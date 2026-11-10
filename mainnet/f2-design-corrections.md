# F2 Design Corrections Before Custody Implementation

**Status:** CORRECTION ANNEX to `mainnet/f2-design-decision-closeout.md`. Documentation/specification only. No contract implementation, no push, no deployment, no chain writes, no spending, no outreach, no production keys, no activation.
**Baseline:** HEAD `5cc9d079` (F2 closeout, local only). Corrects normative clauses to match the **actual** contract/signature rules in `contracts/SAAXEscrowCustodyV2.sol` and the agreement/v4 signing spec. Supersedes the corresponding passages of the F2 closeout where they conflict; the closeout's preserved established decisions (§1) are unchanged.

**Reading key:** each corrected clause is labeled **CORRECTED** (fixes a factual error in the F2 closeout), **SPECIFIED** (makes precise what was open), or **UNCHANGED** (restates a preserved decision for completeness).

---

## 1. Pre-settlement checkpoint authority (per path)

### 1.1 The three release/refund paths and their checkpoint authority

The custody contract (`SAAXEscrowCustodyV2.sol`) has exactly **three** terminal-money paths, each with a distinct authority. The proposed V3 pre-settlement-head commitment must be specified **per path**, because the authority that authorizes the money movement is also the authority that authorizes the head:

| Path | Money-movement authority (V2, actual) | Checkpoint (head) authority for V3 | Signature covering the head |
|---|---|---|---|
| **Evaluator release / refund / disputed resolution** (`release`, `refund` with verdict, `resolve`) | Evaluator verdict — EIP-712 `EscrowVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt)`, valid only while `block.timestamp < finalCutoff`; ERC-1271 (Safe) or ecrecover (EOA) | **Evaluator.** The head hash is a field of the evaluator's signed verdict payload. | The evaluator's EIP-712 verdict signature (Safe ERC-1271 or EOA), extended to include `preSettlementHead` (V3 type change — see §4). |
| **Mutual release / refund** (`mutualRelease`, `mutualRefund`) | BOTH buyer + seller EIP-712 `MutualResolution(commitmentId, commitmentDigest, action, nonce, issuedAt)`, same digest, valid only while `block.timestamp < finalCutoff` | **Both parties jointly.** The head hash is a field of the shared `MutualResolution` payload. | Both party signatures over the identical `MutualResolution` digest, extended to include `preSettlementHead`. |
| **Timeout refund** (`refund` with zeroed v/r/s and empty sigBytes) | **No signature at all** — eligibility at/after `finalCutoff`, beneficiary fixed to the original buyer, caller may be anyone and cannot choose a recipient (`AfterCutoff` / `DeadlineNotPassed`, V2:480-485) | **No checkpoint required.** Timeout must remain executable with zero fresh signatures and zero journal availability. | None. Timeout is contract-clock-eligible, not signature-authorized. |

### 1.2 Timeout refund: the no-checkpoint recommendation (unambiguous)

**Recommendation for timeout refund in V3: an unambiguous NO-CHECKPOINT outcome.**

- The timeout path requires **no journal and no signature**. Requiring a pre-settlement head for timeout would (a) invent a journal hash the timeout caller does not have, and (b) make timeout exit depend on operator cooperation — both explicitly forbidden by the directive ("Do not invent a journal hash or require operator cooperation to exit").
- The V3 `refund()` timeout branch **must not take a `preSettlementHead` parameter** (or, if a single ABI is shared, the timeout branch **must accept and ignore** the field as a defined no-op, with the contract emitting `refunded` without any head record). **Do not** route timeout through `commitSettlementHead`.
- An **optional submitted checkpoint** is rejected: it would create two semantically distinct timeout outcomes (with-head vs without-head) and force the verifier to decide which is expected — ambiguity, not precision.
- Consequence for the verifier: for a timeout terminal, the verifier **must not require** an on-chain head; a timeout escrow with no head record verifies as complete for the timeout path, and the journal's timeout entry carries no head.

