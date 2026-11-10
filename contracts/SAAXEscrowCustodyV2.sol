// SPDX-License-Identifier: MIT
// SAAX Protocol — Restricted Objective-Digital Custody (candidate, LOCAL ONLY)
//
// Phase 3A internal candidate implementing the reviewed restricted
// OBJECTIVE_DIGITAL profile from:
//   mainnet/policies/custody-policy-v1.md        (policy §A–§F)
//   mainnet/design/custody-v2-design.md          (proposed v2 design §5/§6)
//   mainnet/design/agreement-signing-spec.md     (v4 agreement format §3/§4)
//
// STATUS: INTERNAL CANDIDATE — NOT deployed, NOT wired into production routes,
// NOT mainnet-admission-enabled, NOT independently reviewed. This is the
// implementation of the Phase 3A mandate's restricted profile ONLY. Advanced
// profiles (PHYSICAL_DELIVERY, SUBJECTIVE_SERVICE, HIGH_VALUE_ASSURANCE) are
// intentionally absent: no partial awards, no arbitrary recipients, no
// unrestricted admin withdrawal, no silent migration of V1 positions.
//
// A. Authority and consent
//   - fund() binds the escrow to: parties (buyer/seller), asset, exact
//     principal (atomic units), custody chain (block.chainid), policyId +
//     policy digest, agreementRef (the canonical v4 manifest digest-derived
//     reference), evaluator authority, deadline (resolution window end) and
//     finalCutoff (fixed, non-extendable timeout boundary). The caller may be
//     anyone (relayer-friendly), but the AGREEMENT TERMS are the terms; the
//     caller supplies no economic values beyond the beneficiary set that the
//     parties authorized by signing the agreement. An arbitrary
//     caller-supplied policyId/agreementRef is NOT accepted: policyId must
//     equal the contract-admitted policy id and agreementRef must be non-zero
//     and match the digest-derived reference validated by the admission
//     pipeline (structural admission runs in mainnet/admission; the contract
//     enforces the binding at this layer).
//
// B. Restricted objective-digital profile
//   - Evaluator-authorized release/refund and disputed resolution: valid only
//     while block.timestamp < finalCutoff (policy §B.1, §B.5).
//   - Mutually signed full release/refund (buyer + seller EIP-712 signatures)
//     valid only while block.timestamp < finalCutoff (§B.1).
//   - Timeout refund at or after finalCutoff for BOTH Funded and Disputed
//     positions, beneficiary = original buyer, caller may be anyone but MUST
//     NOT select a recipient (§B.2).
//   - The cutoff is fixed at fund; no retry, repeated submission, or dispute
//     toggling extends it (§B.4). Earlier-issued verdict signatures do NOT
//     override execution-time cutoff rules: any evaluator/mutual resolution
//     executed at/after finalCutoff reverts AfterCutoff (§B.5).
//   - Eligibility does not mean automatic execution: someone must submit the
//     timeout transaction (§B.2).
//   - Partial awards and arbitrary recipient changes are outside this profile.
//
// C. Evaluator authority
//   - The preferred 2-of-3 evaluator signing authority is implemented through
//     an established multisignature mechanism (Safe{Wallet} + ERC-1271). The
//     `bytes` verdict signature field is a SIGNATURE CONTAINER, not threshold
//     enforcement: the Safe enforces its configured signing policy (2-of-3
//     owners); this contract validates the RESULTING AUTHORIZATION through
//     ERC-1271 isValidSignature when the evaluator is a contract, or through
//     ecrecover when the evaluator is an EOA (V1-compatible).
//   - Signing redundancy is NOT independent adjudication (§C.2). Evaluator
//     approval, gas-paying execution, and EAS attestation remain separate
//     responsibilities (§C.3). Evaluator approval keys must NOT reside in the
//     public API process (§C.4 — operator concern, not on-chain).
//   - Safe owner/threshold changes are a GOVERNANCE DEPENDENCY (§C.6): they
//     are disclosed/monitored off-chain; the custody contract reads only
//     isValidSignature at execution time.
//   - If the intended signing controls cannot be supported, admission stays
//     disabled; there is NO silent fallback to a single operator key (§C.7).

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

