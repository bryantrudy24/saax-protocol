# Reviewer Handoff — Independent Review Package: SAAX Custody V3 (F3B)

**Status: OWNER-APPROVED baseline for independent review.** This handoff assembles the
input an independent reviewer needs. The package itself is immutable; this document is a
navigation aid. It does not constitute an audit, a readiness claim, or a deployment
authorization.

---

## 1. Package identity (owner-approved, 2026-11-06)

| Item | Value |
|---|---|
| Manifest | `review/f3c-candidate/10-review-snapshot-manifest.json` |
| Manifest SHA-256 | `920ddff847c96f6a97fadd326a19f3172c580b1d0074c3c279b7a82f7bb1abf0` |
| Archive | `review/f3c-candidate/snapshot/saax-custody-v3-review-snapshot-ea0562b5.tar.gz` |
| Archive SHA-256 | `bfecfd1b0fa6948621ba7683f5849cba7c308b6de956bacb6726f1bbff660781` (41,707,398 bytes) |
| Preparation commit | `ea0562b52003cbd63e3bd731227a49f85b875470` (ancestor of main `b33b3073`) |
| Candidate source | `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8` — `contracts/SAAXEscrowCustodyV3.sol` |
| Test/evidence revision | `7c26838b7709366ae032ccf6f80971692589ee37` |
| Candidate runtime pin | keccak `0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3` |
| Manifest entries | 78 (source 1, artifact 3, build 8, components 13, identity 10, harnesses 7, evidenceCand 18, evidenceOther 18) |

The archive is a `git archive` of the preparation commit (22,819 files including locked
dependencies). The manifest hashes are over the **git blob (LF) bytes**; on Windows,
compile from `git show <rev>:<path>` (or set `core.autocrlf false`) — see §6.

## 2. What the reviewer receives (exact snapshot scope)

- **Source (1)** — `contracts/SAAXEscrowCustodyV3.sol`, pinned.
- **Artifact (3)** — `data/escrow-custody-v3-build.json` + creation/runtime bytecode files.
- **Build (8)** — compiler settings, F3A/F3B build manifests, reproducibility records.
- **Components (13)** — endpoint, worker (d1-d3), verifier, journal, evidence, anchor,
  signatures, durable stores.
- **Identity/policies/config docs (10)** — candidate identity JSONs, EAS policy, supported
  networks, chain-identity resolution.
- **Candidate harnesses (7)** — the six exact-candidate test suites + build/reconcile scripts.
- **Candidate-lane evidence (18)** — v4 exports (7 outcomes), contention, boundary, real-Safe.
- **Historical/supporting evidence (18)** — F3A lane, phase3b/3c exports, provenance records.

Excluded by design: the manifest's own checksum and preparation-commit files (circular-hash
avoidance); node_modules (lockfile is the dependency identity); all secrets (none in any
commit — verified); synthetic fixtures (MockUSDC, local EAS 1.7.1, real Safe 1.4.1) labeled
as such; unrelated dirty working-tree changes.

## 3. Reviewer instructions (authoritative)

`review/f3c-candidate/05-reviewer-instructions.md` is the authoritative how-to-verify doc.
Key points:

1. `git rev-parse HEAD` must equal `2e49625b` (candidate revision); the package commit
   `ea0562b5` is its child and must exist.
2. `node scripts/_f3c-reconcile-runtime.cjs` — both lane hashes must equal the tables in
   `02-build-facts.md` and the pins above.
3. Re-run any suite: `scripts/test-v3-integrated-flow.cjs` (26), `test-f3c-two-worker-contention.cjs` (14),
   `_f3c-v4-export-producer.cjs` (22), `test-custody-version-dispatch.cjs` (11),
   `test-custody-v3-realsafe-candidate.cjs` (46), `test-custody-v3-candidate-boundary.cjs` (161).
4. F3A-target suites deploy **paris** bytecode (behavioral oracle only) — NOT candidate-object
   coverage; see `03-coverage-matrix.md`.
5. Section 6 of the instructions: **do NOT treat category A (hash match) as categories B–E.**

The full re-validation record (this session's reproduction, 280/280 + 23/23 checkpoint
binding, fresh `npm ci` at `ea0562b5`) is in `12-current-state-and-reproducibility.md` and
`evidence/2026-11-06-rerun/`.

## 4. Review scope of record (what the independent reviewer must examine)

From `mainnet/design/design-review-brief.md` (Phase F1 addendum) and
`mainnet/release-candidate-gap-assessment.md` §4, the scope covers:

1. **Custody candidate** — accounting/conservation, terminal exclusivity, CEI order,
   safe-transfer handling, caps/totalHeld, fundingEnabled gate, cutoff semantics,
   verdict/mutual authorization, ERC-1271 evaluator container + ecrecover EOA path,
   replay guards (global verdict nonce, global mutual nonce), resolve:hold + cutoff
   interplay, minReleaseTime coverage, dispute paths.
2. **Signer/encryption architecture** — `worker/signing-vault.js`, `worker/prepared-vault.js`
   (AES-256-GCM envelope, AAD context), `worker/d4*.js`, config gates, complete immutable
   signing intent, env/separation boundaries.
3. **Safe/governance dependencies** — Safe 1.4.1 + proxy/factory/fallback handler pinned;
   the explicit limitation that ERC-1271 success at execution point does **not** establish
   approved governance; historical owner-snapshot verification is specified, not implemented.
