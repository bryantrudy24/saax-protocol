# SAAX Mainnet Escrow — Independent Design Review Brief

**Status:** INTERNAL — prepared by the vendor (station overseer) for an **independent** design review that is **NOT COMPLETED**. This document is not an audit, not an approval, and not a readiness claim.
**Prepared at HEAD:** `57aec0fb` (Phase 1 commit; Phase 2 working-tree additions are the design/spec documents themselves — **the review should be performed against the Phase 2 commit once created**).
**Scope:** the proposed custody v2 design (`mainnet/design/custody-v2-design.md`) and the proposed v4 signed-agreement spec (`mainnet/design/agreement-signing-spec.md`), including the isolated spec-support module and tests under `mainnet/design/support/` and `mainnet/design/tests/`.

---

## 1. Design scope and source paths

| Item | Path |
|---|---|
| Custody v2 design (proposed) | `mainnet/design/custody-v2-design.md` |
| Agreement signing spec v4 (proposed) | `mainnet/design/agreement-signing-spec.md` |
| Spec-support module (canonicalization + digest vectors) | `mainnet/design/support/v4-canonical.js` |
| Focused tests (v4 digest/tamper/version/consent/amount) | `mainnet/design/tests/test-v4-spec.js` |
| Current immutable custody (baseline read) | `contracts/SAAXEscrowCustodyV1.sol` |
| Phase 1 policy (normative) | `mainnet/policies/custody-policy-v1.md`, `mainnet/policies/transaction-profiles-v1.md` |
| Phase 1 agreement template | `mainnet/agreements/custody-policy-addendum-v1.md` |
| Phase 1 admission validator (structural subset) | `mainnet/admission/` |
| Current verifier (v1/v2/v3; v4 NOT supported yet) | `verifier/verify-export.js` (line refs below) |
| Readiness roadmap + gates | `mainnet/mainnet-escrow-readiness.md` (§5 phases, §A–§E) |

**Commit references:** Phase 1 = `57aec0fb`. The v3 manifest conventions referenced: `verifier/verify-export.js` `MANIFEST_FIELDS_V3` (line 83), `SUPPORTED_FORMAT_VERSIONS=[1,2,3]` (line 85); custody V1 verdict domain `DOMAIN_NAME "SAAX Escrow Custody V1"` in `contracts/SAAXEscrowCustodyV1.sol`.

---

## 2. Trust assumptions to verify

1. **No operator authority on-chain.** The proposed v2 custody has no admin, owner, upgrade, pause, or withdrawal. Reviewer: confirm no path (including via the proposed `fundingEnabled` flag, caps, or any helper) can move principal except the defined terminal transitions.
2. **Agreement digest is the authority.** Parties, asset, amount, custody, chain, permitted outcomes, deadlines, evaluator authority, fallback disposition are bound into the v4 digest before funding. Reviewer: confirm the canonical field list is complete and that no outcome-affecting value lives outside the digest.
3. **Evaluator = 2-of-3 aggregate; signing redundancy ≠ independent adjudication.** The mechanism (MPC threshold vs Safe+EIP-1271) is undecided (activation blocker). Reviewer: assess both candidate mechanisms' compatibility, governance surfaces, failure modes, and historical-verification properties.
4. **Recipient immutability.** No path accepts a caller-selected recipient; timeout refunds go to the fixed buyer.
5. **Terminal exclusivity.** Exactly one terminal transition per escrow; two payouts impossible.
6. **Cutoff non-extendability and earlier-signature non-override.** Evaluator/mutual resolutions valid only before `finalCutoff`; timeout refund eligible at/after `finalCutoff` including disputed; earlier verdicts cannot override execution-time cutoff rules.
7. **Verifier independence.** The export verifier runs in a separate process without SAAX DB access, reads chain state at explicit blocks. Reviewer: confirm the v4 extension (when implemented) preserves this independence and adds contract-wallet snapshot verification.

---

## 3. Custody and accounting invariants (must hold)

1. `totalHeld == Σ amount(escrows in {Funded, Disputed})`; `balanceHeld(token) == totalHeld` (up to token caveats).
2. `amount ≤ perPositionCap`; `totalHeld + amount ≤ aggregateCap` at fund (`CapExceeded`).
3. Terminal states: `Released` XOR `Refunded` exactly once; `releasedAt>0` XOR `refundedAt>0`.
4. `minReleaseTime ≤ deadline ≤ finalCutoff` at fund.
5. Fees/reserve separate from principal; milestone allocations total principal (agreement-level; not on-chain at v2 — see deferred accounting §8.1 of the custody design).
6. No partial awards; no arbitrary recipient changes (restricted profile).
7. Verdict/mutual actions revert `AfterCutoff` at/after `finalCutoff`, regardless of signature issuance time.

