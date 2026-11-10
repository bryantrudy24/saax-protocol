# Current-State & Reproducibility Verification — Custody V3 Review Snapshot (re-validation 2026-11-06)

Status: **PROPOSED — NOT FROZEN, NOT APPROVED.** Local review snapshot only. No deployment, custody activation, or funding authorized or performed.

## 1. Repository state at re-validation

- Repo: `ax-router` (`solvent-applied-saax-protocol`, origin `bryantrudy24/solvent-applied-saax-protocol.git`)
- HEAD at start: `29ab8602fc6641c5dfc94bd0f1391aa1b7ae68fd` (main) — in sync with `origin/main` (fetched; equal).
- Working tree: extensive PRE-EXISTING unrelated modifications + untracked scratch — **preserved untouched** (no reset/stash/clean of anything outside task-owned paths).
- Candidate revision: `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8` (F3C-REPAIR; source of `contracts/SAAXEscrowCustodyV3.sol`).
- Test/evidence revision: `7c26838b7709366ae032ccf6f80971692589ee37` (F3C continuation 2).
- **Snapshot preparation commit: `ea0562b52003cbd63e3bd731227a49f85b875470`** (single child of `7c26838b`; added the manifest, validation notes, approval record, generator + sanitized evidence copies).
- All four pinned revisions are ancestors of HEAD (verified `git merge-base --is-ancestor` → 0).
- `package.json` / `package-lock.json` at HEAD contain an added `jose 6.2.12` dependency that is **NOT** present at the pinned revisions — unrelated runtime growth, does not touch candidate source, artifact, or any pinned snapshot file. Manifest pins remain valid.

## 2. What the candidate is (and what it is not)

- **Candidate = Custody V3, F3B/Cancun build object**: deployed runtime keccak `0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3`; creation len 22540; deployed runtime len 22014; source sha256 `9bd413ac145b7fe0709ef82aed062d2c4290dcfa7dc75c1bc69b65b794cdbc76`; solc `0.8.26+commit.8a97fa7a.Emscripten.clang`, optimizer 200, viaIR, evmVersion omitted (effective **cancun**).
- Distinguish from:
  - **Deployed testnet Custody V1** (`0x0897dba0…` on Base Sepolia 84532, 6934-byte runtime — the deployed testnet contract, pinned in `verifier/v4-eas-policy.json` 84532 historical lane).
  - **Custody V2** (local identity runtimeHash `0x914a74bc…`; phase3b/phase3c lanes — NOT the candidate).
  - **F3A-paris build** of the same V3 source (`artifacts/f3a/`; runtime keccak `0x60ea1fcb…`; used only as a behavioral oracle — NOT candidate coverage).
- Only ONE review candidate exists in the repo: **Custody V3 F3B**. No competing candidates to compare.

## 3. Snapshot identity (validated this session)

| Item | Value |
|---|---|
| Preparation commit | `ea0562b52003cbd63e3bd731227a49f85b875470` |
| Manifest path | `review/f3c-candidate/10-review-snapshot-manifest.json` |
| Manifest SHA-256 | `920ddff847c96f6a97fadd326a19f3172c580b1d0074c3c279b7a82f7bb1abf0` (recomputed == recorded) |
| Archive | `review/f3c-candidate/snapshot/saax-custody-v3-review-snapshot-ea0562b5.tar.gz` |
| Archive SHA-256 | `bfecfd1b0fa6948621ba7683f5849cba7c308b6de956bacb6726f1bbff660781` (41,707,398 bytes; `git archive` of `ea0562b5`, 22,819 files incl. locked deps) |
| Candidate runtime pin | keccak `0x87615e3d…` |
| Manifest entry count | 78 (source 1, artifact 3, build 8, components 13, identity 10, harnesses 7, evidenceCand 18, evidenceOther 18) |

## 4. Manifest re-validation (new validator, this session)

Command: `node review/f3c-candidate/scripts/_validate-snapshot-current.cjs`

- Resolved **78/78** entries at their pinned revisions; SHA-256 + byte counts **all match** (0 mismatches).
- Integrity block re-checked: realsafe harness byte-identical at `9066ace6` and `7c26838b`; boundary harness present only at `7c26838b`; candidate source unchanged `2e49625b` → `7c26838b` — all OK.
- Drift at HEAD: **none** for any snapshot file (the two `package*.json` diffs are the later jose add, present only in post-`ea0562b5` commits; the manifest pins remain byte-valid at their pinned revisions).

## 5. Build reproducibility (fresh, isolated)

- Isolated worktree `saax-review-prep` checked out at `ea0562b5` (detached).
- `npm ci --ignore-scripts --no-audit --no-fund` → **797 packages**, exit 0, 52 s. solc resolved `0.8.26+commit.8a97fa7a`; `node_modules/solc/soljson.js` sha256 `35ba6661…` == recorded in `09-fresh-install-linkage.md`.
- Recompile of the committed source blob (LF bytes, sha256 `9bd413ac…`) under F3B settings (optimizer 200, viaIR, no evmVersion):
  - creation keccak `0x58a83b0e76ad0d778a4623533271ec6b5502060259eefa572233b27a738ace34`, len 22540 — **byte-identical to the artifact**
  - deployed keccak `0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3`, len 22014 — **matches the pin**
  - deployed sha256 `dbb05777c38b818de0c297322d35afaf2014a87fc540f7750c5547dcfc0ee6d4` — matches the recorded fresh-install rebuild
