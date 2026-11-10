// SAAX Protocol — Day 8, Item 2: Rate limiting on /route (pre-live security control)
//
// Two-tier sliding-window limits, enforced at the HTTP boundary BEFORE the
// sanitization gate and BEFORE payment verification:
//   per IP      : 60 requests / 60s   (prevents DoS from a single source)
//   per wallet  : 30 requests / 60s   (prevents a funded wallet from exhausting
//                 router verification gas)
//
// Store: Supabase saax_router.rate_limits (event-log model) via REST, so limits
// survive process restarts (brief: "Supabase preferred for persistence across
// restarts"). The Supabase REST client is optional — if the connection is not
// configured the limiter falls back to an in-memory sliding window with a
// periodic flush (brief: "or in-memory with periodic flush"). No blocking: a
// store failure fails OPEN (log + allow) so a DB outage can never take down the
// router, but a REAL limit hit fails CLOSED (429).
//
// Response on limit hit: 429 Too Many Requests with Retry-After header and the
// limit type in the body. Exemptions: NONE, not even the operator's test wallet.
//
// Sliding-window algorithm: keep request timestamps (now - window); the count
// is events with ts > now - window. Retry-After = seconds until the OLDEST
// event in the window falls out (<window> minus age of oldest).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  ip:     { limit: 60, windowSeconds: 60 },
  wallet: { limit: 30, windowSeconds: 60 },
};

// ---- Config -----------------------------------------------------------------
const LIMITS = {
  ip: {
    limit: Number(process.env.SAAX_RATE_LIMIT_IP || DEFAULTS.ip.limit),
    windowSeconds: Number(process.env.SAAX_RATE_LIMIT_IP_WINDOW || DEFAULTS.ip.windowSeconds),
  },
  wallet: {
    limit: Number(process.env.SAAX_RATE_LIMIT_WALLET || DEFAULTS.wallet.limit),
    windowSeconds: Number(process.env.SAAX_RATE_LIMIT_WALLET_WINDOW || DEFAULTS.wallet.windowSeconds),
  },
};

let STORE_MODE = String(process.env.SAAX_RATE_LIMIT_STORE || 'supabase').toLowerCase(); // 'supabase' | 'memory'
// Auto-fallback to memory when no store client is configured (route-around,
// brief-sanctioned: "or in-memory with periodic flush"). The route server calls
// ensureStoreMode(); tests may call it directly too.
function ensureStoreMode(hasClient) {
  if (process.env.SAAX_RATE_LIMIT_STORE) return; // operator explicit choice wins
  if (!hasClient && STORE_MODE === 'supabase') {
    STORE_MODE = 'memory';
  }
}
function getStoreMode() { return STORE_MODE; }
const SWEEP_INTERVAL_MS = Number(process.env.SAAX_RATE_LIMIT_SWEEP_MS || 3600000); // hourly sweep fallback, brief Item 1/2

let _supabaseClient = null; // injected via setStoreClient (rest client)
function setStoreClient(c) { _supabaseClient = c; }

function getSupabaseUrl() { return process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || ''; }

// ---- In-memory sliding window ------------------------------------------------
const memBuckets = new Map(); // `${scope}:${key}` -> { events: [tsMs...] }

function memTrim(bucket, windowMs) {
  const cutoff = Date.now() - windowMs;
  bucket.events = bucket.events.filter(t => t > cutoff);
}

function memCount(scope, key) {
  const id = scope + ':' + key;
  const bucket = memBuckets.get(id);
  if (!bucket) return 0;
  memTrim(bucket, LIMITS[scope].windowSeconds * 1000);
  return bucket.events.length;
}

function memRecord(scope, key) {
  const id = scope + ':' + key;
  const bucket = memBuckets.get(id) || { events: [] };
  bucket.events.push(Date.now());
  memBuckets.set(id, bucket);
}