### 1.3 Intent persistence and journal appends — no circularity, no self-reference, no inconsistent retry checkpoints

**What the V3 mechanism commits (corrected from any implication of "settlement commits the tail"):**

The settlement transaction commits the journal's **pre-settlement head** — the hash-chain tail as it exists **immediately before** the settlement entry is appended. The settlement receipt is then linked into the journal as a **subsequent** entry. The transaction does **not** commit itself and does **not** commit the post-settlement tail.

**Why this avoids circularity and self-reference:**
- The head is computed from journal entries that exist **before** the settlement entry; the settlement entry (which records the tx hash) is appended **after** the tx confirms. The committed hash never depends on the entry that contains it. A journal entry recording a transaction cannot contain that transaction's hash (the hash depends on the entry's contents) — the pre-settlement head sidesteps this by construction.
- The `evidenceDigest` binding rule already established in the v4 journal (`v4-journal-schema-decision.md` Phase-A corrections) keeps outcome-relevant references (txHash, blockHash, authorization, submitter) inside the entry hash **and** the EIP-712 signature, while signatures are never part of their own signed hash. The V3 head field follows the same rule: the head is a signed field of the verdict/mutual payload, never the payload's own digest.

**Why intent persistence prevents inconsistent retry checkpoints:**
- The settlement worker persists `{commitmentId, preSettlementHead, verdictNonce, action}` as a durable intent **before** broadcast (D1/D3 semantics: one authoritative acceptance transaction, nonce reservation, PENDING attempt before send).
- On restart, the replacement worker **reconciles the chain first** (did the settlement execute? which head is recorded on-chain?) and only then re-derives the journal append from the durable intent + chain facts. It **never** recomputes a different head and re-broadcasts: the nonce is consumed (replay guard), so a second settlement with a different head either reverts (wrong nonce) or is replay-rejected. The recorded on-chain head is the single source of truth for what was committed.
- Competing settlement: the head is bound to the escrow's `commitmentId` and the verdict nonce. A competing settlement with a different head reverts (nonce) or is rejected by terminal exclusivity (one terminal state per escrow). The D2 state machine (`SUBMISSION_UNCERTAIN` → `INCLUDED` → `FINALIZED|REVERTED`) plus idempotent reconciliation prevents double payout.
- A journal-write failure **after** chain confirmation keeps the outbox row PENDING and re-drains from the recorded outcome without re-execution (D3 `drainOutbox` semantics) — no duplicate journal entry, no duplicate financial effect.

**What the head proves and does not prove (normative, unchanged from v4-journal-schema-decision §8 limitations):**
- Proves: on-chain association of the journal's pre-settlement state with this commitment, and that the submitter was authorized.
- Does **not** prove: completeness of the off-chain journal (the contract records the *submitted* head; it cannot know the true off-chain tail), nor absence of an alternative authorized history, nor the post-settlement tail. Completeness requires additional rules (fixed transition set / checkpoint chain) — the commitment alone does not provide it.

---

## 2. Expiry — exact meaning and enforcement choice

### 2.1 The exact quoted rule (source: `contracts/SAAXEscrowCustodyV2.sol`)

The verdict/mutual execution-validity window is enforced **in the contract**, in both `_checkVerdict` and `_checkMutual`:

```solidity
// _checkVerdict (lines 266-267) and _checkMutual (lines 298-299):
if (issuedAt > block.timestamp + 120) revert NotYetValid();     // future-skew cap: 120s
if (block.timestamp > issuedAt + 300) revert ExpiredVerdict(); // expiry: 300s after issuance
```

And the authoritative D3 expiry policy (`mainnet/design/expiry-policy-d3.md`):

