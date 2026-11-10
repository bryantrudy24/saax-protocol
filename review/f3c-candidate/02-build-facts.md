# Exact Build Facts — SAAXEscrowCustodyV3 (both lanes)

Captured 2026-10-20 from saved artifacts + fresh recompilation. Every hash computed over the actual stored bytes (sha256 via Node crypto, keccak256 via ethers 6.17.0).

## Source
- File: `contracts/SAAXEscrowCustodyV3.sol` (relative to repo root)
- Full revision: unchanged across F3A `c7150105`, F3B `5bd19ba2`, F3C `29363a94`, F3C-REPAIR HEAD `2e49625b` — `git diff c7150105 2e49625b -- contracts/SAAXEscrowCustodyV3.sol` is EMPTY.
- Source SHA-256: `9bd413ac145b7fe0709ef82aed062d2c4290dcfa7dc75c1bc69b65b794cdbc76` (38636 bytes UTF-8)
- Source keccak256: not meaningful for source; SHA-256 is the recorded digest (matches F3A manifest `sourceSha256`, F3B artifact `sourceSha256`, v3 identity `sourceSha256`).

## Compiler (both lanes, identical)
- `solc 0.8.26+commit.8a97fa7a.Emscripten.clang` (lockfile-pinned local, verified `require('solc').version()`)
- Optimizer enabled, runs 200; viaIR true.

## The one setting that differs
| | F3A lane | F3B/F3C candidate lane |
|---|---|---|
| evmVersion | `'paris'` EXPLICIT | OMITTED → solc 0.8.26 default, which is **cancun** |
| Effective EVM target | paris | cancun (confirmed from compiler metadata `settings.evmVersion` in the emitted metadata) |

## F3A lane — committed artifact `artifacts/f3a/`
| Object | hex length | bytes | keccak256 | sha256 |
|---|---|---|---|---|
| Creation bytecode (`V3-creation.bytecode`, `0x`-prefixed, no constructor args, metadata suffix embedded) | 23618 | 11809 | 0x17b6c0ea373c9d69dfeba9435326dc98dc3b62d780df4fbaeb985dadc0e0736b | d375a09c77b57e995808b86b95cf4bcb8659324de56cfae1071086fed8244b3f |
| Runtime bytecode (`V3-runtime.bytecode`) | 23076 | 11538 | 0x60ea1fcbf7011a919ffd44752ab6152c117f146d0d6437ed8eedee9f1b9db9f6 | 9a029d6131b5de3a666b641effa5ea6baca7f02981896263b8bb451c202a6e10 |

Manifest `artifacts/f3a/v3-build-manifest.json` (committed in F3A `c7150105`, working-tree only timestamp changed on 2026-10-20): creationBytecodeSha256 `d375a09c…`, runtimeBytecodeSha256 `9a029d61…`, inputJsonSha256 `c9249e0927ce6b07833a933f5adee820e8095147d003568837afdb3e8278632f`, sizes creation 23618 / runtime 23076. All recompute identically from the stored bytes.

## F3B/F3C candidate lane — committed artifact `data/escrow-custody-v3-build.json`
| Object | hex length | bytes | keccak256 | sha256 |
|---|---|---|---|---|
| Creation bytecode (`bytecode` field) | 22540 | 11270 | 0x58a83b0e76ad0d778a4623533271ec6b5502060259eefa572233b27a738ace34 | 0899e5568c014cbf2ed562a8d2258b9e5878a9d8a272936f7a0d82978053d1f8 |
| Deployed runtime (recomputed; NOT stored in the artifact) | 22014 | 11007 | **0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3** | dbb05777c38b818de0c297322d35afaf2014a87fc540f7750c5547dcfc0ee6d4 (recorded 2026-10-21 from the fresh-install rebuild, `review/f3c-candidate/evidence/fresh-install-rebuild.json`) |

- The F3B artifact records ONLY the runtime keccak pin (`runtimeCodeHash`); it stores creation `bytecode` + ABI. The deployed runtime object was recomputed under the F3B settings for this table.
- `verifier/v4-candidate-identity-31337-v3.json` pins: `runtimeCodeHash 0x87615e3d…`, `sourceSha256 9bd413ac…`, compiler `0.8.26+commit.8a97fa7a.Emscripten.clang`, settings `{optimizer 200, viaIR}` (no evmVersion key), policy `local-immutable-candidate-v3-31337`, chainId 31337.
- `verifier/verify-v4.js` re-checks `ethers.keccak256(eth_getCode(addr)) === identity.runtimeCodeHash` at the settlement block before any behavior verification (line ~173). F3B→HEAD identity file is bit-identical (`git show 5bd19ba2:verifier/v4-candidate-identity-31337-v3.json` == working tree).

## Settings/constructor/metadata handling
- Constructor: `(perPositionCap, aggregateCap, fundingEnabled, admittedPolicyId, admittedPolicyDigest)`; caps and admission are constructor-set, no owner.
- No linked libraries; no immutable variables.
- Metadata suffix: both lanes embed solc metadata (CBOR) in creation + deployed objects; hashes above include the metadata suffix. The F3B artifact's `bytecode` object likewise carries its metadata.
- `chainId` is bound at construction from `block.chainid` (31337 in all local deployments).

## Length reconciliation (the inconsistent numbers quoted earlier)
- F3A creation 23618 vs F3B creation 22540: −1078 hex chars (−539 bytes) — NOT the count of changed executable bytes; different compilation targets.
- F3A runtime 23076 vs F3B runtime 22014: −1062 hex chars (−531 bytes) — same caveat. Runtime-to-creation deltas differ between lanes (F3A: 23618−23076=542; F3B: 22540−22014=526) because constructor epilogue code differs by target.
- Prior diagnostics that quoted only "net length difference" without decomposition are superseded by the table above.

## Repro commands
```
node scripts/_f3c-reconcile-runtime.cjs   # recompiles both lanes, compares all hashes (output in this package: evidence/reconcile-fresh.txt)
node -e ... explicit paris compile        # see 08-commands-log for the exact inline recompiles
```

### Fresh-install rebuild linkage (added 2026-10-21)
Command: inline `node -e` F3B rebuild run from the existing clean locked install `Temp\saax-phase3b-clean-KJElTm` (fresh `npm ci` +797 packages; solc resolved at THAT install's `node_modules/solc/soljson.js`), reading the committed source from the repo. Result: creation object keccak `0x58a83b0e…` / sha256 `0899e556…` / len 22540 — byte-identical to the artifact's `bytecode`; deployed runtime keccak `0x87615e3d…` / sha256 `dbb05777…` / len 22014 — matches the pinned identity. Metadata: evmVersion `cancun`, compiler `0.8.26+commit.8a97fa7a` (see `review/f3c-candidate/evidence/fresh-install-rebuild.json`).