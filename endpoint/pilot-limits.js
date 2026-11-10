// SAAX Protocol — Gate D.1: internal-Beta financial limits (quota enforcement)
//
// PURPOSE
//   Enforce a risk-based transaction-limit policy for the invitation-only
//   internal Beta. This module is the APPLICATION half of the reservation
//   engine; the atomicity lives in Postgres (ax_router.reserve_payment_quota).
//
// NON-NEGOTIABLE PROPERTIES
//   1. Money is INTEGER BASE UNITS end to end. No floating-point arithmetic
//      ever touches a financial amount. USD policy -> base units uses BigInt.
//   2. The database is the enforcement authority. Process-local counters are
//      never consulted for a financial decision.
//   3. FAIL CLOSED. If the reservation store is unreachable, or the policy
//      cannot be evaluated, the payment is REJECTED. There is no fail-open path
//      in this module — unlike the rate limiter, a quota decision is financial.
//   4. One reservation per authorized payment operation, bound to the existing
//      idempotency key. An identical retry returns the SAME reservation and
//      consumes NO additional quota.
//   5. Unknown settlement outcomes RETAIN exposure. A timeout is never proof
//      of failure, so nothing here releases budget on a timeout.
//
// ACTIVATION
//   SAAX_PILOT_ENFORCEMENT = 'off' (default) | 'on'
//   Off means: no allowlist check, no quota check, no reservation written.
//   Production activation is a separate, explicitly authorized operation.
'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Policy (configurable, never hardcoded into control flow)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enforcement: 'off',
  maxSingleUsd: '100',
  walletMaxUsd: '200',
  walletMaxTx: 3,
  globalMaxUsd: '1000',
  globalMaxTx: 15,
  windowHours: 24,
  staleMinutes: 60,
};

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function strEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw).trim();
}

function getPolicy() {
  return {
    enforcement: strEnv('SAAX_PILOT_ENFORCEMENT', DEFAULTS.enforcement).toLowerCase() === 'on' ? 'on' : 'off',
    maxSingleUsd: strEnv('SAAX_PILOT_MAX_SINGLE_USD', DEFAULTS.maxSingleUsd),
    walletMaxUsd: strEnv('SAAX_PILOT_WALLET_MAX_USD', DEFAULTS.walletMaxUsd),
    walletMaxTx: intEnv('SAAX_PILOT_WALLET_MAX_TX', DEFAULTS.walletMaxTx),
    globalMaxUsd: strEnv('SAAX_PILOT_GLOBAL_MAX_USD', DEFAULTS.globalMaxUsd),
    globalMaxTx: intEnv('SAAX_PILOT_GLOBAL_MAX_TX', DEFAULTS.globalMaxTx),
    windowHours: intEnv('SAAX_PILOT_WINDOW_HOURS', DEFAULTS.windowHours),
    staleMinutes: intEnv('SAAX_PILOT_STALE_MINUTES', DEFAULTS.staleMinutes),
  };
}

function isEnforcing() {
  return getPolicy().enforcement === 'on';
}

// ---------------------------------------------------------------------------
// Supported assets — an explicit allowlist, never "any token is USD"
// ---------------------------------------------------------------------------
// Only a USD-pegged stablecoin with a known, fixed decimal count may be
// measured against a USD-denominated cap. Anything else is rejected under
// enforcement rather than silently priced.
const SUPPORTED_ASSETS = [
  {
    chainId: 8453,
    network: 'eip155:8453',
    symbol: 'USDC',
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
    usdPeg: true,
  },
  {
    chainId: 84532,
    network: 'eip155:84532',
    symbol: 'USDC',
    address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    decimals: 6,
    usdPeg: true,
  },
];

function normalizeAsset(asset) {
  return String(asset || '').trim().toLowerCase();
}

/**
 * Resolve a supported asset by chain + address.
 * @returns {{ok:true, asset:object} | {ok:false, reason:string}}
 */
function resolveAsset(chainId, assetAddress) {
  const cid = Number(chainId);
  if (!Number.isInteger(cid) || cid <= 0) return { ok: false, reason: 'invalid_chain_id' };
  const addr = normalizeAsset(assetAddress);
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok: false, reason: 'invalid_asset_address' };
  const found = SUPPORTED_ASSETS.find((a) => a.chainId === cid && a.address === addr);
  if (!found) return { ok: false, reason: 'unsupported_asset' };
  return { ok: true, asset: found };
}

