# F2 — Close Design Decisions and Prepare Reproducibility

**Status:** Pre-freeze decision + build exercise. **Not** a frozen release-candidate audit. No push, deployment, chain writes, spending, or activation performed.

- **Actual HEAD verified:** `7454cb9d6364ed041007d580fa950be3e81d59b5` — matches the reported documentation commit (F1 gap assessment).
- **Local commit (this F2 deliverable):** see final git log; this document is committed locally only.
- **Read:** `mainnet/release-candidate-gap-assessment.md` (F1), `mainnet/design/v4-journal-schema-decision.md` (§7–§8), `mainnet/design/custody-v2-design.md` (§5–§6), `mainnet/design/design-review-brief.md` (addendum), `mainnet/policies/transaction-profiles-v1.md`, `contracts/SAAXEscrowCustodyV2.sol`, `hardhat.config.js`, `scripts/_build-custody.cjs`, `data/escrow-custody-build.json`, `data/escrow-custody-v2-build.json`, `build/hardhat-artifacts/.../SAAXEscrowCustodyV2.json`, `mainnet/mainnet-escrow-readiness.md` (gates G2).

---

## 1. Preserved established decisions (unchanged, not reopened)

| Decision | Stance |
|---|---|
| Launch scope | Restricted OBJECTIVE_DIGITAL only |
| Evaluator authority | Safe + ERC-1271; recommended 2-of-3 evaluator authority |
| Advanced profiles | Disabled |
| EAS anchoring + independent verification | Genuine anchors + separate-process verifier |
| Administrative withdrawal | None (no admin/owner/upgrade/withdraw) |
| Mainnet admission | Disabled |
| Chains | Base mainnet `8453` (target) · local tests `31337` · testnet `84532` |

Still **unresolved inputs** (recorded, not invented): actual Safe owner identities, governance controls, economic limits (numeric caps), production provisioning (RPC/KMS/hosting).

---

## 2. Q1 — On-chain pre-settlement journal-head commitment

### Exact question and source

**Source:** `mainnet/release-candidate-gap-assessment.md` line 103 (F1 table):

> **Q1 | Is an on-chain pre-settlement journal-head commitment required for the selected launch profile?**

Supporting recommendation and rationale in `mainnet/design/v4-journal-schema-decision.md` §8 ("Mainnet binding path"):

> Recommended mainnet mechanism (corrected): a settlement-time *pre-settlement head* commitment in the custody contract. The parties sign the agreement at issuance under head-binding (as now). The settlement transaction commits the journal's **pre-settlement head** — the tail *before* the settlement entry is appended. The settlement receipt is then linked into the journal as a *subsequent* entry.

> State plainly: **"settlement commits the tail" is not implementable as written** — the design must commit the pre-settlement head, not the settlement entry's own hash.

The Q1 journal-head question itself originates in the v4 journal lifecycle design lineage (`v4-journal-schema-decision.md` §7–§8, binding question §3).

### Option A — Existing authenticated head-bound journal (status quo)
**What exists today:** agreement signed at issuance under head-binding; lifecycle events are signed, parent-referenced, hash-chained; the verifier checks `prevHash`/`entryHash`/`eventCount`/`tailHash` ordering. **Explicit completeness limits** are documented: the on-chain initial agreement anchor authenticates the agreement, not later events; the local hash chain alone does not authenticate later history. Verifier ceilings: `VERIFIED_ISSUANCE_ONLY` / `VERIFIED_WITH_LIMITATIONS`, never unrestricted VERIFIED.

**Strengths:** no new contract; no calldata growth; pilot-proven; nothing to rebuild.
**Weaknesses:** journal association for the settlement boundary is off-chain; a later-history checkpoint requires either the fixed-transition-set rule or a checkpoint chain — either way, completeness needs more than the current single anchor.

### Option B — Custody-enforced, authorized pre-settlement-head commitment (recommended by §8)
Specification (as resolved by this document, consistent with `v4-journal-schema-decision.md` §8):