> **Evaluator/mutual authorization validity** — signature issuance vs execution — **EXECUTION** — Verdict/mutual digest bound to the exact contract-action literal + execution-validity window (`verify-v4`: `issuedAt <= settle.time+120s && settle.time <= issuedAt+300s`), verified against `esc.evaluator`. Signatures are NEVER extended automatically.

### 2.2 Corrected enforcement classification

**CORRECTED (fixes a factual error in F2 closeout §3):** the F2 closeout stated *"expiry NOT contract-enforced (V2 has no issuedAt window check; verifier-only)"*. **This is false.** The V2 contract **does** enforce the 120s future-skew cap and the 300s expiry window at execution, in `_checkVerdict` (lines 266-267) and `_checkMutual` (lines 298-299). The verifier's window check (`verify-v4`) is **supplementary** — it applies the same bounds to the export's declared settlement time; it is not the only enforcement.

**Enforcement classification, corrected:**
- **Verdict/mutual signature validity (120s future-skew, 300s expiry): CONTRACT-ENFORCED at execution** (V2:266-267, 298-299) **AND** verifier-checked (supplementary, same bounds). It is a **signature-validity** requirement (limits authorization validity), not merely an evidence-freshness requirement. Per the directive: "If it limits authorization validity, propose contract enforcement at execution" — **it already is contract-enforced**; V3 must preserve it (no weakening, no removal).
- **Access-authorization expiry** (role/action nonce in `endpoint/escrow-access.js`): enforced at **durable acceptance** (`EXPIRED` if expiry <= now, before any acceptance record) — an application-layer access gate, deliberately NOT re-checked at execution (delayed pickup of accepted ops proceeds). This is the "access expiry" the directive asks to distinguish; it is a service-layer liveness gate, not an economic boundary.
- **Issuance-time / future-skew checks**: the `issuedAt > block.timestamp + 120` cap rejects verdicts issued more than 120s in the future (clock skew protection). Contract-enforced (V2:266, 298). The agreement-consent expiry (`authorizations[].expiry` in the v4 export) is checked at **verification time** by the verifier (anchor authority expiry, consent expiry) — evidence-freshness at issuance.
- **Custody cutoffs** (`finalCutoff`, `deadline`, `minReleaseTime`): contract-enforced economic boundaries — see §3.

**Consequence for the verifier (unchanged, normative):** verifier rejection of an expired verdict does **not** by itself prevent direct execution *if the contract path would still accept it* — but in the actual V2 contract, the contract itself rejects expired verdicts, so direct execution of an expired verdict is already impossible. The verifier's expiry check is therefore aligned with (not replacing) contract enforcement. No change to existing funded-position rules is made by this correction.

---

## 3. Deadline relationships — exact inequalities and boundary tables

### 3.1 Actual contract validation (corrected)

**CORRECTED (fixes a factual error in F2 closeout §3):** the F2 closeout stated *"ordering minReleaseTime ≤ deadline ≤ finalCutoff enforced at fund (lines 383–384)"*. **This is false.** `fund()` (V2:383-384) validates only:

```solidity
if (deadline > finalCutoff) revert InvalidPolicy();          // line 383
if (finalCutoff <= block.timestamp) revert InvalidPolicy();  // line 384
```

**minReleaseTime is NOT validated at fund.** The only enforced inequality at fund is `deadline <= finalCutoff` and `finalCutoff > block.timestamp`. The ordering `minReleaseTime ≤ deadline ≤ finalCutoff` is **not** a contract invariant; minReleaseTime is only used at `release` (line 442: `block.timestamp < minReleaseTime → NotYetValid`) and is **not enforced on `resolve` or `mutual` paths** (the Q2(a) divergence, unchanged).

### 3.2 Exact inequalities (normative for V3)

Let `T_fund` = funding block timestamp, `T_exec` = execution block timestamp, `signature_issuedAt` = the verdict/mutual `issuedAt`. The boundaries are:

1. **At fund (V2 actual, V3 must preserve):**
   - `deadline ≤ finalCutoff` (line 383)
   - `finalCutoff > T_fund` (line 384)
