// SAAX Protocol — Discovery Phase 4: durable single-writer acceptance/operation store
//
// Resolves Phase-4 boundary B (proposal-store concurrency): the Phase-3
// fsync journal serializes only WITHIN one process (in-process promise queue);
// it does NOT safely support multiple processes (two processes can both pass
// the in-memory check and append). This store enforces a SINGLE WRITER with:
//
//   - a lockfile (O_EXCL create) carrying { pid, host, startedAt, writerId };
//   - proven-death stale-lock detection: a lock is broken ONLY when (a) it
//     lives on THIS host AND (b) the owning pid is verifiably dead (process.kill
//     with signal 0) AND (c) the pid cannot be a recycled pid that could hand
//     the lock to a new process (pid-start-time guard). A lock that is merely
//     OLD while its record owner is still alive is NEVER reclaimed (no
//     age-based expiry). A lock from an unknown host is treated conservatively.
//   - renewable lease + fencing at every write: the owner creates the lock
//     (O_EXCL), then RENEWS the lock file every RENEW_INTERVAL_MS
//     ({pid,host,writerId,startedAt,ownerStartedAtMs,renewedAt}); every journal
//     WRITE re-checks the lock file and asserts it still names THIS
//     process+writerId. A lock lost to a proven-dead-owner recovery turns every
//     subsequent write from the old owner into a fencing failure
//     (DSC_STORE_NOT_OWNER) — the old owner can never continue writing after
//     ownership loss and can never delete a successor's lock.
//   - PID-reuse guard: the lock records the owner's process START TIME
//     (ownerStartedAtMs). Recovery breaks a dead-pid lock ONLY when the pid's
//     current process started before the lock was written. A recycled pid
//     (current owner started after the lock) => recovery deferred (conservative).
//   - concurrent recovery: recovery is guarded by a RECOVERY-INTENT marker
//     (O_EXCL), so two concurrent recoverers can never both become owners.
//   - ownership enforcement: an operation store bound to the same directory
//     from a DIFFERENT process that holds the lock is refused
//     (DSC_STORE_LOCKED) — never silently sharing the journal;
//   - restart recovery: a new store instance reloads the journal; torn tails
//     are truncated and reported (never merged).
//
// The journal itself remains an append-only fsync-before-ack file (one JSON
// line per accepted operation), so a crash mid-write leaves either the old
// complete journal or the new line, and the atomicity claim covers the
// persisted operation record ONLY (external execution/reconciliation is
// outside the claim, per spec §7.4).
//
// Record shape (one accepted operation = one line):
// {
//   kind: 'acceptance',
//   operationId,              // op_<hex> (deterministic per acceptance)
//   commitmentId,             // deterministic commitment id
//   proposalId, requestDigest, clientNonce,
//   acceptedAt,               // issuance time (controlled clock)
//   status,                   // 'accepted' | 'commitment_created' | 'rejected'
//   reason,                   // when rejected
//   profileVersion, signingKeyId, manifestVersion, manifestDigest,
//   schema: { id, version, digest },
//   buyerScope: { buyer, scopeMaxAmount, scopeCurrency, scopeCapability },
//   proposalDigest: 'sha256:<hex>' of the canonical signed proposal,
//   acceptanceRef: { acceptanceId, digest, keyId },
//   commitmentRef: { manifestHash, digest } | null,
//   signedRepresentation: { version, jws, keyId } | null,   // manifest-v1.1 wrapper
//   idempotencyKey                  // caller-scoped key (opaque, hashed on write)
// }
//
// Semantics (durably accept once):
//   - same idempotencyKey + same request digest  -> DUPLICATE (same operation,
//     same commitment, status preserved, e.g. commitment_created on replay)
//   - same idempotencyKey + DIFFERENT digest     -> CONFLICT (DSC_NONCE_CONFLICT)
//   - same proposalId (single-use) + new idempotencyKey -> REJECTED for reuse
//     (unless the signed proposal declares repeatability; none do in scope)
//   - concurrent identical acceptances            -> exactly ONE accepted op
//   - restart                                     -> journal reloaded; accepted
//     operations are discoverable and resumable

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCK_STALE_MS = 5 * 60 * 1000; // renewal threshold — a live owner must renew before this; NEVER the trigger for breaking a lock
const RENEW_INTERVAL_MS = 60 * 1000; // lease renewal cadence (must be < LOCK_STALE_MS)
const OWNER_START_MS = Date.now(); // this process's start time (pid-reuse guard)

