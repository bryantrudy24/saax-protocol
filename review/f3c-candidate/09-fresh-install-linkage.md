# Fresh-Install Dependency Provenance Linkage (item 4) — recorded 2026-10-21

## Clean installation identity (from retained records)
Existing clean `npm ci` install at `C:\Users\Bryant\AppData\Local\Temp\saax-phase3b-clean-KJElTm`
(created from the committed tree; `npm ci --ignore-scripts --no-audit --no-fund`, exit 0,
+797 packages; recorded in `evidence/.preserved-f3c-repair/clean-install.txt`).

| File | SHA-256 | Notes |
|---|---|---|
| clean install `package.json` | `3efacbf68d7ba540f00c56fec3ad03490810674282b6e0ea321fff8166d14ea0` | byte-identical to repo `package.json` |
| clean install `package-lock.json` | `074cb7e21c5283d00948b1c17c248ceb6e3bb11e667c71a27ecd6532d6153cd3` | byte-identical to repo `package-lock.json`; lockfileVersion 3 |
| repo `package.json` (HEAD 9066ace6 == 2e49625b) | `3efacbf68d7ba540f00c56fec3ad03490810674282b6e0ea321fff8166d14ea0` | — |
| repo `package-lock.json` (HEAD 9066ace6 == 2e49625b) | `074cb7e21c5283d00948b1c17c248ceb6e3bb11e667c71a27ecd6532d6153cd3` | — |
| clean install `node_modules/solc/soljson.js` | `35ba6661f3bdaed995fc7af14c405502290cf681b3fd062fe8738cfdf6db14ed` (9,056,722 bytes) | the ACTUAL compiler file used by the rebuild |
| repo `node_modules/solc/soljson.js` | `35ba6661f3bdaed995fc7af14c405502290cf681b3fd062fe8738cfdf6db14ed` | identical binary |
| rebuild script `scripts/_f3c-reconcile-runtime.cjs` | `e6fef95cda0d4efb4b5ed123b6905450d8514c19b5d643b913ccbb8c898cae46` | retained repro script |

## Compiler
- Path used by the rebuild: `C:\Users\Bryant\AppData\Local\Temp\saax-phase3b-clean-KJElTm\node_modules\solc\soljson.js`
- Version (`require('solc').version()`): `0.8.26+commit.8a97fa7a.Emscripten.clang`
- Lockfile pins `solc` at `0.8.26` (same package); the resolved binary hash above matches the
  repo's own `node_modules/solc/soljson.js` byte-for-byte.

## What the successful rebuild establishes
- The F3B/Cancun candidate artifact (`data/escrow-custody-v3-build.json`) is reproduced
  BYTE-IDENTICALLY (creation object keccak `0x58a83b0e…`, sha256 `0899e556…`, len 22540;
  deployed runtime keccak `0x87615e3d…` == pinned identity; runtime sha256
  `dbb05777c38b818de0c297322d35afaf2014a87fc540f7750c5547dcfc0ee6d4`) from the committed
  source using the freshly installed LOCKED dependencies (exact package.json + package-lock.json,
  exact soljson binary). Source sha256 `9bd413ac…`.
- This closes item 4's "dependency-provenance linkage" for the candidate build: the pinned
  artifact corresponds to the committed lockfile, and a clean locked install reproduces it.

## Relationship to the candidate's build dependencies
- The lockfile at the clean install is BYTE-IDENTICAL to the repo's committed lockfile
  (`074cb7e2…`), and package.json is byte-identical too (`3efacbf6…`) — the clean install
  used the SAME lockfile as the candidate's build environment, not an older one. The
  compiler binary is also byte-identical to the repo's.
- Pinned core deps (from the shared lockfile): solc 0.8.26, @safe-global/safe-contracts 1.4.1,
  ethers 6.17.0, hardhat 2.22.4, @ethereum-attestation-service/eas-contracts 1.7.1.

## What remains unproven (dependency-provenance gap, if any)
- The candidate artifact was originally compiled in the MAIN working tree (not in the clean
  install). The rebuild proves the committed lockfile + committed source reproduce the artifact;
  it does NOT prove the original compilation happened in a pristine, unmodified environment
  (the original build output could in principle have been produced with the same inputs —
  the byte-identical reproduction makes any different-input explanation implausible, but the
  original compilation environment's full provenance is not independently reconstructible).
- No npm supply-chain verification (no `npm ci --dry-run` integrity attestation beyond the
  lockfile's own integrity hashes) was performed; the lockfile itself pins integrity hashes.

## Evidence files
- `review/f3c-candidate/evidence/fresh-install-rebuild.json` (rebuild result record)
- `evidence/f3c-candidate-realsafe-exports/fresh-install-rebuild.json` (copy)
- `evidence/.preserved-f3c-repair/clean-install.txt`, `repro-run.txt`, `repair-final.txt`
