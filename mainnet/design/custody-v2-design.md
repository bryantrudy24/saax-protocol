# SAAX Custody Design — v2 (proposed)

**Status:** INTERNAL DESIGN — proposed implementation version, not a protocol-wide version claim. Not deployed. Not independently reviewed.
**Version:** `custody-v2-design` (design document version 1)
**Prepared:** by the station overseer (Lucius Fox) under Phase 2 of the approved mainnet escrow plan.
**Authoritative inputs:**
- `mainnet/policies/custody-policy-v1.md` (normative policy)
- `mainnet/policies/transaction-profiles-v1.md` (profile requirements)
- `mainnet/agreements/custody-policy-addendum-v1.md` (agreement template)
- `contracts/SAAXEscrowCustodyV1.sol` (current immutable testnet implementation)
- `mainnet/mainnet-escrow-readiness.md` (roadmap, gates, decisions D1–D9)

**Scope discipline:** this document specifies a proposed custody implementation (v2) for the restricted OBJECTIVE_DIGITAL profile and the deferred advanced profiles. It does **not** implement, deploy, or enable funding. No mainnet funding is enabled by this document. The design assumes the owner's policy direction (approved) and records every unresolved economic/legal parameter as an activation blocker.

---

## 1. Purpose and relationship to the current contract

### 1.1 What the current contract is

`SAAXEscrowCustodyV1` (Solidity 0.8.26, immutable, admin-less, testnet-only) implements:

- `fund(commitmentId, commitmentDigest, token, buyer, seller, evaluator, amount, deadline, minReleaseTime)` — anyone may fund; binds all terms; pulls USDC via safe transfer before the state write.
- `release(...)` — evaluator-signed EIP-712 `EscrowVerdict{action:"release"}`; state `Funded`; funds to seller; terminal.
- `refund(...)` — evaluator-signed `{action:"refund"}` **or** deadline-passed timeout refund; state `Funded`; funds to buyer; terminal.
- `raiseDispute(...)` — only buyer or seller; state → `Disputed`; freezes the escrow.
- `resolve(...)` — evaluator-signed verdict `release` | `refund` | `hold`; from `Disputed` only.
- `getEscrow(bytes32)`, `balanceHeld(token)`, `domainSeparator()`.

**Limitations (confirmed from source):** no admin, no owner, no upgrade, no pause, no deposit cap, no evaluator replacement, no withdrawal, no cross-contract migration. `resolve("hold")` returns Disputed → Funded only via evaluator verdict. **No deadline timeout refund while Disputed** — `refund()` reverts `WrongState`. No final-cutoff refund distinct from `deadline`. No mutual-signed release/refund path (`release`/`refund` require the evaluator verdict).

### 1.2 What v2 adds (exact differences)

The v2 design is a **new immutable deployment** (never an upgrade of funded positions) that implements the restricted OBJECTIVE_DIGITAL profile per policy §B and, in a locked-deferred form, the advanced profiles' longstop requirements. Exact deltas from V1:

| # | V1 (current) | V2 (proposed) | Policy driver |
|---|---|---|---|
| D1 | `deadline` is the only time boundary; timeout refund from `Funded` only | Add explicit `finalCutoff` (≥ resolution deadline) as the fixed, non-extendable cutoff; timeout refund eligible at/after cutoff **including `Disputed` state** | §B.2, §B.4 |
| D2 | No mutual-signed release/refund path | Add `mutualRelease`/`mutualRefund` — both parties' EIP-712 signatures, valid only before the final cutoff | §B.1 |
| D3 | Evaluator verdict valid indefinitely (300s expiry window from `issuedAt`, no cutoff relation) | Verdict signatures **cannot override execution-time cutoff rules**: a release verdict issued before cutoff is not executable after cutoff in a manner conflicting with cutoff rules | §B.5 |
| D4 | Dispute freezes funds with no exit | At/after final cutoff, an unresolved (including disputed) escrow is eligible for refund to the original buyer; eligibility ≠ automatic execution (someone must submit) | §B.2, §B.7 |
| D5 | No partial awards | v2 keeps whole-escrow outcomes only (release in full / refund in full); partial awards and arbitrary recipient changes remain outside the profile | §B.8 |
| D6 | Evaluator is a single EOA address checked via `ecrecover` | v2 requires the **2-of-3 evaluator signing authority** to be supported (policy §C.1); the dispatch/verification mechanism is specified in §7; admission stays disabled until the mechanism is supported | §C.1–C.7 |
| D7 | No deposit caps | v2 defines **exposure limits** that MUST be enforced on-chain if advertised as hard custody limits (per-position and aggregate) — activation blocker until owner sets values | §F.2 |
| D8 | No admission gating | `fund` may include an admission gate (permissioned funding) that can be stopped without suppressing agreed exit paths | §F.3 |
| D9 | `resolve("hold")` returns to Funded | Retained for v2, but the final cutoff still applies: a `Disputed` escrow that resolves to `hold` (Funded) at/after cutoff is still refund-eligible to the buyer | §B.2 |
| D10 | Relayer anyone; recipient fixed by terms | Preserved: any eligible submitter may execute a timeout refund, but **MUST NOT select another recipient** — the refund beneficiary is the original buyer (fixed at fund) | §B.6 |

