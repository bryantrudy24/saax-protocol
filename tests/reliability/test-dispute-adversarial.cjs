// SAAX Protocol — MCP Lifecycle Phase 4I: Adversarial security tests for the
// dispute governance surface (isolated).
//
// Negative matrix: forged identities/roles, revoked/expired evaluators,
// cross-commitment access, duplicate/conflicting operations, concurrency,
// direct RPC bypass, malformed inputs. Every rejection must have ZERO
// unauthorized persistent effect.
//
// Usage: node tests/reliability/test-dispute-adversarial.cjs
'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const PATH = require('path');
const { mint } = require('./_gate-d-jwt.cjs');

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_POSTGREST_KEY;

const { raiseDispute, resolveDispute, listDisputes } = require('../../endpoint/dispute.js');
const store = require('../../endpoint/store.js').buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY);
const { privateKeyToAccount } = require('viem/accounts');

const PROOF_TYPES = {
  AuthorityProof: [
    { name: 'authorityProofId', type: 'string' }, { name: 'issuer', type: 'address' },
    { name: 'subject', type: 'address' }, { name: 'validFrom', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' }, { name: 'scopeDigest', type: 'string' },
  ],
};
const PROOF_DOMAIN = { name: 'SAAX Authority', version: '1' };
const scopeDigest = (s) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(s, (k, v) => {
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, k2) => { a[k2] = v[k2]; return a; }, {});
  return v;
}), 'utf8').digest('hex');
const makeProof = (acct, scope, id) => {
  const now = Math.floor(Date.now() / 1000);
  return { authorityProofId: id, proofType: 'verifiable-intent', issuer: acct.address, subject: acct.address, validFrom: new Date((now - 60) * 1000).toISOString(), validUntil: new Date((now + 3600) * 1000).toISOString(), scope, verificationScheme: 'eip712', signature: '', scopeDigest: scopeDigest(scope) };
};
const signProof = async (acct, p) => { p.signature = await acct.signTypedData({ domain: PROOF_DOMAIN, types: PROOF_TYPES, primaryType: 'AuthorityProof', message: { authorityProofId: p.authorityProofId, issuer: p.issuer, subject: p.subject, validFrom: BigInt(Math.floor(Date.parse(p.validFrom) / 1000)), validUntil: BigInt(Math.floor(Date.parse(p.validUntil) / 1000)), scopeDigest: p.scopeDigest } }); return p; };

const sql = (q) => execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();
let PASS = 0, FAIL = 0;
function check(name, ok, info) { if (ok) { PASS++; console.log('PASS ' + name + (info ? ' :: ' + info : '')); } else { FAIL++; console.log('FAIL ' + name + (info ? ' :: ' + info : '')); } }

async function setup(cid, { buyer, provider, evaluator, buyerScope, evaluatorScope, providerScope }) {
  sql(`INSERT INTO ax_router.commitments (commitment_id, state, version, buyer_email, created_at) VALUES ('${cid}', 'evidence_submitted', 1, 'adv@test.local', now());`);
  await store.rpc('provision_authority', { p_agent_id: 'auth-' + cid, p_verified_principal: '0xop-' + cid, p_commitment_id: cid, p_role: 'authority', p_scope: {}, p_valid_until: new Date(Date.now() + 7 * 86400e3).toISOString(), p_operator_token: 'test-operator-token-0123456789abcdef', p_idempotency_ref: 'prov:' + cid });
  const g = (agent, principal, role, scope, ref) => store.rpc('grant_agent_authorization', {
    p_authorizer_agent: 'auth-' + cid, p_authorizer_principal: '0xop-' + cid, p_authorizer_role: 'authority',
    p_subject_agent: agent, p_subject_principal: String(principal.address || principal).toLowerCase(), p_commitment_id: cid, p_role: role, p_scope: scope,
    p_valid_from: new Date(Date.now() - 60e3).toISOString(), p_valid_until: new Date(Date.now() + 3600e3).toISOString(),
    p_idempotency_ref: ref, p_delegation_ref: null,
  });
  await g('a-' + cid, buyer, 'buyer', buyerScope || { actions: ['accept', 'dispute', 'raise_dispute'] }, 'ga:' + cid + ':b');
  if (provider) await g('p-' + cid, provider, 'provider', providerScope || { actions: ['execute', 'complete', 'submit', 'submit_evidence'] }, 'ga:' + cid + ':p');
  await g('e-' + cid, evaluator, 'evaluator', evaluatorScope || { actions: ['verify', 'resolve', 'resolve_dispute'] }, 'ga:' + cid + ':e');
  return {
    b: await signProof(buyer, makeProof(buyer, buyerScope || { actions: ['accept', 'dispute', 'raise_dispute'] }, 'pb:' + cid)),
    e: await signProof(evaluator, makeProof(evaluator, evaluatorScope || { actions: ['verify', 'resolve', 'resolve_dispute'] }, 'pe:' + cid)),
  };
}

