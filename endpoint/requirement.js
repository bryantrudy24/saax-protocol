// SAAX Protocol — Day 11, Item 2: Settlement Requirement (R) Issuance
//
// Reference: IETF draft-king-yew-choo-agentic-payments (Agent-Initiated Payment
// Gating). The payment requirement R is SETTLEMENT-METHOD-NEUTRAL:
//
//   R = <amt, cur, payee, eta, scheme, t_exp>
//
//   amt    amount (raw units as string, from the commitment manifest)
//   cur    currency (e.g. USDC)
//   payee  the seller/recipient address
//   eta    server-minted single-use nonce (expect-token-address)
//   scheme "Payment"
//   t_exp  requirement expiry (ISO 8601 / epoch seconds)
//
// The settlement method S that REALISES R (x402, MPP, entitlement, card, ...)
// is resolved at EXECUTION time — never at commitment time. A commitment can be
// issued with NO rail knowledge at all.
//
// CRITICAL RULES:
//   1. Exactly ONE R is issued per commitment (issueRequirement is idempotent
//      per commitmentId: a second issue for the same commitment returns the
//      SAME R — no nonce churn, no double-issuance).
//   2. The eta nonce is consumed on successful gate commit and never becomes
//      fresh again (consumeNonce).
//   3. A fresh R carries a fresh nonce (a new commitment -> new R -> new nonce).
//   4. Replay of a consumed nonce is rejected (consumeNonce -> { ok:false }).
const crypto = require('crypto');

// ---- In-process nonce + requirement stores ------------------------------------
// Phase 1 keeps state in-process (single server instance). The nonce store maps
// nonce -> { status: 'fresh'|'consumed', commitmentId }. The requirement store
// maps commitmentId -> R (exactly-one-issuance invariant).
const _nonceStore = new Map();
const _reqStore = new Map();
const NONCE_STORE_MAX = 100000;

function _prune() {
  if (_nonceStore.size >= NONCE_STORE_MAX) {
    const oldest = _nonceStore.keys().next().value;
    _nonceStore.delete(oldest);
  }
}

function mintNonce() {
  return 'eta_' + crypto.randomBytes(32).toString('hex');
}

// Issue exactly one R per commitment. If the commitment already has an R,
// return it unchanged (invariant 1). Requires a payee address and amount/
// currency derived from the manifest.
function issueRequirement({ commitmentId, payee, amt, cur, ttlSeconds }) {
  if (!commitmentId || typeof commitmentId !== 'string') throw new Error('issueRequirement: commitmentId is required');
  if (!payee || typeof payee !== 'string') throw new Error('issueRequirement: payee is required');
  if (amt === undefined || amt === null || !/^\d+(\.\d+)?$/.test(String(amt))) throw new Error('issueRequirement: amt must be a numeric string');
  if (!cur || typeof cur !== 'string') throw new Error('issueRequirement: cur is required');

  const existing = _reqStore.get(commitmentId);
  if (existing) return { ...existing, fresh: false };

  const ttl = Number(ttlSeconds || 300);
  const nonce = mintNonce();
  const issuedAt = Date.now();
  const R = {
    amt: String(amt),
    cur: String(cur).toUpperCase(),
    payee,
    eta: nonce,
    scheme: 'Payment',
    t_exp: new Date(issuedAt + ttl * 1000).toISOString(),
    commitmentId,
  };
  _nonceStore.set(nonce, { status: 'fresh', commitmentId });
  _prune();
  _reqStore.set(commitmentId, R);
  return { ...R, fresh: true };
}

// Consume the nonce on successful gate commit. Idempotent per nonce:
// first call consumes (ok:true), any later call on the SAME nonce is rejected
// (ok:false, reason 'nonce already consumed') — replay protection.
function consumeNonce(nonce) {
  const rec = _nonceStore.get(String(nonce || ''));
  if (!rec) return { ok: false, reason: 'unknown nonce', nonce };
  if (rec.status === 'consumed') return { ok: false, reason: 'nonce already consumed (replay rejected)', nonce };
  rec.status = 'consumed';
  return { ok: true, nonce, commitmentId: rec.commitmentId };
}

function nonceStatus(nonce) {
  const rec = _nonceStore.get(String(nonce || ''));
  return rec ? rec.status : 'unknown';
}

function getRequirement(commitmentId) {
  return _reqStore.get(commitmentId) || null;
}

function isFresh(nonce) {
  return _nonceStore.get(String(nonce || ''))?.status === 'fresh';
}

// Test helper: reset in-process state between isolated harness runs.
function reset() {
  _nonceStore.clear();
  _reqStore.clear();
}

module.exports = {
  mintNonce,
  issueRequirement,
  consumeNonce,
  nonceStatus,
  getRequirement,
  isFresh,
  reset,
};