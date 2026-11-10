// D1 execution-worker transactional store (isolated, local-first).
// Backing: node:sqlite (Node >= 22.5 built-in; this repo runs Node 26), WAL journal mode.
// This is a REAL multi-process ACID store: SQLite transactions + UNIQUE constraints +
// atomic versioned updates. It is NOT "JSON file plus atomic rename".
//
// Scope: Phase D1 — durable operation acceptance, nonce reservation, prepared-tx
// persistence. There is NO broadcast capability anywhere in this package.
//
// Not wired into production routes. Not a migration of the hosted service store
// (which is PostgreSQL, data/day17_escrow_durable.sql). This adapter is the
// restricted-launch store for the execution worker.

'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS operations (
  op_id            TEXT PRIMARY KEY,
  payload_digest   TEXT NOT NULL,
  agreement_ref    TEXT NOT NULL,
  escrow_id        TEXT NOT NULL,
  chain_id         INTEGER NOT NULL,
  custody_address  TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  auth_nonce       TEXT NOT NULL,
  auth_role        TEXT NOT NULL,
  auth_expiry      INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ACCEPTED'
                     CHECK (status IN ('ACCEPTED','PREPARED','FAILED','STALLED')),
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Unique account-nonce reservation: one reservation per (account, chain, nonce).
CREATE TABLE IF NOT EXISTS nonce_reservations (
  relayer_account TEXT NOT NULL,
  chain_id        INTEGER NOT NULL,
  nonce           INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'RESERVED'
                    CHECK (status IN ('RESERVED','PREPARED','STALLED','CONSUMED')),
  op_id           TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (relayer_account, chain_id, nonce)
);

-- Durable prepared transactions. signed_bytes is executable material: it is never
-- exported/logged/printed; only its hash and nonce are returned to callers.
-- Phase D4A: when prepared-tx protection is enabled, signed_envelope holds the
-- AES-256-GCM envelope (see worker/prepared-vault.js) and signed_bytes carries a
-- NON-EXECUTABLE marker ('ENC:<kid>:<txHash>') instead of raw bytes. Legacy rows
-- with plaintext signed_bytes and NULL signed_envelope remain readable ONLY
-- through the explicit migration (migratePreparedPlaintextToEnvelope); under
-- protection, broadcast refuses such rows (refuseIfUnsupportedStore).
CREATE TABLE IF NOT EXISTS prepared_txs (
  op_id            TEXT PRIMARY KEY,
  destination      TEXT NOT NULL,
  calldata         TEXT NOT NULL,
  value            TEXT NOT NULL,
  gas_limit        TEXT NOT NULL,
  gas_price        TEXT NOT NULL,
  nonce            INTEGER NOT NULL,
  relayer_account  TEXT NOT NULL,
  chain_id         INTEGER NOT NULL,
  signed_bytes     TEXT NOT NULL,
  signed_envelope  TEXT,
  tx_hash          TEXT NOT NULL,
  action_bindings  TEXT NOT NULL, -- JSON: immutable agreement/escrow/action/cutoff bindings
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (op_id) REFERENCES operations(op_id)
);

