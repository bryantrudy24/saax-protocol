# OWNER APPROVAL REQUEST — Independent-Review Snapshot: SAAX Custody V3 (F3B)

**Status: PROPOSAL ONLY — NOT APPROVED, NOT FROZEN.**
This document requests ONE decision from the owner (Commander). It does not freeze, approve deployment, authorize funding, or constitute an audit. Nothing was deployed, funded, or published.

---

## 1. The decision requested

> **Approve the local immutable review snapshot defined by `review/f3c-candidate/10-review-snapshot-manifest.json` (SHA-256 `920ddff847c96f6a97fadd326a19f3172c580b1d0074c3c279b7a82f7bb1abf0`), candidate source `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8`, package/preparation commit `ea0562b52003cbd63e3bd731227a49f85b875470`, runtime pin `0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3`, archive `review/f3c-candidate/snapshot/saax-custody-v3-review-snapshot-ea0562b5.tar.gz` (SHA-256 `bfecfd1b0fa6948621ba7683f5849cba7c308b6de956bacb6726f1bbff660781`), for INDEPENDENT REVIEW ONLY — with no freeze tag, no deployment, no public-chain write, no spending, and Categories D/E plus the verifier execution-witness limitation retained as open.**

Decision: [ ] APPROVE snapshot for independent review   [ ] REQUEST CHANGES (state what)

---

## 2. Why this candidate

- **Only one custody review candidate exists in the repo**: Custody V3, F3B/Cancun build object (deployed runtime keccak `0x87615e3d…`; source sha256 `9bd413ac…`; solc 0.8.26, optimizer 200, viaIR, evmVersion omitted → Cancun).
- It is **clearly distinct** from the deployed testnet Custody V1 (`0x0897dba0…` on Base Sepolia 84532) and from the local V2 lane (`0x914a74bc…`). The V3 source is unchanged from F3A `c7150105` through the package HEAD (empty diff — verified).
- Exact-candidate coverage is complete on the pinned object: integration 26/26, contention 14/14, v4 exports 22/22, version dispatch 11/11, **real-Safe ERC-1271 + same-block governance 46/46**, boundary/invariant 161/161 — **280/280 reproduced from committed bytes in this session** (plus checkpoint-binding 23/23).
- The manifest pins every included file at its committed revision; all pins are ancestors of main; no snapshot file drifted at HEAD (only `package*.json` gained the unrelated `jose` dep after the preparation commit).

## 3. Snapshot identity (all from this session's verification)

| Item | Value |
|---|---|
| Candidate source revision | `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8` |
| Test/evidence revision | `7c26838b7709366ae032ccf6f80971692589ee37` |
| Preparation commit (snapshot identity) | `ea0562b52003cbd63e3bd731227a49f85b875470` |
| Manifest path + SHA-256 | `review/f3c-candidate/10-review-snapshot-manifest.json` → `920ddff8…` (recomputed == recorded) |
| Archive path + SHA-256 | `review/f3c-candidate/snapshot/saax-custody-v3-review-snapshot-ea0562b5.tar.gz` → `bfecfd1b…` (41,707,398 B; `git archive` of `ea0562b5`; 22,819 files incl. locked deps) |
| Runtime pin (keccak) | `0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3` |
| Manifest entries | 78 — all resolved at pinned revisions, hashes match (0 mismatches), integrity block OK |
| Repro | fresh `npm ci` (797 pkgs) + F3B recompile from blob bytes → artifact byte-identical, runtime == pin |

## 4. Included scope

Per manifest groups: source (1), artifact (3), build (8), components (13: endpoint/worker/verifier/journal/evidence/anchor/signatures), identity/policies/config docs (10), candidate harnesses (7), candidate-lane evidence (18), historical/supporting evidence (18). Sanitized working-tree copies under `review/f3c-candidate/evidence/`; generator `scripts/_review-hash-manifest.cjs`; re-validation script `scripts/_validate-snapshot-current.cjs`; this session's transcripts under `evidence/2026-11-06-rerun/`; this request + the findings register + current-state doc.