2. **At evaluator release (`release`, V2:442-443):**
   - `T_exec ≥ minReleaseTime` (else `NotYetValid`)
   - `T_exec < finalCutoff` (else `AfterCutoff`)
   - signature: `issuedAt ≤ T_exec + 120` and `T_exec ≤ issuedAt + 300` (contract 266-267)
   - **`deadline` NOT enforced at release** (the Q2(a) divergence — the resolution window end is verifier-enforced only)
3. **At evaluator refund (verdict path, V2:477):**
   - `T_exec < finalCutoff` (else `AfterCutoff`)
   - signature window as above
   - **`minReleaseTime` NOT enforced; `deadline` NOT enforced**
4. **At timeout refund (V2:484-485):**
   - `T_exec ≥ finalCutoff` (else `DeadlineNotPassed`, V2:485)
   - state must be Funded or Disputed (else `WrongState`, V2:484)
   - **no signature; no deadline/minReleaseTime requirement**
5. **At resolve (dispute resolution, V2:532):**
   - `T_exec < finalCutoff` (else `AfterCutoff`)
   - state must be Disputed
   - signature window as above
   - **`minReleaseTime` NOT enforced; `deadline` NOT enforced**
6. **At mutual release/refund (V2:578):**
   - `T_exec < finalCutoff` (else `AfterCutoff`)
   - state must be Funded
   - mutual signature window as above
   - **`minReleaseTime` NOT enforced; `deadline` NOT enforced**
7. **At raiseDispute (V2:502-503):**
   - state must be Funded (else `WrongState`, V2:502)
   - `msg.sender` must be buyer or seller (else `NotParty`, V2:503)
   - **no deadline/cutoff gate at dispute raising** (dispute may be raised before cutoff; timeout eligibility remains at/after cutoff)

### 3.3 Boundary table (all paths)

| Action | Earliest permitted | Latest permitted | Authority | Contract enforcement (V2 actual) | Service/verifier checks |
|---|---|---|---|---|---|
| Fund | any time (fundingEnabled gate) | fundingEnabled=false rejects | anyone (terms bind at fund) | fundingEnabled; policyId/digest match; `deadline ≤ finalCutoff`; `finalCutoff > T_fund`; caps; token pull first | admission allowlist, chain guard (84532/8453), agreement admission |
| Release (evaluator) | `T_exec ≥ minReleaseTime` | `T_exec < finalCutoff` | evaluator verdict (ERC-1271/EOA), nonce replay-guarded | minReleaseTime YES (442); finalCutoff YES (443); signature window YES (266-267); **deadline NO** | verifier: resolutionDeadline window, verdict 120/300s, policy identity |
| Refund (evaluator verdict) | any | `T_exec < finalCutoff` | evaluator verdict | finalCutoff YES (477); signature window YES; **deadline NO; minReleaseTime NO** | verifier: resolutionDeadline, expiry, policy |
| Timeout refund | `T_exec ≥ finalCutoff` | none (terminal) | anyone (beneficiary fixed = buyer) | finalCutoff YES (480-485); state Funded/Disputed | verifier: cutoff ≥ all deadlines, consent recorded |
| Resolve (dispute verdict) | any | `T_exec < finalCutoff` | evaluator verdict `resolve:release/refund/hold` | finalCutoff YES (532); signature window YES; **minReleaseTime NO; deadline NO** | verifier: resolutionDeadline, expiry, policy; Q2(a) divergence documented |
| Mutual release/refund | any | `T_exec < finalCutoff` | buyer + seller signatures (same digest), mutual nonce | finalCutoff YES (578); signature window YES (298-299); **minReleaseTime NO; deadline NO** | verifier: mutual nonce per-escrow (Q2(b)), expiry |
| Raise dispute | Funded only | before terminal | buyer or seller only | party restriction YES (503); state Funded (502) | verifier: dispute after cutoff → timeout eligible |
| Delivery deadline | (agreement-level) | fulfillment must complete by `deliveryDeadline` | agreement-level (signed terms) | **NOT contract-enforced** (no field; policy-level) | verifier: journal evidence vs delivery deadline; evaluator judgment |
| Evaluator/mutual signature validity | `issuedAt ≤ T_exec + 120` (future-skew) | `T_exec ≤ issuedAt + 300` (expiry) AND `T_exec < finalCutoff` | evaluator / both parties | **CONTRACT-ENFORCED (266-267, 298-299)** | verifier: same window, cutoff override |
| Final cutoff | fixed at fund | non-extendable (`cutoffExtensionRule="none"`) | immutable at fund | **YES (AfterCutoff on all resolutions; DeadlineNotPassed below)** | verifier: no extension, earlier sigs don't override |
| Timeout eligibility | `T_exec ≥ finalCutoff` (Funded and Disputed) | terminal | anyone (beneficiary fixed) | **YES (480-485)** | verifier: consent, cutoff ≥ deadlines |

