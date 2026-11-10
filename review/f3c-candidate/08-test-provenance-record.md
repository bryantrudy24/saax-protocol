# Test Provenance Record — `scripts/test-custody-v3-realsafe-candidate.cjs` (46/46, 2026-10-21)

Status: LOCAL ONLY, NOT FROZEN. This record corrects the provenance of the focused
candidate harness `scripts/test-custody-v3-realsafe-candidate.cjs` (real Safe ERC-1271 +
same-block governance on the pinned F3B object, 46/46), which stamped `testRevision
a97c3e1d…` although its code was not committed in `a97c3e1d`.

## 1. Base checkout revision at execution

- The harness ran on 2026-10-21 with the working tree checked out at
  `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8` (F3C-REPAIR HEAD) — the same HEAD the earlier
  F3C suites ran on. Evidence: `review/f3c-candidate/evidence/candidate-realsafe-console.txt`
  (`test-revision: 2e49625b…` is NOT printed; critical — see §3) and the run-record
  `evidence/f3c-candidate-realsafe-exports/run-record.json` (line `command`,
  `testRevision: a97c3e1d…`).

- The harness writes `testRevision = git rev-parse HEAD` at runtime (line ~202). At
  execution time HEAD was `2e49625b…`; the run record stamped `a97c3e1d…` because the
  harness file existed in the working tree but was NOT part of the commit at the time the
  executable bytes were authored, and the author stamped the then-current package-revision
  label (a97c3e1d, the previous review-package commit) into the record.

## 2. SHA-256 of the executed harness and relevant supporting files

All hashes are SHA-256 over the exact file bytes as they existed in the working tree at run
time (recorded 2026-10-21, the run's evidence; identical copies exist under
`review/f3c-candidate/evidence/` and `evidence/f3c-candidate-realsafe-exports/`):

| File | sha256 | bytes |
|---|---|---|
| `scripts/test-custody-v3-realsafe-candidate.cjs` | `bf54e38198572a6eb8e911c8fad6ee883152e9a751d2ce83af07413d940316aa` | 44271 |
| `evidence/f3c-candidate-realsafe-exports/results.json` | `5b706c548561a06359742b35e9bbe3e34879cedab01a2ac2faddf5d7fec7ffa2` | 205 |
| `evidence/f3c-candidate-realsafe-exports/run-record.json` | `bcd2ef41d6d1a04a766ad768279dbd7283655cc1fd13acc8a45d5d2a3c655af9` | 941 |
| `evidence/f3c-candidate-realsafe-exports/same-block-pre-governance-release.json` | `9dcb69d6c0b573c908e2044a6c8e8e1ca84cf9ff6c1c5e65fbb51c872c986c6e` | 13522 |
| `evidence/f3c-candidate-realsafe-exports/separate-process.txt` | `a319cc75019540ee7404f3ae0bc47ada975f9c49c8b7f5ea8a044b6267c05c95` | 12559 |
| `.output/v3-realsafe-candidate-run.txt` | `35d058b62c76b3fad05b641be5911b4dc243fa1841e72e880b74afcae7bb84cf` | 3725 |

## 3. Whether those files were uncommitted during execution

YES — uncommitted. At execution time the harness and its evidence outputs existed only in
the working tree on top of base `2e49625b`. Verified with git:

- `git ls-tree -r a97c3e1d -- scripts/test-custody-v3-realsafe-candidate.cjs evidence/f3c-candidate-realsafe-exports/ review/f3c-candidate/evidence/candidate-realsafe-results.json`
  → (none of these paths exist at a97c3e1d)
- `git ls-tree -r 2e49625b -- …` → (none of these paths exist at 2e49625b either —
  verified). The harness and its evidence were committed for the first time in
  `9066ace6` (see §4).
- The execution itself is evidenced by `.output/v3-realsafe-candidate-run.txt` (tail:
  `v3_realsafe_candidate_passed=46 failed=0`), written by the harness run.

This is the disclosure the task requires: the 46/46 run executed UNCOMMITTED bytes. The
run's integrity is preserved because the executed byte-for-byte content is now committed
as `9066ace6` (identical sha256 `bf54e381…`), and the harness internally asserts the
candidate runtime identity (keccak `0x87615e3d…`) before any behavior — but the run is
NOT a post-commit execution. No relabeling: the run stays "executed pre-commit".

## 4. Commit containing the exact executed bytes

`9066ace628cd96c569163830f3614e18b6eb0b2f` ("F3C continuation: close both exact-candidate
coverage gaps on pinned F3B runtime …", 2026-10-21 17:08:32 -0400) is the FIRST commit
containing the exact executed harness bytes and the exact executed evidence files:

- `git show 9066ace6:scripts/test-custody-v3-realsafe-candidate.cjs` → sha256
  `bf54e38198572a6eb8e911c8fad6ee883152e9a751d2ce83af07413d940316aa` == working-tree file
  at run time (byte-identical).
- `git ls-tree -r 9066ace6 -- review/f3c-candidate/evidence/candidate-realsafe-results.json`
  → blob `dcc2f59aed77764e884a4cc49a6b5a13b4883419` (== working tree).
- `git log -- review/f3c-candidate/evidence/candidate-realsafe-results.json` → only
  `9066ace6` touches it.
- `git ls-tree -r a97c3e1d` → NONE of the harness/evidence paths exist at `a97c3e1d`
  (they were created in the working tree after `a97c3e1d` was committed).
- `git ls-tree -r 2e49625b` → NONE of the harness/evidence paths exist at `2e49625b`
  either.

Therefore: the commit containing the exact executed bytes is `9066ace6`, NOT `a97c3e1d`,
and the harness's `testRevision: a97c3e1d…` stamp is a labeling error (it reflected the
intended package revision, not the executed bytes). This record supersedes that stamp.

## 5. What this means for the evidence

- The 46/46 result stands as valid evidence for the F3B candidate (identity asserted
  before behavior; run captured in `.output/v3-realsafe-candidate-run.txt`), with the
  provenance caveat that it ran on uncommitted harness bytes later fixed by `9066ace6`.
- The review package must cite `9066ace6` as the harness revision for the candidate
  real-Safe suite, and `2e49625b` remains the candidate SOURCE revision (contract
  unchanged; `git diff 2e49625b 9066ace6 -- contracts/SAAXEscrowCustodyV3.sol` is empty).
- No claim is made that `a97c3e1d` or `2e49625b` contained the harness. The harness was
  first committed in `9066ace6`.

## 6. Boundary harness provenance — scripts/test-custody-v3-candidate-boundary.cjs (161/161, 2026-10-21)

Same terminology as §1-5 (base revision / executed bytes / uncommitted / first-commit / evidence paths).

### 6.1 Base checkout revision at execution

- The harness ran on 2026-10-21 with the working tree checked out at `9066ace628cd96c569163830f3614e18b6eb0b2f` (HEAD after the 46/46 continuation). The harness stamps `testRevision = git rev-parse HEAD` at runtime (lines 135-138 of the committed file); its run-record `evidence/f3c-candidate-boundary-exports/run-record.json` records `testRevision: 9066ace6...` — which accordingly denotes the BASE CHECKOUT REVISION AT EXECUTION, not the commit containing the harness bytes.

### 6.2 SHA-256 of the executed harness and relevant supporting files

All hashes are SHA-256 over the exact file bytes as they existed in the working tree at run time (verified 2026-10-21 against the committed copies):

| File | sha256 | bytes |
|---|---|---|
| `scripts/test-custody-v3-candidate-boundary.cjs` | `f06d974e1088aa4707c3fb0c8bfee76f795216592cf5ace12f4720834ebab5c6` | 42165 |
| `evidence/f3c-candidate-boundary-exports/results.json` | `84c8f7ef94bb38aee3003203beeb29cea14c559cfa6d81fac4d96328447bf889` | 206 |
| `evidence/f3c-candidate-boundary-exports/run-record.json` | `c3d453d65d946740417f21df64990087da71b415c3c7201ed9df5ffde869a384` | 1668 |
| `.output/v3-candidate-boundary-run.txt` | `284aa1910b61b1e924739e451302086f4e40915b3270a881f9d847eb8cfd4daa` | 8451 |

### 6.3 Whether those files were uncommitted during execution

YES — uncommitted. Verified with git: `git ls-tree -r 9066ace6 -- scripts/test-custody-v3-candidate-boundary.cjs` returns nothing (the harness is ABSENT at 9066ace6); the harness and its evidence were committed for the first time in `7c26838b` (see §6.4). The execution is evidenced by `.output/v3-candidate-boundary-run.txt` (tail: `v3_candidate_boundary_passed=161 failed=0`).

Disclosure: like the 46/46 run, the 161/161 run executed UNCOMMITTED bytes. The executed byte-for-byte content is now committed as `7c26838b` (identical sha256 `f06d974e...`), and the harness internally asserts the candidate runtime identity (keccak `0x87615e3d...`) before any behavior — but the run is NOT a post-commit execution.

### 6.4 Commit containing the exact executed bytes

`7c26838b7709366ae032ccf6f80971692589ee37` ("F3C continuation 2: ...") is the FIRST commit containing the exact executed harness bytes and the exact executed evidence files:

- `git show 7c26838b:scripts/test-custody-v3-candidate-boundary.cjs` → sha256 `f06d974e...` == working-tree file at run time (byte-identical).
- `git ls-tree -r 7c26838b -- evidence/f3c-candidate-boundary-exports/run-record.json` → blob present; `review/f3c-candidate/evidence/candidate-boundary-run-record.json` blob `c05d76e...` == working tree.
- `git ls-tree -r 9066ace6` → NONE of the harness/evidence paths exist at 9066ace6.

The `testRevision: 9066ace6...` stamp therefore denotes the base checkout revision at execution (correct by definition — the harness was edited in the working tree on top of 9066ace6), NOT a claim that 9066ace6 contains the harness. No relabeling needed beyond this record: the stamp semantics are now explicit for BOTH candidate harnesses (46/46 in §1-5, 161/161 here).

### 6.5 What this means for the evidence

- The 161/161 result stands as valid evidence for the F3B candidate (identity asserted before behavior; run captured), with the same provenance caveat as the 46/46 run: executed on uncommitted harness bytes later fixed by `7c26838b`.
- The review package cites `7c26838b` as the harness revision for the candidate boundary suite, and `2e49625b` remains the candidate SOURCE revision (contract unchanged; `git diff 2e49625b 7c26838b -- contracts/SAAXEscrowCustodyV3.sol` is empty).
- No claim is made that `9066ace6` or `2e49625b` contained the boundary harness. The harness was first committed in `7c26838b`.

