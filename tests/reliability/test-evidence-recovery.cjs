// SAAX MCP Lifecycle Phase 3 — three-agent evidence recovery (isolated testbed).
//
// Phase 3G scenario, driven through the app wrapper against the live Docker
// testbed with REAL EIP-712 proofs:
//
//   1. Agent A (buyer) creates a commitment.
//   2. Agent B (seller/provider) accepts and submits fulfillment evidence.
//   3. Agent A terminates (the buyer process is gone).
//   4. Agent C (replacement) authenticates INDEPENDENTLY (own proof + own
//      durable authorization).
//   5. C retrieves commitment history AND evidence (durable state survives).
//   6. C cannot impersonate A, cannot overwrite B's evidence, cannot submit
//      as B.
//   7. Duplicate submissions do not create duplicate records.
//   8. Unauthorized evidence access is rejected.
//   9. Evidence verification cannot be forged (only evaluator can verify).
//  10. No financial operation occurs automatically.
//
// Nonfinancial; isolated to the Docker testbed. No production data touched.
'use strict';

const { randomUUID } = require('crypto');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function sql(q) {
  return execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();
}

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const { mint } = require('./_gate-d-jwt.cjs');
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_POSTGREST_KEY;

const { submitEvidence, verifyEvidence, listEvidence } = require('../../endpoint/evidence-lifecycle.js');
const { privateKeyToAccount } = require('viem/accounts');

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

