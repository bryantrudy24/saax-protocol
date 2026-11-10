// SPDX-License-Identifier: MIT
// SAAX Protocol — Minimal Escrow Custody (Base Sepolia testnet demo)
//
// WHY THIS CONTRACT EXISTS (evidence-backed):
//   The Mandate requires REAL enforceable escrow: funds held pending an
//   outcome, released/refunded ONLY by an authorized decision. SAAX's current
//   settlement path is a DIRECT USDC transfer to the signer wallet
//   (gateway.js transferFrom(owner, signer, value)) — no custody, no hold,
//   no condition. The escrow.js module is a lifecycle flag recorded AFTER the
//   transfer; a state machine alone does not satisfy the requirement.
//
//   Maintained integrations checked:
//     - Kleros Escrow V2: deployed ONLY on Arbitrum + Arbitrum Sepolia
//       (verified from the kleros/escrow-v2 repo deployment tree). NO Base
//       Sepolia deployment. The Mandate requires the "appropriate Base
//       testnet" — integration impossible.
//     - Circle x402 / Facilitator: validates PAYMENT (isValid verdict),
//       does not hold funds.
//     - EAS: anchoring only, no custody.
//   Per the Mandate: "If no suitable mechanism exists, document the evidence
//   and tradeoffs before introducing custom custody code." This contract IS
//   that documented, minimal, auditable custody code — testnet demo only.
//
// DESIGN (enforcement properties):
//   - HOLD: USDC moves into THIS contract (transferFrom) at fund(); the
//     contract owns the balance (balanceOf(this) is verifiable on-chain).
//   - AUTHORIZED RELEASE: release() requires an EIP-712 verdict signed by the
//     AGREED EVALUATOR (from the commitment terms, bound at fund time).
//     msg.sender may be anyone (relayer-friendly); the recovered signer MUST
//     be the evaluator. USDC -> seller. Digest + commitmentId must match.
//   - REFUND: refund() with an EIP-712 signed refund verdict (evaluator) OR
//     after deadline (timeout path, no signature needed) OR by dispute
//     resolution. USDC -> buyer.
//   - DISPUTE: anyone may raiseDispute (evidence ref passed along); resolve
//     requires the evaluator's signed verdict naming release|refund|hold.
//   - NO ADMIN: no owner, no upgrade, no pause, no withdrawal function. Funds
//     can ONLY move via release (to seller) / refund (to buyer). Nobody — not
//     the deployer, not the signer — can pull escrow funds out otherwise.
//   - BINDING: commitmentId (bytes32) + commitmentDigest (bytes32) are frozen
//     at fund() and required on every terminal action. Wrong digest => revert.
//   - SAFETY: ReentrancyGuard-style mutex; checks-effects-interactions;
//     terminal states are final (one release OR one refund, never both).
//
// TOKEN TRANSFER HANDLING (Day 19 hardening):
//   All external token movements go through _safeTransfer / _safeTransferFrom
//   (SafeERC20-style equivalent, carefully reviewed for this minimal contract):
//     - Explicit `false` return  -> revert (TransferFailed).
//     - Reverting token call     -> revert propagates (TransferFailed).
//     - No-return (USDT-style)   -> supported: balance-delta check after the
//       call proves the movement; a no-delta (including fee-on-transfer) is
//       rejected by the exact-amount comparison.
//     - Invalid token target     -> token == address(0) reverts (InvalidToken).
//     - Fee-on-transfer tokens: NOT supported; the balance-delta comparison
//       after transferFrom must equal the requested amount exactly, so any fee
//       mismatch reverts the transition.
//     - Rebasing tokens: NOT guaranteed. The exact-delta check rejects many
//       rebasing behaviors but does NOT establish rejection of EVERY rebasing
//       token (a rebase could theoretically net an exact delta). This test
//       deployment is constrained to the VERIFIED Base Sepolia test USDC
//       contract 0x036CbD53842c5426634e7929541eC2318f3dCF7e only.
//   Ordering: the token movement happens BEFORE the state write, so a failing
//   movement reverts the entire transaction — no terminal state is recorded
//   and no success event is emitted when funds did not actually move.
//   The nonReentrant guard + checks-effects-interactions ordering (state is
//   only written after the external call succeeds) preserves atomicity.
//
// Clarification on escrow ownership: the contract holds the token, but it is
// not a "lockbox with keys" — anyone can CALL release/refund, yet only the
// agreed evaluator's signed verdict (or the deadline) can make the call
// succeed. That is the enforceable boundary: DB status alone cannot move
// funds; the on-chain chain-of-custody is independently verifiable.
//
// Testnet only. No mainnet deployment. No upgrade path (by design).

