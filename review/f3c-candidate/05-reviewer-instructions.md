# Reviewer Instructions & Trust Assumptions — Custody V3 (NOT FROZEN)

## Trust assumptions (what the evidence IS)
1. The repository is the source of truth for identity: `verifier/v4-candidate-identity-31337-v3.json` (runtime keccak 0x87615e3d…, source sha256 9bd413ac…), `data/escrow-custody-v3-build.json` (candidate artifact), `artifacts/f3a/v3-build-manifest.json` (F3A lane reference).
2. The pinned runtime keccak is asserted ON-CHAIN per settlement by `verifier/verify-v4.js` (eth_getCode at the settlement block) — an export whose chain disagrees with the pin is INCOMPLETE, never VERIFIED.
3. All V3 behavioral evidence in this package was produced on the LOCAL EVM chainId 31337 with synthetic keys, local official EAS 1.7.1, real Safe 1.4.1 singleton/proxy/factory (where used), MockUSDC. No public-chain write occurred.
4. Test harness facts were verified by inspecting the harness source (which artifact it deploys and which identity it asserts) and by running the suites fresh this session; reported "green" results are from THIS session's runs (output files in `.output/`), not from historical claims.
5. "VERIFIED_WITH_LIMITATIONS" is the ceiling for exports by design (`noPublicFinality: true`).

## How to verify this package yourself
1. `git rev-parse HEAD` → must equal 2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8 (candidate revision). Package commit (see 06-...) is the NEXT commit on top; both must exist.
2. `node scripts/_f3c-reconcile-runtime.cjs` → both lane hashes must equal the tables in 02-build-facts.md and the pins above.
3. Re-run any suite: `node scripts/test-v3-integrated-flow.cjs`, `node scripts/test-f3c-two-worker-contention.cjs`, `node scripts/_f3c-v4-export-producer.cjs`, `node scripts/test-custody-version-dispatch.cjs`. Results must be 26/0, 14/0, 22/0, 11/0.
4. Confirm the F3A-target suites deploy paris bytecode (hardhat.config.js evmVersion='paris') and therefore are NOT candidate-object coverage (03-coverage-matrix.md).
5. Evaluate the two named exact-candidate gaps (real-Safe ERC-1271; same-block governance) before any freeze decision.
6. Do NOT treat category A (hash match) as categories B–E; see 04-requirement-evidence-index.md §8.

## Boundaries honored in every run
- No push, no deployment, no public-chain writes, no spending, no outreach, no production credentials, no mainnet activation, no candidate freeze, no broad reset/stash/cleanup. Unrelated working-tree changes and `.preserved-f3c-repair` preserved. No secrets in this package (all hashes are public digests).

## Known gaps & readiness matrix (what blocks freeze)
| # | Gap | Blocks freeze? | Who/what resolves |
|---|---|---|---|
| 1 | Real Safe/ERC-1271 flow NOT executed on the exact F3B candidate object (only F3A-paris compile) | **RESOLVED 2026-10-21** — `scripts/test-custody-v3-realsafe-candidate.cjs` 46/46 on the pinned F3B artifact (identity asserted before behavior) | evidence/f3c-candidate-realsafe-exports/ |
| 2 | Same-block governance ordering NOT demonstrated on the exact candidate object | **RESOLVED 2026-10-21** — same harness RS-C14a..C16e: release → changeThreshold(3) → release2 in ONE block; indices 0<1<2; first paid; second reverted without payout; alternative causes excluded | evidence/f3c-candidate-realsafe-exports/ |
| 2b | Required boundary/invariant controls (funding window, seller-payment boundaries, refunds without min-release wait, timeout boundaries, equality/gap, signature timing, nonce classes) not evidenced on the exact candidate | **RESOLVED 2026-10-21** - `scripts/test-custody-v3-candidate-boundary.cjs` 161/161 on the pinned F3B object (identity asserted before behavior); evidence `evidence/f3c-candidate-boundary-exports/` |
| 3 | Deployment-chain compatibility (84532/8453) NOT established for V3 | Yes (production prerequisite) | Independent deployment plan + chain execution test, separately authorized |
| 4 | Independent security review not completed | Yes (production prerequisite) | External reviewer |
| 5 | Production signer provisioning/isolation (HSM/KMS, host isolation) absent | Yes (production prerequisite) | D4B continuation, separate authorization |
| 6 | Safe governance wiring, exposure-limit values, EAS public anchor finality, legal review, operating/recovery/canary params, deployment+funding authorization | Yes (production prerequisites) | Owner decisions + independent review |
| 7 | Same-block governance fixture: resolved for V2 (41/41); tracked Safe governance test defect CLOSED by F3C-REPAIR | No (was tracked; now passing) | — |

## Proposed freeze scope (explicitly NOT FROZEN — this is a proposal only)
Freeze candidate source revision `2e49625b` + the F3B/F3C candidate artifact (data/escrow-custody-v3-build.json, identity 0x87615e3d) + the focused test harness/evidence (scripts/test-custody-v3-realsafe-candidate.cjs, evidence/f3c-candidate-realsafe-exports/) — the two exact-candidate gaps (1–2) are now CLOSED and demonstrated. Freeze remains subject to production prerequisites 3–6 (deployment-chain compatibility, independent security review, signer isolation, production governance/exposure/legal/ops parameters) with separate authorization. No freeze tag or release was created. Funding rule already approved (Option A, T_fund < resolutionDeadline).

### What still blocks candidate freeze
- Deployment-target compatibility (84532/8453) is NOT established — local Cancun execution and config blocking V3 on 84532 do NOT establish target-chain compatibility (Category D ❌).
- Independent security review not completed; production signer provisioning/isolation absent; Safe governance wiring, exposure-limit values, public EAS anchor finality, legal/ops/canary parameters, and deployment+funding authorization all unmet (Category E ❌).
- The full time-boundary battery (83 checks) and fuzz battery (540 checks) still run only on the F3A paris object — they are NOT candidate coverage (documented; the candidate's key boundary cases are covered by integrated-flow 26/26 + two-worker 14/14 + producer 22/22 + candidate real-Safe 46/46).

## UPDATE (F3C continuation 2 - 2026-10-21, HEAD 9066ace6)
- Category C is now fully evidenced on the EXACT candidate: the 46/46 real-Safe/same-block harness AND the new 161/161 boundary/invariant companion (scripts/test-custody-v3-candidate-boundary.cjs, evidence evidence/f3c-candidate-boundary-exports/). The required control list from the objective is covered on the pinned F3B object; the Paris-only 83/540 batteries are documented supersets, not required-control evidence.
- What still blocks ANY freeze (unchanged): deployment-target compatibility 84532 (Category D, not established), independent security review, production signer isolation, production governance/exposure/legal/ops parameters, deployment+funding authorization (Category E).
- The evidence in this package is a candidate-acceptance review snapshot PROPOSAL - it is NOT a production approval. It may carry disclosed production gaps (D/E) for independent review; it must not be presented as production authorization. Verifier limitation retained: authorization assurance = successful canonical execution of the allowlisted custody runtime; the verifier does not independently replay Safe governance state. See 08-test-provenance-record.md and 09-fresh-install-linkage.md.