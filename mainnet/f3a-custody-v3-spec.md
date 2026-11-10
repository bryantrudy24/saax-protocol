# F3A Custody V3 — Normative Specification (Restricted OBJECTIVE_DIGITAL)

**Status:** NORMATIVE SPECIFICATION for the approved F3A custody V3 candidate.
**Baseline:** HEAD `f3e90663` (F2 corrections, docs only).
**Implementation:** `contracts/SAAXEscrowCustodyV3.sol` (PRE-AUDIT CANDIDATE, immutable).
**Supersedes:** the OPEN decision gates D1–D8 of `mainnet/f2-design-corrections.md` §5 per the F3A approved policy; this document records which option each gate resolved to.
**Scope:** contract + signature support only. Worker/verifier integration is F3B and is NOT implemented here.
**Deliverable labels:** `CANDIDATE_LABEL = "pre-audit-candidate"`, `CUSTODY_VERSION = 3`.

---

## 1. Approved policy → normative rules

### 1.1 Pre-settlement-head commitment (approved policy 1)

| Rule | Normative spec |
|---|---|
| R1.1 Evaluator resolutions require the head inside the evaluator-authorized payload | `EscrowVerdict` (V3) has 6 fields: `commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead`. The settlement functions (`release`, `refundVerdict`, `resolve`) require the caller-supplied head to equal the head the evaluator signed; signature recovery/isValidSignature is over the digest containing that head. Non-zero head is REQUIRED on all evaluator and mutual settlement paths (`HeadRequired`). |
| R1.2 Mutual resolutions require both parties to authorize the same head | `MutualResolution` (V3) has the same 6 fields. Both buyer and seller signatures are recovered over the identical digest (identical head). A mismatch between the two parties' heads, or between the signed head and the caller-passed head, fails `UnauthorizedSigner`. |
| R1.3 Timeout refund requires no checkpoint, no journal availability, no fresh signature, no operator cooperation | `refundTimeout(commitmentId, commitmentDigest)` has NO signature parameters and NO head parameter. Eligibility is the contract clock (`block.timestamp >= finalCutoff`). Anyone may submit; beneficiary is fixed to the escrow's original buyer; no head is recorded (`committedHead`/`headCommittedAt` remain zero). An ABI-level head representation is rejected by construction (no such parameter). |
| R1.4 Commit the journal state before settlement; append the receipt afterward | On an authorized settlement, the `preSettlementHead` (the pre-settlement journal tail as computed by the worker off-chain) is recorded IN THE SAME TRANSACTION before the receipt can be linked: `committedHead := preSettlementHead`, `headCommittedAt := block.timestamp`, then the money movement, then `HeadCommitted` + terminal events. The contract does not append journal entries; the off-chain worker appends the settlement receipt after confirmation. |
| R1.5 Do not claim the contract knows the complete off-chain history | The contract records the *submitted* head only. No completeness claim. The verifier (F3B) checks `committedHead == journal tail` off-chain. |

### 1.2 Exact execution boundaries (approved policy 2)

Legacy terminology mapping: the V2 struct field `deadline` is renamed `resolutionDeadline` in V3. `legacyDeadline(commitmentId)` exposes the same value for historical tooling.

Let `T_fund` = funding block timestamp, `T_exec` = execution block timestamp.

| Path | Earliest | Latest | Normative boundary | Contract error |
|---|---|---|---|---|
| Fund | `fundingEnabled` must be true | `T_fund < resolutionDeadline` | `block.timestamp < resolutionDeadline` | `AfterResolutionDeadline`, `FundingDisabled` |
| Evaluator release (`release`) | `T_exec >= minReleaseTime` | `T_exec < resolutionDeadline` | both | `NotYetValid`, `AfterResolutionDeadline` |
| Evaluator refund (`refundVerdict`) | none (no min-release) | `T_exec < resolutionDeadline` | second only | `AfterResolutionDeadline` |
| Disputed release (`resolve` + `release`) | `T_exec >= minReleaseTime` | `T_exec < resolutionDeadline` | both | `NotYetValid`, `AfterResolutionDeadline` |
| Disputed refund (`resolve` + `refund`) | none | `T_exec < resolutionDeadline` | second only | `AfterResolutionDeadline` |
| Mutual release (`mutualRelease`) | `T_exec >= minReleaseTime` | `T_exec < resolutionDeadline` | both | `NotYetValid`, `AfterResolutionDeadline` |
| Mutual refund (`mutualRefund`) | none | `T_exec < resolutionDeadline` | second only | `AfterResolutionDeadline` |
| Timeout refund (`refundTimeout`) | `T_exec >= finalCutoff` | terminal | first only | `DeadlineNotPassed` |
| `raiseDispute` | state Funded | — | party = buyer \| seller | `WrongState`, `NotParty` |