### 3.4 Do resolutionDeadline and finalCutoff have distinct economic purposes? — YES (justified, no redundancy)

- **`finalCutoff`** is the **buyer-protective timeout boundary**: at/after it, unresolved escrow refunds to the original buyer with no signature. It is fixed at fund, non-extendable, and is the **only** boundary that triggers an automatic-exit *eligibility*. It exists to cap how long the buyer's funds can be locked in an unresolved position.
- **`resolutionDeadline`** is the **end of the evaluator/mutual decision window**: the time by which an evaluator verdict or mutual resolution must be *executed* (while `T_exec < finalCutoff`). It exists to bound how long the evaluator has authority to move money one way or the other — a **decision-authority** boundary, not a fund-release boundary.
- They are distinct because a position may be **disputed or pending** past `resolutionDeadline` yet still before `finalCutoff`; the evaluator's authority window ends, but the buyer's funds are not yet eligible for timeout refund. Collapsing them would either (a) let a late evaluator verdict move money after the promised decision window (if only finalCutoff enforced), or (b) force an early timeout refund while the evaluator could still legitimately resolve (if only resolutionDeadline enforced).
- **V3 recommendation (consistent with F2 closeout §3):** enforce `T_exec < deadline` on evaluator release/refund/resolve and mutual release/refund (mirroring finalCutoff), OR drop the field's contract meaning and rename it as verifier-only. Recommendation: **enforce it** — the signed agreement promises `resolutionDeadline`; leaving it verifier-only is a silent narrowing of the signed terms. Do **not** add a new waiting period or redundant deadline; `minReleaseTime`, `deadline`, `finalCutoff` are all already defined — the fix is enforcement parity, not new semantics.

### 3.5 Contradictory parameter combinations to reject (at fund, V3)

The following combinations are contradictory and **must be rejected at fund** (either by the existing contract checks or by V3 additions):

| Combination | Why contradictory | Enforcement |
|---|---|---|
| `deadline > finalCutoff` | resolution window outlives the timeout boundary | V2:383 (already) |
| `finalCutoff <= T_fund` | cutoff in the past | V2:384 (already) |
| `minReleaseTime > deadline` | release-before-boundary later than the decision window end — release could never be both `≥ minReleaseTime` and `< deadline` (if deadline enforced) | **V3 addition: `minReleaseTime ≤ deadline ≤ finalCutoff` at fund** (not present in V2) |
| `minReleaseTime > finalCutoff` | release-before-boundary later than timeout eligibility — an evaluator release would always hit AfterCutoff first | V3 addition (same check) |
| `deadline == finalCutoff` (with minReleaseTime == deadline) | degenerate: no time window for evaluator resolution | V3 addition: require `deadline < finalCutoff` when `minReleaseTime == deadline`; or document the degenerate case as permitted with explicit semantics |
| `deliveryDeadline > resolutionDeadline > finalCutoff` (agreement-level) | fulfillment must complete after the resolution window ends — impossible for the evaluator to adjudicate | **Service/admission check** (agreement admission), not contract — the contract has no deliveryDeadline field |
| `minReleaseTime` in the past at fund (`minReleaseTime <= T_fund`) | release-before-boundary already passed — a no-op constraint | V3 addition: `minReleaseTime > T_fund` (or documented as intentionally permissive) |
| `cutoffExtensionRule != "none"` | extension contradicts the fixed-cutoff invariant | Agreement admission (already: policy requires `"none"`) |

