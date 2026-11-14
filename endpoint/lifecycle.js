// SAAX Protocol — MCP Lifecycle Phase 1: transitionCommitment client (CJS).
//
// App-layer wrapper around the ax_router.transition_commitment RPC (v2),
// plus grant_agent_authorization / revoke_agent_authorization.
//
// FAIL-CLOSED: any RPC error is surfaced as an explicit { ok:false, error }
// with a ST_*/AUTH_*/IDEM_* code when the database returned one, else a
// retryable transport/persistence error. The caller MUST NOT treat a failed
// transition as succeeded, and MUST NOT retry blindly: the RPC is idempotent
// via idempotency_ref, so a safe retry reuses the SAME ref.
//
// AUTHORITY MODEL (v2): transitionCommitment requires `verifiedPrincipal` —
// an independently verified principal identifier (e.g. an EIP-712 recovered
// signer address produced by endpoint/authority.js) THAT THE CALLER HAS
// PROVEN. The RPC will reject any transition where the durable
// agent_authorizations row for (agent_id, commitment, role) does not bind
// that principal. Supplying another agent's agent_id is therefore never
// sufficient: the principal must match the registry, and the application
// layer must have cryptographically verified that principal before calling.
'use strict';

const storeModule = require('./store.js');

function isConfigured() {
  return !!(process.env.POSTGREST_URL || process.env.SAAX_POSTGREST_URL || process.env.SUPABASE_URL);
}

