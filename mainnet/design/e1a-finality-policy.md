# E1A — FinalityAdapter explicit safe/finalized checks + worker policy dispatch

Baseline: `999c4a15` (HEAD before E1A). Commit: `932e7ea1` (local only, no push).

## What changed

### `worker/d2-finality.js` — FinalityAdapter

- **Trusted-config policy selection** (never inferred from chain data):
  `local-confirmations` | `op-stack-safe` | `op-stack-finalized`, passed as
  trusted configuration at construction. Unknown modes throw at construction
  (`FINALITY_POLICY_UNSUPPORTED`), fail closed.
- **Chain gating**: local synthetic confirmations are allowed ONLY on chain
  `31337` (`finality-chain-31337`; non-31337 local policy throws
  `FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337`). Public policies refuse mainnet
  activation (`FINALITY_MAINNET_NOT_ACTIVATED` on chain 1).
- **Receipt identity + chain + canonical-block verification**: the receipt
  must carry the requested tx hash, the canonical block at the recorded
  height must still match `receipt.blockHash` (`REORG_RECEIPT_BLOCK_HASH_CHANGED`),
  and the included block must be covered by the required safe/finalized head.
- **Bounded ancestry/RPC work**: coverage by a head is verified by walking the
  head's parent chain (hash-aware, with number fallback) up to `maxDepth`
  (default 256). If the included block is not reachable within bounds →
  `BOUND_EXCEEDED`; a missing required tagged head → `TAG_UNAVAILABLE`. Both
  fail closed — an unavailable tag/history never passes.
- **SAFE vs FINALIZED**: a receipt covered by the OP Stack `safe` head but not
  the `finalized` head is SAFE (included+safe), NOT consensus-finalized. The
  `finalized` policy requires finalized-head coverage.
- **RPC trust assumptions (documented in module header)**: the configured
  provider/head readers are trusted sources of the safe/finalized tags; we do
  not re-derive consensus from receipts. `[MOCK]` providers simulate tags;
  `[REAL]` local EVM 31337 has no safe/finalized tags and is local-only.
- **RPC_DISAGREEMENT**: `observePublicHead(tag)` records an observation; two
  ACTUAL conflicting observations of the same head block (same number,
  different hash) → `disagreed: true`. A single unchanged head is NOT a
  disagreement.
- **Persisted stall detection**: `checkStall(key)` persists the latest observed
  head block + timestamp via an injectable progress store (in-memory default).
  FINALITY_STALL is reported ONLY when no head progress occurs over the
  configured `stallMs` threshold — one unchanged head alone is never a stall.
- **`fixedWaitFinality`** still never returns final (`FIXED_WAIT_IS_NOT_FINALITY`).

### `worker/d2-store.js` — durable state

- Guarded `ALTER TABLE broadcast_attempts ADD COLUMN finality_state TEXT`
  (values `LOCAL` / `INCLUDED` / `SAFE` / `FINALIZED`; `NULL` for legacy rows).
- `recordIncluded(...)` persists `finality_state` (default `INCLUDED`).
- `recordFinalized(opId, attemptNum, outcome, finalityState)` persists the
  explicit state.
- `recordSafeTerminal(opId, attemptNum, outcome)` persists a SAFE terminal
  (lifecycle FINALIZED, finality_state SAFE — never labeled FINALIZED).

### `worker/d2-worker.js` — worker policy dispatch

- `reconcileOutcome` dispatches finality through
  `finality.establishFinality(receipt, {txHash})` instead of the local-only
  path. A failed public check NEVER falls back to local confirmations.
- Persists the observed finality state accurately on both the not-final
  (INCLUDED / SAFE when safe-covered-but-not-finalized) and final
  (`LOCAL` / `SAFE` / `FINALIZED`) paths.
- Reorg reconciliation is unchanged in outcome (returned to reconciliation by
  hash, never a second business action). `_recheckAfterReorg` now uses the
  policy-aware path and persists the policy-accurate finality state on
  `FINALIZED_AFTER_REORG`.
- **FINALIZED_CONTRADICTION** (blocking incident): a reorg/
  canonical-block-mismatch signal for an attempt already recorded
  consensus-finalized (`FINALIZED` or `LOCAL` state) raises a blocking
  `FINALIZED_CONTRADICTION` incident instead of silently re-reconciling. The
  terminal-attempt path also probes the recorded included block against the
  current canonical chain and raises the same blocking incident if a reorg
  rewrote finalized history. No re-execution, no re-broadcast.

## Tests

`scripts/test-e1-finality.cjs` — 33 assertions, all pass (exit 0).
- `[REAL]` local EVM 31337: local-compat policy + LOCAL_ONLY note; included
  not-final; confirm → FINALIZED with finality_state LOCAL; restart during
  wait (no re-execution, terminal stays); no duplicate execution; local
  success never claimed as public consensus finality; local policy refused on
  84532; mainnet public policy not activated.
- `[MOCK]` OP Stack: safe policy satisfaction (SAFE, not FINALIZED); finalized
  policy not satisfied while only safe; finalized satisfied after head advance;
  canonical-block mismatch (reorg returned, no pass, no duplicate execution);
  receipt disappearance/reorg; unsupported safe tag → TAG_UNAVAILABLE; bounded
  exhaustion → BOUND_EXCEEDED; RPC_DISAGREEMENT (two actual conflicts) and
  unchanged-head-is-not-disagreement; persisted stall (threshold) and progress
  resume; finalized contradiction → FINALIZED_CONTRADICTION blocking incident;
  no fallback from failed public check to local confirmations.

## Regressions (all exit 0)

- `scripts/test-d2-worker.cjs` — 40/40 (D2 broadcast/reconcile/crash/reorg).
- `scripts/test-d3-integration.cjs` — 47/47.
- `scripts/test-d3-closure-export.cjs` — 21/21.
- `scripts/test-d3-expiry-semantics.cjs` — 6/6.

## Durable-state semantics (summary)

| finality_state | meaning | when set |
|---|---|---|
| `LOCAL` | local-test confirmation (chain 31337) — NOT public finality | local policy final |
| `INCLUDED` | mined, not yet covered by required head | not-final under any policy |
| `SAFE` | covered by OP Stack safe head; NOT consensus-finalized | safe policy final, or finalized-policy intermediate |
| `FINALIZED` | covered by OP Stack finalized head | finalized policy final |

Attempt lifecycle status is unchanged (`PENDING`/`SUBMISSION_UNCERTAIN`/
`INCLUDED`/`FINALIZED`/`REVERTED`/`BLOCKED`); `finality_state` is an explicit,
separate axis so SAFE is never confused with consensus-finalized.

## Remaining E1B scope (exact, NOT done here)

1. **Verifier integration**: wire the finality/safe/finalized state into the
   v4 verifier's lifecycle ceiling (the `VERIFIED_WITH_LIMITATIONS` candidate
   ceiling) so a SAFE-only or included-not-finalized record is never reported
   as fully verified.
2. **Public read-only observation**: E1B performs the read-only Base Sepolia
   observation (chain 84532) against the OP Stack safe/finalized tags with the
   public policy active under trusted configuration — no broadcast, no
   spending, no mainnet activation. This requires the trusted-config policy
   to be active for a real chain id (the adapter already supports it; the
   activation is configuration, not code).
3. **Verifier allowlists / deployment fixtures**: intentionally NOT modified
   in E1A (constraint honored). E1B verifier integration must preserve them.

## Constraints honored

- No push, no deployment, no public-chain writes, no spending, no production
  secrets, no mainnet activation.
- Preserved unrelated working-tree changes and historical fixtures.
- Local-chain success is always labeled local, never public-consensus finality.