**Not rejected** (deliberately): `deadline` in the past at fund is NOT currently checked (V2 only checks `finalCutoff > T_fund`); the verifier/mutual resolution window check (`issuedAt + 300 ≥ T_exec`) is contract-enforced. A `deadline < T_fund` position is admissible under V2 (the evaluator simply has no valid window left — timeout refund still works). **Do not silently change this funded-position rule**; document it as an explicit V3 decision (recommend: keep admissible; timeout remains the exit).

---

## 4. Compatibility and review — V3 is an implementation version, not Protocol V3

### 4.1 Version identity

**V3 = a new immutable custody contract implementation (SAAXEscrowCustodyV3), NOT "Protocol V3".** It implements the restricted OBJECTIVE_DIGITAL profile with two additional contract-enforced controls (pre-settlement head commitment + deadline/minReleaseTime parity) on top of V2's rules. It is **not** a protocol-version change to the agreement signing spec, the v4 manifest, or the journal domain (those remain versioned as today: `SAAX Commitment V4`/`4` agreement domain; journal domain `SAAX Commitment Journal`/`4`).

### 4.2 New signing domains and types (V3, spec-level)

| Artifact | V2 (existing) | V3 (new) | Historical preservation |
|---|---|---|---|
| Custody domain name | `SAAX Escrow Custody V2` / version `"2"` | **`SAAX Escrow Custody V3` / version `"3"`** | V2 domain/type must remain supported for historical exports (the v4 verifier must be able to verify V2-era exports under the V2 identity policy). |
| Verdict type | `EscrowVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt)` | **`EscrowVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead)`** (added field; `preSettlementHead` = bytes32) | Old `EscrowVerdict` (5 fields) remains valid for V2-era exports; V3 verifies only the 6-field type. Do **not** reuse the same typehash with a different encoding — the typehash changes automatically with the field list (keccak of the type string), giving domain separation. |
| Mutual type | `MutualResolution(commitmentId, commitmentDigest, action, nonce, issuedAt)` | **`MutualResolution(commitmentId, commitmentDigest, action, nonce, issuedAt, preSettlementHead)`** | Same preservation rule. |
| Verdict nonce | global `usedVerdictNonce` | same replay guard, per-commitment scope if needed (decision: keep global nonce to preserve V2 semantics; per-escrow mutual nonce is the open Q2(b) reviewer item — do not change without review) | Existing consumed nonces are on V2 deployments only; a fresh V3 deployment starts a fresh nonce space. |
| Head type | none | **`bytes32 preSettlementHead`** in verdict/mutual payloads; `commitSettlementHead(commitmentId, head)` separate call **only if** the head is committed independently of the money-moving action (review question (a) from F2 closeout §2 — recommendation: **keep the head inside the verdict/mutual payload**, so one signature authorizes both the head and the action, eliminating a separate call and its replay surface) | No historical head records exist; V3 verifier treats missing head as INCOMPLETE for evaluator/mutual terminals and NOT-REQUIRED for timeout terminals. |

### 4.3 Changed bytecode, ABI, worker, verifier, and admission requirements

