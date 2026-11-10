# E1D — bounded trusted-RPC finality assertions

Baseline: `7dce4d85` (HEAD before E1D). Local commit: after E1D (local only, no
push). Preceding: `7dce4d85` (E1C), `f22b59e6`/`a8148aff` (E1B), `932e7ea1`
(E1A).

## Trust model (official Base / OP Stack semantics)

OP Stack nodes expose three consensus states over JSON-RPC. Base's public RPC
accepts the corresponding block tags on `eth_getBlockByNumber`:

| stage | RPC tag | what the node asserts |
|---|---|---|
| soft finality (unsafe) | `latest` | the transaction is in an L2 block; ordering depends on the Sequencer (~2s on OP Mainnet). |
| safe | `safe` | the block's data has been published to an Ethereum block; ordering no longer depends on the Sequencer, but the Ethereum block can still reorg until Ethereum finalizes it. |
| hard finality | `finalized` | the Ethereum block containing the data has been finalized by Ethereum's consensus mechanism; as final as an ordinary Ethereum transaction. |

Sources:

- Optimism Docs — Transaction finality:
  https://docs.optimism.io/op-stack/transactions/transaction-finality
  ("OP Stack nodes expose these labels over JSON-RPC. The unsafe head is
  served as the latest block, and the safe and finalized heads back the safe
  and finalized block tags.")
- Base Docs — RPC Overview (block parameters):
  https://docs.base.org/base-chain/api-reference/rpc-overview
  (`"latest"` = most recently sealed block; `"safe"` = latest safe block;
  `"finalized"` = latest finalized block)
- Ethereum JSON-RPC (eth_getBlockByNumber tag semantics):
  https://ethereum.org/developers/docs/apis/json-rpc/

### How the node's assertions jointly establish the finding

For a transaction reference `T`, the trusted-RPC assertion (`TrustedRpcFinality.
assertHistoricalFinality`) establishes:

1. **T belongs to canonical block B.** The receipt is fetched by `T`; the
   receipt's recorded `blockNumber`/`blockHash` are read. The canonical block
   at that height (by `eth_getBlockByNumber`) must have the SAME hash as the
   receipt's recorded block hash, and `T` must be present in that canonical
   block's `transactions` list. (Same canonical-canonic membership the
   verifier already enforces; REQUIRED, never sufficient alone.)

2. **The required safe/finalized head is F.** The node's `safe` (and, for the
   finalized policy, `finalized`) tag is read via `eth_getBlockByNumber`. The
   tag IS the node's consensus-status assertion: per the OP Stack docs, the
   safe/finalized heads back exactly those tags.

3. **B is within the canonical prefix covered by F.** Because the node's tag
   asserts every canonical block up to its height is safe/finalized (the
   official tag semantics above), arithmetic coverage — `B.number <= F.number`
   — is the correct, bounded reading of that assertion for deep history. NO
   ancestry walk is performed or needed. (This is explicit and documented; the
   bounded-ancestry method, which walks parents, remains intact and unchanged.)

4. **Observations are sufficiently consistent across the verification window.**
   The required tag(s) are re-read at the end of the assertion and must
   re-present the SAME canonical hash at the SAME height. A normally ADVANCING
   head (higher number) is consistent by definition — it is not a reorg. A
   REGRESSING head (lower number) fails closed (`HEAD_REGRESSED`). A CHANGING
   head (same number, different hash) fails closed (`HEAD_BINDING_CHANGED`).
   The canonical latest head is also re-read; if it regressed below its own
   first reading, that is recorded and treated as a contradiction.

**Explicit trust boundary:** this relies on the RPC's canonical-chain and
consensus-status assertions. It is NOT independent consensus reconstruction
(no L1 state-root replay) and NOT a cryptographic ancestry proof. Canonical
membership ALONE remains insufficient — the required tagged-head coverage and
the consistency rechecks are mandatory, and every output carries the trust
model explicitly (`trustModel.kind = 'trusted-rpc-consensus-status-assertion'`).

## What changed

### `worker/d2-trusted-rpc-finality.js` (new)

`TrustedRpcFinality.assertHistoricalFinality(opts)` — the EXPLICIT, DISTINCT
trusted-RPC safe/finalized assertion for deep history:

