# E1B — V4 finality verification integration + read-only Base Sepolia evidence

Baseline: `c990792e` (HEAD before E1B). Local commit: `a8148aff` (local only, no
push). Preceding: `932e7ea1` (E1A implementation), `c990792e` (E1A design note).

## What changed

### `verifier/v4-finality-adapter.js` (new)

Trusted-config seam between the v4 candidate verifier and the E1A
`FinalityAdapter` (`worker/d2-finality.js`):

- **Policy selection is trusted configuration, never export-owned.** Modes:
  `local-synthetic` (alias `local-confirmations`, chain 31337 only) |
  `op-stack-safe` | `op-stack-finalized`. Unknown modes fail closed
  (`FINALITY_POLICY_UNSUPPORTED`).
- **Read-only provider binding**: wraps an ethers `JsonRpcProvider` so the
  adapter reads blocks, receipts, and the OP Stack `safe`/`finalized` tagged
  heads through `eth_getBlockByNumber` (hex-quantity / tag / hash handling).
  Only `eth_*` READ methods are ever invoked.
- **`observeFinality(opts)`**: returns `{final, mode, reason, safeCovered,
  finalizedCovered, safeHead, finalizedHead, includedBlock, depth,
  observedAt, policy}`. Exact observed status on every non-final path:
  `RECEIPT_ABSENT`, `RECEIPT_IDENTITY_MISMATCH`, `CANONICAL_BLOCK_UNAVAILABLE`,
  `REORG_RECEIPT_BLOCK_HASH_CHANGED`, `TAG_UNAVAILABLE`, `BOUND_EXCEEDED`,
  `UNCOVERED_WITHIN_BOUNDS`, `INCLUDED_ABOVE_HEAD` — all fail closed.
- **SAFE vs FINALIZED**: a receipt covered by the OP Stack `safe` head but not
  `finalized` is SAFE (`safeCovered=true, finalizedCovered=false`), never
  consensus-finalized. The `op-stack-finalized` policy requires finalized-head
  coverage; safe coverage alone is insufficient.
- **Bounded traversal preserved**: ancestry verification is a hash-aware
  parent walk bounded by `maxDepth` (default 256). A transaction beyond the
  bound reports `BOUND_EXCEEDED` and fails closed. The bound is NOT widened
  or removed to make old history pass.

### `verifier/verify-v4.js` — finality integration

- `verifyV4(exp, rpcUrl, finalityPolicy)` and `cli(exp, rpcUrl,
  finalityPolicy)` accept the trusted-config policy. The CLI entry point
  (`verify-export.js`) reads it from `SAAX_V4_FINALITY` — operator
  configuration, never the export.
- **Monotonic strength order**: `local-synthetic` (0) < `op-stack-safe` (1) <
  `op-stack-finalized` (2). The export's declared `finality.mode` may be equal
  or WEAKER than the trusted config (trusted config is what the verifier
  enforces — strengthening is safe). An export claiming a STRONGER mode than
  the trusted config is rejected as an overclaim/downgrade attempt
  (`export finality mode claims more than the trusted policy enforces`).
- **Coverage set**: funding and settlement transactions (the ones whose
  receipts/blocks are canonically verified above) are the transactions whose
  finality stage is evaluated consistently, together.
- **Local-synthetic gate unchanged**: in local mode the export must declare
  `local-synthetic`; chain 31337 only; the boundary check remains.
- **Result**: `finality: { mode: trustedMode, safeStage, finalizedStage,
  observations }` records what was actually enforced. A SAFE-stage observation
  emits a limitation explicitly stating it is not consensus finality. The
  overall ceiling stays `VERIFIED_WITH_LIMITATIONS` — neither a SAFE nor a
  FINALIZED observation produces unrestricted `VERIFIED`.
- **Anchor gate preserved**: `v4-anchor.js` still requires the export's
  declared `finality.mode === 'local-synthetic'` (local-era EAS gate). A
  public finality observation therefore runs under a local-synthetic-declared
  export with the trusted config selecting the stronger enforced policy.

### `scripts/test-e1b-finality.cjs` — labeled mock battery (26 assertions)

`[MOCK]` OP Stack tag simulations + local compatibility:
local policy 31337-only fail-closed; SAFE satisfied vs FINALIZED-not-satisfied
wording; finalized satisfied after head advance; included-but-insufficient
(INCLUDED_ABOVE_HEAD); wrong receipt identity (RECEIPT_IDENTITY_MISMATCH);
reorg canonical-block change (REORG_RECEIPT_BLOCK_HASH_CHANGED); missing safe
tag (TAG_UNAVAILABLE); bounded exhaustion (BOUND_EXCEEDED); policy aliases and
object-form resolution; exporter-supplied confirmations cannot lower; mainnet
public policy refused (FINALITY_MAINNET_NOT_ACTIVATED); structured observation
+ read-only non-mutation.

### `scripts/test-e1b-verify-v4.cjs` — separate-process integration battery (8 assertions)