| Component | Change required (V3) |
|---|---|
| **Bytecode** | New immutable contract (new runtime hash). The V2 runtime identity (`v4-candidate-identity.json`-style pin) must gain a V3 entry; the verifier must pin the V3 runtime hash exactly (no trust-any-deployment). Rebuild artifacts under the pinned compiler settings (§4.4 of the F2 closeout: solc 0.8.26, optimizer 200, viaIR, evmVersion paris) and embed compiler metadata (readiness G2). |
| **ABI** | `release`/`refund`/`resolve`/`mutualRelease`/`mutualRefund` gain the `bytes32 preSettlementHead` calldata field (timeout `refund` branch: field optional/ignored per §1.2). `getEscrow` gains a `bytes32 committedHead` read field (and `headCommittedAt`). New artifacts must not be presented as V2 bytecode evidence. |
| **Worker (D1/D3)** | Settlement intent gains `preSettlementHead`; worker computes the head from the durable journal before broadcast, persists it in the acceptance transaction (outbox row), reconciles chain-recorded head vs journal after execution, and drains the outbox into the journal entry that appends the receipt after the head. Crash boundaries B2/B3 extended: intent-persisted-before-broadcast; broadcast-before-hash-saved; confirmation-before-journal-complete — all reconcilable without re-broadcast (nonce replay + terminal exclusivity). Timeout path: worker must NOT fabricate a head; timeout outbox rows carry no head. |
| **Verifier** | New checks: (1) resolved on-chain `committedHead == journal pre-settlement tail` for evaluator/mutual terminals; (2) head authority — recovered verdict/mutual signer must be the agreement's evaluator / both parties; (3) timeout terminal: head NOT required (and presence of a head on a timeout terminal is a mismatch to reject); (4) V3 verdict/mutual typehash (6-field) and domain `SAAX Escrow Custody V3`/`3`; (5) V3 runtime-hash identity; (6) negative cases: wrong head, head from another commitment, omitted head on evaluator/mutual terminal, head present on timeout terminal, V2-type signature submitted to V3 (must fail — typehash differs). The legacy verifier (v1-v3 exports) remains unchanged; V3 is a new supported identity in the same dispatcher. |
| **Admission** | V3 deployment must be admitted with its own `policyId`/`policyDigest` (the admitted policy is the same `saax-custody-policy-v1` digest — V3 is a custody implementation, not a policy change) and its own custody address identity. Mainnet admission remains **disabled** (unchanged). The admission validator must accept the V3 ABI (18+ tuple) and reject V2-era calldata on the V3 address. |

### 4.4 Compatibility cost summary

- New immutable contract → fresh deployment address, fresh nonce space, fresh runtime identity; pilot/31337 V2 evidence does not carry to V3.
- Verdict/mutual signing type change → Safe ERC-1271 wrapper and EOA signers must sign the 6-field type; existing V2-era signed verdicts are invalid on V3 (by design, domain separation).
- Verifier + worker schema updates; new negative battery; focused validation before any freeze.
- **Preserved:** V2-era exports remain verifiable under the V2 identity policy; the v4 agreement domain, journal domain, evidence domain are unchanged (no Protocol-V3 change); Circle fail-closed payment path and recipient binding are untouched by this custody version.

---

## 5. Exact approval choices (decision gates before implementation)

Each of the following is a **genuine owner decision** — none is described as approved in this annex:

