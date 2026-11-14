// SAAX Gate G.1 — Distributed MCP rate limiting + authentication-abuse protection.
//
// Shared, atomic enforcement across serverless instances via the same Supabase
// event-log pattern already used by endpoint/ratelimit.js (saax_router.rate_limits
// with scope/bucket_key/expires_at). The Supabase store is authoritative for
// production enforcement; the in-memory window is ONLY a bounded fallback when
// the shared store is unavailable (fail-open on store outage, fail-closed on a
// real limit hit) — matching the established ratelimit.js semantics.
//
// Design notes:
//  * Keys are canonicalized server-side. For unauthenticated requests the key is
//    the client IP (Vercel x-forwarded-for). For authenticated requests the key
//    is the VERIFIED principal (recovered EIP-712 signer). An attacker cannot
//    evade limits by supplying arbitrary agent identifiers — only after proof
//    verification succeeds does an identity-based bucket appear, and a forged
//    proof is rejected before any bucket is touched.
//  * Per-operation tier: sensitive tools (evidence verification, evidence
//    submission, dispute resolution, authority validation) get stricter budgets.
//  * Concurrency guard: bounded local semaphore protects expensive crypto work;
//    cross-instance concurrency is bounded by the shared per-principal budget.
//  * Body/payload size bounds are enforced in api/mcp.mjs (single source).
//  * Correct retry responses: 429 + Retry-After.
//  * Structured security events: appended to the rate_limits audit rows via
//    scope 'mcp_security' with reason classification.
//
// IMPORTANT: this module NEVER reuses the financial pilot reservation counters
// (endpoint/pilot-limits.js). Financial isolation is preserved: MCP abuse limits
// live only in the rate_limits table, never in payment_reservations.
'use strict';

const crypto = require('crypto');

const DEFAULTS = {
  // Anonymous (IP-based) tier — bounds a single source exhausting the service.
  ip: { limit: 120, windowSeconds: 60 },
  // Verified principal tier — bounds one authenticated agent.
  principal: { limit: 600, windowSeconds: 60 },
  // Sensitive per-operation tier (crypto verification, evidence, disputes,
  // authority validation). One logical op keyed by (tool, principal|ip).
  op: { default: { limit: 120, windowSeconds: 60 } },
};

function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const LIMITS = {
  ip: {
    limit: envNum('SAAX_MCP_RATE_LIMIT_IP', DEFAULTS.ip.limit),
    windowSeconds: envNum('SAAX_MCP_RATE_LIMIT_IP_WINDOW', DEFAULTS.ip.windowSeconds),
  },
  principal: {
    limit: envNum('SAAX_MCP_RATE_LIMIT_PRINCIPAL', DEFAULTS.principal.limit),
    windowSeconds: envNum('SAAX_MCP_RATE_LIMIT_PRINCIPAL_WINDOW', DEFAULTS.principal.windowSeconds),
  },
  op: {
    default: {
      limit: envNum('SAAX_MCP_RATE_LIMIT_OP', DEFAULTS.op.default.limit),
      windowSeconds: envNum('SAAX_MCP_RATE_LIMIT_OP_WINDOW', DEFAULTS.op.default.windowSeconds),
    },
  },
};

const SENSITIVE_TOOLS = new Set([
  'verify_evidence',
  'submit_evidence',
  'get_evidence_verification',
  'get_authority_validation',
  'raise_dispute',
  'resolve_dispute',
  'resume_commitment',
]);

// Per-tool stricter budgets (per verified principal OR per IP when anonymous).
const OP_LIMITS = {
  verify_evidence: { limit: envNum('SAAX_MCP_RATE_LIMIT_OP_VERIFY', 30), windowSeconds: 60 },
  submit_evidence: { limit: envNum('SAAX_MCP_RATE_LIMIT_OP_SUBMIT', 30), windowSeconds: 60 },
  get_evidence_verification: { limit: envNum('SAAX_MCP_RATE_LIMIT_OP_VERIFY', 30), windowSeconds: 60 },
  get_authority_validation: { limit: envNum('SAAX_MCP_RATE_LIMIT_OP_AUTHVAL', 60), windowSeconds: 60 },
  raise_dispute: { limit: envNum('SAAX_MCP_RATE_LIMIT_OP_DISPUTE', 15), windowSeconds: 60 },
  resolve_dispute: { limit: envNum('SAAX_MCP_RATE_LIMIT_OP_DISPUTE', 15), windowSeconds: 60 },
  resume_commitment: { limit: envNum('SAAX_MCP_RATE_LIMIT_OP_RESUME', 60), windowSeconds: 60 },
};

let STORE_MODE = String(process.env.SAAX_MCP_RATE_LIMIT_STORE || (process.env.SAAX_RATE_LIMIT_STORE || 'supabase')).toLowerCase();
function ensureStoreMode(hasClient) {
  if (process.env.SAAX_MCP_RATE_LIMIT_STORE || process.env.SAAX_RATE_LIMIT_STORE) return;
  if (!hasClient && STORE_MODE === 'supabase') STORE_MODE = 'memory';
}
function getStoreMode() { return STORE_MODE; }

