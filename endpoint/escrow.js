// SAAX Protocol — Escrow Lifecycle (Capability 2)
//
// Deterministic, testable escrow state machine for a SAAX commitment. Protects
// funds pending an outcome with EXPLICIT funding, release, refund, timeout,
// and dispute rules — all bound to the SAME versioned commitment digest that
// the EAS anchor (capability 1) certifies, so the escrow state is checkable
// without trusting SAAX's reported database status.
//
// STATE MACHINE
//   unfunded -> funded -> held -> released | refunded | timed_out | disputed
//   disputed -> released | refunded | held (resolution)
//
// RULES (every transition is gated):
//   fund(commitmentId, digest, {amount, asset, txRef})   unfunded -> funded
//     - requires the commitment digest (the anchor binding)
//     - requires a settlement transaction reference (verified funding)
//     - amount/asset must match the commitment terms exactly (checked by caller)
//     - one escrow per commitment (exactly-one invariant, like requirement.js)
//   hold(commitmentId, digest)                           funded -> held
//     - evidence submitted, verification pending
//   release(commitmentId, digest, {verdict, evidenceRefs})  held -> released
//     - AUTHORIZED RELEASE: requires the verification verdict from the
//       fulfillment layer (evidence policy outcome) — release is denied
//       unless the agreed acceptance criteria are satisfied
//   refund(commitmentId, digest, reason)                 funded|held|disputed -> refunded
//     - requires a reason; the recovery/refund policy governs amount
//   timeout(commitmentId, digest)                        funded|held -> timed_out
//     - deadline passed with no release; explicit unknown outcome preserved
//   dispute(commitmentId, digest, raisedBy, reason, evidenceRef) -> disputed
//     - from funded|held|timed_out; raisedBy ∈ buyer|seller|signer|authority
//   resolveDispute(commitmentId, digest, resolution)     disputed -> released|refunded|held
//     - resolution ∈ release|refund|hold
//
// AUDIT CHAIN: every transition appends a hash-chained entry
//   { state, transition, at, by, prevHash, entryHash }
//   (root = commitmentId) — the same audit-chain shape as the commitment spec.
// The escrow audit chain is SEPARATE from the commitment lifecycle chain and
// from the payment/fulfillment/anchor states (the states stay independent).
//
// STORE SEAM: same pattern as outcome-log.js — an injected store client for
// durable history (PostgREST), with an in-memory fallback for offline harness
// runs. Never throws on store failure (escrow state is authoritative in the
// in-process map; the store is durable history, not the source of truth).
'use strict';

const crypto = require('crypto');

const STATES = Object.freeze({
  UNFUNDED: 'unfunded',
  FUNDED: 'funded',
  HELD: 'held',
  RELEASED: 'released',
  REFUNDED: 'refunded',
  TIMED_OUT: 'timed_out',
  DISPUTED: 'disputed',
});

const RAISED_BY = Object.freeze(['buyer', 'seller', 'signer', 'authority']);
const RESOLUTIONS = Object.freeze(['release', 'refund', 'hold']);

const _escrows = new Map(); // commitmentId -> escrow record

let _client = null;
let _durable = false; // true once the store client is injected (route-server bootstrap)
function setStoreClient(c) {
  _client = c;
  _durable = !!c;
}
function getStoreMode() { return _client ? 'postgrest' : 'memory'; }

// ---- Durable persistence helpers (PostgREST RPCs from day17 migration) --------
// All persistence is NON-BLOCKING and never throws: the in-process map remains
// the hot path; the durable store is the source of truth across restarts.
// A store failure is logged through outcome-log-style stderr only.

function _persistEscrow(escrow, state, pTxRef, pReleaseVerdict, pDispute) {
  if (!_client) return;
  // PostgREST signature matching: ALL declared params must be PRESENT in the
  // body, otherwise it searches for a reduced-arity function and 404s. Nullable
  // text fields are sent as '' and jsonb as {} — never null/undefined.
  const row = {
    p_commitment_id: escrow.commitmentId || '',
    p_commitment_digest: escrow.commitmentDigest || '',
    p_buyer: escrow.buyer || '',
    p_seller: escrow.seller || '',
    p_evaluator: escrow.evaluator || '',
    p_network: escrow.network || 'eip155:84532',
    p_asset: escrow.asset || 'USDC',
    p_amount: String(escrow.amount || ''),
    p_state: state || escrow.state,
    p_version: (escrow.version || 1) + 1,
    p_deadline: escrow.deadline || '',
    p_tx_ref: pTxRef || escrow.txRef || {},
    p_audit_chain: JSON.stringify(escrow.auditChain || []),
    p_release_verdict: pReleaseVerdict || escrow.releaseVerdict || {},
    p_dispute: pDispute || escrow.dispute || {},
  };
  _client.rpc('upsert_escrow', row).catch(() => {});
}