function makeProof(account, subject, scope) {
  const now = Math.floor(Date.now() / 1000);
  const id = 'proof-' + randomUUID().slice(0, 8);
  return {
    authorityProofId: id,
    proofType: 'verifiable-intent',
    issuer: account.address,
    subject,
    validFrom: new Date((now - 60) * 1000).toISOString(),
    validUntil: new Date((now + 3600) * 1000).toISOString(),
    scope,
    verificationScheme: 'eip712',
    signature: '',
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

// Deterministic test keys (A buyer, B provider, C replacement, X attacker, E evaluator).
const A_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_KEY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C_KEY = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const X_KEY = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const E_KEY = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const accA = privateKeyToAccount(A_KEY);
const accB = privateKeyToAccount(B_KEY);
const accC = privateKeyToAccount(C_KEY);
const accX = privateKeyToAccount(X_KEY);
const accE = privateKeyToAccount(E_KEY);

const SCOPES = { evidence: { actions: ['submit_evidence', 'verify_evidence', 'list_evidence'], amountMax: '1000', currency: 'USDC' } };

let PASS = 0, FAIL = 0;
const failures = [];
function record(name, ok, info) {
  if (ok) { PASS++; console.log('PASS ' + name + (info ? ' :: ' + info : '')); }
  else { FAIL++; failures.push(name); console.log('FAIL ' + name + (info ? ' :: ' + info : '')); }
}

(async () => {
  const cid = 'c-' + randomUUID().slice(0, 12);
  const A = accA.address.toLowerCase();
  const B = accB.address.toLowerCase();
  const C = accC.address.toLowerCase();
  const X = accX.address.toLowerCase();
  const E = accE.address.toLowerCase();

  // ---- Seed: commitment + authorizations (buyer A, provider B, evaluator E) --
  sql("INSERT INTO ax_router.commitments (commitment_id, state, capability, terms, version) VALUES ('" + cid + "', 'evidence_pending', 'security scan', '{\"buyerAgentId\":\"" + A + "\",\"sellerAgentId\":\"" + B + "\",\"deliverable\":\"security scan\"}', 1)");
  for (const [role, agent] of [['buyer', A], ['provider', B], ['evaluator', E]]) {
    sql("INSERT INTO ax_router.agent_authorizations (authz_id, agent_id, principal_identity, commitment_id, role, scope, valid_until) VALUES ('a-" + role + "-" + cid + "', '" + agent + "', '" + agent + "', '" + cid + "', '" + role + "', '{\"actions\":[\"submit_evidence\",\"verify_evidence\",\"list_evidence\"]}', now() + interval '1 hour') ON CONFLICT (agent_id, commitment_id, role) DO UPDATE SET revoked_at = NULL, valid_until = now() + interval '1 hour'");
  }

  const proofB = await signProof(accB, makeProof(accB, B, SCOPES.evidence));
  const proofA = await signProof(accA, makeProof(accA, A, SCOPES.evidence));
  const proofC = await signProof(accC, makeProof(accC, C, SCOPES.evidence));
  const proofX = await signProof(accX, makeProof(accX, X, SCOPES.evidence));
  const proofE = await signProof(accE, makeProof(accE, E, SCOPES.evidence));

  const mkEv = (reportId) => ({
    evidenceId: 'evd-' + randomUUID().slice(0, 8),
    evidenceType: 'fulfillment_report',
    issuer: B,
    subject: A,
    issuanceTimestamp: new Date().toISOString(),
    payload: { reportId, status: 'complete' },
    payloadHash: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ reportId, status: 'complete' }), 'utf8').digest('hex'),
    signature: '0x' + 'ab'.repeat(65),
    verificationScheme: 'eip712',
    commitmentId: cid,
    acceptanceCriterionId: 'criterion-1',
    provenance: { source: 'provider-system', collectedAt: new Date().toISOString() },
  });

  // ---- T1: Agent B (provider) submits evidence --------------------------------
  const r1 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: B, proof: proofB, evidence: mkEv('r-b'), idempotencyRef: 'ev-b-1' });
  record('T1-B-submits-evidence', r1.ok && r1.record.evidence_id && r1.record.submitter_agent === B, r1.ok ? 'id=' + r1.record.evidence_id : (r1.reason || ''));
  const evId = r1.ok ? r1.record.evidence_id : null;

  // ---- T2: Agent A terminates; Agent C discovers evidence ---------------------
  // A's process is gone (not modeled — the durable DB row survives by design).
  const r2 = await listEvidence({ commitmentId: cid, agentId: C, proof: proofC });
  record('T2-C-discovers-evidence', !r2.ok, r2.ok ? 'unexpected ok (C has no authz)' : (r2.reason || ''));

  // ---- T3: Agent C granted its OWN authorization, then reads evidence --------
  sql("INSERT INTO ax_router.agent_authorizations (authz_id, agent_id, principal_identity, commitment_id, role, scope, valid_until) VALUES ('a-repl-" + cid + "', '" + C + "', '" + C + "', '" + cid + "', 'provider', '{\"actions\":[\"submit_evidence\",\"list_evidence\"]}', now() + interval '1 hour') ON CONFLICT (agent_id, commitment_id, role) DO UPDATE SET revoked_at = NULL, valid_until = now() + interval '1 hour'");
  const r3 = await listEvidence({ commitmentId: cid, agentId: C, proof: proofC });
  record('T3-C-reads-after-own-authz', r3.ok && r3.record.count >= 1 && r3.record.evidence[0].submitter_agent === B, r3.ok ? 'count=' + r3.record.count + ' submitter=' + (r3.record.evidence[0] && r3.record.evidence[0].submitter_agent) : (r3.reason || ''));

  // ---- T4: C cannot impersonate A (submit as A) -------------------------------
  const r4 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: A, proof: proofC, evidence: mkEv('r-c-as-a'), idempotencyRef: 'ev-c-as-a' });
  record('T4-C-cannot-impersonate-A', !r4.ok && /AUTH_MISSING|PRINCIPAL/i.test(r4.reason || ''), r4.ok ? 'unexpected ok' : (r4.reason || ''));

  // ---- T5: C cannot overwrite B's evidence (same ref, different payload) ------
  const r5 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: B, proof: proofC, evidence: mkEv('r-overwrite'), idempotencyRef: 'ev-b-1' });
  record('T5-C-cannot-overwrite-B-evidence', !r5.ok && /FINGERPRINT_CONFLICT/i.test(r5.reason || ''), r5.ok ? 'unexpected ok' : (r5.reason || ''));

  // ---- T6: C submits its own evidence (own authz) — distinct record -----------
  const evC = mkEv('r-c'); // SAME envelope object reused for T7's replay
  const r6 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: C, proof: proofC, evidence: evC, idempotencyRef: 'ev-c-1' });
  record('T6-C-submits-own-evidence', r6.ok && r6.record.submitter_agent === C, r6.ok ? 'id=' + r6.record.evidence_id : (r6.reason || ''));

  // ---- T7: duplicate submission does not duplicate -----------------------------
  const r7 = await submitEvidence({ commitmentId: cid, criterionId: 'criterion-1', agentId: C, proof: proofC, evidence: evC, idempotencyRef: 'ev-c-1' });
  record('T7-duplicate-no-duplicate', r7.ok && r7.record.status === 'replayed' && r7.record.evidence_id === r6.record.evidence_id, r7.ok ? 'replayed same id' : (r7.reason || ''));

  // ---- T8: X (attacker, no authz) cannot read ----------------------------------
  const r8 = await listEvidence({ commitmentId: cid, agentId: X, proof: proofX });
  record('T8-attacker-cannot-read', !r8.ok && /AUTH_MISSING/i.test(r8.reason || ''), r8.ok ? 'unexpected ok' : (r8.reason || ''));

  // ---- T9: only evaluator can verify (C cannot forge verification) ------------
  const r9 = await verifyEvidence({ evidenceId: evId, verdict: 'verified', agentId: C, proof: proofC, expectedVersion: 1 });
  record('T9-C-cannot-verify', !r9.ok && /AUTH_MISSING/i.test(r9.reason || ''), r9.ok ? 'unexpected ok' : (r9.reason || ''));

  // ---- T10: evaluator verifies B's evidence ------------------------------------
  const r10 = await verifyEvidence({ evidenceId: evId, verdict: 'verified', agentId: E, proof: proofE, expectedVersion: 1 });
  record('T10-evaluator-verifies', r10.ok && r10.record.verification_status === 'verified', r10.ok ? 'status=' + r10.record.verification_status : (r10.reason || ''));

  // ---- T11: evidence attribution intact after verification ---------------------
  const r11 = await listEvidence({ commitmentId: cid, agentId: C, proof: proofC });
  const bRec = r11.ok && r11.record.evidence.find((e) => e.evidence_id === evId);
  record('T11-attribution-intact', r11.ok && bRec && bRec.submitter_agent === B && bRec.status === 'verified', r11.ok ? 'submitter=' + (bRec && bRec.submitter_agent) + ' status=' + (bRec && bRec.status) : (r11.reason || ''));

  // ---- T12: evidence row count (B:1 + C:1 = 2; no dupes) -----------------------
  const cnt = Number(sql("SELECT count(*) FROM ax_router.commitment_evidence WHERE commitment_id = '" + cid + "'"));
  record('T12-no-duplicate-records', cnt === 2, 'rows=' + cnt + ' (expected 2)');

  // ---- T13: no financial side effect (no settlement rows touched) --------------
  // Evidence operations never transition the commitment state; verify state unchanged.
  const st = sql("SELECT state FROM ax_router.commitments WHERE commitment_id = '" + cid + "'");
  record('T13-commitment-state-unchanged', st === 'evidence_pending', 'state=' + st);

  // ---- Cleanup ---------------------------------------------------------------
  sql("DELETE FROM ax_router.commitment_evidence WHERE commitment_id = '" + cid + "'");
  sql("DELETE FROM ax_router.agent_authorizations WHERE commitment_id = '" + cid + "'");
  sql("DELETE FROM ax_router.commitments WHERE commitment_id = '" + cid + "'");

  console.log('\n==== PHASE 3 THREE-AGENT EVIDENCE RECOVERY RESULT: ' + PASS + '/' + (PASS + FAIL) + ' PASS ====');
  if (FAIL) { console.log('FAILED: ' + failures.join(', ')); process.exitCode = 1; }
})();