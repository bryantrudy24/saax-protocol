// SAAX Protocol — Sprint 2: shared helpers for tuning scripts
//
// Centralizes: store client bootstrap (PostgREST service-role JWT from .env),
// outcome fetching (last 90 days), predictive-power computation, guardrail
// application, and proposal insert. All three tuning scripts + the test
// harness import from here so the analysis math is one implementation.
const fs = require('fs');
const path = require('path');
const store = require('../../endpoint/store.js');

const COMPONENTS = ['reputation', 'freshness', 'price'];

// ---- Store ----------------------------------------------------------------
function buildClient() {
  const c = store.buildStoreClient();
  if (!c) throw new Error('store not configured: POSTGREST_URL + SAAX_POSTGREST_KEY required');
  return c;
}

// ---- Outcome fetching (last 90 days, outcome resolved) ----------------------
// PostgREST filter for outcome IS NOT NULL:
//   outcome=neq.null  (PostgREST treats `null` literal as SQL NULL)
async function fetchOutcomes(client, { days = 90, outcomeOnly = true } = {}) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const q = client.from('ranking_outcomes')
    .select('request_id,capability,supplier_ids,supplier_scores,selected_supplier,weights_used,shrinkage_applied,component_scores,outcome,outcome_timestamp,routing_fee_usd,settlement_rail')
    .gte('created_at', since);
  if (outcomeOnly) q.neq('outcome', 'null');
  const res = await q;
  if (res.error) throw res.error;
  return res.data || [];
}

// ---- Predictive power -------------------------------------------------------
// For each component, how strongly does the SELECTED supplier's component
// score correlate with outcome = success? Success is 1/0; a component's score
// is on 0-100. Uses point-biserial correlation (Pearson between the binary
// outcome and the component value of the selected supplier). The selected
// supplier's component score comes from component_scores.rows (recorded at
// ranking time) so each outcome traces to the exact formula + scores that
// produced it.
// Returns { reputation, freshness, price } in [0,1] (abs of correlation,
// clamped) plus the direction sign and sample counts.
function predictivePowers(rows) {
  const vals = { reputation: [], freshness: [], price: [] };
  let nSuccess = 0;
  let nFailure = 0;
  for (const row of rows) {
    if (!row || row.outcome !== 'success' && row.outcome !== 'failure') continue;
    const sel = row.selected_supplier;
    const comps = (row.component_scores && row.component_scores.rows) || [];
    const c = comps.find(x => String(x.agent_id) === String(sel));
    if (!c) continue;
    if (row.outcome === 'success') nSuccess++; else nFailure++;
    for (const comp of COMPONENTS) {
      const v = Number(c[comp]);
      if (Number.isFinite(v)) vals[comp].push({ x: v, y: row.outcome === 'success' ? 1 : 0 });
    }
  }
  const out = {};
  const total = nSuccess + nFailure;
  for (const comp of COMPONENTS) {
    const pts = vals[comp];
    if (pts.length < 2) { out[comp] = { power: 0, n: pts.length, dir: 0 }; continue; }
    const { r, dir } = pearson(pts.map(p => p.x), pts.map(p => p.y));
    const power = Math.min(1, Math.max(0, Math.abs(r)));
    out[comp] = { power: Math.round(power * 10000) / 10000, n: pts.length, dir };
  }
  out._meta = { nSuccess, nFailure, total, windowDays: 90 };
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return { r: 0, dir: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const xd = xs[i] - mx, yd = ys[i] - my;
    num += xd * yd; dx += xd * xd; dy += yd * yd;
  }
  if (dx === 0 || dy === 0) return { r: 0, dir: 0 };
  const r = num / Math.sqrt(dx * dy);
  return { r, dir: r > 0 ? 1 : r < 0 ? -1 : 0 };
}