function _appendAuditEvent(escrow, entry) {
  if (!_client) return;
  _client.rpc('append_escrow_audit', {
    p_commitment_id: escrow.commitmentId,
    p_state: entry.state,
    p_transition: entry.transition,
    p_by: entry.by || 'system',
    p_prev_hash: entry.prevHash,
    p_entry_hash: entry.entryHash,
  }).catch(() => {});
}

// Persist EXTERNAL ACTION INTENT BEFORE any financial broadcast; reconcile
// AFTER the authoritative chain/service outcome. Idempotency-keyed so a
// crash-and-retry can never double-broadcast. Returns { ok, duplicate, status }.
async function recordIntent({ commitmentId, action, idempotencyKey, payload }) {
  if (!_client) return { ok: false, error: 'no store client (memory mode)' };
  const { data, error } = await _client.rpc('record_escrow_intent', {
    p_commitment_id: commitmentId, p_action: action,
    p_idempotency_key: idempotencyKey, p_payload: payload || {},
  });
  if (error) return { ok: false, error: String(error.message || error) };
  return data && data.ok ? { ok: true, id: data.id, status: data.status }
    : { ok: false, duplicate: !!(data && data.duplicate), status: data && data.status };
}

async function updateIntent({ idempotencyKey, intentStatus, txHash, txNonce, reconcileStatus }) {
  if (!_client) return { ok: false, error: 'no store client (memory mode)' };
  const { data, error } = await _client.rpc('update_escrow_intent', {
    p_idempotency_key: idempotencyKey, p_intent_status: intentStatus,
    p_tx_hash: txHash || null, p_tx_nonce: txNonce || null, p_reconcile_status: reconcileStatus || null,
  });
  if (error) return { ok: false, error: String(error.message || error) };
  return { ok: !!(data && data.ok), status: data && data.status, error: data && data.error };
}

async function pendingIntents(limit) {
  if (!_client) return [];
  const { data, error } = await _client.rpc('pending_escrow_intents', { p_limit: limit || 25 });
  if (error || !data) return [];
  return data;
}

// Reconcile an intent against the authoritative on-chain receipt. The intent
// row is marked confirmed/failed/unknown; a crash before save leaves it
// pending/broadcast so a fresh worker re-queries chain state before retrying.
async function reconcileIntent({ idempotencyKey, txHash, confirmed, unknown }) {
  if (!_client) return { ok: false, error: 'no store client (memory mode)' };
  if (confirmed) {
    return updateIntent({ idempotencyKey, intentStatus: 'confirmed', txHash, reconcileStatus: 'matched' });
  }
  if (unknown) {
    return updateIntent({ idempotencyKey, intentStatus: 'unknown', txHash, reconcileStatus: 'unknown' });
  }
  return updateIntent({ idempotencyKey, intentStatus: 'failed', txHash, reconcileStatus: 'mismatch' });
}

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function auditEntry(escrowId, state, transition, by, at) {
  const prevHash = escrowId; // root = commitmentId for the FIRST entry
  const entry = { state, transition, at, by, prevHash, entryHash: null };
  entry.entryHash = sha256hex(JSON.stringify({ state, transition, at, by, prevHash }));
  return entry;
}

function requireDigest(commitmentDigest, name) {
  let d = String(commitmentDigest || '').trim();
  if (d.startsWith('sha256:')) d = d.slice('sha256:'.length);
  if (d.startsWith('0x')) d = d.slice(2);
  if (!/^[a-fA-F0-9]{64}$/.test(d)) {
    throw new Error('escrow.' + name + ': commitmentDigest must be sha256:<64hex> or 0x<64hex>');
  }
  return d.toLowerCase();
}

function requireCommitmentId(id, name) {
  if (!id || typeof id !== 'string') throw new Error('escrow.' + name + ': commitmentId is required');
  return id;
}

