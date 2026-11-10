// SAAX Protocol — Reliability audit: durable idempotency store (file-backed)
//
// Single-writer, restart-safe key-value store for payment idempotency rows and
// gateway nonce records. This is the NO-SUPABASE fallback for the payment path
// so financial-safety replay protection survives process restart — the same
// durability pattern proven by endpoint/proposal-store.js (atomic write +
// fsync + torn-tail recovery), applied to idempotency.
//
// TOPOLOGY BOUNDARY (documented in docs/reliability-audit/02-*):
//   This store is SINGLE-WRITER — one process at a time on one host. It is NOT
//   safe under concurrent multi-process writers (e.g. two Vercel instances).
//   Production on a multi-instance runtime must configure Supabase (cross-
//   instance advisory lock via acquire_idempotency RPC). See the design doc.
//
// ATOMICITY: each mutation writes <key>.json.tmp, fsyncs, then renames over
//   the live file (Windows: MoveFileEx MOVEFILE_REPLACE_EXISTING — atomic on
//   the same volume). A crash mid-write leaves the old file intact or the new
//   one complete; a torn tmp is ignored. No append journal to corrupt.
//
// RECONCILIATION (startup): pending rows older than PENDING_STALE_MS are
//   reconciled per mode:
//     - mock:  safe to fail (nothing was broadcast) -> mark 'failed'
//     - self:  with chainCheck(key, row) -> {known, consumed} consult:
//                consumed -> 'settled' (recovered, note; no fabricated receipt)
//                not consumed -> 'failed' (safe retry)
//     - self:  without chainCheck (offline) -> left 'pending' with
//                recovery:'unresolved' (blocked; NEVER silently retried)
//   Rows missing `meta` (no nonce) without chainCheck also stay unresolved.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PENDING_STALE_MS = 60_000;

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

class DurableIdempotencyStore {
  /**
   * @param {string} dir directory for key files (created if absent)
   */
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(key) {
    return path.join(this.dir, hashKey(key) + '.json');
  }

  _read(key) {
    const f = this._file(key);
    if (!fs.existsSync(f)) return null;
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
    try { return JSON.parse(raw); } catch (_) {
      // Reliability remediation (fail-closed): a corrupt row must NOT be
      // treated as an absent key. If it were, a previously settled key would
      // re-insert as 'pending' and a duplicate payment could be authorized.
      // Return a sentinel so acquire() can FAIL CLOSED instead.
      return { __corrupt: true, file: f };
    }
  }

