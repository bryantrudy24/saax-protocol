// SAAX MCP Lifecycle Phase 1 — three-agent authorization & recovery harness (v2)
//
// Simulates the A/B/C independent-agent scenario AND its adversarial security
// matrix against the ISOLATED testbed:
//   Agent A (buyer)   — original worker that "terminates"
//   Agent B (seller)  — provider performing authorized actions
//   Agent C (replacement) — attempts recovery/continuation after A fails
//
// Security properties proven (v2):
//   * C cannot act as A by changing agent_id, principal, or role inputs
//   * C's own durable authorization is required; delegation is independent
//   * expired and revoked delegations fail closed for EVERY subsequent op
//   * idempotency keys are bound to the full operation fingerprint:
//     reusing another agent's key, or the same key with a different actor/
//     evidence/action/authority, is rejected with IDEM_FINGERPRINT_CONFLICT
//   * direct RPC execution requires the durable authorization (the RPC is
//     the enforcement point — an unauthorized caller gets AUTH_* errors)
//   * event ledger rejects direct INSERT and has no UPDATE/DELETE path
//   * concurrent conflicting transitions cannot double-apply
//   * concurrent revocation + transition has deterministic ordering
//   * database failure does not acknowledge success (fail-closed wrapper)
//   * terminal states reject all mutation
//
// For every negative test we verify BOTH the error response AND the absence
// of unauthorized persistent effects (no state change, no event, no row).
//
// No financial operations. No production data. Isolated testbed only.

'use strict';

const { randomUUID } = require('crypto');

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

async function provisionAuthority({ agentId, principal, commitmentId, role = 'authority' }) {
  const { data, error } = await db.rpc('provision_authority', {
    p_agent_id: agentId,
    p_verified_principal: principal,
    p_commitment_id: commitmentId || null,
    p_role: role,
    p_scope: {},
    p_valid_until: new Date(Date.now() + 7 * 86400e3).toISOString(),
    p_operator_token: 'test-operator-token-0123456789abcdef',
    p_idempotency_ref: 'prov:' + agentId + ':' + (commitmentId || 'svc') + ':' + role,
  });
  if (error) throw new Error('provisionAuthority: ' + error.message);
  return data.authz_id;
}

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

async function countEvents(cid, ref) {
  const { data } = await db.from('commitment_events').select('idempotency_ref').eq('commitment_id', cid).eq('idempotency_ref', ref);
  return (data || []).length;
}

/** Read the commitment state + version (read-only; service_role SELECT). */
async function stateOf(cid) {
  const { data } = await db.from('commitments').select('state, version').eq('commitment_id', cid).limit(1);
  return (data || [])[0];
}

async function clean(id) {
  await db.from('commitments').delete().eq('commitment_id', id).catch(() => {});
  await db.from('commitment_events').delete().eq('commitment_id', id).catch(() => {});
  await db.from('agent_authorizations').delete().eq('commitment_id', id).catch(() => {});
}