- **Which hash is committed:** the journal's **pre-settlement head** — the hash-chain tail as it exists immediately *before* the settlement entry is appended. Not the settlement entry's own tx hash (circularity: an entry recording a transaction cannot contain that transaction's hash, since the hash depends on the entry's contents).
- **Who authorizes it and what signature covers it:** the authorized settlement submitter (the same evaluator/Safe authority that authorizes `release`/`refund`). The head hash becomes part of the **signed verdict payload** (or mutual-resolution payload) that already authorizes settlement — the EIP-712 digest for the settlement action includes `preSettlementHead` as a signed field.
- **When computed/persisted:** computed off-chain at settlement time, immediately before the settlement call; persisted as part of the signed settlement request and in the journal entry that records the settlement receipt as a *subsequent* entry.
- **How the settlement receipt is appended afterward:** after the on-chain settlement transaction confirms, the receipt entry is linked into the journal (parent = the pre-settlement head), preserving the hash chain.
- **Crash/retries/competing settlement/failed journal persistence:** the commitment is **idempotent** — the same head + same verdict nonce cannot double-execute (verdict nonce replay guard in custody). If the journal write fails after chain confirm, recovery re-derives the appended chain from the durable intent record, never re-broadcasting a consumed nonce (matches existing worker crash-gap design D1–D3). Competing settlement: committed head is bound to the escrow's `commitmentId` and the verdict nonce, so a competing settlement with a different head reverts or is replay-rejected; terminal exclusivity holds (one terminal state per escrow).
- **What it proves and does not prove:** proves, on-chain, that the journal state up to settlement was exactly the submitted head (association + tamper evidence at the settlement boundary), and that the submitter was authorized. It **does not** prove completeness of the off-chain journal (the contract records the *submitted* head; it cannot know the true off-chain tail) — completeness still requires the fixed-transition-set or checkpoint rule. It also does not commit the post-settlement tail.
- **Required ABI/signing/verifier/worker/test changes:**
  - **ABI/contract:** new immutable custody version accepting `preSettlementHead` in settlement calldata (e.g. a `bytes32` field in `release`/`refund`/`resolve` verdict payloads or a dedicated `commitSettlementHead` call), recorded per-commitment, replay-guarded by the existing verdict nonce.
  - **Signing:** verdict/mutual EIP-712 types gain the `preSettlementHead` field; signer (Safe ERC-1271 wrapper and EOA path) must sign it.
  - **Verifier:** new check — resolved on-chain `committedHead == journal pre-settlement tail`; new identity/expectation in the v4 verifier map; negative cases (wrong head, head from another commitment, omitted head).
  - **Worker:** settlement worker persists `{commitmentId, preSettlementHead, verdictNonce}` as intent before broadcast; reconciliation compares chain-recorded head to journal; crash boundaries B2/B3 extended.
  - **Tests:** new custody harness cases (wrong-head rejection, replay, competing settlement), verifier negatives, crash-gap cases.

### Recommendation: **Option B** for mainnet (per §8), Option A retained for the pilot.
**Concrete reasons:** (1) it is the only self-consistent formulation (avoids the circularity §8 names); (2) it anchors the settlement boundary on-chain with minimal calldata (one `bytes32`); (3) it directly answers the declared "missing on-chain anchor-finality axis" in the F1 review scope; (4) completeness is explicitly *not* claimed — the fixed-transition-set/checkpoint rule remains an open follow-up, keeping the claim honest.
**Compatibility costs:** new immutable contract version (Q3 item 1); full re-test + review on the new candidate; verdict-signing type change (Safe + EOA); verifier/worker schema updates; pilot artifacts do not carry over.
**Review questions:** (a) is the head committed in the verdict digest or a separate call (affects replay semantics)? (b) does the pre-settlement component need its own nonce or reuse the verdict nonce? (c) which verifier identity policy pins the committed head — and must the verifier treat "no committed head" as incomplete for mainnet?

---

## 3. Q4 — Contract-enforced vs service/operator-enforced controls

### Exact question and sources

**Source:** `mainnet/release-candidate-gap-assessment.md` line 106 (F1 table):

> **Q4 | Which launch controls are contract-enforced vs service/operator-enforced?**

Supporting divergence in line 104 (Q2):

> (a) contract gates evaluator/mutual by cutoff only — the **resolution deadline is enforced by the verifier**, not the contract; `resolve:*` and mutual paths do not enforce `minReleaseTime`.

Profile deadlines in `mainnet/policies/transaction-profiles-v1.md`:
- `deliveryDeadline` (line 26): "the time by which fulfillment must complete"
- `resolutionDeadline` (line 27): "end of the evaluator resolution window"
- `finalCutoff` (line 28): "at/after this, unresolved escrow becomes eligible for refund"; MUST be ≥ delivery and resolution deadlines; fixed at funding
- `buyerRefundTimeoutConsent` (line 29); `cutoffExtensionRule = "none"` (line 35); deadline consistency `deliveryDeadline ≤ resolutionDeadline ≤ finalCutoff` (line 124)

