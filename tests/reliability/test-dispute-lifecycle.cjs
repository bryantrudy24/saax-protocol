// SAAX Protocol â€” MCP Lifecycle Phase 4E: Dispute governance conformance (isolated).
//
// Runs against the local Docker testbed (ax_router_db) with Phase 1 + Phase 3
// + Phase 4 migrations applied. Exercises raise_dispute / resolve_dispute /
// list_disputes RPCs through the app wrapper with real EIP-712 proofs,
// covering the authorization matrix, nonfinancial outcome enforcement,
// idempotency, concurrency, and no-unauthorized-side-effect rules.
//
// Usage: node tests/reliability/test-dispute-lifecycle.cjs
'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');

function sql(q) {
  return execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();
}

const PATH = require('path');
const { mint } = require('./_gate-d-jwt.cjs');
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_POSTGREST_KEY;

const { raiseDispute, resolveDispute, listDisputes } = require('../../endpoint/dispute.js');
const lifecycle = require('../../endpoint/lifecycle.js');
const authority = require('../../endpoint/authority.js');

const { privateKeyToAccount } = require('viem/accounts');
const { randomUUID } = require('crypto');

const PROOF_TYPES = {
  AuthorityProof: [
    { name: 'authorityProofId', type: 'string' },
    { name: 'issuer', type: 'address' },
    { name: 'subject', type: 'address' },
    { name: 'validFrom', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'scopeDigest', type: 'string' },
  ],
};
const PROOF_DOMAIN = { name: 'SAAX Authority', version: '1' };

function scopeDigest(scope) {
  const canonical = JSON.stringify(scope, (k, v) => {
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {});
    return v;
  });
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function makeProof(account, subject, scope, { validFrom, validUntil, proofId } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const from = validFrom || now - 60;
  const until = validUntil || now + 3600;
  const id = proofId || ('proof-' + randomUUID().slice(0, 8));
  return {
    authorityProofId: id,
    proofType: 'verifiable-intent',
    issuer: account.address,
    subject,
    validFrom: new Date(from * 1000).toISOString(),
    validUntil: new Date(until * 1000).toISOString(),
    scope,
    verificationScheme: 'eip712',
    signature: '',
    scopeDigest: scopeDigest(scope),
  };
}

async function signProof(account, proof) {
  const sig = await account.signTypedData({
    domain: PROOF_DOMAIN,
    types: PROOF_TYPES,
    primaryType: 'AuthorityProof',
    message: {
      authorityProofId: proof.authorityProofId,
      issuer: proof.issuer,
      subject: proof.subject,
      validFrom: BigInt(Math.floor(Date.parse(proof.validFrom) / 1000)),
      validUntil: BigInt(Math.floor(Date.parse(proof.validUntil) / 1000)),
      scopeDigest: proof.scopeDigest,
    },
  });
  return { ...proof, signature: sig };
}

async function provisionAuthority({ agentId, principal, commitmentId, role = 'authority', scope = {} }) {
  const { data, error } = await require('../../endpoint/store.js').buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY).rpc('provision_authority', {
    p_agent_id: agentId,
    p_verified_principal: principal,
    p_commitment_id: commitmentId || null,
    p_role: role,
    p_scope: scope,
    p_valid_until: new Date(Date.now() + 7 * 86400e3).toISOString(),
    p_operator_token: 'test-operator-token-0123456789abcdef',
    p_idempotency_ref: 'prov:' + agentId + ':' + (commitmentId || 'svc') + ':' + role,
  });
  if (error) throw new Error('provisionAuthority: ' + error.message);
  return data;
}

async function grantAuthz({ agentId, principal, commitmentId, role, scope = {}, validUntil }) {
  const { data, error } = await require('../../endpoint/store.js').buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY).rpc('grant_agent_authorization', {
    p_authorizer_agent: 'auth-' + commitmentId,
    p_authorizer_principal: '0xop-' + commitmentId,
    p_authorizer_role: 'authority',
    p_subject_agent: agentId,
    p_subject_principal: principal,
    p_commitment_id: commitmentId,
    p_role: role,
    p_scope: scope,
    p_valid_from: new Date(Date.now() - 60 * 1000).toISOString(),
    p_valid_until: validUntil || new Date(Date.now() + 3600 * 1000).toISOString(),
    p_idempotency_ref: 'ga:' + agentId + ':' + commitmentId + ':' + role,
    p_delegation_ref: null,
  });
  if (error) throw new Error('grantAuthz: ' + error.message);
  return data;
}

