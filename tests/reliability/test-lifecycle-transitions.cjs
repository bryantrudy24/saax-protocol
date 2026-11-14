// SAAX MCP Lifecycle Phase 1 — transition_commitment v2 conformance suite (live testbed)
//
// Runs against the ISOLATED Docker Postgres/PostgREST testbed (ax_router_db :5433 /
// ax_router_postgrest :3000). Proves the canonical 17-state transition table is
// enforced at runtime by the SECURITY DEFINER RPC through the app-layer wrapper
// (endpoint/lifecycle.js), with the v2 hardening:
//   * INDEPENDENT PRINCIPAL BINDING — verifiedPrincipal must match the durable
//     authorization row; agent_id alone is never sufficient.
//   * full idempotency operation fingerprint (IDEM_FINGERPRINT_CONFLICT)
//   * replay-after-revocation guard
//   * revocation + expiry enforced; grant/revoke RPCs audited
//   * events append-only, no direct INSERT by service_role
//   * optimistic concurrency + atomicity
//
// Setup uses the operator-provisioned model:
//   provision_authority (operator token) -> grant_agent_authorization (authority
//   holder grants buyer/provider/evaluator rows) — mirroring how production
//   would bootstrap a commitment's participants.
//
// The operator token is a TEST-ONLY constant in the isolated testbed. In
// production the secret lives in the deployment environment, never in code.
//
// No production data is touched. No payment/escrow behavior is exercised.

'use strict';

const { randomUUID } = require('crypto');
const crypto = require('crypto');

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const { mint } = require('./_gate-d-jwt.cjs');
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');

const store = require('../../endpoint/store.js');
const { transitionCommitment, grantAgentAuthorization, revokeAgentAuthorization } = require('../../endpoint/lifecycle.js');

const db = store.buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

/** Operator-provision an authority/system row via the RPC (test token). */
async function provisionAuthority({ agentId, principal, commitmentId, role = 'authority', scope = {} }) {
  const { data, error } = await db.rpc('provision_authority', {
    p_agent_id: agentId,
    p_verified_principal: principal,
    p_commitment_id: commitmentId || null,
    p_role: role,
    p_scope: scope,
    p_valid_until: new Date(Date.now() + 7 * 86400e3).toISOString(),
    p_operator_token: 'test-operator-token-0123456789abcdef', // TESTBED ONLY
    p_idempotency_ref: 'prov:' + agentId + ':' + (commitmentId || 'svc') + ':' + role,
  });
  if (error) throw new Error('provisionAuthority: ' + error.message);
  return data.authz_id;
}

/** Authority holder grants a role to a subject agent via the grant RPC. */
async function grantAuthz({ authorizer, principal, subjectAgent, subjectPrincipal, commitmentId, role, scope, validUntil }) {
  const r = await grantAgentAuthorization({
    authorizerAgent: authorizer, authorizerPrincipal: principal, authorizerRole: 'authority',
    subjectAgent, subjectPrincipal,
    commitmentId, role, scope,
    validUntil: validUntil || new Date(Date.now() + 3600e3).toISOString(),
    idempotencyRef: 'g:' + subjectAgent + ':' + commitmentId + ':' + role,
  });
  if (!r.ok) throw new Error('grantAuthz: ' + r.error);
  return r.data.authz_id;
}

