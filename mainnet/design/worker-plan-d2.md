# D2 Execution Worker — Broadcast, Reconciliation, and Crash Recovery (Phase D2)

Status: **IMPLEMENTED (Phase D2, local, not deployed)** — the D1 worker now
broadcasts durably prepared transactions and reconciles actual custody outcomes
across failures. Local-EVM (chain 31337) tests only. No production-route
wiring, no hosted deployment, no push, no mainnet activation.

## What D2 adds (over D1)

| Concern | D1 (prepared) | D2 (broadcast + reconcile) |
|---|---|---|
| Broadcast | forbidden (no send path) | `broadcastPrepared(opId)` — ONLY path that sends; sends ONLY persisted signed bytes |
| Validation before send | — | `validatePrepared(opId)`: decode + recompute hash + verify sender/chain/destination/calldata-action/value/nonce/bindings; recheck current state + deadlines; reject corrupted/mismatched records; simulation advisory only |
| Attempt states | PREPARED | PENDING (durable before send) → SUBMISSION_UNCERTAIN (sent; response may be lost) → INCLUDED (mined, not final) → FINALIZED / REVERTED / BLOCKED |
| Outcome | — | receipt + canonical block ref, correct custody address/action, expected events, resulting escrow state, actual token movement + amount, beneficiary, finality policy (local-only) |
| Nonce | UNIQUE reservation | chain-aware init + reconcile: account history, pending, reservations, unexpected consumption (blocking incident), gaps, stalled reservations (never recycled) |
| Reorg | — | FinalityAdapter detects removed/replaced receipt or changed block hash; returns to reconciliation WITHOUT a second business action |
| Fee replacement | — | DEFERRED: a stuck/dropped tx is surfaced as BLOCKED + incident, reported — never silently recycled, never double-submitted |

## At-most-once custody effects

There is NO unconditional exactly-once execution and database updates +
blockchain execution are NOT one atomic transaction. The worker guarantees
**at-most-once custody EFFECTS** through:

1. One canonical prepared action per operation (`prepared_txs` PK op_id;
   idempotent retry returns existing state).
2. Durable attempt rows written BEFORE send (crash after send but before the
   response leaves SUBMISSION_UNCERTAIN; recovery reconciles the KNOWN tx by
   hash — never infers non-broadcast from an absent receipt).
3. Reconciliation from the authoritative chain (receipt, escrow state, token
   balance, events) — a reverted receipt consumes the nonce but establishes NO
   custody success; an absent receipt is an uncertain observation.
4. Terminal outcome recorded exactly once (FINALIZED + nonce CONSUMED);
   repeated reconciliation is a no-op (no second payout, no re-broadcast).
5. If another actor resolved the escrow first, the worker records that actual
   outcome + executor (EXTERNAL) and does NOT claim it executed the action.
   Operation failure is kept separate from escrow outcome.

## Files

- `worker/d2-store.js` — D2Store (extends D1Store): `broadcast_attempts`
  (PENDING/SUBMISSION_UNCERTAIN/INCLUDED/FINALIZED/REVERTED/BLOCKED),
  `incidents` (unexpected nonce consumption, nonce gaps, stalled reservations,
  reorg detection, external resolution, stuck-unreplaced; blocking kinds gate
  new work for the account), nonce-consumed bookkeeping.
- `worker/d2-finality.js` — FinalityAdapter: local-confirmations policy (LABELED
  local-only; never a public-finality claim); reorg detection; public-chain
  safe/finalized interface EXISTS but is NOT activated; a fixed waiting period
  is never finality.
- `worker/d2-prereqs.js` — D2Prerequisites: domain-aware validation — signed
  agreement/policy bindings, on-chain escrow state permits the exact action,
  cutoff validity (timeout refund eligible AT/AFTER cutoff without evaluator
  authority; everything else AfterCutoff), authorization validity. Restricted
  launch: EOA evaluator cannot satisfy the 2-of-3 admission policy
  (POLICY_2OF3_REQUIRED — no silent fallback to a single operator key).
- `worker/d2-worker.js` — D2Worker: validatePrepared → broadcastPrepared →
  reconcileOutcome → finalize; nextNonceFor (chain-aware nonce init/reconcile);
  reconcileAll; recoverWork (accepted + prepared + supervised attempts).
- `worker/d2-mock-rpc.js` — LABELED MOCK RPC for network/finality scenarios
  (broadcast response lost, mining-before-reconcile, reorg/receipt
  disappearance, unexpected nonce consumption, dropped/pending txs,
  persistence-failure-after-chain, repeated reconciliation). NEVER presented as
  real-chain results.
- `worker/run-d2-worker.cjs` — worker CLI for child-process crash/restart tests
  (prepare/broadcast/reconcile/reconcile-all/recover). Synthetic key only.
- `scripts/test-d2-worker.cjs` — focused suite (40 checks): REAL local EVM
  31337 + genuine custody V2 + MockUSDC + real Safe 2-of-3 evaluator
  (ERC-1271), plus LABELED MOCK scenarios, plus REAL child-process
  termination/restart (spawn → kill → respawn).

## Real vs mocked coverage (labeled)

- **[REAL]** local EVM 31337: evaluator release/refund, disputed evaluator
  resolution, mutual release, timeout refund (at/after cutoff), external
  settlement (worker refuses before broadcast — STATE_NOT_PERMITTED, no
  fabricated success), child-process prepare/broadcast/restart-reconcile.
- **[MOCK]** labeled mock RPC: broadcast response discarded
  (SUBMISSION_UNCERTAIN), mining-before-reconcile, reorg detection
  (REORG_DETECTED incident, returned to reconciliation), unexpected nonce
  consumption (blocking incident), stalled reservation never recycled.

## Nonce initialization / reconciliation behavior

- `nextNonceFor(account, chain)` starts from max(chain pending nonce,
  highestReserved+1) and validates.
- A FRESH store on an account with existing history (chainNonce > 0, no
  reservations) is NORMAL initialization — handled, not flagged.
- A reservation below the chain nonce that is neither CONSUMED nor STALLED =
  UNEXPECTED_NONCE_CONSUMPTION → blocking incident gates new work + surfaces
  an actionable record. Never silently recycled.
- Stalled reservations are recorded and reviewed; never recycled just because
  a tx is absent.

## Test results (this phase)

- `node scripts/test-d2-worker.cjs` → **40 passed, 0 failed, exit 0**
- `node scripts/test-d1-worker.cjs` → **26 passed, 0 failed** (regression)
- `node scripts/test-d1-cross-process.cjs` → **2 passed, 0 failed** (regression)
- `node scripts/test-v4-journal-walk.cjs` → **87 passed, 0 failed** (regression)
- `node scripts/test-v4-journal-verify.cjs` → **37 passed, 0 failed** (regression)

## Limitations (documented per brief §7)

- **Access JSON ledger → SQLite worker handoff remains UNINTEGRATED.** The
  hosted access path (`endpoint/escrow-access.js`) and the worker store
  (`worker/d1/d2-store.js`) are separate; wiring them is a later integration
  step (unchanged from D1).
- **SQLite WAL is single-host local persistent storage** with coordinated
  ownership (one writer at a time; busy_timeout + schema retry for startup
  contention). It is NOT a multi-host shared-filesystem solution.
- **Node requirement:** `node:sqlite` (Node ≥ 22.5; repo runs Node 26).
- **Signed-byte protection / production signer custody remain activation
  gates.** Raw signed bytes (`prepared_txs.signed_bytes`) are never exported
  or logged — only hash + nonce leave the boundary — and a production
  deployment must load the relayer key from a secret manager. This phase uses
  synthetic local keys only.
- **Nonce UNIQUE constraints do NOT fence a stale signer.** A lease alone
  cannot revoke a transaction already signed; the enforcement boundary is the
  durable reservation + the signer's responsibility never to reuse a reserved
  nonce or broadcast before durable persistence. Documented boundary.
- **Sensitive signed bytes are NOT encrypted** — no encryption is claimed or
  implemented.
- **Fee replacement is deferred.** A stuck/dropped transaction is BLOCKED +
  incident + reported; no invented recovery path, no silent different-tx
  replacement.

## Remaining gaps (unrelated, out of scope this phase)

- Service integration (access ledger → worker handoff; worker → hosted route).
- Relayer key custody (production secret manager).
- Independent security/design audit of the worker.
- v1/v2/v3 verifier hardcoded-chain cleanup (named in check-map, separate
  task). Public-chain finality remains not activated.
- Mainnet admission remains DISABLED. No deployment, no push.