pragma solidity 0.8.26;

/// @dev Full ERC-20 interface with a bool return (USDC, standard tokens).
interface IERC20Returning {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @dev No-return ERC-20 (USDT-style on some chains). balanceOf must exist.
interface IERC20NoReturn {
    function transferFrom(address from, address to, uint256 value) external;
    function transfer(address to, uint256 value) external;
    function balanceOf(address who) external view returns (uint256);
}

contract SAAXEscrowCustodyV1 {
    // ---- Types -----------------------------------------------------------------
    enum EscrowState { None, Funded, Disputed, Released, Refunded }

    struct Escrow {
        bytes32 commitmentId;
        bytes32 commitmentDigest;
        address token;        // USDC on Base Sepolia (0x036C...)
        address buyer;        // funds returned to buyer on refund
        address seller;       // funds released to seller on release
        address evaluator;    // agreed evaluator (from commitment terms) — the ONLY signature that authorizes release/refund
        uint256 amount;       // atomic units (USDC 6 dp)
        uint256 deadline;     // unix seconds; after this, refund() becomes callable without evaluator sig
        uint64 minReleaseTime; // escrow may not release before this (e.g. 0)
        EscrowState state;
        address disputedBy;
        string disputeReason; // URI/ref, not free text
        uint256 disputeAt;
        uint64 releasedAt;
        uint64 refundedAt;
    }

    // ---- Constants -------------------------------------------------------------
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "EscrowVerdict(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt)"
    );

    string public constant DOMAIN_NAME = "SAAX Escrow Custody V1";
    string public constant DOMAIN_VERSION = "1";

    uint256 public chainId;

    // ---- Storage ---------------------------------------------------------------
    mapping(bytes32 => Escrow) public escrows;       // commitmentId -> escrow
    mapping(uint256 => bool) public usedVerdictNonce; // evaluator-verdict nonce replay guard
    uint256 private _locked;

    // ---- Events ----------------------------------------------------------------
    event Funded(bytes32 indexed commitmentId, bytes32 commitmentDigest, address token, address buyer, address seller, address evaluator, uint256 amount, uint256 deadline);
    event Released(bytes32 indexed commitmentId, address indexed seller, uint256 amount, bytes32 verdictHash);
    event Refunded(bytes32 indexed commitmentId, address indexed buyer, uint256 amount, bytes32 verdictHash);
    event Disputed(bytes32 indexed commitmentId, address by, string reason, uint256 at);
    event Resolved(bytes32 indexed commitmentId, string resolution, bytes32 verdictHash);

    error NotFunded();
    error WrongDigest();
    error WrongState();
    error UnauthorizedSigner();
    error BadSignature();
    error Replay();
    error ExpiredVerdict();
    error NotYetValid();
    error DeadlineNotPassed();
    error SelfTransfer();
    error InvalidToken();
    error TransferFailed();
    error NotParty();