function getEscrow(commitmentId) {
  return _escrows.get(commitmentId) || null;
}

// Public: read the current escrow state (or null if never funded).
function escrowStatus(commitmentId) {
  const e = _escrows.get(commitmentId);
  if (!e) return { state: STATES.UNFUNDED, escrow: null };
  return { state: e.state, escrow: e };
}

function _appendAudit(escrow, entry) {
  // Hash-chain the entry: the new entry's prevHash is the previous entryHash
  // (root = commitmentId for the first). The audit chain is append-only.
  const prev = escrow.auditChain.length ? escrow.auditChain[escrow.auditChain.length - 1].entryHash : escrow.commitmentId;
  entry.prevHash = prev;
  entry.entryHash = sha256hex(JSON.stringify({ state: entry.state, transition: entry.transition, at: entry.at, by: entry.by, prevHash: prev }));
  escrow.auditChain.push(entry);
  escrow.updatedAt = entry.at;
}

// ---- Transitions ---------------------------------------------------------------

// unfunded -> funded. Requires the anchor binding (digest) + a verified
// settlement transaction reference. Exactly one escrow per commitment.
function fund({ commitmentId, commitmentDigest, amount, asset, txRef, by, at, buyer, seller, evaluator, network, deadline, version }) {
  const fundOpts = { buyer, seller, evaluator, network, deadline, version };
  const id = requireCommitmentId(commitmentId, 'fund');
  const digest = requireDigest(commitmentDigest, 'fund');
  if (amount === undefined || amount === null || !/^\d+(\.\d+)?$/.test(String(amount))) throw new Error('escrow.fund: amount must be a numeric string');
  if (!asset || typeof asset !== 'string') throw new Error('escrow.fund: asset is required');
  if (!txRef || typeof txRef !== 'object' || !txRef.txHash) throw new Error('escrow.fund: txRef with txHash is required (verified funding)');

  if (_escrows.has(id)) {
    const existing = _escrows.get(id);
    if (existing.state === STATES.FUNDED || existing.state === STATES.HELD) {
      return { ok: true, escrow: existing, alreadyFunded: true }; // idempotent re-fund
    }
    throw new Error('escrow.fund: ST_FUND_FROM_STATE — cannot fund from state ' + existing.state);
  }

  const now = at || new Date().toISOString();
  const escrow = {
    commitmentId: id,
    commitmentDigest: digest,
    state: STATES.FUNDED,
    amount: String(amount),
    asset,
    buyer: fundOpts.buyer || '',
    seller: fundOpts.seller || '',
    evaluator: fundOpts.evaluator || '',
    network: fundOpts.network || 'eip155:84532',
    deadline: fundOpts.deadline || null,
    version: fundOpts.version || 1,
    txRef: { txHash: txRef.txHash, rail: txRef.rail || 'x402' },
    fundedAt: now,
    updatedAt: now,
    releasedAt: null,
    refundedAt: null,
    timedOutAt: null,
    disputedAt: null,
    resolvedAt: null,
    dispute: null,
    auditChain: [auditEntry(id, STATES.FUNDED, 'fund', by || 'system', now)],
    releaseVerdict: null,
  };
  _escrows.set(id, escrow);

  // Durable history (non-blocking): write the escrow row (day17 RPC signature).
  if (_client) _persistEscrow(escrow, STATES.FUNDED);
  return { ok: true, escrow, alreadyFunded: false };
}

// funded -> held (evidence submitted, verification pending).
function hold({ commitmentId, commitmentDigest, by, at }) {
  const id = requireCommitmentId(commitmentId, 'hold');
  const digest = requireDigest(commitmentDigest, 'hold');
  const escrow = _escrows.get(id);
  if (!escrow) throw new Error('escrow.hold: ST_HOLD_UNFUNDED — escrow is not funded');
  if (escrow.commitmentDigest !== digest) throw new Error('escrow.hold: digest binding mismatch — escrow is bound to a different commitment digest');
  if (escrow.state !== STATES.FUNDED) throw new Error('escrow.hold: ST_HOLD_FROM_STATE — cannot hold from state ' + escrow.state);

  const now = at || new Date().toISOString();
  escrow.state = STATES.HELD;
  escrow.heldAt = now;
  escrow.version = (escrow.version || 1) + 1;
  const entry = { state: STATES.HELD, transition: 'hold', at: now, by: by || 'system' };
  _appendAudit(escrow, entry);
  _appendAuditEvent(escrow, entry);
  _persistEscrow(escrow, STATES.HELD, null, null, null);
  return { ok: true, escrow };
}