### 1.3 Design principles preserved from V1

- **Immutable, admin-less, no withdrawal path.** No operator can pull escrow principal.
- **Funds move first, state writes second** (checks-effects-interactions; a failing movement reverts the transition).
- **Safe transfers with exact-delta checks** (rejects fee-on-transfer/rebasing deltas and no-return tokens).
- **Terminal states are final** — one release OR one refund, never both; competing transactions cannot produce two payouts.
- **Relayer-friendly**: `msg.sender` is not the authority; the embedded verdict/mutual signatures are.

---

## 2. Storage fields, supported assets, roles, authority

### 2.1 Storage (struct per escrow, keyed by `commitmentId`)

```
struct Escrow {
  bytes32 commitmentId;
  bytes32 commitmentDigest;      // canonical agreement digest (v4 manifest, sha256)
  address token;                 // whitelisted asset (exactly one per deployment at v2)
  address buyer;                 // fixed beneficiary (refund)
  address seller;                // fixed beneficiary (release)
  address evaluator;             // the 2-of-3 signing authority contract/aggregate (see §7)
  uint256 amount;                // exact integer, token base units
  uint256 deadline;              // unix seconds; resolution window end (evaluator/mutual resolutions valid only before)
  uint256 finalCutoff;           // unix seconds; >= deadline; fixed at funding; the only timeout boundary
  uint64  minReleaseTime;        // escrow may not release before this
  EscrowState state;             // None|Funded|Disputed|Released|Refunded
  address disputedBy;
  string  disputeReason;         // URI/ref
  uint256 disputeAt;
  uint64  releasedAt;
  uint64  refundedAt;
  uint256 policyId;              // versioned custody policy id (e.g. hash of policy doc + version)
  bytes32 agreementRef;          // hash of the signed v4 agreement (off-chain reference, not the terms themselves)
}
```

**New fields vs V1:** `finalCutoff`, `policyId`, `agreementRef`. `deadline` is kept but its meaning is narrowed to "end of the resolution window" (evaluator/mutual resolutions valid only before it — see §6.1). `finalCutoff` is the policy §B.2 boundary.

### 2.2 Global storage

```
mapping(bytes32 => Escrow) public escrows;        // commitmentId -> escrow
mapping(uint256 => bool) public usedVerdictNonce; // evaluator-verdict nonce replay guard (per deployment)
mapping(address => bool) public whitelistedToken; // token whitelist (set at construction; immutable)
uint256 public perPositionCap;                    // 0 = no cap (activation blocker until owner sets)
uint256 public aggregateCap;                      // 0 = no cap
uint256 public totalHeld;                         // sum of outstanding principal (for aggregate cap)
uint256 private _locked;
```

### 2.3 Supported assets

Exactly one whitelisted token per deployment at v2 (Base Sepolia testnet USDC `0x036CbD…CF7e`; mainnet USDC address to be re-derived/verified — activation blocker). The token whitelist is fixed at construction. Fee-on-transfer/rebasing tokens are rejected by the exact-delta check (documented caveat: not provable for every rebasing token; the whitelist is the enforcement point).

### 2.4 Roles and authority