- **Chain and transaction/receipt identity checks** — invalid tx hash
  (`INVALID_TX_HASH`), absent receipt (`RECEIPT_ABSENT`), receipt whose
  `transactionHash` disagrees with the asked hash
  (`RECEIPT_IDENTITY_MISMATCH`), incomplete receipt (`RECEIPT_INCOMPLETE`).
- **Canonical block/hash and transaction-membership checks** — unavailable
  canonical block (`CANONICAL_BLOCK_UNAVAILABLE`), block-hash mismatch
  (`CANONICAL_BLOCK_HASH_MISMATCH`), tx absent from the canonical block
  (`TX_NOT_IN_CANONICAL_BLOCK`), unverifiable member list
  (`TX_IN_BLOCK_UNVERIFIABLE`).
- **Required tagged-head observation** — missing `safe`/`finalized` tag
  (`TAG_UNAVAILABLE`), unsupported policy / tag (`FINALITY_POLICY_UNSUPPORTED`).
- **Coverage and consistency rechecks** — included block above the tagged head
  (`INCLUDED_ABOVE_HEAD`), regressing head (`HEAD_REGRESSED`), changing head at
  the same number (`HEAD_BINDING_CHANGED`), unavailable head
  (`HEAD_UNAVAILABLE`). Advancing heads are NOT reorgs (consistency policy
  documented above).
- **Bounded retries/request budget** — every `send()` is counted; a configured
  `requestBudget` (default 12) bounds total RPC work (`REQUEST_BUDGET_EXHAUSTED`,
  fail closed). Transient read failures are retried up to `retryLimit` (default
  2); persistent failure fails closed (`OBSERVATION_UNAVAILABLE`).
- **Explicit failure for contradictory, unstable, unavailable, or unsupported
  observations** — all of the above reasons fail closed (`final:false`).
- **SAFE is never FINALIZED** — `op-stack-safe` returns `SAFE_COVERED` with
  `finalizedCovered:false`; `op-stack-finalized` requires finalized coverage
  (safe coverage alone is `SAFE_ONLY`-class insufficient and fails).
- **Mainnet refusal + deployment-identity restrictions preserved** — chain 1
  public policy refused (`FINALITY_MAINNET_NOT_ACTIVATED`); local-synthetic
  remains chain-31337-only; no trust-any-deployment flag.
- **No ancestry walk** — correct method dispatch reused from E1C
  (`getBlockByRef` routes a 64-hex hash to `eth_getBlockByHash`, never to
  `eth_getBlockByNumber`; tags/quantities to `eth_getBlockByNumber`).
- Every result exposes `requests` (actual count), `requestLog` (actual
  methods+params), and `trustModel`.

### `verifier/v4-finality-adapter.js` (modified — additive)

`observeHistoricalFinality(opts)` — read-only trusted-config seam for the
trusted-RPC method. Policy selection stays TRUSTED CONFIG, never export-owned
(same `resolvePolicy`). `observeFinality` (the bounded-ancestry method) is
unchanged byte-for-byte; the module just gains the new function and export.

### `verifier/verify-v4.js` (modified — additive)

The finality METHOD is part of trusted configuration, never export-owned:

- Default (and E1A/E1B behavior, unchanged): `observeFinality`
  (bounded-ancestry).
- `SAAX_V4_FINALITY_METHOD=trusted-rpc` (operator env): the verifier uses
  `observeHistoricalFinality` for each funding/settlement reference.
- Any other value fails closed (`FINALITY_METHOD_UNSUPPORTED`).
- The export can never select the method or lower the policy (the existing
  export-mode-vs-trusted-policy strength check is unchanged).

### `worker/d2-worker.js` (modified — additive)

Worker finality policy dispatch:

- `opts.finalityMethod` is trusted configuration: `bounded-ancestry` (unset,
  unchanged default) or `trusted-rpc`; any other value throws at construction
  (`FINALITY_METHOD_UNSUPPORTED`).
- Under `trusted-rpc`, `reconcileOutcome` dispatches to
  `TrustedRpcFinality.assertHistoricalFinality` with the worker's trusted
  policy; under default, the existing `finality.establishFinality` path is
  unchanged. There is NO fallback from a failed trusted-rpc check to the
  bounded method and NO fallback from a failed public check to local
  confirmations — both fail closed.
- The durable `finality_state` mapping is preserved for trusted-rpc results:
  `op-stack-safe` -> `SAFE`, `op-stack-finalized` -> `FINALIZED`; SAFE is never
  labeled consensus-finalized.