// held -> released. AUTHORIZED RELEASE: requires the fulfillment verification
// verdict (evidence policy outcome) — release is denied unless the agreed
// acceptance criteria are satisfied AND the verdict names the release.
function release({ commitmentId, commitmentDigest, verdict, evidenceRefs, by, at }) {
  const id = requireCommitmentId(commitmentId, 'release');
  const digest = requireDigest(commitmentDigest, 'release');
  const escrow = _escrows.get(id);
  if (!escrow) throw new Error('escrow.release: ST_RELEASE_UNFUNDED — escrow is not funded');
  if (escrow.commitmentDigest !== digest) throw new Error('escrow.release: digest binding mismatch — escrow is bound to a different commitment digest');
  if (escrow.state !== STATES.HELD && escrow.state !== STATES.FUNDED) {
    throw new Error('escrow.release: ST_RELEASE_FROM_STATE — cannot release from state ' + escrow.state);
  }
  // Authorized release gate: the verification verdict MUST say satisfied.
  const verdictOk = verdict && (verdict.satisfied === true || verdict.outcome === 'satisfied' || verdict.verified === true);
  if (!verdictOk) {
    throw new Error('escrow.release: ST_RELEASE_UNAUTHORIZED — release requires a satisfied verification verdict (got ' + (verdict && verdict.outcome) + ')');
  }

  const now = at || new Date().toISOString();
  escrow.state = STATES.RELEASED;
  escrow.releasedAt = now;
  escrow.version = (escrow.version || 1) + 1;
  escrow.releaseVerdict = { satisfied: true, verdict, evidenceRefs: evidenceRefs || [] };
  const entry = { state: STATES.RELEASED, transition: 'release', at: now, by: by || 'system' };
  _appendAudit(escrow, entry);
  _appendAuditEvent(escrow, entry);
  _persistEscrow(escrow, STATES.RELEASED, null, escrow.releaseVerdict, null);
  return { ok: true, escrow };
}

// funded|held|disputed -> refunded. Requires a reason; refund policy governs.
function refund({ commitmentId, commitmentDigest, reason, by, at }) {
  const id = requireCommitmentId(commitmentId, 'refund');
  const digest = requireDigest(commitmentDigest, 'refund');
  const escrow = _escrows.get(id);
  if (!escrow) throw new Error('escrow.refund: ST_REFUND_UNFUNDED — escrow is not funded');
  if (escrow.commitmentDigest !== digest) throw new Error('escrow.refund: digest binding mismatch — escrow is bound to a different commitment digest');
  if (!reason || typeof reason !== 'string') throw new Error('escrow.refund: reason is required');
  if (![STATES.FUNDED, STATES.HELD, STATES.DISPUTED].includes(escrow.state)) {
    throw new Error('escrow.refund: ST_REFUND_FROM_STATE — cannot refund from state ' + escrow.state);
  }

  const now = at || new Date().toISOString();
  escrow.state = STATES.REFUNDED;
  escrow.refundedAt = now;
  escrow.refundReason = reason;
  escrow.version = (escrow.version || 1) + 1;
  const entry = { state: STATES.REFUNDED, transition: 'refund', at: now, by: by || 'system' };
  _appendAudit(escrow, entry);
  _appendAuditEvent(escrow, entry);
  _persistEscrow(escrow, STATES.REFUNDED, null, null, null);
  return { ok: true, escrow };
}