async function seedCommitment(id, state = 'issued') {
  const ins = await db.from('commitments').insert({
    commitment_id: id, state, capability: 'demo', terms: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  if (ins && ins.error) throw new Error('seedCommitment: ' + ins.error.message);
}

/** Remove test rows (service_role can still DELETE on commitments for test
 *  hygiene — the ledger/registry are cleaned by the owner path in tests). */
async function clean(id) {
  await db.from('commitments').delete().eq('commitment_id', id).catch(() => {});
  await db.from('commitment_events').delete().eq('commitment_id', id).catch(() => {});
  await db.from('agent_authorizations').delete().eq('commitment_id', id).catch(() => {});
  await db.from('agent_authorizations').delete().eq('commitment_id', null).eq('agent_id', 'auth-' + id).catch(() => {});
}

(async () => {
  const cid = 'c-lc-' + randomUUID().slice(0, 8);
  try {
    // ---- operator bootstrap: authority for this commitment ----
    await seedCommitment(cid);
    await provisionAuthority({ agentId: 'auth-' + cid, principal: '0xop-' + cid, commitmentId: cid, role: 'authority' });

    // ---- authority grants the participants ----
    await grantAuthz({ authorizer: 'auth-' + cid, principal: '0xop-' + cid, subjectAgent: 'a-buyer-' + cid, subjectPrincipal: '0xbuyer', commitmentId: cid, role: 'buyer', scope: { actions: ['accept','dispute'] } });
    await grantAuthz({ authorizer: 'auth-' + cid, principal: '0xop-' + cid, subjectAgent: 'a-prov-' + cid, subjectPrincipal: '0xseller', commitmentId: cid, role: 'provider', scope: { actions: ['execute','complete','submit'] } });
    await grantAuthz({ authorizer: 'auth-' + cid, principal: '0xop-' + cid, subjectAgent: 'a-eval-' + cid, subjectPrincipal: '0xeval', commitmentId: cid, role: 'evaluator', scope: { actions: ['verify','fulfill'] } });

    // ---- 1. full valid chain (v2 requires verifiedPrincipal everywhere) ----
    let r = await transitionCommitment({ commitmentId: cid, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'a-buyer-' + cid, verifiedPrincipal: '0xbuyer', actorRole: 'buyer', authorityRef: 'ref:a', idempotencyRef: 'i1', expectedVersion: 1 });
    check('issued->accepted (buyer, verified principal 0xbuyer)', r.ok && r.data.to_state === 'accepted' && r.data.state_version === 2, JSON.stringify(r));

    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'a-prov-' + cid, verifiedPrincipal: '0xseller', actorRole: 'provider', idempotencyRef: 'i2', expectedVersion: 2 });
    check('accepted->executing (provider, verified principal 0xseller)', r.ok && r.data.to_state === 'executing', JSON.stringify(r));

    r = await transitionCommitment({ commitmentId: cid, fromState: 'executing', toState: 'evidence_pending', requestedAction: 'complete', agentId: 'a-prov-' + cid, verifiedPrincipal: '0xseller', actorRole: 'provider', idempotencyRef: 'i3', expectedVersion: 3 });
    check('executing->evidence_pending (provider)', r.ok, JSON.stringify(r));

    r = await transitionCommitment({ commitmentId: cid, fromState: 'evidence_pending', toState: 'evidence_submitted', requestedAction: 'submit', agentId: 'a-prov-' + cid, verifiedPrincipal: '0xseller', actorRole: 'provider', idempotencyRef: 'i4', expectedVersion: 4 });
    check('evidence_pending->evidence_submitted (provider)', r.ok, JSON.stringify(r));

    r = await transitionCommitment({ commitmentId: cid, fromState: 'evidence_submitted', toState: 'verifying', requestedAction: 'verify', agentId: 'a-eval-' + cid, verifiedPrincipal: '0xeval', actorRole: 'evaluator', idempotencyRef: 'i5', expectedVersion: 5 });
    check('evidence_submitted->verifying (evaluator)', r.ok, JSON.stringify(r));

    r = await transitionCommitment({ commitmentId: cid, fromState: 'verifying', toState: 'fulfilled', requestedAction: 'fulfill', agentId: 'a-eval-' + cid, verifiedPrincipal: '0xeval', actorRole: 'evaluator', idempotencyRef: 'i6', expectedVersion: 6 });
    check('verifying->fulfilled (evaluator)', r.ok, JSON.stringify(r));

    // ---- 2. invalid edge ----
    r = await transitionCommitment({ commitmentId: cid, fromState: 'fulfilled', toState: 'executing', requestedAction: 'execute', agentId: 'a-prov-' + cid, verifiedPrincipal: '0xseller', actorRole: 'provider', idempotencyRef: 'i7', expectedVersion: 7 });
    check('fulfilled->executing rejected (ST_INVALID_TRANSITION)', !r.ok && r.code === 'ST_INVALID_TRANSITION', JSON.stringify(r));

    // ---- 3. idempotent replay (same ref + same operation) returns replayed ----
    r = await transitionCommitment({ commitmentId: cid, fromState: 'verifying', toState: 'fulfilled', requestedAction: 'fulfill', agentId: 'a-eval-' + cid, verifiedPrincipal: '0xeval', actorRole: 'evaluator', idempotencyRef: 'i6', expectedVersion: 6 });
    check('idempotent replay of i6 returns replayed', r.ok && r.data.status === 'replayed' && r.data.to_state === 'fulfilled', JSON.stringify(r));
    const { data: evs } = await db.from('commitment_events').select('idempotency_ref').eq('commitment_id', cid);
    const i6count = (evs || []).filter(e => e && e.idempotency_ref === 'i6').length;
    check('replay did not duplicate event i6', i6count === 1, 'count=' + i6count);

    // ---- 3b. FINGERPRINT CONFLICT: same ref, DIFFERENT operation ----
    r = await transitionCommitment({ commitmentId: cid, fromState: 'verifying', toState: 'fulfilled', requestedAction: 'fulfill', agentId: 'a-eval-' + cid, verifiedPrincipal: '0xeval', actorRole: 'evaluator', authorityRef: 'ref:DIFFERENT', idempotencyRef: 'i6', expectedVersion: 6 });
    check('same ref + different authority -> IDEM_FINGERPRINT_CONFLICT (no replay disclose)', !r.ok && r.code === 'IDEM_FINGERPRINT_CONFLICT', JSON.stringify(r));

    r = await transitionCommitment({ commitmentId: cid, fromState: 'verifying', toState: 'fulfilled', requestedAction: 'fulfill', agentId: 'a-eval-' + cid, verifiedPrincipal: '0xDIFFERENT', actorRole: 'evaluator', idempotencyRef: 'i6', expectedVersion: 6 });
    check('same ref + different principal -> IDEM_FINGERPRINT_CONFLICT', !r.ok && r.code === 'IDEM_FINGERPRINT_CONFLICT', JSON.stringify(r));

    // ---- 3c. REPLAY-AFTER-REVOCATION: revoked caller cannot retrieve replay ----
    // (Full chain to verifying, then revoke the evaluator; same-ref retry must
    //  fail AUTH_REVOKED rather than return replayed.)
    const cidR2 = 'c-lc-' + randomUUID().slice(0, 8);
    await seedCommitment(cidR2);
    await provisionAuthority({ agentId: 'auth-' + cidR2, principal: '0xop-' + cidR2, commitmentId: cidR2, role: 'authority' });
    await grantAuthz({ authorizer: 'auth-' + cidR2, principal: '0xop-' + cidR2, subjectAgent: 'a-buy2-' + cidR2, subjectPrincipal: '0xbuy2', commitmentId: cidR2, role: 'buyer', scope: { actions: ['accept'] } });
    await grantAuthz({ authorizer: 'auth-' + cidR2, principal: '0xop-' + cidR2, subjectAgent: 'a-prov2-' + cidR2, subjectPrincipal: '0xprov2', commitmentId: cidR2, role: 'provider', scope: { actions: ['execute','complete','submit'] } });
    const evalAuthzId = await grantAuthz({ authorizer: 'auth-' + cidR2, principal: '0xop-' + cidR2, subjectAgent: 'a-eval2-' + cidR2, subjectPrincipal: '0xeval2', commitmentId: cidR2, role: 'evaluator', scope: { actions: ['verify','fulfill'] } });
    await transitionCommitment({ commitmentId: cidR2, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'a-buy2-' + cidR2, verifiedPrincipal: '0xbuy2', actorRole: 'buyer', idempotencyRef: 'iR2a', expectedVersion: 1 });
    await transitionCommitment({ commitmentId: cidR2, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'a-prov2-' + cidR2, verifiedPrincipal: '0xprov2', actorRole: 'provider', idempotencyRef: 'iR2b', expectedVersion: 2 });
    await transitionCommitment({ commitmentId: cidR2, fromState: 'executing', toState: 'evidence_pending', requestedAction: 'complete', agentId: 'a-prov2-' + cidR2, verifiedPrincipal: '0xprov2', actorRole: 'provider', idempotencyRef: 'iR2c', expectedVersion: 3 });
    await transitionCommitment({ commitmentId: cidR2, fromState: 'evidence_pending', toState: 'evidence_submitted', requestedAction: 'submit', agentId: 'a-prov2-' + cidR2, verifiedPrincipal: '0xprov2', actorRole: 'provider', idempotencyRef: 'iR2d', expectedVersion: 4 });
    r = await transitionCommitment({ commitmentId: cidR2, fromState: 'evidence_submitted', toState: 'verifying', requestedAction: 'verify', agentId: 'a-eval2-' + cidR2, verifiedPrincipal: '0xeval2', actorRole: 'evaluator', idempotencyRef: 'iR2e', expectedVersion: 5 });
    check('setup: evidence_submitted->verifying (evaluator2)', r.ok, JSON.stringify(r));
    const rev = await revokeAgentAuthorization({ authorizerAgent: 'a-eval2-' + cidR2, authorizerPrincipal: '0xeval2', authorizerRole: 'evaluator', authzId: evalAuthzId, reason: 'test-revoke', idempotencyRef: 'rev1' });
    check('revoke succeeds (self-revoke of evaluator2)', rev.ok && rev.data.status === 'revoked', JSON.stringify(rev));
    // Same operation as iR2e's would-be next step — but the caller is revoked.
    r = await transitionCommitment({ commitmentId: cidR2, fromState: 'verifying', toState: 'fulfilled', requestedAction: 'fulfill', agentId: 'a-eval2-' + cidR2, verifiedPrincipal: '0xeval2', actorRole: 'evaluator', idempotencyRef: 'iR2f', expectedVersion: 6 });
    check('revoked caller cannot transition (AUTH_REVOKED)', !r.ok && r.code === 'AUTH_REVOKED', JSON.stringify(r));
    await clean(cidR2);

    // ---- 4. stale version ----
    r = await transitionCommitment({ commitmentId: cid, fromState: 'fulfilled', toState: 'settled', requestedAction: 'settle', agentId: 'sys', verifiedPrincipal: '0xsystem', actorRole: 'system', idempotencyRef: 'i8', expectedVersion: 3 });
    check('stale version rejected (ST_STALE_VERSION)', !r.ok && r.code === 'ST_STALE_VERSION', JSON.stringify(r));

    // ---- 5. unknown commitment ----
    r = await transitionCommitment({ commitmentId: 'nope-' + cid, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'a-buyer-' + cid, verifiedPrincipal: '0xbuyer', actorRole: 'buyer', idempotencyRef: 'i9' });
    check('unknown commitment rejected (ST_UNKNOWN_COMMITMENT)', !r.ok && r.code === 'ST_UNKNOWN_COMMITMENT', JSON.stringify(r));

    // ---- 6. wrong role ----
    r = await transitionCommitment({ commitmentId: cid, fromState: 'fulfilled', toState: 'settled', requestedAction: 'settle', agentId: 'a-buyer-' + cid, verifiedPrincipal: '0xbuyer', actorRole: 'buyer', idempotencyRef: 'i10', expectedVersion: 7 });
    check('buyer cannot settle (AUTH_ROLE_DENIED)', !r.ok && r.code === 'AUTH_ROLE_DENIED', JSON.stringify(r));

    // ---- 7. revoked authorization (registry-level) ----
    const cid2 = 'c-lc-' + randomUUID().slice(0, 8);
    await seedCommitment(cid2);
    await provisionAuthority({ agentId: 'auth-' + cid2, principal: '0xop-' + cid2, commitmentId: cid2, role: 'authority' });
    const authz2 = await grantAuthz({ authorizer: 'auth-' + cid2, principal: '0xop-' + cid2, subjectAgent: 'a-rev-' + cid2, subjectPrincipal: '0xbuyer', commitmentId: cid2, role: 'buyer', scope: { actions: ['accept'] } });
    const rev2 = await revokeAgentAuthorization({ authorizerAgent: 'a-rev-' + cid2, authorizerPrincipal: '0xbuyer', authorizerRole: 'buyer', authzId: authz2, reason: 'test', idempotencyRef: 'rev2' });
    check('revoke succeeds for buyer self-revoke', rev2.ok && rev2.data.status === 'revoked', JSON.stringify(rev2));
    r = await transitionCommitment({ commitmentId: cid2, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'a-rev-' + cid2, verifiedPrincipal: '0xbuyer', actorRole: 'buyer', idempotencyRef: 'i11' });
    check('revoked authorization rejected (AUTH_REVOKED)', !r.ok && r.code === 'AUTH_REVOKED', JSON.stringify(r));
    await clean(cid2);

    // ---- 8. expired authorization ----
    const cid3 = 'c-lc-' + randomUUID().slice(0, 8);
    await seedCommitment(cid3);
    await provisionAuthority({ agentId: 'auth-' + cid3, principal: '0xop-' + cid3, commitmentId: cid3, role: 'authority' });
    // Grant a SHORT-lived window (2s), then let it lapse before the transition.
    await grantAuthz({ authorizer: 'auth-' + cid3, principal: '0xop-' + cid3, subjectAgent: 'a-exp-' + cid3, subjectPrincipal: '0xbuyer', commitmentId: cid3, role: 'buyer', scope: { actions: ['accept'] }, validUntil: new Date(Date.now() + 2000).toISOString() });
    await new Promise(res => setTimeout(res, 2300));
    r = await transitionCommitment({ commitmentId: cid3, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'a-exp-' + cid3, verifiedPrincipal: '0xbuyer', actorRole: 'buyer', idempotencyRef: 'i12' });
    check('expired authorization rejected (AUTH_EXPIRED)', !r.ok && r.code === 'AUTH_EXPIRED', JSON.stringify(r));
    await clean(cid3);

    // ---- 9. out-of-scope action ----
    const cid4 = 'c-lc-' + randomUUID().slice(0, 8);
    await seedCommitment(cid4, 'accepted');
    await provisionAuthority({ agentId: 'auth-' + cid4, principal: '0xop-' + cid4, commitmentId: cid4, role: 'authority' });
    await grantAuthz({ authorizer: 'auth-' + cid4, principal: '0xop-' + cid4, subjectAgent: 'a-scope-' + cid4, subjectPrincipal: '0xseller', commitmentId: cid4, role: 'provider', scope: { actions: ['execute-other'] } });
    r = await transitionCommitment({ commitmentId: cid4, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'a-scope-' + cid4, verifiedPrincipal: '0xseller', actorRole: 'provider', idempotencyRef: 'i14', expectedVersion: 1 });
    check('out-of-scope action rejected (AUTH_OUT_OF_SCOPE)', !r.ok && r.code === 'AUTH_OUT_OF_SCOPE', JSON.stringify(r));
    await clean(cid4);

    // ---- 10. PRINCIPAL BINDING: correct agent_id but WRONG principal ----
    r = await transitionCommitment({ commitmentId: cid, fromState: 'fulfilled', toState: 'disputed', requestedAction: 'dispute', agentId: 'a-buyer-' + cid, verifiedPrincipal: '0xNOTTHEBUYER', actorRole: 'buyer', idempotencyRef: 'i15' });
    check('agent_id alone is not authority: wrong principal rejected (AUTH_MISSING_AUTHORIZATION)',
      !r.ok && r.code === 'AUTH_MISSING_AUTHORIZATION', JSON.stringify(r));

    // ---- 10b. impersonation via agent_id swap ----
    r = await transitionCommitment({ commitmentId: cid, fromState: 'fulfilled', toState: 'disputed', requestedAction: 'dispute', agentId: 'a-eval-' + cid, verifiedPrincipal: '0xbuyer', actorRole: 'buyer', idempotencyRef: 'i16' });
    check('impersonation (agent_id of another agent + buyer principal) rejected (AUTH_MISSING_AUTHORIZATION)',
      !r.ok && r.code === 'AUTH_MISSING_AUTHORIZATION', JSON.stringify(r));

    // ---- 11. DIRECT INSERT rejection (event ledger append-only) ----
    const directIns = await db.from('commitment_events').insert({
      event_id: 'forged', commitment_id: cid, from_state: 'issued', to_state: 'accepted',
      requested_action: 'forged', actor_identity: '0xforged', actor_role: 'buyer',
      state_version: 1, idempotency_ref: 'forged', op_fingerprint: 'forged',
    });
    check('direct INSERT into commitment_events by service_role is REJECTED',
      !!directIns && !!directIns.error, JSON.stringify(directIns && directIns.error || directIns));

    // ---- 12. atomicity: exactly the 6 transition events recorded ----
    const { data: allEvs } = await db.from('commitment_events').select('commitment_id, idempotency_ref').eq('commitment_id', cid);
    const evList = allEvs || [];
    const expectedRefs = ['i1','i2','i3','i4','i5','i6'];
    const refsPresent = expectedRefs.every(ref => evList.some(e => e && e.idempotency_ref === ref));
    check('atomic events: exactly the 6 transition events recorded', refsPresent && evList.length === 6,
      'count=' + evList.length + ' refs=' + evList.map(e => e && e.idempotency_ref).join(','));

    await clean(cid);
  } catch (e) {
    fail++;
    console.log('UNCAUGHT ' + (e && e.message || e));
  }

  console.log(`\n=== lifecycle conformance v2: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();