Fund-time parameter validation (normative, hard):

```
minReleaseTime < resolutionDeadline   (strict)
resolutionDeadline <= finalCutoff     (equality ALLOWED)
Block.timestamp < resolutionDeadline  (funding window; = AfterResolutionDeadline)
```

Semantics that are explicitly decided:
- Funding **after** `minReleaseTime` is allowed while `resolutionDeadline` remains open; `minReleaseTime > T_fund` is NOT required.
- Equality `resolutionDeadline == finalCutoff` is allowed; then evaluator/mutual authority and timeout eligibility coincide exactly.
- If `resolutionDeadline < finalCutoff`, the interval `[resolutionDeadline, finalCutoff)` is the **intentional no-ordinary-resolution gap**: evaluator/mutual settlement is blocked (`AfterResolutionDeadline`), timeout is NOT yet eligible (`DeadlineNotPassed`); only the timeout at/after `finalCutoff` exits the position.
- `resolutionDeadline` in the past at fund is rejected (`AfterResolutionDeadline`), a change from V2 (which only required `finalCutoff > T_fund`); this closes the D8 admissibility gap per the approved policy "funding at/after resolutionDeadline rejected".

### 1.3 Authorization validity (approved policy 3)

- Contract-enforced at execution, unchanged from V2:
  - `issuedAt > block.timestamp + 120` → `NotYetValid` (future-skew cap)
  - `block.timestamp > issuedAt + 300` → `ExpiredVerdict` (expiry; equality `== issuedAt + 300` is accepted)
- Evaluated at execution using the CURRENT block timestamp. Historical verification uses the relevant historical time (F3B verifier concern), NOT today's expiry.
- Access expiry (service-layer authorization expiry in endpoint/escrow-access.js) is kept SEPARATE: it is not re-checked by the contract and is not part of this spec.

### 1.4 Nonces (approved policy 4)

| Property | Normative spec |
|---|---|
| Scope | ESCROW-SCOPED: `usedVerdictNonce[commitmentId][nonce]` and `usedMutualNonce[commitmentId][nonce]`. A nonce consumed on escrow A does not block escrow B. |
| Class separation | Verdict nonces and mutual nonces are separate mappings + separate typehashes. The same numeric nonce can be used in both classes without conflict (and across escrows). |
| Replay within an escrow+class | `Replay` if already consumed. |
| Replay across escrows | Impossible (scope). |
| Replay across chains / versions / custody deployments | Impossible via the EIP-712 domain separator: `(name="SAAX Escrow Custody V3", version="3", chainId, verifyingContract=this)`. A signature from chain X, from the V2 domain, or from another custody address recovers a different digest → `UnauthorizedSigner`. |
| V2 preservation | V2 keeps its global `usedVerdictNonce`/`usedMutualNonce`. V3 is a NEW contract with a fresh nonce space; V2 behavior is untouched (historical V2 behavior preserved by not modifying V2). |
| Explicit replay semantics | A failed attempt (wrong signature/head/party) does NOT consume the nonce (the recording happens only after full validation passes). Terminal exclusivity guards a second payout even for a replayed nonce. |

### 1.5 Existing safeguards (approved policy 5)

Retained verbatim from V2: exact agreement/policy/party/asset/amount bindings at fund (`commitmentId`, `commitmentDigest`, token, buyer, seller, evaluator, exact amount, `policyId`==admitted, `policyDigest`==admitted, `agreementRef` != 0); fixed beneficiaries (buyer/seller only, no caller-chosen recipient on ANY path including timeout); per-position and aggregate caps + `totalHeld` liability accounting; `fundingEnabled` intake gate (exits never suppressed); V1-hardened token-transfer checks (exact balance-delta on pull and push; non-returning/failed transfers revert `TransferFailed`); terminal exclusivity (one terminal state per escrow, no double payout); Safe/ERC-1271 evaluator support (Safe enforces its own threshold; contract validates the resulting authorization) and ecrecover for EOA evaluators. No arbitrary admin withdrawal and no recipient substitution exist by construction. Advanced profiles (`PHYSICAL_DELIVERY`, `SUBJECTIVE_SERVICE`, `HIGH_VALUE_ASSURANCE`) and mainnet admission remain disabled.

---

## 2. Complete action/state table

States: `None(0), Funded(1), Disputed(2), Released(3), Refunded(4)`.

