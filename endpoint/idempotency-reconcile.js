// SAAX Protocol — Final Production Reliability Gate (Phase 1)
// Startup/scheduled reconciliation for the Supabase/PostgREST production
// idempotency store.
//
// GAP CLOSED: the file-backed durable idempotency store (idempotency-durable.js)
// reconciles stale pending rows at startup, but the Supabase production path had
// NO reconciliation mechanism. A 'pending' row left by a crashed/lost worker
// stayed pending until TTL sweep (409 forever for the client, or an operator
// "fix" that could delete the row and allow a duplicate payment).
//
// This module exposes reconcile() with the SAME semantics as the file store's
// reconcilePending, but against the DURABLE DB record via the
// ax_router.reconcile_idempotency RPC (transactional per-key advisory locks).
//
// POLICY (never auto-replay; never resolve by age):
//   - confirmedKeys -> 'settled'   (caller has authoritative evidence: chain
//                                   check says the authorization was consumed)
//   - failedKeys    -> 'failed'    (caller evidence says NOT consumed)
//   - stale pending w/o evidence   -> left 'pending', reported UNRESOLVED
//   - mock mode (nothing broadcast)-> force_unknown=true marks failed-safely
//                                     ONLY when the lane is provably mock
//
// Evidence source: the application passes chain/verifier evidence. When the
// caller has no evidence hook, reconcile() must be invoked with empty lists —
// which only marks unresolved rows — NEVER resolving anything by age.
'use strict';

// Consensus threshold for a row to be considered stale (mirrors the file
// store's PENDING_STALE_MS = 60s).
const STALE_AFTER_SECONDS = 60;

/**
 * Reconcile stale pending idempotency rows via the DB RPC.
 *
 * @param {object} opts
 * @param {object} opts.client   PostgREST store client (store.js shape: .rpc())
 * @param {string[]} [opts.confirmedKeys]   keys with authoritative evidence of consumption
 * @param {string[]} [opts.failedKeys]      keys with authoritative evidence of non-consumption
 * @param {boolean}  [opts.forceUnknown]    mock-lane only: mark stale pending as failed
 * @param {number}   [opts.staleAfterSeconds]
 * @param {number}   [opts.limit]
 * @returns {Promise<{reconciled:number, unresolved:number, notes:string[], error?:string}>}
 */
async function reconcile({ client, confirmedKeys, failedKeys, forceUnknown, staleAfterSeconds, limit } = {}) {
  if (!client || typeof client.rpc !== 'function') {
    return { reconciled: 0, unresolved: 0, notes: ['reconcile: no store client (not configured); skipped'], error: 'no store client' };
  }
  const confirmed = Array.isArray(confirmedKeys) ? confirmedKeys.map(String) : [];
  const failed = Array.isArray(failedKeys) ? failedKeys.map(String) : [];
  const params = {
    p_stale_after_seconds: staleAfterSeconds || STALE_AFTER_SECONDS,
    p_limit: limit || 100,
    p_force_unknown: !!forceUnknown,
    p_confirmed_keys: confirmed.length ? confirmed : null,
    p_failed_keys: failed.length ? failed : null,
  };
  try {
    const { data, error } = await client.rpc('reconcile_idempotency', params);
    if (error) throw error;
    const out = {
      reconciled: Number(data && data.reconciled) || 0,
      unresolved: Number(data && data.unresolved) || 0,
      notes: Array.isArray(data && data.notes) ? data.notes : [],
    };
    if (out.reconciled || out.unresolved) {
      console.error('[reliability] DB idempotency reconciliation: reconciled=' + out.reconciled + ' unresolved=' + out.unresolved);
      for (const n of out.notes.slice(0, 20)) console.error('[reliability]   ' + n);
    }
    return out;
  } catch (e) {
    // Store outage / RPC unavailable: DO NOT resolve anything. Preserve
    // unknown outcomes explicitly. (Fail-closed: a reconciliation that cannot
    // run must not be reported as success.)
    const msg = String(e.message || e).slice(0, 200);
    console.error('[reliability] DB idempotency reconciliation failed (outage; nothing resolved): ' + msg);
    return { reconciled: 0, unresolved: 0, notes: ['reconcile failed: ' + msg], error: msg };
  }
}

module.exports = { reconcile, STALE_AFTER_SECONDS };