# SAAX Release-Candidate Gap Assessment — Phase F1 (Consolidated)

**Status:** INTERNAL — inspection and documentation only. Not a security audit, not a
deployment, not an activation, not a readiness claim.
**Baseline verified:** repository HEAD is `86061976` ("E1 closure: explicit supported-network
policy + runtime finality configuration seam") — matches the reported baseline exactly.
Branch `main`; last pushed commit on `origin/main` is `bf8c603d`; HEAD is **35 local commits
ahead of origin/main**. Working tree has pre-existing unrelated modifications (472 status
entries); none were changed by this assessment.
**Scope discipline observed:** no push, no deployment, no public-chain writes, no spending,
no outreach, no production secrets, no mainnet activation. No test suite was re-run; every
count below is a historical report from the cited committed evidence at or before HEAD.

This document is the authoritative overview. Detailed documents are linked, not repeated.

---

## 0. Evidence tier legend (how to read every table)

| Tier | Meaning |
|---|---|
| PROPOSED | Specified in policy/design documents only; no implementation |
| IMPLEMENTED-LOCAL | Code exists in the working tree at HEAD |
| DEMONSTRATED-LOCAL | Implemented and exercised against the local EVM (31337) with genuine contracts (custody V2, official EAS 1.7.1 local, real Safe 1.4.1 local, MockUSDC) or labeled mocks — local-only evidence |
| TESTNET-DEMONSTRATED | Exercised read-only against public Base Sepolia 84532 (observations; no public writes) |
| OPERATIONALLY-DEPLOYED | Wired into the hosted production route |
| INDEPENDENTLY-REVIEWED | A review by a party other than the vendor, recorded |
| NOT-ESTABLISHED | Requirement not met; evidence does not exist |

A configuration gate, declaration, or test double is **never** equated with a functioning
production control. "Tests pass" establishes conformance, not security.

---

## 1. The authoritative gap table

Status codes: **DONE-IN-SCOPE** (satisfied for the restricted OBJECTIVE_DIGITAL launch
profile as presently scoped) / **PARTIAL** / **BLOCKED** / **NOT-STARTED** /
**DEFERRED-OUT-OF-LAUNCH** (advanced profile, out of the restricted launch).

### 1.1 Custody policy, dispute liveness, admission, bindings

| Requirement | Actual implementation / evidence | Status | Remaining action | Dependency | Completion criterion |
|---|---|---|---|---|---|
| Dispute-liveness rules and their exact economic consent | V2 candidate: `finalCutoff` fixed at `fund`; timeout refund eligible at/after cutoff for **both** Funded and Disputed (T4/T9 in contract source); mutual release/refund before cutoff; earlier verdicts cannot override cutoff (AfterCutoff). Seller's express timeout consent is a required digest-covered manifest field (`consents.sellerTimeoutConsent`), mirrored in the addendum clause 4.3 and the admission validator (`buyerRefundTimeoutConsent.acceptedBySeller === true`). DEMONSTRATED-LOCAL (test-custody-v2 T25-T28/T31/T33/T34; D2 40/40; D3 47/47). | DONE-IN-SCOPE | None for the mechanism; owner must set per-agreement durations (`deadline`, `finalCutoff`) and confirm the legal review of the timeout consent (addendum). | Owner decision (values); legal review | Signed decision log with durations; addendum clause 4.3 reviewed |
| Supported actions and objective-digital admission | Actions: `release`, `refund` (verdict), `refund` (timeout), `raiseDispute`, `resolve` (release/refund/hold), `mutualRelease`, `mutualRefund` — implemented in V2 candidate; worker D1–D3 prepare/broadcast/reconcile the same action set. Admission validator (`mainnet/admission/`) 40/40, distinguishes structural / missingActivation / unsupportedCapabilities / finalAdmission; final admission disabled for mainnet. | DONE-IN-SCOPE (mechanism; activation disabled by design) | None for mechanism. Activation requires signing mechanism selection + economic inputs (validator returns missingActivation). | B (owner decisions) | Validator finalAdmission passes for a populated OBJECTIVE_DIGITAL agreement after owner inputs, on 84532 testnet only |
| Advanced profiles remaining disabled | PHYSICAL_DELIVERY / SUBJECTIVE_SERVICE / HIGH_VALUE_ASSURANCE defined in `transaction-profiles-v1.md`, structurally validated, **inactive**: validator rejects activation (missing legal instrument, longstop executor, named expert, etc.); custody V2 has no partial awards / arbitrary recipients / milestone settlement inside one escrow (whole-escrow only; advanced milestones = separate positions, off-chain invariant). | DONE-IN-SCOPE (as disabled) / DEFERRED-OUT-OF-LAUNCH | None until a later phase; any activation requires profile-specific custody/evidence/adjudication/longstop mechanisms + legal review + owner decision. | Owner decision + legal | No advanced-profile activation path exists; admission rejects it |
| Agreement / evaluator / escrow / anchor bindings | v4 manifest digest (`MANIFEST_FIELDS_V4`, COSE-style envelope + two genuine EOA CommitmentConsent signatures in fixed domain `SAAX Commitment V4`/4) covers policy, profile, custody (chain/address/token/principal/fees/reserve), consents incl. seller timeout, evidenceRequirements, deadlines, fallbackDisposition, parties, evaluator + permitted decisions, price. `verify-v4.js` verifies funding calldata and `getEscrow` term slots (13-slot comparison) + canonical receipt/events/transfer; **anchor binding** implemented: official local EAS attestation with both-party attester authority, exact bytes bound to manifest digest + commitmentId (v4-anchor 38/38 incl. paired positive/negatives). DEMONSTRATED-LOCAL. | DONE-IN-SCOPE (local) | Public deployment identity policy entries (below) before any public chain; verifier legacy hardcode cleanup (`verify-export.js:526,737` chainId) named. | Public deployment identity (D) | Export verified separate-process with anchor bound, at the candidate ceiling, on a public deployment identity entry that has been reviewed |
| Journal association, tamper evidence, completeness limits | v4 journal produced by the closure producer (hash chain only, v4 domain `SAAX Commitment Journal`/4, evidenceDigest bounds outcome refs, intent vs confirmed distinct, relayer vs authorizer distinct) and verified by `v4-journal.js` (37/37; walk 87/87). Association via first-event commitmentId+manifestHash; tamper via hash chain. **Completeness is explicitly NOT established**; pilot binds the journal head off-chain (head-bound). Mainnet pre-settlement journal-head commitment is **undecided** and would require a **new immutable contract** (see §3). | PARTIAL | Owner decision: journal-head commitment for mainnet (yes/no) → if yes, new-contract spec + implementation; producer emission integration into the hosted worker lane (outbox → journal is implemented locally in D3; hosted lane off). | B (owner decision) | Decision recorded; if yes, new contract version spec'd + tested locally before freeze |
| Fulfillment evidence and supported predicates | Phase C implemented: `v4-evidence.js` — schema, agreement-bound evidence domain (`SAAX Commitment Evidence`/4), per-item authenticity (genuine EIP-712), issuer allowlist, sufficiency (type/count/uniqueness/maxAge/deadline), **one supported predicate `hash-equals`** with satisfied/not-satisfied/insufficient findings; refunds verify a failure finding, releases require satisfaction. 22/22 + producer 25/25 + d3-closure exports A/B. Subjective/physical/HVA unsupported by design. | DONE-IN-SCOPE (restricted; one predicate) | None for launch; other predicates are DEFERRED-OUT-OF-LAUNCH. | — | Export verifies with evidence record under the candidate ceiling; unsupported predicates fail INCOMPLETE |
| Dispute must not permit double payout / recipient immutability | Terminal exclusivity (Released XOR Refunded, once), nonReentrant mutex, fixed beneficiaries (timeout → original buyer; mutual → fixed by action), no caller-chosen recipient. Tested T29/T44/T4/T6-T11/T46-T48. | DONE-IN-SCOPE (local) | Independent review confirms. | D | Reviewer disposition |

### 1.2 Worker, signing protection, production wiring

| Requirement | Actual implementation / evidence | Status | Remaining action | Dependency | Completion criterion |
|---|---|---|---|---|---|
| Worker acceptance, concurrency, nonce handling, recovery | D1: durable acceptance (SQLite WAL, ACID), versioned claims, UNIQUE nonce reservations, crash recovery (26/26; cross-process 6×2/2). D2: validate→broadcast→reconcile, PENDING/SUBMISSION_UNCERTAIN/INCLUDED/FINALIZED/REVERTED/BLOCKED, chain-aware nonce init/reconcile, blocking incidents, reorg detection, at-most-once custody effects (40/40). D3: ONE atomic acceptance tx (operation+work+outbox), polling work discovery, outbox journal drain, worker-restart reconciliation, 409 changed-payload (47/47). All local. | PARTIAL (mechanism DONE-IN-SCOPE locally; production wiring absent) | Hosted-lane integration (JSON ledger → SQLite handoff) is documented but **not wired** (`SAAX_INTEGRATED_WORKER` off by default); single-host SQLite WAL assumption; independent worker audit. | B, D | Hosted lane with `SAAX_INTEGRATED_WORKER=1` passes the D3 integration suite on a staging host |
| Fee replacement | Deferred by design: stuck/dropped tx → BLOCKED + incident + report; never recycled, never double-submitted. | DEFERRED-OUT-OF-LAUNCH | Owner accepts BLOCKED+incident posture for canary, or authorizes fee-replacement design. | B | Decision recorded |
| Signed-byte protection and signer isolation | D4A: AES-256-GCM envelope for prepared signed bytes (signed_bytes holds non-executable marker), signing vault bounds (op binding, chain, custody, action, value, fee), fail-closed decrypt only in broadcast path (56/56). D4B: config gates before store/sign/broadcast, complete immutable signing intent, validly-encoded unauthorized verdict rejection (EVALUATOR_MISMATCH, ESCROW_BINDING_MISMATCH, threshold-below), env-separation runtime probe (API process has no key path) (101/101 at E1 closure). PARTIAL for production: remote/HSM/KMS signing not implemented; host-level isolation (separate OS account/container, secret manager) pending. | PARTIAL | Secret-manager/KMS provisioning + host isolation (C); independent review of signer/envelope design (D). | C, D | A production worker boots with keys from a secret manager, no key in route-process env, D4A/D4B suites green on that configuration |
| Real production signer/provider integration and provisioning | Real Safe 1.4.1 singleton + proxy + factory + fallback handler + threshold governance exercised on local EVM (phase3b, 17/17 real-Safe harness); external-signer reference server is a synthetic adapter refusing non-local execution. Production Safe wiring in hosted worker, provider provisioning (archive RPC with safe/finalized tags, multiple providers), key custody: NOT provisioned. | NOT-STARTED (production) | Provider/RPC provisioning + Safe deployment config + secret manager (C); production governance wiring | C | Provisioned endpoints verified (tags, archive, disagreement pairs); productio Safe owners/threshold configured + monitored |
| Safe configuration/governance provenance and recovery | Approved 2-of-3 governance provenance is **NOT established** by successful ERC-1271 execution (explicit across phase3b/check-map/E1B). Historical ERC-1271 method binds successful canonical direct-call execution through the allowlisted immutable runtime (same-block governance ordering tested); Safe owner/threshold snapshot-at-verdict-block historical verification is **specified, not implemented** (owner-snapshot reads). | PARTIAL | Independent governance provenance review; owner-snapshot verifier implementation if Safe route approved. | D, B | Reviewer-approved governing-document set for owners/threshold; snapshot verification implemented + tested |

### 1.3 Finality, RPC, reproducibility, ops, review, launch

| Requirement | Actual implementation / evidence | Status | Remaining action | Dependency | Completion criterion |
|---|---|---|---|---|---|
| Funding and settlement finality (separately) | Funding + settlement transactions are the required coverage set. E1A–E1D finality stack: trusted-config policy (local-synthetic / op-stack-safe / op-stack-finalized), SAFE never FINALIZED, no fallback, bounded ancestry (default 256) AND trusted-RPC method (no ancestry walk; identity + canonical membership + tagged-head coverage + head-binding rechecks + request budget). Base Sepolia read-only observations: 4/4 committed hashes canonical members; E1D **SAFE 4/4 and FINALIZED 4/4** for the funding/settlement txs under the trusted-RPC method; bounded-ancestry method reports BOUND_EXCEEDED for the same deep history (unchanged, not widened). TESTNET-DEMONSTRATED (read-only component positives). | DONE-IN-SCOPE (component; activation blocked) | Mainnet 8453 blocked under supported-network policy (`FINALITY_MAINNET_NOT_ACTIVATED`); operator activation of method+policy (`SAAX_V4_FINALITY_METHOD=trusted-rpc`, `SAAX_V4_FINALITY`; worker `SAAX_FINALITY_METHOD/POLICY`), archive RPC provisioning, finality-policy approval. | B, C | Owner-approved policy; configured operator env passes a read-only Base-mainnet observation (no writes) |
| **Anchor finality (separate axis)** | **NOT ESTABLISHED.** The E1D/E1C observations record **two cid/digest anchor references** (identifiers only: `refunded.commitment` / `disputed.commitment`). There is **no EAS attestation transaction receipt** (uid, txHash, blockHash, receipt, blockNumber) for any anchor in the finality observations or anchor refs. The observed finality rows cover the escrow funding/settlement transactions only. Anchor verification exists only under the pinned local-official-EAS policies (31337 local; 84532 historical local-evidence), which authorize no public deployment. **Exact remaining evidence required:** (1) a public EAS attestation transaction (or the decision to operate without an on-chain anchor) with canonical receipt/block + Attested event + uid/schema/attester binding to the agreement digest; (2) that anchor tx covered by the required safe/finalized head under the approved policy + trusted-RPC method; (3) a public deployment identity policy entry for the EAS deployment used (see below). This does not claim funding/settlement finality work is undone — that axis is complete at the component level. | BLOCKED | Owner decision: on-chain anchor or not for launch; EAS deployment identity entry; then attestation + finality observation on the public chain. | B, C, D | Anchor tx receipt with finalized-head coverage on the target chain, verified separate-process under a reviewed deployment identity entry |
| Public custody/EAS deployment identity policies | Repository-owned identity policy exists: `v4-candidate-identity.json` / `v4-candidate-identity-31337.json` (runtime hash pinned), `v4-eas-policy.json` (`{ default, policies }` — 84532 historical local-evidence entry byte-identical + explicit LOCAL-TEST-ONLY 31337 entry). **No public Base Sepolia or Base mainnet custody/EAS entry exists; no trust-any-deployment flag.** A lifecycle export claiming public 84532 identity is rejected INCOMPLETE (focused negative). | PARTIAL (framework exists; no public entries) | Public deployment identity review; add reviewed entries for the actual public deployments (custody address, EAS/registry addresses, runtime hashes) once deployments exist. | E (deployment), D | Reviewed identity entries for the deployed public contracts; exports verify under those entries |
| RPC capability requirements and disagreement handling | Capability requirements documented (archive for deep `eth_getCode`/`eth_call`, `eth_getBlockByNumber` tags+hex+hash, `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_chainId`). Disagreement handling implemented: `observePublicHead` two-actual-conflict → RPC_DISAGREEMENT; head-binding rechecks (HEAD_BINDING_CHANGED / HEAD_REGRESSED); bounded retries/request budget; advancing head is not a reorg. Provider provisioning (multiple independent providers) is operational, not code. | PARTIAL | Provision ≥2 independent archive-capable providers with tag support; verify disagreement path on the target chain. | C | Providers provisioned; a two-provider conflict test on testnet exhibits RPC_DISAGREEMENT |
| Runtime / build / dependency reproducibility | Phase3B: `scripts/check-phase3b-clean.cjs` fresh-folder `npm ci` + pinned solc 0.8.26 + Safe 1.4.1 + Hardhat 2.22.4; clean-install evidence committed; artifact identity records ABI/source SHA-256/settings/runtime keccak. **Input gap:** the custody build artifact historically **lacks embedded compiler metadata** (readiness G2); candidate not frozen; production bytecode-equivalence not claimed. | PARTIAL | Freeze candidate commit; add embedded compiler metadata; reproducible rebuild of the frozen artifact with hash match. | A | `check-phase3b-clean` pattern on the frozen commit reproduces the artifact byte-for-byte; metadata embedded |
| Persistent storage, backup/restore, monitoring, incident response, shutdown | Persistence: SQLite WAL store (D1–D3) + durable acceptance + recovery harness; archival Postgres schema (`data/day17_escrow_durable.sql`) exists with atomic RPCs. Backup/restore **drill not demonstrated** (readiness G7). Monitoring/incident/shutdown: runbook content specified in readiness D.4–D.5 (kill switch stops intake; cannot halt custody; direct deposits documented); no committed drill evidence. | PARTIAL | Backup/restore drill committed; monitoring live (balances/liabilities, pending intents, disputes+age, evaluator activity, store errors, chain/RPC health); incident runbook exercised. | C | Drill report + alert ownership + runbook exercised |
| Independent review/audit and remediation | None exists. `audit/custody-review-phase5.md` is the vendor's own review **prepared FOR** an external reviewer, explicitly not an audit (records permanent-lock scenario etc.). `design-review-brief.md` commissioning packet updated at Phase F1 (see §4). No external reviewer contacted, no engagement. | NOT-STARTED | Commission per §4 under authorization; remediation + disposition; reviewer re-verify. | D (spend authorization) | Findings report with severities + disposition table + remediation commits; zero open critical/high |
| Exposure limits, agreement/legal completion, participant disclosures | V2 candidate **enforces on-chain** per-position + aggregate caps (`perPositionCap`/`aggregateCap`/`totalHeld`; constructor requires positive caps when funding enabled) — mechanism DONE-IN-SCOPE locally; **numeric values are an owner activation input**. Agreement template + addendum exist (gaps: governing law/forum/institutional rules, legal review pending). Participant disclosures drafted in readiness D.9; mainnet disclosures not reviewed. | DONE-IN-SCOPE (mechanism) / PARTIAL (values, legal) | Owner sets caps; legal review of addendum + disclosures. | B, legal | Caps set in the deployed candidate config; reviewed disclosures shipped with onboarding |
| Deployment authorization, source/bytecode verification, restricted canary | Not started: no deployment authorization (G11), no deployed-artifact bytecode/config verification (G12), no restricted real-fund canary (G13), no expansion (G14). Final-candidate testnet lifecycle rehearsal on the exact frozen artifact (G9) not re-run since freeze (historical testnet flows exist on prior artifacts). External testnet pilot prepared, **not sent**, requires a named external buyer (separate authorization). | NOT-STARTED | G9 rehearsal (testnet, frozen artifact) → G11 authorization → G12 independent verification → G13 canary → G14 expansion. | B, C, D, E | Canary positions funded→terminal with receipts/events/token movements/export verification within limits; expansion only on evidence |

---

## 2. Finality-by-component status (what is done vs not)

| Component | Status | Evidence |
|---|---|---|
| Funding/settlement finality (component) | DEMONSTRATED (testnet read-only; SAFE 4/4, FINALIZED 4/4 via trusted-RPC method; bounded-ancestry BOUND_EXCEEDED for deep history by design) | `evidence/e1d-sepolia-trusted-finality.json`, `evidence/e1c-sepolia-membership.json`, `evidence/e1b-sepolia-observation.json` |
| Anchor finality | **NOT ESTABLISHED** — only cid/digest refs; no EAS attestation receipt | same observations (anchorRefs = 2 identifiers) |
| Mainnet activation | BLOCKED under supported-network policy (`FINALITY_MAINNET_NOT_ACTIVATED`) | `mainnet/design/support/supported-networks.js` |
| SAFE vs FINALIZED labeling | Correct everywhere; SAFE never labeled consensus-finalized | E1A/E1B/E1C/E1D docs + tests |

---

## 3. Design-vs-implementation conflicts and material unresolved decisions

### 3.1 Resolved conflicts (decided with evidence)

1. **Local EVM chain identity.** 84532 was overloaded (local EVM vs Base Sepolia); resolved by moving the local EVM to 31337 (`chain-identity-resolution.md`, adopted; `hardhat.config.js` 31337; e1-closure supported-network policy; local chain never public). Historical 84532 local-evidence fixtures preserved byte-identical.
2. **Journal binding model for the pilot.** v4-journal-schema-decision: pilot = hash-chain-only, **no signing-time journal-root binding** (head-bound via first-event commitmentId+manifestHash). Adopted. Zero fixture regeneration.
3. **Evaluator mechanism direction.** V2 candidate implements the **Safe+ERC-1271** route (signature container; Safe enforces its own 2-of-3 threshold). MPC threshold remains the documented alternative. Direction chosen; final production selection + security review still an activation input.
4. **Dispute liveness.** Candidate closes the V1 permanent-lock scenario via final-cutoff timeout refund including Disputed — the Phase-1 "secondary exit" question is implemented for the restricted profile.

### 3.2 Open design-vs-implementation questions (must be decided, not assumed)

| # | Question | Current state | Tradeoffs | Needs |
|---|---|---|---|---|
| Q1 | Is an **on-chain pre-settlement journal-head commitment** required for the selected launch profile? | **Undecided for launch.** v4-journal-schema-decision §8 recommends the settlement-time pre-settlement-head commitment for mainnet; the pilot stays head-bound. The existing V2 candidate **does not implement it**. | Committing the pre-settlement head on-chain anchors journal state up to settlement (association + tamper evidence at the cost of a new immutable contract + more calldata + review). Not committing keeps the current contract but leaves journal association off-chain (head-bound; completeness still needs fixed-transition-set or checkpoint rules either way). | Owner decision + (if yes) new-contract spec, implementation, tests, review |
| Q2 | Does the existing custody candidate implement the selected requirement set? | The candidate implements the restricted OBJECTIVE_DIGITAL profile as of the Phase 3A mandate (finalCutoff, mutual, timeout incl. disputed, caps, fundingEnabled, policy/agreement binding, ERC-1271 evaluator container, whole-escrow only). **Divergences from the design doc:** (a) contract gates evaluator/mutual by cutoff only — the **resolution deadline is enforced by the verifier**, not the contract; `resolve:*` and mutual paths do not enforce `minReleaseTime`; (b) global `usedMutualNonce` space instead of per-escrow (reviewer question raised in Phase 3A); (c) terminal-state replay rejection by state, not by nonce. | Tighten contract vs verifier-only: putting the resolution deadline + minReleaseTime in the contract is a **new immutable version** and disqualifies the candidate unless re-frozen; accepting verifier-enforced bounds is cheaper but leaves on-chain execution-time enforcement narrower than the signed agreement. | Owner decision Q1/Q4 + independent review opinion |
| Q3 | What requires a new immutable contract version? | (1) Settlement-time pre-settlement journal-head commitment (Q1=yes). (2) Contract-enforced resolution deadline / minReleaseTime on resolve+mutual (Q4=yes). (3) Any change to funded positions — never (immutable; no migration). (4) Future caps changes on a deployed candidate — new deployment (caps immutable at construction). The candidate itself is a **new deployment** vs V1 (breaking ABI: `bytes` verdict container, extra fields). | Each new version = new deployment + full retest + review; preserves old positions. | Owner decisions Q1/Q4; freeze discipline |
| Q4 | Which launch controls are **contract-enforced** vs **service/operator-enforced**? | **Contract-enforced (candidate):** no admin/withdraw, immutable, safe-transfer exact-delta, digest/policyId/policyDigest/agreementRef binding at fund, per-position + aggregate caps + totalHeld, fundingEnabled intake gate (exits always open), fixed beneficiaries, cutoff rules (AfterCutoff), verdict/mutual authorization + nonce replay, terminal exclusivity, reentrancy mutex. **Service/operator-enforced (not contract):** admission allowlist, party eligibility, chain guard (`verifyOnChain` refuses ≠84532), worker execution + reconciliation + finality labeling, monitoring/alerts, kill switch (intake only; **cannot freeze custody or stop direct deposits** — direct `fund` calls bypass the app by design and must be monitored), deployment identity allowlists (verifier policy), key custody. | Contract-enforcement is absolute but frozen at deployment; service-enforcement is flexible but bypassable by direct chain calls. The candidate already pushes the hard limits on-chain; the remaining question is whether any *additional* control (journal head, resolution deadline) must move on-chain. | B (owner), D (review) |
| Q5 | Finality method + policy for launch | Trusted-RPC method + `op-stack-finalized` policy is the technically demonstrated choice on Base Sepolia (SAFE + FINALIZED positives; deep-history capable, no ancestry walk; documented trust model). Activation is operator env; mainnet blocked by supported-network policy until authorized. `op-stack-safe` is strictly weaker (SAFE ≠ FINALIZED). | trusted-rpc/finalized is stronger but trusts the provider's consensus-status assertions (documented); bounded-ancestry is conservative but BOUND_EXCEEDED on deep history; safe-only is insufficient for launch. | B + C (provisioning) |

Other unresolved items (recorded, not invented): numeric caps; mainnet USDC address pinning; Safe production owner/threshold identity + independence; governance/snapshot verifier; legal (governing law/forum) + disclosure review; fee-replacement posture; worker lease/multi-host store if scaled; global-vs-per-escrow mutual nonce (reviewer input); host-level key isolation; audit provider selection.

---

## 4. Independent review scope (commissioning brief updated around the actual candidate)

The commissioning brief `mainnet/design/design-review-brief.md` is updated (Phase F1 addendum) to scope around the **actual** candidate at HEAD `86061976`. Required reviewer coverage (contracts + integration):

1. **Custody candidate** `contracts/SAAXEscrowCustodyV2.sol`: accounting/conservation, terminal exclusivity, checks-effects-interactions, safe-transfer handling, caps/totalHeld, fundingEnabled gate, cutoff semantics, verdict/mutual authorization, ERC-1271 evaluator container (Safe path) + ecrecover (EOA path), replay guards (global verdict nonce, global mutual nonce), resolve:hold + cutoff interplay, minReleaseTime coverage, dispute paths.
2. **Signer/encryption architecture**: `worker/signing-vault.js`, `worker/prepared-vault.js` (AES-256-GCM envelope, AAD context, key delivery), `worker/d4*.js`, config gates, complete signing intent, env/separation boundaries (API process has no key path), external-signer adapter honesty.
3. **Safe/governance dependencies**: Safe 1.4.1 + proxy/factory/fallback handler pinned locally; owner/threshold governance; the explicit limitation that ERC-1271 success does not establish approved governance; historical owner-snapshot verification approach (specified, not implemented).
4. **Recovery/finality assumptions**: worker state machine (D1–D3), at-most-once property, nonce handling, crash boundaries, reorg handling, finality trust model (trusted-RPC consensus-status assertion; not consensus reconstruction), SAFE≠FINALIZED labeling.
5. **Journal/evidence/anchor**: v4 journal (association + tamper, not completeness), evidence `hash-equals` predicate, EAS anchor binding + attester authority (local), the missing on-chain anchor-finality axis.
6. **Known limitations and unresolved decisions**: §3 list; the candidate is not frozen, not audited, not deployed.
7. **Required reviewer deliverables**: findings report with severities (critical/high/medium/low) + disposition table (fixed / won't-fix with rationale) + remediation verification; re-check of the changed code paths after remediation; post-deployment bytecode/config verification procedure per readiness C.4 stage 5.
8. **Explicit exclusions**: x402 immediate-payment gateway, website content, OS/host security, third-party contract internals (USDC, EAS, Safe) as trust assumptions with pinned addresses/versions.

**Work that must finish before a meaningful release-candidate freeze:**
- Owner decisions Q1 (journal head), Q4 (resolution-deadline/minReleaseTime contract enforcement), and the economic/caps/evaluator/legal inputs (B).
- Freeze candidate + embedded compiler metadata + reproducible build (A).
- Re-run the full suite set on the frozen candidate (G3), not HEAD drift.
- Either close or explicitly freeze the verifier-vs-contract divergences (Q2) so review targets one behavior.
- Hosted-lane worker wiring decision (assess the D3 integration as part of the candidate scope or defer).
- Named RPC provider + Safe production config inputs.

Do not call the current moving implementation audited or frozen. No auditor outreach, no paid engagement, no fabricated quotes — this scope is the commissioning packet, not an engagement.

---

## 5. Shortest remaining path (ordered, with completion criteria)

### A. Engineering Lucius can perform locally now (no new authorization)

1. **Freeze a release-candidate commit** + add **embedded compiler metadata** to the build artifact (readiness G2). Criterion: `scripts/_build-custody.cjs` (or frozen variant) embeds metadata; artifact rebuilds byte-identical; hash recorded in `verifier/v4-candidate-identity*.json`-style policy.
2. **Re-run all suites on the frozen candidate** (G3): test-custody-v2 (51), D1 (26), D2 (40), D3 (47), D3-action-auth (28+), D4A (56), D4B (101), E1A–E1D, v4 producer/journal/evidence/anchor, admission (40), chain-guard (9). Criterion: all green on the frozen commit; results committed; no suite run against drifting code.
3. **Resolve Q1/Q4 design specs for owner decision** (new-contract journal-head spec; resolution-deadline/minReleaseTime enforcement options) — documentation only, no implementation before approval. Criterion: decision docs with tradeoffs, no code.
4. **Hosted-lane worker integration plan** (JSON ledger → SQLite handoff migration; `SAAX_INTEGRATED_WORKER` rollout; monitoring spec; incident runbook; participant disclosure text; backup/restore drill design). Criterion: docs reviewed, drills designed.
5. **Read-only Base mainnet capability survey** (no writes): RPC tags/archive verification, head positions, EAS deployment address verification, USDC address verification. Criterion: capability matrix + addresses verified, recorded as observations.
6. **Commissioning packet finalized** (this doc + updated design-review-brief) referencing the frozen commit. Criterion: packet self-contained.

### B. Owner decisions and economic parameters
1. Exposure caps numeric values (per-position, aggregate) — candidate enforces on-chain.
2. Evaluator mechanism selection confirmed (candidate: Safe+ERC-1271; alternative: MPC) + owner/threshold independence.
3. Q1 journal-head commitment (yes/no).
4. Q4 resolution-deadline/minReleaseTime enforcement (contract vs verifier).
5. Finality method + policy approval (recommendation: trusted-rpc + op-stack-finalized).
6. Mainnet USDC address + token whitelist pinning.
7. Legal review of addendum + disclosures (qualified legal; governing law/forum).
8. Canary limits + initial admission list.
**Criterion:** signed decision log covering D1–D9-equivalent + Q1/Q4 + caps + legal inputs.

### C. Provider provisioning / cost authorization
1. Archive-capable RPC with safe/finalized tags (≥2 independent providers).
2. Hosting + Postgres/PostgREST (self-hosted) + backup storage.
3. Secret manager/KMS for relayer key + prepared-key delivery + rotation.
4. Production Safe deployment config (singleton/owners/threshold) if Safe route.
**Criterion:** endpoints provisioned and verified against A.5 matrix; keys delivered without route-process access.

### D. Independent review
1. Commission design/security review (contract + integration + signer + governance + recovery/finality per §4) once A.1–A.4 and B are settled and the candidate is frozen.
2. Remediation + disposition table.
3. Reviewer re-verification.
**Criterion:** findings report + disposition; zero open critical/high; medium/low dispositioned.

### E. Deployment authorization
1. G11 owner authorization (deploy + initial limits + escrow-backed off until authorized).
2. G12 independent bytecode/config verification pre-funding (on-chain code hash == artifact; chain/custody env verified; no escrow-backed flag beyond scope).
**Criterion:** authorization recorded; verification report committed.

### F. Separately authorized funding / canary
1. G9 final-candidate testnet lifecycle rehearsal against the **exact frozen artifact** (existing historical testnet flows re-run on the frozen candidate).
2. G13 restricted real-fund canary within limits; G14 expansion only on evidence.
**Criterion:** canary positions complete funded→terminal with receipts, events, token movements, and separate-process export verification; expansion authorized per evidence.

External participant validation is **separate** from internal engineering: the external testnet pilot (validating an external buyer with their own keys) is optional-but-recommended between D and E and needs separate outreach authorization plus a named external buyer. Its absence must not block A–D.

---

## 6. Final status

- **The candidate is ready for neither a release audit nor an independent design review as a frozen artifact** — a meaningful independent review can only be commissioned after the owner decisions (§3) and freeze work (§5A.1–A.4) settle the target behavior, and the candidate is currently moving (35 local commits ahead of origin/main; uncommitted working-tree changes preserved).
- **It IS ready for internal design review of the settled pieces** (the Phase F1 scope documents: custody V2 candidate, v4 verifier, worker, signer envelope) — that is what §4 commissions.
- Claims not made: no audit exists; no freeze exists; no public deployment identity exists; anchor finality is NOT ESTABLISHED; mainnet remains blocked under the supported-network policy; passing tests do not establish security.

*End of Phase F1 gap assessment.*