| # | Action | From | To | Authority | Boundaries (T_exec) | Head | Nonce | Events |
|---|---|---|---|---|---|---|---|---|
| 1 | `fund` | None | Funded | caller (terms bind) | `< RDL`; fundingEnabled; caps | — | — | `Funded` |
| 2 | `release` | Funded | Released | evaluator (EOA/Safe ERC-1271) | `>= MRT`, `< RDL` | required, recorded | verdict nonce | `HeadCommitted`, `Released` |
| 3 | `refundVerdict` | Funded | Refunded | evaluator | `< RDL` | required, recorded | verdict nonce | `HeadCommitted`, `Refunded` |
| 4 | `raiseDispute` | Funded | Disputed | buyer or seller | none | — | — | `Disputed` |
| 5 | `resolve` + `release` | Disputed | Released | evaluator | `>= MRT`, `< RDL` | required, recorded | verdict nonce | `HeadCommitted`, `Released`, `Resolved` |
| 6 | `resolve` + `refund` | Disputed | Refunded | evaluator | `< RDL` | required, recorded | verdict nonce | `HeadCommitted`, `Refunded`, `Resolved` |
| 7 | `resolve` + `hold` | Disputed | Funded | evaluator | `< RDL` | required, recorded | verdict nonce | `HeadCommitted`, `Resolved` |
| 8 | `resolve` + anything else | — | revert | — | — | — | — | `UnsupportedAction` |
| 9 | `mutualRelease` | Funded | Released | buyer + seller | `>= MRT`, `< RDL` | required, same for both, recorded | mutual nonce | `HeadCommitted`, `Released`, `MutualResolution` |
| 10 | `mutualRefund` | Funded | Refunded | buyer + seller | `< RDL` | required, same for both, recorded | mutual nonce | `HeadCommitted`, `Refunded`, `MutualResolution` |
| 11 | `refundTimeout` | Funded or Disputed | Refunded | none (clock) | `>= finalCutoff` | ABSENT (never recorded) | none | `Refunded` (zero head) |
| 12 | any terminal re-execution | Released/Refunded | — | revert | — | — | — | `WrongState` |

No other transitions are possible. `resolve` from Funded, `release` from Disputed, `raiseDispute` on terminal states, mutual on non-Funded — all revert `WrongState`.

---

## 3. Checkpoint encoding

- `preSettlementHead` is `bytes32`, the off-chain journal's pre-settlement tail hash as computed by the journal producer (hash chain over prior entries; exact canonicalization is F3B/verifier scope — the contract treats it as an opaque committed binding).
- Zero (`bytes32(0)`) is the REJECTED representation on evaluator/mutual paths (`HeadRequired`) and the ONLY representation on the timeout path (absent by ABI).
- Stored per escrow: `committedHead` (bytes32) + `headCommittedAt` (uint256, execution timestamp). Never reset by `hold` (a hold commits the head that authorized moving back to Funded; a later settlement must commit a (possibly different) head — its own).
- The contract does NOT store the full checkpoint chain; it commits the submitted head only (R1.5).

---

## 4. Nonce scope and semantics (summary)

See §1.4. Public views: `usedVerdictNonce(bytes32,uint256)`, `usedMutualNonce(bytes32,uint256)`.

---

## 5. Events (ABI)

| Event | Fields |
|---|---|
| `Funded` | `indexed commitmentId`, `commitmentDigest`, `token`, `buyer`, `seller`, `evaluator`, `amount`, `resolutionDeadline`, `finalCutoff`, `policyId`, `policyDigest`, `agreementRef` |
| `Released` | `indexed commitmentId`, `indexed seller`, `amount`, `verdictHash`, `preSettlementHead` |
| `Refunded` | `indexed commitmentId`, `indexed buyer`, `amount`, `verdictHash`, `preSettlementHead` |
| `Disputed` | `indexed commitmentId`, `by`, `reason`, `at` |
| `Resolved` | `indexed commitmentId`, `resolution`, `verdictHash`, `preSettlementHead` |
| `MutualResolution` | `indexed commitmentId`, `action`, `nonce`, `preSettlementHead` |
| `HeadCommitted` | `indexed commitmentId`, `preSettlementHead`, `at` |

`verdictHash` = `keccak256(abi.encodePacked(v, r, s))` (or the packed mutual sigs), consistent with V2, plus the explicit head field for provenance.

---

## 6. ABI

Public functions (exact selectors recorded in the build manifest):