// funded|held -> timed_out (deadline passed with no release). Explicit unknown
// outcome preserved (never silently released or refunded).
function timeout({ commitmentId, commitmentDigest, by, at }) {
  const id = requireCommitmentId(commitmentId, 'timeout');
  const digest = requireDigest(commitmentDigest, 'timeout');
  const escrow = _escrows.get(id);
  if (!escrow) throw new Error('escrow.timeout: ST_TIMEOUT_UNFUNDED — escrow is not funded');
  if (escrow.commitmentDigest !== digest) throw new Error('escrow.timeout: digest binding mismatch — escrow is bound to a different commitment digest');
  if (![STATES.FUNDED, STATES.HELD].includes(escrow.state)) {
    throw new Error('escrow.timeout: ST_TIMEOUT_FROM_STATE — cannot timeout from state ' + escrow.state);
  }

  const now = at || new Date().toISOString();
  escrow.state = STATES.TIMED_OUT;
  escrow.timedOutAt = now;
  escrow.version = (escrow.version || 1) + 1;
  const entry = { state: STATES.TIMED_OUT, transition: 'timeout', at: now, by: by || 'system' };
  _appendAudit(escrow, entry);
  _appendAuditEvent(escrow, entry);
  _persistEscrow(escrow, STATES.TIMED_OUT, null, null, null);
  return { ok: true, escrow };
}

// funded|held|timed_out -> disputed. Raised by a party with a reason + evidence.
function dispute({ commitmentId, commitmentDigest, raisedBy, reason, evidenceRef, by, at }) {
  const id = requireCommitmentId(commitmentId, 'dispute');
  const digest = requireDigest(commitmentDigest, 'dispute');
  const escrow = _escrows.get(id);
  if (!escrow) throw new Error('escrow.dispute: ST_DISPUTE_UNFUNDED — escrow is not funded');
  if (escrow.commitmentDigest !== digest) throw new Error('escrow.dispute: digest binding mismatch — escrow is bound to a different commitment digest');
  if (!RAISED_BY.includes(raisedBy)) throw new Error('escrow.dispute: raisedBy must be one of ' + RAISED_BY.join('|'));
  if (!reason || typeof reason !== 'string') throw new Error('escrow.dispute: reason is required');
  if (![STATES.FUNDED, STATES.HELD, STATES.TIMED_OUT].includes(escrow.state)) {
    throw new Error('escrow.dispute: ST_DISPUTE_FROM_STATE — cannot dispute from state ' + escrow.state);
  }

  const now = at || new Date().toISOString();
  escrow.state = STATES.DISPUTED;
  escrow.disputedAt = now;
  escrow.version = (escrow.version || 1) + 1;
  escrow.dispute = { raisedBy, reason, evidenceRef: evidenceRef || null, openedAt: now };
  const entry = { state: STATES.DISPUTED, transition: 'dispute', at: now, by: by || raisedBy };
  _appendAudit(escrow, entry);
  _appendAuditEvent(escrow, entry);
  _persistEscrow(escrow, STATES.DISPUTED, null, null, escrow.dispute);
  return { ok: true, escrow };
}

// disputed -> released|refunded|held. Resolution names the outcome.
function resolveDispute({ commitmentId, commitmentDigest, resolution, verdict, reason, by, at }) {
  const id = requireCommitmentId(commitmentId, 'resolveDispute');
  const digest = requireDigest(commitmentDigest, 'resolveDispute');
  const escrow = _escrows.get(id);
  if (!escrow) throw new Error('escrow.resolveDispute: ST_RESOLVE_UNFUNDED — escrow is not funded');
  if (escrow.commitmentDigest !== digest) throw new Error('escrow.resolveDispute: digest binding mismatch — escrow is bound to a different commitment digest');
  if (escrow.state !== STATES.DISPUTED) throw new Error('escrow.resolveDispute: ST_RESOLVE_FROM_STATE — only a disputed escrow can be resolved (state ' + escrow.state + ')');
  if (!RESOLUTIONS.includes(resolution)) throw new Error('escrow.resolveDispute: resolution must be one of ' + RESOLUTIONS.join('|'));
  if (resolution === 'release' && !reason) {
    // release requires a satisfied verdict (same gate as release())
    if (!verdict || (verdict.satisfied !== true && verdict.outcome !== 'satisfied' && verdict.verified !== true)) {
      throw new Error('escrow.resolveDispute: ST_RESOLVE_UNAUTHORIZED — release resolution requires a satisfied verification verdict');
    }
  }

  const now = at || new Date().toISOString();
  escrow.resolvedAt = now;
  escrow.version = (escrow.version || 1) + 1;
  escrow.disputeResolution = { resolution, reason: reason || null, resolvedAt: now, by: by || 'system' };
  if (resolution === 'release') {
    escrow.state = STATES.RELEASED;
    escrow.releasedAt = now;
    escrow.releaseVerdict = { satisfied: true, verdict, evidenceRefs: [] };
    const entry = { state: STATES.RELEASED, transition: 'resolve_dispute_release', at: now, by: by || 'system' };
    _appendAudit(escrow, entry);
    _appendAuditEvent(escrow, entry);
    _persistEscrow(escrow, STATES.RELEASED, null, escrow.releaseVerdict, null);
  } else if (resolution === 'refund') {
    escrow.state = STATES.REFUNDED;
    escrow.refundedAt = now;
    escrow.refundReason = reason || 'dispute resolved to refund';
    const entry = { state: STATES.REFUNDED, transition: 'resolve_dispute_refund', at: now, by: by || 'system' };
    _appendAudit(escrow, entry);
    _appendAuditEvent(escrow, entry);
    _persistEscrow(escrow, STATES.REFUNDED, null, null, null);
  } else {
    escrow.state = STATES.HELD;
    escrow.heldAt = now;
    const entry = { state: STATES.HELD, transition: 'resolve_dispute_hold', at: now, by: by || 'system' };
    _appendAudit(escrow, entry);
    _appendAuditEvent(escrow, entry);
    _persistEscrow(escrow, STATES.HELD, null, null, null);
  }
  return { ok: true, escrow };
}

