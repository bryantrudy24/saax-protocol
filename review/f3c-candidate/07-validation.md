# Reviewer Check: package references & checksums (validation once, 2026-10-20)

## Commands used to validate (all executed, output captured)
1. `git rev-parse HEAD` → `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8`
2. `node scripts/_f3c-reconcile-runtime.cjs` → F3A lane keccak `0x60ea1fcb…`/sha256 `9a029d61…`; F3B lane keccak `0x87615e3d…`; identity==artifact; F3A creation == manifest creation.
3. Source sha256 recompute → `9bd413ac145b7fe0709ef82aed062d2c4290dcfa7dc75c1bc69b65b794cdbc76` (= all three pinned sources).
4. Chain/identity call graph inspected in source: `verify-v4.js` requires identity and rejects by keccak; `test-v3-integrated-flow.cjs` + `test-f3c-two-worker-contention.cjs` + `_f3c-v4-export-producer.cjs` deploy `data/escrow-custody-v3-build.json` (candidate); `test-v4-checkpoint.cjs` + `test-v4-producer-closure.cjs` deploy `SAAXEscrowCustodyV2` (V2 identity 0x914a74bc…).
5. Metadata extraction for both lanes (compiler-emitted) → paris vs cancun.
6. Repo-owned pin checked at F3B (`git show 5bd19ba2:…`) == working tree == HEAD for the v3 identity file.

## Files validated for existence + hashes (sha256 over file bytes)
| File | sha256 | Status |
|---|---|---|
| `review/f3c-candidate/01-provenance-correction.md` | 65a0920098e5a29c0a31d24fd67de07bbd87a9e32bd1c559981b72facc39f804 | exists |
| `review/f3c-candidate/02-build-facts.md` | 0789d6bedd93b49687cf7c45d3da73a6e9825f2ae32993911a4a6e623e0b0e73 | exists |
| `review/f3c-candidate/03-coverage-matrix.md` | cef0c8f878c14640cda6a9e456f012da5d8b7185ad445ee78ecb4932fc075c8d | exists |
| `review/f3c-candidate/04-requirement-evidence-index.md` | 4654cd4b9419972c85ffabe3bec69a8f730715604fb7c9ce043ac860f1c2b496 | exists |
| `review/f3c-candidate/05-reviewer-instructions.md` | 649ddca9236641abd2b05579716bd605465b19c2c072954bd844fbb7f61b1558 | exists |
| `review/f3c-candidate/06-run-log.md` | de4f2f44a6b2e2ef0c088af6e57f006a9ecda3cc1401496a7de398798d1a8f48 | exists |
| `review/f3c-candidate/evidence/reconcile-fresh.txt` | (copied from `.output/reconcile-fresh.txt`) | to copy |
| `artifacts/f3a/V3-runtime.bytecode` | sha256 9a029d61… (matches manifest) | exists |
| `artifacts/f3a/V3-creation.bytecode` | sha256 d375a09c… (matches manifest) | exists |
| `data/escrow-custody-v3-build.json` | runtimeCodeHash 0x87615e3d…; bytecode hash as 02-build-facts | exists |
| `verifier/v4-candidate-identity-31337-v3.json` | runtimeCodeHash 0x87615e3d… | exists |
| `mainnet/funding-rule-approval.md` | APPROVED Option A | exists |

## Checksum cross-check (the two that matter)
- F3A stored runtime → sha256 `9a029d61…` == F3A manifest `runtimeBytecodeSha256` ✅
- F3A stored runtime → keccak `0x60ea1fcb…` ≠ F3B pin `0x87615e3d…` → the two lanes are different objects ✅ (this IS the provenance finding)
- F3B recompile (no evmVersion) → keccak == pin `0x87615e3d…` ✅ (reproduction of the pinned candidate)

## Known limitation
- The F3B deployed runtime object is not stored in the repo; its identity is the keccak pin. Lengths/bytes for the F3B runtime in 02-build-facts come from a fresh F3B-settings recompile, not from a stored object. This is disclosed in the package.

## ADDENDUM (F3C continuation — 2026-10-21, package commit a97c3e1d)

### New commands executed (once each, output captured)
1. `node scripts/test-custody-v3-realsafe-candidate.cjs` → **46/46 PASS**, exit 0 (`.output/v3-realsafe-candidate-run.txt`; evidence in `evidence/f3c-candidate-realsafe-exports/`): deployed runtime keccak asserted == `0x87615e3d…` before behavior; real Safe ERC-1271 positives/negatives; same-block governance ordering; sequential threshold-invalidation; separate-process verifier `VERIFIED_WITH_LIMITATIONS` (exit 0) over read-only RPC.
2. Focused F3B/Cancun rebuild from the existing clean locked install (`Temp\saax-phase3b-clean-KJElTm`, `npm ci` +797 packages) → creation object byte-identical to the artifact (keccak `0x58a83b0e…`, sha256 `0899e556…`, len 22540); deployed runtime keccak `0x87615e3d…` == pin; runtime sha256 `dbb05777c38b818de0c297322d35afaf2014a87fc540f7750c5547dcfc0ee6d4` (newly recorded); metadata evmVersion cancun; compiler `0.8.26+commit.8a97fa7a`. Evidence: `review/f3c-candidate/evidence/fresh-install-rebuild.json`.