```
constructor(uint256 perPositionCap, uint256 aggregateCap, bool fundingEnabled, uint256 admittedPolicyId, bytes32 admittedPolicyDigest)
domainSeparator() view → bytes32
legacyDeadline(bytes32) view → uint256
getEscrow(bytes32) view → (id, digest, token, buyer, seller, evaluator, amount, resolutionDeadline, finalCutoff, minReleaseTime, committedHead, headCommittedAt, policyId, policyDigest, agreementRef, state, disputedBy, disputeAt, releasedAt, refundedAt) [20-tuple]
fund(bytes32,bytes32,address,address,address,address,uint256,uint256,uint256,uint64,uint256,bytes32,bytes32) → bool
release(bytes32,bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32,bytes) → bool        # +preSettlementHead at position 3
refundVerdict(bytes32,bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32,bytes) → bool # +preSettlementHead at position 3
refundTimeout(bytes32,bytes32) → bool
raiseDispute(bytes32,bytes32,string) → bool
resolve(bytes32,bytes32,string,bytes32,uint256,uint256,uint8,bytes32,bytes32,bytes) → bool  # resolution, +preSettlementHead
mutualRelease(bytes32,bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32,uint8,bytes32,bytes32) → bool
mutualRefund(bytes32,bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32,uint8,bytes32,bytes32) → bool
perPositionCap() / aggregateCap() / totalHeld() / fundingEnabled() / admittedPolicyId() / admittedPolicyDigest() / chainId() / DOMAIN_NAME() / DOMAIN_VERSION() / CUSTODY_VERSION() / CANDIDATE_LABEL() / DOMAIN_TYPEHASH() / VERDICT_TYPEHASH() / MUTUAL_TYPEHASH() / escrows(bytes32) / usedVerdictNonce(bytes32,uint256) / usedMutualNonce(bytes32,uint256) / balanceHeld(address)
```

---

## 7. Storage layout (V3)

| Slot group | Fields | Notes |
|---|---|---|
| Constants/immutable-ish | `chainId` (constructor), `perPositionCap`, `aggregateCap`, `fundingEnabled`, `admittedPolicyId`, `admittedPolicyDigest` | no owner; constructor-set |
| `escrows` | `mapping(bytes32 => Escrow)` — see struct in contract: commitmentId, commitmentDigest, token, buyer, seller, evaluator, amount, resolutionDeadline, finalCutoff, minReleaseTime, committedHead, headCommittedAt, policyId, policyDigest, agreementRef, state, disputedBy, disputeReason, disputeAt, releasedAt, refundedAt | V3 adds `committedHead` + `headCommittedAt` vs V2 |
| `usedVerdictNonce` | `mapping(bytes32 => mapping(uint256 => bool))` | escrow-scoped (V3; V2 was global) |
| `usedMutualNonce` | `mapping(bytes32 => mapping(uint256 => bool))` | escrow-scoped (V3) |
| `totalHeld` | uint256 liability | only fund() increments; only terminal exits decrement |
| `_locked` | uint256 reentrancy guard | nonReentrant modifiers |

---

## 8. Rejection of unknown or ambiguous representations

- Unknown action literals (anything not `release`/`refund`/`hold` in `resolve`; anything not `release`/`refund` in mutual) → `UnsupportedAction`.
- Ambiguous head representations: zero head on a settlement path → `HeadRequired`; any signed head != caller-passed head → `UnauthorizedSigner`; there is no "optional" head anywhere on evaluator/mutual paths, and no head parameter at all on `refundTimeout` (an ABI-level head on timeout is impossible).
- V2-era 5-field verdict/mutual signatures submitted to V3 → fail typehash/domain separation (`UnauthorizedSigner`), verified by test.
- Caller-selected recipients are absent from the entire ABI.

---

## 9. Rejected/open items (F3B + review gates)

- Worker intent persistence, journal append-after-receipt, outbox drain: F3B.
- Verifier checks (head equality, head authority, timeout-no-head, V3 runtime-hash identity, negative battery): F3B.
- Admission wiring for a V3 custody address: F3B/mainnet gate (stays disabled).
- Independent review: NOT COMPLETED (pre-audit candidate).
- Numerical caps / Safe owner set / USDC pinning / mainnet RPC+finality policy: unchanged open items from F2 closeout.

## 10. Provenance

- Decision gates resolved by the F3A approved policy: D1=B (head in payload), D2=enforce `resolutionDeadline`, D3=enforce minReleaseTime on resolve/mutual release, D4=add validation at fund, D5=no-checkpoint timeout, D6=in-payload, D7=escrow-scoped nonces, D8=reject past resolutionDeadline at fund.
- Build manifest: see `artifacts/f3a/v3-build-manifest.json`.