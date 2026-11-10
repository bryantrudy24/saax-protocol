# D3 Execution Worker — Authenticated Endpoint → Durable Worker Integration (Phase D3)

Status: **IMPLEMENTED (Phase D3, local, not deployed)** — the JSON-ledger →
SQLite acceptance gap is CLOSED for the integrated lane. The endpoint and the
worker now share ONE SQLite store; acceptance is ONE atomic transaction
(operation + work item + journal/outbox intent). Local-EVM (chain 31337)
tests only, synthetic keys, mock USDC. No production-route wiring, no hosted
deployment, no push, no mainnet activation.

## What D3 adds (over D2)

| Concern | D2 | D3 (integrated) |
|---|---|---|
| Acceptance store | JSON ledger (endpoint) vs SQLite (worker) — TWO stores | ONE SQLite store; `acceptIntegrated` = ONE BEGIN IMMEDIATE transaction (operation + work + outbox) |
| Work discovery | N/A (worker run manually) | `work_items` table polled by the worker — NEVER an in-memory notification; work survives worker absence and resumes |
| Journal intent | deferred | `outbox` rows written IN the acceptance transaction; drained into real journal entries tied to actual receipts after execution; a journal-write failure after chain execution stays recoverable (outbox PENDING → re-drain from recorded outcome, no re-execution) |
| Retry semantics | JSON-ledger (nonce-keyed) | same-nonce/changed-payload → 409 CONFLICT_CHANGED_PAYLOAD (guarded by auth_nonce lookup, NOT op_id derivation); identical retry → same operation, no second row |
| Mode gate | — | `SAAX_INTEGRATED_WORKER=1`; hosted lane (env unset) byte-identical JSON-ledger behavior |
| Chain/ABI | 84532 hardcoded in escrow.js verifyOnChain | `SAAX_NETWORK=local` allows the configured local chain (SAAX_CHAIN_ID, e.g. 31337); `SAAX_CUSTODY_ABI` env picks the V2 18-tuple ABI for the local lane (legacy default = V1 14-tuple artifact, unchanged); getLogs scan bounded by chain head (low-block chain no longer hangs) |

## The ONE authoritative acceptance transaction

`worker/d3-store.js acceptIntegrated()`:

```
BEGIN IMMEDIATE
  blocking-incident check for the relayer account/chain (REJECT inside the tx)
  INSERT operations   (op_id from nonce+payloadDigest; camelCase row)
  INSERT work_items   (PENDING — worker polls this)
  INSERT outbox       (journal intent: what a confirmed entry must record)
  UPDATE operations SET action_args  (verdict/commitment params the worker needs)
COMMIT
```

- The endpoint NEVER reserves nonces (worker owns the dedicated relayer
  account; nonces reserved durably at prepare, D1 semantics).
- The worker NEVER invents evaluator approval: execution requires
  D2Prerequisites to pass (signed agreement/policy, on-chain state permits the
  exact action, cutoff valid, genuine evaluator/mutual signatures or timeout
  contract rules). The verdict signature in `actionArgs` is the REAL key
  signature the contract enforces — the worker only carries it.
- A caller-controlled user ID, configured buyer address, or valid transport
  token alone is NOT sufficient: the route handler's existing checks
  (signature recovery to the role's configured address AND the on-chain
  escrow party, funding bindings vs the agreement, custody/chain pinning) run
  BEFORE the acceptance write.

## HTTP handler integration (route-server.js)

- `SAAX_INTEGRATED_WORKER=1` + a request body carrying `actionArgs` → the
  handler replaces the JSON-ledger acceptance with the store transaction and
  responds `{ ok, mode:'escrow-access-integrated', operation:<opId>, status:
  'accepted', escrow }`. Identical retries return the SAME operation
  (idempotent). Same-nonce/changed-payload → 409.
- Hosted lane (env unset): byte-identical JSON-ledger path, unchanged.

## Worker integration (worker/d3-worker.js, worker/run-d3-worker.cjs)

- `processOnce()`: reconcile supervised attempts (poll), then claim PENDING
  work (versioned), prepare via `_prepareAccepted` (no re-accept — the work
  row IS the durable record), broadcast + reconcile via the D2 pipeline, then
  drain the outbox into real journal entries.
- `drainOutbox()`: for each outbox PENDING row whose op attempt is terminal,
  write the confirmed journal entry with `by` = the AUTHORIZING party from the
  on-chain escrow (evaluator for release/refund; buyer|seller for dispute;
  timeout-refund → role 'open', submitter recorded), `submitter` = relayer,
  tx/block refs from the actual receipt. A journal write failure keeps the
  outbox PENDING → re-drain recovers WITHOUT re-execution.
- Timout refunds journal `timeout-refund` (role 'open', NO evaluator
  authority) — never conflated with evaluator `refund`.
- Discovery is POLLING ONLY. `--loop` settles supervised attempts across
  cycles; `--once` processes one batch.

## CLI (worker/run-d3-worker.cjs)