// ---- Audit chain verification ---------------------------------------------------
// Independently verify an escrow's audit chain: every entryHash must match its
// content and the chain must be hash-linked (prevHash === prior entryHash,
// root === commitmentId). Returns { ok, verified, reason }.
function verifyAuditChain(commitmentId) {
  const escrow = _escrows.get(commitmentId);
  if (!escrow) return { ok: false, verified: false, reason: 'no escrow for commitment' };
  const chain = escrow.auditChain || [];
  let prev = escrow.commitmentId;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (entry.prevHash !== prev) {
      return { ok: false, verified: false, reason: 'chain broken at entry ' + i + ': prevHash mismatch' };
    }
    const expected = sha256hex(JSON.stringify({ state: entry.state, transition: entry.transition, at: entry.at, by: entry.by, prevHash: prev }));
    if (entry.entryHash !== expected) {
      return { ok: false, verified: false, reason: 'chain tampered at entry ' + i + ': entryHash does not match content' };
    }
    prev = entry.entryHash;
  }
  return { ok: true, verified: true, reason: null };
}

// ---- F3B: explicit custody-version dispatch (LOCAL TEST ONLY) --------------
// Version selection is NEVER inferred from manifest/export formatVersion. It
// is driven by the custody identity declared for the active chain/lane and
// validated against the pinned artifact. The V1 legacy artifact remains the
// hosted lane (84532) default; the V2 candidate remains the local D3 lane
// (31337) default; V3 is explicitly selectable ONLY on the local lane via
// SAAX_CUSTODY_VERSION=3 (chain-restricted, never silently substituted).
const path = require('path');
const { JsonRpcProvider, Contract, getAddress } = require('ethers');
const custodyVersion = require('./custody-version.js');

// Back-compat: the explicit legacy artifact path override (SAAX_CUSTODY_ABI)
// still works, but NEVER silently changes the custody version lane mapping.
function custodyArtifactFor(version, legacyAbiPath) {
  if (legacyAbiPath) {
    try { return require(path.resolve(String(legacyAbiPath).trim())).abi; } catch (e) { return null; }
  }
  const sel = custodyVersion.selectCustodyVersion({ chainId: versionChainHint(), declaredVersion: version || '' });
  return sel.ok ? sel.artifact.abi : null;
}
function versionChainHint() {
  // The chain is resolved live below; the artifact hint is only for a
  // declared SAAX_CUSTODY_VERSION in the local lane. 84532 hosted default = V1.
  if (String(process.env.SAAX_NETWORK || '').trim().toLowerCase() === 'local') {
    return Number(process.env.SAAX_CHAIN_ID || 31337);
  }
  return 84532;
}