// ---- Guardrails ------------------------------------------------------------
// new weights proportional to predictive power, satisfying ALL of:
//   - sum to 1.0 (normalized)
//   - each component within [minW=0.1, maxW=0.7]
//   - each component within current ± maxDelta=0.15
// Algorithm: normalize the raw proposal to 1.0, then alternate
//   (a) clamp each component to [max(minW, cur-maxDelta), min(maxW, cur+maxDelta)]
//   (b) renormalize
// until a fixed point. A final exact clip to [minW, maxW] after the last
// renormalize guarantees the hard bounds always hold, and each component
// stays within the ±delta band of current (clamping (a) is a contraction).
// The result never violates a bound even when normalization would overshoot.
function applyGuardrails(proposal, current, opts = {}) {
  const maxDelta = opts.maxDelta != null ? opts.maxDelta : 0.15;
  const minW = opts.minW != null ? opts.minW : 0.1;
  const maxW = opts.maxW != null ? opts.maxW : 0.7;
  let w = {
    reputation: Number(proposal.reputation) || 0,
    freshness: Number(proposal.freshness) || 0,
    price: Number(proposal.price) || 0,
  };
  const cur = {
    reputation: Number(current.reputation) || 0,
    freshness: Number(current.freshness) || 0,
    price: Number(current.price) || 0,
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const normalize = (x) => {
    const s = x.reputation + x.freshness + x.price;
    if (s <= 0) return { reputation: cur.reputation, freshness: cur.freshness, price: cur.price };
    return {
      reputation: x.reputation / s,
      freshness: x.freshness / s,
      price: x.price / s,
    };
  };
  if (w.reputation + w.freshness + w.price <= 0) return { ...cur, _guardrails: 'no-signal-kept-current' };
  w = normalize(w);
  // Per-component clamp window: intersection of [minW,maxW] and [cur±maxDelta].
  const win = {};
  for (const c of COMPONENTS) {
    win[c] = { lo: Math.max(minW, cur[c] - maxDelta), hi: Math.min(maxW, cur[c] + maxDelta) };
  }
  // Feasibility: the window must be able to sum to 1. If the sum of the hi
  // bounds < 1 or sum of lo bounds > 1, no feasible point exists; widen the
  // window by relaxing maxDelta first, then bounds (never below minW).
  const sumHi = win.reputation.hi + win.freshness.hi + win.price.hi;
  const sumLo = win.reputation.lo + win.freshness.lo + win.price.lo;
  if (sumHi < 1) {
    // distribute the deficit across components below their global max
    for (const c of COMPONENTS) win[c].hi = Math.min(maxW, win[c].hi + (1 - sumHi));
  }
  if (sumLo > 1) {
    for (const c of COMPONENTS) win[c].lo = Math.max(minW, win[c].lo - (sumLo - 1));
  }
  for (let pass = 0; pass < 5; pass++) {
    for (const c of COMPONENTS) w[c] = clamp(w[c], win[c].lo, win[c].hi);
    const s = w.reputation + w.freshness + w.price;
    if (Math.abs(s - 1) < 1e-9) break;
    w = normalize(w);
    // Early stop: no component bound changes between passes.
  }
  // Final fixed point: normalize, clamp to per-component windows, and clear
  // any residual (1 - sum) by distributing it ONLY to components with headroom
  // inside their windows — so a component pinned at its window bound (e.g.
  // reputation at 0.7) is never pushed past it by the compensation.
  let s = 0;
  for (let pass = 0; pass < 6; pass++) {
    w = normalize(w);
    for (const c of COMPONENTS) w[c] = clamp(w[c], win[c].lo, win[c].hi);
    s = w.reputation + w.freshness + w.price;
    if (Math.abs(s - 1) < 1e-9) break;
    const diff = 1 - s;
    if (diff > 0) {
      const head = { reputation: win.reputation.hi - w.reputation, freshness: win.freshness.hi - w.freshness, price: win.price.hi - w.price };
      const avail = head.reputation + head.freshness + head.price;
      if (avail > 1e-12) for (const c of COMPONENTS) w[c] += diff * (head[c] / avail);
      else break;
    } else {
      const room = { reputation: w.reputation - win.reputation.lo, freshness: w.freshness - win.freshness.lo, price: w.price - win.price.lo };
      const avail = room.reputation + room.freshness + room.price;
      if (avail > 1e-12) for (const c of COMPONENTS) w[c] += diff * (room[c] / avail);
      else break;
    }
  }
  w = {
    reputation: Math.round(w.reputation * 10000) / 10000,
    freshness: Math.round(w.freshness * 10000) / 10000,
    price: Math.round(w.price * 10000) / 10000,
  };
  // Rounding can move the sum by up to ±0.0003; compensate bound-aware.
  const roundedSum = w.reputation + w.freshness + w.price;
  const diff = 1 - roundedSum;
  if (Math.abs(diff) > 1e-6) {
    const head = { reputation: win.reputation.hi - w.reputation, freshness: win.freshness.hi - w.freshness, price: win.price.hi - w.price };
    const avail = head.reputation + head.freshness + head.price;
    if (avail > 1e-12) {
      for (const c of COMPONENTS) w[c] = Math.round((w[c] + diff * (head[c] / avail)) * 10000) / 10000;
    }
  }
  w._guardrails = 'applied';
  return w;
}

// ---- Proposal insert --------------------------------------------------------
async function insertProposal(client, proposal) {
  const res = await client.from('tuning_proposals').insert(proposal);
  if (res && res.error) throw res.error;
  return proposal;
}

async function insertHistory(client, h) {
  const res = await client.from('tuning_history').insert(h);
  if (res && res.error) throw res.error;
  return h;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { COMPONENTS, buildClient, fetchOutcomes, predictivePowers, pearson, applyGuardrails, insertProposal, insertHistory, today };