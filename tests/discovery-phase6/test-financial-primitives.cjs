'use strict';

// Offline fixture tests for financial-verifier-candidate.cjs.
// Run with: node --test financial-verifier-fixtures.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const verifier = require('../../verifier/verify-financial-export.js');

function signJws(payload, privateKey, kid) {
  const protectedPart = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url');
  const payloadPart = Buffer.from(verifier.jcs(payload)).toString('base64url');
  const input = Buffer.from(protectedPart + '.' + payloadPart, 'ascii');
  const signature = crypto.sign(null, input, privateKey).toString('base64url');
  return protectedPart + '.' + payloadPart + '.' + signature;
}

function goodAgreement() {
  return {
    schemaVersion: 'saax-financial-agreement-v1',
    network: 'eip155:84532',
    chainId: 84532,
    asset: 'eip155:84532/erc20:' + verifier.TEST_USDC,
    buyer: '0x' + '11'.repeat(20),
    seller: '0x' + '22'.repeat(20),
    evaluator: { address: '0x' + '33'.repeat(20), permittedDecisions: ['release', 'refund'] },
    custody: { address: verifier.CUSTODY, runtimeKeccak: verifier.CUSTODY_RUNTIME_KECCAK },
    token: { address: verifier.TEST_USDC, symbol: 'USDC', decimals: 6 },
    minReleaseTime: '0',
    recovery: { signedRefund: true, timeoutRefund: true, refundBeneficiary: 'buyer' },
  };
}

test('positive control: independently pinned EdDSA JWS verifies', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  const payload = { bound: true, role: 'provider' };
  const jws = signJws(payload, privateKey, 'trusted-key');
  assert.deepEqual(verifier.verifyCompactJws({ jws, publicJwk, expectedKeyId: 'trusted-key', expectedPayload: payload }), {
    ok: true, payload, kid: 'trusted-key',
  });
});

test('negative: wrong explicit kid reports exact failure code', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jws = signJws({ ok: true }, privateKey, 'actual-kid');
  assert.equal(verifier.verifyCompactJws({
    jws, publicJwk: publicKey.export({ format: 'jwk' }), expectedKeyId: 'pinned-kid', expectedPayload: { ok: true },
  }).code, 'JWS_KID_MISMATCH');
});

test('negative: modified signed payload reports exact failure code', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const parts = signJws({ ok: true }, privateKey, 'trusted-key').split('.');
  parts[1] = Buffer.from('{"ok":false}').toString('base64url');
  assert.equal(verifier.verifyCompactJws({
    jws: parts.join('.'), publicJwk: publicKey.export({ format: 'jwk' }), expectedKeyId: 'trusted-key', expectedPayload: { ok: true },
  }).code, 'JWS_SIGNATURE_INVALID');
});

test('positive control: complete financialAgreement satisfies pinned schema', () => {
  assert.deepEqual(verifier.agreementProblems(goodAgreement()), []);
});

test('negative: wrong chain has exact agreement failure code', () => {
  assert.ok(verifier.agreementProblems({ ...goodAgreement(), chainId: 1 }).includes('FA_CHAIN_ID'));
});

test('negative: absent agreement is exact incomplete requirement failure', () => {
  assert.deepEqual(verifier.agreementProblems(undefined), ['FA_MISSING']);
});

test('negative: trust input rejects private JWK material', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const problems = verifier.checkTrustSchema({
    provider: { providerId: 'https://provider.example/', keyId: 'p', publicJwk: { ...jwk, d: 'private' } },
    buyer: { address: goodAgreement().buyer, keyId: 'b', publicJwk: jwk },
  });
  assert.deepEqual(problems, ['TRUST_PROVIDER_ENTRY']);
});

test('positive control: legacy manifest-v1 hash recomputation has digest form', () => {
  const manifest = {
    commitmentId: '0x' + '44'.repeat(32), buyerAgentId: goodAgreement().buyer,
    sellerAgentId: 'https://provider.example/', capability: 'security-scan',
    price: { amount: '500000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash', value: 'sha256:' + '55'.repeat(32) },
    deadline: '2027-01-01T00:00:00Z', cancelCondition: 'buyer-cancel-before-delivery',
    signature: 'COSE_Sign1:0x' + '00'.repeat(65),
  };
  assert.match(verifier.buildLegacyManifestHash(manifest), /^sha256:[0-9a-f]{64}$/);
});
