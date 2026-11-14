// SAAX Protocol — MCP Lifecycle Phase 3: evidence lifecycle helpers (CJS).
//
// Bridges the durable evidence RPCs (ax_router.submit_evidence /
// verify_evidence / list_evidence) into the MCP surface with the SAME
// principal-binding security model as Phase 2:
//   - The caller's EIP-712 authority proof is verified; the recovered signer
//     is the ONLY accepted verifiedPrincipal (never a caller-supplied agentId
//     or header).
//   - The RPC re-verifies the durable agent_authorizations registry inside the
//     transaction (principal + role + scope + revocation + expiry).
//   - Evidence submission NEVER transitions the commitment state and never
//     triggers settlement, escrow release, or finalization.
//   - Sensitive payload content is not stored: only integrity references
//     (payload_hash) and the validated envelope metadata.
'use strict';

const storeModule = require('./store.js');
const lifecycle = require('./lifecycle.js');
const authority = require('./authority.js');

const MAX_ENVELOPE_BYTES = 65536; // must match the RPC guard

function isConfigured() {
  return !!(process.env.POSTGREST_URL || process.env.SAAX_POSTGREST_URL || process.env.SUPABASE_URL);
}

function client() {
  if (!isConfigured()) throw new Error('evidence storage not configured');
  return (storeModule.buildStoreClient && storeModule.buildStoreClient()) || storeModule.buildSupabaseClient();
}

function sanitize(msg) {
  return String(msg || '').replace(/(sk|key|token|secret|password|authorization)[^\s]{0,60}/gi, '$1:<redacted>').slice(0, 300);
}

/**
 * Verify the caller's EIP-712 proof and return the recovered principal.
 * Mirrors lifecycle-mcp.verifyPrincipal but without requiring a commitment
 * row for the structural/signature stages (the RPC enforces binding).
 * @param {object} proof
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, principal?:string, reason?:string, stage?:string}>}
 */
async function verifyProof(proof, opts = {}) {
  if (!proof || typeof proof !== 'object') return { ok: false, reason: 'authority proof is required', stage: 'structure' };
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

/**
 * Submit evidence durably. Returns the stable evidence record.
 * @param {object} args { commitmentId, criterionId, agentId, proof, evidence }
 * @returns {Promise<{ok:boolean, record?:object, reason?:string, stage?:string}>}
 */
async function submitEvidence(args = {}, opts = {}) {
  try {
    const commitmentId = String(args.commitmentId || '').trim();
    const agentId = String(args.agentId || '').trim();
    const criterionId = args.criterionId ? String(args.criterionId).trim() : null;
    const proof = args.proof;
    const evidence = args.evidence;
    if (!commitmentId || !agentId) return { ok: false, reason: 'commitmentId and agentId are required', stage: 'input' };
    if (!evidence || typeof evidence !== 'object') return { ok: false, reason: 'evidence object is required', stage: 'input' };

    // Principal verification (EIP-712 recovery).
    const vp = await verifyProof(proof, opts);
    if (!vp.ok) return { ok: false, reason: vp.reason, stage: vp.stage };

    // Envelope size guard (mirrors the RPC).
    const envBytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    if (envBytes > MAX_ENVELOPE_BYTES) {
      return { ok: false, reason: 'evidence envelope exceeds ' + MAX_ENVELOPE_BYTES + ' bytes (' + envBytes + ')', stage: 'input' };
    }

    // Payload hash: canonical integrity reference. Prefer the caller-provided
    // payloadHash when present and well-formed; otherwise compute over the
    // canonical payload. The RPC binds this into the op fingerprint.
    let payloadHash = String(evidence.payloadHash || '').trim();
    if (!/^[a-f0-9]{16,128}$/i.test(payloadHash)) {
      const crypto = require('crypto');
      payloadHash = 'sha256:' + crypto.createHash('sha256')
        .update(JSON.stringify(evidence.payload || {}), 'utf8').digest('hex');
    }

    const idemRef = String(args.idempotencyRef || '').trim() || ('ev:' + agentId + ':' + commitmentId + ':' + Date.now());

    const db = client();
    const { data, error } = await db.rpc('submit_evidence', {
      p_commitment_id: commitmentId,
      p_criterion_id: criterionId,
      p_agent_id: agentId,
      p_verified_principal: vp.principal,
      p_envelope: evidence,
      p_payload_hash: payloadHash,
      p_idempotency_ref: idemRef,
    });
    if (error) {
      const msg = sanitize(error.message || error);
      return { ok: false, reason: msg, stage: 'rpc' };
    }
    if (!data || !data.evidence_id) return { ok: false, reason: 'submit_evidence returned no record', stage: 'rpc' };
    return { ok: true, record: data, stage: 'ok' };
  } catch (e) {
    return { ok: false, reason: sanitize(e.message || e), stage: 'error' };
  }
}

/**
 * Verify or reject evidence (evaluator only). Idempotent per verdict.
 */
async function verifyEvidence(args = {}, opts = {}) {
  try {
    const evidenceId = String(args.evidenceId || '').trim();
    const agentId = String(args.agentId || '').trim();
    const verdict = String(args.verdict || '').toLowerCase();
    const proof = args.proof;
    if (!evidenceId || !agentId || !['verified', 'rejected'].includes(verdict)) {
      return { ok: false, reason: 'evidenceId, agentId, and verdict (verified|rejected) are required', stage: 'input' };
    }
    const vp = await verifyProof(proof, opts);
    if (!vp.ok) return { ok: false, reason: vp.reason, stage: vp.stage };

    const db = client();
    const { data, error } = await db.rpc('verify_evidence', {
      p_evidence_id: evidenceId,
      p_verdict: verdict,
      p_agent_id: agentId,
      p_verified_principal: vp.principal,
      p_reason: verdict === 'rejected' ? String(args.reason || 'rejected by evaluator') : null,
      p_expected_version: args.expectedVersion != null ? Number(args.expectedVersion) : null,
    });
    if (error) return { ok: false, reason: sanitize(error.message || error), stage: 'rpc' };
    return { ok: true, record: data, stage: 'ok' };
  } catch (e) {
    return { ok: false, reason: sanitize(e.message || e), stage: 'error' };
  }
}

/**
 * List evidence for a commitment (commitment-scoped; caller must hold an
 * active authorization on the commitment).
 */
async function listEvidence(args = {}, opts = {}) {
  try {
    const commitmentId = String(args.commitmentId || '').trim();
    const agentId = String(args.agentId || '').trim();
    const proof = args.proof;
    if (!commitmentId || !agentId) return { ok: false, reason: 'commitmentId and agentId are required', stage: 'input' };
    const vp = await verifyProof(proof, opts);
    if (!vp.ok) return { ok: false, reason: vp.reason, stage: vp.stage };

    const db = client();
    const { data, error } = await db.rpc('list_evidence', {
      p_commitment_id: commitmentId,
      p_agent_id: agentId,
      p_verified_principal: vp.principal,
      p_status: args.status ? String(args.status) : null,
      p_limit: Math.min(Math.max(Number(args.limit) || 50, 1), 200),
      p_offset: Math.max(Number(args.offset) || 0, 0),
    });
    if (error) return { ok: false, reason: sanitize(error.message || error), stage: 'rpc' };
    return { ok: true, record: data, stage: 'ok' };
  } catch (e) {
    return { ok: false, reason: sanitize(e.message || e), stage: 'error' };
  }
}

module.exports = { submitEvidence, verifyEvidence, listEvidence, verifyProof, MAX_ENVELOPE_BYTES };