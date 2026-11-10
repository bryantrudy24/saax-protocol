// SAAX Protocol — Day 15, Item 1: Evidence/Attestation test harness
// Run: node scripts/test-evidence.js
//
// Seven tests (per the Task Brief Step 5):
//   T1  Valid evidence from an approved issuer with a valid signature binds to
//       a commitment and satisfies its criterion
//   T2  Evidence with a bad signature fails validation
//   T3  Evidence bound to the wrong commitment fails binding
//   T4  Evidence older than maxEvidenceAge fails the freshness check
//   T5  Evidence with minimumEvidenceCount unmet returns insufficient_evidence
//   T6  Evidence with an unapproved issuer fails when the allowlist is present
//   T7  Payload tampering (hash mismatch) fails validation
//
// Signature scheme: eip712 via viem signTypedData/verifyTypedData over the
// EVIDENCE domain (real cryptographic verification — not emulation).

'use strict';

process.env.SAAX_IDEMPOTENCY_STORE = 'memory';

const crypto = require('crypto');
const { privateKeyToAccount, signTypedData } = require('viem/accounts');
const evidenceMod = require('../endpoint/evidence.js');

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  if (ok) passed++;
  else { failures++; console.log('  FAIL', name, detail ? '| ' + detail : ''); }
  return ok;
};

// ---- key material -----------------------------------------------------------
// Separate KEY + ADDRESS pairs: keys sign (viem needs the hex), addresses fill
// typed-data fields / allowlists.
const APPROVED_KEY = '0x' + 'ab'.repeat(32);
const APPROVED_ISSUER = privateKeyToAccount(APPROVED_KEY).address;  // sensor/oracle
const UNKNOWN_KEY = '0x' + 'cd'.repeat(32);
const UNKNOWN_ISSUER = privateKeyToAccount(UNKNOWN_KEY).address;    // not on the allowlist
const SUBJECT_KEY = '0x' + 'ef'.repeat(32);
const SUBJECT = privateKeyToAccount(SUBJECT_KEY).address;           // the commitment buyer/asset
const SELLER = privateKeyToAccount('0x' + '44'.repeat(32)).address; // real 40-char address
const OTHER_COMMITMENT = '0x' + '11'.repeat(32);

async function makeEvidence({ issuerKey, overrides = {}, sign = true, hashPayloadHash = null }) {
  const issuerAcct = privateKeyToAccount(issuerKey);
  const issuer = overrides.issuer || issuerAcct.address;
  const base = {
    evidenceId: '0x' + crypto.randomBytes(32).toString('hex'),
    evidenceType: 'temperature-reading',
    issuer,
    subject: overrides.subject || SUBJECT,
    issuanceTimestamp: overrides.issuanceTimestamp || new Date().toISOString(),
    contextReference: '0x' + '22'.repeat(32),
    payload: overrides.payload || { temperature: 3.5, unit: 'C' },
    provenance: overrides.provenance || { kind: 'chain', source: 'oracle.sensor-a', sourceTx: '0x' + '33'.repeat(32) },
    verificationScheme: 'eip712',
    commitmentId: overrides.commitmentId || '0x' + 'aa'.repeat(32),
    acceptanceCriterionId: overrides.acceptanceCriterionId || '0x' + 'bb'.repeat(32),
  };
  const payloadHash = hashPayloadHash !== null
    ? hashPayloadHash
    : evidenceMod.hashPayload(base.payload);
  base.payloadHash = payloadHash;
  if (sign) {
    const sig = await signTypedData({
      privateKey: issuerKey,
      types: evidenceMod.EVIDENCE_TYPES,
      primaryType: 'Evidence',
      message: {
        evidenceId: base.evidenceId,
        issuer: base.issuer,
        subject: base.subject,
        commitmentId: base.commitmentId,
        acceptanceCriterionId: base.acceptanceCriterionId,
        payloadHash: base.payloadHash,
      },
      domain: { name: evidenceMod.EVIDENCE_DOMAIN_NAME, version: evidenceMod.EVIDENCE_DOMAIN_VERSION },
    });
    base.signature = sig;
  } else {
    base.signature = '0xdeadbeef'; // invalid sig
  }
  return base;
}

// ---- a valid commitment with one acceptance criterion + verification policy --
function makeCommitment(extra = {}) {
  return {
    commitmentId: '0x' + 'aa'.repeat(32),
    buyerAgentId: SUBJECT,
    sellerAgentId: SELLER,
    capability: 'cold-chain-delivery',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: {
      type: 'temperature',
      value: '<= 5C',
      verificationPolicies: [{
        criterionId: '0x' + 'bb'.repeat(32),
        criterionDescription: 'delivery temperature <= 5C',
        requiredEvidenceType: 'temperature-reading',
        acceptedIssuers: [APPROVED_ISSUER],
        verificationScheme: 'eip712',
        evaluationLogic: 'payload.temperature <= 5',
        maxEvidenceAge: 3600,
        minimumEvidenceCount: 1,
      }],
    },
    deadline: '2026-10-07T12:00:00Z',
    ...extra,
  };
}