function canonicalFingerprint(args) {
  // Mirror of the RPC's plpgsql fingerprint (v2). Excludes expectedVersion
  // and idempotencyRef; every other security-relevant field is bound.
  const crypto = require('crypto');
  const parts = [
    args.commitmentId || '',
    args.fromState || '',
    args.toState || '',
    args.requestedAction || '',
    args.verifiedPrincipal || '',
    args.agentId || '',
    args.actorRole || '',
    args.authorityRef || '',
    args.evidenceRef || '',
  ];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

/**
 * Execute an authorized commitment transition (v2 RPC).
 *
 * @param {object} args
 * @param {string} args.commitmentId
 * @param {string} args.fromState        expected current state (informational; RPC re-checks)
 * @param {string} args.toState
 * @param {string} args.requestedAction
 * @param {string} args.agentId          durable agent identifier
 * @param {string} args.verifiedPrincipal INDEPENDENTLY VERIFIED principal (required)
 * @param {'buyer'|'provider'|'evaluator'|'authority'|'system'} args.actorRole
 * @param {string} [args.authorityRef]
 * @param {string} [args.idempotencyRef] required for retry-safety; generated if omitted
 * @param {string} [args.evidenceRef]
 * @param {number} [args.expectedVersion] optimistic-concurrency guard
 * @returns {Promise<{ok:boolean, data?:object, error?:string, code?:string, retryable?:boolean}>}
 */
async function transitionCommitment(args) {
  if (!args || !args.commitmentId || !args.toState) {
    return { ok: false, code: 'AUTH_BAD_REQUEST', error: 'commitmentId and toState are required' };
  }
  if (!args.verifiedPrincipal || typeof args.verifiedPrincipal !== 'string' || !args.verifiedPrincipal.trim()) {
    return { ok: false, code: 'AUTH_PRINCIPAL_REQUIRED',
      error: 'verifiedPrincipal is required — the caller must prove its identity before a transition' };
  }
  if (!isConfigured()) {
    return { ok: false, code: 'STORE_UNAVAILABLE', retryable: true,
      error: 'commitment transition unavailable: storage not configured' };
  }
  const idem = args.idempotencyRef ||
    ('lc:' + args.commitmentId + ':' + args.fromState + '->' + args.toState + ':' +
     (args.verifiedPrincipal || 'anon') + ':' + Date.now());

  let client;
  try {
    client = (storeModule.buildStoreClient && storeModule.buildStoreClient()) || storeModule.buildSupabaseClient();
  } catch (e) {
    return { ok: false, code: 'STORE_UNAVAILABLE', retryable: true,
      error: 'commitment transition unavailable: ' + safeMsg(e) };
  }

  try {
    const { data, error } = await client.rpc('transition_commitment', {
      p_commitment_id: args.commitmentId,
      p_from_state: args.fromState,
      p_to_state: args.toState,
      p_requested_action: args.requestedAction,
      p_agent_id: args.agentId,
      p_verified_principal: args.verifiedPrincipal,
      p_actor_role: args.actorRole,
      p_authority_ref: args.authorityRef || null,
      p_idempotency_ref: idem,
      p_evidence_ref: args.evidenceRef || null,
      p_expected_version: args.expectedVersion ?? null,
    });

    if (error) {
      const code = extractCode(error.message);
      return {
        ok: false,
        code: code || 'TRANSITION_FAILED',
        retryable: code === null && looksTransport(error.message),
        error: sanitize(error.message),
      };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, code: 'TRANSITION_FAILED', retryable: true,
        error: 'transition_commitment returned no result body' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, code: 'TRANSITION_FAILED', retryable: true,
      error: 'commitment transition failed: ' + safeMsg(e) };
  }
}

/**
 * Grant (or refresh) a durable agent authorization (v2 RPC).
 * Only the authorizer's OWN identity may be granted unless the authorizer
 * holds role 'authority' for the same commitment. Service/system-scope
 * grants are rejected (AUTH_SYSTEM_GRANT_DENIED).
 */
async function grantAgentAuthorization(args) {
  if (!args || !args.authorizerAgent || !args.authorizerPrincipal || !args.subjectAgent || !args.subjectPrincipal || !args.role) {
    return { ok: false, code: 'AUTH_BAD_REQUEST',
      error: 'authorizerAgent, authorizerPrincipal, subjectAgent, subjectPrincipal, role are required' };
  }
  if (!isConfigured()) {
    return { ok: false, code: 'STORE_UNAVAILABLE', retryable: true,
      error: 'grant unavailable: storage not configured' };
  }
  let client;
  try {
    client = (storeModule.buildStoreClient && storeModule.buildStoreClient()) || storeModule.buildSupabaseClient();
  } catch (e) {
    return { ok: false, code: 'STORE_UNAVAILABLE', retryable: true, error: safeMsg(e) };
  }
  try {
    const { data, error } = await client.rpc('grant_agent_authorization', {
      p_authorizer_agent: args.authorizerAgent,
      p_authorizer_principal: args.authorizerPrincipal,
      p_authorizer_role: args.authorizerRole || 'authority',
      p_subject_agent: args.subjectAgent,
      p_subject_principal: args.subjectPrincipal,
      p_commitment_id: args.commitmentId || null,
      p_role: args.role,
      p_scope: args.scope || {},
      p_valid_from: args.validFrom || null,
      p_valid_until: args.validUntil || null,
      p_idempotency_ref: args.idempotencyRef || null,
      p_delegation_ref: args.delegationRef || null,
    });
    if (error) {
      const code = extractCode(error.message);
      return { ok: false, code: code || 'GRANT_FAILED',
        retryable: code === null && looksTransport(error.message), error: sanitize(error.message) };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, code: 'GRANT_FAILED', retryable: true, error: safeMsg(e) };
  }
}

/**
 * Revoke an agent authorization (v2 RPC).
 * Self-revoke allowed (caller is the grantee); otherwise the caller must
 * hold active 'authority' or 'system' authorization for the same commitment
 * (or system scope). Idempotent: a second revoke of an already-revoked row
 * returns already_revoked/replayed and never writes a second event.
 */
async function revokeAgentAuthorization(args) {
  if (!args || !args.authorizerAgent || !args.authorizerPrincipal || !args.authzId) {
    return { ok: false, code: 'AUTH_BAD_REQUEST',
      error: 'authorizerAgent, authorizerPrincipal, authzId are required' };
  }
  if (!isConfigured()) {
    return { ok: false, code: 'STORE_UNAVAILABLE', retryable: true,
      error: 'revoke unavailable: storage not configured' };
  }
  let client;
  try {
    client = (storeModule.buildStoreClient && storeModule.buildStoreClient()) || storeModule.buildSupabaseClient();
  } catch (e) {
    return { ok: false, code: 'STORE_UNAVAILABLE', retryable: true, error: safeMsg(e) };
  }
  try {
    const { data, error } = await client.rpc('revoke_agent_authorization', {
      p_authorizer_agent: args.authorizerAgent,
      p_authorizer_principal: args.authorizerPrincipal,
      p_authorizer_role: args.authorizerRole || 'authority',
      p_authz_id: args.authzId,
      p_reason: args.reason || 'revoked',
      p_idempotency_ref: args.idempotencyRef || null,
    });
    if (error) {
      const code = extractCode(error.message);
      return { ok: false, code: code || 'REVOKE_FAILED',
        retryable: code === null && looksTransport(error.message), error: sanitize(error.message) };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, code: 'REVOKE_FAILED', retryable: true, error: safeMsg(e) };
  }
}

/** Extract a canonical ST_xxx / AUTH_xxx / IDEM_xxx code from the RPC error. */
function extractCode(message) {
  if (!message) return null;
  const m = String(message).match(/\b(ST_[A-Z_]+|AUTH_[A-Z_]+|IDEM_[A-Z_]+)\b/);
  return m ? m[1] : null;
}

/** A transport/persistence failure (not a domain rejection) is retryable-safe. */
function looksTransport(message) {
  return /fetch failed|ECONNREFUSED|timeout|network|unavailable|socket|Broken pipe/i.test(String(message || ''));
}

/** Never leak full error strings (may contain URLs/keys) — truncate + strip. */
function sanitize(message) {
  return String(message || 'transition failed').replace(/https?:\/\/[^\s]+/g, '[url-redacted]').slice(0, 300);
}

function safeMsg(e) {
  return e && e.message ? sanitize(e.message) : 'unknown error';
}

module.exports = {
  transitionCommitment,
  grantAgentAuthorization,
  revokeAgentAuthorization,
  canonicalFingerprint,
  extractCode,
};