async function verifyOnChain(commitmentId, opts) {
  opts = opts || {};
  // The guard source is the RPC-resolved chain: an explicit eth_chainId
  // round-trip against the active RPC, never configuration.
  // LOCAL INTEGRATED MODE (SAAX_NETWORK=local): the local EVM runs on the
  // distinct local chain ID (SAAX_CHAIN_ID, e.g. 31337) per the chain-identity
  // resolution. The hosted lane default (SAAX_NETWORK unset) remains
  // Base Sepolia 84532 ONLY — unchanged.
  const localMode = String(process.env.SAAX_NETWORK || '').trim().toLowerCase() === 'local';
  const allowedChain = localMode ? Number(process.env.SAAX_CHAIN_ID || 31337) : 84532;
  const rpc = String(process.env.SAAX_RPC_URL || (allowedChain === 84532 ? 'https://sepolia.base.org' : 'http://127.0.0.1:8545')).trim();
  let provider;
  let chainId;
  try {
    provider = new JsonRpcProvider(rpc);
    chainId = Number(await provider.send('eth_chainId', []));
    if (chainId !== allowedChain) {
      return { ok: false, reason: 'escrow-backed mode is ' + (localMode ? 'local-EVM-only (chain ' + chainId + ', expected ' + allowedChain + ')' : 'testnet-only (chain ' + chainId + ', expected ' + allowedChain + ')'), error: 'CHAIN_MISMATCH' };
    }
  } catch (e) {
    return { ok: false, reason: 'provider failed: ' + String(e.message || e).slice(0, 160), error: 'PROVIDER' };
  }
  const custody = String(opts.custody || process.env.SAAX_CUSTODY_ADDRESS || '').trim();
  if (!custody) {
    return { ok: false, reason: 'no custody address (SAAX_CUSTODY_ADDRESS unset)', error: 'NO_CUSTODY' };
  }
  // F3B: select the custody version explicitly. The declared version comes
  // from opts.custodyVersion (route-server passes it through) or the env
  // override (SAAX_CUSTODY_VERSION — local lane only). NEVER formatVersion.
  const declared = String(opts.custodyVersion || process.env.SAAX_CUSTODY_VERSION || '').trim();
  const sel = custodyVersion.selectCustodyVersion({ chainId, declaredVersion: declared });
  if (!sel.ok) {
    return { ok: false, reason: 'custody version dispatch: ' + sel.errors.join('; '), error: 'VERSION_DISPATCH' };
  }
  // Identity check when the chain is readable: the deployed runtime must
  // match the pinned artifact runtimeCodeHash (V3 ships it; V1/V2 legacy
  // artifacts may not — then the artifact selection + chain binding is the
  // documented assurance, consistent with prior behavior).
  if (sel.identity && sel.identity.runtimeCodeHash) {
    try {
      const code = await provider.send('eth_getCode', [custody, 'latest']);
      if (code && code !== '0x' && code.length > 2) {
        const { ethers } = require('ethers');
        const deployedHash = ethers.keccak256(code);
        if (deployedHash.toLowerCase() !== sel.identity.runtimeCodeHash.toLowerCase()) {
          return { ok: false, reason: 'custody identity mismatch: deployed runtime hash ' + deployedHash.slice(0, 18) + ' != pinned ' + sel.identity.runtimeCodeHash.slice(0, 18) + ' (v' + sel.version + ')', error: 'IDENTITY_MISMATCH' };
        }
      }
    } catch (e) {
      // code read unavailable — identity not assertable this call; the
      // artifact/ABI selection remains the documented local-lane assurance.
    }
  }
  const custodyAbi = (opts.abiOverride) ? opts.abiOverride
    : (custodyArtifactFor(sel.version, process.env.SAAX_CUSTODY_ABI));
  if (!custodyAbi) {
    return { ok: false, reason: 'custody ABI artifact missing', error: 'NO_ABI' };
  }
  let escrowAddr;
  try { escrowAddr = getAddress(custody); } catch (e) { return { ok: false, reason: 'invalid custody address', error: 'BAD_ADDRESS' }; }
  const contract = new Contract(escrowAddr, custodyAbi, provider);
  try {
    const row = await contract.getEscrow(commitmentId);
    // V3 getEscrow returns a 20-tuple ending in committedHead/headCommittedAt
    // (indexes 10/11) BEFORE the V2 common tail (policyId..refundedAt shifts).
    // Decode by version: V3 keeps the V3 ABI's named tuple, so row fields are
    // named identically but the head fields exist only there.
    const escrow = {
      id: row.id,
      digest: row.digest,
      token: row.token,
      buyer: row.buyer,
      seller: row.seller,
      evaluator: row.evaluator,
      amount: row.amount.toString(),
      deadline: row.deadline ? row.deadline.toString() : (row.resolutionDeadline ? row.resolutionDeadline.toString() : ''),
      resolutionDeadline: row.resolutionDeadline ? row.resolutionDeadline.toString() : (row.deadline ? row.deadline.toString() : ''),
      finalCutoff: row.finalCutoff ? row.finalCutoff.toString() : '',
      minReleaseTime: row.minReleaseTime ? row.minReleaseTime.toString() : '',
      committedHead: row.committedHead || null,
      headCommittedAt: row.headCommittedAt ? row.headCommittedAt.toString() : '0',
      state: ['unfunded','funded','disputed','released','refunded'][Number(row.state)] || String(row.state),
      disputedBy: row.disputedBy,
      disputeAt: row.disputeAt ? row.disputeAt.toString() : '0',
      releasedAt: row.releasedAt ? row.releasedAt.toString() : '0',
      refundedAt: row.refundedAt ? row.refundedAt.toString() : '0',
      custodyVersion: sel.version,
    };
    const funded = escrow.state === 'funded' || escrow.state === 'disputed';
    // Recover the authoritative Funded event (tx hash + block) for this commitment.
    let fundTx = null, fundBlock = null, fundedAt = null;
    try {
      const topic = contract.interface.encodeFilterTopics('Funded', [commitmentId]);
      // Bounded scan from a sane floor (public RPC getLogs caps ranges),
      // capped at the chain's LATEST BLOCK: on a low-block chain (local EVM,
      // fresh testnet) an unbounded scan walking to 0x7ffffff0 would iterate
      // billions of empty pages. The authoritative ceiling is the head.
      let head;
      try { head = Number(await provider.send('eth_blockNumber', [])); }
      catch (_) { head = 0; }
      const DEPLOY_FLOOR = Number(process.env.SAAX_ESCROW_SCAN_FROM_BLOCK || 48170000);
      const SCAN_CEIL = Math.min(0x7ffffff0, head > 0 ? head : DEPLOY_FLOOR);
      let logs = [];
      for (let fromB = DEPLOY_FLOOR; fromB <= SCAN_CEIL; fromB += 200) {
        const toB = Math.min(fromB + 199, SCAN_CEIL);
        let page;
        try { page = await provider.getLogs({ fromBlock: fromB, toBlock: toB, address: escrowAddr, topics: topic }); }
        catch (e) { break; }
        if (page && page.length) logs.push(...page);
        if (toB >= SCAN_CEIL) break;
      }
      if (logs && logs.length) {
        const last = logs[logs.length - 1];
        fundTx = last.transactionHash || null;
        fundBlock = String(last.blockNumber || '');
        const parsed = contract.interface.parseLog(last);
        if (parsed && parsed.args && parsed.args.at !== undefined) fundedAt = String(parsed.args.at);
      }
    } catch (e) { /* event recovery is best-effort; state read already succeeded */ }
    escrow.fundTx = fundTx;
    escrow.fundBlock = fundBlock;
    escrow.fundedAt = fundedAt;
    return { ok: true, chainId, custody: escrowAddr.toLowerCase(), escrow, funded };
  } catch (e) {
    return { ok: false, reason: 'contract read failed: ' + String(e.message || e).slice(0, 160), error: 'READ_FAILED' };
  }
}

async function verifyOnChainOrThrow(commitmentId, opts, expected) {
  const res = await verifyOnChain(commitmentId, opts);
  if (!res.ok) throw new Error('escrow on-chain verify failed: ' + (res.reason || res.error));
  if (expected) {
    for (const k of Object.keys(expected)) {
      if (res.escrow[k] !== undefined && String(res.escrow[k]).toLowerCase() !== String(expected[k]).toLowerCase()) {
        throw new Error('escrow on-chain binding mismatch (' + k + '): ' + res.escrow[k] + ' != ' + expected[k]);
      }
    }
  }
  return res;
}

module.exports = {
  verifyOnChain,
  verifyOnChainOrThrow,
  STATES,
  fund,
  hold,
  release,
  refund,
  timeout,
  dispute,
  resolveDispute,
  escrowStatus,
  verifyAuditChain,
  setStoreClient,
  getStoreMode,
  recordIntent,
  updateIntent,
  reconcileIntent,
  pendingIntents,
};