// ============================================================================
// T1 — VALID evidence from an approved issuer, valid signature, binds to the
//      commitment, satisfies the criterion
// ============================================================================
(async function run() {
  const commitment = makeCommitment();
  const ev = await makeEvidence({ issuerKey: APPROVED_KEY, overrides: { commitmentId: commitment.commitmentId } });

  const v = await evidenceMod.validateEvidence(ev, commitment);
  check('T1a validateEvidence ok', v.ok, v.reason);

  const evalRes = await evidenceMod.evaluateCriterion(commitment.acceptanceCriteria.verificationPolicies[0], [ev], { commitment });
  check('T1b evaluateCriterion satisfied', evalRes.outcome === 'satisfied', evalRes.reason);

  const rec = evidenceMod.recordOutcome(commitment.commitmentId, '0x' + 'bb'.repeat(32), 'satisfied', [ev.evidenceId], { commitment });
  check('T1c recordOutcome writes on commitment', rec && rec.evidenceOutcomes && rec.evidenceOutcomes['0x' + 'bb'.repeat(32)].outcome === 'satisfied');

  // ---- T2 — bad signature fails --------------------------------------------
  const badSig = await makeEvidence({ issuerKey: APPROVED_KEY, overrides: { commitmentId: commitment.commitmentId }, sign: false });
  const v2 = await evidenceMod.validateEvidence(badSig, commitment);
  check('T2 bad signature rejected', !v2.ok, v2.reason);

  // ---- T3 — wrong commitment binding fails ----------------------------------
  const wrongCommit = await makeEvidence({ issuerKey: APPROVED_KEY, overrides: { commitmentId: OTHER_COMMITMENT } });
  const v3 = await evidenceMod.validateEvidence(wrongCommit, commitment);
  check('T3 wrong commitment binding rejected', !v3.ok && v3.stage === 'binding', v3.reason);

  // ---- T4 — evidence older than maxEvidenceAge fails ------------------------
  const stale = await makeEvidence({
    issuerKey: APPROVED_KEY,
    overrides: {
      commitmentId: commitment.commitmentId,
      issuanceTimestamp: new Date(Date.now() - 7200 * 1000).toISOString(), // 2h old > 3600s
    },
  });
  const evalStale = await evidenceMod.evaluateCriterion(commitment.acceptanceCriteria.verificationPolicies[0], [stale], { commitment });
  check('T4 stale evidence not_satisfied (freshness)', evalStale.outcome === 'not_satisfied', evalStale.reason);

  // ---- T5 — minimumEvidenceCount unmet returns insufficient_evidence ---------
  const policyMin2 = {
    criterionId: '0x' + 'bb'.repeat(32),
    requiredEvidenceType: 'temperature-reading',
    acceptedIssuers: [APPROVED_ISSUER],
    verificationScheme: 'eip712',
    evaluationLogic: 'payload.temperature <= 5',
    maxEvidenceAge: 3600,
    minimumEvidenceCount: 2, // only 1 supplied
  };
  const evalMin = await evidenceMod.evaluateCriterion(policyMin2, [ev], { commitment });
  check('T5 min count unmet -> insufficient_evidence', evalMin.outcome === 'insufficient_evidence', evalMin.reason);

  // ---- T6 — unapproved issuer fails when allowlist present -------------------
  const rogue = await makeEvidence({ issuerKey: UNKNOWN_KEY, overrides: { commitmentId: commitment.commitmentId } });
  const evalRogue = await evidenceMod.evaluateCriterion(commitment.acceptanceCriteria.verificationPolicies[0], [rogue], { commitment });
  check('T6 unapproved issuer rejected (allowlist)', evalRogue.outcome === 'not_satisfied', evalRogue.reason);

  // ---- T7 — payload tampering (hash mismatch) fails validation ---------------
  const tampered = await makeEvidence({
    issuerKey: APPROVED_KEY,
    overrides: {
      commitmentId: commitment.commitmentId,
      payload: { temperature: 8.5, unit: 'C' }, // tampered AFTER signing
    },
  });
  // recompute the hash from the tampered payload so the signature still matches
  // the ORIGINAL payload hash -> the hash-vs-payload mismatch is the tamper check
  const badHash = await makeEvidence({
    issuerKey: APPROVED_KEY,
    overrides: { commitmentId: commitment.commitmentId },
    sign: true,
    hashPayloadHash: 'sha256:' + '00'.repeat(32), // arbitrary, differs from actual
  });
  const v7 = await evidenceMod.validateEvidence(badHash, commitment);
  check('T7 payload tamper (hash mismatch) rejected', !v7.ok && v7.stage === 'payload-hash', v7.reason);

  // ---- summary ----------------------------------------------------------------
  console.log('----');
  console.log('evidence tests: ' + passed + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e.message || e);
  process.exit(2);
});