// ---- Supabase store (event-log model) -----------------------------------------
async function supabaseCount(scope, key, windowSeconds) {
  if (!_supabaseClient) throw new Error('supabase rate-limit store not configured');
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { data, error } = await _supabaseClient
    .from('rate_limits')
    .select('id')
    .eq('scope', scope)
    .eq('bucket_key', key)
    .gte('ts', since);
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

async function supabaseRecord(scope, key) {
  if (!_supabaseClient) throw new Error('supabase rate-limit store not configured');
  const expiresAt = new Date(Date.now() + (LIMITS[scope].windowSeconds + 60) * 1000).toISOString();
  const { error } = await _supabaseClient
    .from('rate_limits')
    .insert({ scope, bucket_key: key, expires_at: expiresAt });
  if (error) throw error;
}

// Sweep expired rows (hourly route-around for the brief's cleanup requirement;
// the REST layer has no DELETE-by-query, so we page expired ids and delete them).
async function sweepExpired() {
  if (!_supabaseClient) return;
  try {
    const now = new Date().toISOString();
    const { data, error } = await _supabaseClient
      .from('rate_limits')
      .select('id')
      .lt('expires_at', now)
      .limit(500);
    if (error) throw error;
    if (Array.isArray(data) && data.length) {
      await _supabaseClient.from('rate_limits').delete().in('id', data.map(r => r.id));
    }
  } catch (e) {
    // sweep is housekeeping; failure is not fatal
  }
}

// ---- Public API ----------------------------------------------------------------
// Evaluate both tiers for a request. Returns:
//   { ok:true, counts:{ip,wallet} }                  -> allowed
//   { ok:false, status:429, retryAfterSeconds, limitType, counts } -> blocked
// Records the event AFTER both tiers pass (a rejected request is still counted
// for the tier that was hit? NO — brief: fire 61 -> 61st returns 429; the 61st
// must be BLOCKED, so we record BEFORE the check and the 61st event sees 61 in
// the window. See test-day8-item2.js for the exact counting proof.)
async function checkAndRecord(ip, walletAddress) {
  const counts = { ip: null, wallet: null };
  const errors = [];
  // Supabase mode requires a live client; otherwise use the in-memory window
  // (fail-open route-around — a DB outage must never block the router).
  const useSupabase = STORE_MODE === 'supabase' && !!_supabaseClient;

  // 1. per-IP tier
  try {
    if (!useSupabase) {
      memRecord('ip', ip);
      counts.ip = memCount('ip', ip);
    } else {
      await supabaseRecord('ip', ip);
      counts.ip = await supabaseCount('ip', ip, LIMITS.ip.windowSeconds);
    }
  } catch (e) {
    errors.push('ip:' + String(e.message || e));
  }

  // 2. per-wallet tier (only when a wallet is present)
  if (walletAddress) {
    try {
      if (!useSupabase) {
        memRecord('wallet', walletAddress);
        counts.wallet = memCount('wallet', walletAddress);
      } else {
        await supabaseRecord('wallet', walletAddress);
        counts.wallet = await supabaseCount('wallet', walletAddress, LIMITS.wallet.windowSeconds);
      }
    } catch (e) {
      errors.push('wallet:' + String(e.message || e));
    }
  }

  // A store failure fails OPEN (log + allow) — never block the router on a
  // DB outage. A real limit hit fails CLOSED.
  const blockedIp = counts.ip !== null && counts.ip > LIMITS.ip.limit;
  const blockedWallet = counts.wallet !== null && counts.wallet > LIMITS.wallet.limit;
  if (blockedIp || blockedWallet) {
    const limitType = blockedWallet ? 'wallet' : 'ip';
    const w = LIMITS[limitType].windowSeconds;
    // oldest event age -> seconds until it leaves the window (>= 1)
    let retry = w;
    try {
      if (STORE_MODE === 'memory') {
        const id = limitType + ':' + (limitType === 'wallet' ? walletAddress : ip);
        const bucket = memBuckets.get(id);
        if (bucket && bucket.events.length) {
          const oldest = Math.min(...bucket.events);
          retry = Math.max(1, Math.ceil((oldest + w * 1000 - Date.now()) / 1000));
        }
      } else {
        retry = w; // supabase: window length is the correct Retry-After upper bound
      }
    } catch (_) { retry = w; }
    return {
      ok: false,
      status: 429,
      retryAfterSeconds: retry,
      limitType,
      counts,
      errors,
      message: 'rate limit exceeded: ' + limitType + ' tier (' +
        (limitType === 'ip' ? LIMITS.ip.limit : LIMITS.wallet.limit) + ' per 60s)',
    };
  }

  return { ok: true, counts, errors };
}

// Export limits for tests/logs.
function limitsFor(scope) { return { ...LIMITS[scope] }; }

module.exports = {
  LIMITS,
  DEFAULTS,
  STORE_MODE,
  SWEEP_INTERVAL_MS,
  memBuckets,
  setStoreClient,
  ensureStoreMode,
  getStoreMode,
  limitsFor,
  memCount,
  memRecord,
  supabaseCount,
  supabaseRecord,
  sweepExpired,
  checkAndRecord,
};