```
Startup:  node worker/run-d3-worker.cjs <store> <chainId> <custody> <rpc> --once|--loop
Prepare:  node worker/run-d3-worker.cjs ... --prepare-op <opId>
Broadcast: node worker/run-d3-worker.cjs ... --broadcast <opId>
Reconcile: node worker/run-d3-worker.cjs ... --reconcile <opId>     # replacement worker
Drain:     node worker/run-d3-worker.cjs ... --drain                 # journal recovery
Export:    node worker/run-d3-worker.cjs ... --export <opId>         # v4 export from records
Recover:   node worker/run-d3-worker.cjs ... --recover               # accepted+prepared+work+outbox
Shutdown:  SIGINT/Ctrl-C (graceful after the current work item); --exit-after N for tests
```

Env: SAAX_D2_RELAYER_KEY (synthetic), SAAX_JOURNAL_DIR + SAAX_JOURNAL_SIGNER_KEY,
SAAX_JOURNAL_RPC, SAAX_D3_EXPORT_DIR (export file output).

## One-host assumptions / relayer ownership

- SQLite WAL is single-host local persistent storage with coordinated
  ownership (one writer at a time; busy_timeout + schema retry for startup
  contention). NOT a multi-host shared-filesystem solution — documented, not
  silently enabled.
- The dedicated relayer account is owned by the worker; the endpoint never
  reserves nonces (it creates work). Nonce UNIQUE constraints do NOT fence a
  stale signer (lease boundary documented); the signer never reuses a reserved
  nonce and never broadcasts before durable persistence.

## Test results (this phase)

- `node scripts/test-d3-integration.cjs` → **47 passed, 0 failed, exit 0**
  (REAL HTTP handler + REAL worker as SEPARATE processes; REAL local EVM
  31337 + genuine custody V2 + MockUSDC):
  - release path: valid authenticated request → ONE durable op → worker
    PREPARED→BROADCAST→RECONCILED → escrow Released, beneficiary seller,
    attempt finalized exactly once, outbox COMPLETE, journal with real
    receipt refs, terminal consistency.
  - timeout-refund path (nonfulfillment): escrow Refunded, beneficiary buyer
    (fixed), no evaluator authority, journal `timeout-refund` role 'open'.
  - negatives BEFORE acceptance: missing/wrong transport token (401), wrong
    role, wrong chain, wrong custody, mismatched terms — all rejected with no
    operation created.
  - concurrent/identical retry → ONE operation; changed-payload same nonce →
    409.
  - handler killed after commit → work durable; retry after restart returns
    the SAME operation.
  - worker dies after broadcast → replacement reconciles (FINALIZED), repeated
    reconciliation idempotent (no double payout).
  - journal persistence failure after chain execution → outbox PENDING →
    recovery drains WITHOUT re-execution (no duplicate entry).
  - terminal status + v4 export available after service restart; separate
    verifier process reports the honest limited verdict (no fabricated
    VERIFIED).
- Regressions: test-v4-journal-walk 87/87, test-v4-journal-verify 37/37,
  test-d1-worker 26/26, test-d2-worker 40/40 — ALL GREEN.

## Limitations retained

- Hosted lane unchanged (JSON ledger default; SAAX_INTEGRATED_WORKER unset).
  Operational JSON ledgers are NOT imported — a future migration is documented
  separately.
- Fee replacement deferred (BLOCKED + incident, reported).
- Public-chain finality NOT activated. Relayer key custody + signed-byte
  protection remain activation gates (synthetic keys only; bytes never
  exported/logged; not encrypted — no encryption claimed).
- The minimal v4 exporter (persisted records + chain evidence) surfaces
  anchor/evidence as absent rather than fabricating them; verifier reports
  the honest limited/incomplete verdict. Full anchor + evidence export remains
  the closure producer's job (script/test-v4-producer-closure.cjs).
- Independent security/design audit of the worker NOT completed.
- Mainnet admission remains DISABLED. No deployment, no push.## D3 CLOSURE — expiry policy + complete exports (2026-10-18)

- Expiry policy: access-auth expiry enforced at durable acceptance
  (escrow-access EXPIRED); execution is governed by contract-action validity +
  cutoff (d2-prereqs), NOT the access-auth expiry. The execution-time
  wall-clock AUTH_EXPIRED rejection was removed (delayed pickup of accepted
  ops must proceed). Verified: test-d3-expiry-semantics.cjs 6/6.
- Resolve access-role enforcement: worker/d3-action-auth.js RESOLVE now
  requires accessRole === evaluator BEFORE the verdict re-entry
  (RESOLVE_ROLE_REQUIRED); buyer/seller cannot gain resolve access through
  internal mapping (N16/N17/N18). Action-auth suite now 28/28.
- Complete integrated exports (requirement 3): scripts/test-d3-closure-export.cjs
  produces BOTH A (fulfilled release, satisfied criterion, evaluator release)
  and B (affirmative nonfulfillment -> authorized evaluator refund BEFORE
  final cutoff, criterion NOT satisfied) with the FULL artifact chain (signed
  v4 agreement, authorizations, genuine EAS anchor, journal, evidence) and
  verifies each separate-process with the candidate ceiling
  (VERIFIED_WITH_LIMITATIONS, never full VERIFIED) + a negative
  missing-records control (INCOMPLETE). Outcome distinction: refunds do NOT
  require criterion satisfaction; releases DO (v4-evidence.js narrow fix).