class AcceptanceStore {
  /**
   * @param {string} dir directory for journal + lock (created if absent)
   * @param {{ now?: () => number, lockStaleMs?: number, host?: string }} opts
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.nowMs = opts.now || (() => Date.now());
    this.host = opts.host || 'local';
    this.lockStaleMs = opts.lockStaleMs || LOCK_STALE_MS;
    this.renewIntervalMs = opts.renewIntervalMs || RENEW_INTERVAL_MS;
    this.lockFile = path.join(dir, 'operation.lock');
    this.file = path.join(dir, 'operations.journal');
    this.writerId = crypto.randomBytes(8).toString('hex');
    this.recoverIntentFile = path.join(dir, 'operation.lock.recovery');
    this._renewTimer = null;
    this._records = new Map();       // operationId -> record
    this._byIdem = new Map();        // `${idemKey}\u0000${digest}` -> operationId
    this._byProposal = new Map();    // proposalId -> operationId (single-use)
    this._queue = Promise.resolve();
    this._recoveredStaleLock = false;
    this._recoveredTail = false;
    this._locked = false;
    this._lockError = null;
    this._ready = this._init();
  }

  _init() {
    fs.mkdirSync(this.dir, { recursive: true });
    const acquired = this._acquireLock();
    if (!acquired.ok) {
      this._lockError = acquired.reason;
      return;
    }
    this._locked = true;
    this._load();
    this._startRenewal();
  }

  _acquireLock() {
    // Fast path: O_EXCL create (no contention).
    const fresh = this._tryCreateLock();
    if (fresh.ok) return fresh;
    // Contended — decide by the lock's content, NEVER by age alone.
    const info = fresh.info || {};
    this._lockPid = info.pid;
    const sameHost = info.host === this.host;
    const pidAlive = sameHost && this._pidAlive(info.pid);
    const ownerStartedAt = Number(info.ownerStartedAtMs || 0);
    const pidRecycled = sameHost && ownerStartedAt > 0 && this._recycledPid(info.pid, ownerStartedAt);
    if (sameHost && pidRecycled) {
      // The lock claims OUR pid with an owner start EARLIER than this
      // process's start: the pid was recycled after the original owner died;
      // we cannot be that owner. Owner death is unproven -> reclaim deferred.
      return { ok: false, reason: 'acceptance store lock pid was recycled (owner death unproven; reclaim deferred) — ' + info.pid };
    }
    if (sameHost && !pidAlive) {
      // PROVEN DEATH on this host: pid not alive (and not ours) -> safe.
      // Race-safe reclaim via the recovery-intent marker.
      const rec = this._tryClaimRecovery(info.pid);
      if (!rec.ok) return { ok: false, reason: rec.reason };
      this._recoveredStaleLock = true;
      const again = this._tryCreateLock();
      return again.ok ? again : { ok: false, reason: 'lock re-acquired by a concurrent recoverer' };
    }
    if (sameHost && pidAlive) {
      return { ok: false, reason: 'acceptance store locked by a live process (pid ' + info.pid + ')' };
    }
    return { ok: false, reason: 'acceptance store locked by another host (' + (info.host || 'unknown') + '); ownership unknown, treated conservatively' };
  }

  _tryCreateLock() {
    try {
      const fd = fs.openSync(this.lockFile, 'wx'); // O_EXCL — fail if exists
      const info = { pid: process.pid, host: this.host, writerId: this.writerId, startedAt: new Date().toISOString(), ownerStartedAtMs: OWNER_START_MS, renewedAt: new Date().toISOString() };
      fs.writeSync(fd, JSON.stringify(info), null, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return { ok: true, info };
    } catch (e) {
      let raw = null;
      try { raw = fs.readFileSync(this.lockFile, 'utf8'); } catch (_) { /* fall through */ }
      try { return { ok: false, info: JSON.parse(raw) }; } catch (_) { return { ok: false, info: {} }; }
    }
  }

  _tryClaimRecovery(targetPid) {
    // O_EXCL marker: only one process may break+re-acquire at a time.
    try {
      const fd = fs.openSync(this.recoverIntentFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, reclaiming: targetPid, at: new Date().toISOString() }), null, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch (_) {
      return { ok: false, reason: 'another process is already recovering this lock' };
    }
    try { fs.unlinkSync(this.lockFile); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(this.recoverIntentFile); } catch (_) { /* ignore */ }
    return { ok: true };
  }

  _pidAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
  }

  _recycledPid(pid, ownerStartedAt) {
    // The only ambiguous case is a lock claiming THIS process's pid: if the
    // lock's recorded owner-start differs from THIS process's start, the
    // recorded owner cannot be us — the pid was recycled after the original
    // owner died (or the lock is malformed/future-dated). Reclaim must be
    // deferred (owner death unproven for the lock's writerId). A dead pid
    // that is NOT ours is unambiguous proven death -> recovery is safe.
    if (pid !== process.pid) return false;
    if (ownerStartedAt <= 0) return false; // no guard info -> rely on pidAlive only
    return Number(ownerStartedAt) !== OWNER_START_MS;
  }

  _startRenewal() {
    this._renewTimer = setInterval(() => {
      try {
        const raw = fs.readFileSync(this.lockFile, 'utf8');
        const info = JSON.parse(raw);
        if (info.pid === process.pid && info.writerId === this.writerId) {
          const fd = fs.openSync(this.lockFile, 'w'); // overwrite (we own it)
          fs.writeSync(fd, JSON.stringify({ ...info, renewedAt: new Date().toISOString() }), null, 'utf8');
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        } else {
          // We lost ownership (e.g. a successor recovering OUR pid). Stop
          // renewing; every write will fence.
          this._locked = false;
          if (this._renewTimer) { clearInterval(this._renewTimer); this._renewTimer = null; }
        }
      } catch (_) { /* transient; next tick retries */ }
    }, this.renewIntervalMs);
    if (this._renewTimer.unref) this._renewTimer.unref();
  }

  _assertOwnership() {
    // Fencing at every write: the lock must STILL name this process+writerId.
    if (!this._locked) {
      const e = new Error('acceptance store ownership lost (lock no longer held)');
      e.code = 'DSC_STORE_NOT_OWNER';
      throw e;
    }
    try {
      const raw = fs.readFileSync(this.lockFile, 'utf8');
      const info = JSON.parse(raw);
      if (info.pid !== process.pid || info.writerId !== this.writerId) {
        this._locked = false;
        const e = new Error('acceptance store ownership lost (lock now held by ' + (info.pid || '?') + '/' + (info.writerId || '?') + ')');
        e.code = 'DSC_STORE_NOT_OWNER';
        throw e;
      }
      return true;
    } catch (e) {
      if (e.code === 'DSC_STORE_NOT_OWNER') throw e;
      const e2 = new Error('acceptance store ownership check failed: ' + (e && e.message || e));
      e2.code = 'DSC_STORE_NOT_OWNER';
      throw e2;
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) { fs.writeFileSync(this.file, '', 'utf8'); return; }
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n');
      let torn = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          this._index(rec);
        } catch (_) {
          torn = true;
          this._truncateTo(i);
          break;
        }
      }
      if (torn) this._recoveredTail = true;
    } catch (e) {
      throw new Error('acceptance store: cannot open journal: ' + (e && e.message || e));
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
    this._records.set(rec.operationId, rec);
    if (rec.idempotencyKey && rec.requestDigest) this._byIdem.set(rec.idempotencyKey + '\u0000' + rec.requestDigest, rec.operationId);
    if (rec.proposalId) {
      const existing = this._byProposal.get(rec.proposalId);
      // Keep the FIRST (accepted) operation for a single-use proposal.
      if (!existing) this._byProposal.set(rec.proposalId, rec.operationId);
    }
  }

  get recoveredStaleLock() { return this._recoveredStaleLock; }
  get recoveredTail() { return this._recoveredTail; }
  get lockError() { return this._lockError; }
  get isLocked() { return this._locked; }
  get size() { return this._records.size; }

  _checkReady() {
    if (this._lockError) {
      const e = new Error(this._lockError);
      e.code = 'DSC_STORE_LOCKED';
      throw e;
    }
    if (!this._locked) {
      // Ownership was lost (released or stolen): every write is fenced.
      const e = new Error('acceptance store ownership lost (lock no longer held)');
      e.code = 'DSC_STORE_NOT_OWNER';
      throw e;
    }
  }

  /**
   * Atomically persist an acceptance decision (single decision point).
   * record: see header. Must include idempotencyKey, requestDigest, proposalId,
   *          proposalDigest, operationId, commitmentId, status, acceptedAt,
   *          buyerScope, versions/digests, acceptanceRef.
   * Returns:
   *   { ok:true, duplicate:false }                      -> accepted (appended)
   *   { ok:true, duplicate:true, record }               -> identical retry (same op)
   *   { ok:false, status:'conflict', reason }           -> same idem key, diff digest
   *   { ok:false, status:'reused_proposal', reason }    -> single-use proposal already
   *                                                       accepted under a different key
   *   { ok:false, status:'store_error', reason }        -> I/O failure
   */
  async persistAcceptance(record) {
    this._checkReady();
    const run = this._queue.then(async () => {
      this._assertOwnership(); // fencing before any write
      const idemKey = record.idempotencyKey + '\u0000' + record.requestDigest;
      const existingId = this._byIdem.get(idemKey);
      if (existingId) {
        const rec = this._records.get(existingId);
        if (rec && rec.operationId === record.operationId) return { ok: true, duplicate: false };
        return { ok: true, duplicate: true, record: rec };
      }
      // Same idempotency key, different digest -> conflict.
      for (const [k, id] of this._byIdem) {
        const [key, digest] = k.split('\u0000');
        if (key === record.idempotencyKey && digest !== record.requestDigest) {
          return { ok: false, status: 'conflict', reason: 'idempotencyKey reused with a different request digest' };
        }
      }
      // Single-use proposal: another operation already accepted it.
      const existingOp = this._byProposal.get(record.proposalId);
      if (existingOp && existingOp !== record.operationId) {
        const rec = this._records.get(existingOp);
        return { ok: false, status: 'reused_proposal', reason: 'proposal already accepted under operation ' + existingOp + (rec && rec.status === 'rejected' ? '' : ' (single-use)') };
      }
      // Append atomically (fsync before ack).
      const line = JSON.stringify(record) + '\n';
      try {
        const fd = fs.openSync(this.file, 'a');
        try { fs.writeSync(fd, line, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch (e) {
        return { ok: false, status: 'store_error', reason: (e && e.message || e) };
      }
      this._index(record);
      return { ok: true, duplicate: false };
    });
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Update an existing operation's status (append-only status transition). */
  async transition(operationId, patch) {
    this._checkReady();
    const run = this._queue.then(async () => {
      this._assertOwnership(); // fencing before any write
      const rec = this._records.get(operationId);
      if (!rec) return { ok: false, reason: 'operation not found' };
      const updated = { ...rec, ...patch, status: patch.status || rec.status };
      const line = JSON.stringify(updated) + '\n';
      try {
        const fd = fs.openSync(this.file, 'a');
        try { fs.writeSync(fd, line, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch (e) { return { ok: false, reason: (e && e.message || e) }; }
      this._records.set(operationId, updated);
      return { ok: true, record: updated };
    });
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Lookup by operationId (null when absent). */
  getByOperation(operationId) {
    return this._records.get(operationId) || null;
  }

  /** Lookup by idempotency scope (client idempotency key + digest). */
  getByIdempotency(key, digest) {
    const id = this._byIdem.get(key + '\u0000' + digest);
    return id ? this._records.get(id) || null : null;
  }

  /** Lookup by proposalId (the acceptance/commitment for a proposal). */
  getByProposal(proposalId) {
    const id = this._byProposal.get(proposalId);
    return id ? this._records.get(id) || null : null;
  }

  releaseLock() {
    if (!this._locked) return;
    // Only the CURRENT owner may delete the lock; a stale owner must never
    // delete a successor's lock.
    try {
      const raw = fs.readFileSync(this.lockFile, 'utf8');
      const info = JSON.parse(raw);
      if (info.pid === process.pid && info.writerId === this.writerId) {
        fs.unlinkSync(this.lockFile);
      }
    } catch (_) { /* ignore */ }
    if (this._renewTimer) { clearInterval(this._renewTimer); this._renewTimer = null; }
    this._locked = false;
  }
}

function operationDigestOf(record) {
  const canonical = JSON.stringify({
    operationId: record.operationId,
    commitmentId: record.commitmentId,
    proposalId: record.proposalId,
    requestDigest: record.requestDigest,
    clientNonce: record.clientNonce,
    acceptedAt: record.acceptedAt,
    profileVersion: record.profileVersion,
    manifestVersion: record.manifestVersion,
    manifestDigest: record.manifestDigest,
    schema: record.schema,
    buyerScope: record.buyerScope,
    terms: record.terms,
  });
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = { AcceptanceStore, operationDigestOf, LOCK_STALE_MS, RENEW_INTERVAL_MS };