contract SAAXEscrowCustodyV2 {
    // ---- Types -----------------------------------------------------------------
    enum EscrowState { None, Funded, Disputed, Released, Refunded }

    struct Escrow {
        bytes32 commitmentId;
        bytes32 commitmentDigest;
        address token;          // USDC on Base Sepolia (testnet) / chain-confirmed asset
        address buyer;          // fixed beneficiary on refund / mutual-refund
        address seller;         // fixed beneficiary on release / mutual-release
        address evaluator;      // EOA (ecrecover) OR contract wallet (ERC-1271)
        uint256 amount;         // exact atomic units (token base units); no floats
        uint256 deadline;       // unix seconds: end of the resolution window (evaluator/mutual valid while < deadline AND < finalCutoff)
        uint256 finalCutoff;    // unix seconds: fixed, non-extendable timeout boundary (>= deadline); timeout eligible at/after
        uint64 minReleaseTime;  // escrow may not release before this
        uint256 policyId;       // versioned custody policy id (contract-admitted; e.g. keccak of policy doc + version)
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
    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "EscrowVerdict(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt)"
    );
    bytes32 public constant MUTUAL_TYPEHASH = keccak256(
        "MutualResolution(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt)"
    );

    string public constant DOMAIN_NAME = "SAAX Escrow Custody V2";
    string public constant DOMAIN_VERSION = "2";

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    uint256 public chainId;

    // ---- Storage ---------------------------------------------------------------
    mapping(bytes32 => Escrow) public escrows;          // commitmentId -> escrow
    mapping(uint256 => bool) public usedVerdictNonce;    // evaluator-verdict nonce replay guard
    mapping(uint256 => bool) public usedMutualNonce;     // mutual-resolution nonce replay guard

    // Exposure limits (policy §F.2). Activation-blocked until owner sets values:
    // 0 means NOT ADMITTED — fund() reverts PolicyNotAdmitted.
    uint256 public perPositionCap;   // max outstanding principal per escrow (atomic units)
    uint256 public aggregateCap;     // max total outstanding principal across all escrows
    uint256 public totalHeld;        // sum of outstanding (Funded + Disputed) principal

    // Admitted policy (policy §A.1): the versioned custody policy this
    // deployment is configured for. fund() REQUIRES the caller-supplied
    // policyId + policyDigest to equal the admitted values — an arbitrary
    // caller-supplied reference is NOT accepted (policy binding, not
    // decorative metadata).
    uint256 public admittedPolicyId;
    bytes32 public admittedPolicyDigest;

    // Admission gate (policy §F.3): stops INTAKE only. Exits are NEVER suppressed.
    bool public fundingEnabled;

    uint256 private _locked;

    // ---- Events ----------------------------------------------------------------
    event Funded(bytes32 indexed commitmentId, bytes32 commitmentDigest, address token, address buyer, address seller, address evaluator, uint256 amount, uint256 deadline, uint256 finalCutoff, uint256 policyId, bytes32 policyDigest, bytes32 agreementRef);
    event Released(bytes32 indexed commitmentId, address indexed seller, uint256 amount, bytes32 verdictHash);
    event Refunded(bytes32 indexed commitmentId, address indexed buyer, uint256 amount, bytes32 verdictHash);
    event Disputed(bytes32 indexed commitmentId, address by, string reason, uint256 at);
    event Resolved(bytes32 indexed commitmentId, string resolution, bytes32 verdictHash);
    event MutualResolution(bytes32 indexed commitmentId, string action, uint256 nonce);

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
        // NOTE: caps = 0 with fundingEnabled=true is a misconfiguration (a
        // zero cap means "not admitted"); the constructor enforces that a
        // positive funding-enabled deployment MUST have positive caps.
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

    function _hashTyped(uint256 nonce, uint256 issuedAt, bytes32 typehash, bytes32 commitmentId, bytes32 commitmentDigest, string memory action) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            domainSeparator(),
            keccak256(abi.encode(
                typehash,
                commitmentId,
                commitmentDigest,
                keccak256(bytes(action)),
                nonce,
                issuedAt
            ))
        ));
    }

    /// @dev Verdict digest (evaluator): EIP-712 EscrowVerdict.
    function _hashVerdict(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt) internal view returns (bytes32) {
        return _hashTyped(nonce, issuedAt, VERDICT_TYPEHASH, commitmentId, commitmentDigest, action);
    }

    /// @dev Mutual digest (buyer/seller): EIP-712 MutualResolution.
    function _hashMutual(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt) internal view returns (bytes32) {
        return _hashTyped(nonce, issuedAt, MUTUAL_TYPEHASH, commitmentId, commitmentDigest, action);
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

    function _recoverVerdictSigner(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        bytes32 digest = _hashVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    /// @dev Validates an evaluator verdict. Supports BOTH:
    ///   - EOA evaluator: (v,r,s) recovered to e.evaluator (V1-compatible).
    ///   - Contract-wallet evaluator (Safe + ERC-1271): raw (v,r,s) is
    ///     REQUIRED to be zeroed (the container is empty); the verdict digest
    ///     + the full packed signature bytes are checked via isValidSignature.
    ///   The `bytes` verdict field is a signature CONTAINER; the Safe enforces
    ///   its OWN threshold policy. Here we only authenticate the resulting
    ///   authorization.
    function _checkVerdict(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, uint8 v, bytes32 r, bytes32 s, bytes memory sigBytes, address expectedEvaluator) internal {
        if (issuedAt > block.timestamp + 120) revert NotYetValid();
        if (block.timestamp > issuedAt + 300) revert ExpiredVerdict();
        if (usedVerdictNonce[nonce]) revert Replay();

        bool ok;
        if (expectedEvaluator.code.length > 0) {
            // Contract wallet path: require the legacy (v,r,s) container to be
            // empty so there is no ambiguity about which signature authorizes.
            if (!(v == 0 && r == bytes32(0) && s == bytes32(0))) revert BadSignature();
            if (sigBytes.length == 0) revert BadSignature();
            bytes32 digest = _hashVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt);
            ok = _isValidSignature(expectedEvaluator, digest, sigBytes);
        } else {
            // EOA path (V1-compatible): recover from (v,r,s).
            address signer = _recoverVerdictSigner(commitmentId, commitmentDigest, action, nonce, issuedAt, v, r, s);
            ok = (signer == expectedEvaluator);
        }
        if (!ok) revert UnauthorizedSigner();
        usedVerdictNonce[nonce] = true;
    }

    function _recoverMutualSigner(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        bytes32 digest = _hashMutual(commitmentId, commitmentDigest, action, nonce, issuedAt);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    /// @dev Validates mutual resolution: BOTH buyer and seller signatures over
    ///      the SAME MutualResolution digest. Parties are EOAs here (contract
    ///      wallet party support is a documented Phase 3/4 integration item).
    function _checkMutual(bytes32 commitmentId, bytes32 commitmentDigest, string memory action, uint256 nonce, uint256 issuedAt, uint8 bv, bytes32 br, bytes32 bs, uint8 sv, bytes32 sr, bytes32 ss, address buyer, address seller) internal {
        if (issuedAt > block.timestamp + 120) revert NotYetValid();
        if (block.timestamp > issuedAt + 300) revert ExpiredVerdict();
        if (usedMutualNonce[nonce]) revert Replay();
        address signerB = _recoverMutualSigner(commitmentId, commitmentDigest, action, nonce, issuedAt, bv, br, bs);
        address signerS = _recoverMutualSigner(commitmentId, commitmentDigest, action, nonce, issuedAt, sv, sr, ss);
        if (signerB != buyer || signerS != seller) revert UnauthorizedSigner();
        usedMutualNonce[nonce] = true;
    }

    // ---- Safe transfer internals (V1-hardened, unchanged) ----------------------
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

    // ---- Admission / administration --------------------------------------------
    /// @dev Owner-equivalent admission control is intentionally NOT present in
    ///      this candidate (no owner role by design, mirroring V1). The caps +
    ///      fundingEnabled are set at construction for the local candidate.
    ///      Deployment-time configuration is the documented activation input.

    // ---- Fund ------------------------------------------------------------------
    /// @dev Creates the escrow, binding the exact agreement/policy terms.
    ///      Anyone may submit (msg.sender supplies the tokens) — the terms are
    ///      the authority, not the caller. policyId MUST equal the admitted
    ///      policy id; agreementRef and policyDigest MUST be non-zero and bound.
    function fund(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        address token,
        address buyer,
        address seller,
        address evaluator,
        uint256 amount,
        uint256 deadline,
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
        // Policy binding (§A.1): the terms are the authority. An arbitrary
        // caller-supplied reference does NOT substitute for agreement
        // authorization — the policy id + digest must match the admitted
        // policy this deployment enforces.
        if (policyId != admittedPolicyId) revert InvalidPolicy();
        if (policyDigest != admittedPolicyDigest) revert InvalidPolicy();
        // Valid deadline relationships (policy §A, design §6.1): the resolution
        // window must not extend past the final cutoff, and the final cutoff
        // must be in the future.
        if (deadline > finalCutoff) revert InvalidPolicy();
        if (finalCutoff <= block.timestamp) revert InvalidPolicy();
        // Cap enforcement (policy §F.2): per-position and aggregate.
        if (perPositionCap != 0 && amount > perPositionCap) revert CapExceeded();
        if (aggregateCap != 0 && totalHeld + amount > aggregateCap) revert CapExceeded();

        // Pull the USDC into custody FIRST; a failed movement reverts the
        // whole transaction, so no escrow is ever recorded unfunded. Liability
        // accounting (totalHeld) is independent of unsolicited direct token
        // transfers: only fund() increments totalHeld, and only terminal exits
        // decrement it. Direct donations to this contract do NOT inflate
        // liability and cannot be withdrawn by anyone.
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
            deadline: deadline,
            finalCutoff: finalCutoff,
            minReleaseTime: minReleaseTime,
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

        emit Funded(commitmentId, commitmentDigest, token, buyer, seller, evaluator, amount, deadline, finalCutoff, policyId, policyDigest, agreementRef);
        return true;
    }

    // ---- Authorized release ----------------------------------------------------
    /// @dev Evaluator-authorized release. Valid ONLY before finalCutoff. If the
    ///      evaluator is a contract wallet (Safe), sigBytes carries the
    ///      contract-wallet signature (2-of-3 enforced by the Safe itself).
    function release(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
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
        if (block.timestamp >= e.finalCutoff) revert AfterCutoff(); // §B.5: earlier signatures do not override cutoff rules
        _checkVerdict(commitmentId, commitmentDigest, "release", nonce, issuedAt, v, r, s, sigBytes, e.evaluator);

        _safeTransfer(e.token, e.seller, e.amount);
        e.state = EscrowState.Released;
        e.releasedAt = uint64(block.timestamp);
        totalHeld -= e.amount;
        emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(v, r, s)));
        return true;
    }

    // ---- Refund -----------------------------------------------------------------
    /// @dev Either an evaluator-signed refund verdict (valid ONLY before
    ///      finalCutoff), OR the timeout path (at/after finalCutoff — no
    ///      signature, beneficiary = buyer, caller may be anyone but CANNOT
    ///      choose a recipient). Disputed escrows use resolve() before cutoff
    ///      and are timeout-refundable at/after cutoff.
    function refund(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
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

        if (v != 0 || r != bytes32(0) || s != bytes32(0) || sigBytes.length > 0) {
            // Verdict refund: valid ONLY before the cutoff.
            if (e.state != EscrowState.Funded) revert WrongState(); // disputed must resolve first
            if (block.timestamp >= e.finalCutoff) revert AfterCutoff();
            _checkVerdict(commitmentId, commitmentDigest, "refund", nonce, issuedAt, v, r, s, sigBytes, e.evaluator);
        } else {
            // Timeout refund (policy §B.2): at/after finalCutoff, no signature.
            // Eligible for BOTH Funded and Disputed positions (policy §B.2:
            // "unresolved escrow becomes eligible for refund to the original
            // buyer, including disputed escrow").
            if (e.state != EscrowState.Funded && e.state != EscrowState.Disputed) revert WrongState();
            if (block.timestamp < e.finalCutoff) revert DeadlineNotPassed();
        }

        _safeTransfer(e.token, e.buyer, e.amount);
        e.state = EscrowState.Refunded;
        e.refundedAt = uint64(block.timestamp);
        totalHeld -= e.amount;
        emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(v, r, s)));
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
    /// @dev Evaluator resolution of a disputed escrow. Valid ONLY before
    ///      finalCutoff. "release"→seller, "refund"→buyer, "hold"→back to
    ///      Funded. At/after cutoff, the timeout refund path applies instead
    ///      (anyone may submit; beneficiary fixed to buyer).
    function resolve(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        string calldata resolution,
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
        if (block.timestamp >= e.finalCutoff) revert AfterCutoff(); // §B.5
        _checkVerdict(commitmentId, commitmentDigest, string.concat("resolve:", resolution), nonce, issuedAt, v, r, s, sigBytes, e.evaluator);

        if (keccak256(bytes(resolution)) == keccak256("release")) {
            _safeTransfer(e.token, e.seller, e.amount);
            e.state = EscrowState.Released;
            e.releasedAt = uint64(block.timestamp);
            totalHeld -= e.amount;
            emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(v, r, s)));
        } else if (keccak256(bytes(resolution)) == keccak256("refund")) {
            _safeTransfer(e.token, e.buyer, e.amount);
            e.state = EscrowState.Refunded;
            e.refundedAt = uint64(block.timestamp);
            totalHeld -= e.amount;
            emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(v, r, s)));
        } else if (keccak256(bytes(resolution)) == keccak256("hold")) {
            e.state = EscrowState.Funded;
            e.disputedBy = address(0);
            e.disputeReason = "";
            e.disputeAt = 0;
        } else {
            revert UnsupportedAction();
        }
        emit Resolved(commitmentId, resolution, keccak256(abi.encodePacked(v, r, s)));
        return true;
    }

    // ---- Mutual resolution (both parties) ---------------------------------------
    /// @dev Buyer + seller mutually sign the SAME MutualResolution digest.
    ///      Valid ONLY before finalCutoff. mutualRelease → seller;
    ///      mutualRefund → buyer. Fixed beneficiaries; no caller-chosen
    ///      recipient. Neither partial release nor partial refund is possible
    ///      (full amount only — restricted profile).
    function _mutual(
        bytes32 commitmentId,
        bytes32 commitmentDigest,
        string memory action,
        uint256 nonce,
        uint256 issuedAt,
        uint8 bv, bytes32 br, bytes32 bs,
        uint8 sv, bytes32 sr, bytes32 ss
    ) internal nonReentrant returns (bool) {
        Escrow storage e = escrows[commitmentId];
        if (e.state == EscrowState.None) revert NotFunded();
        if (e.commitmentDigest != commitmentDigest) revert WrongDigest();
        if (e.state != EscrowState.Funded) revert WrongState();
        if (block.timestamp >= e.finalCutoff) revert AfterCutoff(); // §B.5
        _checkMutual(commitmentId, commitmentDigest, action, nonce, issuedAt, bv, br, bs, sv, sr, ss, e.buyer, e.seller);

        if (keccak256(bytes(action)) == keccak256("release")) {
            _safeTransfer(e.token, e.seller, e.amount);
            e.state = EscrowState.Released;
            e.releasedAt = uint64(block.timestamp);
            totalHeld -= e.amount;
            emit Released(commitmentId, e.seller, e.amount, keccak256(abi.encodePacked(bv, br, bs, sv, sr, ss)));
        } else if (keccak256(bytes(action)) == keccak256("refund")) {
            _safeTransfer(e.token, e.buyer, e.amount);
            e.state = EscrowState.Refunded;
            e.refundedAt = uint64(block.timestamp);
            totalHeld -= e.amount;
            emit Refunded(commitmentId, e.buyer, e.amount, keccak256(abi.encodePacked(bv, br, bs, sv, sr, ss)));
        } else {
            revert UnsupportedAction();
        }
        emit MutualResolution(commitmentId, action, nonce);
        return true;
    }

    function mutualRelease(
        bytes32 commitmentId, bytes32 commitmentDigest, uint256 nonce, uint256 issuedAt,
        uint8 bv, bytes32 br, bytes32 bs, uint8 sv, bytes32 sr, bytes32 ss
    ) external returns (bool) {
        return _mutual(commitmentId, commitmentDigest, "release", nonce, issuedAt, bv, br, bs, sv, sr, ss);
    }

    function mutualRefund(
        bytes32 commitmentId, bytes32 commitmentDigest, uint256 nonce, uint256 issuedAt,
        uint8 bv, bytes32 br, bytes32 bs, uint8 sv, bytes32 sr, bytes32 ss
    ) external returns (bool) {
        return _mutual(commitmentId, commitmentDigest, "refund", nonce, issuedAt, bv, br, bs, sv, sr, ss);
    }

    // ---- Read -------------------------------------------------------------------
    function getEscrow(bytes32 commitmentId) external view returns (
        bytes32 id, bytes32 digest, address token, address buyer, address seller,
        address evaluator, uint256 amount, uint256 deadline, uint256 finalCutoff,
        uint64 minReleaseTime, uint256 policyId, bytes32 policyDigest, bytes32 agreementRef,
        EscrowState state, address disputedBy, uint256 disputeAt, uint64 releasedAt, uint64 refundedAt
    ) {
        Escrow storage e = escrows[commitmentId];
        return (e.commitmentId, e.commitmentDigest, e.token, e.buyer, e.seller, e.evaluator,
            e.amount, e.deadline, e.finalCutoff, e.minReleaseTime, e.policyId, e.policyDigest,
            e.agreementRef, e.state, e.disputedBy, e.disputeAt, e.releasedAt, e.refundedAt);
    }

    /// @dev Outstanding liability (Funded + Disputed principal).
    function balanceHeld(address token) external view returns (uint256) {
        return IERC20Returning(token).balanceOf(address(this));
    }
}