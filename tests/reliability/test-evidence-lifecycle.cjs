// SAAX MCP Lifecycle Phase 3 — Evidence lifecycle conformance (isolated).
//
// Runs against the local Docker testbed (ax_router_db) with the Phase 1
// migration + Phase 3 evidence migration applied. Exercises submit_evidence /
// verify_evidence / list_evidence RPCs through the app wrapper with real
// EIP-712 proofs (authority.js), covering the authorization matrix,
// idempotency binding, concurrency, and no-unauthorized-side-effect rules.
//
// Usage: node tests/reliability/test-evidence-lifecycle.cjs
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

const { submitEvidence, verifyEvidence, listEvidence } = require('../../endpoint/evidence-lifecycle.js');
const authority = require('../../endpoint/authority.js');

// ---- EIP-712 proof factory (viem; recovered signer = proof.issuer) ----------
// Mirrors the Phase 2 principal-binding test exactly: real EIP-712 signatures
// over the SAAX Authority domain (name+version only — no chainId).
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
    signature: '', // filled by signProof
    scopeDigest: scopeDigest(scope),
  };
}

async function signProof(account, proof) {
  const typed = {
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
  };
  const sig = await account.signTypedData(typed);
  return { ...proof, signature: sig };
}

// Real signers (deterministic test keys) — same as the Phase 1/2 tests.
const A_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const B_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const C_KEY = '0x3333333333333333333333333333333333333333333333333333333333333333';
const X_KEY = '0x4444444444444444444444444444444444444444444444444444444444444444';
const accA = privateKeyToAccount(A_KEY);
const accB = privateKeyToAccount(B_KEY);
const accC = privateKeyToAccount(C_KEY);
const accX = privateKeyToAccount(X_KEY);
const SIGNERS = { buyer: accA.address.toLowerCase(), provider: accB.address.toLowerCase(), evaluator: accC.address.toLowerCase(), attacker: accX.address.toLowerCase() };
const SCOPES = {
  evidence: { actions: ['submit_evidence', 'verify_evidence', 'list_evidence'], amountMax: '1000', currency: 'USDC' },
};

let PASS = 0, FAIL = 0, SKIP = 0;
const failures = [];
function record(name, ok, info) {
  if (ok) { PASS++; console.log('PASS ' + name + (info ? ' :: ' + info : '')); }
  else { FAIL++; failures.push(name); console.log('FAIL ' + name + (info ? ' :: ' + info : '')); }
}