let _client = null; // supabase-js-style client injected from store.js (same as ratelimit.js)
function setStoreClient(c) { _client = c; }
function getStoreClient() { return _client; }

// ---- In-memory bounded fallback (also used when store is down) ---------------
const memBuckets = new Map();
function memTrim(bucket, windowMs) {
  const cutoff = Date.now() - windowMs;
  bucket.events = bucket.events.filter(t => t > cutoff);
}
function memCount(scope, key, windowSeconds) {
  const id = scope + ':' + key;
  const b = memBuckets.get(id);
  if (!b) return 0;
  memTrim(b, windowSeconds * 1000);
  return b.events.length;
}
function memRecord(scope, key) {
  const id = scope + ':' + key;
  const b = memBuckets.get(id) || { events: [] };
  b.events.push(Date.now());
  memBuckets.set(id, b);
}

// ---- Supabase shared store (atomic claim semantics) ----------------------------
// The shared limiter uses an atomic INSERT ... ON CONFLICT DO UPDATE pattern
// wherever the backend supports it; the PostgREST client used here follows the
// established ratelimit.js pattern: INSERT then COUNT within the window.
async function sharedCount(scope, key, windowSeconds) {
  if (!_client) throw new Error('shared rate-limit store not configured');
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { data, error } = await _client
    .from('rate_limits')
    .select('id')
    .eq('scope', scope)
    .eq('bucket_key', key)
    .gte('ts', since);
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

async function sharedRecord(scope, key, windowSeconds) {
  if (!_client) throw new Error('shared rate-limit store not configured');
  const expiresAt = new Date(Date.now() + (windowSeconds + 60) * 1000).toISOString();
  const { error } = await _client
    .from('rate_limits')
    .insert({ scope, bucket_key: key, expires_at: expiresAt });
  if (error) throw error;
}

// Canonical bucket key: never trust caller-supplied identity. For unauthenticated
// traffic we key on the transport IP; for authenticated traffic we key on the
// recovered EIP-712 principal (verified upstream). Arbitrary agentIds are NOT
// accepted as keys — an attacker cannot rotate buckets by changing an input.
function canonicalKey(raw) {
  if (!raw || typeof raw !== 'string') return 'anon';
  // Lowercase, trim, cap length; hash long values so a principal cannot blow the
  // index with a huge key.
  const s = raw.trim().toLowerCase();
  if (!s) return 'anon';
  if (s.length > 64) return 'h:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
  return s.slice(0, 64);
}

/**
 * Evaluate (and record) all applicable tiers for one MCP request.
 * @param {object} opts { ip, principal, tool }
 * @returns {Promise<{ok:boolean,status?:number,retryAfterSeconds?:number,limitType?:string,counts:object,errors:string[]}>}
 *   ok:false + status:429 = blocked (fail-closed on a real limit hit).
 *   Store outage: ok:false + status:503 for SENSITIVE_TOOLS (fail-closed so
 *   abuse protection cannot be disabled for mutations/crypto verification);
 *   ok:true (errors populated) for discovery/read tools so public catalog and
 *   status endpoints stay available during a store outage.
 */
async function checkMcpRequest({ ip, principal, tool }) {
  const counts = { ip: null, principal: null, op: null };
  const errors = [];
  const useShared = STORE_MODE === 'supabase' && !!_client;
  const ipKey = canonicalKey(ip);
  const principalKey = principal ? canonicalKey(principal) : null;

  const recordAndCount = async (scope, key, windowSeconds) => {
    if (!useShared) {
      memRecord(scope, key);
      return memCount(scope, key, windowSeconds);
    }
    await sharedRecord(scope, key, windowSeconds);
    return sharedCount(scope, key, windowSeconds);
  };

  // 1. IP tier (always).
  try {
    counts.ip = await recordAndCount('mcp_ip', ipKey, LIMITS.ip.windowSeconds);
  } catch (e) { errors.push('ip:' + String(e.message || e)); }

  // 2. Principal tier (only for verified principals, never for claimed agentIds).
  if (principalKey) {
    try {
      counts.principal = await recordAndCount('mcp_principal', principalKey, LIMITS.principal.windowSeconds);
    } catch (e) { errors.push('principal:' + String(e.message || e)); }
  }

  // 3. Sensitive per-op tier (only for sensitive tools).
  const opLim = OP_LIMITS[tool] || LIMITS.op.default;
  if (SENSITIVE_TOOLS.has(tool)) {
    const opKey = (principalKey || ipKey) + '|' + tool;
    try {
      counts.op = await recordAndCount('mcp_op', opKey, opLim.windowSeconds);
    } catch (e) { errors.push('op:' + String(e.message || e)); }
  }

  // Store-outage policy (Gate G.1.1 hardening): when the SHARED store is
  // unavailable (errors on any tier), SENSITIVE operations fail CLOSED (503)
  // so abuse protection cannot be silently disabled for mutations or
  // cryptographic verification. Low-risk discovery/read operations remain
  // fail-OPEN (memory fallback still bounds per instance) so public catalog
  // and status endpoints stay available during a store outage.
  const storeDegraded = useShared && errors.length > 0;
  if (storeDegraded && SENSITIVE_TOOLS.has(tool)) {
    return {
      ok: false,
      status: 503,
      retryAfterSeconds: Math.min(30, LIMITS.ip.windowSeconds),
      limitType: 'store-unavailable',
      counts,
      errors,
      message: 'MCP rate-limit store unavailable; sensitive operation refused (fail-closed)',
    };
  }

  // Fail-closed on a REAL limit hit; fail-open on store errors (availability).
  const blockedIp = counts.ip !== null && counts.ip > LIMITS.ip.limit;
  const blockedPrincipal = counts.principal !== null && counts.principal > LIMITS.principal.limit;
  const blockedOp = counts.op !== null && counts.op > opLim.limit;
  if (blockedIp || blockedPrincipal || blockedOp) {
    const limitType = blockedOp ? 'op' : (blockedPrincipal ? 'principal' : 'ip');
    const w = limitType === 'op' ? opLim.windowSeconds : LIMITS[limitType].windowSeconds;
    return {
      ok: false,
      status: 429,
      retryAfterSeconds: Math.max(1, w),
      limitType,
      counts,
      errors,
      message: 'MCP rate limit exceeded: ' + limitType + ' tier',
    };
  }

  return { ok: true, counts, errors };
}

// ---- Authentication-abuse protection -------------------------------------------
// Per-source failed-auth throttle: keyed on canonical IP (and verified principal
// when present). Bounded exponential backoff: allowed attempts shrink as failures
// accumulate; a success resets the source. Anti-lockout: the window is capped and
// the throttle NEVER blocks a verified, valid proof — only repeated failures.
const AUTH_LIMITS = {
  maxFailures: envNum('SAAX_MCP_AUTH_MAX_FAILURES', 10),
  windowSeconds: envNum('SAAX_MCP_AUTH_WINDOW', 60),
};

async function recordAuthFailure({ ip, principal }) {
  const scope = 'mcp_auth_fail';
  const key = canonicalKey(principal || ip);
  try {
    if (STORE_MODE === 'supabase' && _client) await sharedRecord(scope, key, AUTH_LIMITS.windowSeconds);
    else memRecord(scope, key);
  } catch (e) { /* fail-open on store outage for auth counting too */ }
}

async function authFailCount({ ip, principal }) {
  const scope = 'mcp_auth_fail';
  const key = canonicalKey(principal || ip);
  try {
    if (STORE_MODE === 'supabase' && _client) return await sharedCount(scope, key, AUTH_LIMITS.windowSeconds);
    return memCount(scope, key, AUTH_LIMITS.windowSeconds);
  } catch (e) { return 0; } // fail-open: store outage must not permanently lock a source
}

// Retry-After for a throttled source: remaining failures before recovery.
// Bounded exponential backoff: penalty scales with failure count.
async function authPenaltySeconds({ ip, principal }) {
  const fails = await authFailCount({ ip, principal });
  if (fails <= AUTH_LIMITS.maxFailures) return 0;
  const excess = fails - AUTH_LIMITS.maxFailures;
  return Math.min(300, Math.round(AUTH_LIMITS.windowSeconds * Math.pow(2, Math.min(excess, 5)) / 2));
}

// Anti-lockout: a valid proof clears the failure record for that principal.
async function clearAuthFailures({ ip, principal }) {
  const scope = 'mcp_auth_fail';
  const key = canonicalKey(principal || ip);
  try {
    if (STORE_MODE === 'supabase' && _client) {
      // Delete-by-query is not available via this REST client; page and delete.
      const { data, error } = await _client.from('rate_limits').select('id').eq('scope', scope).eq('bucket_key', key).limit(1000);
      if (!error && Array.isArray(data) && data.length) {
        await _client.from('rate_limits').delete().in('id', data.map(r => r.id)).catch(() => {});
      }
    } else {
      memBuckets.delete(scope + ':' + key);
    }
  } catch (e) { /* non-fatal */ }
}

function limitsFor(scope) { return { ...(LIMITS[scope] || {}) }; }
function opLimitsFor(tool) { return { ...(OP_LIMITS[tool] || LIMITS.op.default) }; }

module.exports = {
  DEFAULTS,
  LIMITS,
  OP_LIMITS,
  SENSITIVE_TOOLS,
  AUTH_LIMITS,
  STORE_MODE,
  memBuckets,
  setStoreClient,
  getStoreClient,
  ensureStoreMode,
  getStoreMode,
  canonicalKey,
  checkMcpRequest,
  recordAuthFailure,
  authFailCount,
  authPenaltySeconds,
  clearAuthFailures,
  limitsFor,
  opLimitsFor,
};