| Role | Who | Authority | On-chain check |
|---|---|---|---|
| Buyer | The agreement-identified buyer (party signature binds this) | Fund (via app), raise dispute, mutually sign release/refund before cutoff, submit timeout refund? (buyer may submit; anyone may) | `msg.sender == buyer` for dispute; mutual signature recovery for mutual paths; timeout refund: any caller |
| Seller | The agreement-identified seller | Raise dispute, mutually sign release/refund | `msg.sender == seller` for dispute; mutual signature recovery |
| Evaluator | The 2-of-3 signing authority (policy §C.1) — contract wallet or threshold aggregate | Sign verdicts (release/refund/resolve) within the resolution window | `_checkVerdict` with the v2 evaluator-verification mechanism (§7) |
| Relayer | Anyone | Submit any valid transaction (fund, timeout refund, verdict execution) | Not an authority; embedded signatures/eligibility govern |
| Operator | Service operator | No on-chain authority; can stop admission/funding intake; cannot move funds | none |

**No role address, receipt, payment authorization, or service configuration substitutes for agreement authorization** (policy §A.3). The on-chain `buyer`/`seller`/`evaluator` are bound at `fund` from the agreement digest; a funding call that disagrees with the digest is rejected.

---

## 3. Proposed external function interfaces

```
// Admission + funding
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
  uint64  minReleaseTime,
  uint256 policyId,
  bytes32 agreementRef
) external returns (bool);

// Authorized release (evaluator verdict), before final cutoff
function release(
  bytes32 commitmentId,
  bytes32 commitmentDigest,
  uint256 verdictNonce,
  uint256 issuedAt,
  bytes calldata evSignature      // evaluator-aggregate signature (see §7)
) external returns (bool);

// Refund: evaluator verdict, OR timeout (at/after finalCutoff, including Disputed)
function refund(
  bytes32 commitmentId,
  bytes32 commitmentDigest,
  uint256 verdictNonce,
  uint256 issuedAt,
  bytes calldata evSignature      // empty for timeout refund
) external returns (bool);

// Mutual release (both parties), before final cutoff
function mutualRelease(
  bytes32 commitmentId,
  bytes32 commitmentDigest,
  uint256 mutualNonce,
  uint256 issuedAt,
  bytes calldata buyerSig,
  bytes calldata sellerSig
) external returns (bool);

// Mutual refund (both parties), before final cutoff
function mutualRefund(
  bytes32 commitmentId,
  bytes32 commitmentDigest,
  uint256 mutualNonce,
  uint256 issuedAt,
  bytes calldata buyerSig,
  bytes calldata sellerSig
) external returns (bool);

// Dispute (buyer or seller only)
function raiseDispute(
  bytes32 commitmentId,
  bytes32 commitmentDigest,
  string calldata reason
) external returns (bool);

// Resolve a dispute (evaluator verdict: release | refund | hold) — before final cutoff
function resolve(
  bytes32 commitmentId,
  bytes32 commitmentDigest,
  string calldata resolution,
  uint256 verdictNonce,
  uint256 issuedAt,
  bytes calldata evSignature
) external returns (bool);

// Read surface (unchanged shape, extended)
function getEscrow(bytes32 commitmentId) external view returns (/* V1 fields + finalCutoff, policyId, agreementRef */);
function balanceHeld(address token) external view returns (uint256);
function domainSeparator() external view returns (bytes32);
```

**Signature format note:** V1 used raw `(v,r,s)` for the evaluator. V2 changes the evaluator parameter to `bytes` because the 2-of-3 mechanism (contract wallet / threshold aggregate) has a variable-length signature. This is a **breaking ABI change** — hence a new deployment, never an upgrade. §7 specifies the exact mechanism and compatibility.

---

## 4. States and the complete transition table

### 4.1 States (unchanged enum, extended semantics)

```
enum EscrowState { None, Funded, Disputed, Released, Refunded }
```

### 4.2 Transition table