- **Environment note (recorded, not a defect):** the repo's own reconcile script (`evidence/outputs/_f3c-reconcile-runtime.cjs`) reports mismatches when run from a Windows worktree because `git checkout` converts the .sol to **CRLF** (698 CRLF; worktree sha256 `c30b934b…` ≠ blob). The manifest hashes are over the **git blob (LF)** bytes, which are the authoritative committed bytes. Recompiling from the blob bytes reproduces the artifact exactly. Future reproductions on Windows must compile from `git show`/blob bytes (or set `.gitattributes` eol=lf) — documented as a reproducibility caveat.

## 6. Exact-candidate test battery (fresh run, isolated worktree `saax-review-prep`)

All commands executed from the clean locked install at `ea0562b5`; every harness asserts the deployed runtime keccak == `0x87615e3d…` before behavior:

| Suite | Expectation | Result (this session) |
|---|---|---|
| `node scripts/test-v3-integrated-flow.cjs` | 26/26 | **26/26 PASS** |
| `node scripts/test-f3c-two-worker-contention.cjs` | 14/14 | **14/14 PASS** |
| `node scripts/_f3c-v4-export-producer.cjs` | 22/22 | **22/22 PASS** |
| `node scripts/test-custody-version-dispatch.cjs` | 11/11 | **11/11 PASS** (ALL TESTS PASSED) |
| `node scripts/test-custody-v3-realsafe-candidate.cjs` | 46/46 | **46/46 PASS** |
| `node scripts/test-custody-v3-candidate-boundary.cjs` | 161/161 | **161/161 PASS** |

Total: **280/280** across the six exact-candidate suites — all reproduce on a fresh locked install from the pinned commit.

Explicitly NOT candidate-object coverage (documented, not re-run): `test-custody-v3.cjs` (83) and `test-custody-v3-fuzz.cjs` (540) compile the source under the F3A-paris settings (behavioral oracle only); `test-custody-v3-realsafe.cjs` (25, Paris target); V2 suites (41/41, 25/25) are for Custody V2. `test-f3c-checkpoint-binding.cjs` (23) covers shared journal primitives (not candidate runtime).

## 7. Secrets and package completeness

- `git grep` over `ea0562b5` excluding node_modules: no `BEGIN … PRIVATE KEY` material; the only "PRIVATE KEY" strings are env-var-name references in `rotate-seller-wallet.js` (key read from `process.env`, never a literal) and a comment in `test-d4a-vault.cjs`. No `.env` files tracked (only `.env.example`). None of the four on-disk private JWKs are in any commit (prior Phase-5 full-history scan: 0 hits across 21,791 blobs).
- Archive file list: 22,819 paths; only `.env.example` copies and library `keystore`/`SecretKey`/`privateKeyToAccount` internals (node_modules) match name heuristics — all benign library/example content, no credentials.
- Missing dependencies: none — the archive is a full `git archive` of the preparation commit including the lockfile; `npm ci` from it installs 797 packages and reproduces the build.

## 8. What the independent reviewer must verify

1. Identity: recompile source (blob bytes) → creation `0x58a83b0e…`, runtime `0x87615e3d…` == artifact == identity pin.
2. Authorization timing: is execution-time authorization sufficiently bound (direct-call success as execution witness, ERC-1271 Safe check at execution point) — what happens if owner/threshold changes between signing and execution?
3. Governance transitions: same-block ordering (release → changeThreshold → release2) — is the second release correctly rejected, and can a rollback/reorg reorder these?
4. Token handling: exactly-once payout paths (release/resolve/mutual/timeout/refund), reentrancy surface (external calls order, CEI), fee-on-transfer/rebasing tokens.
5. Replay protection: escrow-scoped nonce classes for verdict/mutual, head commitment, checkpoint freeze; cross-chain replay (chainId binding).
6. Dispute liveness: refundTimeout/DeadlineNotPassed boundaries, deadline arithmetic, gap/equality edge cases (RDL==CUT), do any states permit permanent lock?
7. Recovery/crash: durable worker + outbox semantics, duplicate funding/prevention after restart, headless timeout correctness.
8. Verifier limits: `verify-v4.js` does NOT replay Safe owner/threshold post-block; it binds authorization to canonical direct-call success (execution witness). ERC-1271 success is not proof of approved governance — is this acceptable for the intended assurance level?

## 9. Limitations carried (unchanged from the package)

- Category D — deployment-target compatibility (Base Sepolia 84532 / mainnet 8453): **NOT ESTABLISHED**. Local Cancun execution (chainId 31337) does not establish target-chain compatibility.
- Category E — independent security review + production prerequisites (signer isolation, Safe wiring, exposure caps, EAS public anchor finality, legal/ops/canary params, deployment+funding authorization): **NOT DONE**.
- Passing tests establish conformance, not security; no audit exists.
- Anchored finality (public EAS attestation receipt): NOT ESTABLISHED; no public deployment identity entries.
- Verifier execution-witness limitation retained (see §8.8).

## 10. Evidence preserved

- Run transcripts of this session's repro+battery are captured in `review/f3c-candidate/evidence/2026-11-06-rerun/` (this directory's `repro-build.txt`, `battery-*.txt`).
- Historical evidence (`.preserved-f3c-repair/`, `f3c-final-report-2e49625b.md`, phase3b/3c-v4 exports, run-records) untouched and reused with their provenance caveats.