| # | Decision | Options | Recommendation | Currently |
|---|---|---|---|---|
| D1 | Q1 pre-settlement head commitment | Approve Option B (head in verdict/mutual payload) / reject / defer | **Approve Option B** | OPEN |
| D2 | Q4 deadline enforcement | Enforce `T_exec < deadline` on evaluator/mutual/resolve (new immutable version) / rename as verifier-only | **Enforce** | OPEN |
| D3 | Q4 minReleaseTime parity | Enforce on resolve/mutual like release / leave as Q2(a) divergence documented | **Enforce** | OPEN |
| D4 | minReleaseTime validation at fund | Add `minReleaseTime ≤ deadline ≤ finalCutoff` + `minReleaseTime > T_fund` at fund / keep unvalidated | **Add (prevents contradictory combos, §3.5)** | OPEN |
| D5 | Timeout head requirement | No-checkpoint (head not required, absent on timeout) / optional submitted checkpoint | **No-checkpoint** | OPEN (recommendation stated) |
| D6 | Head placement | In verdict/mutual payload (single signature authorizes head+action) / separate `commitSettlementHead` call | **In payload** | OPEN |
| D7 | Verdict nonce scope | Keep global nonce (V2 semantics) / per-commitment | **Keep global** (Q2(b) per-escrow mutual nonce remains a reviewer item) | OPEN |
| D8 | `deadline` in the past at fund | Admissible (timeout remains the exit) / reject at fund | **Keep admissible, documented** (do not silently change funded-position rules) | OPEN |

**Smallest decisions required before implementation (owner only):** D1, D2, D3, D4, D5, D6, D7, D8 above, plus the unresolved inputs recorded in the F2 closeout (Safe owner identities + threshold, numeric caps, legal review, mainnet RPC/finality policy, USDC pinning, canary limits, admission list).

**Independent-review questions (not owner economic decisions):** (a) head-in-verdict vs separate-call replay semantics; (b) per-escrow mutual nonce; (c) verifier treatment of "no committed head" on evaluator/mutual terminals (INCOMPLETE vs NOT VERIFIED); (d) the degenerate `deadline == finalCutoff` case; (e) V3 identity policy pinning and artifact provenance.

---

## 6. Acceptance criteria for this correction annex

- [x] Path-specific checkpoint authority (evaluator / mutual / timeout) specified separately (§1).
- [x] Timeout refund: unambiguous **no-checkpoint** recommendation, no invented journal hash, no operator cooperation (§1.2).
- [x] Intent persistence + journal appends: circularity/self-reference/inconsistent-retry explanation grounded in the actual D1/D3 mechanism (§1.3).
- [x] Verdict expiry: exact quoted contract rule (V2:266-267, 298-299) with corrected enforcement classification (§2).
- [x] Access expiry / verdict validity / issuance-time checks / custody cutoffs distinguished (§2.2).
- [x] Exact inequalities + boundary table for all release/refund/resolve/mutual/timeout paths (§3.2-3.3).
- [x] resolutionDeadline vs finalCutoff distinct economic purposes (§3.4).
- [x] Contradictory parameter combinations to reject (§3.5); no redundant deadlines or invented waiting periods.
- [x] V3 = implementation version, not Protocol V3; new signing domains/types + historical preservation (§4).
- [x] Changed bytecode/ABI/worker/verifier/admission requirements (§4.3).
- [x] Unresolved recommendations labeled OPEN, never described as approved (§5).
- [x] No push, deployment, chain writes, spending, outreach, production keys, activation.

---

## 7. Affected files and dependencies

- **This annex:** `mainnet/f2-design-corrections.md` (new).
- **F2 closeout (unchanged except pointer):** `mainnet/f2-design-decision-closeout.md` — the corrections annex supersedes §2-§3 claims where they conflict (noted in §1 header).
- **Dependencies for implementation:** the V3 custody spec task (contract + ABI + verdict/mutual type change + worker intent + verifier identity + negative tests) after D1-D8.
- **Sources read for this annex (all committed):** `contracts/SAAXEscrowCustodyV2.sol` (V2:266-267, 298-299, 383-384, 442-443, 477, 480-485, 532, 565, 578), `mainnet/policies/transaction-profiles-v1.md`, `mainnet/design/agreement-signing-spec.md` (§4.3), `mainnet/design/expiry-policy-d3.md`, `mainnet/design/v4-journal-schema-decision.md` (§8), `mainnet/design/worker-plan-d3.md`, `mainnet/design/v4-verifier-check-map.md`, `mainnet/f2-design-decision-closeout.md`.