4. **Recovery/finality** — worker state machine (D1–D3), at-most-once property, nonce
   handling, crash boundaries, reorg handling, finality trust model (trusted-RPC
   consensus-status assertion; SAFE ≠ FINALIZED; no fallback).
5. **Journal/evidence/anchor** — hash-chain association + tamper evidence (not completeness),
   `hash-equals` predicate, EAS anchor binding (local), the missing on-chain anchor-finality axis.
6. **Verifier** — `verify-v4.js` version dispatch, runtime identity assertion at settlement
   block, recomputed journal prefix triple-binding, receipt-extension enforcement.
7. **Known limitations and unresolved decisions** — findings register
   `13-known-findings-register.md` (F-1…F-16) and gap assessment §3 (Q1, Q2, Q4, Q5).

## 5. Questions the reviewer must answer (open items, carried into review)

From `13-known-findings-register.md` ([NEEDS REVIEW] items) and `12-current-state…` §8:

- **F-6/§8.8 — Authorization timing:** is execution-point authorization (canonical direct-call
  success as execution witness, ERC-1271 Safe check at execution point) sufficient for the
  intended assurance level, or is post-block governance-state (owner/threshold snapshot)
  verification required? What happens if governance changes between signing and execution?
- **F-8 — Authorization timing (same-block):** is the demonstrated same-block ordering
  (release → changeThreshold → release2: first paid, second reverted) robust against
  reorg/rollback and mempool ordering differences on a public chain?
- **F-9 — Token handling:** are the exactly-once payout assumptions (balance deltas vs.
  transfer amounts) sound for standard tokens only? Is a token whitelist required for
  fee-on-transfer/rebasing/pausable tokens?
- **F-10 — Reentrancy:** confirm CEI order in every transition and that no external call
  precedes state writes that could re-enter.
- **F-11 — Replay protection:** are escrow-scoped nonce classes for verdict/mutual, the
  checkpoint head commitment, and chainId binding sufficient against cross-chain replay?
- **F-12 — Dispute liveness:** do any configurations permit permanent lock of funds
  (RDL==CUT equality tested; the economic consent for that case is owner-approved Option A)?
  Is the deadline vs finalCutoff gap semantics sound (the most important design question —
  see `design-review-brief.md` §9.1)?
- **F-13 — Crash recovery:** is the durable-worker at-most-once guarantee (two-worker
  contention 14/14, crash-after-broadcast reconciliation) sufficient? Residual: public-chain
  reorg mid-recovery, journal corruption/fsync semantics on production stores.
- **F-7 — Anchor finality:** is operating with `VERIFIED_WITH_LIMITATIONS` (no public EAS
  attestation receipt) acceptable for the intended assurance level, or is an on-chain anchor
  required?

Plus the commissioning brief's §9 design questions (deadline-vs-cutoff dead window, mutual
window bound, resolve("hold") at/after cutoff, on-chain caps necessity, v4 field-set
completeness, buyer consent inclusion, COSE_EIP-712 dual-scheme ambiguity, MPC-vs-Safe
aggregate-key strength) and §7 (contract-wallet signature, verifier recording of signer
mechanism, EIP-1271 vs v4 schema, three signature domains' disjointness, historical
verification under owner-set change, admission-gate bypass).

## 6. Reproducibility caveats (recorded, not defects)

- **CRLF:** Windows `git checkout` converts the .sol to CRLF; manifest hashes are over the
  LF blob. Compile from `git show` bytes (or `core.autocrlf false` / `.gitattributes`).
  F3B recompile from blob bytes reproduces creation `0x58a83b0e…` and runtime
  `0x87615e3d…` byte-identically (this session, fresh `npm ci`, 797 packages).
- **F3A vs F3B hashes:** F3A manifest records SHA-256 digests; F3B records keccak256 of the
  same deployed object — different digest functions over identical bytes, hence different
  strings (reconciled in `02-build-facts.md` / `mainnet/f3c-status.md` §2).
- **Test provenance:** the 46/46 and 161/161 harnesses first ran on uncommitted bytes;
  committed copies are byte-identical and this session re-ran all 280/280 from the pinned
  commit (identity asserted pre-behavior). Historical record retains its original caveat.

## 7. Required reviewer deliverables (from the commissioning brief §F)

1. Findings report with severities (critical/high/medium/low) and location refs.
2. Disposition table: fixed / won't-fix with rationale for every finding.
3. Remediation verification: re-check of every changed code path after fixes.
4. Post-deployment bytecode/config verification procedure (on-chain runtime code hash ==
   artifact; chain/custody env; escrow-backed off until authorized).
5. Explicit statement of what the review does NOT cover (x402 lane, website, OS/host,
   third-party internals as trust assumptions) and residual risks (key custody, token
   behaviors, RPC trust, Safe governance).

## 8. Assurance ceiling

- Passing tests establish **conformance, not security**; no audit exists.
- Export ceiling is `VERIFIED_WITH_LIMITATIONS` (`noPublicFinality: true`); no public
  deployment identity entries exist; mainnet activation is BLOCKED under supported-network
  policy; deployment compatibility (84532/8453) is **NOT ESTABLISHED** — local Cancun
  (31337) only.
- This package and its approval change none of that.

---
*Handoff prepared by the station overseer (Lucius Fox), 2026-11-06, from the owner-approved
baseline. Owner approval record: `OWNER-APPROVAL-RECORD.md`.*