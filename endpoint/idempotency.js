// SAAX Protocol — Day 8, Item 1: Idempotency keys on every payment request (pre-live)
//
// Threat: network retries / RPC timeouts / client re-submissions can process the
// same payment request twice. Mock mode masks it; live mode = double charge.
//
// Rules (brief):
//   - Every demand request accepted at /route carries a client-supplied
//     Idempotency-Key header, OR the server derives a DETERMINISTIC key from
//     hash(buyerAddress + capability + budget + deadline + nonce) when absent.
//   - Before ANY payment verification, check the key against a persistent store
//     (Supabase saax_router.idempotency_keys).
//       * exists + (verified|settled) -> return the CACHED RESPONSE, no re-process
//       * exists + pending            -> 409 Conflict (previous request in flight)
//       * new                         -> insert pending, process, then update to
//                                        verified|settled on success, failed on error
//   - Payload hash = hash(capability + budget + deadline). Same key + DIFFERENT
//     payload hash -> 422 (client reusing a key for a different request =
//     protocol violation).
//   - TTL 24h; cleanup job runs hourly (sweep).
//
// Store: Supabase saax_router.idempotency_keys via REST (injected client, same as
// ratelimit.js). No-blocking route-around: if the store is unavailable, the gate
// fails OPEN with a warning log (never block the router on a DB outage) — but the
// brief's protocol-violation checks remain enforced in-process for the session.
const crypto = require('crypto');

const TTL_HOURS = 24;
const SWEEP_INTERVAL_MS = 3600000; // hourly cleanup (brief)

let _supabaseClient = null;
function setStoreClient(c) { _supabaseClient = c; }

// ---- Durable fallback (reliability audit) ------------------------------------
// When Supabase is not configured and the store is NOT forced to memory, the
// payment idempotency gate can use a file-backed durable store so replay
// protection survives process restart (single-writer topology). See
// idempotency-durable.js + docs/reliability-audit/02-payment-idempotency-design.md.
let _durableStore = null;
function setDurableStore(store) { _durableStore = store; }
function getDurableStore() { return _durableStore; }

// ---- Deterministic key derivation (no header case, brief) -------------------
// hash(buyerAddress + capability + budget + deadline + nonce)
// Day 8 closure (regression fix): `extra` folds fee-affecting request inputs
// (e.g. x-mock-buyer-rep) into the derived key when present. Without this, two
// requests with the same body from the same buyer — but different buyer-rep
// headers (no rep vs rep:96) — would collide on the SAME derived key and the
// second would replay the first's CACHED response, applying the wrong discount.
function deriveKey({ buyerAddress, capability, budget, deadline, nonce, extra }) {
  const material = [
    String(buyerAddress || '').toLowerCase(),
    String(capability || ''),
    String(budget === undefined ? '' : budget),
    String(deadline === undefined ? '' : deadline),
    String(nonce === undefined ? '' : nonce),
    extra === undefined || extra === null ? '' : String(extra),
  ].join('|');
  return 'der:' + Buffer.from(crypto.createHash('sha256').update(material, 'utf8').digest()).toString('hex');
}

// ---- Payload hash (brief): hash(capability + budget + deadline) -------------
function payloadHash({ capability, budget, deadline }) {
  const material = [
    String(capability || ''),
    String(budget === undefined ? '' : budget),
    String(deadline === undefined ? '' : deadline),
  ].join('|');
  return 'ph:' + Buffer.from(crypto.createHash('sha256').update(material, 'utf8').digest()).toString('hex');
}

// ---- Header extraction -------------------------------------------------------
// Header name per brief: "Idempotency-Key"
function headerKey(req) {
  const v = (req.headers && req.headers['idempotency-key']) || '';
  return String(v).trim() || null;
}

// ---- In-memory fallback (brief-sanctioned route-around: no blocked builds;
// Supabase is the production target, memory keeps the gates functional when
// creds are absent — same pattern as ratelimit.js).
const memStore = new Map(); // key -> row
let _internalMode = null;   // null = follow client, 'memory' = forced by tests

function useSupabase() {
  return _internalMode !== 'memory' && !!_supabaseClient;
}

function useDurable() {
  return _internalMode !== 'memory' && !_supabaseClient && !!_durableStore;
}

function memGet(key) { return memStore.get(key) || null; }

function memInsert(key, payloadHashValue, ttlHours) {
  const now = new Date();
  const row = {
    key,
    status: 'pending',
    payload_hash: payloadHashValue,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlHours * 3600000).toISOString(),
  };
  memStore.set(key, row);
  return 'inserted';
}

