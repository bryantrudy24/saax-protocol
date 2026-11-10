# F3A-vs-F3B Provenance Finding — CORRECTION RECORD (2026-10-20)

## What the earlier reconciliation claimed (INCORRECT)
The F3C status document (mainnet/f3c-status.md §2, prior text) reconciled F3A and F3B as:
"F3A runtimeBytecodeSha256 is SHA-256 of the runtime binary; the F3B runtimeCodeHash is keccak256 of the SAME binary — two different digest functions over the identical deployed object, hence different hash strings by construction. Same compiler, same settings (evmVersion default paris in F3A manifest, omitted-but-identical in F3B artifact)."

**This claim is WRONG.** The two lanes do NOT share identical runtime bytes.

## What the artifacts and fresh recompilation prove
Same source revision: contracts/SAAXEscrowCustodyV3.sol, sha256 9bd413ac145b7fe0709ef82aed062d2c4290dcfa7dc75c1bc69b65b794cdbc76 (unchanged between F3A `c7150105`, F3B `5bd19ba2`, and HEAD `2e49625b`).

| Lane | Settings (solc 0.8.26+commit.8a97fa7a, optimizer 200, viaIR) | Effective EVM target (compiler metadata) | Creation hexLen/bytes | Runtime hexLen/bytes | Runtime keccak256 | Runtime sha256 |
|---|---|---|---|---|---|---|
| F3A | evmVersion EXPLICIT 'paris' | **paris** | 23618 / 11809 | 23076 / 11538 | 0x60ea1fcbf7011a919ffd44752ab6152c117f146d0d6437ed8eedee9f1b9db9f6 | 9a029d6131b5de3a666b641effa5ea6baca7f02981896263b8bb451c202a6e10 |
| F3B | evmVersion OMITTED (defaults) | **cancun** (solc 0.8.26 default; verified via metadata) | 22540 / 11270 | 22014 / 11007 (recomputed) | 0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3 | (not stored in artifact; keccak pin only) |

- Fresh recomputation of the F3A lane (explicit paris) reproduces keccak 0x60ea1fcb… and sha256 9a029d61… — matches the committed F3A manifest exactly.
- Fresh recomputation of the F3B lane (evmVersion omitted) reproduces keccak 0x87615e3d… — matches the committed F3B artifact + v3 identity exactly.
- The two lane outputs are DIFFERENT bytecode: hex length differs by 1062 (creation) / 1062 (runtime), keccak and sha256 differ (PUSH0/opcode differences from cancun vs paris). A net length difference is NOT the exact count of changed executable bytes; it is a different compilation target producing a different object.
- The F3B artifact does NOT store its deployed runtime object — only the keccak pin (data/escrow-custody-v3-build.json — `bytecode` is the CREATION object). The F3B runtime bytes were recomputed above for the length/table; the repo-owned identity for the deployed V3 runtime remains the keccak pin 0x87615e3d….

## What this means
- F3A tests (test-custody-v3.cjs 83/0, test-custody-v3-realsafe.cjs 25/0, test-custody-v3-fuzz.cjs 540/0, and the phase3b-v4 41/0 / phase3c-v4 25/0 suites) exercised bytecode compiled with the 'paris' target (hardhat.config.js declares evmVersion paris for the in-tree compile). They do NOT by themselves demonstrate coverage of the F3B/F3C candidate runtime (cancun, keccak 0x87615e3d).
- The integrated V3 harnesses that deploy the F3B artifact (data/escrow-custody-v3-build.json) — test-v3-integrated-flow.cjs (26/0), test-f3c-two-worker-contention.cjs (14/0), _f3c-v4-export-producer.cjs (7-outcome exports, 22/0) — DO exercise the exact F3B candidate runtime on local EVM 31337. Their check "runtime equals repository-owned identity" compares the deployed code's keccak to the pinned 0x87615e3d — asserted BEFORE any behavior test in those harnesses.
- Any claim that "F3A tests cover the F3B candidate" is a test-provenance error and must not appear in a freeze package.

## Correction action
This record supersedes the prior reconciliation text. The build-provenance issue is RESOLVED as a documented difference (two compiler targets from one source), NOT as identical-bytes/different-digest. All earlier historical reports are preserved; this is the correction to the current status and review package.