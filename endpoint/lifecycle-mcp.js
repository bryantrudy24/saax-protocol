// SAAX Protocol — MCP Lifecycle Phase 2: principal-bound lifecycle helpers (CJS).
//
// Bridges the hardened Phase 1 lifecycle architecture (endpoint/lifecycle.js +
// ax_router.transition_commitment) into the MCP surface with INDEPENDENT
// PRINCIPAL BINDING.
//
// SECURITY MODEL (Phase 2B):
//   - The MCP caller proves its identity with an EIP-712 authority proof
//     (endpoint/authority.js, eip712 scheme). The recovered signer address is
//     the ONLY accepted verifiedPrincipal — never a caller-supplied agentId or
//     a header.
//   - A transition is authorized ONLY when a durable agent_authorizations row
//     binds (agentId, principal, commitment, role) AND the row is unrevoked,
//     unexpired, and in scope. The RPC re-verifies all of this inside the
//     transaction (FOR UPDATE), so a concurrent revoke serializes first.
//   - No operator secret, service credential, or unrestricted DB capability is
//     ever exposed through MCP. Direct RPC invocation remains blocked (the
//     tables carry no service-role DML grants; writes flow only through the
//     SECURITY DEFINER RPCs, which this module invokes via the app wrapper).
//
// RECOVERY (Phase 2D):
//   - getRecoveryStatus / getPendingActions reconcile the authoritative
//     commitment row BEFORE exposing a mutation recommendation.
//   - resumeCommitment performs a transition ONLY with the replacement agent's
//     own verified principal + durable authorization — authority never
//     transfers automatically with the commitment.
'use strict';

const storeModule = require('./store.js');
const lifecycle = require('./lifecycle.js');
const authority = require('./authority.js');

function isConfigured() {
  return !!(process.env.POSTGREST_URL || process.env.SAAX_POSTGREST_URL || process.env.SUPABASE_URL);
}

function client() {
  if (!isConfigured()) throw new Error('lifecycle storage not configured');
  return (storeModule.buildStoreClient && storeModule.buildStoreClient()) || storeModule.buildSupabaseClient();
}

/** Build a commitment-context object the RPC/authority layer understands. */
function commitmentContext(row) {
  const terms = row && row.terms && typeof row.terms === 'object' ? row.terms : {};
  return {
    commitment: {
      commitmentId: row && row.commitment_id,
      state: row && row.state,
      buyerAgentId: terms.buyerAgentId || null,
      sellerAgentId: terms.sellerAgentId || null,
      authorityProofId: terms.authorityProofId || row && row.authority_ref || null,
      capability: terms.deliverable || row && row.capability || null,
    },
    capability: terms.deliverable || row && row.capability || null,
    currency: terms.price && terms.price.currency || null,
    amountRaw: terms.price && terms.price.amount || null,
  };
}

/**
 * Independently verify the caller's EIP-712 authority proof and return the
 * recovered signer (the ONLY accepted verifiedPrincipal). Never trusts
 * caller-supplied identity fields.
 *
 * Verification is role-aware:
 *   - EVERY caller: structural validation + signature recovery + time validity.
 *   - BUYER role: additionally, the proof subject must equal the commitment's
 *     buyerAgentId (authority.js full validateAuthorityProof).
 *   - NON-BUYER roles (provider/evaluator/authority/system): the proof subject
 *     is the agent itself; the commitment buyer binding does NOT apply. Their
 *     authority comes from the durable agent_authorizations registry, which
 *     the RPC re-verifies inside the transaction (principal binding).
 *
 * @param {object} proof  the EIP-712 AuthorityProof
 * @param {object} commitmentRow  the commitment row (for binding checks)
 * @param {object} [opts]  { verifyVerifier } for custom verifier hooks (tests);
 *                          callerRole overrides the role used for binding
 * @returns {Promise<{ok:boolean, principal?:string, reason?:string, stage?:string}>}
 */