### `scripts/test-e1d-trusted-rpc-finality.cjs` (new) — labeled mock battery (35 assertions)

`[MOCK]` labeled provider simulations; every mock records each `send()` so
tests assert the ACTUAL RPC methods used and the exact bounded request counts.

- Deep historical SAFE and FINALIZED positives (no ancestry walk; bounded
  request count; no hash routed as a block-number argument).
- Membership positive but required finality pending (`INCLUDED_ABOVE_HEAD`).
- Wrong receipt / block / chain (identity mismatch, canonical hash mismatch,
  tx-not-in-block, absent receipt, chain armed).
- Conflicting canonical views (reorg after first observation).
- Advancing vs regressing vs changing heads (advancing is NOT a reorg;
  regressing -> `HEAD_REGRESSED`; changing at same number ->
  `HEAD_BINDING_CHANGED`).
- Unsupported tags / history (`TAG_UNAVAILABLE`, `CANONICAL_BLOCK_UNAVAILABLE`,
  unsupported policy).
- Request-budget exhaustion and bounded retries (transient retry succeeds;
  persistent failure -> `OBSERVATION_UNAVAILABLE`).
- Configuration downgrade attempts (local-synthetic cannot satisfy a public
  policy; SAFE output never carries FINALIZED wording).
- SAFE never mislabeled FINALIZED.
- Mainnet refusal + explicit trust model / request log exposed.
- The existing bounded-ancestry method stays intact: for the SAME deep tx the
  E1C bounded method still reports `BOUND_EXCEEDED` (untouched, not widened).

### `scripts/observe-e1d-sepolia.cjs` + `evidence/e1d-sepolia-trusted-finality.json`

Read-only Base Sepolia (chain 84532) observation of the FULL committed
transaction hashes from `evidence/terminal-state-escrows.json` (fundTx /
refundTx / disputeTx, full 32-byte hashes). Chain identity validated
(`eth_chainId` = 84532). One fresh `TrustedRpcFinality` per (tx, policy)
assertion so each observation gets its full read budget.

- **Membership findings (separate)**: all 4 committed hashes canonical members
  (`CANONICAL_MEMBER`).
- **SAFE positives — 4/4**: both refunded and disputed funding/settlement
  txs are covered by the node's `safe` head assertion: `final=true`,
  `reason=SAFE_COVERED`, `safeCovered=true`, `finalizedCovered=false`.
- **FINALIZED — 4/4**: both records' funding/settlement txs are covered by the
  node's `finalized` head assertion: `final=true`, `reason=FINALIZED_COVERED`,
  `finalizedCovered=true`.
- Bounded request counts recorded per assertion (6–8 reads; budget 20).
- Anchor references (cid/digest) recorded alongside funding/settlement where
  the escrow records carry them (2 anchor refs).
- The result is an RPC observation of the node's canonical-chain and
  consensus-status assertions, NOT independent consensus reconstruction and
  NOT a cryptographic ancestry proof. **A component positive does not make a
  full public export supported** — the deployment identity axis remains
  unsupported (no trust-any-deployment flag, no public custody/EAS
  whitelist).

## Membership vs finality — the invariant (updated with E1D)

| finding | what establishes it | satisfiable by deep history? |
|---|---|---|
| `membership.member=true` | trusted RPC: receipt present, canonical block hash match, tx in canonical block | YES (no ancestry walk) |
| `finality.final=true` via bounded-ancestry (`SAFE_COVERED`/`FINALIZED_COVERED`) | bounded parent walk to the safe/finalized head + head-binding recheck | NO — fails closed `BOUND_EXCEEDED` beyond `maxDepth` (unchanged) |
| `finality.final=true` via trusted-RPC (E1D, `SAFE_COVERED`/`FINALIZED_COVERED`) | the node's OWN canonical-chain + consensus-status (safe/finalized tag) assertions with identity, canonical membership, coverage, and consistency rechecks | YES — deep history, NO ancestry walk, bounded request budget |

The configured assurance is never lowered: the E1D trusted-RPC method is a
DISTINCT, explicitly activated method (trusted configuration), and canonical
membership alone still never drives finality.

## Tests / counts / exit codes (this run)

- `scripts/test-e1d-trusted-rpc-finality.cjs` — 35 passed, 0 failed, exit 0.
- `scripts/observe-e1d-sepolia.cjs` — exit 0 (chain matches; 4/4 committed
  hashes canonical members; 4/4 SAFE positives and 4/4 FINALIZED positives
  recorded as RPC observations).