### Files validated for existence + hashes (sha256 over file bytes)
| File | sha256 | Status |
|---|---|---|
| `scripts/test-custody-v3-realsafe-candidate.cjs` | bf54e38198572a6eb8e911c8fad6ee883152e9a751d2ce83af07413d940316aa | exists (harness source) |
| `evidence/f3c-candidate-realsafe-exports/fresh-install-rebuild.json` | 21dce567a4c836d15f0c11da9a7d8cd1b8e4c60a0c547fb886421b45257df960 | exists |
| `review/f3c-candidate/evidence/candidate-realsafe-console.txt` | 35d058b62c76b3fad05b641be5911b4dc243fa1841e72e880b74afcae7bb84cf (harness 46/46 transcript) | exists |
| `review/f3c-candidate/evidence/candidate-realsafe-separate-process.txt` | a319cc75019540ee7404f3ae0bc47ada975f9c49c8b7f5ea8a044b6267c05c95 (verifier transcript, exit 0) | exists |
| `review/f3c-candidate/evidence/candidate-realsafe-export.json` | 9dcb69d6c0b573c908e2044a6c8e8e1ca84cf9ff6c1c5e65fbb51c872c986c6e (v4 export) | exists |
| `review/f3c-candidate/evidence/candidate-realsafe-run-record.json` | bcd2ef41d6d1a04a766ad768279dbd7283655cc1fd13acc8a45d5d2a3c655af9 (46/0; sameBlockIndexes 0<1<2, statuses 1/1/0) | exists |
| `review/f3c-candidate/evidence/candidate-realsafe-results.json` | 5b706c548561a06359742b35e9bbe3e34879cedab01a2ac2faddf5d7fec7ffa2 (passed 46, failed 0) | exists |

### Verifier limitation (unchanged, precise)
`verify-v4.js` establishes transaction-time authorization via the success of the canonical direct call into the allowlisted runtime (execution witness). It does NOT re-read Safe threshold/owner state or make a post-block wallet call (no Safe governance state replay). This limitation is reported in the harness output and run log; it is not weakened.

### Coverage/reproduction status after this continuation
- Category C (exact-candidate test coverage) → ✅ DONE (real-Safe ERC-1271 + same-block governance on the pinned F3B object, 46/46). The full 83/540 F3A-target batteries remain Paris-only (not candidate coverage).
- Category A/B (artifact reproduction + fresh locked-install reproduction) → ✅ DONE; the exact F3B/Cancun artifact is now also rebuilt byte-identically from the committed source using the freshly installed locked deps (fresh-install-rebuild.json).
- Category D (deployment-target compatibility 84532) → ❌ EXPLICITLY UNRESOLVED. Local Cancun execution and config blocking V3 on 84532 do not establish target-chain compatibility.
- Category E (independent review + production prerequisites) → ❌ NOT DONE.
- Package remains NOT FROZEN. No freeze tag, no release, no push, no deployment, no public-chain writes, no spending.

## ADDENDUM (F3C continuation 2 - 2026-10-21, HEAD 9066ace6)

### New command executed (once)
1. 
ode scripts/test-custody-v3-candidate-boundary.cjs -> **161/161 PASS**, exit 0 (.output/v3-candidate-boundary-run.txt; evidence evidence/f3c-candidate-boundary-exports/): deployed runtime keccak asserted == 0x87615e3d before any behavior; funding before/at/after RDL; release/resolve/mutual boundaries at minReleaseTime and RDL; refunds without min-release wait; timeout before/at/after finalCutoff; RDL==CUT equality + intentional gap; future-skew/expiry; escrow-scoped verdict/mutual nonce classes; 12 fuzz rounds seed 0xC4A (state-unchanged, head class, no double payout, totalHeld==outstanding).

### Files validated for existence + hashes (sha256)
| File | sha256 | Status |
|---|---|---|
| scripts/test-custody-v3-candidate-boundary.cjs | 06d974e1088aa4707c3fb0c8bfee76f795216592cf5ace12f4720834ebab5c6 | exists (harness source) |
| .output/v3-candidate-boundary-run.txt | 284aa1910b61b1e924739e451302086f4e40915b3270a881f9d847eb8cfd4daa | exists (161/161 transcript) |
| evidence/f3c-candidate-boundary-exports/results.json | 84c8f7ef94bb38aee3003203beeb29cea14c559cfa6d81fac4d96328447bf889 | exists (passed 161, failed 0) |
| evidence/f3c-candidate-boundary-exports/run-record.json | c3d453d65d946740417f21df64990087da71b415c3c7201ed9df5ffde869a384 | exists |

### Category status after this continuation
- Category C (exact-candidate test coverage) -> âœ… DONE: real-Safe 46/46 + boundary/invariant 161/161 on the pinned F3B object. Complete required-control list is now evidenced on the candidate; the full 83/540 F3A batteries remain Paris-only (documented as superset, not required-control evidence).
- Category D (deployment-target compatibility 84532) -> âŒ EXPLICITLY UNRESOLVED (unchanged).
- Category E (independent review + production prerequisites) -> âŒ NOT DONE (unchanged).
- Package remains NOT FROZEN. No freeze tag, no release, no push, no deployment.