Contract fields (`contracts/SAAXEscrowCustodyV2.sol`): `deadline` (resolution window end, line 96), `finalCutoff` (line 97), `minReleaseTime` (line 98); ordering `minReleaseTime ≤ deadline ≤ finalCutoff` enforced at fund (lines 383–384).

### Boundary table (from actual code and terms)

| Action | Earliest permitted execution | Latest permitted execution | Authority | Contract enforcement | Additional service/verifier checks |
|---|---|---|---|---|---|
| **Fund** | any time (fundingEnabled gate) | fundingEnabled=false rejects (intake) | anyone (binds terms at fund) | `fundingEnabled` gate; term binding (digest, parties, caps) | admission allowlist, chain guard (84532 only) |
| **Release (evaluator verdict)** | `block.timestamp ≥ minReleaseTime` (`NotYetValid`, V2:442) | `block.timestamp < finalCutoff` (`AfterCutoff`, V2:443) | evaluator verdict (Safe ERC-1271 / EOA), nonce-replay-guarded | **minReleaseTime YES; finalCutoff YES**; `deadline` NOT enforced at release (only verifier) | verifier checks resolutionDeadline window, verdict 120/300s expiry, policy identity |
| **Refund (evaluator verdict)** | any (no min) | `block.timestamp < finalCutoff` (`AfterCutoff`, V2:477) | evaluator verdict | **finalCutoff YES** | verifier: resolutionDeadline, expiry, policy |
| **Refund (timeout)** | `block.timestamp ≥ finalCutoff` (`DeadlineNotPassed`, V2:485) | none (terminal) | **anyone** (beneficiary fixed = original buyer; no caller-chosen recipient) | **finalCutoff YES** (V2:480-485) | verifier: cutoff ≥ all deadlines, consent recorded |
| **Resolve dispute (verdict)** | any (minReleaseTime NOT checked on resolve) | `block.timestamp < finalCutoff` (`AfterCutoff`, V2:532) | evaluator verdict `resolve:release/refund/hold` | **finalCutoff YES; minReleaseTime NOT enforced on resolve** | verifier: resolutionDeadline, expiry, policy; note the Q2(a) divergence |
| **Mutual release/refund** | any | `block.timestamp < finalCutoff` (`AfterCutoff`, V2:578) | buyer + seller signatures, global mutual nonce | **finalCutoff YES; minReleaseTime NOT enforced on mutual** | verifier: mutual nonce per-escrow question (Q2(b)), expiry |
| **Raise dispute** | Funded only (`WrongState` otherwise) | before terminal state | buyer or seller only (`NotParty`, V2:565) | **party restriction YES** | verifier: dispute after cutoff path (timeout eligible) |
| **Delivery deadline** | — | fulfillment must complete by `deliveryDeadline` | agreement-level (signed terms) | **NOT contract-enforced** (no field; policy-level) | verifier: journal evidence vs delivery deadline; evaluator judgment |
| **Evaluator/mutual signature validity** | — | verdict issued within ±120s/300s window (per V1 convention); executed before cutoff | evaluator / both parties | **expiry NOT contract-enforced** (V2 has no issuedAt window check; verifier-only), cutoff YES | verifier: verdict expiry window, cutoff override (§B.5) |
| **Final cutoff** | fixed at fund | non-extendable (`cutoffExtensionRule="none"`; §6.3) | immutable at fund | **YES (AfterCutoff on all resolutions; DeadlineNotPassed below)** | verifier: no extension, earlier sigs don't override |
| **Timeout eligibility** | `≥ finalCutoff` both Funded and Disputed | terminal | anyone (beneficiary fixed) | **YES (T4/T9; V2:480-485)** | verifier: consent, cutoff ≥ deadlines |

### Recommendation for Q4

**Contract-enforce the economic execution boundaries that must survive direct contract calls** — specifically the **resolution deadline** (`deadline`) on `release`/`resolve`/mutual paths, matching the already-enforced `finalCutoff` and `minReleaseTime`. Rationale: service/verifier checks supplement enforcement; they **cannot undo an unauthorized payout** made by a direct chain call that bypasses the app. The signed agreement promises `resolutionDeadline`; the current candidate only honors it if the app's verifier is in the path. Per Q2 divergence (a), this is a **new immutable contract version** (Q3 item 2) — not a patch to the candidate.