| # | From | To | Action | Preconditions | Authorized callers/signatures | Effects | Event | Failures |
|---|---|---|---|---|---|---|---|---|
| T1 | None | Funded | `fund` | Agreement digest matches terms; policy version + digest valid; token whitelisted; amount ≤ perPositionCap; totalHeld+amount ≤ aggregateCap; buyer≠seller; all addrs non-zero | anyone (msg.sender pays the token) | USDC pulled into custody; escrow record created; totalHeld += amount | `Funded(...)` | WrongDigest, WrongState, InvalidToken, SelfTransfer, TransferFailed, CapExceeded, PolicyNotAdmitted |
| T2 | Funded | Released | `release` | state==Funded; digest matches; block.timestamp ≥ minReleaseTime; **block.timestamp < finalCutoff**; evaluator verdict valid (§6.2) | evaluator verdict (via relayer) | USDC → seller; totalHeld -= amount; state=Released; releasedAt=now | `Released(...)` | NotFunded, WrongDigest, WrongState, AfterCutoff, UnauthorizedSigner, BadSignature, Replay, ExpiredVerdict, NotYetValid, TransferFailed |
| T3 | Funded | Refunded | `refund` (verdict) | state==Funded; digest matches; **block.timestamp < finalCutoff**; evaluator refund verdict valid | evaluator verdict | USDC → buyer; totalHeld -= amount; state=Refunded; refundedAt=now | `Refunded(...)` | as T2 (AfterCutoff instead of timeout eligibility) |
| T4 | Funded | Refunded | `refund` (timeout) | state==Funded; digest matches; **block.timestamp ≥ finalCutoff**; no signature required | anyone (relayer; beneficiary is fixed buyer) | USDC → buyer; totalHeld -= amount; state=Refunded; refundedAt=now | `Refunded(...)` | NotFunded, WrongDigest, WrongState, DeadlineNotPassed |
| T5 | Funded | Disputed | `raiseDispute` | state==Funded; digest matches; msg.sender ∈ {buyer, seller} | buyer or seller | state=Disputed; disputedBy=msg.sender; disputeReason=reason; disputeAt=now | `Disputed(...)` | NotFunded, WrongDigest, WrongState, NotParty |
| T6 | Disputed | Released | `resolve` (release) | state==Disputed; digest matches; **block.timestamp < finalCutoff**; evaluator verdict action `resolve:release` valid | evaluator verdict | USDC → seller; totalHeld -= amount; state=Released; releasedAt=now | `Released(...)`, `Resolved(...)` | NotFunded, WrongDigest, WrongState, AfterCutoff, UnauthorizedSigner, BadSignature, Replay, ExpiredVerdict, TransferFailed |
| T7 | Disputed | Refunded | `resolve` (refund) | state==Disputed; digest matches; **block.timestamp < finalCutoff**; evaluator verdict action `resolve:refund` valid | evaluator verdict | USDC → buyer; totalHeld -= amount; state=Refunded; refundedAt=now | `Refunded(...)`, `Resolved(...)` | as T6 |
| T8 | Disputed | Funded | `resolve` (hold) | state==Disputed; digest matches; **block.timestamp < finalCutoff**; evaluator verdict action `resolve:hold` valid | evaluator verdict | state=Funded; dispute fields cleared | `Resolved(...)` | as T6 |
| T9 | Disputed | Refunded | `refund` (timeout) | state==Disputed; digest matches; **block.timestamp ≥ finalCutoff**; no signature | anyone (beneficiary fixed buyer) | USDC → buyer; totalHeld -= amount; state=Refunded; refundedAt=now | `Refunded(...)` | NotFunded, WrongDigest, WrongState, DeadlineNotPassed |
| T10 | Funded | Released | `mutualRelease` | state==Funded; digest matches; **block.timestamp < finalCutoff**; both parties' EIP-712 signatures valid, mutual nonce unused | buyer + seller signatures | USDC → seller; totalHeld -= amount; state=Released; releasedAt=now | `Released(...)` | NotFunded, WrongDigest, WrongState, AfterCutoff, BadSignature, Replay, ExpiredVerdict, TransferFailed |
| T11 | Funded | Refunded | `mutualRefund` | state==Funded; digest matches; **block.timestamp < finalCutoff**; both parties' signatures valid | buyer + seller | USDC → buyer; totalHeld -= amount; state=Refunded; refundedAt=now | `Refunded(...)` | as T10 |
| — | Released | — | (any) | terminal | none | **No transition from Released.** Any action reverts WrongState. | — | WrongState |
| — | Refunded | — | (any) | terminal | none | **No transition from Refunded.** | — | WrongState |