async function verifyPrincipal(proof, commitmentRow, opts = {}) {
  if (!proof || typeof proof !== 'object') {
    return { ok: false, reason: 'authority proof is required', stage: 'structure' };
  }
  if (!commitmentRow) {
    return { ok: false, reason: 'commitment not found', stage: 'binding' };
  }
  const callerRole = String(opts.callerRole || 'buyer').toLowerCase();
  const callerAction = String(opts.callerAction || opts.action || '').toLowerCase();

  // 1. Structural validation (shared by all roles).
  const structural = authority.validateAuthorityProofStructure(proof);
  if (!structural.ok) return { ok: false, reason: structural.reason, stage: 'structure' };

  // 2. Buyer binding: proof.subject must equal the commitment buyer — for the
  //    buyer's OWN lifecycle actions (accept/cancel/dispute/raise). Recovery
  //    and read operations (resume/history/recover/list) may be performed by
  //    an independently authorized replacement agent whose address differs
  //    from the original buyer; its authority comes from its own durable
  //    agent_authorizations row, re-verified by the RPC inside the
  //    transaction. The anti-impersonation property is preserved: a
  //    replacement can NEVER act as the buyer on buyer-scoped lifecycle
  //    actions without its own registry row, and the RPC re-checks principal
  //    binding for every transition.
  const recoveryActions = new Set(['resume', 'history', 'recover', 'list', 'list_evidence', 'get_recovery_status', 'get_pending_actions']);
  if (callerRole === 'buyer' && !recoveryActions.has(callerAction)) {
    const buyerAgentId = (commitmentRow.terms && commitmentRow.terms.buyerAgentId) || null;
    if (buyerAgentId && String(buyerAgentId).toLowerCase() !== String(proof.subject).toLowerCase()) {
      return { ok: false, reason: 'proof subject is not the commitment buyer', stage: 'binding' };
    }
  }

  // 3. Signature recovery over the exact PROOF domain (name+version only).
  const sig = await authority.verifyProofSignature(proof, opts);
  if (!sig.ok) return { ok: false, reason: sig.reason, stage: 'signature' };

  // 4. Time validity.
  const nowMs = Date.now();
  const fromMs = Date.parse(proof.validFrom);
  const untilMs = Date.parse(proof.validUntil);
  if (nowMs < fromMs) return { ok: false, reason: 'proof not yet valid (validFrom in future)', stage: 'time' };
  if (nowMs > untilMs) return { ok: false, reason: 'proof expired (validUntil passed)', stage: 'time' };

  // The recovered signer is the verified principal (proof.issuer).
  const principal = String(proof.issuer || '').toLowerCase();
  if (!principal) return { ok: false, reason: 'issuer (signer) not recoverable', stage: 'signature' };
  return { ok: true, principal, stage: 'ok' };
}

/**
 * Load the authoritative commitment row (reconcile-before-read). Returns null
 * when the commitment does not exist.
 */
async function loadCommitment(commitmentId) {
  const db = client();
  const { data, error } = await db
    .from('commitments')
    .select('commitment_id,state,capability,terms,version,authority_ref,evidence_refs,created_at,updated_at')
    .eq('commitment_id', commitmentId)
    .limit(1);
  if (error) throw new Error('commitment lookup failed: ' + (lifecycle.sanitize ? lifecycle.sanitize(error.message) : error.message));
  return data && data.length ? data[0] : null;
}

/** Read the durable event ledger for a commitment (newest first). */
async function readHistory(commitmentId) {
  const db = client();
  const { data, error } = await db
    .from('commitment_events')
    .select('event_id,commitment_id,from_state,to_state,requested_action,actor_identity,actor_role,authority_ref,event_timestamp,state_version,idempotency_ref,evidence_ref')
    .eq('commitment_id', commitmentId);
  if (error) throw new Error('event history failed: ' + (lifecycle.sanitize ? lifecycle.sanitize(error.message) : error.message));
  const rows = data || [];
  return rows.sort((a, b) => String(b.event_timestamp).localeCompare(String(a.event_timestamp)));
}

/** Read the caller's durable authorization row (commitment-scoped or system). */
async function loadAuthorization(agentId, principal, commitmentId, role) {
  const db = client();
  let q = db
    .from('agent_authorizations')
    .select('authz_id,agent_id,principal_identity,commitment_id,role,scope,valid_from,valid_until,revoked_at,revoked_by,delegation_ref,created_at')
    .eq('agent_id', agentId)
    .eq('principal_identity', String(principal).toLowerCase())
    .eq('role', role);
  if (commitmentId) q = q.eq('commitment_id', commitmentId);
  else q = q.is('commitment_id', null);
  const { data, error } = await q.limit(1);
  if (error) throw new Error('authorization lookup failed: ' + (lifecycle.sanitize ? lifecycle.sanitize(error.message) : error.message));
  return data && data.length ? data[0] : null;
}

/** True when the authz row is currently valid (unrevoked, within window). */
function authzActive(row) {
  if (!row) return false;
  if (row.revoked_at) return false;
  const now = Date.now();
  if (row.valid_from && Date.parse(row.valid_from) > now) return false;
  if (row.valid_until && Date.parse(row.valid_until) < now) return false;
  return true;
}