function memUpdate(key, status, responseStatus, responseBody) {
  const row = memStore.get(key);
  if (!row) return;
  row.status = status;
  if (responseStatus !== undefined && responseStatus !== null) row.response_status = responseStatus;
  if (typeof responseBody === 'string') row.response_body = responseBody;
  memStore.set(key, row);
}

// ---- Store helpers (Supabase REST; all throw on store failure) --------------
async function storeGet(key) {
  if (useDurable()) {
    return _durableStore.get(key) || null;
  }
  if (!_supabaseClient) throw new Error('supabase idempotency store not configured');
  const { data, error } = await _supabaseClient
    .from('idempotency_keys')
    .select('*')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Atomic acquire: row-level advisory lock via pg_advisory_xact_lock in a
// transaction. The brief's concurrent-duplicate test (100ms) requires that two
// simultaneous inserts of the same key do NOT both process. Supabase REST has
// no upsert-and-return-existing, so we use an RPC that serializes on the key.
async function storeAcquire(key, payloadHashValue) {
  if (useSupabase()) {
    // PostgREST-correct: BARE function name, schema resolved via the client
    // config (db: { schema: 'saax_router' } -> Accept/Content-Profile headers in
    // store.js). The old schema-baked name 'saax_router_acquire_idempotency' did
    // not exist in the PostgREST search path -> 404 in Supabase mode (live
    // break). See store.js header comment (Day 8 closure, Item 1).
    const { data, error } = await _supabaseClient.rpc('acquire_idempotency', {
      p_key: key,
      p_payload_hash: payloadHashValue,
      p_ttl_hours: TTL_HOURS,
    });
    if (error) throw error;
    return data;
  }
  // Durable + memory fallbacks — same semantics as the SQL function:
  if (useDurable()) {
    const outcome = _durableStore.acquire(key, payloadHashValue, TTL_HOURS, null);
    if (outcome === 'inserted') return 'inserted';
    if (outcome && outcome.conflict) {
      if (outcome.status === 'pending') return 'conflict_pending';
      return outcome;
    }
    return 'inserted';
  }
  // Memory fallback — same semantics as the SQL function:
  const existing = memGet(key);
  if (!existing) return memInsert(key, payloadHashValue, TTL_HOURS); // 'inserted'
  if (existing.payload_hash && existing.payload_hash !== payloadHashValue) {
    const err = new Error('payload hash mismatch: idempotency key reused for a different request');
    throw err;
  }
  if (existing.status === 'pending') return 'conflict_pending';
  // verified | settled | failed -> cached response shape
  return {
    conflict: true,
    status: existing.status,
    response_status: existing.response_status,
    response_body: existing.response_body,
  };
}

async function storeUpdate(key, status, responseStatus, responseBody) {
  if (useDurable()) {
    _durableStore.update(key, status, responseStatus, responseBody);
    return;
  }
  if (!_supabaseClient) throw new Error('supabase idempotency store not configured');
  const patch = {
    status,
    ...(responseStatus !== undefined && responseStatus !== null ? { response_status: responseStatus } : {}),
    ...(typeof responseBody === 'string' ? { response_body: responseBody } : {}),
  };
  const { error } = await _supabaseClient
    .from('idempotency_keys')
    .update(patch)
    .eq('key', key);
  if (error) throw error;
}

// Test-only: switch the store to in-memory without a Supabase client.
function setStoreMode(mode) { _internalMode = mode; }
// Effective store topology (reliability remediation, fail-closed policy):
//   'memory'   -> NOT durable (in-process Map; restart wipes replay protection)
//   'durable'  -> file-backed single-writer durable store (no Supabase)
//   'supabase' -> shared transactional store (multi-instance safe)
// This is the authoritative check route-server uses to FAIL CLOSED before any
// live financial operation when only an in-memory store is active.
function getStoreMode() {
  if (_internalMode === 'memory') return 'memory';
  if (!!_supabaseClient) return 'supabase';
  if (!!_durableStore) return 'durable';
  return 'memory';
}
function isDurableActive() {
  return getStoreMode() !== 'memory';
}

async function sweepExpired() {
  if (!_supabaseClient) return;
  try {
    const now = new Date().toISOString();
    const { data, error } = await _supabaseClient
      .from('idempotency_keys')
      .select('key')
      .lt('expires_at', now)
      .limit(500);
    if (error) throw error;
    if (Array.isArray(data) && data.length) {
      await _supabaseClient.from('idempotency_keys').delete().in('key', data.map(r => r.key));
    }
  } catch (_) { /* housekeeping; failure not fatal */ }
}

// ---- The gate: call BEFORE any payment verification --------------------------
// Returns:
//   { ok:true, key, payloadHash, fresh:boolean }                     -> proceed
//   { ok:false, status:409, key }                                    -> in-flight
//   { ok:false, status:422, key, reason }                            -> key reused
//   { ok:false, status:200, key, cached:{status,body} }              -> replay
//   { ok:false, status:503, key, reason }                            -> store down
//
// The cached-response path (brief: "return the cached response, do not
// re-process") carries response_status + response_body from the settled row.
async function idempotencyGate(req, ctx) {
  // ctx: { payload: {capability,budget,deadline}, buyerAddress, nonce }
  let key = headerKey(req);
  const derived = !key;
  if (!key) {
    key = deriveKey({ buyerAddress: ctx.buyerAddress, capability: ctx.payload.capability, budget: ctx.payload.budget, deadline: ctx.payload.deadline, nonce: ctx.nonce || '', extra: ctx.extra || '' });
  }
  const ph = payloadHash(ctx.payload);

  try {
    const outcome = await storeAcquire(key, ph);
    if (outcome === 'inserted') {
      return { ok: true, key, payloadHash: ph, fresh: true, derived };
    }
    if (outcome === 'conflict_pending') {
      return { ok: false, status: 409, key, derived, reason: 'idempotency key in flight (pending); previous request still processing' };
    }
    if (outcome && typeof outcome === 'object' && outcome.conflict) {
      const status = String(outcome.status || 'pending');
      if (status === 'pending') {
        return { ok: false, status: 409, key, derived, reason: 'idempotency key in flight (pending); previous request still processing' };
      }
      if (status === 'failed') {
        // A FAILED prior attempt is retryable with a fresh key, but the SAME key
        // after failure means the client did not get the error -> replay the
        // failure response if we cached it, else re-process.
        if (outcome.response_status) {
          return { ok: false, status: Number(outcome.response_status), key, derived, cached: { status: Number(outcome.response_status), body: outcome.response_body || '' } };
        }
        return { ok: true, key, payloadHash: ph, fresh: true, derived, retryAfterFailure: true };
      }
      // verified | settled -> cached response
      return { ok: false, status: 200, key, derived, cached: { status: Number(outcome.response_status || 200), body: outcome.response_body || '' } };
    }
    // payload-hash mismatch surfaced from the DB layer as a thrown marker
    return { ok: true, key, payloadHash: ph, fresh: true, derived };
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes('payload hash mismatch')) {
      return { ok: false, status: 422, key, derived, reason: 'idempotency key reused with a different payload hash (protocol violation)' };
    }
    // Store down -> fail OPEN with a warning (route-around, no blocking)
    return { ok: false, status: 503, key, derived, reason: 'idempotency store unavailable: ' + msg.slice(0, 120) };
  }
}

