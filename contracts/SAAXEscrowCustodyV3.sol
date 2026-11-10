// SPDX-License-Identifier: MIT
// SAAX Protocol — Restricted Objective-Digital Custody V3 (candidate, LOCAL ONLY, PRE-AUDIT)
//
// Phase F3A internal candidate implementing the APPROVED restricted
// OBJECTIVE_DIGITAL custody rules from:
//   mainnet/f3a-custody-v3-spec.md              (normative F3A spec — approved rules, this file)
//   mainnet/f2-design-corrections.md            (path-specific checkpoint authority, boundaries)
//   mainnet/policies/custody-policy-v1.md       (policy §A–§F)
//   mainnet/design/agreement-signing-spec.md    (v4 agreement format §3/§4)
//
// STATUS: INTERNAL PRE-AUDIT CANDIDATE — NOT deployed, NOT wired into
// production routes, NOT mainnet-admission-enabled, NOT independently
// reviewed. CANDIDATE_LABEL = "pre-audit-candidate". Advanced profiles
// (PHYSICAL_DELIVERY, SUBJECTIVE_SERVICE, HIGH_VALUE_ASSURANCE) are
// intentionally absent: no partial awards, no arbitrary recipients, no
// unrestricted admin withdrawal, no silent migration of V1/V2 positions.
//
// V3 vs V2 (the four approved deltas; everything else is preserved):
//   1. PRE-SETTLEMENT-HEAD COMMITMENT: evaluator verdicts and mutual
//      resolutions carry `bytes32 preSettlementHead` INSIDE the signed
//      EIP-712 payload (single signature authorizes both the head and the
//      money-moving action). The accepted head is recorded on-chain
//      (committedHead, headCommittedAt). TIMEOUT REFUND NEEDS NO CHECKPOINT:
//      refundTimeout() takes no head, requires no signature, no journal, and
//      no operator cooperation — eligibility is the contract clock
//      (block.timestamp >= finalCutoff). The contract records the *submitted*
//      head; it does NOT know the complete off-chain journal history.
//   2. EXACT EXECUTION BOUNDARIES (renamed from legacy "deadline"):
//        fund:                 block.timestamp <  resolutionDeadline
//        seller-payment paths  (evaluator release, disputed release,
//        mutualRelease):       block.timestamp >= minReleaseTime
//                              block.timestamp <  resolutionDeadline
//        evaluator/mutual refund paths (refundVerdict, resolve:refund,
//        mutualRefund):        block.timestamp <  resolutionDeadline
//                              NO minimum-release delay.
//        timeout refund:       block.timestamp >= finalCutoff
//        validation at fund:   minReleaseTime <  resolutionDeadline <= finalCutoff
//      Funding after minReleaseTime is allowed while resolutionDeadline
//      remains open. minReleaseTime > funding time is NOT required. Equality
//      resolutionDeadline == finalCutoff is allowed. If
//      resolutionDeadline < finalCutoff the interval
//      [resolutionDeadline, finalCutoff) is the documented intentional gap
//      with NO ordinary resolution (evaluator/mutual blocked; only timeout at
//      finalCutoff exits). Legacy term mapping: V2 struct field `deadline` ==
//      V3 `resolutionDeadline`; exposed via legacyDeadline(commitmentId).
//   3. AUTHORIZATION VALIDITY: contract-enforced issuedAt future-skew and
//      expiry EVALUATED AT EXECUTION (unchanged from V2):
//        issuedAt > block.timestamp + 120 -> NotYetValid
//        block.timestamp > issuedAt + 300 -> ExpiredVerdict
//      Access (service-layer) expiry is separate and unchanged.
//   4. NONCES: ESCROW-SCOPED resolution nonces for V3 (per commitmentId, per
//      authorization class: evaluator verdict vs mutual resolution, SEPARATE
//      maps). Replay across escrows is impossible (scope); across
//      authorization classes (separate maps + separate typehashes); across
//      chains/versions (domain separator binds chainId + name + version +
//      verifyingContract); across custody deployments (verifyingContract).
//      V2 kept its global nonce maps — this file is a NEW contract, so V2
//      behavior is preserved by not touching V2.
//
// PRESERVED SAFEGUARDS (unchanged from V2): exact agreement/policy/party/
// asset/amount bindings at fund; fixed beneficiaries (buyer/seller only —
// no caller-chosen recipient anywhere, including timeout); per-position and
// aggregate caps + totalHeld liability accounting; funding-disable control
// (intake only; exits never suppressed); token-transfer checks (exact-amount
// balance-delta on both pull and push, revert on non-returning/nonstandard
// failures); terminal exclusivity (one terminal state per escrow — no double
// payout); Safe/ERC-1271 evaluator support (Safe enforces its OWN 2-of-3
// threshold; this contract validates the RESULTING authorization via
// isValidSignature, or ecrecover for EOA evaluators). No arbitrary admin
// withdrawal or recipient substitution exists by construction.

