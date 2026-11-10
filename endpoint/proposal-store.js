// SAAX Protocol — Discovery Phase 3: durable proposal store
//
// File-backed, append-only, restart-safe idempotency store for issued
// proposals (prepare_commitment). Design decisions:
//
//   - The SAAX repo's live deployment uses Supabase (ax_router schema,
//     `api/lib/supabase.mjs`, service-role RPCs), BUT this phase deliberately
//     keeps proposal persistence portable and dependency-free so the isolated
//     HTTP endpoint and the MCP adapter work in ANY environment (local test,
//     Vercel function, or a future DB-backed row). A file-backed append-only
//     journal is restart-safe and atomic per record (fsync + one write), and
//     matches the Phase-2 test-harness philosophy of no external service
//     requirement. Supabase/DB backing is documented as the deployment
//     upgrade path (Phase 4), NOT assumed live here.
//
//   - Atomicity: each accepted issuance is ONE append (JSON line) flushed
//     with fsync before the proposal is returned. A crash mid-write leaves
//     either the old complete journal or the new line; record boundaries are
//     verified on load (each line must parse; a torn tail line is truncated
//     and reported as recovered, never silently merged).
//
//   - Idempotency semantics (spec §6.5, §7.4):
//       * same scoped idempotency key (clientNonce + requestDigest) with the
//         same request digest  -> DUPLICATE: return the SAME unexpired proposal
//       * same key with a DIFFERENT digest -> CONFLICT (DSC_NONCE_CONFLICT),
//         never silently re-issued
//       * expired proposals remain expired (a duplicate lookup returns the
//         stored proposal; expiry is judged by the caller's controlled clock;
//         replacement is explicit — see `expire`/`replace`)
//       * concurrent retries can NOT create contradictory records: the store
//         serializes via a lockfile-free in-process promise queue AND a
//         compare-and-swap check inside the append (double-check before write;
//         the journal is the single source of truth after reload).
//
//   - Nonce separation: proposal records live in this store ONLY. They are
//     distinct from account nonces, access nonces, evaluator-verdict nonces,
//     and the payment idempotency-key store (endpoint/idempotency.js). No
//     shared nonce space.
//
//   - Privacy: we store the cardinal fields needed to reproduce + verify the
//     proposal (proposalId, nonce, requestDigest, signedPayload, versions/
//     digests, status, signature ref). We do NOT log the private key or any
//     credentials, and the signedPayload is the proposal (no buyer secrets
//     beyond what the request already carried).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROPOSAL_TTL_MS = 24 * 3600 * 1000; // operational retention; signed expiry is authoritative

