// SAAX Protocol — Sprint 2 Item 1: outcome logging (ranking_outcomes)
//
// Wires the ranking engine into saax_router.ranking_outcomes. Every ranked
// result inserts a row capturing the ordered supplier ids, the computed
// composite scores, the selected supplier, the exact weights_used snapshot,
// whether shrinkage was applied, and (later, at settlement-observation time)
// the outcome/fee/rail.
//
// Write path: PostgREST (self-hosted Docker, service-role JWT from .env) via
// the store client, exactly like idempotency/ratelimit. When the store is not
// configured (offline harness runs) we keep an in-memory append-only buffer
// with a best-effort flush — the sanctioned route-around used elsewhere in
// this codebase. Trade-secret rule: rows never appear in API responses.
//
// row shape (all optional except the brief's NOT NULLs); component_scores is
// the additive per-component breakdown for tuning analysis (see dump/tuning_tables.sql):
//   { request_id, capability, supplier_ids[], supplier_scores[], selected_supplier,
//     weights_used{}, shrinkage_applied, component_scores{}, outcome,
//     routing_fee_usd, settlement_rail }

const store = require('./store.js');

let _client = null;
let _buffer = [];
let _flushPromise = null;

function setStoreClient(c) { _client = c; }
function getStoreMode() { return _client ? 'postgrest' : 'memory'; }

// Insert one outcome row. Never throws: the endpoint must not fail because
// telemetry is unavailable. Returns { ok, error? }.
async function logOutcome(row) {
  const clean = {
    request_id: String(row.request_id || '').slice(0, 512),
    capability: String(row.capability || '').slice(0, 512),
    supplier_ids: Array.isArray(row.supplier_ids) ? row.supplier_ids.map(String) : [],
    supplier_scores: Array.isArray(row.supplier_scores) ? row.supplier_scores.map(Number) : [],
    selected_supplier: row.selected_supplier != null ? String(row.selected_supplier) : null,
    weights_used: row.weights_used || {},
    shrinkage_applied: !!row.shrinkage_applied,
    component_scores: row.component_scores || null,
    outcome: row.outcome || null,
    outcome_timestamp: row.outcome_timestamp || null,
    routing_fee_usd: row.routing_fee_usd != null ? Number(row.routing_fee_usd) : null,
    settlement_rail: row.settlement_rail || null,
  };
  if (!clean.supplier_ids.length || !clean.supplier_scores.length) {
    return { ok: false, error: new Error('outcome row missing supplier_ids/supplier_scores') };
  }
  if (!_client) {
    _buffer.push({ ...clean, created_at: new Date().toISOString() });
    return { ok: true, mode: 'memory-buffered' };
  }
  try {
    const res = await _client.from('ranking_outcomes').insert(clean);
    if (res && res.error) throw res.error;
    return { ok: true, mode: 'postgrest' };
  } catch (e) {
    _buffer.push({ ...clean, created_at: new Date().toISOString() });
    return { ok: false, mode: 'postgrest-failed-buffered', error: String((e && e.message) || e) };
  }
}

// Best-effort flush of the in-memory buffer when the store comes up later.
async function flushBuffer() {
  if (!_client || !_buffer.length) return { flushed: 0 };
  if (_flushPromise) return _flushPromise;
  _flushPromise = (async () => {
    const batch = _buffer.splice(0, _buffer.length);
    let flushed = 0;
    for (const row of batch) {
      try {
        const res = await _client.from('ranking_outcomes').insert(row);
        if (!(res && res.error)) flushed++;
      } catch (_) {}
    }
    _buffer = _buffer.concat(batch.slice(flushed));
    return { flushed };
  })().finally(() => { _flushPromise = null; });
  return _flushPromise;
}

// All queued rows (memory mode; used by the test harness to assert writes).
function queued() { return _buffer.slice(); }
function clearBuffer() { _buffer = []; }

module.exports = { setStoreClient, getStoreMode, logOutcome, flushBuffer, queued, clearBuffer };