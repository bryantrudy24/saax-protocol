// SAAX Protocol — usage telemetry (OPT-IN, default OFF, write-only, best-effort)
//
// Purpose: structured, durable gateway-request measurement WITHOUT changing
// financial behavior. This module is DISABLED unless SAAX_USAGE_TELEMETRY=on.
// It records one row per gateway request into ax_router.gateway_requests
// (see data/migration-20261108-gateway-usage-measurement.sql — PREPARED, NOT
// APPLIED). All writes are fire-and-forget: a telemetry failure NEVER affects
// the request outcome, never retries a payment, and never throws into the
// handler path.
//
// Privacy: NO IP addresses, user-agents, cookies, authorization headers, or
// payment payloads are logged. client_id is an OPTIONAL authenticated
// agent/client identifier supplied by the application — never derived from an
// IP. is_synthetic marks demo/fixture/test traffic so reporting can exclude it.
//
// When the migration is NOT applied, the table is absent and the module
// silently no-ops (writes are skipped) — it must not break the gateway.
'use strict';

const ENABLED = String(process.env.SAAX_USAGE_TELEMETRY || 'off').toLowerCase() === 'on';

let _storeClient = null; // injected via setStoreClient (same store as idempotency/ratelimit)
let _env = process.env.VERCEL_ENV || process.env.NODE_ENV || 'local';

function setStoreClient(c) { _storeClient = c; }
function setEnvironment(e) { _env = e; }
function isEnabled() { return ENABLED && !!_storeClient; }

// Record one gateway request. Never throws. Fire-and-forget.
async function record({ endpoint, method, status, outcome, durationMs, clientId, commitmentId, idempotencyKey, txHash, chainId, isRetry, isSynthetic, errorCode, requestId }) {
  if (!isEnabled()) return { ok: false, skipped: 'disabled' };
  try {
    const row = {
      request_id: requestId || (require('crypto').randomUUID()),
      environment: _env,
      endpoint: String(endpoint || '').slice(0, 200),
      method: String(method || '').slice(0, 10),
      status: Number.isInteger(status) ? status : null,
      outcome: String(outcome || 'unknown').slice(0, 32),
      duration_ms: Number.isInteger(durationMs) ? durationMs : null,
      client_id: clientId ? String(clientId).slice(0, 200) : null,
      commitment_id: commitmentId ? String(commitmentId).slice(0, 200) : null,
      idempotency_key: idempotencyKey ? String(idempotencyKey).slice(0, 200) : null,
      tx_hash: txHash ? String(txHash).slice(0, 100) : null,
      chain_id: Number.isInteger(chainId) ? chainId : null,
      is_retry: !!isRetry,
      is_synthetic: !!isSynthetic,
      error_code: errorCode ? String(errorCode).slice(0, 100) : null,
    };
    await _storeClient.from('gateway_requests').insert(row);
    return { ok: true };
  } catch (e) {
    // Telemetry is write-only and best-effort: never surface into the request path.
    if (process.env.SAAX_USAGE_TELEMETRY_DEBUG === 'on') {
      console.error('[usage-telemetry] record skipped:', e.message);
    }
    return { ok: false, skipped: 'error' };
  }
}

module.exports = { record, setStoreClient, setEnvironment, isEnabled, ENABLED };