- Regressions (all exit 0):
  - `scripts/test-e1-finality.cjs` (E1A battery) — 33 passed, 0 failed.
  - `scripts/test-e1b-finality.cjs` (E1B adapter battery) — 26 passed, 0 failed.
  - `scripts/test-e1b-verify-v4.cjs` (E1B verifier battery) — 8 passed, 0 failed.
  - `scripts/test-e1c-historical-finality.cjs` (E1C battery) — 35 passed, 0 failed.
  - `scripts/test-d2-worker.cjs` (D2 worker battery) — 40 passed, 0 failed.

## Deployment identity restrictions (unchanged)

- The historical 84532 `v4-eas-policy.json` / `v4-candidate-identity.json`
  profiles remain the historical LOCAL-EVIDENCE profiles, NOT public Base
  Sepolia deployments. No trust-any-address flag, no EAS/custody bypass, no
  whitelist of an unreviewed public deployment was added.
- A lifecycle export claiming 84532 public deployment identity remains
  unsupported (INCOMPLETE_UNSUPPORTED).
- Mainnet admission stays disabled (`FINALITY_MAINNET_NOT_ACTIVATED` on chain
  1; no mainnet profile exists).
- The finality COMPONENT is what E1D demonstrates (read-only safe/finalized
  assertions against committed hash evidence); the full public-chain export
  remains unsupported.
- No push, no deployment, no public-chain writes, no spending, no production
  secrets.

## Remaining gates (unchanged from E1A/E1B/E1C)

- Signer: external signer integration (D4B) and signing isolation remain
  operator/activation gates.
- Governance: approved 2-of-3 Safe governance provenance is NOT established by
  successful ERC-1271 execution; journal attests records, not authorization.
- Audit: independent security/economic audit (readiness gate G4) remains
  outstanding; conformance tests are not an audit.
- Operating: mainnet admission, public deployment identity review, RPC
  capability requirements (archive/non-archive, safe/finalized tag support,
  multiple providers for disagreement detection), finality policy approval,
  and explicit operator activation of the trusted-RPC method
  (`SAAX_V4_FINALITY_METHOD=trusted-rpc` + `SAAX_V4_FINALITY=<policy>`) remain
  before any public export is permitted.

## Definition of done (E1D)

- [x] Trust model documented from official Base / OP Stack / Ethereum RPC
      sources; explicit that the assertion relies on the RPC's canonical-chain
      and consensus-status assertions (not independent consensus, not a
      cryptographic ancestry proof; canonical membership alone insufficient).
- [x] Distinct trusted-RPC method (`TrustedRpcFinality.assertHistoricalFinality`)
      with identity checks, canonical block/hash + membership checks, required
      tagged-head observation, coverage and consistency rechecks, bounded
      retries/request budget, explicit failure for contradictory/unstable/
      unavailable/unsupported observations.
- [x] Existing bounded-ancestry and membership-only methods intact (E1C battery
      and E1A/E1B batteries still pass; the bounded walk still reports
      `BOUND_EXCEEDED` for deep history — never widened).
- [x] Normally advancing head handled without treating every advance as a
      reorg; consistency policy defined precisely (advancing = consistent;
      regressing/changing = fail closed).
- [x] Export-supplied method/policy can never lower trusted configured
      requirements; mainnet activation disabled.
- [x] Worker and verifier finality policy wired (worker `finalityMethod`,
      verifier `SAAX_V4_FINALITY_METHOD`), default behavior unchanged.
- [x] Tests: deep SAFE/FINALIZED positives, membership-pending finality,
      wrong receipt/block/chain, conflicting canonical views, advancing vs
      regressing/changing heads, unsupported tags/history, request-budget
      exhaustion, configuration downgrade attempts, SAFE never mislabeled
      FINALIZED — 35/35.
- [x] Read-only Sepolia observer run using full committed transaction hashes
      (4/4 canonical members; 4/4 SAFE positives; 4/4 FINALIZED positives;
      anchor refs alongside).
- [x] Focused affected regressions re-run (E1A 33/33, E1B 26/26, E1B-v4 8/8,
      E1C 35/35, D2 40/40).
- [x] Docs updated (this note).
- [x] Committed locally, not pushed. No push, no deployment, no public-chain
      writes, no spending, no production secrets, no mainnet activation.