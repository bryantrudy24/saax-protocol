// D2 execution-worker store extension — broadcast attempts, incidents, and
// attempt_state tracking on top of the D1 store.
//
// Phase D2 adds to the D1 ACID store (node:sqlite, WAL, FULL sync):
//   - broadcast_attempts : one row per broadcast attempt with explicit
//     attempt/operation states covering PENDING (durable before send),
//     SUBMISSION_UNCERTAIN (sent; response may be lost), INCLUDED (mined but
//     not yet finalized), FINALIZED (outcome established + local finality),
//     REVERTED (receipt status 0 — nonce consumed, no custody success),
//     BLOCKED (cannot proceed; replacement deferred, surfaced via incidents).
//   - incidents           : actionable records — unexpected nonce consumption,
//     nonce gaps, stalled reservations, reorg detection, external resolution,
//     stuck-unreplaced. A blocking incident gates new work for the account.
//
// The operations table gains an attempt_state column (ALTER, guarded) so
// existing D1 store files remain compatible; the D1 status CHECK constraint
// (ACCEPTED/PREPARED/FAILED/STALLED) is unchanged. This store is isolated to
// the execution worker — NOT the hosted PostgreSQL store, NOT multi-host
// shared-filesystem (SQLite WAL is single-host; documented limitation).

'use strict';

const { D1Store } = require('./d1-store.js');

const D2_SCHEMA = `
CREATE TABLE IF NOT EXISTS broadcast_attempts (
  op_id                  TEXT NOT NULL,
  attempt_num            INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN
                           ('PENDING','SUBMISSION_UNCERTAIN','INCLUDED','FINALIZED','REVERTED','BLOCKED')),
  tx_hash                TEXT NOT NULL,
  nonce                  INTEGER NOT NULL,
  chain_id               INTEGER NOT NULL,
  relayer_account        TEXT NOT NULL,
  send_error             TEXT,
  sim_note               TEXT,
  broadcast_at           INTEGER,
  included_block_number  INTEGER,
  included_block_hash    TEXT,
  finality_policy        TEXT,
  finality_confirmations INTEGER,
  outcome                TEXT,   -- JSON outcome evidence (actual result)
  error                  TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (op_id, attempt_num)
);

CREATE TABLE IF NOT EXISTS incidents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  op_id           TEXT,
  relayer_account TEXT,
  chain_id        INTEGER,
  nonce           INTEGER,
  detail          TEXT,
  created_at      INTEGER NOT NULL,
  acknowledged    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attempts_status ON broadcast_attempts(status);
CREATE INDEX IF NOT EXISTS idx_attempts_nonce ON broadcast_attempts(chain_id, nonce);
CREATE INDEX IF NOT EXISTS idx_incidents_kind ON incidents(kind, acknowledged);
`;

class D2Store extends D1Store {
  constructor(dbPath, opts = {}) {
    super(dbPath, opts); // D1 schema exec (idempotent, busy-retried)
    this._ensureD2();
  }

  _ensureD2() {
    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        this.db.exec(D2_SCHEMA);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const waitMs = 50 * (attempt + 1);
        const sab = new SharedArrayBuffer(4);
        const i32 = new Int32Array(sab);
        Atomics.wait(i32, 0, 0, waitMs);
      }
    }
    if (lastErr) throw lastErr;
    // Guarded ALTER: add operations.attempt_state if missing (D1 files stay
    // compatible; D2-only column).
    const cols = this.db.prepare('PRAGMA table_info(operations)').all().map((c) => c.name);
    if (!cols.includes('attempt_state')) {
      this.db.exec("ALTER TABLE operations ADD COLUMN attempt_state TEXT");
    }
    // E1A: guarded ALTER on broadcast_attempts for the explicit finality
    // state column. Values: NULL / 'LOCAL' (local-confirmations terminal),
    // 'INCLUDED' (mined but not yet safe/finalized), 'SAFE' (covered by the
    // OP Stack safe head — NOT consensus-finalized), 'FINALIZED' (covered by
    // the finalized head). Kept separate from the lifecycle `status` so a
    // SAFE observation is never labeled consensus-finalized in the attempt
    // row while the lifecycle state stays accurate.
    const acols = this.db.prepare('PRAGMA table_info(broadcast_attempts)').all().map((c) => c.name);
    if (!acols.includes('finality_state')) {
      this.db.exec("ALTER TABLE broadcast_attempts ADD COLUMN finality_state TEXT");
    }
  }

  _now() { return Date.now(); }

  // ---- attempt lifecycle ----------------------------------------------------

  /** Durable attempt row BEFORE sending (status PENDING). Attempt numbering
   *  is per-op and monotonic (replacement attempts tracked even though fee
   *  replacement itself is deferred). */
  beginAttempt({ opId, nonce, txHash, chainId, relayerAccount, simNote, gasLimit, gasPrice }) {
    const now = this._now();
    const prev = this.db.prepare('SELECT MAX(attempt_num) AS m FROM broadcast_attempts WHERE op_id = ?').get(opId);
    const attemptNum = (prev && prev.m !== null ? prev.m : 0) + 1;
    this.db.prepare(`
      INSERT INTO broadcast_attempts
        (op_id, attempt_num, status, tx_hash, nonce, chain_id, relayer_account,
         sim_note, created_at, updated_at)
      VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)
    `).run(opId, attemptNum, txHash, nonce, chainId, relayerAccount, simNote || null, now, now);
    this.db.prepare(`
      UPDATE operations SET attempt_state='PENDING', updated_at=? WHERE op_id=?
    `).run(now, opId);
    return this.getAttempt(opId, attemptNum);
  }

  getAttempt(opId, attemptNum) {
    const row = this.db.prepare('SELECT * FROM broadcast_attempts WHERE op_id=? AND attempt_num=?').get(opId, attemptNum);
    if (!row) return null;
    if (row.outcome) row.outcome = JSON.parse(row.outcome);
    return row;
  }

  getAttempts(opId) {
    return this.db.prepare('SELECT * FROM broadcast_attempts WHERE op_id=? ORDER BY attempt_num').all(opId).map((r) => {
      if (r.outcome) r.outcome = JSON.parse(r.outcome);
      return r;
    });
  }

  listAttempts(statuses) {
    if (!statuses || statuses.length === 0) {
      return this.db.prepare('SELECT * FROM broadcast_attempts ORDER BY op_id, attempt_num').all();
    }
    const q = 'SELECT * FROM broadcast_attempts WHERE status IN (' + statuses.map(() => '?').join(',') + ') ORDER BY op_id, attempt_num';
    return this.db.prepare(q).all(...statuses);
  }

  listAttemptsByOp(opId) { return this.getAttempts(opId); }

  _updateAttempt(opId, attemptNum, fields) {
    const now = this._now();
    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
    this.db.prepare(`UPDATE broadcast_attempts SET ${sets}, updated_at=? WHERE op_id=? AND attempt_num=?`)
      .run(...Object.values(fields), now, opId, attemptNum);
  }

  recordSend(opId, attemptNum, { status, sendError, broadcastAt }) {
    this._updateAttempt(opId, attemptNum, {
      status, send_error: sendError || null,
      broadcast_at: broadcastAt !== undefined ? broadcastAt : this._now(),
    });
    this.db.prepare(`UPDATE operations SET attempt_state=?, updated_at=? WHERE op_id=?`)
      .run(status, this._now(), opId);
  }

  recordIncluded(opId, attemptNum, { blockNumber, blockHash, finalityPolicy, confirmations, finalityState }) {
    this._updateAttempt(opId, attemptNum, {
      status: 'INCLUDED',
      included_block_number: blockNumber,
      included_block_hash: blockHash,
      finality_policy: finalityPolicy || null,
      finality_confirmations: confirmations !== undefined ? confirmations : null,
      finality_state: finalityState || 'INCLUDED',
    });
    this.db.prepare(`UPDATE operations SET attempt_state='INCLUDED', updated_at=? WHERE op_id=?`).run(this._now(), opId);
  }

  recordFinalized(opId, attemptNum, outcome, finalityState) {
    this._updateAttempt(opId, attemptNum, {
      status: 'FINALIZED',
      outcome: JSON.stringify(outcome || {}),
      finality_state: finalityState || 'FINALIZED',
    });
    this.db.prepare(`UPDATE operations SET attempt_state='FINALIZED', status='PREPARED', updated_at=? WHERE op_id=?`).run(this._now(), opId);
  }

  /**
   * E1A: persist a SAFE terminal outcome — the attempt lifecycle becomes
   * terminal (FINALIZED status, nonce consumed) but the finality_state is
   * 'SAFE': covered by the OP Stack safe head, NOT consensus-finalized.
   * SAFE must never be labeled FINALIZED in the finality state.
   */
  recordSafeTerminal(opId, attemptNum, outcome) {
    this._updateAttempt(opId, attemptNum, {
      status: 'FINALIZED',
      outcome: JSON.stringify(outcome || {}),
      finality_state: 'SAFE',
    });
    this.db.prepare(`UPDATE operations SET attempt_state='FINALIZED', status='PREPARED', updated_at=? WHERE op_id=?`).run(this._now(), opId);
  }

  recordReverted(opId, attemptNum, error) {
    this._updateAttempt(opId, attemptNum, { status: 'REVERTED', error: error || null });
    this.db.prepare(`UPDATE operations SET attempt_state='REVERTED', updated_at=? WHERE op_id=?`).run(this._now(), opId);
  }

  recordBlocked(opId, attemptNum, error) {
    this._updateAttempt(opId, attemptNum, { status: 'BLOCKED', error: error || null });
    this.db.prepare(`UPDATE operations SET attempt_state='BLOCKED', updated_at=? WHERE op_id=?`).run(this._now(), opId);
  }

  setOperationAttemptState(opId, state) {
    this.db.prepare(`UPDATE operations SET attempt_state=?, updated_at=? WHERE op_id=?`).run(state, this._now(), opId);
  }

  // ---- nonce reconciliation bookkeeping --------------------------------------

  listReservations({ relayerAccount, chainId, status } = {}) {
    let sql = 'SELECT * FROM nonce_reservations WHERE 1=1';
    const args = [];
    if (relayerAccount) { sql += ' AND relayer_account=?'; args.push(relayerAccount); }
    if (chainId !== undefined) { sql += ' AND chain_id=?'; args.push(chainId); }
    if (status) { sql += ' AND status=?'; args.push(status); }
    return this.db.prepare(sql + ' ORDER BY nonce').all(...args);
  }

  markNonceConsumed({ relayerAccount, chainId, nonce }) {
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE nonce_reservations SET status='CONSUMED', version=version+1, updated_at=?
      WHERE relayer_account=? AND chain_id=? AND nonce=? AND status IN ('RESERVED','PREPARED')
    `).run(now, relayerAccount, chainId, nonce);
    return res.changes === 1;
  }

  // ---- incidents -------------------------------------------------------------

  incident({ kind, opId, relayerAccount, chainId, nonce, detail }) {
    this.db.prepare(`
      INSERT INTO incidents (kind, op_id, relayer_account, chain_id, nonce, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(kind, opId || null, relayerAccount || null, chainId !== undefined ? chainId : null,
          nonce !== undefined ? nonce : null, detail || null, this._now());
  }

  listIncidents({ kind, unacknowledged } = {}) {
    let sql = 'SELECT * FROM incidents WHERE 1=1';
    const args = [];
    if (kind) { sql += ' AND kind=?'; args.push(kind); }
    if (unacknowledged) { sql += ' AND acknowledged=0'; }
    return this.db.prepare(sql + ' ORDER BY id').all(...args);
  }

  acknowledgeIncident(id) {
    this.db.prepare('UPDATE incidents SET acknowledged=1 WHERE id=?').run(id);
  }

  /** A blocking incident gates new work for the (account, chain) pair:
   *  unexpected nonce consumption or unresolvable nonce gap. */
  hasBlockingIncident(relayerAccount, chainId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM incidents
      WHERE acknowledged=0 AND kind IN ('UNEXPECTED_NONCE_CONSUMPTION','NONCE_GAP')
        AND relayer_account=? AND chain_id=?
    `).get(relayerAccount, chainId);
    return (row && row.c > 0) || false;
  }
}

module.exports = { D2Store };