(async () => {
  sql(`INSERT INTO ax_router.operator_secrets (secret_key, secret_hash) VALUES ('authority_operator','653720f36b93ba9429b5d13edd74c359787b7138ffc17d77a564b947dd6adeb6') ON CONFLICT (secret_key) DO UPDATE SET secret_hash=EXCLUDED.secret_hash;`);
  const B = privateKeyToAccount('0x' + '1'.repeat(64));
  const P = privateKeyToAccount('0x' + '2'.repeat(64));
  const E = privateKeyToAccount('0x' + '3'.repeat(64));
  const X = privateKeyToAccount('0x' + '4'.repeat(64));

  // A1: forged evaluator (E impersonates with X's identity) can't resolve
  const c1 = 'c-adv-' + crypto.randomBytes(4).toString('hex');
  const { b: b1, e: e1 } = await setup(c1, { buyer: B, provider: P, evaluator: E });
  const d1 = await raiseDispute({ commitmentId: c1, agentId: 'a-' + c1, proof: b1, reason: 'adversarial dispute one', idempotencyRef: 'd1:' + c1 });
  check('A1-raise-ok', d1.ok, d1.ok ? 'ok' : d1.reason);
  const forgedE = await signProof(X, makeProof(X, { actions: ['verify', 'resolve', 'resolve_dispute'] }, 'px:' + c1));
  const r1 = await resolveDispute({ disputeId: d1.record.dispute_id, outcome: 'satisfied', agentId: 'e-' + c1, proof: forgedE, idempotencyRef: 'r1:' + c1 });
  check('A1-forged-evaluator-rejected', !r1.ok && /PRINCIPAL|AUTH|signature/.test(r1.reason || ''), r1.reason);
  check('A1-no-state-change', sql(`select state from ax_router.commitments where commitment_id='${c1}';`) === 'disputed', 'state stays disputed');

  // A2: cross-commitment dispute read denied
  const c2 = 'c-adv2-' + crypto.randomBytes(4).toString('hex');
  const { b: b2 } = await setup(c2, { buyer: B, provider: P, evaluator: E });
  const l2 = await listDisputes({ commitmentId: c2, agentId: 'a-' + c1, proof: b1 }); // agent from c1 on c2
  check('A2-cross-commitment-list-denied', !l2.ok && /AUTH/.test(l2.reason || ''), l2.reason);

  // A3: short reason rejected
  const r3 = await raiseDispute({ commitmentId: c2, agentId: 'a-' + c2, proof: b2, reason: 'short', idempotencyRef: 'd3:' + c2 });
  check('A3-short-reason-rejected', !r3.ok && /reason|DISP_BAD/.test(r3.reason || ''), r3.reason);

  // A4: malformed proof rejected before RPC
  const r4 = await raiseDispute({ commitmentId: c2, agentId: 'a-' + c2, proof: null, reason: 'valid enough reason here', idempotencyRef: 'd4:' + c2 });
  check('A4-null-proof-rejected', !r4.ok && /proof/.test(r4.reason || ''), r4.reason);

  // A5: duplicate concurrent raise — one row only (same commitment+ref)
  const c5 = 'c-adv5-' + crypto.randomBytes(4).toString('hex');
  const { b: b5 } = await setup(c5, { buyer: B, provider: P, evaluator: E });
  const outs = await Promise.all([
    raiseDispute({ commitmentId: c5, agentId: 'a-' + c5, proof: b5, reason: 'concurrent dispute raise five', idempotencyRef: 'd5:' + c5 }),
    raiseDispute({ commitmentId: c5, agentId: 'a-' + c5, proof: b5, reason: 'concurrent dispute raise five', idempotencyRef: 'd5:' + c5 }),
    raiseDispute({ commitmentId: c5, agentId: 'a-' + c5, proof: b5, reason: 'concurrent dispute raise five', idempotencyRef: 'd5:' + c5 }),
  ]);
  const rows5 = Number(sql(`select count(*) from ax_router.commitment_disputes where commitment_id='${c5}';`));
  const raisedCount = outs.filter((o) => o.ok && o.record && o.record.status === 'raised').length;
  const replayedCount = outs.filter((o) => o.ok && o.record && o.record.status === 'replayed').length;
  const invalidCount = outs.filter((o) => !o.ok && /DISP_INVALID_STATE/.test(o.reason || '')).length;
  check('A5-concurrent-single-row', raisedCount === 1 && replayedCount + invalidCount === 2 && rows5 === 1, 'raised=' + raisedCount + ' replayed=' + replayedCount + ' invalid=' + invalidCount + ' rows=' + rows5);

  // A6: direct service-role INSERT into disputes rejected (no DML grant)
  const canIns = sql(`select count(*) from information_schema.role_table_grants where table_schema='ax_router' and table_name='commitment_disputes' and privilege_type='INSERT' and grantee='service_role';`);
  check('A6-service-role-no-insert', canIns === '0', 'insert grants=' + canIns);

  // A7: revoked evaluator cannot resolve (revoke via authz RPC with authz_id)
  const c7 = 'c-adv7-' + crypto.randomBytes(4).toString('hex');
  const { b: b7, e: e7 } = await setup(c7, { buyer: B, provider: P, evaluator: E });
  const d7 = await raiseDispute({ commitmentId: c7, agentId: 'a-' + c7, proof: b7, reason: 'adversarial dispute seven', idempotencyRef: 'd7:' + c7 });
  const azId = sql(`select authz_id from ax_router.agent_authorizations where agent_id='e-${c7}' and commitment_id='${c7}' limit 1;`);
  const rev = await store.rpc('revoke_agent_authorization', { p_authorizer_agent: 'e-' + c7, p_authorizer_principal: String(E.address).toLowerCase(), p_authorizer_role: 'evaluator', p_authz_id: azId, p_reason: 'adv-test', p_idempotency_ref: 'rv:' + c7 });
  check('A7-revoke-ok', !rev.error, rev.error ? rev.error.message : 'ok');
  const r7 = await resolveDispute({ disputeId: d7.record.dispute_id, outcome: 'satisfied', agentId: 'e-' + c7, proof: e7, idempotencyRef: 'r7:' + c7 });
  check('A7-revoked-evaluator-rejected', !r7.ok && /AUTH_REVOKED|AUTH_MISSING/.test(r7.reason || ''), r7.reason);
  check('A7-dispute-still-open', sql(`select status from ax_router.commitment_disputes where dispute_id='${d7.record.dispute_id}';`) === 'open', 'still open');

  // A8: conflicting resolve (different outcome) rejected after resolution
  const c8 = 'c-adv8-' + crypto.randomBytes(4).toString('hex');
  const { b: b8, e: e8 } = await setup(c8, { buyer: B, provider: P, evaluator: E });
  const d8 = await raiseDispute({ commitmentId: c8, agentId: 'a-' + c8, proof: b8, reason: 'adversarial dispute eight', idempotencyRef: 'd8:' + c8 });
  const ok8 = await resolveDispute({ disputeId: d8.record.dispute_id, outcome: 'satisfied', agentId: 'e-' + c8, proof: e8, idempotencyRef: 'r8a:' + c8 });
  const bad8 = await resolveDispute({ disputeId: d8.record.dispute_id, outcome: 'against', agentId: 'e-' + c8, proof: e8, idempotencyRef: 'r8b:' + c8 });
  check('A8-conflicting-resolve-rejected', ok8.ok && !bad8.ok && /CONFLICT|ALREADY/.test(bad8.reason || ''), bad8.reason);

  // A9: stale version attempt rejected
  const c9 = 'c-adv9-' + crypto.randomBytes(4).toString('hex');
  const { b: b9 } = await setup(c9, { buyer: B, provider: P, evaluator: E });
  const badV = await raiseDispute({ commitmentId: c9, agentId: 'a-' + c9, proof: b9, reason: 'adversarial dispute nine', idempotencyRef: 'd9:' + c9 });
  check('A9-raise-ok', badV.ok, badV.ok ? 'ok' : badV.reason);
  // version bump on second raise attempt (state now disputed → DISP_INVALID_STATE)
  const again = await raiseDispute({ commitmentId: c9, agentId: 'a-' + c9, proof: b9, reason: 'adversarial dispute nine again', idempotencyRef: 'd9b:' + c9 });
  check('A9-raise-again-rejected', !again.ok && /DISP_INVALID_STATE/.test(again.reason || ''), again.reason);

  // A10: no side effects on rejected operations (no dispute rows on c2)
  const c2Rows = Number(sql(`select count(*) from ax_router.commitment_disputes where commitment_id='${c2}';`));
  check('A10-no-side-effects-on-rejects', c2Rows === 0, 'c2 rows=' + c2Rows);

  console.log('\n==== PHASE 4 DISPUTE ADVERSARIAL: ' + PASS + '/' + (PASS + FAIL) + ' PASS ====');
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });