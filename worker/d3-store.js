// D3 execution-worker store extension — the SINGLE authoritative acceptance
// boundary that removes the JSON-ledger -> SQLite gap.
//
// Phase D3 adds to the D2 ACID store (node:sqlite, WAL, FULL sync, one host):
//   - work_items     : durable work scheduled at acceptance. A worker
//                      discovers committed work by POLLING this table — it
//                      never depends on an in-memory notification. One row
//                      per operation that requires execution.
//   - outbox         : durable journal/outbox INTENT written in the SAME
//                      transaction as acceptance. After chain execution the
//                      worker drains the outbox into real journal entries
//                      (tied to actual receipts/events) and marks rows
//                      COMPLETE. A journal-write failure after chain
//                      execution is therefore RECOVERABLE without another
//                      payout: the outbox row survives, the op outcome is
//                      already recorded, and re-draining writes the journal
//                      from the recorded outcome.
//
// THE ACCEPTANCE TRANSACTION (acceptIntegrated):
//   BEGIN IMMEDIATE
//     - check blocking incidents for the relayer account/chain
//     - INSERT operations (op_id derived deterministically from the access
//       auth nonce + payload digest — idempotent retries return the SAME op)
//     - INSERT work_items (when the action needs worker execution)
//     - INSERT outbox (journal intent: what the journal must contain once
//       the effect is confirmed)
//     - INSERT nonce_reservations? NO — the reservation happens at
//       PREPARATION (D1), not acceptance. D3 keeps acceptance atomic with
//       work + journal intent; the nonce is reserved durably at prepare.
//   COMMIT
//
// Retry semantics (mandated):
//   - identical authenticated retry (same nonce + same payload digest + same
//     op identity) returns the SAME operation (idempotent).
//   - changed payload with the same authorization nonce is REJECTED.
//   - outstanding nonce gaps/incidents BLOCK new submissions (the check is
//     inside the same transaction as acceptance, so it cannot be raced).
//
// One-host assumptions are enforced/documented: SQLite WAL is single-host
// local persistent storage with coordinated ownership (one writer at a time;
// the store uses busy_timeout + schema retry, NOT a multi-host solution).
// The dedicated relayer account is owned by the worker; the endpoint NEVER
// reserves nonces — it creates work, and the worker serializes per-account.

'use strict';

const { D2Store } = require('./d2-store.js');

const D3_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_items (
  op_id            TEXT PRIMARY KEY,
  chain_id         INTEGER NOT NULL,
  relayer_account  TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','CLAIMED','PREPARED','BROADCAST','RECONCILED','FAILED','BLOCKED')),
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (op_id) REFERENCES operations(op_id)
);

CREATE INDEX IF NOT EXISTS idx_work_status ON work_items(status, chain_id);

CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id           TEXT NOT NULL,
  commitment_id   TEXT NOT NULL,
  manifest_hash   TEXT NOT NULL,
  chain_id        INTEGER NOT NULL,
  custody_address TEXT NOT NULL,
  intent_json     TEXT NOT NULL,   -- journal intent (transition/role/action/state)
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','COMPLETE','FAILED')),
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  UNIQUE (op_id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
`;

/** op_id is derived deterministically from the access auth nonce + payload
 *  digest so idempotent retries map to the SAME operation row, and a changed
 *  payload under the same nonce maps to a DIFFERENT op_id — which the
 *  operations PK + retry check then reject as a conflict. */
function opIdFromNonce(nonce, payloadDigest) {
  const crypto = require('node:crypto');
  return 'op-' + crypto.createHash('sha256').update(String(nonce) + '|' + String(payloadDigest)).digest('hex').slice(0, 24);
}

class D3Store extends D2Store {
  constructor(dbPath, opts = {}) {
    super(dbPath, opts); // D1 + D2 schema (idempotent, busy-retried)
    this._ensureD3();
  }

  _ensureD3() {
    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        this.db.exec(D3_SCHEMA);
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
    // Guarded ALTERs: add D3-only columns to the D1 operations table if
    // missing (existing D1/D2 store files stay compatible).
    const cols = this.db.prepare('PRAGMA table_info(operations)').all().map((c) => c.name);
    if (!cols.includes('action_args')) {
      this.db.exec("ALTER TABLE operations ADD COLUMN action_args TEXT");
    }
    if (!cols.includes('export_artifacts')) {
      this.db.exec("ALTER TABLE operations ADD COLUMN export_artifacts TEXT");
    }
  }

  /**
   * THE single authoritative acceptance boundary.
   *
   * One BEGIN IMMEDIATE transaction atomically persists:
   *   - the authenticated operation (op identity, canonical payload hash,
   *     agreement/escrow/action bindings, access nonce consumption),
   *   - the durable work item (PENDING; discovered by worker polling),
   *   - the journal/outbox intent (what a confirmed entry must record).
   *
   * @param {object} p
   *   { nonce, payloadDigest, role, action, commitmentDigest, escrowId,
   *     custody, chainId, expiry, agreementRef, authExpiry, workRequired,
   *     journalIntent, actionArgs }  — all fields are validated by the caller;
   *     this method only persists. journalIntent = { transition, role,
   *     contractAction, resultingState } for the outbox; actionArgs = the
   *     custody action arguments the worker needs to build calldata
   *     (commitmentId, commitmentDigest, verdict nonce/issuedAt, sigs, etc.),
   *     persisted atomically with acceptance so the worker never needs the
   *     original request to reconstruct the transaction.
   * @returns {object} { ok, idempotent?, op, work?, outbox?, conflict? }
   */
  acceptIntegrated(p) {
    const now = this._now();
    const opId = opIdFromNonce(p.nonce, p.payloadDigest);
    // SAME-NONCE CHANGED-PAYLOAD GUARD (mandated retry semantics): the op_id
    // is derived from nonce + payloadDigest, so a changed payload under the
    // SAME nonce would produce a different op_id and quietly insert a second
    // row. That is NOT allowed: the access nonce is consumed by durable
    // acceptance, so the same nonce MUST map to the same logical acceptance.
    // Check for an existing row with this auth_nonce BEFORE inserting.
    const holder = this.db.prepare('SELECT op_id, payload_digest, version FROM operations WHERE auth_nonce = ? ORDER BY created_at LIMIT 1').get(String(p.nonce));
    if (holder) {
      if (holder.payload_digest === p.payloadDigest) {
        // identical retry -> same operation
        return { ok: true, idempotent: true, op: this.getOperation(holder.op_id), work: this.getWork(holder.op_id), outbox: this.getOutbox(holder.op_id) };
      }
      return { ok: false, conflict: true, reason: 'CONFLICT_CHANGED_PAYLOAD', op: this.getOperation(holder.op_id) };
    }
    const run = this.db.prepare(`
      INSERT INTO operations (op_id, payload_digest, agreement_ref, escrow_id, chain_id, custody_address,
                              requested_action, auth_nonce, auth_role, auth_expiry, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', 1, ?, ?)
    `);
    const insertWork = this.db.prepare(`
      INSERT INTO work_items (op_id, chain_id, relayer_account, requested_action, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'PENDING', 1, ?, ?)
    `);
    const insertOutbox = this.db.prepare(`
      INSERT INTO outbox (op_id, commitment_id, manifest_hash, chain_id, custody_address, intent_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `);

    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Blocking incident check INSIDE the acceptance transaction: an
        // outstanding nonce gap/incident prevents new submissions rather than
        // only warning. (Relayer account known at acceptance via worker owner.)
        const relayer = p.relayerAccount || '';
        if (relayer && this._hasBlockingIncidentTx(relayer, p.chainId)) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'BLOCKING_INCIDENT', detail: 'acceptance refused: outstanding blocking nonce incident for relayer account' };
        }
        run.run(opId, p.payloadDigest, p.agreementRef || '', p.escrowId, p.chainId, p.custody,
                p.action, String(p.nonce), p.role, p.authExpiry || 0, now, now);
        if (p.workRequired) {
          insertWork.run(opId, p.chainId, relayer, p.action, now, now);
        }
        if (p.actionArgs !== undefined && p.actionArgs !== null) {
          this.db.prepare('UPDATE operations SET action_args=? WHERE op_id=?')
            .run(JSON.stringify(p.actionArgs), opId);
        }
        if (p.exportArtifacts !== undefined && p.exportArtifacts !== null) {
          this.db.prepare('UPDATE operations SET export_artifacts=? WHERE op_id=?')
            .run(JSON.stringify(p.exportArtifacts), opId);
        }
        insertOutbox.run(opId, p.commitmentDigest, p.manifestHash || p.commitmentDigest,
                         p.chainId, p.custody, JSON.stringify(p.journalIntent || {}), now);
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
      return { ok: true, idempotent: false, op: this.getOperation(opId), work: p.workRequired ? this.getWork(opId) : null, outbox: this.getOutbox(opId) };
    } catch (e) {
      // PK collision -> identical retry or changed-payload conflict
      const existing = this.getOperation(opId);
      if (!existing) throw e;
      const same =
        existing.payloadDigest === p.payloadDigest &&
        existing.authNonce === String(p.nonce) &&
        existing.agreementRef === (p.agreementRef || '') &&
        existing.escrowId === p.escrowId &&
        existing.chainId === p.chainId &&
        existing.custodyAddress === p.custody &&
        existing.requestedAction === p.action;
      if (same) {
        return { ok: true, idempotent: true, op: existing, work: this.getWork(opId), outbox: this.getOutbox(opId) };
      }
      return { ok: false, conflict: true, reason: 'CONFLICT_CHANGED_PAYLOAD', op: existing };
    }
  }

  /** Blocking-incident check WITHOUT opening a nested transaction (the caller
   *  is already inside BEGIN IMMEDIATE). */
  _hasBlockingIncidentTx(relayerAccount, chainId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM incidents
      WHERE acknowledged=0 AND kind IN ('UNEXPECTED_NONCE_CONSUMPTION','NONCE_GAP')
        AND relayer_account=? AND chain_id=?
    `).get(relayerAccount, chainId);
    return (row && row.c > 0) || false;
  }

  // ---- work items ----------------------------------------------------------

  getWork(opId) {
    const row = this.db.prepare('SELECT * FROM work_items WHERE op_id = ?').get(opId);
    return row || null;
  }

  /** Worker polling: claim committed PENDING work atomically (versioned). */
  claimWork(opId, expectedVersion, owner) {
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE work_items SET status='CLAIMED', version=version+1, updated_at=?
      WHERE op_id=? AND version=? AND status='PENDING'
    `).run(now, opId, expectedVersion);
    if (res.changes !== 1) {
      const cur = this.getWork(opId);
      return { ok: false, reason: cur ? 'STALE_VERSION' : 'NO_WORK', current: cur };
    }
    return { ok: true, work: this.getWork(opId) };
  }

  updateWorkStatus(opId, status) {
    const now = this._now();
    this.db.prepare(`UPDATE work_items SET status=?, version=version+1, updated_at=? WHERE op_id=?`)
      .run(status, now, opId);
  }

  listWork(statuses) {
    if (!statuses || statuses.length === 0) {
      return this.db.prepare('SELECT * FROM work_items ORDER BY created_at').all();
    }
    const q = 'SELECT * FROM work_items WHERE status IN (' + statuses.map(() => '?').join(',') + ') ORDER BY created_at';
    return this.db.prepare(q).all(...statuses);
  }

  // ---- outbox ---------------------------------------------------------------

  getOperationActionArgs(opId) {
    const row = this.db.prepare('SELECT action_args FROM operations WHERE op_id = ?').get(opId);
    if (!row || !row.action_args) return null;
    try { return JSON.parse(row.action_args); } catch { return null; }
  }

  getOperationArtifacts(opId) {
    const row = this.db.prepare('SELECT export_artifacts FROM operations WHERE op_id = ?').get(opId);
    if (!row || !row.export_artifacts) return null;
    try { return JSON.parse(row.export_artifacts); } catch { return null; }
  }

  getOutbox(opId) {
    const row = this.db.prepare('SELECT * FROM outbox WHERE op_id = ?').get(opId);
    return row || null;
  }

  listOutbox(statuses) {
    if (!statuses || statuses.length === 0) {
      return this.db.prepare('SELECT * FROM outbox ORDER BY id').all();
    }
    const q = 'SELECT * FROM outbox WHERE status IN (' + statuses.map(() => '?').join(',') + ') ORDER BY id';
    return this.db.prepare(q).all(...statuses);
  }

  markOutboxComplete(opId) {
    const now = this._now();
    this.db.prepare(`UPDATE outbox SET status='COMPLETE', completed_at=? WHERE op_id=? AND status='PENDING'`)
      .run(now, opId);
  }

  markOutboxFailed(opId, reason) {
    this.db.prepare(`UPDATE outbox SET status='FAILED', intent_json=json_set(intent_json, '$.failReason', ?) WHERE op_id=?`)
      .run(String(reason).slice(0, 500), opId);
  }
}

module.exports = { D3Store, opIdFromNonce };