  _write(key, row) {
    const f = this._file(key);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(row), 'utf8');
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd); // Windows: must close the handle before rename (EPERM otherwise)
    }
    fs.renameSync(tmp, f);
  }

  /**
   * Atomic acquire. Same contract as the Supabase RPC + mem path:
   *   returns 'inserted'
   *   returns { conflict:true, status, response_status?, response_body? }
   *   throws Error('payload hash mismatch: ...') on key reuse w/ different hash
   */
  acquire(key, payloadHash, ttlHours, meta) {
    if (!key) throw new Error('durable idempotency: key is required');
    const existing = this._read(key);
    const now = Date.now();
    if (existing && existing.__corrupt) {
      throw new Error('durable idempotency: corrupt row for key (fail-closed; operator must repair or remove the file explicitly): ' + existing.file);
    }
    if (!existing) {
      const row = {
        key: String(key),
        status: 'pending',
        payload_hash: payloadHash || null,
        meta: meta || null,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + Number(ttlHours || 24) * 3600 * 1000).toISOString(),
      };
      this._write(key, row);
      // Double-check after create: another writer (shouldn't happen in
      // single-writer topology, but defend) that raced in gets a conflict.
      const after = this._read(key);
      if (after && after.status === 'pending' && (after.payload_hash || null) !== (payloadHash || null)) {
        throw new Error('payload hash mismatch: idempotency key reused for a different request');
      }
      return 'inserted';
    }
    if (existing.payload_hash && payloadHash && existing.payload_hash !== payloadHash) {
      throw new Error('payload hash mismatch: idempotency key reused for a different request');
    }
    if (existing.status === 'pending') {
      return { conflict: true, status: 'pending' };
    }
    return {
      conflict: true,
      status: existing.status,
      response_status: existing.response_status,
      response_body: existing.response_body,
    };
  }

  /** Atomic status update (same call sites as storeUpdate). */
  update(key, status, responseStatus, responseBody, meta) {
    const f = this._file(key);
    const row = this._read(key) || { key: String(key), created_at: new Date().toISOString() };
    row.status = status;
    if (responseStatus !== undefined && responseStatus !== null) row.response_status = responseStatus;
    if (typeof responseBody === 'string') row.response_body = responseBody;
    if (meta) row.meta = meta;
    row.updated_at = new Date().toISOString();
    // Preserve expiry when re-writing an existing row.
    if (!row.expires_at) row.expires_at = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    this._write(key, row);
  }

  get(key) {
    const row = this._read(key);
    if (!row) return null;
    return row;
  }

  list() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { return out; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.dir, n), 'utf8');
        const row = JSON.parse(raw);
        if (row && row.key) out.push(row);
      } catch (_) { /* torn file — skip */ }
    }
    return out;
  }

  remove(key) {
    const f = this._file(key);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best-effort */ }
  }

  sweepExpired() {
    const now = Date.now();
    for (const row of this.list()) {
      if (row.expires_at && new Date(row.expires_at).getTime() < now) this.remove(row.key);
    }
  }

  /**
   * Startup reconciliation of stale pending rows.
   * @param {{mode:string, now?:()=>number, chainCheck?:(key,row)=>Promise<{known:boolean,consumed?:boolean}>}} opts
   * @returns {Promise<{reconciled:number, unresolved:number, notes:string[]}>}
   */
  async reconcilePending({ mode, now, chainCheck } = {}) {
    const ts = now ? now() : Date.now();
    const notes = [];
    let reconciled = 0, unresolved = 0;
    for (const row of this.list()) {
      if (row.status !== 'pending') continue;
      const created = new Date(row.created_at || 0).getTime();
      if (ts - created < PENDING_STALE_MS) continue; // still plausibly in flight

      if (mode === 'mock') {
        this.update(row.key, 'failed', null, null, { ...(row.meta || {}), recovery: 'mock-pending-reconciled' });
        notes.push('key ' + String(row.key).slice(0, 24) + ': mock pending -> failed (nothing broadcast)');
        reconciled++;
        continue;
      }
      // self mode
      if (typeof chainCheck === 'function') {
        try {
          const verdict = await chainCheck(row.key, row);
          if (verdict && verdict.known && verdict.consumed === true) {
            this.update(row.key, 'settled', 200, null, { ...(row.meta || {}), recovery: 'chain-reconciled-consumed', note: 'pending recovered: authorization consumed on-chain (txHash must be confirmed manually; receipt body not fabricated)' });
            notes.push('key ' + String(row.key).slice(0, 24) + ': self pending -> settled (chain consumed)');
            reconciled++;
          } else if (verdict && verdict.known && verdict.consumed === false) {
            this.update(row.key, 'failed', null, null, { ...(row.meta || {}), recovery: 'chain-reconciled-not-consumed' });
            notes.push('key ' + String(row.key).slice(0, 24) + ': self pending -> failed (chain NOT consumed)');
            reconciled++;
          } else {
            this.update(row.key, 'pending', null, null, { ...(row.meta || {}), recovery: 'unresolved', recoveryAt: new Date(ts).toISOString() });
            notes.push('key ' + String(row.key).slice(0, 24) + ': self pending UNRESOLVED (chain unknown)');
            unresolved++;
          }
        } catch (e) {
          this.update(row.key, 'pending', null, null, { ...(row.meta || {}), recovery: 'unresolved-chain-error', recoveryError: String(e.message || e).slice(0, 160), recoveryAt: new Date(ts).toISOString() });
          notes.push('key ' + String(row.key).slice(0, 24) + ': self pending UNRESOLVED (chain error)');
          unresolved++;
        }
      } else {
        this.update(row.key, 'pending', null, null, { ...(row.meta || {}), recovery: 'unresolved-offline', recoveryAt: new Date(ts).toISOString() });
        notes.push('key ' + String(row.key).slice(0, 24) + ': self pending UNRESOLVED (offline; blocked)');
        unresolved++;
      }
    }
    return { reconciled, unresolved, notes };
  }
}

module.exports = { DurableIdempotencyStore, PENDING_STALE_MS };
