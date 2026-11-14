// SAAX Protocol — MCP Lifecycle Phase 3: EAS event-anchoring module.
//
// DESIGN (Phase 3F): independent tamper-evidence for lifecycle and evidence
// events via the Ethereum Attestation Service. This module is SIMULATED /
// TESTNET-ONLY: it never submits a mainnet attestation. The production path
// (real EAS contract calls) requires a custody/signing trust boundary that is
// NOT authorized yet — this module defines the deterministic contract and a
// mock anchor transport so the design is testable in isolation.
//
// Security policy:
//   - Deterministic event hash: sha256 over canonical JSON (sorted keys) of
//     { schemaVersion, eventType, commitmentId, eventId, fromState, toState,
//       actorPrincipal, authorityRef, evidenceRef, timestamp, chainId }.
//   - Explicit schema/version identifiers (schemaVersion=1) so hash semantics
//     cannot drift silently.
//   - Commitment binding: the commitmentId is inside the hashed payload.
//   - Attestation reference: { attestationUid?, txHash?, chainId, network,
//       status: pending|confirmed|failed, anchoredAt }.
//   - Idempotent anchoring attempts: keyed by eventId — one anchor record per
//     event; re-anchor attempts return the existing record.
//   - Reconciliation after uncertain network outcomes: a pending anchor is
//     re-checked (verifyAnchor) and only marked confirmed when the mock
//     transport returns a confirmed receipt; an unconfirmed anchor is NEVER
//     reported as anchored.
//   - No false claim of anchoring: status stays 'pending' until the transport
//     confirms; the DB record and API responses both reflect that.
//   - Anchoring is asynchronous by design; lifecycle availability never
//     depends on anchor confirmation.
'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const ANCHOR_SCHEMA_UID = '0x' + 'ab'.repeat(16); // deterministic mock schema UID (testnet)
const CHAIN_ID = 11155111; // Sepolia (testnet) — mainnet requires approval

/** Canonicalize an object: sorted keys, stable JSON. */
function canonical(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {});
    }
    return v;
  });
}

/** Deterministic event hash over the full anchor payload. */
function eventHash(event) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    eventType: event.eventType,
    commitmentId: event.commitmentId,
    eventId: event.eventId,
    fromState: event.fromState || null,
    toState: event.toState || null,
    actorPrincipal: event.actorPrincipal || null,
    authorityRef: event.authorityRef || null,
    evidenceRef: event.evidenceRef || null,
    timestamp: event.timestamp || new Date().toISOString(),
    chainId: CHAIN_ID,
  };
  return 'sha256:' + crypto.createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

/**
 * In-memory anchor registry (test/simulated). A real implementation would
 * persist anchor records next to the event ledger; this module keeps a map so
 * the design and its idempotency/reconciliation semantics are testable without
 * a production schema change.
 */
const _anchors = new Map(); // eventId -> { status, attestationUid?, txHash?, attempts, anchoredAt?, confirmedAt?, error? }

function _mockTransport(eventHashHex) {
  // Simulated EAS: 90% confirm on first attempt, else pending (uncertain).
  // Deterministic per hash so tests can force both branches.
  const last = eventHashHex.slice(-1);
  if (['0', '1', '2', '3', '4', '5', '6', '7', '8'].includes(last)) {
    return { ok: true, attestationUid: '0x' + crypto.createHash('sha256').update(eventHashHex).digest('hex').slice(0, 64), txHash: '0x' + crypto.createHash('sha256').update(eventHashHex + ':tx').digest('hex').slice(0, 64) };
  }
  return { ok: false, reason: 'simulated network uncertainty (pending)' };
}

/**
 * Anchor an event. Idempotent per eventId: re-anchoring returns the existing
 * record (status preserved). Never reports 'confirmed' without a confirmed
 * transport receipt.
 */
async function anchorEvent(event, opts = {}) {
  if (!event || !event.eventId || !event.commitmentId || !event.eventType) {
    return { ok: false, reason: 'eventId, commitmentId, and eventType are required' };
  }
  const digest = eventHash(event);
  const existing = _anchors.get(event.eventId);
  if (existing) {
    return { ok: true, record: { ...existing, eventId: event.eventId, digest, replayed: true } };
  }
  const transport = (opts && opts.transport) || _mockTransport;
  const attempt = await transport(digest);
  const record = {
    eventId: event.eventId,
    commitmentId: event.commitmentId,
    digest,
    schemaUid: ANCHOR_SCHEMA_UID,
    chainId: CHAIN_ID,
    network: 'sepolia-testnet',
    status: attempt.ok ? 'confirmed' : 'pending',
    attestationUid: attempt.ok ? attempt.attestationUid : null,
    txHash: attempt.ok ? attempt.txHash : null,
    attempts: 1,
    anchoredAt: new Date().toISOString(),
    confirmedAt: attempt.ok ? new Date().toISOString() : null,
    error: attempt.ok ? null : (attempt.reason || null),
  };
  _anchors.set(event.eventId, record);
  return { ok: true, record };
}

/**
 * Reconcile a pending anchor: re-check the transport for confirmation.
 * A pending anchor is NEVER promoted to confirmed without a confirmed receipt.
 */
async function reconcileAnchor(eventId, opts = {}) {
  const existing = _anchors.get(eventId);
  if (!existing) return { ok: false, reason: 'no anchor record for event ' + eventId };
  if (existing.status !== 'pending') return { ok: true, record: { ...existing, replayed: true } };
  const transport = (opts && opts.transport) || _mockTransport;
  const attempt = await transport(existing.digest);
  if (attempt.ok) {
    const updated = { ...existing, status: 'confirmed', attestationUid: attempt.attestationUid, txHash: attempt.txHash, confirmedAt: new Date().toISOString(), error: null, attempts: existing.attempts + 1 };
    _anchors.set(eventId, updated);
    return { ok: true, record: updated };
  }
  const updated = { ...existing, attempts: existing.attempts + 1, error: attempt.reason || 'still pending' };
  _anchors.set(eventId, updated);
  return { ok: true, record: updated };
}

/** Read an anchor record. */
function getAnchor(eventId) {
  const r = _anchors.get(eventId);
  return r ? { ok: true, record: { ...r } } : { ok: false, reason: 'not anchored' };
}

/** Test seam: clear the registry. */
function _reset() { _anchors.clear(); }

module.exports = {
  eventHash, anchorEvent, reconcileAnchor, getAnchor, _reset,
  SCHEMA_VERSION, ANCHOR_SCHEMA_UID, CHAIN_ID,
};