---

## 4. Deadline/race analysis

- **Race 1 — timeout refund vs evaluator release at the cutoff boundary.** At `block.timestamp == finalCutoff`, the timeout refund becomes eligible while the evaluator release is no longer valid. The contract time check (`≥ finalCutoff` for timeout; `< finalCutoff` for evaluator/mutual) makes the boundary deterministic per block. Reviewer: confirm off-by-one semantics and that a block whose timestamp equals `finalCutoff` cannot execute an evaluator release.
- **Race 2 — competing terminal transactions** (evaluator release verdict vs relayer timeout refund vs mutual refund). The mutex + terminal-state guards ensure exactly one wins; the loser reverts `WrongState`. Reviewer: confirm no path where both succeed (two payouts) and no path where neither can ever succeed (livelock) under normal ordering.
- **Race 3 — dispute raised vs cutoff.** A dispute raised before cutoff freezes to Disputed; at/after cutoff a timeout refund is still eligible (T9). A dispute cannot extend the cutoff. Reviewer: confirm dispute toggling cannot shift `finalCutoff`.
- **Race 4 — verdict expiry vs cutoff.** Verdict has issuedAt window (±120s/300s per V1) AND the cutoff gate. Reviewer: confirm the intersection (`valid && beforeCutoff`) is the only executable window and that an expired-but-pre-cutoff verdict is rejected.
- **Race 5 — reentrancy** during token movements (transfer → state write). The `nonReentrant` mutex + checks-effects-interactions ordering. Reviewer: confirm the order in every transition.

---

## 5. Evaluator governance and disappearance scenarios

- **Disappearance before cutoff, escrow Funded:** timeout refund at/after cutoff releases to buyer (buyer-protective default; seller accepted this in the agreement consent).
- **Disappearance after a dispute is raised:** disputed escrow — at/after cutoff the T9 timeout refund releases to buyer. This is the policy §B.2 buyer-protective default.
- **Disappearance with an unresolved disputed escrow before cutoff:** funds stay held until cutoff (no admin; no pause); documented exposure, disclosed in the addendum (clause 5.5).
- **Evaluator compromise:** a malicious verdict before cutoff can move funds (release to seller / refund to buyer per the verdict); contract cannot detect compromise; mitigations are operational (key policy, monitoring) — and the cutoff does not help after a pre-cutoff terminal verdict (terminality is irreversible).
- **Key loss in a 2-of-3 MPC:** 2-of-3 continues signing; share lifecycle is off-chain/operational. **In Safe:** owner/threshold governance exists; any change must be disclosed + monitored (policy §C.6); historical verification requires owner snapshot at verdict block.
- **Disclosed, not hidden:** the addendum documents evaluator-dependence; the design does not promise unconditional recovery (policy §F.6).

---

## 6. Token transfer, pause/blacklist dependencies

- **Whitelist:** exactly one token per deployment at v2 (testnet USDC `0x036CbD…CF7e`; mainnet USDC re-verify — activation blocker). Fee-on-transfer/rebasing rejected by exact-delta (caveat: not provable for every rebasing token; the whitelist is the enforcement point).
- **No-return tokens (USDT-style):** supported via balance-delta proof.
- **Pause/blacklist (USDC can pause/blacklist):** the contract cannot override; a blacklisted buyer/seller/custody breaks transfers — an explicit external dependency (policy §F.5), disclosed in the addendum.
- **Token address(0):** `InvalidToken` revert at every movement.

---

## 7. Contract-wallet signature and historical-verification questions

1. Which mechanism is selected (MPC threshold vs Safe+EIP-1271)? What are the exact custody-contract deltas for each (EIP-1271 hook vs none)?
2. How does the verifier record and check the evaluator signer mechanism? For Safe: how does it read owner/threshold at the verdict block (snapshot vs current)? For MPC: is the aggregate key stable and derivable?
3. Does the v4 agreement schema's contract-wallet party signing (EIP-1271 reference) match the verifier's party-authorization check? What is the `walletType`/`verificationBlock` format?
4. Are the three signature domains (agreement consent, access auth, custody verdict) provably disjoint (different domain name/version/typehash)? Can a signature from one domain be replayed as another?
5. What happens to historical verification if a Safe owner set changes after a verdict? (Specified as snapshot-at-block; reviewer validates the approach.)
6. Admission is disabled until the signing mechanism is supported — reviewer to confirm the admission gate is not bypassable by any route.

