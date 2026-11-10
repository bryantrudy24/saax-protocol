// SAAX Protocol — EAS anchoring unit test (memory-safe, no network writes)
//
// Proves the EAS anchoring layer's deterministic, tamper-evident properties
// WITHOUT any chain interaction (SAAX_EAS_MODE=mock by default in eas.js):
//   1. schema UID is deterministic 0x+64 hex
//   2. same commitment -> same attestation UID (mock derivation)
//   3. encode/decode round-trip preserves commitmentDigest + commitmentId
//   4. verifyAnchor fails closed on a zero/unknown UID (no throw)
//   5. tampering with the digest changes the UID + data (anchor binding)
'use strict';

const assert = require('assert');
const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');
// The module is mock-safe: SAAX_EAS_MODE defaults to 'mock' -> NO network.
process.env.SAAX_EAS_MODE = 'mock';
const eas = require('../endpoint/eas.js');

let passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); process.exitCode = 1; }
}

const commitment = {
  commitmentId: '0x9c2f1d9a0f8e6b4d3a1c7e5f8b0d2a4c6e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b',
  commitmentDigest: '0x7a3f9c1e2b4d5f6a8c0e1d2b3a4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c',
  parties: JSON.stringify({ buyer: '0x1111111111111111111111111111111111111111', seller: '0x2222222222222222222222222222222222222222' }),
  requestedOutcome: JSON.stringify({ description: 'Deliver a cold-chain temperature report for shipment S-1042', category: 'data-delivery' }),
  providerObligation: JSON.stringify({ description: 'Produce a signed temperature-reading report', target: 'report.validity == full-transit' }),
  commercialTerms: JSON.stringify({ currency: 'USD', price: '50000', fee: '2500', feePayer: 'buyer' }),
  paymentTerms: JSON.stringify({ amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', settlementRequirement: { rail: null, amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: '0x2222222222222222222222222222222222222222', chainId: 8453, deadline: '2026-10-07T00:00:00Z' } }),
  acceptanceCriteria: JSON.stringify([{ criterionId: 'c1', description: 'delivery temperature <= 5C', requiredEvidenceType: 'temperature-reading' }]),
  deadline: '2026-10-06T18:00:00Z',
  failureConditions: JSON.stringify([{ condition: 'provider_obligation_unfulfilled' }]),
  recoveryPolicy: JSON.stringify({ maxRetries: 2, retryIntervalSeconds: 300, refundOnFailure: true, compensationPercent: '5' }),
  refundsCompensation: JSON.stringify({ refundOnTotalFailure: true, partialCreditPercent: '50' }),
  lifecycleState: 'issued',
};

(async () => {
  console.log('--- EAS anchoring unit test (mock mode, no network) ---');

  // 1. Schema UID deterministic
  const s1 = eas.deriveSchemaUid();
  const s2 = eas.deriveSchemaUid();
  check('schema UID is 0x+64 hex', /^0x[a-fA-F0-9]{64}$/.test(s1), s1.slice(0, 18) + '...');
  check('schema UID deterministic', s1 === s2);

  // 2. Same commitment -> same attestation UID
  const a1 = await eas.attestCommitment(commitment);
  const a2 = await eas.attestCommitment(commitment);
  check('attestCommitment ok (mock)', a1.ok && a2.ok);
  check('attestation UID deterministic', a1.anchor.uid === a2.anchor.uid, a1.anchor.uid.slice(0, 18) + '...');
  check('attestation UID 0x+64', /^0x[a-fA-F0-9]{64}$/.test(a1.anchor.uid));
  check('mock mode (no network)', a1.anchor.mode === 'mock' && a1.mock === true);
  check('anchor carries commitmentDigest', a1.anchor.commitmentDigest === commitment.commitmentDigest.toLowerCase());
  check('anchor carries chainId 8453', a1.anchor.chainId === 8453);

  // 3. Encode/decode round-trip preserves digest + id
  const data = eas.encodeAttestationData(commitment);
  const { decodeAbiParameters, parseAbiParameters } = require('viem');
  const decoded = decodeAbiParameters(
    parseAbiParameters('string,string,string,string,string,string,string,string,string,string,string,string,string,uint64'),
    data
  );
  check('round-trip commitmentId', String(decoded[0]) === commitment.commitmentId);
  check('round-trip commitmentDigest', String(decoded[1]) === commitment.commitmentDigest);
  check('round-trip lifecycleState', String(decoded[12]) === 'issued');

  // 4. verifyAnchor fails closed on zero UID (no throw, no network dependency)
  const v = await eas.verifyAnchor({ uid: '0x0000000000000000000000000000000000000000000000000000000000000000', commitmentDigest: commitment.commitmentDigest });
  check('verifyAnchor fails closed on zero uid', v.ok === false && v.verified === false && !v.error, v.reason || v.error);

  // 5. Tamper-evidence: changing the digest changes the UID + data
  const tampered = { ...commitment, commitmentDigest: '0x' + 'ab'.repeat(32) };
  const a3 = await eas.attestCommitment(tampered);
  check('tampered digest -> different UID', a3.anchor.uid !== a1.anchor.uid);
  check('tampered digest -> different data', a3.anchor.attestationData !== a1.anchor.attestationData);

  // 6. invalid input rejected
  const bad = await eas.attestCommitment({ commitmentId: 'x' });
  check('missing digest rejected', bad.ok === false && /commitmentDigest/.test(bad.error));

  // 7. sha256:-prefixed digest (the real manifestHash format) normalizes
  const FIXED_AT = 1800000000;
  const shaCommitment = { ...commitment, commitmentDigest: 'sha256:' + commitment.commitmentDigest.slice(2), anchoredAt: FIXED_AT };
  const bareCommitment = { ...commitment, anchoredAt: FIXED_AT };
  const sha = await eas.attestCommitment(shaCommitment);
  const bare = await eas.attestCommitment(bareCommitment);
  check('sha256: prefix normalized to bare 0x digest', sha.ok === true && sha.anchor.commitmentDigest === commitment.commitmentDigest.toLowerCase());
  // The attestation UID includes `time`, so two separate attestations (even
  // with identical data) differ — the correct tamper-evidence check is that
  // the encoded DATA (with the same anchoredAt) is identical, proving digest
  // normalization is canonical.
  check('sha256: and bare digest produce SAME data', sha.anchor.attestationData === bare.anchor.attestationData);

  console.log('---');
  console.log(passed + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ''));
})();