'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, Signature } = require('ethers');
const { verifyVerdictAuthorization, VERDICT_TYPES } = require('../../verifier/financial-evidence.js');
const custody = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const commitmentId = '0x' + 'ab'.repeat(32), commitmentDigest = '0x' + 'cd'.repeat(32);
const evaluator = Wallet.createRandom();
const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: 84532, verifyingContract: custody };
async function fixture(signDomain = domain, signer = evaluator, action = 'release') {
  const message = { commitmentId, commitmentDigest, action, nonce: '701', issuedAt: '1700000000' };
  const s = Signature.from(await signer.signTypedData(signDomain, VERDICT_TYPES, message));
  return { ...message, domain: signDomain, types: VERDICT_TYPES, primaryType: 'EscrowVerdict', v: s.v, r: s.r, s: s.s };
}
function verify(verdict, extra = {}) {
  return verifyVerdictAuthorization({ verdict, evaluator: evaluator.address, permittedDecisions: ['release', 'refund'],
    action: 'release', commitmentId, commitmentDigest, blockTimestamp: 1700000001n, custody, ...extra });
}
test('positive cryptographic verdict with exact domain, type, action, nonce and time', async () => {
  assert.deepEqual(verify(await fixture()), []);
});
test('unauthorized evaluator signature rejected, exact failure', async () => {
  assert.ok(verify(await fixture(domain, Wallet.createRandom())).includes('VERDICT_UNAUTHORIZED_SIGNER'));
});
test('wrong domain name rejected independent of nonce consumption', async () => {
  const errors = verify(await fixture({ ...domain, name: 'Other Custody' }));
  assert.ok(errors.includes('VERDICT_DOMAIN_STRUCT')); assert.ok(errors.includes('VERDICT_UNAUTHORIZED_SIGNER'));
});
test('wrong custody contract rejected', async () => {
  const errors = verify(await fixture({ ...domain, verifyingContract: Wallet.createRandom().address }));
  assert.ok(errors.includes('VERDICT_DOMAIN_STRUCT')); assert.ok(errors.includes('VERDICT_UNAUTHORIZED_SIGNER'));
});
test('wrong chain signature rejected', async () => {
  const errors = verify(await fixture({ ...domain, chainId: 8453 }));
  assert.ok(errors.includes('VERDICT_DOMAIN_STRUCT')); assert.ok(errors.includes('VERDICT_UNAUTHORIZED_SIGNER'));
});
test('invalid signature rejected', async () => {
  const verdict = await fixture(); verdict.r = '0x' + '00'.repeat(32);
  assert.ok(verify(verdict).some(e => ['VERDICT_INVALID_SIGNATURE', 'VERDICT_UNAUTHORIZED_SIGNER'].includes(e)));
});
test('forbidden action rejected even with valid evaluator signature', async () => {
  assert.ok(verify(await fixture(), { permittedDecisions: ['refund'] }).includes('VERDICT_FORBIDDEN_ACTION'));
  assert.ok(verify(await fixture(domain, evaluator, 'refund')).includes('VERDICT_FORBIDDEN_ACTION'));
});
test('expired at execution time rejected, current wall clock irrelevant', async () => {
  assert.ok(verify(await fixture(), { blockTimestamp: 1700000301n }).includes('VERDICT_EXECUTION_TIME'));
});
test('future issuedAt beyond contract grace rejected', async () => {
  assert.ok(verify(await fixture(), { blockTimestamp: 1699999879n }).includes('VERDICT_EXECUTION_TIME'));
});
test('inclusive exact time boundaries accepted', async () => {
  const v = await fixture(); assert.deepEqual(verify(v, { blockTimestamp: 1700000300n }), []);
  assert.deepEqual(verify(v, { blockTimestamp: 1699999880n }), []);
});
test('substituted commitment binding rejected', async () => {
  assert.ok(verify(await fixture(), { commitmentId: '0x' + 'ed'.repeat(32) }).includes('VERDICT_BINDING'));
});