---

## 8. Advanced-profile exclusions (what v2 does NOT do)

- No partial awards / partial refunds / arbitrary recipient changes (restricted profile only; policy §B.8).
- No automatic whole-transaction buyer refund after value has changed hands in advanced profiles (policy §D.4).
- No per-milestone partial settlement inside one escrow — advanced milestones use **separate escrow positions** (§8.1 custody design); the Σ milestone == principal invariant is agreement-level (off-chain) at v2.
- No universal dollar threshold for high-value assurance (policy §D.3); no unconstrained-AI final adjudicator (profiles §3).
- PHYSICAL_DELIVERY, SUBJECTIVE_SERVICE, HIGH_VALUE_ASSURANCE: defined but **inactive** until evidence/adjudication/longstop mechanisms exist.

---

## 9. Specific questions requiring reviewer judgment

1. Is the `deadline` (resolution window) vs `finalCutoff` (timeout boundary) distinction sound, or does it introduce a semantic gap (e.g. evaluator cannot release between `deadline` and `finalCutoff` while mutual signatures also expire at `deadline`, but timeout only opens at `finalCutoff` — is there a dead window where nothing can resolve and funds sit until cutoff)? **This is the most important design question.**
2. Should the mutual-release/refund window equal the resolution window (deadline) or extend to `finalCutoff`? Policy §B.1 says "within the agreed resolution window" — confirm `deadline` is the right bound for BOTH evaluator and mutual actions, or whether mutual should be bounded by cutoff.
3. Is `resolve("hold")` returning Disputed → Funded at/after cutoff sound when the timeout refund is simultaneously eligible? Confirm the `state` re-check and the exact ordering.
4. Are the on-chain exposure caps necessary at v2, or is service-level intake enforcement (with disclosure) sufficient until volume requires on-chain caps? (Policy §F.2 requires on-chain if advertised as hard caps.)
5. Is the v4 field set **complete** for the restricted profile (no missing outcome-affecting value), and is the required/optional classification right?
6. Should `consents` include an explicit **buyer** consent (not just seller timeout consent)? (Spec requires both parties' `accepted:true`.)
7. Does the COSE_Sign1 envelope + EIP-712 consent dual-scheme create ambiguity about which signature is authoritative in the export? Recommend one canonical representation.
8. For the MPC 2-of-3 route: is the fixed-aggregate-key property strong enough to justify dropping the EIP-1271 hook, given the operational dependency on the MPC provider?

---

## 10. Unresolved owner economic/legal parameters

| Parameter | Status |
|---|---|
| 2-of-3 evaluator mechanism (MPC vs Safe) | Owner decision + independent review |
| Exposure caps (perPositionCap, aggregateCap values) | Owner decision |
| Resolution window (`deadline`) and final cutoff durations | Transaction-specific (agreement-level) |
| Mainnet custody deployment address + USDC address | Deployment phase (Phase 6) |
| Legal review of the agreement/addendum (incl. seller timeout consent) | Qualified legal review |
| Governing law/forum/institutional rules | Explicitly left for selection (addendum §11.2) |
| Dispute-cost reserve funding amounts (HVA) | Owner decision |
| Advanced-profile activation (longstop executor identity, evidence/adjudication mechanisms) | Deferred to later phases |

---

## 11. Review status

- **Vendor internal review:** performed by the station overseer during Phase 2 (consistency checks across policy, addendum, admission schema, custody design, signing spec — see the Phase 2 verification section in the build log).
- **Independent design review: NOT COMPLETED.** This brief is the commissioning packet. No external reviewer has been contacted, no engagement has been made, and nothing in this package represents independent approval.

*End of design-review brief.*---

## Phase 3A implementation status (appended)

An internal custody candidate `SAAXEscrowCustodyV2` was implemented and tested locally
(`contracts/SAAXEscrowCustodyV2.sol`; harness `scripts/test-custody-v2.cjs`; local-only Hardhat
EVM, chainId 84532). Status doc: `mainnet/design/phase3a-status.md`.

Key implementation differences from the proposed design:
- Evaluator verification is implemented via an ERC-1271-style hook (`isValidSignature` on the
  evaluator contract), validated with a Safe-signature-model mock (`contracts/mocks/SafeMock2of3.sol`)
  using genuine secp256k1 EIP-712 signatures. The production Safe singleton + owner/threshold
  governance is NOT yet integrated — the mock is not the Safe deployment.
- Mutual resolution (`mutualRelease`/`mutualRefund`) is implemented with a single global
  `usedMutualNonce` replay map. The Phase 2 design's per-escrow nonce proposal was simplified to a
  global space; tests use distinct nonces across escrows. Reviewer question: confirm a global mutual
  nonce space is acceptable, or whether per-escrow nonces are required for the v2 spec.
- Terminal-state replay is enforced by state (`WrongState`), not by a replay nonce — a second
  release on a released escrow reverts. This satisfies "no double payout" but differs from a
  nonce-based replay error. Reviewer question: is state-based rejection sufficient for the
  restricted profile, or must replay errors be distinguishable by the verifier?

Remaining implementation work before review completion:
- Real Safe singleton deployment and owner/threshold governance tests.
- Verifier extension for the v4 agreement format (spec-only today).
- ERC-1271 historical-execution-context validation in export verification.

## Phase 3B reproducibility and v4 checkpoint update

Current authoritative local checkpoint detail: `mainnet/design/phase3b-v4-checkpoint.md`.
This supersedes earlier statements that real Safe integration and isolated v4 verification
are wholly unimplemented, without changing the historical Phase 2/3A evidence.
Safe 1.4.1, solc 0.8.26 and Hardhat 2.22.4 are pinned. Local Safe integration uses the
actual singleton, proxy, factory, fallback handler and owner-governed threshold change.
The version-dispatched v4 verifier is isolated from production. Its custody domain is
selected from an exact repository-owned V2 runtime identity, not manifest format version.
Historical ERC-1271 uses canonical successful direct-call execution evidence, including
same-block governance ordering; no current/end-of-block Safe snapshot substitutes for it.

Reviewer must assess the execution-witness trust model, RPC integrity assumptions,
bytecode identity maintenance, the unresolved resolution-deadline/contract-cutoff gap,
and the limits of ERC-1271 acceptance vs independently approved Safe governance.
External evidence sufficiency, public-chain finality, contract-wallet party consent,
advanced profiles, worker, exhaustive fuzz/invariants and independent audit remain gaps.
Mainnet admission stays disabled. No deployment, push or production wiring occurred.
---

# Phase F1 addendum — commissioning brief updated around the ACTUAL candidate

**Prepared:** Phase F1 (this run). **Baseline verified:** HEAD `86061976` (35 local commits
ahead of origin/main `bf8c603d`). This addendum scopes the review around the implemented
candidate as it actually exists at HEAD, replaces nothing historical, and does not claim any
review is complete.

## A. Actual candidate and integration paths to review

| Item | Actual path / value | Notes |
|---|---|---|
| Custody candidate | `contracts/SAAXEscrowCustodyV2.sol` | Restricted OBJECTIVE_DIGITAL; new immutable deployment vs V1 (breaking ABI: `bytes` verdict container, finalCutoff/mutual/caps/policy/agreement fields). LOCAL ONLY, candidate, not frozen. |
| V1 baseline (read-only context) | `contracts/SAAXEscrowCustodyV1.sol` | Testnet-only; no-liveness limitation closed in V2 by final-cutoff timeout refund incl. Disputed. |
| Signer vault | `worker/signing-vault.js`, `worker/prepared-vault.js` | AES-256-GCM envelope; decrypt ONLY in restricted broadcast path; fail-closed. |
| Worker | `worker/d1-worker.js`, `worker/d2-worker.js`, `worker/d3-worker.js`, `worker/d1-store.js`/`d2-store.js`/`d3-store.js`, `worker/d3-action-auth.js`, `worker/d2-prereqs.js` | SQLite WAL single-host; at-most-once custody effects; hosted lane NOT wired (`SAAX_INTEGRATED_WORKER` off). |
| Finality | `worker/d2-finality.js`, `worker/d2-trusted-rpc-finality.js`, `worker/d2-historical-finality.js`, `verifier/v4-finality-adapter.js` | Trusted-config policy; trusted-RPC and bounded-ancestry methods; SAFE≠FINALIZED; chain gates (31337 local / 84532 testnet / 8453+1 BLOCKED). |
| Verifier | `verifier/verify-export.js` (dispatch), `verifier/verify-v4.js`, `verifier/v4-anchor.js`, `verifier/v4-journal.js`, `verifier/v4-evidence.js`, identity/eas-policy JSON files | Local lifecycle ceiling = VERIFIED_WITH_LIMITATIONS; issuance = VERIFIED_ISSUANCE_ONLY; no unrestricted VERIFIED. |
| Admission | `mainnet/admission/` | Structural subset; final admission disabled for mainnet. |
| Agreements | `mainnet/agreements/custody-policy-addendum-v1.md`, `mainnet/design/agreement-signing-spec.md` | Template requires transaction completion + qualified legal review. |
| Durable schema (hosted) | `data/day17_escrow_durable.sql` | Postgres/PostgREST; archival; live path not wired. |

## B. Signer/encryption architecture (review focus)

- Threat model and key boundaries per `d4a-signer-isolation.md`: relayer key in worker env
  only; evaluator owner keys never in the API process; prepared signed bytes sealed with
  AES-256-GCM (AAD = op/chain/sender/nonce/intended tx); prepared-key delivered out-of-band.
- Process-level separation proven under the SAME OS account; **not host-compromise
  isolation**; remote/HSM/KMS signing NOT implemented (explicit limitation).
- Config gates (D4B) fail closed before store open/sign/broadcast; complete immutable
  signing intent; validly-encoded unauthorized verdicts rejected (EVALUATOR_MISMATCH /
  ESCROW_BINDING_MISMATCH / threshold-below).

## C. Safe/governance dependencies

- Safe 1.4.1 + proxy/factory/fallback handler pinned; local EVM governance/changeThreshold
  tested. Production Safe wiring in the hosted worker NOT done.
- **Explicit:** successful ERC-1271 execution does NOT establish approved 2-of-3 Safe
  governance or adjudicator independence. Historical ERC-1271 method = canonical successful
  direct-call execution witness through the allowlisted immutable runtime; owner/threshold
  snapshot-at-verdict-block verification SPECIFIED, not implemented.

## D. Recovery/finality assumptions to review

- At-most-once custody effects (no unconditional exactly-once); PENDING →
  SUBMISSION_UNCERTAIN → INCLUDED → FINALIZED|REVERTED|BLOCKED; absent receipt = uncertain,
  never non-broadcast; reorg returns to reconciliation, no second business action;
  FINALIZED_CONTRADICTION blocking incident.
- Finality trust model: trusted-RPC consensus-status assertion (safe/finalized tags),
  NOT independent consensus reconstruction, NOT a cryptographic ancestry proof. Bounded
  ancestry method fails closed (BOUND_EXCEEDED) on deep history; trusted-RPC method serves
  deep history within a request budget. Anchor finality NOT ESTABLISHED (cid/digest refs only).

## E. Known limitations and unresolved decisions (list for the reviewer)

See `mainnet/release-candidate-gap-assessment.md` §3 (Q1 journal-head commitment; Q2
verifier-vs-contract divergences: resolution deadline and minReleaseTime enforced by
verifier, not contract; global mutual nonce; terminal-state replay by state; Q4
contract-vs-service enforcement; Q5 finality policy). Economic values (caps, durations),
mainnet USDC pinning, Safe production identity, governance snapshot verifier, legal review,
disclosure review, fee-replacement posture, host-level key isolation are unresolved inputs.

## F. Required reviewer deliverables

1. Findings report with severities (critical/high/medium/low) and location refs.
2. Disposition table: fixed / won't-fix with rationale for every finding.
3. Remediation verification: re-check of every changed code path after fixes.
4. Post-deployment bytecode/config verification procedure (compare on-chain runtime code
   hash to the artifact; verify chain/custody env; escrow-backed off until authorized).
5. Explicit statement of what the review does not cover (x402 lane, website, OS/host,
   third-party internals as trust assumptions) and residual risks (key custody, token
   behaviors, RPC trust, Safe governance).

## G. What must finish before a meaningful release-candidate freeze

Owner decisions (§3 of the assessment), freeze commit + embedded compiler metadata +
reproducible rebuild, full suite re-run on the frozen candidate (not HEAD drift),
resolution or explicit freezing of the verifier-vs-contract divergences, hosted-lane worker
wiring decision, provisioned RPC/Safe/secret inputs. **The candidate is not frozen, not
audited, not deployed, and must not be described as such.** No auditor outreach, no paid
engagement, no fabricated quotes — this addendum finalizes the commissioning packet only.

*End of Phase F1 addendum.*