**Key invariants from the table:**
- **Before cutoff** (`< finalCutoff`): evaluator verdicts, mutual signatures, dispute, resolve are all valid.
- **At/after cutoff** (`≥ finalCutoff`): timeout refund eligible for both Funded and Disputed; **no evaluator or mutual resolution is valid** (execution-time cutoff rules override earlier signatures — policy §B.5).
- **Terminal exclusivity:** Released and Refunded are final; competing transactions cannot produce two payouts (only one terminal transition per escrow; totalHeld decremented exactly once).
- **Recipient is fixed:** timeout refund beneficiary is always the original buyer; the caller cannot select a recipient (policy §B.6).

---

## 5. Amount accounting and invariants

### 5.1 Accounting model

- All amounts are exact integers in the token's base units (no floats).
- `totalHeld` tracks the sum of outstanding (non-terminal) escrow principal for the aggregate cap.
- Milestone principal allocations (where a profile has them) are an **agreement-level** construct recorded in the signed v4 manifest (see `agreement-signing-spec.md`), not on-chain per-milestone balances. **Only whole-escrow outcomes are supported on-chain** (policy §B.8): release in full or refund in full.
- Dispute-cost reserves and fees are **separate from principal** and identified in the agreement; they are not part of the escrow principal and are not held by the custody contract unless the agreement's accounting explicitly funds them into custody (which the v2 contract does not do — see deferred capability table §8).

### 5.2 Invariants

1. **Conservation:** for every non-terminal escrow, custody holds `amount`; Σ outstanding escrow amounts == `balanceHeld(token)` (up to token transfer/rebasing caveats).
2. **TotalHeld consistency:** `totalHeld == Σ(amount of all escrows in state ∈ {Funded, Disputed})`.
3. **Terminality:** `state ∈ {Released, Refunded}` ⇒ `totalHeld` decremented exactly once for that escrow; `releasedAt>0 XOR refundedAt>0` (never both).
4. **Cap enforcement:** `amount ≤ perPositionCap` and `totalHeld + amount ≤ aggregateCap` at fund; `CapExceeded` otherwise.
5. **Deadline ordering:** `minReleaseTime ≤ deadline ≤ finalCutoff` at fund; `AfterCutoff` if any resolution is attempted at/after `finalCutoff`.
6. **Policy binding:** every funded escrow's `policyId` and `agreementRef` match the digest-derived values (enforced at fund).
7. **No two payouts:** any path to a terminal state requires `state ∈ {Funded, Disputed}`; terminal states reject all mutations (reentrancy-safe).

---

## 6. Execution-time boundary rules (restricted OBJECTIVE_DIGITAL)

### 6.1 Resolution window and final cutoff

- `deadline` = end of the **resolution window**: evaluator verdicts and mutual signatures are valid only while `block.timestamp < deadline` (strict). This is the window in which the evaluator may decide and the parties may mutually resolve (policy §B.1).
- `finalCutoff` = the fixed, non-extendable boundary. **At or after `finalCutoff`**, timeout refund becomes eligible (Funded or Disputed). Uses `finalCutoff` rather than `deadline` for the timeout so the resolution window and the buyer-protective timeout are distinct, nudgeable parameters (owner chooses values; the relationship `deadline ≤ finalCutoff` is enforced).

### 6.2 Verdict validity vs cutoff