// ---------------------------------------------------------------------------
// Integer base-unit conversion (BigInt only — no float ever)
// ---------------------------------------------------------------------------
/**
 * Convert a decimal USD string ("100", "0.05", "12.345678") to integer base
 * units for a given decimal count. Rejects anything that is not an exact,
 * non-negative, representable amount.
 * @returns {{ok:true, units:string} | {ok:false, reason:string}}
 */
function usdToUnits(usd, decimals) {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) return { ok: false, reason: 'invalid_decimals' };
  const raw = String(usd === undefined || usd === null ? '' : usd).trim();
  if (!raw) return { ok: false, reason: 'empty_amount' };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, reason: 'malformed_amount' };

  const [whole, frac = ''] = raw.split('.');
  if (frac.length > dec) return { ok: false, reason: 'too_many_decimals' };

  const padded = frac.padEnd(dec, '0');
  let units;
  try {
    units = BigInt(whole) * (10n ** BigInt(dec)) + BigInt(padded === '' ? '0' : padded);
  } catch (_) {
    return { ok: false, reason: 'amount_overflow' };
  }
  if (units <= 0n) return { ok: false, reason: 'non_positive_amount' };
  // numeric(78,0) ceiling — reject rather than let the DB truncate.
  if (units >= 10n ** 78n) return { ok: false, reason: 'amount_overflow' };
  return { ok: true, units: units.toString() };
}

/** Parse an already-integer base-unit string. Rejects negatives, zero, floats. */
function parseUnits(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return { ok: false, reason: 'empty_amount' };
  if (!/^\d+$/.test(raw)) return { ok: false, reason: 'non_integer_amount' };
  let units;
  try {
    units = BigInt(raw);
  } catch (_) {
    return { ok: false, reason: 'amount_overflow' };
  }
  if (units <= 0n) return { ok: false, reason: 'non_positive_amount' };
  if (units >= 10n ** 78n) return { ok: false, reason: 'amount_overflow' };
  return { ok: true, units: units.toString() };
}

// ---------------------------------------------------------------------------
// Wallet identity
// ---------------------------------------------------------------------------
/**
 * Normalize an EVM address to lowercase 0x + 40 hex. Rejects anything else.
 * Lowercasing is the canonical comparison form; the checksummed form is a
 * display concern, not an identity concern.
 */