- Enforce `block.timestamp < deadline` for evaluator release/refund/resolve and mutual release/refund (mirroring the existing `finalCutoff` gate), OR drop the field's contract meaning and rename it (documenting it as verifier-only). Recommendation: **enforce it** — the policy already defines `resolutionDeadline` as the evaluator window end; leaving it verifier-only is a silent narrowing of the signed terms.
- `minReleaseTime`: enforce on `resolve:*` release and mutualRelease the same way release already does (`NotYetValid`), closing Q2(a) fully.
- Mutually exclusive terminals already enforced; replay guards remain (verdict nonce global — keep, note Q2(b) per-escrow mutual nonce as a reviewer item; do not change without review).
- Verdict **expiry window** stays verifier-only (it is a service-liveness concern, not an economic-boundary: an old signature executed before cutoff still pays the agreed party the agreed amount — acceptable; document as such).

**Unsupported promise / missing signed parameter identified:** the verifier currently enforces `resolutionDeadline`, but the **contract does not**, and the **delivery deadline is not signed into any on-chain-visible field** (policy-level only). If the launch profile promises "resolution deadline is a binding boundary," the signed agreement must bind a field the settlement path can enforce — closing Q4 means (a) enforcing `deadline` in-contract and (b) declaring `deliveryDeadline` an **agreement/evidence-level obligation, not an on-chain gate** (delivery completion is adjudicated by the evaluator from evidence, not by the custody contract). Do not invent a review window or change timeout economics; `minReleaseTime`, `deadline`, `finalCutoff` are all already defined fields — the fix is enforcement parity, not new semantics.

---

## 4. Reproducible builds (pre-freeze exercise)

### Inspection results

| Artifact | Path | Metadata embedded? | Reproducible under documented settings? |
|---|---|---|---|
| V1 artifact | `data/escrow-custody-build.json` | **No** (keys: abi, bytecode, source, compiledAt) | **Yes** — rebuild via `_build-custody.cjs` settings (optimizer 200, viaIR, **no evmVersion**) → byte-identical 13928 chars ✓ |
| V2 hardhat artifact | `build/hardhat-artifacts/.../SAAXEscrowCustodyV2.json` | **No** (keys: _format, contractName, sourceName, abi, bytecode, deployedBytecode, linkReferences…) | **Yes** — F2 pinned-settings build (paris, optimizer 200, viaIR) → byte-identical 21268 chars ✓ |
| V2 data stub | `data/escrow-custody-v2-build.json` | **No** | N/A (ABI+note only) |

**Key finding:** the two toolchains produce **different bytecode for the same V1 source** because `_build-custody.cjs` omits `evmVersion` (solc default) while `hardhat.config.js` pins `evmVersion: 'paris'`. Both are deterministic under their own settings; neither artifact **embeds** its settings, so a third party cannot tell which settings produced either. That is the G2 reproducibility-input gap, now precisely evidenced:
- V1 rebuild (no evmVersion): 13928 chars == existing artifact ✓
- V1 rebuild (paris): 14518 chars ≠ existing artifact (expected: different EVM version semantics)
- V2 rebuild (paris == hardhat): 21268 chars == hardhat artifact ✓

### New tooling (narrowly necessary)
`scripts/_f2-repro-build.cjs` — compiles V1+V2 via pinned solc-js (0.8.26+commit.8a97fa7a, optimizer 200, viaIR, evmVersion paris), embeds `solcVersion`, `settings`, per-contract `metadataHash` (sha256 of solc metadata), `sourceHash`, and a `buildHash` over the whole result; writes `data/escrow-custody-repro-build.json`. Demonstrates an **isolated rebuild in the same process** → **byte-identical (sha256 `67af9b2e…`)**.

**Documented settings for rebuild:** `solc 0.8.26+commit.8a97fa7a` · optimizer `{enabled:true, runs:200}` · `viaIR:true` · `evmVersion:'paris'` · output selection abi + evm bytecode + metadata. Reproduce: `node scripts/_f2-repro-build.cjs`.

**Changes required before freeze (reproducibility):**
1. Pin `evmVersion: 'paris'` in `scripts/_build-custody.cjs` (align with hardhat) and regenerate `data/escrow-custody-build.json`.
2. Embed compiler metadata (solcVersion, settings, metadataHash, sourceHash) in **both** artifact files — the frozen candidate's artifacts must carry it (readiness G2).
3. Record the frozen candidate commit + buildHash in the verifier identity policy (like `v4-candidate-identity.json` style).
4. Decide V1-vs-V2 artifact policy: the deployed/harness-referenced artifact for custody is V1 (`data/escrow-custody-build.json`); the candidate for mainnet is V2 (hardhat). Keep both reproducible with explicit settings metadata.

