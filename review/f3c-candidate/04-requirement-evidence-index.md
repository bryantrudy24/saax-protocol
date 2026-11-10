# Requirement-to-Evidence Index — Custody V3 review package (NOT FROZEN)

Source revision (candidate): `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8` (HEAD, F3C-REPAIR)
Package location: `review/f3c-candidate/` (this directory). Review date: 2026-10-20.

Legend: ✅ exact-candidate evidence (deployed the pinned F3B runtime, keccak 0x87615e3d on EVM 31337) · 🟡 other-runtime evidence (F3A paris or V2) · ❌ not established · N/A out of scope.

Test-code revision (separate from candidate source revision): `a97c3e1d4ffb42f7e39955cdfcc9054477a57bb6` (package HEAD). Candidate source revision: `2e49625b…`. The focused candidate harness is `scripts/test-custody-v3-realsafe-candidate.cjs` (46/46, run once 2026-10-21; evidence in `evidence/f3c-candidate-realsafe-exports/` and `review/f3c-candidate/evidence/candidate-realsafe-*`).

## 1. Build provenance (section 3 of the objective)
| Requirement | Evidence | Status |
|---|---|---|
| Full source revision + source hashes | `contracts/SAAXEscrowCustodyV3.sol` unchanged c7150105→2e49625b; sha256 9bd413ac… (02-build-facts.md) | ✅ |
| Actual compiler + complete settings | solc 0.8.26+commit.8a97fa7a.Emscripten.clang, optimizer 200, viaIR; F3A evmVersion=paris, F3B omitted (02-build-facts.md) | ✅ |
| Effective EVM target (read, not guessed) | F3A metadata `paris`; F3B metadata `cancun` (compiler-emitted metadata, captured 2026-10-20) | ✅ |
| Creation/runtime/deployed separated, both hashes labeled | 02-build-facts.md tables + `evidence/reconcile-fresh.txt` (fresh recompile both lanes) | ✅ |
| Byte lengths without 0x prefix | 02-build-facts.md (hexLen & bytes) | ✅ |
| Metadata/constructor/linked-lib/immutable handling | 02-build-facts.md §settings | ✅ |
| Length discrepancy reconciled | 02-build-facts.md §length reconciliation (net deltas ≠ changed byte counts) | ✅ |
| Prior "identical bytes" claim corrected | 01-provenance-correction.md | ✅ |

## 2. Reproduction (section 4 of the objective)
| Requirement | Evidence | Status |
|---|---|---|
| Isolated-source rebuild (reused deps) | Fresh directories `Temp\saax-phase3b-clean-KJElTm` (clean npm ci from lockfile, 797 packages, hardhat compile "evm target: paris", suites 41/0 + real-Safe 17/0) and `Temp\saax-phase3b-clean-Mna4MR` (27/0 phase3b run) — both are FULL clean installs of the committed tree, not junctions. Recorded in evidence/.preserved-f3c-repair/clean-install.txt + repro-run.txt + repair-final.txt | ✅ (clean install, not junction-labeled) |
| Fresh locked dependency-install once | Same `npm ci` runs above — completed successfully (no block). No junction was created; the interrupted junction attempt left no live junction (fsutil: Mna4MR node_modules is NOT a reparse point). S5MW2m empty dir is dead scratch | ✅ |
| Dependency paths + actual compiler | package-lock-driven; solc 0.8.26 local; safe-contracts 1.4.1; ethers 6.17.0; hardhat 2.22.4; eas-contracts 1.7.1 (run-record.json stamps) | ✅ |
| Compare reproduced with pinned artifacts | reconcile-fresh.txt: F3A recompile == F3A artifact (paris), F3B recompile == F3B pin (cancun); artifact hashes never replaced | ✅ |
| Exact F3B/Cancun artifact rebuilt from committed source using FRESHLY INSTALLED LOCKED DEPS | **DONE 2026-10-21**: focused rebuild run from `Temp\saax-phase3b-clean-KJElTm` (the existing clean `npm ci` locked install) resolving `solc` at that install's `node_modules`. Creation object byte-identical to artifact (keccak 0x58a83b0e…, sha256 0899e556…, len 22540); deployed runtime keccak 0x87615e3d… == pinned identity; runtime sha256 (newly recorded) dbb05777c38b818de0c297322d35afaf2014a87fc540f7750c5547dcfc0ee6d4; metadata evmVersion cancun, compiler 0.8.26+commit.8a97fa7a. Evidence: `evidence/f3c-candidate-realsafe-exports/fresh-install-rebuild.json` + `review/f3c-candidate/evidence/fresh-install-rebuild.json` | ✅ |
| Sanitized repro script/log preserved | scripts/_f3c-reconcile-runtime.cjs + .output/reconcile-fresh.txt + this package; no secrets written | ✅ |
| Durable checkpoint after this step | This package IS the checkpoint; also daily evidence dirs + committed evidence (see 6) | ✅ |