Runs ONE genuine local EVM 31337 lifecycle export (custody V2 + official EAS
1.7.1 + Safe 2-of-3 + MockUSDC, exact producer pattern) through
`verifier/verify-export.js` in a FRESH PROCESS per case (no app DB, no
participant keys), over a read-only RPC proxy:
- `[LOCAL]` default policy -> `VERIFIED_WITH_LIMITATIONS`, local-synthetic
  boundary check, no public-f finality claim.
- `[PUBLIC]` trusted `op-stack-safe` -> SAFE-stage observed (safeStage=true,
  finalized=false), never finalized; limitation states it is not consensus
  finality. (The local EVM RPC reports its latest block as the `safe` tag,
  demonstrating the read-only SAFE-stage path end-to-end.)
- `[NEG]` export claiming a stronger mode than trusted config -> rejected
  (downgrade/overclaim attempt).
- `[NEG]` 84532 public deployment identity claim remains unsupported
  (INCOMPLETE, no trust-any green path).
- `[LOCAL]` separate-process verification returns without app DB access.

### `scripts/observe-e1b-sepolia.cjs` + `evidence/e1b-sepolia-observation.json`

Read-only Base Sepolia (chain 84532) observation of the committed transaction
hashes from `evidence/terminal-state-escrows.json` (fundTx / refundTx /
disputeTx, 4 transactions):

- Chain identity validated (`eth_chainId` = 84532).
- Every committed transaction: receipt present, status 0x1, canonical block
  hash match, transaction present in canonical block.
- Finality under both public policies: **bounded ancestry walk fails closed
  with `BOUND_EXCEEDED`** (these txs are ~100k blocks deep; the default
  bounded window is 256 — the limitation is reported, the safety check is not
  removed).
- Separately labeled arithmetic head-position note (non-walking): included
  block <= safe/finalized head numbers — consistent with eventual coverage,
  explicitly NOT ancestry-walk proof.
- Observation time, head references, policy, and RPC trust assumptions
  recorded. The result is an RPC observation, never independent consensus
  reconstruction.

## Tests / counts / exit codes (this run)

- `scripts/test-e1b-finality.cjs` — 26 passed, 0 failed, exit 0.
- `scripts/test-e1b-verify-v4.cjs` — 8 passed, 0 failed, exit 0.
- `scripts/observe-e1b-sepolia.cjs` — exit 0 (chain matches, all receipts
  canonical); finality bounded-walk results recorded as observations.
- Regressions: `scripts/test-e1-finality.cjs` (E1A battery) re-run — see the
  E1B run record for counts. E1A's adapter/store/worker files were NOT
  modified by E1B (verified: `git diff 932e7ea1 -- worker/` empty apart from
  the pre-existing unrelated working-tree changes preserved).

## Deployment identity restrictions (unchanged)

- The historical 84532 `v4-eas-policy.json` / `v4-candidate-identity.json`
  profiles remain the historical LOCAL-EVIDENCE profiles, NOT public Base
  Sepolia deployments. No trust-any-address flag, no EAS/custody bypass, no
  whitelist of an unreviewed public deployment was added.
- A lifecycle export claiming 84532 public deployment identity remains
  unsupported (INCOMPLETE_UNSUPPORTED) — verified by a focused negative.
- Mainnet admission stays disabled (`FINALITY_MAINNET_NOT_ACTIVATED` on chain
  1; no mainnet profile exists). The full public-chain export remains
  unsupported; the finality COMPONENT is what was integrated and
  demonstrated, independently of deployment identity.
- No push, no deployment, no public-chain writes, no spending, no production
  secrets.

## Remaining gates (unchanged from E1A/check-map)

- Signer: external signer integration (D4B) and signing isolation remain
  operator/activation gates.
- Governance: approved 2-of-3 Safe governance provenance is NOT established by
  successful ERC-1271 execution; journal attests records, not authorization.
- Audit: independent security/economic audit (readiness gate G4) remains
  outstanding; conformance tests are not an audit.
- Operating: mainnet admission, public deployment identity review, RPC
  capability requirements (archive/non-archive, safe/finalized tag support,
  multiple providers for disagreement detection), and finality policy approval
  for public-chain operation remain before any public export is permitted.

## Definition of done (E1B)

- [x] Worktree reconciled (generated E1B artifacts isolated; unrelated working
      tree changes preserved untouched).
- [x] Finality adapter integrated into v4 verification through trusted
      configuration.
- [x] SAFE != FINALIZED wording and policy satisfaction demonstrated.
- [x] Included-but-insufficient, wrong receipt/block/chain, missing
      tags/history, bounded exhaustion, exported downgrade attempts,
      unsupported public deployment identity covered.
- [x] Separate-process verifier behavior without app DB access covered.
- [x] Read-only Base Sepolia observation recorded with real committed hashes.
- [x] Docs updated (this note, check-map, operating requirements).
- [x] Committed locally, not pushed.