/** Derive the set of lifecycle states reachable from `state` (canonical 39-edge map). */
function allowedTransitions(state) {
  switch (state) {
    case 'issued': return ['authority_validated', 'accepted', 'cancelled', 'expired'];
    case 'authority_validated': return ['accepted', 'failed', 'expired'];
    case 'accepted': return ['executing', 'in_flight', 'cancelled', 'expired'];
    case 'in_flight': return ['executing', 'failed', 'expired'];
    case 'executing': return ['evidence_pending', 'recovering', 'failed', 'expired'];
    case 'evidence_pending': return ['evidence_submitted', 'recovering', 'failed'];
    case 'evidence_submitted': return ['verifying', 'disputed'];
    case 'verifying': return ['fulfilled', 'recovering', 'failed'];
    case 'fulfilled': return ['settled', 'disputed'];
    case 'recovering': return ['executing', 'evidence_pending', 'failed', 'fulfilled'];
    case 'disputed': return ['executing', 'recovering', 'fulfilled', 'failed', 'settled'];
    case 'settled': return ['finalized', 'disputed'];
    default: return [];
  }
}

/** Role required to reach `toState` from `state` (mirrors the RPC role map). */
function roleForTransition(state, toState) {
  if (toState === 'accepted' || toState === 'cancelled' || toState === 'disputed') return 'buyer';
  if (toState === 'authority_validated') return 'authority';
  if (toState === 'executing' || toState === 'in_flight' || toState === 'evidence_pending' || toState === 'evidence_submitted') return 'provider';
  if (toState === 'verifying' || toState === 'fulfilled') return 'evaluator';
  if (state === 'disputed' && ['executing', 'recovering', 'fulfilled', 'failed', 'settled'].includes(toState)) return 'evaluator';
  if (['expired', 'failed', 'recovering', 'settled', 'finalized'].includes(toState)) return 'system';
  if (state === 'recovering' && ['executing', 'evidence_pending'].includes(toState)) return 'provider';
  if (state === 'recovering' && toState === 'fulfilled') return 'evaluator';
  return null;
}

/** Map an MCP-visible action to its canonical lifecycle transition. */
function actionToTransition(action, state) {
  const a = String(action || '').toLowerCase();
  switch (a) {
    case 'cancel': return 'cancelled';
    case 'accept': return 'accepted';
    case 'authorize': return 'authority_validated';
    case 'execute': return 'executing';
    case 'complete': return 'evidence_pending';
    case 'submit': return 'evidence_submitted';
    case 'verify': return 'verifying';
    case 'fulfill': return 'fulfilled';
    case 'settle': return 'settled';
    case 'finalize': return 'finalized';
    case 'dispute': return 'disputed';
    case 'recover': return 'recovering';
    case 'fail': return 'failed';
    case 'expire': return 'expired';
    default: return null;
  }
}

/** Action label for a transition (reverse map). */
function transitionToAction(toState) {
  const map = {
    cancelled: 'cancel', accepted: 'accept', authority_validated: 'authorize',
    executing: 'execute', evidence_pending: 'complete', evidence_submitted: 'submit',
    verifying: 'verify', fulfilled: 'fulfill', settled: 'settle', finalized: 'finalize',
    disputed: 'dispute', recovering: 'recover', failed: 'fail', expired: 'expire',
  };
  return map[toState] || toState;
}

/**
 * Build the recovery status for a commitment + caller.
 * Reconciles the authoritative row and returns the caller's pending actions.
 */
async function buildRecoveryStatus(commitmentRow, agentId, principal, role) {
  const state = commitmentRow.state;
  const reachable = allowedTransitions(state);
  const authz = await loadAuthorization(agentId, principal, commitmentRow.commitment_id, role);
  const active = authzActive(authz);
  const inScope = (action) => {
    if (!active) return false;
    const actions = authz.scope && Array.isArray(authz.scope.actions) ? authz.scope.actions : [];
    if (actions.length === 0) return true; // unrestricted role scope
    return actions.includes(action);
  };
  const pending = reachable
    .map((to) => ({ toState: to, action: transitionToAction(to), requiredRole: roleForTransition(commitmentRow.state, to) }))
    .filter((t) => t.requiredRole === role && inScope(t.action));
  return {
    commitmentId: commitmentRow.commitment_id,
    state,
    version: commitmentRow.version || 1,
    caller: { agentId, principal, role, authorized: active, revoked: !!(authz && authz.revoked_at), expiresAt: authz ? authz.valid_until : null },
    recoverable: state === 'recovering' || state === 'in_flight' || state === 'executing' || state === 'evidence_pending' || state === 'verifying',
    pendingActions: pending,
  };
}

module.exports = {
  isConfigured,
  client,
  verifyPrincipal,
  loadCommitment,
  readHistory,
  loadAuthorization,
  authzActive,
  allowedTransitions,
  roleForTransition,
  actionToTransition,
  transitionToAction,
  buildRecoveryStatus,
  commitmentContext,
};