- An evaluator verdict has its own expiry window (issuedAt within ±120s/300s of block time, per V1's convention) **and** is subject to the cutoff: `release`/`refund`/`resolve` executed at/after `finalCutoff` revert `AfterCutoff` even with a verdict issued before the cutoff (policy §B.5). Earlier-issued verdict signatures do not override execution-time cutoff rules.
- Mutual signatures (`mutualRelease`/`mutualRefund`) similarly require `block.timestamp < finalCutoff`.

### 6.3 Non-extendability

- `finalCutoff` is fixed at fund. No retry, repeated submission, dispute toggling, or resolve("hold") extends it (policy §B.4). The contract does not store or permit a cutoff update.

### 6.4 Competing transactions

- The `nonReentrant` mutex + terminal-state guards ensure two competing transactions (e.g. a relayer's timeout refund and an evaluator's release verdict) cannot both succeed: the first terminal transition wins; the second reverts `WrongState`. Two payouts are impossible.

### 6.5 Recipient immutability

- The timeout refund path sends to `e.buyer` only. The caller supplies no recipient argument. Mutual paths send to the fixed beneficiary defined by the action (`mutualRelease` → seller, `mutualRefund` → buyer). No path accepts a caller-chosen recipient.

### 6.6 Terminal-state behavior

- Released/Refunded are immutable. Reads remain available (`getEscrow`, events). No recovery from a terminal state (policy §D.6: previously released funds are not recoverable via a lifecycle-state change).

---

## 7. The 2-of-3 evaluator signing authority

### 7.1 Policy requirement (policy §C.1–C.7)

The recommended participant-funded launch uses a **2-of-3 evaluator signing authority** through an established multisignature mechanism. Signing redundancy is **not** independent adjudication (the signers' identities/appointment determine independence, not the key count). Evaluator approval (signing), gas-paying execution (submitting), and EAS attestation are separate responsibilities. **Evaluator approval keys MUST NOT reside in the public API process.** The custody contract's `ecrecover`-based verdict verification cannot verify a contract-wallet signature directly; admission stays disabled until the mechanism is supported.

### 7.2 Established contract-wallet tooling evaluated

| Mechanism | Verdict compatibility | Owner/threshold governance | Key failure | Revocation | Historical verification | Verdict: v2 support |
|---|---|---|---|---|---|---|
| **Safe{Wallet} (Gnosis Safe) with 2/3 owners** | Safe does not expose a raw EIP-712 message signature that `ecrecover` would accept; Safe signs arbitrary messages via `signMessage` (EIP-191) or typed data through `isValidSignature` (EIP-1271). The custody contract would need an **EIP-1271 `isValidSignature` hook** rather than `ecrecover`. | Owner/threshold can change via Safe transactions; any change must be disclosed + monitored (policy §C.6). | Key loss: 2/3 still signs; owner replacement governed by remaining owners. | Owners can be removed; threshold can change; no per-escrow revocation (a revoked key stops being an owner). | Historical verification: `isValidSignature` is dynamic (state-dependent); a verifier must re-read the Safe's current owners/threshold to confirm the signers at verdict time — **not** derivable from the verdict alone. | **Compatible with a custody-contract change** (EIP-1271 hook); governance must be disclosed/monitored; historical verification needs owner-snapshot reads. |
| **2-of-3 MPC threshold (e.g. Lit, MPC wallet)** | MPC produces a single ECDSA signature from 2-of-3 shares — **directly compatible with `ecrecover`** (the aggregate signature is an ordinary secp256k1 signature whose public key is fixed). | No mutable owner set (the aggregate key is fixed at setup) — **no owner/threshold governance surface**; strongest against governance risk. | Key loss: 2-of-3 preserves signing (any 2 shares); share lifecycle is off-chain. | Off-chain share revocation; the on-chain key never changes. | Historical verification: single fixed address — derivable and stable. | **Best compatibility tool today**; requires no custody-contract EIP-1271 change; operational dependency on the MPC infrastructure provider. |
| **Safe with EIP-1271 hook in custody** | Requires adding `isValidSignature(bytes32, bytes)` to the custody contract, delegating to the Safe. Verdict verification becomes an external call; replay guard still on `usedVerdictNonce`. | Same Safe governance as above. | Same as Safe. | Same as Safe. | Same dynamic-state caveat as Safe. | **Compatible with a contract change**; more moving parts than MPC; independent-review scope grows. |

### 7.3 Recommended

For the participant-funded launch: **2-of-3 threshold MPC producing a single fixed ECDSA aggregate key** (if the provider choice passes security review — provider is an activation input), with **fallback: Safe + EIP-1271 hook** in the custody contract (larger contract delta, reviewed explicitly). Both are activation blockers pending the owner's mechanism decision; the admission flag stays **disabled** until the selected mechanism is implemented and reviewed. **No single operator key fallback** is acceptable (policy §C.7).

### 7.4 Contract-wallet validation consistency (across agreement, verdict, export)

- **Agreement signing:** the parties sign the v4 manifest (EIP-712 per `agreement-signing-spec.md`). If a party is a contract wallet, the agreement schema must accept an EIP-1271 signature reference and the verifier must check `isValidSignature` on-chain at a recorded block.
- **Verdict authorization:** the evaluator aggregate signs the `EscrowVerdict`; the custody contract verifies via the selected mechanism (ecrecover for MPC; EIP-1271 for Safe).
- **Export verification:** the verifier must record which mechanism was used and, where the signer is a contract wallet, read the wallet's owner/threshold state at the verdict block for historical verification. **This is additional implementation work** (not present today) and is recorded under §8 as deferred.

---

## 8. Capability matrix — initial vs advanced

| Policy requirement | Existing support (V1) | Proposed (V2 restricted) | Deferred/blocked | Activation condition |
|---|---|---|---|---|
| Immutable admin-less custody with no withdrawal | YES (V1) | YES | — | — |
| Safe transfers, exact-delta, no-return tokens | YES (V1) | YES | — | — |
| Fund binds terms; digest + commitmentId | YES (V1) | YES (+policyId, agreementRef) | — | — |
| Release/refund via evaluator verdict | YES (V1, single EOA) | YES (2-of-3 aggregate) | — | 2-of-3 mechanism selected + reviewed (§7.3) |
| Timeout refund at deadline (Funded only) | YES (V1) | YES (finalCutoff, Funded + Disputed) | — | — |
| Dispute by buyer/seller; resolve by evaluator | YES (V1) | YES (before cutoff) | — | — |
| Mutually signed release/refund | NO | YES (before cutoff) | — | — |
| Final-cutoff refund incl. disputed | NO | YES (T4/T9) | — | — |
| No cutoff extension; earlier sigs don't override | NO | YES (§6.2–6.3) | — | — |
| No two payouts; fixed recipient | YES (V1) | YES (§6.4–6.5) | — | — |
| **2-of-3 evaluator** | NO (ecrecover single key) | PROPOSED (§7) | Mechanism decision + security review | Owner decision + independent review |
| **Exposure limits on-chain** | NO | PROPOSED (§5.2, perPositionCap/aggregateCap) | Owner values for caps | Owner sets values |
| **Deposit/admission gate** | NO | PROPOSED (intake can stop without suppressing exits) | — | — |
| Advanced profile custody (partial delivery, earned milestones, separable disputed amounts, longstop executor) | NO | NO (deferred) | Requires distinct accounting (§8.1) | Profile admission + legal review + longstop executable |
| High-value assurance layer | NO | NO | Same as advanced | — |
| EIP-1271 contract-wallet verdict verification | NO | PROPOSED (only if Safe route chosen) | Mechanism decision | §7.3 |
| Historical verification of contract-wallet signers | NO | SPECIFIED (verifier reads owner snapshot at verdict block) | Implementation in verifier | When a contract-wallet evaluator is used |

### 8.1 Advanced milestones: separate escrow positions vs additional accounting

**Recommendation: separate escrow positions per milestone for advanced profiles, NOT per-milestone on-chain partial settlement inside one escrow.**

Reasoning:
- The v2 contract supports only whole-escrow release/refund (policy §B.8). Partial settlement inside one escrow would require either (a) multiple release calls with tracked released amounts — a storage + accounting change (recording `releasedTotal`, `lockedRemaining`) that expands the terminal-state model and the double-payout surface; or (b) splitting principal across multiple escrow positions, each whole-escrow, each with its own digest-bound terms and its own deadline.
- Option (b) is **safer and simpler**: each milestone escrow is a self-contained whole-escrow outcome; approval of an earlier milestone does not unlock later ones; a dispute on one milestone does not freeze others; the sum of milestone escrow amounts equals the agreed principal (enforced at the agreement level by the admission validator's milestone-total check).
- **Tradeoff (must be explicit):** separate positions mean more on-chain records and more per-position gas; the accounting invariant "Σ milestone escrows == principal" is **off-chain (agreement-level)** unless the contract enforces a per-agreement bundle (a v2+ feature — deferred). The design does **not** pretend binary release/refund supports per-milestone partial settlement; if the owner later requires partial settlement inside a single escrow, that is a distinct contract feature (recorded released amounts + `releasePartial`) requiring its own design and security review.

**Deferred:** PHYSICAL_DELIVERY, SUBJECTIVE_SERVICE, HIGH_VALUE_ASSURANCE remain **defined but inactive** until their required custody, evidence, adjudication, and longstop mechanisms exist (policy §D). No universal buyer-refund fallback applies to advanced transactions; a mutual or authorized adjudicated refund remains permissible where the agreed profile supports it.

---

## 9. Funding/admission restrictions, exposure limits, emergency controls

### 9.1 Admission gating

- `fund` requires a **valid policy admission**: `policyId` must equal the contract's admitted policy id (set at construction) and `policyDigest`/`agreementRef` must match the committed policy (the contract stores the policy id + digest; the full structural admission runs in the app/validator per `mainnet/admission/`).
- An **admission flag** (`fundingEnabled`) can be set false to stop new funding — **without suppressing exit paths** (policy §F.3): release/refund/resolve/mutual/timeout remain callable. This is the only "stop" control; it never freezes custody.
- **No unrestricted administrative withdrawal** exists in any variant (policy §F.1).

### 9.2 Exposure limits

- `perPositionCap` and `aggregateCap` are the on-chain hard caps (policy §F.2). Set to 0 (no cap) until the owner supplies values — **activation blocker**; v2 does not boot with caps advertised but unenforced.
- Caps count `totalHeld` (sum of outstanding principal). Released/refunded amounts are excluded (they left custody).

### 9.3 Emergency controls — exact limitations

| Control | What it can do | What it CANNOT do |
|---|---|---|
| Service kill switch (app) | Stop new funding intake via the app | Cannot freeze custody; direct on-chain `fund` calls bypass it (documented) |
| `fundingEnabled=false` (contract) | Reject `fund` calls | Cannot halt release/refund/resolve/mutual/timeout; cannot pause the contract |
| Reentrancy mutex | Block reentrant re-entry | Does not stop direct calls |
| Verdict expiry (issuedAt window) | Bound verdict freshness | Does not stop a valid in-window verdict |
| No admin/owner | — | Cannot bail out funds, migrate, or pause (by design) |
| Token pause/blacklist, network failure, adjudicator failure | — | Explicit dependencies (policy §F.5); the contract cannot override them |

---

## 10. Migration/version selection without changing funded positions

- **Existing funded positions retain their original rules forever** (policy §A.4–A.5). V1 testnet positions keep V1 semantics; v2 is a new deployment with a new address (new EIP-712 domain automatically: `verifyingContract` + `chainId`).
- Version selection: the application selects the custody deployment by `SAAX_CUSTODY_ADDRESS` (per-chain config). No silent migration. A future migration contract (if the owner ever approves one) must be a new, separately reviewed deployment with explicit participant consent; never assumed.
- The v2 contract's `fund` requires the v4 agreement digest (per `agreement-signing-spec.md`); V1-funded positions' V1 manifests are unaffected (historical digest verification unchanged).

---

## 11. Activation blockers (unresolved, never invented)

| Blocker | Field/requirement | Who resolves |
|---|---|---|
| 2-of-3 evaluator mechanism selection + security review | §7.3 (MPC vs Safe+EIP-1271) | Owner + independent review |
| Per-position and aggregate exposure caps | `perPositionCap`, `aggregateCap` values | Owner |
| Mainnet custody deployment + address | New v2 deployment on 8453 | Deployment authorization (Phase 6) |
| Mainnet USDC address verification | Whitelisted token | Verify on 8453 |
| Final cutoff / resolution window durations | `deadline`, `finalCutoff` values per agreement | Agreement-level (transaction-specific) |
| Legal review of the restricted profile timeout consent | Addendum clause 4 | Qualified legal review |
| Evaluator mechanism historical-verification procedure | Verifier owner-snapshot reads (EIP-1271 path) | Implementation in Phase 3+ |
| Advanced-profile custody accounting (separate positions) | §8.1 | Owner decision + later phase |

---

## 12. Summary of exact V1→V2 changes

1. New fields: `finalCutoff`, `policyId`, `agreementRef`.
2. New functions: `mutualRelease`, `mutualRefund`.
3. `refund` timeout path extended to the `Disputed` state at/after `finalCutoff`.
4. All evaluator/mutual resolutions gated on `block.timestamp < finalCutoff` (execution-time cutoff rule).
5. Evaluator signature parameter changed to `bytes` for the 2-of-3 aggregate (breaking ABI → new deployment).
6. On-chain exposure caps (`perPositionCap`, `aggregateCap`, `totalHeld`).
7. `fundingEnabled` admission gate (stops intake only; exits always open).
8. Policy binding fields (`policyId`, `agreementRef`) enforced at fund.

*End of custody design (v2).*