pragma solidity 0.8.26;

interface IERC20Returning {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IERC20NoReturn {
    function transferFrom(address from, address to, uint256 value) external;
    function transfer(address to, uint256 value) external;
    function balanceOf(address who) external view returns (uint256);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}

contract SAAXEscrowCustodyV3 {
    // ---- Types -----------------------------------------------------------------
    enum EscrowState { None, Funded, Disputed, Released, Refunded }

    struct Escrow {
        bytes32 commitmentId;
        bytes32 commitmentDigest;
        address token;          // USDC on Base Sepolia (testnet) / chain-confirmed asset
        address buyer;          // fixed beneficiary on refund / mutual-refund / timeout
        address seller;         // fixed beneficiary on release / mutual-release
        address evaluator;      // EOA (ecrecover) OR contract wallet (ERC-1271)
        uint256 amount;         // exact atomic units (token base units); no floats
        uint256 resolutionDeadline; // unix seconds: END OF the evaluator/mutual decision window (legacy "deadline")
        uint256 finalCutoff;    // unix seconds: fixed, non-extendable timeout boundary (>= resolutionDeadline)
        uint64 minReleaseTime;  // seller-payment paths only; NOT required < funding time
        bytes32 committedHead;  // pre-settlement journal tail committed by an authorized settlement (bytes32(0) on timeout)
        uint256 headCommittedAt;// execution timestamp when committedHead was recorded (0 if never)
        uint256 policyId;       // versioned custody policy id (contract-admitted)
        bytes32 policyDigest;   // sha256 digest of the policy document (see admission/validator)
        bytes32 agreementRef;   // canonical v4 manifest digest-derived reference — NOT decorative
        EscrowState state;
        address disputedBy;
        string disputeReason;   // URI/ref, not free text
        uint256 disputeAt;
        uint64 releasedAt;
        uint64 refundedAt;
    }

    // ---- Constants -------------------------------------------------------------
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    // V3 verdict type — DISTINCT from V2's 5-field EscrowVerdict: the
    // preSettlementHead field changes the type string, so the typehash
    // differs and a V2-era signature can never validate against V3.
    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "EscrowVerdict(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt,bytes32 preSettlementHead)"
    );
    bytes32 public constant MUTUAL_TYPEHASH = keccak256(
        "MutualResolution(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt,bytes32 preSettlementHead)"
    );

    string public constant DOMAIN_NAME = "SAAX Escrow Custody V3";
    string public constant DOMAIN_VERSION = "3";
    uint256 public constant CUSTODY_VERSION = 3;
    string public constant CANDIDATE_LABEL = "pre-audit-candidate";

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    uint256 public chainId;

    // ---- Storage ---------------------------------------------------------------
    mapping(bytes32 => Escrow) public escrows;                 // commitmentId -> escrow
    mapping(bytes32 => mapping(uint256 => bool)) public usedVerdictNonce; // EVALUATOR verdict nonces, escrow-scoped
    mapping(bytes32 => mapping(uint256 => bool)) public usedMutualNonce;  // MUTUAL resolution nonces, escrow-scoped