(async () => {
  // ---- Setup: seed a commitment + authorizations via the Phase 1 RPCs -------
  // Use the same bootstrap approach as the Phase 1/2 harnesses: provision via
  // operator token, grant provider/buyer/evaluator rows, create a commitment.
  // (Phase 1 test harness has the exact flow; mirror it here.)
  const setup = require('./phase2-smoke.cjs');
  // phase2-smoke may not export a setup; fall back to direct SQL/RPC seeding.
  // For this test we seed directly through the RPCs using a known operator
  // token hash and the grant RPC.

  const operatorToken = 'test-operator-token-phase3';
  sql("INSERT INTO ax_router.operator_secrets (secret_key, secret_hash) VALUES ('authority_operator', encode(sha256(convert_to('" + operatorToken + "','UTF8')),'hex')) ON CONFLICT (secret_key) DO UPDATE SET secret_hash = EXCLUDED.secret_hash");

  // Provision authority for each agent (system/authority role rows).
  // grant_agent_authorization(p_authorizer_agent, p_authorizer_principal, p_operator_token,
  //   p_subject_agent, p_principal, p_role, p_commitment_id, p_scope, p_valid_from, p_valid_until)
  // We provision service-scope authority rows so grants can be issued.
  // Simpler: seed rows directly (testbed) for buyer/provider/evaluator on the commitment.
  const cid = 'c-' + crypto.randomBytes(6).toString('hex');
  sql("INSERT INTO ax_router.commitments (commitment_id, state, capability, terms, version) VALUES ('" + cid + "', 'executing', 'security scan', '{\"buyerAgentId\":\"" + accA.address.toLowerCase() + "\",\"sellerAgentId\":\"" + accB.address.toLowerCase() + "\",\"deliverable\":\"security scan\"}', 1)");
  for (const [role, agent, principal] of [
    ['buyer', accA.address.toLowerCase(), accA.address.toLowerCase()],
    ['provider', accB.address.toLowerCase(), accB.address.toLowerCase()],
    ['evaluator', accC.address.toLowerCase(), accC.address.toLowerCase()],
  ]) {
    sql("INSERT INTO ax_router.agent_authorizations (authz_id, agent_id, principal_identity, commitment_id, role, scope, valid_until) VALUES ('a-" + role + "-" + cid + "', '" + agent + "', '" + principal + "', '" + cid + "', '" + role + "', '{\"actions\":[\"submit_evidence\",\"verify_evidence\",\"list_evidence\"]}', now() + interval '1 hour') ON CONFLICT (agent_id, commitment_id, role) DO UPDATE SET revoked_at = NULL, valid_until = now() + interval '1 hour'");
  }

  // ---- T1: provider submits evidence -----------------------------------------
  const ev = {
    evidenceId: 'evd-' + crypto.randomBytes(6).toString('hex'),
    evidenceType: 'fulfillment_report',
    issuer: SIGNERS.provider,
    subject: SIGNERS.buyer,
    issuanceTimestamp: new Date().toISOString(),
    payload: { reportId: 'r-1', status: 'complete' },
    payloadHash: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ reportId: 'r-1', status: 'complete' }), 'utf8').digest('hex'),
    signature: '0x' + 'ab'.repeat(65),
    verificationScheme: 'eip712',
    commitmentId: cid,
    acceptanceCriterionId: 'criterion-1',
    provenance: { source: 'provider-system', collectedAt: new Date().toISOString() },
  };
  const proof = await signProof(accB, makeProof(accB, accB.address, SCOPES.evidence));
  const r1 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev1' });
  record('T1-provider-submits-evidence', r1.ok && r1.record && r1.record.evidence_id && r1.record.submission_status === 'submitted', r1.ok ? 'id=' + r1.record.evidence_id + ' status=' + r1.record.submission_status : (r1.reason || 'no record'));
  const evidenceId = r1.ok ? r1.record.evidence_id : null;

  // ---- T2: idempotent replay returns the SAME record -------------------------
  if (evidenceId) {
    const r2 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev1' });
    record('T2-idempotent-replay', r2.ok && r2.record.status === 'replayed' && r2.record.evidence_id === evidenceId, r2.ok ? 'replayed id=' + r2.record.evidence_id : (r2.reason || ''));
  } else record('T2-idempotent-replay', false, 'skipped: no evidence id');

  // ---- T3: conflicting payload on same ref is rejected -----------------------
  const ev2 = { ...ev, payload: { reportId: 'r-2', status: 'complete' } };
  const r3 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.provider, proof, evidence: ev2, idempotencyRef: 'ev1' });
  record('T3-conflicting-payload-rejected', !r3.ok && /FINGERPRINT_CONFLICT/i.test(r3.reason || ''), r3.ok ? 'unexpected ok' : (r3.reason || ''));

  // ---- T4: forged submitter identity rejected --------------------------------
  const r4 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.provider, proof: await signProof(accX, makeProof(accX, accX.address, SCOPES.evidence)), evidence: ev, idempotencyRef: 'ev-attack' });
  record('T4-forged-submitter-rejected', !r4.ok && /AUTH_MISSING|PRINCIPAL/i.test(r4.reason || ''), r4.ok ? 'unexpected ok' : (r4.reason || ''));

  // ---- T5: attacker with no authorization rejected ---------------------------
  const r5 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.attacker, proof: await signProof(accX, makeProof(accX, accX.address, SCOPES.evidence)), evidence: ev, idempotencyRef: 'ev-attack2' });
  record('T5-no-authz-rejected', !r5.ok && /AUTH_MISSING/i.test(r5.reason || ''), r5.ok ? 'unexpected ok' : (r5.reason || ''));

  // ---- T6: buyer can also submit ----------------------------------------------
  const r6 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.buyer, proof: await signProof(accA, makeProof(accA, accA.address, SCOPES.evidence)), evidence: { ...ev, payload: { reportId: 'r-buyer' } }, idempotencyRef: 'ev-buyer' });
  record('T6-buyer-submits', r6.ok && r6.record.submission_status === 'submitted', r6.ok ? 'ok' : (r6.reason || ''));

  // ---- T7: evaluator CANNOT submit (role check) ------------------------------
  const r7 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.evaluator, proof: await signProof(accC, makeProof(accC, accC.address, SCOPES.evidence)), evidence: ev, idempotencyRef: 'ev-eval' });
  record('T7-evaluator-cannot-submit', !r7.ok, r7.ok ? 'unexpected ok' : (r7.reason || ''));

  // ---- T8: oversized envelope rejected ----------------------------------------
  const big = { ...ev, payload: { blob: 'x'.repeat(70_000) } };
  const r8 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.provider, proof, evidence: big, idempotencyRef: 'ev-big' });
  // The wrapper's own size guard fires before the RPC (same limit, same
  // intent); accept either the wrapper message or the RPC code.
  record('T8-oversized-rejected', !r8.ok && (/TOO_LARGE/i.test(r8.reason || '') || /exceeds 65536/i.test(r8.reason || '')), r8.ok ? 'unexpected ok' : (r8.reason || ''));

  // ---- T9: verify_evidence by evaluator succeeds -----------------------------
  if (evidenceId) {
    const r9 = await verifyEvidence({ evidenceId, verdict: 'verified', agentId: SIGNERS.evaluator, proof: await signProof(accC, makeProof(accC, accC.address, SCOPES.evidence)), expectedVersion: 1 });
    record('T9-evaluator-verifies', r9.ok && r9.record.verification_status === 'verified', r9.ok ? 'status=' + r9.record.verification_status : (r9.reason || ''));

    // ---- T10: provider CANNOT verify (role check) -----------------------------
    const r10 = await verifyEvidence({ evidenceId, verdict: 'verified', agentId: SIGNERS.provider, proof, expectedVersion: 2 });
    record('T10-provider-cannot-verify', !r10.ok, r10.ok ? 'unexpected ok' : (r10.reason || ''));

    // ---- T11: same-verdict replay is idempotent -------------------------------
    const r11 = await verifyEvidence({ evidenceId, verdict: 'verified', agentId: SIGNERS.evaluator, proof: await signProof(accC, makeProof(accC, accC.address, SCOPES.evidence)), expectedVersion: 2 });
    record('T11-verify-replay-idempotent', r11.ok && r11.record.status === 'replayed', r11.ok ? 'replayed' : (r11.reason || ''));

    // ---- T12: flip-flop rejected (verified -> rejected) ------------------------
    const r12 = await verifyEvidence({ evidenceId, verdict: 'rejected', agentId: SIGNERS.evaluator, proof: await signProof(accC, makeProof(accC, accC.address, SCOPES.evidence)), reason: 'quality issue', expectedVersion: 2 });
    record('T12-flipflop-rejected', !r12.ok && /STATUS_CONFLICT/i.test(r12.reason || ''), r12.ok ? 'unexpected ok' : (r12.reason || ''));
  } else {
    record('T9-evaluator-verifies', false, 'skipped: no evidence id');
    record('T10-provider-cannot-verify', false, 'skipped: no evidence id');
    record('T11-verify-replay-idempotent', false, 'skipped: no evidence id');
    record('T12-flipflop-rejected', false, 'skipped: no evidence id');
  }

  // ---- T13: list_evidence by authorized provider -----------------------------
  const r13 = await listEvidence({ commitmentId: cid, agentId: SIGNERS.provider, proof });
  record('T13-list-authorized', r13.ok && r13.record.count >= 1 && Array.isArray(r13.record.evidence), r13.ok ? 'count=' + r13.record.count : (r13.reason || ''));

  // ---- T14: list_evidence by unauthorized attacker rejected ------------------
  const r14 = await listEvidence({ commitmentId: cid, agentId: SIGNERS.attacker, proof: await signProof(accX, makeProof(accX, accX.address, SCOPES.evidence)) });
  record('T14-list-unauthorized-rejected', !r14.ok && /AUTH_MISSING/i.test(r14.reason || ''), r14.ok ? 'unexpected ok' : (r14.reason || ''));

  // ---- T15: cross-commitment access rejected ----------------------------------
  const cid2 = 'c-' + crypto.randomBytes(6).toString('hex');
  sql("INSERT INTO ax_router.commitments (commitment_id, state, capability, terms, version) VALUES ('" + cid2 + "', 'executing', 'other scan', '{}', 1)");
  const r15 = await listEvidence({ commitmentId: cid2, agentId: SIGNERS.provider, proof });
  record('T15-cross-commitment-rejected', !r15.ok && /AUTH_MISSING/i.test(r15.reason || ''), r15.ok ? 'unexpected ok' : (r15.reason || ''));

  // ---- T16: revoked authorization rejected -----------------------------------
  sql("UPDATE ax_router.agent_authorizations SET revoked_at = now() WHERE authz_id = 'a-provider-" + cid + "'");
  const r16 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev-revoked' });
  record('T16-revoked-authz-rejected', !r16.ok && /AUTH_REVOKED/i.test(r16.reason || ''), r16.ok ? 'unexpected ok' : (r16.reason || ''));

  // ---- T17: expired authorization rejected ------------------------------------
  sql("INSERT INTO ax_router.agent_authorizations (authz_id, agent_id, principal_identity, commitment_id, role, scope, valid_until) VALUES ('a-exp-" + cid + "', '" + SIGNERS.provider + "', '" + SIGNERS.provider + "', '" + cid + "', 'provider', '{\"actions\":[\"submit_evidence\"]}', now() - interval '1 minute') ON CONFLICT (agent_id, commitment_id, role) DO UPDATE SET valid_until = now() - interval '1 minute', revoked_at = NULL");
  const r17 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev-expired' });
  record('T17-expired-authz-rejected', !r17.ok && /AUTH_EXPIRED/i.test(r17.reason || ''), r17.ok ? 'unexpected ok' : (r17.reason || ''));

  // ---- T18: malformed envelope rejected ----------------------------------------
  const r18 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: SIGNERS.buyer, proof: await signProof(accA, makeProof(accA, accA.address, SCOPES.evidence)), evidence: 'not-an-object', idempotencyRef: 'ev-malformed' });
  record('T18-malformed-envelope-rejected', !r18.ok, r18.ok ? 'unexpected ok' : (r18.reason || ''));

  // ---- T19: no side effect on rejected operations ------------------------------
  const cnt = Number(sql("SELECT count(*) FROM ax_router.commitment_evidence WHERE commitment_id = '" + cid + "'"));
  // Expect: ev1 (provider), ev-buyer (buyer) — 2 rows. The rejected ops (attack,
  // attack2, eval, big, revoked, expired, malformed) must NOT have inserted.
  record('T19-no-side-effect-on-rejects', cnt === 2, 'rows=' + cnt + ' (expected 2)');

  // ---- T20: concurrent same-ref submissions -> exactly one row ----------------
  const cid3 = 'c-' + crypto.randomBytes(6).toString('hex');
  sql("INSERT INTO ax_router.commitments (commitment_id, state, capability, terms, version) VALUES ('" + cid3 + "', 'executing', 'scan3', '{}', 1)");
  sql("INSERT INTO ax_router.agent_authorizations (authz_id, agent_id, principal_identity, commitment_id, role, scope, valid_until) VALUES ('a-p3-" + cid3 + "', '" + SIGNERS.provider + "', '" + SIGNERS.provider + "', '" + cid3 + "', 'provider', '{\"actions\":[\"submit_evidence\"]}', now() + interval '1 hour') ON CONFLICT (agent_id, commitment_id, role) DO UPDATE SET revoked_at = NULL, valid_until = now() + interval '1 hour'");
  const concurrency = await Promise.allSettled([
    submitEvidence({ commitmentId: cid3, criterionId: 'c-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev-conc' }),
    submitEvidence({ commitmentId: cid3, criterionId: 'c-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev-conc' }),
    submitEvidence({ commitmentId: cid3, criterionId: 'c-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev-conc' }),
    submitEvidence({ commitmentId: cid3, criterionId: 'c-1', agentId: SIGNERS.provider, proof, evidence: ev, idempotencyRef: 'ev-conc' }),
  ]);
  const rows3 = Number(sql("SELECT count(*) FROM ax_router.commitment_evidence WHERE commitment_id = '" + cid3 + "' AND idempotency_ref = 'ev-conc'"));
  const winners = concurrency.filter((s) => s.status === 'fulfilled' && s.value.ok && s.value.record.status === 'submitted').length;
  const replays = concurrency.filter((s) => s.status === 'fulfilled' && s.value.ok && s.value.record.status === 'replayed').length;
  record('T20-concurrent-same-ref-one-row', rows3 === 1 && winners === 1, 'rows=' + rows3 + ' winners=' + winners + ' replays=' + replays);

  // ---- T21: distinct refs -> distinct rows ------------------------------------
  const r21 = await submitEvidence({ commitmentId: cid3, criterionId: 'c-1', agentId: SIGNERS.provider, proof, evidence: { ...ev, payload: { reportId: 'r-second' } }, idempotencyRef: 'ev-conc-2' });
  const rowsDistinct = Number(sql("SELECT count(*) FROM ax_router.commitment_evidence WHERE commitment_id = '" + cid3 + "'"));
  record('T21-distinct-refs-distinct-rows', r21.ok && rowsDistinct === 2, 'rows=' + rowsDistinct + ' (expected 2) second=' + (r21.ok ? 'ok' : (r21.reason || 'err')));

  // ---- Cleanup: drop test rows -------------------------------------------------
  sql("DELETE FROM ax_router.commitment_evidence WHERE commitment_id IN ('" + cid + "','" + cid2 + "','" + cid3 + "')");
  sql("DELETE FROM ax_router.agent_authorizations WHERE commitment_id IN ('" + cid + "','" + cid2 + "','" + cid3 + "')");
  sql("DELETE FROM ax_router.commitments WHERE commitment_id IN ('" + cid + "','" + cid2 + "','" + cid3 + "')");

  console.log('\n==== PHASE 3 EVIDENCE LIFECYCLE RESULT: ' + PASS + '/' + (PASS + FAIL) + ' PASS ====');
  if (FAIL) { console.log('FAILED: ' + failures.join(', ')); process.exitCode = 1; }
})();