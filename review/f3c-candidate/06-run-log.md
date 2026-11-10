# Session Verification Run Log — 2026-10-20 (exact candidate, local EVM 31337)

All runs executed THIS session after the StarNet outage/restart. Outputs preserved under `.output/` (repo workspace) and referenced by the package. No run was fabricated: every count is the tail line of the real command.

| Command | Result | Output file | Candidate-object? |
|---|---|---|---|
| `node scripts/_f3c-reconcile-runtime.cjs` | exit 0; both lane hashes match pins | `.output/reconcile-fresh.txt` | n/a (recompile check) |
| explicit-paris inline recompile (F3A lane) | keccak 0x60ea1fcb…, hexLen 23074 | captured in transcript | F3A |
| F3B-lane metadata extraction | evmVersion **cancun** | captured in transcript | F3B |
| `node scripts/test-custody-version-dispatch.cjs` | 11/11 PASS | transcript in run log | identity dispatch |
| `node scripts/test-custody-v3-realsafe.cjs` | 25/25 PASS (F3A-target compile) | `.output/v3-realsafe-run.txt` | F3A-target (not candidate) |
| `node scripts/test-v3-integrated-flow.cjs` | **26/26 PASS** | `.output/v3-integrated-run.txt` | ✅ candidate artifact |
| `node scripts/test-f3c-two-worker-contention.cjs` | **14/14 PASS** | `.output/two-worker-run.txt` | ✅ candidate artifact |
| `node scripts/_f3c-v4-export-producer.cjs` | **22/22 PASS**, 7 outcomes, regenerated `evidence/f3c-v4-exports/*` stamped revision 2e49625b | `.output/v4-export-producer-run.txt` + evidence dir | ✅ candidate artifact |
| `node scripts/test-custody-v3.cjs` | 83/83 PASS (F3A-target compile) | `.output/v3-eoa-battery-run.txt` | F3A-target (not candidate) |
| `node scripts/test-custody-v3-fuzz.cjs` | 540/540 PASS (F3A-target compile) | `.output/v3-fuzz-run.txt` | F3A-target (not candidate) |
| `node scripts/test-f3c-checkpoint-binding.cjs` | 23/23 PASS | `.output/checkpoint-binding-run.txt` | shared journal primitives |

## ADDENDUM (F3C continuation — 2026-10-21, package commit a97c3e1d, still NOT FROZEN)

The two named exact-candidate coverage gaps (real-Safe ERC-1271 on the pinned F3B object; same-block governance ordering on the pinned F3B object) were closed by a NEW focused companion harness. Each focused suite ran ONCE after implementation; no re-run loop. Completed F3C suites (integrated-flow 26/26, two-worker 14/14, exports 22/22, dispatch 11/11) were NOT restarted. No broad testing was added.

| Command | Result | Output file | Candidate-object? |
|---|---|---|---|
| `node scripts/test-custody-v3-realsafe-candidate.cjs` | **46/46 PASS** (real Safe 1.4.1 ERC-1271 + same-block governance, on the pinned F3B artifact) | `.output/v3-realsafe-candidate-run.txt`; `evidence/f3c-candidate-realsafe-exports/{run-record.json,results.json,same-block-pre-governance-release.json,separate-process.txt,fresh-install-rebuild.json}` | ✅ exact candidate (identity asserted before behavior) |
| Focused F3B/Cancun rebuild from the existing clean locked install | exit 0; creation byte-identical to artifact; runtime keccak == pin; runtime sha256 `dbb05777…` | `review/f3c-candidate/evidence/fresh-install-rebuild.json` | n/a (reproduction, item 4) |