**Label:** this is a **pre-freeze build exercise** — NOT a frozen release-candidate audit, NOT a full functional-suite rerun. No suite was rerun for this phase.

---

## 5. Corrected readiness sequence

The assessment's sequence is corrected to the following ordered path (independent design review may run earlier to assess Q1/Q4 and trust assumptions; anchor finality and public deployment identity remain explicit remaining requirements — no fabricated deployment evidence):

1. **Design decisions** — Q1 (journal-head commitment: Option B recommended) + Q4 (resolution-deadline/minReleaseTime contract enforcement) + economic/caps/evaluator/legal owner inputs.
2. **Required implementation** — new immutable custody version (Q3 items 1+2): pre-settlement-head commitment + deadline/minReleaseTime enforcement; verdict/mutual signing type changes; verifier schema + identity policy update; worker intent/reconciliation extension.
3. **Focused validation** — narrow new-contract + verifier + worker crash-boundary tests on the new candidate; no broad-suite rerun yet.
4. **Reproducible release-candidate freeze** — frozen commit + embedded compiler metadata + byte-identical rebuild evidence (G2) + buildHash pinned in verifier policy.
5. **Independent release audit** — commissioning packet references the frozen commit; reviewer scope per design-review-brief addendum; findings disposition table.
6. **Remediation / reassessment** — audit findings fixed or explicitly won't-fix with rationale; re-check changed paths.
7. **Operating gates** — G1 policy direction (secondary-exit decision), G3 full-suite rerun on the frozen candidate, G6 recovery boundaries (D3 execution worker), admission/monitoring/runbook.
8. **Deployment authorization** — separate explicit owner authorization to deploy (mainnet blocked by supported-network policy until then).
9. **Deployment verification** — deployment tx + nonce + block recorded; on-chain code-hash compared to artifact; env/config verified before any funding.
10. **Separately authorized funding / canary** — real funds only after post-canary gate; canary limits per owner decision.

Anchor **finality** (finalized-head confirmation of the EAS anchor and settlement) and **public deployment identity** (who operates / which address) remain explicit remaining requirements — they are not fabricated or pre-claimed.

---

## 6. Deliverable, affected files, acceptance

**This F2 document:** the compact decision record above.

**Affected files this task:** `scripts/_f2-repro-build.cjs` (new), `data/escrow-custody-repro-build.json` (new artifact), this doc + build-log entry. **Not** committed: no source/contract changes were made (no implementation — documentation + build exercise only).

**Dependencies for next phase:** owner decisions (Q1 yes/no; Q4 enforce-in-contract yes/no; numeric caps; evaluator identity; Safe owners/threshold; legal review), then the new custody version spec.

**Acceptance criteria (F2):**
- [x] Actual HEAD verified (`7454cb9d`) vs reported commit.
- [x] Q1/Q4 exact wording quoted with sources; per-option tradeoffs; one recommendation each with compatibility costs and review questions.
- [x] Q4 boundary table from actual code + terms; contract-vs-service split explicit; unsupported promise (resolution deadline verifier-only; delivery deadline policy-only) identified.
- [x] Reproducible-build exercise: V1 and V2 rebuilds byte-identical under documented settings; metadata gap (no embedded compiler metadata) evidenced; new tooling + artifact produced; labeled pre-freeze.
- [x] Readiness sequence corrected (1→10 with independent review earlier; anchor finality + deployment identity explicit).
- [x] No push, deployment, chain writes, spending, outreach, production keys, activation.

**Smallest remaining owner decisions:**
1. Q1: approve Option B (pre-settlement-head commitment) — yes/no.
2. Q4: approve in-contract enforcement of `deadline` + `minReleaseTime` on resolve/mutual (new immutable version) — yes/no.
3. Numeric exposure caps (per-position, aggregate).
4. Safe production owner identities + threshold (2-of-3 recommended) + key custody.
5. Legal review of addendum/disclosures (governing law/forum).
6. Named RPC provider(s) for mainnet + finality policy approval (`trusted-rpc` + `op-stack-finalized` recommended).
7. Mainnet USDC address pinning + token whitelist.
8. Canary limits + initial admission list.

**Exact next bounded implementation phase (after owner decisions):** "V3 custody spec + focused validation": produce the new immutable custody contract spec (pre-settlement-head commitment field + deadline/minReleaseTime gates), the verdict-digest type change (Safe ERC-1271 + EOA), verifier schema/identity update, and the D3 worker intent/reconciliation extension — **documentation + focused tests only**, still no deployment. If the owner defers Q1 or Q4, that phase shrinks to the accepted subset; nothing is frozen early.