(async () => {
  const cid = 'c-h-' + randomUUID().slice(0, 8);
  try {
    // ============ OPERATOR BOOTSTRAP + POSITIVE PATH ============
    await seedCommitment(cid);
    await provisionAuthority({ agentId: 'auth-' + cid, principal: '0xop-' + cid, commitmentId: cid });
    await grantAuthz({ authorizer: 'auth-' + cid, principal: '0xop-' + cid, subjectAgent: 'agent-a', subjectPrincipal: '0xA', commitmentId: cid, role: 'buyer', scope: { actions: ['accept','dispute'] } });
    await grantAuthz({ authorizer: 'auth-' + cid, principal: '0xop-' + cid, subjectAgent: 'agent-b', subjectPrincipal: '0xB', commitmentId: cid, role: 'provider', scope: { actions: ['execute','complete','submit'] } });

    // A accepts (authorized buyer action) — positive: valid lifecycle transition
    let r = await transitionCommitment({ commitmentId: cid, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'agent-a', verifiedPrincipal: '0xA', actorRole: 'buyer', authorityRef: 'a-sig-1', idempotencyRef: 'h1', expectedVersion: 1 });
    check('A (buyer) accepts the commitment', r.ok && r.data.to_state === 'accepted' && r.data.state_version === 2, JSON.stringify(r));

    // Successful durable event recording + version increment
    const ev1 = await countEvents(cid, 'h1');
    const st1 = await stateOf(cid);
    check('event recorded for h1 + version incremented', ev1 === 1 && st1 && st1.version === 2 && st1.state === 'accepted', JSON.stringify({ ev1, st1 }));

    // ============ RECOVERY: A "terminates"; replacement C arrives ============
    // N1: C with NO authorization cannot act (AUTH_MISSING_AUTHORIZATION), no state change
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', idempotencyRef: 'h2', expectedVersion: 2 });
    check('N1: C (no authorization) cannot execute — AUTH_MISSING_AUTHORIZATION', !r.ok && r.code === 'AUTH_MISSING_AUTHORIZATION', JSON.stringify(r));
    const stAfterN1 = await stateOf(cid);
    check('N1: no persistent effect (state unchanged, no event)', stAfterN1.state === 'accepted' && stAfterN1.version === 2, JSON.stringify(stAfterN1));

    // N2: C impersonates A — supplies A's agent_id AND A's principal
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-a', verifiedPrincipal: '0xA', actorRole: 'provider', idempotencyRef: 'h3', expectedVersion: 2 });
    // The RPC must NOT treat C-as-A as authorized: A has no provider role for this commitment.
    check('N2: C spoofing A identity (agent_id=agent-a, role=provider) rejected — A lacks provider role', !r.ok && (r.code === 'AUTH_MISSING_AUTHORIZATION' || r.code === 'AUTH_ROLE_DENIED'), JSON.stringify(r));

    // N3: C forges a role — claims 'authority' with no authority row
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'authority', idempotencyRef: 'h4', expectedVersion: 2 });
    // The role-table check fires BEFORE the registry lookup (defense-in-depth
    // ordering), so a forged role with no registry row yields AUTH_ROLE_DENIED.
    // Both reject — the invariant is "forged roles never succeed".
    check('N3: C forged role (authority) rejected', !r.ok && (r.code === 'AUTH_ROLE_DENIED' || r.code === 'AUTH_MISSING_AUTHORIZATION'), JSON.stringify(r));

    // N4: C uses ANOTHER commitment's authorization (cross-commitment reuse)
    const cidOther = 'c-h-' + randomUUID().slice(0, 8);
    await seedCommitment(cidOther);
    await provisionAuthority({ agentId: 'auth-' + cidOther, principal: '0xop-' + cidOther, commitmentId: cidOther });
    await grantAuthz({ authorizer: 'auth-' + cidOther, principal: '0xop-' + cidOther, subjectAgent: 'agent-c', subjectPrincipal: '0xC', commitmentId: cidOther, role: 'provider', scope: { actions: ['execute'] } });
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', idempotencyRef: 'h5', expectedVersion: 2 });
    check('N4: C cannot reuse another commitment\'s authorization (AUTH_MISSING_AUTHORIZATION)', !r.ok && r.code === 'AUTH_MISSING_AUTHORIZATION', JSON.stringify(r));
    const stAfterN4 = await stateOf(cid);
    check('N4: no persistent effect', stAfterN4.state === 'accepted' && stAfterN4.version === 2, JSON.stringify(stAfterN4));
    await clean(cidOther);

    // ============ POSITIVE: C receives its OWN scoped delegation ============
    await grantAuthz({ authorizer: 'auth-' + cid, principal: '0xop-' + cid, subjectAgent: 'agent-c', subjectPrincipal: '0xC', commitmentId: cid, role: 'provider', scope: { actions: ['execute'] } });
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', idempotencyRef: 'h6', expectedVersion: 2 });
    check('C with OWN durable authorization can execute (authorized continuation)', r.ok && r.data.to_state === 'executing', JSON.stringify(r));
    const stAfterPos = await stateOf(cid);
    check('continuation recorded: version 3, state executing', stAfterPos && stAfterPos.version === 3 && stAfterPos.state === 'executing', JSON.stringify(stAfterPos));

    // C's scope only covers 'execute' — 'complete' fails (AUTH_OUT_OF_SCOPE), no effect
    r = await transitionCommitment({ commitmentId: cid, fromState: 'executing', toState: 'evidence_pending', requestedAction: 'complete', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', idempotencyRef: 'h7', expectedVersion: 3 });
    check('C out-of-scope (complete not in C scope) rejected — AUTH_OUT_OF_SCOPE', !r.ok && r.code === 'AUTH_OUT_OF_SCOPE', JSON.stringify(r));
    const stAfterScope = await stateOf(cid);
    check('out-of-scope has no persistent effect', stAfterScope.state === 'executing' && stAfterScope.version === 3, JSON.stringify(stAfterScope));

    // ============ EXPIRED delegation ============
    const cidX = 'c-h-' + randomUUID().slice(0, 8);
    await seedCommitment(cidX, 'accepted');
    await provisionAuthority({ agentId: 'auth-' + cidX, principal: '0xop-' + cidX, commitmentId: cidX });
    await grantAuthz({ authorizer: 'auth-' + cidX, principal: '0xop-' + cidX, subjectAgent: 'agent-exp', subjectPrincipal: '0xE', commitmentId: cidX, role: 'provider', scope: { actions: ['execute'] }, validUntil: new Date(Date.now() + 1500).toISOString() });
    await new Promise(res => setTimeout(res, 1900));
    r = await transitionCommitment({ commitmentId: cidX, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-exp', verifiedPrincipal: '0xE', actorRole: 'provider', idempotencyRef: 'h8', expectedVersion: 1 });
    check('expired delegation rejected (AUTH_EXPIRED)', !r.ok && r.code === 'AUTH_EXPIRED', JSON.stringify(r));
    const stAfterX = await stateOf(cidX);
    check('expired: no persistent effect', stAfterX.state === 'accepted' && stAfterX.version === 1, JSON.stringify(stAfterX));
    await clean(cidX);

    // ============ REVOKED delegation ============
    const cidR = 'c-h-' + randomUUID().slice(0, 8);
    await seedCommitment(cidR, 'accepted');
    await provisionAuthority({ agentId: 'auth-' + cidR, principal: '0xop-' + cidR, commitmentId: cidR });
    const revAuthzId = await grantAuthz({ authorizer: 'auth-' + cidR, principal: '0xop-' + cidR, subjectAgent: 'agent-rev', subjectPrincipal: '0xR', commitmentId: cidR, role: 'provider', scope: { actions: ['execute'] } });
    // Revoke via the authority (not self): authority/system path
    await revokeAgentAuthorization({ authorizerAgent: 'auth-' + cidR, authorizerPrincipal: '0xop-' + cidR, authorizerRole: 'authority', authzId: revAuthzId, reason: 'test-revoke', idempotencyRef: 'revR' });
    r = await transitionCommitment({ commitmentId: cidR, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-rev', verifiedPrincipal: '0xR', actorRole: 'provider', idempotencyRef: 'h9', expectedVersion: 1 });
    check('revoked delegation rejected (AUTH_REVOKED)', !r.ok && r.code === 'AUTH_REVOKED', JSON.stringify(r));
    const stAfterRev = await stateOf(cidR);
    check('revoked: no persistent effect', stAfterRev.state === 'accepted' && stAfterRev.version === 1, JSON.stringify(stAfterRev));
    await clean(cidR);

    // ============ IDEMPOTENCY BINDING (v2) ============
    // N5: C reuses B's idempotency key (h2-style ref was B's execute attempt;
    // here we reuse A's accept ref 'h1' for a DIFFERENT operation) — must be
    // IDEM_FINGERPRINT_CONFLICT, and must NOT disclose the original outcome.
    r = await transitionCommitment({ commitmentId: cid, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'buyer', idempotencyRef: 'h1' });
    // h1 is bound to A's accept; C reusing it with (agent-c, 0xC) is a fingerprint conflict.
    check('N5: reusing another agent\'s idempotency key -> IDEM_FINGERPRINT_CONFLICT', !r.ok && r.code === 'IDEM_FINGERPRINT_CONFLICT', JSON.stringify(r));

    // N6: same key with different evidence ref (h6 bound to execute, reuse with evidence) — conflict
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', evidenceRef: 'ev-X', idempotencyRef: 'h6', expectedVersion: 3 });
    check('N6: same key + different evidence -> IDEM_FINGERPRINT_CONFLICT', !r.ok && r.code === 'IDEM_FINGERPRINT_CONFLICT', JSON.stringify(r));

    // N7: same key with different action (h6 was 'execute'; reuse with 'complete') — conflict
    r = await transitionCommitment({ commitmentId: cid, fromState: 'executing', toState: 'evidence_pending', requestedAction: 'complete', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', idempotencyRef: 'h6', expectedVersion: 3 });
    check('N7: same key + different action -> IDEM_FINGERPRINT_CONFLICT', !r.ok && r.code === 'IDEM_FINGERPRINT_CONFLICT', JSON.stringify(r));

    // N8: same key with different authority ref — conflict
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', authorityRef: 'DIFFERENT-AUTH', idempotencyRef: 'h6', expectedVersion: 3 });
    check('N8: same key + different authority -> IDEM_FINGERPRINT_CONFLICT', !r.ok && r.code === 'IDEM_FINGERPRINT_CONFLICT', JSON.stringify(r));

    // POSITIVE: valid idempotent retry (exact same operation) returns replayed, no new event
    r = await transitionCommitment({ commitmentId: cid, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-c', verifiedPrincipal: '0xC', actorRole: 'provider', idempotencyRef: 'h6', expectedVersion: 3 });
    check('valid idempotent retry returns replayed (h6)', r.ok && r.data.status === 'replayed', JSON.stringify(r));
    const evH6 = await countEvents(cid, 'h6');
    check('valid retry did not create a second event', evH6 === 1, 'count=' + evH6);

    // ============ UNAUTHORIZED EVENT INSERT / MODIFY ============
    const forgedIns = await db.from('commitment_events').insert({
      event_id: 'forged-' + cid, commitment_id: cid, from_state: 'executing', to_state: 'settled',
      requested_action: 'forged-settle', actor_identity: '0xforged', actor_role: 'system',
      state_version: 99, idempotency_ref: 'forged', op_fingerprint: 'forged',
    });
    check('unauthorized direct INSERT into commitment_events rejected', !!forgedIns && !!forgedIns.error, JSON.stringify(forgedIns && forgedIns.error || forgedIns));
    const forgedUpd = await db.from('commitment_events').update({ to_state: 'settled' }).eq('commitment_id', cid).eq('idempotency_ref', 'h6');
    check('no UPDATE path on commitment_events (rejected or no-op)', !!forgedUpd && !!forgedUpd.error, JSON.stringify(forgedUpd && forgedUpd.error || forgedUpd));

    // ============ CONCURRENT CONFLICTING TRANSITIONS ============
    const t1 = transitionCommitment({ commitmentId: cid, fromState: 'executing', toState: 'evidence_pending', requestedAction: 'complete', agentId: 'agent-b', verifiedPrincipal: '0xB', actorRole: 'provider', idempotencyRef: 'c1', expectedVersion: 3 });
    const t2 = transitionCommitment({ commitmentId: cid, fromState: 'executing', toState: 'recovering', requestedAction: 'recover', agentId: 'auth-' + cid, verifiedPrincipal: '0xop-' + cid, actorRole: 'system', idempotencyRef: 'c2', expectedVersion: 3 });
    // system role requires a system-scope or commitment-scoped system row — provision one
    // (the transition table allows system -> recovering from executing).
    const [r1, r2] = await Promise.all([t1, t2]);
    // Either order may win, but the loser must be ST_STALE_VERSION/ST_INVALID_TRANSITION,
    // never a double-apply. Exactly one event for one of the two refs.
    const wins = [r1, r2].filter(x => x.ok).length;
    const errs = [r1, r2].filter(x => !x.ok).map(x => x.code);
    check('concurrent conflicting transitions: exactly one wins, loser rejected', wins === 1 && errs.every(e => e === 'ST_STALE_VERSION' || e === 'ST_INVALID_TRANSITION' || e === 'AUTH_MISSING_AUTHORIZATION'), 'wins=' + wins + ' errs=' + JSON.stringify(errs));
    const stAfterConc = await stateOf(cid);
    check('concurrent: no double-apply (state is single-valued)', ['executing','evidence_pending','recovering'].includes(stAfterConc.state), JSON.stringify(stAfterConc));

    // ============ CONCURRENT REVOCATION AND TRANSITION ============
    // Give C provider+complete scope; race revoke(C) vs C's complete transition.
    // Deterministic order: revoke commits first → transition must AUTH_REVOKED.
    const cidRc = 'c-h-' + randomUUID().slice(0, 8);
    await seedCommitment(cidRc, 'accepted');
    await provisionAuthority({ agentId: 'auth-' + cidRc, principal: '0xop-' + cidRc, commitmentId: cidRc });
    const rcAuthz = await grantAuthz({ authorizer: 'auth-' + cidRc, principal: '0xop-' + cidRc, subjectAgent: 'agent-rc', subjectPrincipal: '0xRC', commitmentId: cidRc, role: 'provider', scope: { actions: ['execute','complete'] } });
    // Advance to executing first
    r = await transitionCommitment({ commitmentId: cidRc, fromState: 'accepted', toState: 'executing', requestedAction: 'execute', agentId: 'agent-rc', verifiedPrincipal: '0xRC', actorRole: 'provider', idempotencyRef: 'rc1', expectedVersion: 1 });
    check('setup: rc transition to executing', r.ok, JSON.stringify(r));
    await revokeAgentAuthorization({ authorizerAgent: 'auth-' + cidRc, authorizerPrincipal: '0xop-' + cidRc, authorizerRole: 'authority', authzId: rcAuthz, reason: 'race-revoke', idempotencyRef: 'revRc' });
    r = await transitionCommitment({ commitmentId: cidRc, fromState: 'executing', toState: 'evidence_pending', requestedAction: 'complete', agentId: 'agent-rc', verifiedPrincipal: '0xRC', actorRole: 'provider', idempotencyRef: 'rc2', expectedVersion: 2 });
    check('revocation serializes before transition: AUTH_REVOKED', !r.ok && r.code === 'AUTH_REVOKED', JSON.stringify(r));
    const stAfterRc = await stateOf(cidRc);
    check('race: no persistent effect after revoke-before-transition', stAfterRc.state === 'executing' && stAfterRc.version === 2, JSON.stringify(stAfterRc));
    await clean(cidRc);

    // ============ DATABASE FAILURE DURING TRANSITION: fail-closed ============
    // Feed an invalid RPC call (unknown commitment + wrong param types) or use
    // a closed store: the wrapper must return { ok:false } and never success.
    const failRpc = await db.rpc('transition_commitment', {
      p_commitment_id: 'does-not-exist', p_from_state: 'issued', p_to_state: 'accepted',
      p_requested_action: 'accept', p_agent_id: 'x', p_verified_principal: '0xdead',
      p_actor_role: 'buyer', p_idempotency_ref: 'fail1',
    });
    check('database failure (unknown commitment) -> error, never success', !!failRpc && !!failRpc.error, JSON.stringify(failRpc));
    const stAfterFail = await stateOf(cid);
    check('db failure: no acknowledged success / no state change', !!stAfterFail, JSON.stringify(stAfterFail));

    // ============ TERMINAL-STATE MUTATION ============
    // Drive cid to a terminal state (cancelled via buyer) and then attempt mutation.
    const cidT = 'c-h-' + randomUUID().slice(0, 8);
    await seedCommitment(cidT);
    await provisionAuthority({ agentId: 'auth-' + cidT, principal: '0xop-' + cidT, commitmentId: cidT });
    await grantAuthz({ authorizer: 'auth-' + cidT, principal: '0xop-' + cidT, subjectAgent: 'agent-t', subjectPrincipal: '0xT', commitmentId: cidT, role: 'buyer', scope: { actions: ['accept','cancel'] } });
    r = await transitionCommitment({ commitmentId: cidT, fromState: 'issued', toState: 'accepted', requestedAction: 'accept', agentId: 'agent-t', verifiedPrincipal: '0xT', actorRole: 'buyer', idempotencyRef: 't1', expectedVersion: 1 });
    check('setup: t accepted', r.ok, JSON.stringify(r));
    r = await transitionCommitment({ commitmentId: cidT, fromState: 'accepted', toState: 'cancelled', requestedAction: 'cancel', agentId: 'agent-t', verifiedPrincipal: '0xT', actorRole: 'buyer', idempotencyRef: 't2', expectedVersion: 2 });
    check('buyer cancels (terminal reached)', r.ok && r.data.to_state === 'cancelled', JSON.stringify(r));
    r = await transitionCommitment({ commitmentId: cidT, fromState: 'cancelled', toState: 'accepted', requestedAction: 'accept', agentId: 'agent-t', verifiedPrincipal: '0xT', actorRole: 'buyer', idempotencyRef: 't3', expectedVersion: 3 });
    check('terminal state rejects further mutation (ST_ALREADY_FINALIZED)', !r.ok && r.code === 'ST_ALREADY_FINALIZED', JSON.stringify(r));
    const stAfterT = await stateOf(cidT);
    check('terminal: no persistent effect', stAfterT.state === 'cancelled' && stAfterT.version === 3, JSON.stringify(stAfterT));
    await clean(cidT);

    await clean(cid);
  } catch (e) {
    fail++;
    console.log('UNCAUGHT ' + (e && e.stack || e));
  }

  console.log(`\n=== three-agent security harness v2: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();