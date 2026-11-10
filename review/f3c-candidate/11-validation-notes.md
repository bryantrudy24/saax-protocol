# Validation Notes - F3C Independent-Review Snapshot (one-time validation)

Status: LOCAL ONLY, NOT FROZEN. Companion to 10-review-snapshot-manifest.json; prepared at HEAD 7c26838b.

## 1. Baseline confirmation (actual repo state at preparation)
- HEAD: `7c26838b7709366ae032ccf6f80971692589ee37` (F3C continuation 2 - matches the reported package commit).
- Candidate source revision: `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8` (F3C-REPAIR).
- Prior package commit: `9066ace628cd96c569163830f3614e18b6eb0b2f` (46/46 continuation).
- Branch: main, 47 commits ahead of origin/main; NO push; no tag created by this work. Pre-existing tag `phase3b-realsafe-checkpoint` untouched.
- No snapshot manifest or approval proposal existed at HEAD before this preparation; `10-review-snapshot-manifest.json`, `11-validation-notes.md`, and `PROPOSED-freeze-approval-record.md` are created here.
- Working tree: extensive PRE-EXISTING unrelated modifications and untracked scratch preserved untouched (no reset/stash/clean/stage of anything outside the listed package paths).

## 2. Provenance corrections (retained, exact)
- F3A lane (evmVersion paris) and F3B/F3C candidate lane (evmVersion omitted -> cancun) produce DIFFERENT bytecode objects from the same source. F3A batteries (83/540 etc.) are NOT candidate-object coverage. Correction record: 01-provenance-correction.md; build facts: 02-build-facts.md.
- 46/46 real-Safe harness (`scripts/test-custody-v3-realsafe-candidate.cjs`, sha256 `bf54e381…`) executed on base `2e49625b`, UNCOMMITTED; FIRST commit containing the executed bytes: `9066ace6`; its `testRevision: a97c3e1d` stamp was a labeling error, superseded by 08-test-provenance-record.md.
- 161/161 boundary harness (`scripts/test-custody-v3-candidate-boundary.cjs`, sha256 `f06d974e…`) executed on base `9066ace6`, UNCOMMITTED; FIRST commit containing the executed bytes: `7c26838b`; `testRevision: 9066ace6` denotes the base checkout revision at execution, not the containing commit.
- Both harnesses assert deployed runtime keccak `0x87615e3d…` BEFORE any behavior; executed-file hashes recorded in 08; run transcripts preserved in `review/f3c-candidate/evidence/` and `.output/`.
- Candidate source `contracts/SAAXEscrowCustodyV3.sol` is unchanged across 2e49625b -> 9066ace6 -> 7c26838b (empty diff, re-verified with `git diff`).

## 3. One-time validation executed (read-only; no behavioral reruns, no rebuilds)
Validation: resolve every entry of 10-review-snapshot-manifest.json at its pinned revision (`git show <rev>:<path>` for committed entries; working-tree bytes for the two labeled sanitized copies) and recompute SHA-256 + byte count.
Result: **78/78 entries resolved; SHA-256 and byte counts all match; 0 mismatches.**
- Entries pinned to 2e49625b (candidate source): 1.
- Entries pinned to 7c26838b via `git show`: 75.
- Working-tree (sanitized copy) entries: 2 - `scripts/_f3c-reconcile-runtime.cjs` (sha256 `e6fef95c…`) and `evidence/f3c-final-report-2e49625b.md` (sha256 `b7ae40b5…`); both match the working-tree bytes, and byte-identical sanitized copies are placed in this package.
- Integrity block re-verified: realsafe harness byte-identical at 9066ace6 and 7c26838b (bf54e381…); boundary harness ABSENT at 9066ace6, present at 7c26838b (f06d974e…); candidate source hash equal at 2e49625b and 7c26838b (sourceUnchanged.srcToPkgDiffEmpty=true).
- Implementation-equivalence check for files taken from later revisions: candidate implementation is sourced EXCLUSIVELY from 2e49625b. All tests, evidence, build inputs, and component files are pinned at 7c26838b: it is the first-commit for the boundary harness and the package HEAD; the realsafe harness is verified byte-identical between its first commit (9066ace6) and the pin (7c26838b). No dirty working-tree implementation is claimed as candidate or harness content.

## 4. Exclusions (deliberate)
- The manifest excludes its own checksum and the other files created in the preparation commit (no circular hash; documented in manifest.preparationArtifacts).
- node_modules/dependency directories, secrets, private keys, environment files, runtime databases, scratch/working files, and the unrelated dirty tree are outside the snapshot. Synthetic/rebuild fixtures are labeled as such in the package (fresh-install-rebuild.json, reconcile-fresh.txt = rebuild/reconciliation outputs, not on-chain witness evidence).
- Unrelated working-tree changes preserved; none staged by this preparation.

## 5. Remaining snapshot-integrity blockers
- None for the snapshot itself: all referenced paths exist at their pinned revisions and all checksums validate (section 3).
- Open items carried (review-relevant, NOT snapshot blockers): Category D (deployment-target compatibility, 84532) NOT ESTABLISHED; Category E (independent review + production prerequisites) NOT DONE; verifier's execution-witness authorization limitation retained (verify-v4.js binds transaction-time authorization to canonical direct-call success into the allowlisted runtime; it does NOT replay Safe threshold/owner state; ERC-1271 success is not proof of approved governance); anchor finality NOT ESTABLISHED; no public deployment identity entries; mainnet blocked.

## 6. What was NOT done
No behavioral test reruns, no rebuilds, no freeze/tag, no push, no publication, no reviewer outreach, no deployment, no public-chain writes, no spending, no production credentials touched. Retained prior-run evidence is reused as-is with its provenance caveats.