function normalizeWallet(address) {
  const raw = String(address || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return { ok: false, reason: 'invalid_wallet_address' };
  return { ok: true, wallet: raw.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Reservation identity
// ---------------------------------------------------------------------------
/**
 * Deterministic reservation id from the idempotency key. Same key -> same
 * reservation id, so a retry reconciles instead of double-reserving.
 */
function reservationIdFor(idempotencyKey) {
  const material = 'saax:reservation:v1:' + String(idempotencyKey || '');
  return 'res_' + crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 40);
}

/** Payload hash binding the reservation to the exact authorized operation. */
function reservationPayloadHash({ wallet, chainId, asset, amountUnits, recipient, commitmentId }) {
  const material = [
    'saax:reservation-payload:v1',
    String(wallet || '').toLowerCase(),
    String(chainId === undefined ? '' : chainId),
    normalizeAsset(asset),
    String(amountUnits === undefined ? '' : amountUnits),
    String(recipient || '').toLowerCase(),
    String(commitmentId || ''),
  ].join('|');
  return 'rph:' + crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Store binding
// ---------------------------------------------------------------------------
let _client = null;
function setStoreClient(c) { _client = c; }
function getStoreClient() { return _client; }

function storeAvailable() {
  return !!(_client && typeof _client.rpc === 'function');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
/**
 * Evaluate the pilot policy for one payment operation.
 *
 * Call site contract: invoke AFTER the idempotency gate has produced a fresh
 * key and BEFORE any payment authorization is presented or broadcast.
 *
 * @param {object} ctx
 * @param {string} ctx.idempotencyKey  the SAME key the idempotency gate used
 * @param {string} ctx.wallet          the VERIFIED payer (never a caller string)
 * @param {number} ctx.chainId
 * @param {string} ctx.asset           token contract address
 * @param {string} ctx.amountUnits     integer base units (string)
 * @param {string} ctx.recipient
 * @param {string} [ctx.commitmentId]
 * @returns {Promise<{ok:boolean, enforced:boolean, reason?:string, reservationId?:string, status?:string, detail?:object}>}
 */
async function evaluate(ctx) {
  const policy = getPolicy();
  if (policy.enforcement !== 'on') {
    return { ok: true, enforced: false, reason: 'pilot_enforcement_disabled' };
  }

  // ---- Fail closed on any missing prerequisite ----------------------------
  if (!storeAvailable()) {
    return { ok: false, enforced: true, reason: 'limit_store_unavailable' };
  }
  if (!ctx || !ctx.idempotencyKey) {
    return { ok: false, enforced: true, reason: 'missing_idempotency_key' };
  }

  const walletRes = normalizeWallet(ctx.wallet);
  if (!walletRes.ok) return { ok: false, enforced: true, reason: walletRes.reason };

  const assetRes = resolveAsset(ctx.chainId, ctx.asset);
  if (!assetRes.ok) return { ok: false, enforced: true, reason: assetRes.reason };

  const amountRes = parseUnits(ctx.amountUnits);
  if (!amountRes.ok) return { ok: false, enforced: true, reason: amountRes.reason };

  const recipientRes = normalizeWallet(ctx.recipient);
  if (!recipientRes.ok) return { ok: false, enforced: true, reason: 'invalid_recipient' };

  // ---- Policy thresholds -> base units (BigInt) ---------------------------
  const dec = assetRes.asset.decimals;
  const single = usdToUnits(policy.maxSingleUsd, dec);
  const walletMax = usdToUnits(policy.walletMaxUsd, dec);
  const globalMax = usdToUnits(policy.globalMaxUsd, dec);
  if (!single.ok || !walletMax.ok || !globalMax.ok) {
    // A misconfigured policy must never silently disable the caps.
    return { ok: false, enforced: true, reason: 'invalid_policy_configuration' };
  }

  const reservationId = reservationIdFor(ctx.idempotencyKey);
  const payloadHash = reservationPayloadHash({
    wallet: walletRes.wallet,
    chainId: assetRes.asset.chainId,
    asset: assetRes.asset.address,
    amountUnits: amountRes.units,
    recipient: recipientRes.wallet,
    commitmentId: ctx.commitmentId,
  });

  let result;
  try {
    const { data, error } = await _client.rpc('reserve_payment_quota', {
      p_reservation_id: reservationId,
      p_idempotency_key: String(ctx.idempotencyKey),
      p_wallet: walletRes.wallet,
      p_chain_id: assetRes.asset.chainId,
      p_asset: assetRes.asset.address,
      p_amount_units: amountRes.units,
      p_recipient: recipientRes.wallet,
      p_commitment_id: ctx.commitmentId ? String(ctx.commitmentId) : null,
      p_payload_hash: payloadHash,
      p_max_single_units: single.units,
      p_wallet_max_units: walletMax.units,
      p_wallet_max_tx: policy.walletMaxTx,
      p_global_max_units: globalMax.units,
      p_global_max_tx: policy.globalMaxTx,
      p_window_hours: policy.windowHours,
      p_enforce_allowlist: true,
    });
    if (error) throw error;
    result = data;
  } catch (e) {
    // FAIL CLOSED. An unreachable limit store means the quota cannot be
    // evaluated, and an unevaluated financial operation must not proceed.
    return {
      ok: false,
      enforced: true,
      reason: 'limit_store_unavailable',
      detail: { error: String(e.message || e).slice(0, 200) },
    };
  }

  if (!result || typeof result !== 'object') {
    return { ok: false, enforced: true, reason: 'limit_store_invalid_response' };
  }
  if (result.allowed !== true) {
    return {
      ok: false,
      enforced: true,
      reason: String(result.reason || 'quota_rejected'),
      reservationId: result.reservation_id || reservationId,
      detail: result,
    };
  }
  return {
    ok: true,
    enforced: true,
    reason: result.replay ? 'replay_existing_reservation' : 'reserved',
    reservationId: result.reservation_id || reservationId,
    status: result.status || 'RESERVED',
    detail: result,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------
async function finalize(reservationId, status, reason, settlementRef) {
  if (!storeAvailable()) return { ok: false, reason: 'limit_store_unavailable' };
  try {
    const { data, error } = await _client.rpc('finalize_payment_reservation', {
      p_reservation_id: String(reservationId),
      p_status: String(status),
      p_reason: reason ? String(reason).slice(0, 200) : null,
      p_settlement_ref: settlementRef ? String(settlementRef).slice(0, 200) : null,
    });
    if (error) throw error;
    return data || { ok: false, reason: 'empty_response' };
  } catch (e) {
    return { ok: false, reason: 'limit_store_unavailable', error: String(e.message || e).slice(0, 200) };
  }
}

/** Settlement observed on chain -> CONFIRMED (keeps consuming exposure). */
function confirm(reservationId, settlementRef) {
  return finalize(reservationId, 'CONFIRMED', 'settlement observed', settlementRef);
}

/** Authoritative proof the operation cannot settle -> RELEASED (frees budget). */
function release(reservationId, reason) {
  return finalize(reservationId, 'RELEASED', reason || 'authoritative non-settlement', null);
}

/** Outcome unknown -> EXPIRED_UNRESOLVED (STILL consumes exposure). */
function markUnresolved(reservationId, reason) {
  return finalize(reservationId, 'EXPIRED_UNRESOLVED', reason || 'outcome unknown', null);
}

/**
 * Startup reconciliation. Evidence lists are supplied by the caller from
 * AUTHORITATIVE sources (chain / verifier). This function never invents them.
 */
async function reconcile({ staleMinutes, confirmedIds, failedIds } = {}) {
  if (!storeAvailable()) return { ok: false, reason: 'limit_store_unavailable' };
  const policy = getPolicy();
  try {
    const { data, error } = await _client.rpc('reconcile_payment_reservations', {
      p_stale_minutes: Number.isInteger(staleMinutes) ? staleMinutes : policy.staleMinutes,
      p_confirmed_ids: Array.isArray(confirmedIds) ? confirmedIds : [],
      p_failed_ids: Array.isArray(failedIds) ? failedIds : [],
      p_force_unknown: false,
    });
    if (error) throw error;
    return { ok: true, ...(data || {}) };
  } catch (e) {
    return { ok: false, reason: 'limit_store_unavailable', error: String(e.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Allowlist administration (manual approval per wallet)
// ---------------------------------------------------------------------------
async function approveWallet(wallet, { label, chainId, addedBy } = {}) {
  if (!storeAvailable()) return { ok: false, reason: 'limit_store_unavailable' };
  const w = normalizeWallet(wallet);
  if (!w.ok) return { ok: false, reason: w.reason };
  try {
    // Re-approving a previously revoked wallet is a legitimate operator action
    // (the audit trail keeps revoked_at/revoked_by in the row history; the
    // PRIMARY KEY means only one row per wallet exists, so re-approval must
    // UPDATE the existing row rather than INSERT a duplicate). Strategy:
    //   1. PATCH the existing row to approved (clears revocation state).
    //   2. Verify the row is actually approved (the PATCH returns no row
    //      count, so a SELECT confirms effect).
    //   3. If the wallet has no row yet, INSERT it.
    // Update is idempotent; a concurrent revoke between update and insert is
    // an operator-admin race with no financial impact (worst case the insert
    // PK-conflicts and the operator retries).
    const patch = {
      status: 'approved',
      label: label ? String(label).slice(0, 120) : null,
      chain_id: Number.isInteger(chainId) ? chainId : 8453,
      added_by: addedBy ? String(addedBy).slice(0, 120) : 'operator',
      revoked_at: null,
      revoked_by: null,
      note: null,
    };
    const { error: updErr } = await _client.from('pilot_wallets').update(patch).eq('wallet', w.wallet);
    if (updErr) throw updErr;
    const existing = await getWallet(w.wallet);
    if (existing.ok && existing.wallet && existing.wallet.status === 'approved') {
      return { ok: true, wallet: w.wallet, status: 'approved' };
    }
    const { error: insErr } = await _client.from('pilot_wallets').insert({
      wallet: w.wallet,
      status: 'approved',
      label: label ? String(label).slice(0, 120) : null,
      chain_id: Number.isInteger(chainId) ? chainId : 8453,
      added_by: addedBy ? String(addedBy).slice(0, 120) : 'operator',
    });
    if (insErr) throw insErr;
    return { ok: true, wallet: w.wallet, status: 'approved' };
  } catch (e) {
    return { ok: false, reason: 'allowlist_write_failed', error: String(e.message || e).slice(0, 200) };
  }
}

async function revokeWallet(wallet, { revokedBy, note } = {}) {
  if (!storeAvailable()) return { ok: false, reason: 'limit_store_unavailable' };
  const w = normalizeWallet(wallet);
  if (!w.ok) return { ok: false, reason: w.reason };
  try {
    const { error } = await _client
      .from('pilot_wallets')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: revokedBy ? String(revokedBy).slice(0, 120) : 'operator',
        note: note ? String(note).slice(0, 200) : null,
      })
      .eq('wallet', w.wallet);
    if (error) throw error;
    return { ok: true, wallet: w.wallet, status: 'revoked' };
  } catch (e) {
    return { ok: false, reason: 'allowlist_write_failed', error: String(e.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Retry-After estimation (Gate D.3 Phase D)
// ---------------------------------------------------------------------------
// A fixed 86400s Retry-After is WRONG for a rolling window: the true earliest
// retry is when the OLDEST exposure-consuming reservation in the binding scope
// leaves the window (created_at + window_hours). Unresolved reservations
// (RESERVED/CONFIRMED/EXPIRED_UNRESOLVED) keep consuming exposure and hence
// keep pushing the retry point forward — we never promise availability that
// unresolved evidence may prevent.
//
// Returns { estimateSeconds } when a time-based retry can be established
// safely, or { estimateSeconds: null } when it cannot (hard caps like
// single_transaction_cap / allowlist / invalid input — no time frees them).
// The value is CONSERVATIVE: we return the earliest moment at which the
// binding scope's oldest block falls out of the window. For count caps this
// may still understate the wait (several slots may need to free), so callers
// must treat it as a lower bound, never a promise. When in doubt we return
// null and the caller omits the header (per protocol: never guess a precise
// retry point).
async function computeRetryAfter({ reason, wallet, chainId }) {
  if (!storeAvailable()) return { estimateSeconds: null };
  // Only rolling-window caps have a time-based retry. Everything else (single
  // cap, allowlist/revocation, malformed input, unknown store state) cannot be
  // predicted by time and MUST omit the header.
  const WINDOW_CAPS = new Set([
    'wallet_amount_cap', 'wallet_count_cap',
    'global_amount_cap', 'global_count_cap',
  ]);
  if (!WINDOW_CAPS.has(String(reason || ''))) return { estimateSeconds: null };

  const w = normalizeWallet(wallet);
  if (!w.ok) return { estimateSeconds: null };
  const scope = String(reason || '').startsWith('global_') ? 'global' : 'wallet';
  const policy = getPolicy();
  const windowHours = Number.isInteger(policy.windowHours) && policy.windowHours > 0
    ? policy.windowHours : 24;

  try {
    // The store client builder does not expose an order() method, so fetch
    // the exposure-consuming rows for the scope and find the oldest in JS.
    // Pilot volume is tiny (<= 15 tx/day), so this is trivially cheap and
    // avoids depending on PostgREST ordering syntax.
    let q = _client
      .from('payment_reservations')
      .select('created_at')
      .in('status', ['RESERVED', 'CONFIRMED', 'EXPIRED_UNRESOLVED']);
    if (scope === 'wallet') q = q.eq('wallet', w.wallet);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) return { estimateSeconds: null };
    const oldestMs = data
      .map((r) => r && r.created_at ? new Date(r.created_at).getTime() : NaN)
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b)[0];
    if (oldestMs === undefined) return { estimateSeconds: null };
    const retryMs = oldestMs + windowHours * 3600 * 1000 - Date.now();
    // If the computed point is already past (clock skew / races), the caller
    // should retry immediately rather than claim a stale wait.
    const estimateSeconds = Math.max(1, Math.ceil(retryMs / 1000));
    return { estimateSeconds };
  } catch (_) {
    // Store outage: fail closed — omit the header rather than guess.
    return { estimateSeconds: null };
  }
}

async function getWallet(wallet) {
  if (!storeAvailable()) return { ok: false, reason: 'limit_store_unavailable' };
  const w = normalizeWallet(wallet);
  if (!w.ok) return { ok: false, reason: w.reason };
  try {
    const { data, error } = await _client
      .from('pilot_wallets')
      .select('*')
      .eq('wallet', w.wallet)
      .maybeSingle();
    if (error) throw error;
    return { ok: true, wallet: data || null };
  } catch (e) {
    return { ok: false, reason: 'allowlist_read_failed', error: String(e.message || e).slice(0, 200) };
  }
}

module.exports = {
  DEFAULTS,
  SUPPORTED_ASSETS,
  getPolicy,
  isEnforcing,
  resolveAsset,
  usdToUnits,
  parseUnits,
  normalizeWallet,
  reservationIdFor,
  reservationPayloadHash,
  setStoreClient,
  getStoreClient,
  storeAvailable,
  evaluate,
  finalize,
  confirm,
  release,
  markUnresolved,
  reconcile,
  approveWallet,
  revokeWallet,
  getWallet,
  computeRetryAfter,
};