    // Exposure limits (policy §F.2). Activation-blocked until owner sets values:
    // 0 means NOT ADMITTED — fund() reverts PolicyNotAdmitted.
    uint256 public perPositionCap;   // max outstanding principal per escrow (atomic units)
    uint256 public aggregateCap;     // max total outstanding principal across all escrows
    uint256 public totalHeld;        // sum of outstanding (Funded + Disputed) principal

    uint256 public admittedPolicyId;
    bytes32 public admittedPolicyDigest;

    // Admission gate (policy §F.3): stops INTAKE only. Exits are NEVER suppressed.
    bool public fundingEnabled;

    uint256 private _locked;

    // ---- Events ----------------------------------------------------------------
    event Funded(bytes32 indexed commitmentId, bytes32 commitmentDigest, address token, address buyer, address seller, address evaluator, uint256 amount, uint256 resolutionDeadline, uint256 finalCutoff, uint256 policyId, bytes32 policyDigest, bytes32 agreementRef);
    event Released(bytes32 indexed commitmentId, address indexed seller, uint256 amount, bytes32 verdictHash, bytes32 preSettlementHead);
    event Refunded(bytes32 indexed commitmentId, address indexed buyer, uint256 amount, bytes32 verdictHash, bytes32 preSettlementHead);
    event Disputed(bytes32 indexed commitmentId, address by, string reason, uint256 at);
    event Resolved(bytes32 indexed commitmentId, string resolution, bytes32 verdictHash, bytes32 preSettlementHead);
    event MutualResolution(bytes32 indexed commitmentId, string action, uint256 nonce, bytes32 preSettlementHead);
    event HeadCommitted(bytes32 indexed commitmentId, bytes32 preSettlementHead, uint256 at);

    // ---- Errors ----------------------------------------------------------------
    error NotFunded();
    error WrongDigest();
    error WrongState();
    error UnauthorizedSigner();
    error BadSignature();
    error Replay();
    error ExpiredVerdict();
    error NotYetValid();
    error DeadlineNotPassed();
    error AfterCutoff();
    error AfterResolutionDeadline();
    error HeadRequired();
    error SelfTransfer();
    error InvalidToken();
    error TransferFailed();
    error NotParty();
    error CapExceeded();
    error PolicyNotAdmitted();
    error FundingDisabled();
    error InvalidPolicy();
    error InvalidAgreementRef();
    error InvalidRecipient();
    error UnsupportedAction();