## 5. Exclusions

- Manifest's own checksum + preparation-commit files (circular-hash avoidance; documented).
- node_modules/dependency dirs exist in the archive (full-tree archive) but are NOT part of the manifest's hash coverage; lockfile is the identity for deps.
- Secrets: none in the committed tree (verified via `git grep`); private JWKs exist only on disk, never in any commit (prior full-history scan). `.env.example` only.
- Unrelated dirty working-tree changes: preserved, excluded from the snapshot.
- Synthetic fixtures (MockUSDC, local EAS 1.7.1, real Safe 1.4.1 singleton) are labeled as such.

## 6. Test results (this session, isolated worktree at `ea0562b5`)

| Suite | Result |
|---|---|
| test-v3-integrated-flow | **26/26** |
| test-f3c-two-worker-contention | **14/14** |
| _f3c-v4-export-producer | **22/22** |
| test-custody-version-dispatch | **11/11** |
| test-custody-v3-realsafe-candidate | **46/46** |
| test-custody-v3-candidate-boundary | **161/161** |
| test-f3c-checkpoint-binding | **23/23** |
| F3B rebuild from blob bytes | creation `0x58a83b0e…` / runtime `0x87615e3d…` — **match artifact + pin** |

## 7. Unresolved findings (summary — full register: `13-known-findings-register.md`)

- **F-3 (Category D)**: deployment-target compatibility (84532/8453) NOT ESTABLISHED — local Cancun only.
- **F-4 (Category E)**: no independent review completed; production prerequisites (signer isolation, Safe wiring, caps, legal/ops/canary, deployment+funding authorization) NOT DONE.
- **F-6**: verifier execution-witness limitation (does not replay Safe governance state post-block).
- **F-7**: public EAS anchor finality NOT ESTABLISHED; `VERIFIED_WITH_LIMITATIONS` is the export ceiling.
- **F-1/F-2**: historical pre-commit provenance disclosed (now closed by this session's committed-bytes re-run); Windows CRLF repro caveat documented (compile from blob bytes).
- **F-8..F-12**: reviewer questions — authorization timing, governance transitions, token handling, reentrancy, replay, dispute liveness, crash recovery.
- Owner decisions outstanding: Q1 journal-head, Q4 contract-vs-verifier enforcement, caps, legal, G9/G13 canaries, deployment-target work, provider/Safe provisioning, review engagement, deployment+funding authorization.

## 8. Production-readiness gaps (explicit — snapshot does not imply readiness)

1. Deployment compatibility: unproven on any public chain.
2. Signing/governance: no production signer provisioning; evaluator/provider keys are synthetic.
3. Operational limits: caps, recovery/canary parameters undefined.
4. Anchor finality: no public attestation identity or receipt.
5. Independent review: not engaged (this snapshot is the input to it).
6. Deployment/funding approvals: none given; funding rule (Option A) already approved for the economics only.

## 9. Change-control rules (what approval means)

- **Approval freezes the identified candidate for review ONLY.** It does NOT: constitute an independent audit, establish production readiness, authorize deployment or funding, or grant permission for any public-chain write or spending.
- Approval is scoped to the exact manifest digest + candidate revision + preparation commit + archive hash above.
- Any subsequent change to candidate source, harness bytes, evidence, manifest content, or archive content **invalidates this approval** and requires a NEW preparation and NEW approval.
- The preparation commit (`ea0562b5`), candidate revision (`2e49625b`), and test revision (`7c26838b`) remain untouched historical objects.

## 10. The reviewer's first questions (also in `12-current-state-and-reproducibility.md` §8)

Authorization timing · governance transitions/same-block ordering · token handling (fee-on-transfer etc.) · reentrancy · replay protection/nonce classes · dispute liveness/deadline arithmetic · crash recovery/durable worker · verifier execution-witness adequacy.