### Exact assertions recorded (from the harness output)
- Deployed runtime keccak == pinned F3B identity `0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3` asserted BEFORE any behavior (RS-C2 / C2b / C2c).
- Real Safe 2-of-3 release accepted with head committed + exactly-once payout (RS-C3..C5b); one-sig / duplicate / wrong-owner / wrong-digest / head-substitution / zero-head / wrong-chain-domain all rejected (RS-C6..C10c); real-Safe refund accepted (RS-C11..C11b).
- Same-block ordering (automine off, one block): indices releaseA=0 < governance=1 < releaseB=2, same block hash; releaseA status 1 (payout), governance status 1 (threshold→3), releaseB status 0 (revert, no payout, escrow still Funded, totalHeld unchanged, no settlement event/head) (RS-C14a..C15d). Alternative causes excluded (RS-C16a..e).
- Sequential cross-check on same Safe: outstanding 2-of-3 invalid after threshold→3; fresh 3-of-3 accepted, paid once (RS-C18a..f).
- Export of the successful pre-governance release verified SEPARATE PROCESS: `VERDICT: VERIFIED_WITH_LIMITATIONS` (exit 0) over read-only RPC; verifier re-checked candidate runtime identity at the settlement block; method = canonical successful execution of allowlisted runtime (execution witness) (RS-C20..C21).

### Precise verifier limitation (reported, never weakened)
`verify-v4.js` establishes transaction-time authorization via the SUCCESS of the canonical direct call into the allowlisted immutable runtime (the runtime enforced Safe ERC-1271 at execution point). It does NOT re-read Safe threshold/owner state or make a post-block wallet call (no Safe governance state replay). That is a documented verifier limitation, not a behavioral gap — the on-chain custody call itself is the authorization check at execution point.

## Evidence reused (inspected, not re-run)
- `evidence/phase3b-v4/results.json` — 41/0, runtimeHash 0x914a74bc… = **V2** custody (harness deploys SAAXEscrowCustodyV2; NOT V3 candidate).
- `evidence/phase3c-v4/results.json` — 25/0 at revision 2e49625b; same V2 custody deployment.
- `evidence/phase3c-v4/separate-process.txt` — VERDICT: VERIFIED_WITH_LIMITATIONS (V2 lifecycle export).
- `evidence/.preserved-f3c-repair/clean-install.txt`, `repro-run.txt`, `repair-final.txt` — clean-install + 41/0 + 25/0 history, preserved untouched.
- `evidence/f3c-final-report-2e49625b.md` — prior report (kept as historical; corrected by 01-provenance-correction.md on the identity claim).
- `mainnet/funding-rule-approval.md` — APPROVED Option A (read; economics untouched).
- `mainnet/release-candidate-gap-assessment.md`, `mainnet/f3c-status.md` — gap tables (read; used for prerequisites).
- `evidence/v3-battery/*` (66 case files + summary) — v3 export tamper battery on the **historical 84532 V1-era** verifier lane; not candidate coverage (documented in 03-coverage-matrix.md).

## Working-tree state at package creation
HEAD = 2e49625b; uncommitted modifications (evidence outputs, manifest timestamp, daily logs) preserved as found. Only intended package files added under `review/f3c-candidate/`. No staging of unrelated files, no reset, no stash, no cleanup.

## ADDENDUM (F3C continuation 2 - 2026-10-21, HEAD 9066ace6, still NOT FROZEN)
Category C exact-candidate boundary/invariant coverage completed.

| Command | Result | Output file | Candidate-object? |
|---|---|---|---|
| 
ode scripts/test-custody-v3-candidate-boundary.cjs | **161/161 PASS** (funding window A; seller-payment boundaries B; refunds without min-release wait C; timeout before/at/after cutoff D; equality+gap E; signature timing + nonce classes F; 12-round seeded fuzz G, seed 0xC4A) | .output/v3-candidate-boundary-run.txt; evidence/f3c-candidate-boundary-exports/{results.json, run-record.json} | âœ… exact candidate (runtime keccak 0x87615e3d asserted before any behavior) |

- Harness: scripts/test-custody-v3-candidate-boundary.cjs (sha256 06d974e1088aa4707c3fb0c8bfee76f795216592cf5ace12f4720834ebab5c6).
- Deterministic clock model (documented in the harness header): setTime consumes the pending timestamp with evm_mine and probes execute at exactly the wanted instant; issuedAt is always the actual executed block timestamp, so the verdict freshness window is respected and no pending-timestamp leaks occur (revert probes that never mine).
- Evidence files: evidence/f3c-candidate-boundary-exports/results.json (passed 161, failed 0, runtimeCodeHash == pin), un-record.json (sections A-G, seed 0xC4A, testRevision 9066ace6, candidateRevision 2e49625b).
- No broad reruns; no candidate freeze; provenance record in 08-test-provenance-record.md; fresh-install linkage in 09-fresh-install-linkage.md.