    modifier nonReentrant() {
        require(_locked == 0, "reentrant");
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(uint256 _perPositionCap, uint256 _aggregateCap, bool _fundingEnabled, uint256 _admittedPolicyId, bytes32 _admittedPolicyDigest) {
        chainId = block.chainid;
        perPositionCap = _perPositionCap;
        aggregateCap = _aggregateCap;
        fundingEnabled = _fundingEnabled;
        admittedPolicyId = _admittedPolicyId;
        admittedPolicyDigest = _admittedPolicyDigest;
        if (_fundingEnabled && (_perPositionCap == 0 || _aggregateCap == 0)) revert CapExceeded();
        if (_admittedPolicyId == 0 || _admittedPolicyDigest == bytes32(0)) revert InvalidPolicy();
    }

    // ---- EIP-712 ---------------------------------------------------------------
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(DOMAIN_NAME)),
            keccak256(bytes(DOMAIN_VERSION)),
            chainId,
            address(this)
        ));
    }

    function _hashTyped(bytes32 typehash, bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, bytes32 preSettlementHead) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            domainSeparator(),
            keccak256(abi.encode(
                typehash,
                commitmentId,
                commitmentDigest,
                keccak256(bytes(action)),
                nonce,
                issuedAt,
                preSettlementHead
            ))
        ));
    }

    /// @dev Evaluator verdict digest (V3, 6-field, head-bound).
    function _hashVerdict(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, bytes32 preSettlementHead) internal view returns (bytes32) {
        return _hashTyped(VERDICT_TYPEHASH, commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead);
    }

    /// @dev Mutual resolution digest (V3, 6-field, head-bound).
    function _hashMutual(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, bytes32 preSettlementHead) internal view returns (bytes32) {
        return _hashTyped(MUTUAL_TYPEHASH, commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead);
    }

    /// @dev ERC-1271 verification when evaluator is a contract wallet; the
    ///      contract wallet (e.g. Safe) enforces its OWN configured signing
    ///      policy (owner set + threshold). The custody contract only checks
    ///      the resulting authorization via isValidSignature.
    function _isValidSignature(address wallet, bytes32 digest, bytes memory signature) internal view returns (bool) {
        if (wallet.code.length == 0) return false;
        (bool ok, bytes memory data) = wallet.staticcall(
            abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature)
        );
        return ok && data.length >= 32 && abi.decode(data, (bytes4)) == ERC1271_MAGIC;
    }

    function _recoverVerdictSigner(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, bytes32 preSettlementHead, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        bytes32 digest = _hashVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    /// @dev Validates an evaluator verdict (V3). Supports BOTH:
    ///   - EOA evaluator: (v,r,s) recovered to e.evaluator.
    ///   - Contract-wallet evaluator (Safe + ERC-1271): (v,r,s) MUST be zeroed
    ///     (empty container); the verdict digest + full packed signature bytes
    ///     are checked via isValidSignature (Safe enforces its own threshold).
    ///   The head MUST be non-zero on evaluator paths (approved policy 1):
    ///   the evaluator authorizes BOTH the action and the committed head.
    function _checkVerdict(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, bytes32 preSettlementHead, uint8 v, bytes32 r, bytes32 s, bytes memory sigBytes, address expectedEvaluator) internal {
        if (preSettlementHead == bytes32(0)) revert HeadRequired();
        if (issuedAt > block.timestamp + 120) revert NotYetValid();
        if (block.timestamp > issuedAt + 300) revert ExpiredVerdict();
        if (usedVerdictNonce[commitmentId][nonce]) revert Replay();

        bool ok;
        if (expectedEvaluator.code.length > 0) {
            if (!(v == 0 && r == bytes32(0) && s == bytes32(0))) revert BadSignature();
            if (sigBytes.length == 0) revert BadSignature();
            bytes32 digest = _hashVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead);
            ok = _isValidSignature(expectedEvaluator, digest, sigBytes);
        } else {
            address signer = _recoverVerdictSigner(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead, v, r, s);
            ok = (signer == expectedEvaluator);
        }
        if (!ok) revert UnauthorizedSigner();
        usedVerdictNonce[commitmentId][nonce] = true;
    }

    function _recoverMutualSigner(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, bytes32 preSettlementHead, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        bytes32 digest = _hashMutual(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    /// @dev Validates mutual resolution (V3): BOTH buyer and seller sign the
    ///      SAME MutualResolution digest, including the SAME head (approved
    ///      policy 1: both parties authorize the same head). Parties are EOAs
    ///      here (contract-wallet party support remains a later integration
    ///      item, unchanged from V2).
    function _checkMutual(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, bytes32 preSettlementHead, uint8 bv, bytes32 br, bytes32 bs, uint8 sv, bytes32 sr, bytes32 ss, address buyer, address seller) internal {
        if (preSettlementHead == bytes32(0)) revert HeadRequired();
        if (issuedAt > block.timestamp + 120) revert NotYetValid();
        if (block.timestamp > issuedAt + 300) revert ExpiredVerdict();
        if (usedMutualNonce[commitmentId][nonce]) revert Replay();
        address signerB = _recoverMutualSigner(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead, bv, br, bs);
        address signerS = _recoverMutualSigner(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead, sv, sr, ss);
        if (signerB != buyer || signerS != seller) revert UnauthorizedSigner();
        usedMutualNonce[commitmentId][nonce] = true;
    }

    // ---- Safe transfer internals (V1/V2-hardened, unchanged) --------------------
    function _balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20NoReturn.balanceOf.selector, who)
        );
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        if (token == address(0)) revert InvalidToken();
        uint256 beforeBal = _balanceOf(token, to);
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Returning.transferFrom.selector, from, to, value)
        );
        if (!ok || (data.length >= 32 && !abi.decode(data, (bool)))) revert TransferFailed();
        uint256 afterBal = _balanceOf(token, to);
        if (afterBal < beforeBal || afterBal - beforeBal != value) revert TransferFailed();
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        if (token == address(0)) revert InvalidToken();
        uint256 beforeBal = _balanceOf(token, to);
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Returning.transfer.selector, to, value)
        );
        if (!ok || (data.length >= 32 && !abi.decode(data, (bool)))) revert TransferFailed();
        uint256 afterBal = _balanceOf(token, to);
        if (afterBal < beforeBal || afterBal - beforeBal != value) revert TransferFailed();
    }

    // ---- Fund ------------------------------------------------------------------
    /// @dev Creates the escrow, binding the exact agreement/policy terms.
    ///      Anyone may submit (msg.sender supplies the tokens) — the terms are
    ///      the authority, not the caller. Funding window (approved policy 2):
    ///      block.timestamp < resolutionDeadline. Funding after minReleaseTime
    ///      is allowed while resolutionDeadline remains open; minReleaseTime >
    ///      funding time is NOT required.
    function fund(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        address token,
        address buyer,
        address seller,
        address evaluator,
        uint256 amount,
        uint256 resolutionDeadline,
        uint256 finalCutoff,
        uint64 minReleaseTime,
        uint256 policyId,
        bytes32 policyDigest,
        bytes32 agreementRef
    ) external nonReentrant returns (bool) {
        if (!fundingEnabled) revert FundingDisabled();
        if (commitmentId == bytes32(0)) revert WrongDigest();
        if (commitmentDigest == bytes32(0)) revert WrongDigest();
        if (token == address(0) || buyer == address(0) || seller == address(0) || evaluator == address(0)) revert WrongDigest();
        if (buyer == seller) revert SelfTransfer();
        if (amount == 0) revert WrongDigest();
        if (escrows[commitmentId].state != EscrowState.None) revert WrongState();
        if (policyId == 0) revert InvalidPolicy();
        if (policyDigest == bytes32(0)) revert InvalidPolicy();
        if (agreementRef == bytes32(0)) revert InvalidAgreementRef();
        if (policyId != admittedPolicyId) revert InvalidPolicy();
        if (policyDigest != admittedPolicyDigest) revert InvalidPolicy();
        // Parameter validation (approved policy 2): strict ordering
        //   minReleaseTime < resolutionDeadline <= finalCutoff
        // Equality resolutionDeadline == finalCutoff is ALLOWED. If
        // resolutionDeadline < finalCutoff the interval between them is the
        // documented intentional gap with NO ordinary resolution.
        if (!(minReleaseTime < resolutionDeadline)) revert InvalidPolicy();
        if (resolutionDeadline > finalCutoff) revert InvalidPolicy();
        // Funding window: block.timestamp < resolutionDeadline. (Since
        // resolutionDeadline <= finalCutoff and this check passes, the final
        // cutoff is also in the future; the explicit finalCutoff check below
        // keeps the boundary table self-documenting.)
        if (block.timestamp >= resolutionDeadline) revert AfterResolutionDeadline();
        if (finalCutoff <= block.timestamp) revert InvalidPolicy();
        // Cap enforcement (policy §F.2): per-position and aggregate.
        if (perPositionCap != 0 && amount > perPositionCap) revert CapExceeded();
        if (aggregateCap != 0 && totalHeld + amount > aggregateCap) revert CapExceeded();

        // Pull the token into custody FIRST; a failed movement reverts the
        // whole transaction, so no escrow is ever recorded unfunded. Liability
        // accounting (totalHeld) is independent of unsolicited direct token
        // transfers: only fund() increments totalHeld, and only terminal exits
        // decrement it. Direct donations cannot be withdrawn by anyone.
        _safeTransferFrom(token, msg.sender, address(this), amount);
        totalHeld += amount;

        escrows[commitmentId] = Escrow({
            commitmentId: commitmentId,
            commitmentDigest: commitmentDigest,
            token: token,
            buyer: buyer,
            seller: seller,
            evaluator: evaluator,
            amount: amount,
            resolutionDeadline: resolutionDeadline,
            finalCutoff: finalCutoff,
            minReleaseTime: minReleaseTime,
            committedHead: bytes32(0),
            headCommittedAt: 0,
            policyId: policyId,
            policyDigest: policyDigest,
            agreementRef: agreementRef,
            state: EscrowState.Funded,
            disputedBy: address(0),
            disputeReason: "",
            disputeAt: 0,
            releasedAt: 0,
            refundedAt: 0
        });

        emit Funded(commitmentId, commitmentDigest, token, buyer, seller, evaluator, amount, resolutionDeadline, finalCutoff, policyId, policyDigest, agreementRef);
        return true;
    }

    // ---- Evaluator release ------------------------------------------------------
    /// @dev Evaluator-authorized release (seller-payment path). Requires
    ///      block.timestamp >= minReleaseTime AND < resolutionDeadline, plus a
    ///      non-zero preSettlementHead inside the signed verdict.
    function release(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        bytes32 preSettlementHead,
        uint256 nonce,
        uint256 issuedAt,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata sigBytes
    ) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded) revert WrongState();
        if (block.timestamp < e.minReleaseTime) revert NotYetValid();
        if (block.timestamp >= e.resolutionDeadline) revert AfterResolutionDeadline();
        _checkVerdict(commitmentId, commitmentDigest, "release", nonce, issuedAt, preSettlementHead, v, r, s, sigBytes, e.evaluator);

        _safeTransfer(e.token, e.seller, e.amount);
        e.state = EscrowState.Released;
        e.releasedAt = uint64(block.timestamp);
        e.committedHead = preSettlementHead;
        e.headCommittedAt = block.timestamp;
        totalHeld -= e.amount;
        emit HeadCommitted(commitmentId, preSettlementHead, block.timestamp);
        emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(v, r, s)), preSettlementHead);
        return true;
    }

    // ---- Evaluator verdict refund -------------------------------------------------
    /// @dev Evaluator-signed refund (buyer path). Requires ONLY
    ///      block.timestamp < resolutionDeadline — NO minimum-release delay
    ///      (approved policy 2: evaluator refund paths have no min-release).
    function refundVerdict(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        bytes32 preSettlementHead,
        uint256 nonce,
        uint256 issuedAt,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata sigBytes
    ) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded) revert WrongState(); // disputed must resolve first
        if (block.timestamp >= e.resolutionDeadline) revert AfterResolutionDeadline();
        _checkVerdict(commitmentId, commitmentDigest, "refund", nonce, issuedAt, preSettlementHead, v, r, s, sigBytes, e.evaluator);

        _safeTransfer(e.token, e.buyer, e.amount);
        e.state = EscrowState.Refunded;
        e.refundedAt = uint64(block.timestamp);
        e.committedHead = preSettlementHead;
        e.headCommittedAt = block.timestamp;
        totalHeld -= e.amount;
        emit HeadCommitted(commitmentId, preSettlementHead, block.timestamp);
        emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(v, r, s)), preSettlementHead);
        return true;
    }

    // ---- Timeout refund (NO checkpoint, NO signature, NO operator) ----------------
    /// @dev Timeout refund (approved policy 1): at/after finalCutoff, for
    ///      BOTH Funded and Disputed positions, beneficiary fixed to the
    ///      original buyer, caller may be anyone but CANNOT select a
    ///      recipient. Takes NO preSettlementHead, requires NO fresh signature
    ///      and NO journal availability. A submitted checkpoint is NOT an
    ///      accepted representation on this path: the function has no head
    ///      parameter, so an unknown/ambiguous head-bearing representation is
    ///      rejected at the ABI level by construction.
    function refundTimeout(bytes32 commitmentId, bytes32 commitmentDigest) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded && e.state != EscrowState.Disputed) revert WrongState();
        if (block.timestamp < e.finalCutoff) revert DeadlineNotPassed();

        _safeTransfer(e.token, e.buyer, e.amount);
        e.state = EscrowState.Refunded;
        e.refundedAt = uint64(block.timestamp);
        // committedHead/headCommittedAt remain zero: no checkpoint on timeout.
        totalHeld -= e.amount;
        emit Refunded(commitmentId, e.buyer, e.amount, bytes32(0), bytes32(0));
        return true;
    }

    // ---- Dispute ----------------------------------------------------------------
    /// @dev Only authorized commitment parties may dispute (buyer or seller).
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

    // ---- Resolve a dispute ------------------------------------------------------
    /// @dev Evaluator resolution of a disputed escrow. Requires ONLY
    ///      block.timestamp < resolutionDeadline (approved policy 2).
    ///      "release"→seller (seller-payment path: additionally requires
    ///      block.timestamp >= minReleaseTime), "refund"→buyer (NO
    ///      min-release), "hold"→back to Funded. At/after finalCutoff the
    ///      timeout path (refundTimeout) applies instead — the intentional
    ///      gap means no evaluator action is executable in
    ///      [resolutionDeadline, finalCutoff).
    function resolve(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        string calldata resolution,
        bytes32 preSettlementHead,
        uint256 nonce,
        uint256 issuedAt,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata sigBytes
    ) external nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Disputed) revert WrongState();
        if (block.timestamp >= e.resolutionDeadline) revert AfterResolutionDeadline();
        _checkVerdict(commitmentId, commitmentDigest, string.concat("resolve:", resolution), nonce, issuedAt, preSettlementHead, v, r, s, sigBytes, e.evaluator);

        if (keccak256(bytes(resolution)) == keccak256("release")) {
            if (block.timestamp < e.minReleaseTime) revert NotYetValid(); // seller-payment path
            _safeTransfer(e.token, e.seller, e.amount);
            e.state = EscrowState.Released;
            e.releasedAt = uint64(block.timestamp);
            e.committedHead = preSettlementHead;
            e.headCommittedAt = block.timestamp;
            totalHeld -= e.amount;
            emit HeadCommitted(commitmentId, preSettlementHead, block.timestamp);
            emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(v, r, s)), preSettlementHead);
        } else if (keccak256(bytes(resolution)) == keccak256("refund")) {
            _safeTransfer(e.token, e.buyer, e.amount);
            e.state = EscrowState.Refunded;
            e.refundedAt = uint64(block.timestamp);
            e.committedHead = preSettlementHead;
            e.headCommittedAt = block.timestamp;
            totalHeld -= e.amount;
            emit HeadCommitted(commitmentId, preSettlementHead, block.timestamp);
            emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(v, r, s)), preSettlementHead);
        } else if (keccak256(bytes(resolution)) == keccak256("hold")) {
            e.state = EscrowState.Funded;
            e.disputedBy = address(0);
            e.disputeReason = "";
            e.disputeAt = 0;
            e.committedHead = preSettlementHead;
            e.headCommittedAt = block.timestamp;
            emit HeadCommitted(commitmentId, preSettlementHead, block.timestamp);
        } else {
            revert UnsupportedAction();
        }
        emit Resolved(commitmentId, resolution, keccak256(abi.encodePacked(v, r, s)), preSettlementHead);
        return true;
    }

    // ---- Mutual resolution (both parties) ---------------------------------------
    /// @dev Buyer + seller mutually sign the SAME MutualResolution digest,
    ///      including the SAME non-zero preSettlementHead. Valid ONLY while
    ///      block.timestamp < resolutionDeadline. mutualRelease is a
    ///      seller-payment path (requires >= minReleaseTime); mutualRefund has
    ///      NO min-release delay. Fixed beneficiaries; no caller-chosen
    ///      recipient; full amount only (restricted profile).
    function _mutual(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        string memory action,
        bytes32 preSettlementHead,
        uint256 nonce,
        uint256 issuedAt,
        uint8 bv, bytes32 br, bytes32 bs,
        uint8 sv, bytes32 sr, bytes32 ss
    ) internal nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded) revert WrongState();
        if (block.timestamp >= e.resolutionDeadline) revert AfterResolutionDeadline();
        if (keccak256(bytes(action)) == keccak256("release") && block.timestamp < e.minReleaseTime) revert NotYetValid(); // seller-payment path
        _checkMutual(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead, bv, br, bs, sv, sr, ss, e.buyer, e.seller);

        if (keccak256(bytes(action)) == keccak256("release")) {
            _safeTransfer(e.token, e.seller, e.amount);
            e.state = EscrowState.Released;
            e.releasedAt = uint64(block.timestamp);
            e.committedHead = preSettlementHead;
            e.headCommittedAt = block.timestamp;
            totalHeld -= e.amount;
            emit HeadCommitted(commitmentId, preSettlementHead, block.timestamp);
            emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(bv, br, bs, sv, sr, ss)), preSettlementHead);
        } else if (keccak256(bytes(action)) == keccak256("refund")) {
            _safeTransfer(e.token, e.buyer, e.amount);
            e.state = EscrowState.Refunded;
            e.refundedAt = uint64(block.timestamp);
            e.committedHead = preSettlementHead;
            e.headCommittedAt = block.timestamp;
            totalHeld -= e.amount;
            emit HeadCommitted(commitmentId, preSettlementHead, block.timestamp);
            emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(bv, br, bs, sv, sr, ss)), preSettlementHead);
        } else {
            revert UnsupportedAction();
        }
        emit MutualResolution(commitmentId, action, nonce, preSettlementHead);
        return true;
    }

    function mutualRelease(
        bytes32 commitmentId, bytes32 commitmentDigest, bytes32 preSettlementHead, uint256 nonce, uint256 issuedAt,
        uint8 bv, bytes32 br, bytes32 bs, uint8 sv, bytes32 sr, bytes32 ss
    ) external returns (bool) {
        return _mutual(commitmentId, commitmentDigest, "release", preSettlementHead, nonce, issuedAt, bv, br, bs, sv, sr, ss);
    }

    function mutualRefund(
        bytes32 commitmentId, bytes32 commitmentDigest, bytes32 preSettlementHead, uint256 nonce, uint256 issuedAt,
        uint8 bv, bytes32 br, bytes32 bs, uint8 sv, bytes32 sr, bytes32 ss
    ) external returns (bool) {
        return _mutual(commitmentId, commitmentDigest, "refund", preSettlementHead, nonce, issuedAt, bv, br, bs, sv, sr, ss);
    }

    // ---- Read -------------------------------------------------------------------
    /// @dev Legacy term mapping (approved policy 2): V2's `deadline` field is
    ///      V3's `resolutionDeadline`. This view exposes the legacy name so
    ///      historical tooling that read `deadline` reads the same value.
    function legacyDeadline(bytes32 commitmentId) external view returns (uint256) {
        return escrows[commitmentId].resolutionDeadline;
    }

    function getEscrow(bytes32 commitmentId) external view returns (
        bytes32 id, bytes32 digest, address token, address buyer, address seller,
        address evaluator, uint256 amount, uint256 resolutionDeadline, uint256 finalCutoff,
        uint64 minReleaseTime, bytes32 committedHead, uint256 headCommittedAt,
        uint256 policyId, bytes32 policyDigest, bytes32 agreementRef,
        EscrowState state, address disputedBy, uint256 disputeAt, uint64 releasedAt, uint64 refundedAt
    ) {
        Escrow storage e = escrows[commitmentId];
        return (e.commitmentId, e.commitmentDigest, e.token, e.buyer, e.seller, e.evaluator,
            e.amount, e.resolutionDeadline, e.finalCutoff, e.minReleaseTime,
            e.committedHead, e.headCommittedAt,
            e.policyId, e.policyDigest, e.agreementRef,
            e.state, e.disputedBy, e.disputeAt, e.releasedAt, e.refundedAt);
    }

    /// @dev Outstanding liability (Funded + Disputed principal). NOTE: this is
    ///      the TOKEN balance held by this contract, which includes unsolicited
    ///      donations. The accounting invariant totalHeld == sum(outstanding)
    ///      is the liability figure; balanceHeld >= totalHeld is expected only
    ///      by donations.
    function balanceHeld(address token) external view returns (uint256) {
        return IERC20Returning(token).balanceOf(address(this));
    }
}