// SAAX Protocol — MCP Lifecycle Phase 5F: operator-authority provisioning
// conformance (ISOLATED testbed only — ax_router_db :5433 / ax_router_postgrest
// :3000). Never runs against production.
//
// Wrapper contracts (endpoint/lifecycle.js, verified by source):
//   grantAgentAuthorization({ authorizerAgent, authorizerPrincipal,
//     authorizerRole, subjectAgent, subjectPrincipal, commitmentId, role,
//     scope, validFrom, validUntil, idempotencyRef }) -> { ok, data|error }
//   revokeAgentAuthorization({ authorizerAgent, authorizerPrincipal,
//     authorizerRole, authzId, reason, idempotencyRef }) -> { ok, data|error }
//   provision_authority RPC: p_agent_id, p_verified_principal, p_commitment_id,
//     p_role (authority|system), p_scope, p_valid_until, p_operator_token,
//     p_idempotency_ref; hard-codes secret_key='authority_operator'.
'use strict';

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const { mint } = require('./_gate-d-jwt.cjs');
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const store = require('../../endpoint/store.js');
const lifecycle = require('../../endpoint/lifecycle.js');
const db = store.buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function psql(sql) {
  return execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router', '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

async function provision(opts) {
  const { data, error } = await db.rpc('provision_authority', {
    p_agent_id: opts.agentId,
    p_verified_principal: opts.verifiedPrincipal,
    p_commitment_id: opts.commitmentId !== undefined && opts.commitmentId !== null ? opts.commitmentId : null,
    p_role: opts.role || 'authority',
    p_scope: opts.scope || {},
    p_valid_until: opts.validUntil !== undefined ? opts.validUntil : null,
    p_operator_token: opts.operatorToken !== undefined && opts.operatorToken !== null ? opts.operatorToken : null,
    p_idempotency_ref: opts.idempotencyRef || null,
  });
  if (error) return { ok: false, reason: String(error.message || error) };
  return { ok: true, record: data };
}

(async () => {
  const TEST_TOKEN = 'phase5f-test-operator-token-' + crypto.randomBytes(6).toString('hex');
  // Runtime-unique idempotency refs: repeat-run safe (no stale-row collisions).
  const REF = 'run-' + crypto.randomBytes(6).toString('hex');
  const hash = crypto.createHash('sha256').update(TEST_TOKEN, 'utf8').digest('hex');
  // Seed the EXACT key the migration queries (authority_operator) with a fresh
  // test token, and restore the original hash at cleanup.
  const ORIG_HASH = psql("SELECT secret_hash FROM ax_router.operator_secrets WHERE secret_key='authority_operator';");
  psql("INSERT INTO ax_router.operator_secrets (secret_key, secret_hash) VALUES ('authority_operator', '" + hash + "') ON CONFLICT (secret_key) DO UPDATE SET secret_hash=EXCLUDED.secret_hash;");
  const cleaned = []; // queue of psql cleanup statements

  // --- P1: service_role has SELECT-only on operator_secrets ---
  const servPrivs = psql("SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants WHERE table_schema='ax_router' AND table_name='operator_secrets' AND grantee='service_role';");
  check('P1-service-role-select-only', servPrivs === 'SELECT', servPrivs);

  // --- P2: absent token rejected ---
  const r1 = await provision({ agentId: 'op-a', verifiedPrincipal: '0x' + '0'.repeat(40), role: 'authority', validUntil: new Date(Date.now() + 86400000).toISOString(), operatorToken: null, idempotencyRef: REF + '-p1' });
  check('P2-absent-token-rejected', r1.ok === false && /OPERATOR_TOKEN/i.test(r1.reason || ''), r1.reason || '');

  // --- P3: wrong token rejected ---
  const r2 = await provision({ agentId: 'op-a', verifiedPrincipal: '0x' + '0'.repeat(40), role: 'authority', validUntil: new Date(Date.now() + 86400000).toISOString(), operatorToken: 'wrong-token-value-123456', idempotencyRef: REF + '-p2' });
  check('P3-wrong-token-rejected', r2.ok === false && /OPERATOR_TOKEN/i.test(r2.reason || ''), r2.reason || '');

  // --- P4: correct token + commitment-scoped authority provisions ---
  // The grant path requires the authorizer to hold authority for the SAME
  // commitment, so provision authority scoped to c-5f-1 (not service scope).
  const r3 = await provision({ agentId: 'op-a', verifiedPrincipal: '0x' + '0'.repeat(40), role: 'authority', commitmentId: 'c-5f-1', validUntil: new Date(Date.now() + 86400000).toISOString(), operatorToken: TEST_TOKEN, idempotencyRef: REF + '-p4' });
  check('P4-correct-token-provisions', r3.ok === true && r3.record && r3.record.status === 'provisioned', JSON.stringify(r3.record || r3.reason));

  // --- P5: provisioning idempotent ---
  const r4 = await provision({ agentId: 'op-a', verifiedPrincipal: '0x' + '0'.repeat(40), role: 'authority', commitmentId: 'c-5f-1', validUntil: new Date(Date.now() + 86400000).toISOString(), operatorToken: TEST_TOKEN, idempotencyRef: REF + '-p4' });
  check('P5-provision-idempotent', r4.ok === true && (r4.record.status === 'provisioned' || r4.record.status === 'replayed'), JSON.stringify(r4.record || r4.reason));

  // --- P6: authority authorizer grants a buyer (commitment-scoped) ---
  const g = await lifecycle.grantAgentAuthorization({
    authorizerAgent: 'op-a', authorizerPrincipal: '0x' + '0'.repeat(40), authorizerRole: 'authority',
    subjectAgent: 'buyer-1', subjectPrincipal: '0x' + 'b'.repeat(40),
    commitmentId: 'c-5f-1', role: 'buyer', scope: { actions: ['accept_commitment', 'submit_evidence'] },
    validFrom: new Date(Date.now() - 60000).toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    idempotencyRef: REF + '-g1',
  });
  check('P6-authorizer-grants-buyer', g.ok === true && g.data && (g.data.status === 'granted' || g.data.status === 'exists'), JSON.stringify(g.data || g.error));

  const authzId = psql("SELECT authz_id FROM ax_router.agent_authorizations WHERE agent_id='buyer-1' AND commitment_id='c-5f-1' AND role='buyer' AND revoked_at IS NULL LIMIT 1;");
  check('P6b-grant-row-derived', authzId !== '' && /^[0-9a-f-]{8,}$/i.test(authzId), authzId);

  // --- P7: a non-authority cannot grant ---
  const g2 = await lifecycle.grantAgentAuthorization({
    authorizerAgent: 'imposter', authorizerPrincipal: '0x' + 'd'.repeat(40), authorizerRole: 'buyer',
    subjectAgent: 'buyer-2', subjectPrincipal: '0x' + 'c'.repeat(40),
    commitmentId: 'c-5f-2', role: 'buyer', scope: { actions: ['accept_commitment'] },
    validFrom: new Date(Date.now() - 60000).toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    idempotencyRef: REF + '-g2',
  });
  check('P7-non-authority-cannot-grant', g2.ok === false, g2.error || '');

  // --- P8: authority revokes the buyer (authzId-targeted) ---
  const revAuthz = await lifecycle.revokeAgentAuthorization({
    authorizerAgent: 'op-a', authorizerPrincipal: '0x' + '0'.repeat(40), authorizerRole: 'authority',
    authzId: authzId, reason: 'phase5f test revoke', idempotencyRef: REF + '-rv1',
  });
  check('P8-authorizer-revokes', revAuthz.ok === true && (revAuthz.data.status === 'revoked' || revAuthz.data.status === 'already_revoked' || revAuthz.data.status === 'replayed'), JSON.stringify(revAuthz.data || revAuthz.error));

  // --- P9: revocation durably recorded ---
  const revokedCount = psql("SELECT count(*) FROM ax_router.agent_authorizations WHERE agent_id='buyer-1' AND commitment_id='c-5f-1' AND revoked_at IS NOT NULL;");
  check('P9-revoked-row-recorded', revokedCount === '1', revokedCount);

  // --- P10: authorization_events audit trail recorded grant+revoke ---
  const evCount = psql("SELECT count(*) FROM ax_router.authorization_events WHERE idempotency_ref IN ('" + REF + "-g1','" + REF + "-rv1');");
  check('P10-audit-events-recorded', Number(evCount) >= 2, evCount);

  // --- P11: wrong-role provisioning rejected (system|authority only) ---
  const rBad = await provision({ agentId: 'op-b', verifiedPrincipal: '0x' + '0'.repeat(40), role: 'buyer', validUntil: new Date(Date.now() + 86400000).toISOString(), operatorToken: TEST_TOKEN, idempotencyRef: REF + '-p11' });
  check('P11-bad-role-rejected', rBad.ok === false, rBad.reason || '');

  // --- P12: expired authority window rejected ---
  const rPast = await provision({ agentId: 'op-c', verifiedPrincipal: '0x' + '0'.repeat(40), role: 'authority', commitmentId: 'c-5f-1', validUntil: new Date(Date.now() - 1000).toISOString(), operatorToken: TEST_TOKEN, idempotencyRef: REF + '-p12' });
  check('P12-expired-window-rejected', rPast.ok === false, rPast.reason || '');

  // --- P13: no privilege escalation — service-role INSERT on operator_secrets
  //     returns a server error (SELECT-only grant). Assert on the RESULT, not
  //     a throw: supabase-js may resolve with { error } instead of throwing.
  let insertErr = null, insertOk = false;
  try {
    const res = await db.from('operator_secrets').insert({ secret_key: 'hax', secret_hash: 'x' });
    insertErr = res && res.error ? String(res.error.message || res.error) : null;
    insertOk = !!(res && res.error === null && res.data);
  } catch (e) { insertErr = String(e.message || e); }
  check('P13-service-role-cannot-insert-secret', insertErr !== null && /permission denied|permission|RLS|rls/i.test(insertErr) && !insertOk, insertErr || 'no error (bad)');

  // --- Cleanup: restore the original hash + drop test rows ---
  if (ORIG_HASH) psql("UPDATE ax_router.operator_secrets SET secret_hash='" + ORIG_HASH + "' WHERE secret_key='authority_operator';");
  else psql("DELETE FROM ax_router.operator_secrets WHERE secret_key='authority_operator';");
  psql("DELETE FROM ax_router.agent_authorizations WHERE agent_id IN ('op-a','op-b','op-c') OR (agent_id='buyer-1' AND commitment_id='c-5f-1');");
  console.log('\n==== PHASE 5F OPERATOR PROVISIONING: ' + pass + '/' + (pass + fail) + ' PASS ====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });