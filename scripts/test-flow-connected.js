// SAAX Protocol — Connected Flow Test (Capability 1 + 2 + fulfillment)
//
// Proves the END-TO-END flow the build requires, WITHOUT any network:
//   authorized agreement -> confirmed EAS anchor -> verified escrow funding
//   -> execution -> evidence -> verification -> authorized release
//
// Uses the REAL modules (commitment.js, eas.js, escrow.js, evidence.js) with
// mock-safe modes (SAAX_EAS_MODE=mock, no chain write; evidence uses the
// eip712 structural verifier hook). This is the integration test that proves
// the three capabilities connect on the same versioned commitment digest.
'use strict';

process.env.SAAX_X402_MODE = 'mock';
process.env.SAAX_EAS_MODE = 'mock';
const commitmentMod = require('../endpoint/commitment.js');
const eas = require('../endpoint/eas.js');
const escrow = require('../endpoint/escrow.js');
const evidence = require('../endpoint/evidence.js');

let passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); process.exitCode = 1; }
}

(async () => {
  console.log('--- Connected flow test: agreement -> anchor -> escrow -> evidence -> release ---');

  // 1. Authorized agreement (commitment manifest with canonical digest)
  const manifest = commitmentMod.buildManifest({
    commitmentId: commitmentMod.newCommitmentId(),
    buyerAgentId: '0x1111111111111111111111111111111111111111',
    sellerAgentId: '0x2222222222222222222222222222222222222222',
    capability: 'security-scan',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash', value: 'sha256:saax-protocol-phase1' },
    deadline: '2026-10-05T12:00:00Z',
    cancelCondition: 'buyer-cancel-before-delivery',
  });
  check('agreement manifest built', !!manifest.commitmentId && !!manifest.manifestHash, manifest.manifestHash.slice(0, 24) + '...');

  // 2. Confirmed EAS anchor (mock mode: deterministic UID binding the digest)
  const anchorRes = await eas.attestCommitment({
    commitmentId: manifest.commitmentId,
    commitmentDigest: manifest.manifestHash,
    parties: JSON.stringify({ buyer: manifest.buyerAgentId, seller: manifest.sellerAgentId }),
    requestedOutcome: JSON.stringify({ description: manifest.capability }),
    providerObligation: JSON.stringify({ description: manifest.capability }),
    commercialTerms: JSON.stringify(manifest.price || {}),
    paymentTerms: JSON.stringify({ amount: manifest.price.amount, currency: manifest.price.currency }),
    acceptanceCriteria: JSON.stringify([manifest.acceptanceCriteria || {}]),
    deadline: manifest.deadline,
    failureConditions: JSON.stringify([{ condition: 'provider_obligation_unfulfilled' }]),
    recoveryPolicy: JSON.stringify({ maxRetries: 0, refundOnFailure: true }),
    refundsCompensation: JSON.stringify({ refundOnTotalFailure: true }),
    lifecycleState: 'issued',
  });
  check('anchor confirmed (mock)', anchorRes.ok === true && !!anchorRes.anchor.uid, anchorRes.anchor.uid.slice(0, 18) + '...');
  check('anchor binds the manifest digest', anchorRes.anchor.commitmentDigest === manifest.manifestHash.replace('sha256:', '0x'));

  // 3. Verified escrow funding (bound to the SAME digest)
  const fund = escrow.fund({
    commitmentId: manifest.commitmentId,
    commitmentDigest: manifest.manifestHash, // sha256: form, normalized by escrow
    amount: manifest.price.amount,
    asset: manifest.price.currency,
    txRef: { txHash: '0x' + 'ab'.repeat(32), rail: 'x402' },
  });
  check('escrow funded', fund.ok === true && fund.escrow.state === escrow.STATES.FUNDED, fund.escrow.state);
  check('escrow bound to same digest', fund.escrow.commitmentDigest === manifest.manifestHash.replace('sha256:', '').toLowerCase());

  // 4. Execution -> evidence submission -> verification -> authorized release
  escrow.hold({ commitmentId: manifest.commitmentId, commitmentDigest: manifest.manifestHash });
  check('escrow held (execution complete)', escrow.escrowStatus(manifest.commitmentId).state === escrow.STATES.HELD);

  // Evidence: valid eip712-signed evidence bound to the commitment + criterion
  const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
  const crypto = require('crypto');
  const issuerKey = privateKeyToAccount(generatePrivateKey());
  const payload = { complete: true };
  const payloadHash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const sig = await issuerKey.signTypedData({
    domain: { name: evidence.EVIDENCE_DOMAIN_NAME, version: evidence.EVIDENCE_DOMAIN_VERSION },
    types: evidence.EVIDENCE_TYPES,
    primaryType: 'Evidence',
    message: {
      evidenceId: '0x' + '77'.repeat(32),
      issuer: issuerKey.address,
      subject: manifest.buyerAgentId,
      commitmentId: manifest.commitmentId,
      acceptanceCriterionId: 'c1',
      payloadHash,
    },
  });
  const evidenceRecord = {
    evidenceId: '0x' + '77'.repeat(32),
    evidenceType: 'completion-report',
    issuer: issuerKey.address,
    subject: manifest.buyerAgentId,
    issuanceTimestamp: new Date().toISOString(),
    contextReference: manifest.commitmentId,
    payload,
    payloadHash,
    provenance: { source: 'inspector', kind: 'external' },
    signature: sig,
    verificationScheme: 'eip712',
    verificationMaterial: issuerKey.address,
    commitmentId: manifest.commitmentId,
    acceptanceCriterionId: 'c1',
  };

  // Attestation abstraction (Day 15 Item 1) — evaluateCriterion(criterion, [evidence])
  const criterion = {
    criterionId: 'c1',
    description: 'completion report submitted',
    verificationPolicy: {
      criterionId: 'c1',
      requiredEvidenceType: 'completion-report',
      acceptedIssuers: [issuerKey.address],
      verificationScheme: 'eip712',
      evaluationLogic: 'payload.complete == true',
      maxEvidenceAge: 86400,
      minimumEvidenceCount: 1,
    },
  };
  const outcome = await evidence.evaluateCriterion(criterion, [evidenceRecord], {});
  check('evidence verification: satisfied', outcome.outcome === 'satisfied', outcome.outcome);

  // AUTHORIZED RELEASE — the verdict gates it
  const release = escrow.release({
    commitmentId: manifest.commitmentId,
    commitmentDigest: manifest.manifestHash,
    verdict: { outcome: outcome.outcome, evidenceRefs: [evidenceRecord.evidenceId] },
    evidenceRefs: [evidenceRecord.evidenceId],
  });
  check('authorized release', release.ok === true && release.escrow.state === escrow.STATES.RELEASED, release.escrow.state);
  check('release verdict records evidence', release.escrow.releaseVerdict.evidenceRefs.length === 1);

  // 5. Independent verification WITHOUT trusting the DB:
  //    a) the anchor is resolvable (deterministic UID + schema)
  //    b) the escrow audit chain is intact
  const audit = escrow.verifyAuditChain(manifest.commitmentId);
  check('escrow audit chain independently verifies', audit.verified === true, audit.reason);
  check('anchor uid + schema present (independently checkable)', /^0x[a-fA-F0-9]{64}$/.test(anchorRes.anchor.uid) && /^0x[a-fA-F0-9]{64}$/.test(anchorRes.anchor.schemaUid));

  // 6. Refund path (dispute -> refund) on a fresh commitment
  const m2 = commitmentMod.buildManifest({
    commitmentId: commitmentMod.newCommitmentId(),
    buyerAgentId: '0x1111111111111111111111111111111111111111',
    sellerAgentId: '0x2222222222222222222222222222222222222222',
    capability: 'security-scan',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash', value: 'sha256:saax-protocol-phase1' },
    deadline: '2026-10-05T12:00:00Z',
    cancelCondition: 'buyer-cancel-before-delivery',
  });
  escrow.fund({ commitmentId: m2.commitmentId, commitmentDigest: m2.manifestHash, amount: m2.price.amount, asset: m2.price.currency, txRef: { txHash: '0x' + 'cd'.repeat(32) } });
  escrow.hold({ commitmentId: m2.commitmentId, commitmentDigest: m2.manifestHash });
  escrow.dispute({ commitmentId: m2.commitmentId, commitmentDigest: m2.manifestHash, raisedBy: 'buyer', reason: 'delivery not as agreed' });
  const refund = escrow.refund({ commitmentId: m2.commitmentId, commitmentDigest: m2.manifestHash, reason: 'dispute resolved to refund' });
  check('dispute -> refund completes', refund.ok === true && refund.escrow.state === escrow.STATES.REFUNDED, refund.escrow.state);

  console.log('---');
  console.log(passed + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ''));
})();