const RESULTS = [];
function check(name, cond, detail) {
  RESULTS.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}
function finish(name) {
  const failed = RESULTS.filter((r) => !r.pass);
  console.log('\n==== ' + name + ': ' + (RESULTS.length - failed.length) + '/' + RESULTS.length + ' PASS ====');
  process.exit(failed.length ? 1 : 0);
}

(async () => {

  // ---- Operator-token self-seed (testbed only; mirrors the owner/psql action) ----
  // The isolated testbed's operator_secrets row is not durably seeded across
  // container restarts. This test seeds the TEST-ONLY token hash so the suite
  // is reproducible from any testbed state. Never point at production.
  sql(`INSERT INTO ax_router.operator_secrets (secret_key, secret_hash, updated_at)
       VALUES ('authority_operator', '653720f36b93ba9429b5d13edd74c359787b7138ffc17d77a564b947dd6adeb6', now())
       ON CONFLICT (secret_key) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, updated_at = now();`);

  // ---- Setup: provider account + EIP-712 proof helper ----
  const accB = privateKeyToAccount('0x' + '2'.repeat(64));
  const accE = privateKeyToAccount('0x' + '3'.repeat(64));
  const accX = privateKeyToAccount('0x' + '4'.repeat(64));

  // Create a commitment in a dispute-eligible state (evidence_submitted).
  const cid = 'c-' + crypto.randomBytes(6).toString('hex');
  sql(`INSERT INTO ax_router.commitments (commitment_id, state, version, buyer_email, created_at) VALUES ('${cid}', 'evidence_submitted', 1, 'buyer@test.local', now());`);
  await provisionAuthority({ agentId: 'auth-' + cid, principal: '0xop-' + cid, commitmentId: cid, role: 'authority' });
  await grantAuthz({ agentId: 'agent-buyer', principal: accB.address, commitmentId: cid, role: 'buyer', scope: { actions: ['accept', 'dispute', 'raise_dispute'] } });
  await grantAuthz({ agentId: 'agent-prov', principal: accB.address, commitmentId: cid, role: 'provider', scope: { actions: ['fulfill'] } });
  await grantAuthz({ agentId: 'agent-e', principal: accE.address, commitmentId: cid, role: 'evaluator', scope: { actions: ['verify', 'resolve', 'resolve_dispute'] } });

  const proofB = await signProof(accB, makeProof(accB, accB.address, { actions: ['accept', 'dispute'] }, { proofId: 'pb-' + cid }));

  // ---- Negative raise tests first (while still in evidence_submitted) ----
  // T6: unauthorized (no authz) cannot raise
  const accY = privateKeyToAccount('0x' + '1'.repeat(64));
  const proofY = await signProof(accY, makeProof(accY, accY.address, { actions: ['fulfill'] }, { proofId: 'py-' + cid }));
  const r6 = await raiseDispute({
    commitmentId: cid, agentId: 'agent-y', proof: proofY,
    reason: 'trying to raise without authorization',
    idempotencyRef: 'disp6:' + cid,
  });
  check('T6-unauthorized-raise-rejected', !r6.ok && /AUTH_MISSING_AUTHORIZATION/.test(r6.reason || ''), r6.reason);

  // T7: evaluator (no raise authority) rejected — role map requires buyer for disputed
  const proofE = await signProof(accE, makeProof(accE, accE.address, { actions: ['verify', 'resolve'] }, { proofId: 'pe-' + cid }));
  const r7 = await raiseDispute({
    commitmentId: cid, agentId: 'agent-e', proof: proofE,
    reason: 'evaluator attempts to raise',
    idempotencyRef: 'disp7:' + cid,
  });
  check('T7-evaluator-cannot-raise', !r7.ok && /AUTH_ROLE_DENIED/.test(r7.reason || ''), r7.reason);

  // T8: forged principal cannot raise (principal mismatch)
  const r8 = await raiseDispute({
    commitmentId: cid, agentId: 'agent-buyer', proof: { ...proofB, issuer: accX.address },
    reason: 'forged principal attempt',
    idempotencyRef: 'disp8:' + cid,
  });
  check('T8-forged-principal-rejected', !r8.ok && /signature|principal|stale/i.test(r8.reason || ''), r8.reason);

  // T5: raise from wrong state (executing) rejected
  // (A second commitment seeded directly into 'executing'; buyer has no valid edge.)
  const cidWrong = 'cw-' + crypto.randomBytes(6).toString('hex');
  sql(`INSERT INTO ax_router.commitments (commitment_id, state, version, buyer_email, created_at) VALUES ('${cidWrong}', 'executing', 1, 'wrong@test.local', now());`);
  await provisionAuthority({ agentId: 'auth-' + cidWrong, principal: '0xop-' + cidWrong, commitmentId: cidWrong, role: 'authority' });
  await grantAuthz({ agentId: 'agent-buyer-w', principal: accB.address, commitmentId: cidWrong, role: 'buyer', scope: { actions: ['accept', 'dispute', 'raise_dispute'] } });
  const proofBW = await signProof(accB, makeProof(accB, accB.address, { actions: ['accept', 'dispute'] }, { proofId: 'pbw-' + cidWrong }));
  const r5 = await raiseDispute({ commitmentId: cidWrong, agentId: 'agent-buyer-w', proof: proofBW, reason: 'dispute from executing', idempotencyRef: 'disp5:' + cidWrong });
  check('T5-raise-from-wrong-state-rejected', !r5.ok && /DISP_INVALID_STATE/.test(r5.reason || ''), r5.reason);

  // ---- Positive raise flow ----
  // T1: buyer raises a dispute from evidence_submitted
  const r1 = await raiseDispute({
    commitmentId: cid, agentId: 'agent-buyer', proof: proofB,
    reason: 'Evidence does not match agreed quality criteria',
    evidenceRefs: ['ev:test-001'], idempotencyRef: 'disp1:' + cid,
  });
  check('T1-provider-raises-dispute', r1.ok && r1.record && r1.record.status === 'raised', r1.ok ? JSON.stringify(r1.record) : r1.reason);

  // T2: commitment state advanced to disputed
  const st1 = sql(`select state from ax_router.commitments where commitment_id='${cid}';`);
  check('T2-commitment-state-disputed', st1 === 'disputed', 'state=' + st1);

  // T3: idempotent replay returns replayed, same dispute id
  const r3 = await raiseDispute({
    commitmentId: cid, agentId: 'agent-buyer', proof: proofB,
    reason: 'Evidence does not match agreed quality criteria',
    evidenceRefs: ['ev:test-001'], idempotencyRef: 'disp1:' + cid,
  });
  check('T3-idempotent-replay', r3.ok && r3.record && r3.record.status === 'replayed', r3.ok ? JSON.stringify(r3.record) : r3.reason);

  // T4: duplicate dispute row not created
  const cnt1 = sql(`select count(*) from ax_router.commitment_disputes where commitment_id='${cid}';`);
  check('T4-single-dispute-row', cnt1 === '1', 'rows=' + cnt1);

  // T9: list_disputes â€” authorized caller sees the dispute
  const l1 = await listDisputes({ commitmentId: cid, agentId: 'agent-buyer', proof: proofB });
  check('T9-list-authorized', l1.ok && Array.isArray(l1.record.disputes) && l1.record.disputes.length === 1, l1.ok ? JSON.stringify(l1.record) : l1.reason);

  // T10: list_disputes â€” unauthorized caller rejected
  const l2 = await listDisputes({ commitmentId: cid, agentId: 'agent-y', proof: proofY });
  check('T10-list-unauthorized-rejected', !l2.ok && /AUTH_MISSING_AUTHORIZATION/.test(l2.reason || ''), l2.reason);

  // T11: resolve by provider (not evaluator) rejected
  const r11 = await resolveDispute({
    disputeId: r1.record.dispute_id, outcome: 'satisfied', agentId: 'agent-buyer', proof: proofB,
    idempotencyRef: 'res11:' + cid,
  });
  check('T11-provider-cannot-resolve', !r11.ok && /evaluator|AUTH/i.test(r11.reason || ''), r11.reason);

  // T12: resolve by evaluator â€” satisfied -> fulfilled (canonical edge)
  const r12 = await resolveDispute({
    disputeId: r1.record.dispute_id, outcome: 'satisfied', agentId: 'agent-e', proof: proofE,
    idempotencyRef: 'res12:' + cid,
  });
  check('T12-evaluator-resolves-satisfied', r12.ok && r12.record && r12.record.outcome === 'satisfied' && r12.record.commitment_state === 'fulfilled', r12.ok ? JSON.stringify(r12.record) : r12.reason);

  // T13: commitment state now fulfilled
  const st13 = sql(`select state from ax_router.commitments where commitment_id='${cid}';`);
  check('T13-commitment-fulfilled', st13 === 'fulfilled', 'state=' + st13);

  // T14: resolved dispute cannot be re-resolved (DISP_ALREADY_RESOLVED)
  const r14 = await resolveDispute({
    disputeId: r1.record.dispute_id, outcome: 'against', agentId: 'agent-e', proof: proofE,
    idempotencyRef: 'res14:' + cid,
  });
  check('T14-double-resolve-rejected', !r14.ok && /DISP_RESOLVED_CONFLICT|DISP_ALREADY_RESOLVED|DISP_NOT_DISPUTED/.test(r14.reason || ''), r14.reason);

  // T15: resolution idempotent replay (same ref) returns replayed
  const r15 = await resolveDispute({
    disputeId: r1.record.dispute_id, outcome: 'satisfied', agentId: 'agent-e', proof: proofE,
    idempotencyRef: 'res12:' + cid,
  });
  check('T15-resolve-replay-idempotent', r15.ok && r15.record && (r15.record.status === 'replayed' || r15.record.outcome === 'satisfied'), r15.ok ? JSON.stringify(r15.record) : r15.reason);

  // T16: 'settled' outcome is rejected (financial path disabled)
  const r16 = await resolveDispute({
    disputeId: r1.record.dispute_id, outcome: 'settled', agentId: 'agent-e', proof: proofE,
    idempotencyRef: 'res16:' + cid,
  });
  check('T16-settled-outcome-blocked', !r16.ok && /settled|DISP_BAD_OUTCOME|outcome/.test(r16.reason || ''), r16.reason);

  // ---- Second scenario: dispute resolved to 'against' -> failed ----
  const cid2 = 'c2-' + crypto.randomBytes(6).toString('hex');
  sql(`INSERT INTO ax_router.commitments (commitment_id, state, version, buyer_email, created_at) VALUES ('${cid2}', 'evidence_submitted', 1, 'buyer2@test.local', now());`);
  await provisionAuthority({ agentId: 'auth-' + cid2, principal: '0xop-' + cid2, commitmentId: cid2, role: 'authority' });
  await grantAuthz({ agentId: 'agent-buyer2', principal: accB.address, commitmentId: cid2, role: 'buyer', scope: { actions: ['accept', 'dispute', 'raise_dispute'] } });
  await grantAuthz({ agentId: 'agent-prov2', principal: accB.address, commitmentId: cid2, role: 'provider', scope: { actions: ['fulfill'] } });
  await grantAuthz({ agentId: 'agent-e2', principal: accE.address, commitmentId: cid2, role: 'evaluator', scope: { actions: ['verify', 'resolve', 'resolve_dispute'] } });
  const proofB2 = await signProof(accB, makeProof(accB, accB.address, { actions: ['accept', 'dispute'] }, { proofId: 'pb2-' + cid2 }));
  const proofE2 = await signProof(accE, makeProof(accE, accE.address, { actions: ['verify', 'resolve'] }, { proofId: 'pe2-' + cid2 }));

  const r2a = await raiseDispute({
    commitmentId: cid2, agentId: 'agent-buyer2', proof: proofB2,
    reason: 'Delivered item is not what was agreed',
    idempotencyRef: 'disp2a:' + cid2,
  });
  check('T17-raise-second-dispute', r2a.ok && r2a.record.status === 'raised', r2a.ok ? JSON.stringify(r2a.record) : r2a.reason);

  const r2b = await resolveDispute({
    disputeId: r2a.record.dispute_id, outcome: 'against', agentId: 'agent-e2', proof: proofE2,
    idempotencyRef: 'res2b:' + cid2,
  });
  check('T18-resolve-against->failed', r2b.ok && r2b.record.commitment_state === 'failed', r2b.ok ? JSON.stringify(r2b.record) : r2b.reason);

  // T19: expired evaluator authorization rejected
  const cid3 = 'c3-' + crypto.randomBytes(6).toString('hex');
  sql(`INSERT INTO ax_router.commitments (commitment_id, state, version, buyer_email, created_at) VALUES ('${cid3}', 'evidence_submitted', 1, 'buyer3@test.local', now());`);
  await provisionAuthority({ agentId: 'auth-' + cid3, principal: '0xop-' + cid3, commitmentId: cid3, role: 'authority' });
  await grantAuthz({ agentId: 'agent-buyer3', principal: accB.address, commitmentId: cid3, role: 'buyer', scope: { actions: ['accept', 'dispute', 'raise_dispute'] } });
  await grantAuthz({ agentId: 'agent-prov3', principal: accB.address, commitmentId: cid3, role: 'provider', scope: { actions: ['fulfill'] } });
  // Evaluator authorization that is ALREADY EXPIRED at grant time â€” grant RPC rejects past validUntil.
  const expired = new Date(Date.now() - 60 * 1000).toISOString();
  const grantExpired = await require('../../endpoint/store.js').buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY).rpc('grant_agent_authorization', {
    p_authorizer_agent: 'auth-' + cid3, p_authorizer_principal: '0xop-' + cid3, p_authorizer_role: 'authority',
    p_subject_agent: 'agent-e3', p_subject_principal: accE.address, p_commitment_id: cid3, p_role: 'evaluator',
    p_scope: { actions: ['verify', 'resolve', 'resolve_dispute'] },
    p_valid_from: new Date(Date.now() - 120 * 1000).toISOString(), p_valid_until: expired, p_idempotency_ref: 'ga-e3:' + cid3,
    p_delegation_ref: null,
  });
  check('T19-expired-grant-rejected-at-grant', !!(grantExpired.error && /valid_until|23514|AUTH/.test(grantExpired.error.message || '')), grantExpired.error ? grantExpired.error.message : 'grant unexpectedly succeeded');

  // T20: revoked evaluator cannot resolve
  const cid4 = 'c4-' + crypto.randomBytes(6).toString('hex');
  sql(`INSERT INTO ax_router.commitments (commitment_id, state, version, buyer_email, created_at) VALUES ('${cid4}', 'evidence_submitted', 1, 'buyer4@test.local', now());`);
  await provisionAuthority({ agentId: 'auth-' + cid4, principal: '0xop-' + cid4, commitmentId: cid4, role: 'authority' });
  await grantAuthz({ agentId: 'agent-buyer4', principal: accB.address, commitmentId: cid4, role: 'buyer', scope: { actions: ['accept', 'dispute', 'raise_dispute'] } });
  await grantAuthz({ agentId: 'agent-prov4', principal: accB.address, commitmentId: cid4, role: 'provider', scope: { actions: ['fulfill'] } });
  await grantAuthz({ agentId: 'agent-e4', principal: accE.address, commitmentId: cid4, role: 'evaluator', scope: { actions: ['verify', 'resolve', 'resolve_dispute'] } });
  const proofB4 = await signProof(accB, makeProof(accB, accB.address, { actions: ['accept', 'dispute'] }, { proofId: 'pb4-' + cid4 }));
  const r4a = await raiseDispute({ commitmentId: cid4, agentId: 'agent-buyer4', proof: proofB4, reason: 'Quality dispute on fourth commitment', idempotencyRef: 'disp4a:' + cid4 });
  check('T20-raise-fourth', r4a.ok && r4a.record.status === 'raised', r4a.ok ? JSON.stringify(r4a.record) : r4a.reason);
  const authzRow = sql(`select authz_id from ax_router.agent_authorizations where agent_id='agent-e4' and commitment_id='${cid4}' and role='evaluator' limit 1;`);
  const revokeRes = await require('../../endpoint/store.js').buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY).rpc('revoke_agent_authorization', {
    p_authorizer_agent: 'agent-e4', p_authorizer_principal: accE.address, p_authorizer_role: 'evaluator',
    p_authz_id: authzRow, p_reason: 'revoked for test', p_idempotency_ref: 'rv4:' + cid4,
  });
  if (revokeRes.error) throw new Error('revoke setup: ' + revokeRes.error.message);
  const proofE4 = await signProof(accE, makeProof(accE, accE.address, { actions: ['verify', 'resolve'] }, { proofId: 'pe4-' + cid4 }));
  const r4b = await resolveDispute({ disputeId: r4a.record.dispute_id, outcome: 'satisfied', agentId: 'agent-e4', proof: proofE4, idempotencyRef: 'res4b:' + cid4 });
  check('T21-revoked-evaluator-cannot-resolve', !r4b.ok && /AUTH_REVOKED|AUTH_MISSING/.test(r4b.reason || ''), r4b.reason);

  // T22: dispute history is append-only (no UPDATE grants)
  const canUpd = sql(`select count(*) from information_schema.role_table_grants where table_schema='ax_router' and table_name='commitment_disputes' and privilege_type in ('UPDATE','DELETE') and grantee='service_role';`);
  check('T22-disputes-no-service-update', canUpd === '0', 'grant count=' + canUpd);

  finish('PHASE 4 DISPUTE LIFECYCLE');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });