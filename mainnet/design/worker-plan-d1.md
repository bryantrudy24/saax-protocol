# D1 Execution Worker — Implementation Plan & Status (Phase D1)

Status: **IMPLEMENTED (Phase D1, local, not deployed)** — durable operation
acceptance, prerequisite validation, account-nonce reservation, transaction
signing (NO broadcast), and durable prepared-transaction storage.
Phase D2 (broadcast + reconciliation + crash recovery on the live path) is NOT
included here.

## Architecture

```
request acceptance (endpoint/escrow-access.js — existing, durable, idempotent)
        │  payload + auth nonce (EIP-712 EscrowAccess signed by the role)
        ▼
worker/d1-worker.js  D1Worker.prepare(opParams)
        │  1. store.acceptOperation       (ACCEPTED, idempotent, conflict-checked)
        │  2. prereqs.validatePrerequisites (signed agreement/policy + on-chain
        │     escrow bindings + state permits action + evidence/evaluator
        │     prerequisites + cutoff/auth validity + genuine signatures)
        │  3. buildCustodyCalldata        (ABI from committed hardhat artifact)
        │  4. reserveNonce                (UNIQUE (account, chain, nonce))
        │  5. signTransactionLocal        (ethers Wallet.signTransaction — NO provider,
        │     NO send; tx hash computed locally via keccak256 of signed bytes)
        │  6. store.persistPrepared       (durable: signed bytes, hash, nonce,
        │     immutable action bindings)
        │  7. store.claimOperation        (versioned: ACCEPTED→PREPARED, fencing)
        ▼
PREPARED (durable, never broadcast)
```

## Persistence: node:sqlite transactional adapter

Selected because the restricted launch has no PostgreSQL/BullMQ, and "JSON file
plus atomic rename alone must not be presented as multi-process transactional
coordination." `node:sqlite` (Node >= 22.5 built-in; repo runs Node 26) provides:

- **Real ACID transactions** (SQLite WAL journal, synchronous=FULL).
- **Multi-process safety**: PRAGMA journal_mode=WAL allows concurrent readers +
  one writer; busy_timeout + schema-exec retry handle startup contention.
- **UNIQUE constraints** as the nonce-authority enforcement layer
  (`nonce_reservations` PK = (relayer_account, chain_id, nonce)).
- **Versioned claims** (UPDATE ... WHERE version = expected) for stale-worker
  fencing.

This is an ISOLATED adapter (`worker/d1-store.js`) — NOT a migration of the
hosted PostgreSQL store (`data/day17_escrow_durable.sql`), and NOT wired into any
production route.

## Store schema (worker/d1-store.js)

| Table | Purpose | Key invariants |
|---|---|---|
| `operations` | stable op identity, payload digest, agreement/escrow/chain/custody/action, auth nonce/role/expiry, status | PK op_id; status ∈ {ACCEPTED, PREPARED, FAILED, STALLED}; version fencing |
| `nonce_reservations` | unique account-nonce reservation | PK (relayer_account, chain_id, nonce); status ∈ {RESERVED, PREPARED, STALLED, CONSUMED} |
| `prepared_txs` | durable signed bytes + hash + nonce + immutable bindings | PK op_id; FK op_id → operations |
| `stalled_reservations` | recovery obligations — never silently recycle a nonce | PK (relayer_account, chain_id, nonce) |

## State transitions and invariants

- `ACCEPTED → PREPARED` (versioned claim; only the worker holding version N can
  advance to N+1; a stale worker's claim fails `STALE_VERSION`).
- `ACCEPTED → FAILED` (persistence or prerequisite failure — fail closed, op not
  marked PREPARED, nonce recorded STALLED).
- `RESERVED → PREPARED` (after durable persist) or `RESERVED → STALLED` (on
  signing/persist failure — the nonce is NEVER silently recycled).
- One canonical prepared action per operation: `prepared_txs` PK op_id and the
  idempotent-retry path returns the existing PREPARED state.
- **A lease alone cannot revoke a transaction already signed.** The reservation
  record (UNIQUE) is the nonce-authority enforcement; the signer's enforcement
  responsibility is that it NEVER reuses a reserved nonce and NEVER broadcasts
  before durable persistence. Documented boundary.

## Secret-storage requirements

- Synthetic local signing keys only (generated at runtime; never committed).
- `signed_bytes` (executable material) is stored in `prepared_txs` but is NEVER
  exported/logged/printed — only `tx_hash` and `nonce` leave the preparation
  boundary (`recover()` and `prepare()` return neither signed bytes nor the full
  calldata/signature material).
- A production deployment would load the relayer key from a secret manager /
  KMS-equivalent; out of D1 scope.

## Supported actions

`release`, `refund`, `mutualRelease`, `mutualRefund`, `raiseDispute`, `resolve`
(restricted OBJECTIVE_DIGITAL profile; no advanced-profile activation).

## Concurrency and restart rules

- Serialized preparation per relayer account (in-process per-account mutex).
- Cross-process: store UNIQUE nonce constraint + bounded retry (default 3)
  resolves transient reservation races deterministically (tested 6× clean).
- Crash recovery (`recover()`): lists ACCEPTED ops needing preparation + restores
  PREPARED records (exact stored hash/nonce).
- Crash boundaries demonstrated in tests:
  - after acceptance, before signing → op stays ACCEPTED, zero broadcast;
  - after signing, before durable storage → signing failure fails closed
    (SIGN_FAILED, no PREPARED, nonce STALLED), zero broadcast;
  - after durable preparation → exact stored hash/bytes restored on restart.

## Exact remaining D2 work (broadcast + reconciliation)

1. **Broadcast**: `broadcastPrepared(opId)` — the ONLY new code path that calls
   a provider send; must read the durable prepared tx (signed bytes from the
   store), broadcast, and record tx hash + status CONSUMED.
2. **Reconciliation**: after broadcast, re-read authoritative chain state
   (receipt, balance, nonce, escrow state) and mark confirmed/matched exactly
   once (no double execution) — mirror the day20-live-recovery pattern for the
   fund path, extended to release/refund/resolve.
3. **Crash recovery integration**: kill-after-broadcast-before-receipt boundary
   (B4) wired for every custody action; reconcile on restart.
4. **Relayer key custody** (D4) and finality policy (B7) before live escrow use.

## Startup path (future D2)

```
node worker/run-worker.js --store <path> --action prepare --poll
```
(not yet created; D1 modules are libraries + tests only)