-- Stalled reservations and recovery obligations: never silently recycle a nonce.
CREATE TABLE IF NOT EXISTS stalled_reservations (
  relayer_account TEXT NOT NULL,
  chain_id        INTEGER NOT NULL,
  nonce           INTEGER NOT NULL,
  op_id           TEXT NOT NULL,
  reason          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (relayer_account, chain_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_ops_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_prepared_chain_nonce ON prepared_txs(chain_id, nonce);
`;

const STATE_SEQUENCE_FORWARD = new Set(['ACCEPTED', 'PREPARED']);

class D1Store {
  /**
   * @param {string} dbPath absolute path to the sqlite file
   * @param {object} [opts]
   * @param {boolean} [opts.wipe] wipe the DB before opening (tests only)
   */
  constructor(dbPath, opts = {}) {
    this.dbPath = dbPath;
    if (opts.wipe && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
    if (opts.wipe) {
      for (const suffix of ['-wal', '-shm']) {
        const f = dbPath + suffix;
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // busy_timeout: concurrent worker processes legitimately contend on the WAL
    // during startup (schema exec + PRAGMA). SQLite busy-waits up to this many ms
    // before returning SQLITE_BUSY instead of failing immediately.
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    // Schema exec is idempotent; on a fresh multi-process start two workers may
    // contend for the write lock while the other runs PRAGMA journal_mode=WAL.
    // Retry the whole schema exec a bounded number of times instead of failing.
    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        this.db.exec(SCHEMA);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const waitMs = 50 * (attempt + 1);
        const { Atomics, SharedArrayBuffer } = globalThis;
        // sleep without busy-looping the event loop
        const sab = new SharedArrayBuffer(4);
        const i32 = new Int32Array(sab);
        Atomics.wait(i32, 0, 0, waitMs);
      }
    }
    if (lastErr) throw lastErr;
    // Phase D4A: existing store files need the signed_envelope column (guarded).
    this._ensurePreparedEnvelopeColumn();
    this._now = () => Date.now();
  }

  close() {
    try { this.db.close(); } catch { /* noop */ }
  }

  /** Guarded ALTER: ensure prepared_txs.signed_envelope exists (old store files). */
  _ensurePreparedEnvelopeColumn() {
    const cols = this.db.prepare('PRAGMA table_info(prepared_txs)').all().map((c) => c.name);
    if (!cols.includes('signed_envelope')) {
      this.db.exec('ALTER TABLE prepared_txs ADD COLUMN signed_envelope TEXT');
    }
  }

  /**
   * Explicit, restart-safe migration of synthetic PLAINTEXT prepared records to
   * protected envelopes. NEVER auto-runs. Idempotent: only rows that still carry
   * plaintext signed_bytes (no envelope) are sealed; a re-run skips rows already
   * migrated. Interrupted migration is safe: a sealed row is marked by its
   * non-executable marker, so re-running continues from the remaining plaintext
   * rows and never double-seals nor loses operations.
   *
   * The plaintext in WAL / backups / temporary files is NOT erased by this row
   * change. Do not claim erasure; rotate storage/backups to clear remnants.
   *
   * @param {object} vault { sealPrepared } and opts { keyHex|keyFile }
   * @returns { migrated: number[], skipped: number, remainingPlaintext: number }
   */
  migratePreparedPlaintextToEnvelope(vault, opts = {}) {
    const rows = this.db.prepare(
      "SELECT * FROM prepared_txs WHERE signed_envelope IS NULL AND signed_bytes NOT LIKE 'ENC:%'"
    ).all();
    const migrated = [];
    let skipped = 0;
    const now = this._now();
    const upd = this.db.prepare(
      'UPDATE prepared_txs SET signed_envelope = ?, signed_bytes = ?, created_at = created_at WHERE op_id = ? AND signed_envelope IS NULL'
    );
    for (const row of rows) {
      if (!row.signed_bytes || /^ENC:/.test(row.signed_bytes)) { skipped += 1; continue; }
      const context = {
        op: row.op_id,
        chain: Number(row.chain_id),
        sender: row.relayer_account,
        accountNonce: Number(row.nonce),
        intendedTx: { to: row.destination, txHash: row.tx_hash },
      };
      let envelope;
      try {
        envelope = vault.sealPrepared(row.signed_bytes, context, opts);
      } catch (e) {
        throw new Error('MIGRATION_SEAL_FAILED:' + row.op_id + ':' + e.message);
      }
      const marker = 'ENC:' + envelope.kid + ':' + row.tx_hash;
      // Guarded UPDATE: only migrates the row if it is STILL un-enveloped
      // (restart-safe under concurrent readers/writers).
      const res = upd.run(JSON.stringify(envelope), marker, row.op_id);
      if (res.changes === 1) migrated.push(row.op_id);
      else skipped += 1;
    }
    const remaining = this.db.prepare(
      "SELECT COUNT(*) AS c FROM prepared_txs WHERE signed_envelope IS NULL AND signed_bytes NOT LIKE 'ENC:%' AND signed_bytes IS NOT NULL AND signed_bytes != ''"
    ).get().c;
    return { migrated, skipped, remainingPlaintext: remaining, at: now };
  }

  /**
   * Fail-closed check for protected broadcast: if ANY prepared row still carries
   * plaintext signed_bytes with no envelope, refuse with a precise migration
   * requirement. Call before broadcast under protection.
   */
  refuseIfUnsupportedStore() {
    const rows = this.db.prepare(
      "SELECT op_id FROM prepared_txs WHERE signed_envelope IS NULL AND signed_bytes NOT LIKE 'ENC:%' AND signed_bytes IS NOT NULL AND signed_bytes != ''"
    ).all();
    if (rows.length === 0) return { ok: true };
    return {
      ok: false,
      reason: 'STORE_NOT_PROTECTED',
      detail: 'run migratePreparedPlaintextToEnvelope() to seal ' + rows.length + ' plaintext prepared row(s): ' + rows.map((r) => r.op_id).join(','),
    };
  }

  // ---- operations ---------------------------------------------------------

  /**
   * Atomically record a durable operation (acceptance).
   * - identical authenticated retry (same nonce + same payload digest + same op identity)
   *   retrieves the SAME operation (idempotent).
   * - changed payload with the same authorization nonce is REJECTED.
   */
  acceptOperation({ opId, payloadDigest, agreementRef, escrowId, chainId, custodyAddress, requestedAction, authNonce, authRole, authExpiry }) {
    const now = this._now();
    const run = this.db.prepare(`
      INSERT INTO operations (op_id, payload_digest, agreement_ref, escrow_id, chain_id, custody_address,
                              requested_action, auth_nonce, auth_role, auth_expiry, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', 1, ?, ?)
    `);
    try {
      run.run(opId, payloadDigest, agreementRef, escrowId, chainId, custodyAddress,
              requestedAction, authNonce, authRole, authExpiry, now, now);
      return { ok: true, idempotent: false, op: this.getOperation(opId) };
    } catch (e) {
      // PK collision -> retry or conflict
      const existing = this.getOperation(opId);
      if (!existing) throw e;
      if (existing.payloadDigest === payloadDigest &&
          existing.authNonce === authNonce &&
          existing.agreementRef === agreementRef &&
          existing.escrowId === escrowId &&
          existing.chainId === chainId &&
          existing.custodyAddress === custodyAddress) {
        return { ok: true, idempotent: true, op: existing };
      }
      return { ok: false, reason: 'CONFLICT_CHANGED_PAYLOAD', op: existing };
    }
  }

  getOperation(opId) {
    const row = this.db.prepare('SELECT * FROM operations WHERE op_id = ?').get(opId);
    return row ? this._mapOp(row) : null;
  }

  _mapOp(row) {
    return {
      op_id: row.op_id,
      payloadDigest: row.payload_digest,
      agreementRef: row.agreement_ref,
      escrowId: row.escrow_id,
      chainId: row.chain_id,
      custodyAddress: row.custody_address,
      requestedAction: row.requested_action,
      authNonce: row.auth_nonce,
      authRole: row.auth_role,
      authExpiry: row.auth_expiry,
      status: row.status,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Atomic claim with version/fencing: UPDATE ... WHERE version = expected. */
  claimOperation(opId, expectedVersion) {
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE operations SET status='PREPARED', version = version + 1, updated_at = ?
      WHERE op_id = ? AND version = ? AND status = 'ACCEPTED'
    `).run(now, opId, expectedVersion);
    if (res.changes !== 1) {
      const cur = this.getOperation(opId);
      return { ok: false, reason: 'STALE_VERSION', currentVersion: cur ? cur.version : null, status: cur ? cur.status : null };
    }
    return { ok: true, op: this.getOperation(opId) };
  }

  /** Mark a FAILED (or STALLED) terminal-ish state — used when persistence fails. */
  failOperation(opId, reason) {
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE operations SET status='FAILED', updated_at = ?
      WHERE op_id = ? AND status = 'ACCEPTED'
    `).run(now, opId);
    return res.changes === 1;
  }

  // ---- nonce reservations -------------------------------------------------

  /** Atomically reserve a unique nonce for (account, chain). Fails on conflict. */
  reserveNonce({ relayerAccount, chainId, nonce, opId }) {
    const now = this._now();
    try {
      this.db.prepare(`
        INSERT INTO nonce_reservations (relayer_account, chain_id, nonce, status, op_id, version, created_at, updated_at)
        VALUES (?, ?, ?, 'RESERVED', ?, 1, ?, ?)
      `).run(relayerAccount, chainId, nonce, opId, now, now);
      return { ok: true, reservation: { relayerAccount, chainId, nonce, opId } };
    } catch (e) {
      // UNIQUE violation -> another worker/op already reserved this nonce
      const existing = this.db.prepare(`
        SELECT relayer_account AS relayerAccount, chain_id AS chainId, nonce, status, op_id AS opId
        FROM nonce_reservations WHERE relayer_account = ? AND chain_id = ? AND nonce = ?
      `).get(relayerAccount, chainId, nonce);
      return { ok: false, reason: 'NONCE_ALREADY_RESERVED', existing: existing || null };
    }
  }

  /** Mark a reservation PREPARED (transaction durably stored). */
  markNoncePrepared({ relayerAccount, chainId, nonce }) {
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE nonce_reservations SET status='PREPARED', version = version + 1, updated_at = ?
      WHERE relayer_account = ? AND chain_id = ? AND nonce = ? AND status = 'RESERVED'
    `).run(now, relayerAccount, chainId, nonce);
    return res.changes === 1;
  }

  /** Record a stalled reservation + recovery obligation. Never recycles the nonce. */
  recordStalled({ relayerAccount, chainId, nonce, opId, reason }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO stalled_reservations (relayer_account, chain_id, nonce, op_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(relayerAccount, chainId, nonce, opId, reason, this._now());
    this.db.prepare(`
      UPDATE nonce_reservations SET status='STALLED', version = version + 1
      WHERE relayer_account = ? AND chain_id = ? AND nonce = ?
    `).run(relayerAccount, chainId, nonce);
  }

  // ---- prepared txs -------------------------------------------------------

  /** Durably persist the prepared transaction. Atomic with the claim. */
  persistPrepared({ opId, destination, calldata, value, gasLimit, gasPrice, nonce, relayerAccount, chainId, signedBytes, signedEnvelope, txHash, actionBindings }) {
    const now = this._now();
    const run = this.db.prepare(`
      INSERT OR REPLACE INTO prepared_txs (op_id, destination, calldata, value, gas_limit, gas_price, nonce,
                                           relayer_account, chain_id, signed_bytes, signed_envelope, tx_hash, action_bindings, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Protected mode: signed_bytes carries a NON-EXECUTABLE marker, the envelope
    // holds the ciphertext. Legacy path (no envelope): plaintext signed_bytes.
    const storedBytes = signedEnvelope
      ? 'ENC:' + (signedEnvelope.kid || 'k1') + ':' + txHash
      : (signedBytes || '');
    run.run(opId, destination, calldata, value, gasLimit, gasPrice, nonce,
            relayerAccount, chainId, storedBytes, signedEnvelope ? JSON.stringify(signedEnvelope) : null, txHash, JSON.stringify(actionBindings), now);
    return { ok: true, tx: this.getPrepared(opId) };
  }

  getPrepared(opId) {
    const row = this.db.prepare('SELECT * FROM prepared_txs WHERE op_id = ?').get(opId);
    if (!row) return null;
    const rec = { ...row, actionBindings: JSON.parse(row.action_bindings) };
    if (rec.signed_envelope) rec.signedEnvelope = JSON.parse(rec.signed_envelope);
    if (rec.signed_envelope) rec.protected = true;
    else if (rec.signed_bytes && /^ENC:/.test(rec.signed_bytes)) rec.protectedMarker = true;
    return rec;
  }

  getPreparedByNonce(chainId, nonce) {
    const row = this.db.prepare('SELECT * FROM prepared_txs WHERE chain_id = ? AND nonce = ?').get(chainId, nonce);
    if (!row) return null;
    const rec = { ...row, actionBindings: JSON.parse(row.action_bindings) };
    if (rec.signed_envelope) rec.signedEnvelope = JSON.parse(rec.signed_envelope);
    if (rec.signed_envelope) rec.protected = true;
    return rec;
  }

  listOperations(status) {
    const stmt = status ? this.db.prepare('SELECT * FROM operations WHERE status = ? ORDER BY created_at') : this.db.prepare('SELECT * FROM operations ORDER BY created_at');
    return status ? stmt.all(status) : stmt.all();
  }

  listPrepared() {
    return this.db.prepare('SELECT op_id AS opId, destination, nonce, relayer_account AS relayerAccount, chain_id AS chainId, tx_hash AS txHash, created_at AS createdAt FROM prepared_txs ORDER BY nonce').all();
  }
}

module.exports = { D1Store };