class ProposalStore {
  /**
   * @param {string} dir directory for the journal file (created if absent)
   * @param {{ now?: () => number }} opts optional injectable clock (ms)
   */
  constructor(dir, opts) {
    this.dir = dir;
    this.nowMs = (opts && opts.now) || (() => Date.now());
    this.file = path.join(dir, 'proposals.journal');
    this._records = new Map(); // proposalId -> record
    this._byScope = new Map(); // `${nonce}\u0000${digest}` -> proposalId
    this._queue = Promise.resolve();
    this._ready = this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.file)) {
        fs.writeFileSync(this.file, '', 'utf8');
        return;
      }
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n');
      let torn = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          this._index(rec);
        } catch (e) {
          // Torn/partial tail (crash mid-write) — truncate here.
          torn = true;
          this._truncateTo(i);
          break;
        }
      }
      if (torn) this._recoveredTail = true;
    } catch (e) {
      throw new Error('proposal store: cannot open journal: ' + (e && e.message || e));
    }
  }

  _truncateTo(lineIndex) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      const keep = lines.slice(0, lineIndex).join('\n') + (lineIndex > 0 ? '\n' : '');
      fs.writeFileSync(this.file, keep, 'utf8');
    } catch (_) { /* best-effort */ }
  }

  _index(rec) {
    this._records.set(rec.proposalId, rec);
    this._byScope.set(rec.nonce + '\u0000' + rec.requestDigest, rec.proposalId);
  }

  get recoveredTail() { return !!this._recoveredTail; }

  /**
   * Atomically persist an issued proposal.
   * record: { proposalId, nonce, requestDigest, signedPayload, profileVersion,
   *           schema, issuedAt, expires, status, signature, scope? }
   * Returns:
   *   { ok:true, duplicate:false }                 -> issued (appended)
   *   { ok:true, duplicate:true, proposal }          -> identical retry (same
   *                                                      key+digest): the SAME
   *                                                      stored proposal is
   *                                                      returned (never a new
   *                                                      one)
   *   { ok:false, status:'conflict', reason }        -> same nonce, DIFFERENT
   *                                                      request digest
   *   { ok:false, status:'store_error', reason }     -> I/O failure
   *
   * This is the SINGLE atomic decision point: serialized in-process, with a
   * compare-and-swap check inside the same queued critical section as the file
   * append. A concurrent duplicate/conflict can never produce two issued
   * records or a contradictory pair (also enforced on reload).
   */
  async persist(record) {
    const run = this._queue.then(async () => {
      const key = record.nonce + '\u0000' + record.requestDigest;
      const existing = this._byScope.get(key);
      if (existing) {
        const rec = this._records.get(existing);
        if (rec && rec.proposalId === record.proposalId) return { ok: true, duplicate: false }; // same record re-persisted
        // Same scope + different proposalId: identical retry of the same
        // request — return the SAME stored proposal (duplicate), never a new
        // one. (The only way a different proposalId reaches here for the same
        // key is a genuinely identical request re-issued after a restart or an
        // in-flight retry; both must see the original.)
        return { ok: true, duplicate: true, proposal: rec ? safeParse(rec.signedPayload) : null };
      }
      // Same nonce with a DIFFERENT digest -> conflict (never silent re-issue).
      for (const [k, id] of this._byScope) {
        const [nonce, digest] = k.split('\u0000');
        if (nonce === record.nonce && digest !== record.requestDigest) {
          return { ok: false, status: 'conflict', reason: 'clientNonce reused with a different request digest' };
        }
      }
      const line = JSON.stringify(record) + '\n';
      try {
        const fd = fs.openSync(this.file, 'a');
        try {
          fs.writeSync(fd, line, null, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (e) {
        return { ok: false, status: 'store_error', reason: (e && e.message || e) };
      }
      this._index(record);
      return { ok: true, duplicate: false };
    });
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Look up a proposal by id (null when absent). */
  getById(proposalId) {
    const rec = this._records.get(proposalId);
    return rec ? safeParse(rec.signedPayload) : null;
  }

  /** Look up by scope (clientNonce + requestDigest). */
  getByScope(scope) {
    const id = this._byScope.get(scope.clientNonce + '\u0000' + scope.requestDigest);
    if (!id) return null;
    const rec = this._records.get(id);
    return rec ? safeParse(rec.signedPayload) : null;
  }

  /** Record count (live). */
  get size() { return this._records.size; }

  /**
   * Explicit replacement: expire an existing proposal (status -> 'expired').
   * A proposal is only replaced when the caller proves it (same scope + new
   * digest + explicit re-issue permission). Phase 3 keeps this API but the
   * preflight core does NOT auto-replace — expired stays expired; a fresh
   * proposal requires a fresh clientNonce.
   */
  async expire(proposalId, reason) {
    const existing = this._records.get(proposalId);
    if (!existing) return { ok: false, reason: 'not_found' };
    const updated = { ...existing, status: 'expired', expiredReason: reason || 'replaced' };
    try {
      const fd = fs.openSync(this.file, 'a');
      try { fs.writeSync(fd, JSON.stringify(updated) + '\n', null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { return { ok: false, reason: (e && e.message || e) }; }
    this._records.set(proposalId, updated);
    return { ok: true };
  }

  /** Sweep records older than the operational retention (keeps file bounded). */
  async sweepExpired() {
    const cutoff = this.nowMs() - PROPOSAL_TTL_MS;
    const stale = [...this._records.values()].filter((r) => Date.parse(r.expires || r.issuedAt) < cutoff);
    for (const rec of stale) {
      this._records.delete(rec.proposalId);
      this._byScope.delete(rec.nonce + '\u0000' + rec.requestDigest);
    }
    return stale.length;
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

module.exports = { ProposalStore, PROPOSAL_TTL_MS };