async function markVerified(key) {
  try {
    if (useSupabase()) {
      await storeUpdate(key, 'verified', null, null);
    } else if (useDurable()) {
      _durableStore.update(key, 'verified', null, null);
    } else {
      const row = memGet(key); if (!row) return false;
      memUpdate(key, 'verified', null, null);
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function markSettled(key, responseStatus, responseBody) {
  try {
    if (useSupabase()) {
      await storeUpdate(key, 'settled', responseStatus, responseBody);
    } else if (useDurable()) {
      _durableStore.update(key, 'settled', responseStatus, responseBody);
    } else {
      const row = memGet(key); if (!row) return false;
      memUpdate(key, 'settled', responseStatus, responseBody);
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function markFailed(key, responseStatus, responseBody) {
  try {
    if (useSupabase()) {
      await storeUpdate(key, 'failed', responseStatus, responseBody);
    } else if (useDurable()) {
      _durableStore.update(key, 'failed', responseStatus, responseBody);
    } else {
      const row = memGet(key); if (!row) return false;
      memUpdate(key, 'failed', responseStatus, responseBody);
    }
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  TTL_HOURS,
  SWEEP_INTERVAL_MS,
  setStoreClient,
  setDurableStore,
  getDurableStore,
  setStoreMode,
  getStoreMode,
  memStore,
  deriveKey,
  payloadHash,
  headerKey,
  storeGet,
  storeAcquire,
  storeUpdate,
  sweepExpired,
  idempotencyGate,
  markVerified,
  markSettled,
  markFailed,
  isDurableActive,
};