## 3. Exact-candidate test coverage (section 5 of the objective)
Full matrix: 03-coverage-matrix.md. Summary:
| Control area | On exact candidate (cancun, 0x87615e3d) | Notes |
|---|---|---|
| Contract auth (EOA verdict, escrow-scoped nonces, chain/version binding) | ✅ integrated-flow 26/26, two-worker 14/14, exports 22/22, dispatch 11/11 | — |
| Time boundaries (minReleaseTime/RDL/cutoff/gap/equality) | âœ… **candidate boundary 161/161** (BC-B1..B7/boundaries, D, E) | Exact-candidate object (deterministic clock model) |
| Real Safe / ERC-1271 | ✅ **candidate real-Safe 46/46** (RS-C1..C18f) | **GAP CLOSED** — real Safe 1.4.1, pinned F3B artifact, identity asserted before behavior |
| Seven integrated settlement outcomes | ✅ producer 22/22 separate-process | — |
| Checkpoint/journal/receipt binding | ✅ producer + integrated-flow; shared primitives also 23/23 binding test | — |
| Concurrency / crash recovery / duplicate payout | ✅ two-worker 14/14 + integrated-flow kill/reconcile | — |
| Same-block governance ordering | ✅ **candidate real-Safe 46/46** (RS-C14a..C16e) | **GAP CLOSED** — one block: release(A) OK → changeThreshold(3) OK → release(B) reverted, indices 0<1<2, no payout, exclusion matrix |
| Funding, seller-payment, refund, timeout, equality/gap, signature-timing, nonce-class boundaries | âœ… **candidate boundary 161/161** | **ADDED 2026-10-21** - `scripts/test-custody-v3-candidate-boundary.cjs` on the pinned F3B object; runtime keccak asserted before behavior; evidence `evidence/f3c-candidate-boundary-exports/` |
| V3 version dispatch/identity | ✅ dispatch 11/11 + verify-v4 identity re-check per export | — |

## 4. Deployment-target compatibility (item 5 tail + section 6-D)
- ❌ NOT ESTABLISHED. No public deployment identity for V3; V3 is local-lane-only by config; Base Sepolia hosts V1. Cancun-target bytecode is generically compatible with current Base Sepolia (Cancun-active), but no execution/deployment evidence exists. Local EVM execution does not establish deployment-chain compatibility.

## 5. Independent-review and production prerequisites (section 6-E + retained items)
All retained and UNMET (unchanged from gap assessment, `mainnet/release-candidate-gap-assessment.md`, `mainnet/f3c-status.md` §D4):
- Real signer provisioning/isolation (D4B partial: remote/HSM/KMS adapter absent, host isolation pending)
- Approved Safe governance on a real deployment (owner identities/threshold wiring; only synthetic local Safe tested)
- Deployment/asset identity pinning for public chain (V3: none exists)
- Public EAS anchor finality (local anchors only; noPublicFinality=true everywhere)
- Exposure limits (perPositionCap/aggregateCap values are owner decisions, not production-set)
- Operating/recovery/canary parameters
- Legal review of custody policy + timeout consent
- Independent security review/remediation (not completed)
- Separately authorized deployment/funding (no deployment, no funding authorized)

## 6. Assurance limits (retained)
- Full-export ceiling: VERIFIED_WITH_LIMITATIONS (by design, `noPublicFinality`).
- Local EAS anchors/confirmations are NOT public finality.
- Journal integrity does not establish complete or unique history.
- Accepted intent ≠ confirmed execution.
- Synthetic signer tests do not establish production key custody.

## 7. Funding policy
- `mainnet/funding-rule-approval.md` — APPROVED 2026-10-19, Option A: `T_fund < resolutionDeadline`; funding at/after resolutionDeadline rejected; supersedes earlier funding-until-finalCutoff proposal. NOT reopened; contract economics unchanged.

## 8. Category status summary (distinguish A–E)
| Category | Status |
|---|---|---|
| A. Artifact reproduction | ✅ DONE (both lanes; reconcile + clean installs + fresh runs) |
| B. Fresh locked dependency-install reproduction | ✅ DONE (npm ci from committed lockfile, twice, both clean) |
| C. Exact-candidate test coverage | âœ… DONE - real-Safe ERC-1271 + same-block governance on the exact F3B object (46/46) AND the required boundary/invariant controls on the exact object (161/161, `scripts/test-custody-v3-candidate-boundary.cjs`, 2026-10-21): funding window, seller-payment boundaries, refunds without min-release wait, timeout boundaries, equality/gap, signature timing, nonce classes, 12-round seeded fuzz. The full 83/540 F3A batteries remain Paris-only (superset breadth, not required-control evidence). |
| D. Intended deployment-target compatibility | ❌ NOT ESTABLISHED |
| E. Independent review + production prerequisites | ❌ NOT DONE (prerequisites retained, separate authorization required) |

A successful runtime hash match (category A) does NOT establish B, C, D, or E. Closing the two exact-candidate gaps (category C) does NOT establish deployment-target compatibility (D) — local Cancun execution and config blocking V3 on 84532 do not establish target-chain compatibility.