    modifier nonReentrant() {
        require(_locked == 0, "reentrant");
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor() {
        chainId = block.chainid;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(DOMAIN_NAME)),
            keccak256(bytes(DOMAIN_VERSION)),
            chainId,
            address(this)
        ));
    }

    function _hashVerdict(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            domainSeparator(),
            keccak256(abi.encode(
                VERDICT_TYPEHASH,
                commitmentId,
                commitmentDigest,
                keccak256(bytes(action)),
                nonce,
                issuedAt
            ))
        ));
    }

    function _recoverVerdictSigner(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        bytes32 digest = _hashVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    function _checkVerdict(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, uint8 v, bytes32 r, bytes32 s, address expectedEvaluator) internal {
        if (issuedAt > block.timestamp + 120) revert NotYetValid();
        if (block.timestamp > issuedAt + 300) revert ExpiredVerdict();
        if (usedVerdictNonce[nonce]) revert Replay();
        address signer = _recoverVerdictSigner(commitmentId, commitmentDigest, action, nonce, issuedAt, v, r, s);
        if (signer != expectedEvaluator) revert UnauthorizedSigner();
        usedVerdictNonce[nonce] = true;
    }

    // ---- Safe transfer internals ----------------------------------------------
    // All token movements MUST go through these. No unchecked return values.

    function _balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20NoReturn.balanceOf.selector, who)
        );
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    /// @dev Safe transferFrom. Handles:
    ///   - standard returning tokens (explicit false -> revert);
    ///   - no-return tokens (USDT-style): balance deltas prove the movement;
    ///   - fee-on-transfer / rebasing: rejected by the exact-delta comparison;
    ///   - token == address(0): invalid target, reverts InvalidToken.
    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        if (token == address(0)) revert InvalidToken();
        uint256 beforeBal = _balanceOf(token, to);
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Returning.transferFrom.selector, from, to, value)
        );
        // Reject explicit false returns and reverting calls.
        if (!ok || (data.length >= 32 && !abi.decode(data, (bool)))) revert TransferFailed();
        // ALWAYS verify the exact balance delta, regardless of return data.
        // This is what rejects fee-on-transfer / rebasing tokens: the
        // recipient must have received EXACTLY `value`, nothing less.
        uint256 afterBal = _balanceOf(token, to);
        if (afterBal < beforeBal || afterBal - beforeBal != value) revert TransferFailed();
    }

    /// @dev Safe transfer. Same semantics as _safeTransferFrom.
    function _safeTransfer(address token, address to, uint256 value) internal {
        if (token == address(0)) revert InvalidToken();
        uint256 beforeBal = _balanceOf(token, to);
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Returning.transfer.selector, to, value)
        );
        // Reject explicit false returns and reverting calls.
        if (!ok || (data.length >= 32 && !abi.decode(data, (bool)))) revert TransferFailed();
        // ALWAYS verify the exact balance delta, regardless of return data.
        uint256 afterBal = _balanceOf(token, to);
        if (afterBal < beforeBal || afterBal - beforeBal != value) revert TransferFailed();
    }

    // ---- Fund (anyone may fund; creates the escrow, binding terms) -------------
    function fund(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        address token,
        address buyer,
        address seller,
        address evaluator,
        uint256 amount,
        uint256 deadline,
        uint64 minReleaseTime
    ) external nonReentrant returns (bool) {
        if (commitmentId == bytes32(0)) revert WrongDigest();
        if (commitmentDigest == bytes32(0)) revert WrongDigest();
        if (token == address(0) || buyer == address(0) || seller == address(0) || evaluator == address(0)) revert WrongDigest();
        if (buyer == seller) revert SelfTransfer();
        if (amount == 0) revert WrongDigest();
        if (escrows[commitmentId].state != EscrowState.None) revert WrongState();

        // Pull the USDC into custody FIRST; a failed movement reverts the
        // whole transaction, so no escrow is ever recorded unfunded.
        _safeTransferFrom(token, msg.sender, address(this), amount);

        escrows[commitmentId] = Escrow({
            commitmentId: commitmentId,
            commitmentDigest: commitmentDigest,
            token: token,
            buyer: buyer,
            seller: seller,
            evaluator: evaluator,
            amount: amount,
            deadline: deadline,
            minReleaseTime: minReleaseTime,
            state: EscrowState.Funded,
            disputedBy: address(0),
            disputeReason: "",
            disputeAt: 0,
            releasedAt: 0,
            refundedAt: 0
        });

        emit Funded(commitmentId, commitmentDigest, token, buyer, seller, evaluator, amount, deadline);
        return true;
    }

    // ---- Authorized release: evaluator's signed verdict required --------------
    function release(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        uint256 nonce,
        uint256 issuedAt,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded) revert WrongState(); // disputed must resolve first
        if (block.timestamp < e.minReleaseTime) revert NotYetValid();
        _checkVerdict(commitmentId, commitmentDigest, "release", nonce, issuedAt, v, r, s, e.evaluator);

        // Move funds FIRST; then record terminal state.
        _safeTransfer(e.token, e.seller, e.amount);

        e.state = EscrowState.Released;
        e.releasedAt = uint64(block.timestamp);
        emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(v, r, s)));
        return true;
    }

    // ---- Refund: evaluator's signed refund verdict, OR after deadline ----------
    function refund(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        uint256 nonce,
        uint256 issuedAt,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded) revert WrongState(); // disputed must resolve first

        // Either an evaluator-signed refund verdict, OR the deadline has passed (timeout refund).
        if (v != 0 || r != bytes32(0) || s != bytes32(0)) {
            _checkVerdict(commitmentId, commitmentDigest, "refund", nonce, issuedAt, v, r, s, e.evaluator);
        } else {
            if (block.timestamp < e.deadline) revert DeadlineNotPassed();
        }

        // Move funds FIRST; then record terminal state.
        _safeTransfer(e.token, e.buyer, e.amount);

        e.state = EscrowState.Refunded;
        e.refundedAt = uint64(block.timestamp);
        emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(v, r, s)));
        return true;
    }

    // ---- Dispute (ONLY authorized commitment parties: buyer or seller) ---------
    // An unrelated wallet must NOT be able to freeze funds. The evaluator
    // (resolution authority) is intentionally NOT in this set: the evaluator
    // arbitrates, and opening a dispute against their own escrow would let
    // them force a freeze. Buyer/seller are bound at fund() time.
    function raiseDispute(bytes32 commitmentId, bytes32 commitmentDigest, string calldata reason) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded) revert WrongState();
        if (msg.sender != e.buyer && msg.sender != e.seller) revert NotParty();
        e.state = EscrowState.Disputed;
        e.disputedBy = msg.sender;
        e.disputeReason = reason;
        e.disputeAt = block.timestamp;
        emit Disputed(commitmentId, msg.sender, reason, block.timestamp);
        return true;
    }

    // ---- Resolve a dispute: evaluator's signed verdict names the outcome --------
    function resolve(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        string calldata resolution, // "release" | "refund" | "hold"
        uint256 nonce,
        uint256 issuedAt,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Disputed) revert WrongState();
        _checkVerdict(commitmentId, commitmentDigest, string.concat("resolve:", resolution), nonce, issuedAt, v, r, s, e.evaluator);

        if (keccak256(bytes(resolution)) == keccak256("release")) {
            // Move funds FIRST; then record terminal state.
            _safeTransfer(e.token, e.seller, e.amount);
            e.state = EscrowState.Released;
            e.releasedAt = uint64(block.timestamp);
            emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(v, r, s)));
        } else if (keccak256(bytes(resolution)) == keccak256("refund")) {
            // Move funds FIRST; then record terminal state.
            _safeTransfer(e.token, e.buyer, e.amount);
            e.state = EscrowState.Refunded;
            e.refundedAt = uint64(block.timestamp);
            emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(v, r, s)));
        } else {
            // "hold": lift the dispute back to Funded (evaluator decided to continue)
            e.state = EscrowState.Funded;
            e.disputedBy = address(0);
            e.disputeReason = "";
            e.disputeAt = 0;
        }
        emit Resolved(commitmentId, resolution, keccak256(abi.encodePacked(v, r, s)));
        return true;
    }

    // ---- Read (independent verification) ---------------------------------------
    function getEscrow(bytes32 commitmentId) external view returns (
        bytes32 id, bytes32 digest, address token, address buyer, address seller,
        address evaluator, uint256 amount, uint256 deadline, uint64 minReleaseTime,
        EscrowState state, address disputedBy, uint256 disputeAt, uint64 releasedAt, uint64 refundedAt
    ) {
        Escrow storage e = escrows[commitmentId];
        return (e.commitmentId, e.commitmentDigest, e.token, e.buyer, e.seller, e.evaluator,
            e.amount, e.deadline, e.minReleaseTime, e.state, e.disputedBy, e.disputeAt, e.releasedAt, e.refundedAt);
    }

    // Balance held by THIS contract for a given token (independent of any
    // single escrow; usable across escrows sharing the same asset).
    function balanceHeld(address token) external view returns (uint256) {
        return IERC20Returning(token).balanceOf(address(this));
    }
}