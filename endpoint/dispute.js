// SAAX Protocol — MCP Lifecycle Phase 4: Dispute governance helpers (CJS).
//
// Bridges the durable dispute RPCs (ax_router.raise_dispute / resolve_dispute /
// list_disputes) into the MCP surface with the SAME principal-binding security
// model as Phases 2-3:
//   - The caller's EIP-712 authority proof is verified; the recovered signer
//     is the ONLY accepted verifiedPrincipal (never a caller-supplied agentId).
//   - The RPC re-verifies the durable agent_authorizations registry inside the
//     transaction (principal + role + scope + revocation + expiry).
//   - Dispute resolution NEVER triggers a financial transfer: only the
//     nonfinancial canonical outcomes (continue|rework|satisfied|against)
//     are exposed; 'settled' is intentionally omitted.
//   - Sensitive payload content is not stored beyond the dispute record.
'use strict';

const storeModule = require('./store.js');
const authority = require('./authority.js');

function isConfigured() {
  return !!(process.env.POSTGREST_URL || process.env.SAAX_POSTGREST_URL || process.env.SUPABASE_URL);
}

function client() {
  if (!isConfigured()) throw new Error('dispute storage not configured');
  return (storeModule.buildStoreClient && storeModule.buildStoreClient()) || storeModule.buildSupabaseClient();
}

function sanitize(msg) {
  return String(msg || '').replace(/(sk|key|token|secret|password|authorization)[^\s]{0,60}/gi, '$1:<redacted>').slice(0, 300);
}

/**
 * Verify the caller's EIP-712 proof and return the recovered principal.
 * Reuses the same domain/structure rules as lifecycle-mcp.verifyProof.
 */
async function verifyProof(proof, opts = {}) {
  if (!proof || typeof proof !== 'object') return { ok: false, reason: 'authority proof is required', stage: 'structure' };
  if (typeof authority.validateAuthorityProofStructure !== 'function' || typeof authority.verifyProofSignature !== 'function') {
    return { ok: false, reason: 'authority module missing verifiers', stage: 'structure' };
  }
  const structural = authority.validateAuthorityProofStructure(proof);
  if (!structural.ok) return { ok: false, reason: structural.reason, stage: 'structure' };
  const sig = await authority.verifyProofSignature(proof, opts);
  if (!sig.ok) return { ok: false, reason: sig.reason, stage: 'signature' };
  const nowMs = Date.now();
  const fromMs = Date.parse(proof.validFrom);
  const untilMs = Date.parse(proof.validUntil);
  if (nowMs < fromMs) return { ok: false, reason: 'proof not yet valid', stage: 'time' };
  if (nowMs > untilMs) return { ok: false, reason: 'proof expired', stage: 'time' };
  const principal = String(proof.issuer || '').toLowerCase();
  if (!principal) return { ok: false, reason: 'issuer not recoverable', stage: 'signature' };
  return { ok: true, principal, stage: 'ok' };
}

/** Raise a dispute (authorized initiator). */
async function raiseDispute(args = {}, opts = {}) {
  try {
    const commitmentId = String(args.commitmentId || '').trim();
    const disputeId = String(args.disputeId || '').trim() || ('disp-' + commitmentId + '-' + Date.now());
    const agentId = String(args.agentId || '').trim();
    const reason = String(args.reason || '').trim();
    if (!commitmentId || !agentId || reason.length < 8) {
      return { ok: false, reason: 'commitmentId, agentId, and a reason of at least 8 characters are required', stage: 'input' };
    }
    const vp = await verifyProof(args.proof, opts);
    if (!vp.ok) return { ok: false, reason: vp.reason, stage: vp.stage };

    const evidenceRefs = Array.isArray(args.evidenceRefs) ? args.evidenceRefs : [];
    const idemRef = String(args.idempotencyRef || '').trim() || ('disp:' + agentId + ':' + commitmentId + ':' + disputeId);

    const db = client();
    const { data, error } = await db.rpc('raise_dispute', {
      p_commitment_id: commitmentId,
      p_dispute_id: disputeId,
      p_agent_id: agentId,
      p_verified_principal: vp.principal,
      p_reason: reason,
      p_evidence_refs: evidenceRefs,
      p_idempotency_ref: idemRef,
    });
    if (error) return { ok: false, reason: sanitize(error.message || error), stage: 'rpc' };
    if (!data) return { ok: false, reason: 'raise_dispute returned no record', stage: 'rpc' };
    return { ok: true, record: data, stage: 'ok' };
  } catch (e) {
    return { ok: false, reason: sanitize(e.message || e), stage: 'error' };
  }
}

/** Resolve a dispute (evaluator only; nonfinancial outcomes). */
async function resolveDispute(args = {}, opts = {}) {
  try {
    const disputeId = String(args.disputeId || '').trim();
    const outcome = String(args.outcome || '').trim();
    const agentId = String(args.agentId || '').trim();
    if (!disputeId || !['continue', 'rework', 'satisfied', 'against'].includes(outcome) || !agentId) {
      return { ok: false, reason: 'disputeId, outcome (continue|rework|satisfied|against), and agentId are required', stage: 'input' };
    }
    const vp = await verifyProof(args.proof, opts);
    if (!vp.ok) return { ok: false, reason: vp.reason, stage: vp.stage };

    const idemRef = String(args.idempotencyRef || '').trim() || ('res:' + agentId + ':' + disputeId);

    const db = client();
    const { data, error } = await db.rpc('resolve_dispute', {
      p_dispute_id: disputeId,
      p_outcome: outcome,
      p_agent_id: agentId,
      p_verified_principal: vp.principal,
      p_reason: String(args.reason || '').trim() || null,
      p_idempotency_ref: idemRef,
    });
    if (error) return { ok: false, reason: sanitize(error.message || error), stage: 'rpc' };
    if (!data) return { ok: false, reason: 'resolve_dispute returned no record', stage: 'rpc' };
    return { ok: true, record: data, stage: 'ok' };
  } catch (e) {
    return { ok: false, reason: sanitize(e.message || e), stage: 'error' };
  }
}

/** List disputes for a commitment (authorized read). */
async function listDisputes(args = {}, opts = {}) {
  try {
    const commitmentId = String(args.commitmentId || '').trim();
    const agentId = String(args.agentId || '').trim();
    if (!commitmentId || !agentId) return { ok: false, reason: 'commitmentId and agentId are required', stage: 'input' };
    const vp = await verifyProof(args.proof, opts);
    if (!vp.ok) return { ok: false, reason: vp.reason, stage: vp.stage };

    const db = client();
    const { data, error } = await db.rpc('list_disputes', {
      p_commitment_id: commitmentId,
      p_agent_id: agentId,
      p_verified_principal: vp.principal,
      p_status: args.status || null,
      p_limit: args.limit || 50,
      p_offset: args.offset || 0,
    });
    if (error) return { ok: false, reason: sanitize(error.message || error), stage: 'rpc' };
    if (!data) return { ok: false, reason: 'list_disputes returned no record', stage: 'rpc' };
    return { ok: true, record: data, stage: 'ok' };
  } catch (e) {
    return { ok: false, reason: sanitize(e.message || e), stage: 'error' };
  }
}

module.exports = { verifyProof, raiseDispute, resolveDispute, listDisputes };