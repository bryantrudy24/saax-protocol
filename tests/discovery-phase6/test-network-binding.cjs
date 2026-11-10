// Authenticated network/asset handoff: no live RPC, signatures use throwaway keys.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');
const discCrypto = require('../../endpoint/discovery-crypto.js');
const acceptanceCore = require('../../endpoint/acceptance-core.js');
const commitmentLib = require('../../endpoint/commitment.js');
const handoff = require('../../endpoint/financial-handoff.js');

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const EVALUATOR = '0x3333333333333333333333333333333333333333';
const PROVIDER = 'https://provider.test/';
const SCHEMA = 'sha256:' + 'a'.repeat(64);
const hash = (x) => 'sha256:' + crypto.createHash('sha256').update(x).digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));
const sign = async (payload, key, kid) => (await discCrypto.signProfileCanonical({ payload, privateJwk: key, keyId: kid })).jws;

async function keys() {
  const pair = await generateKeyPair('Ed25519', { extractable: true });
  return { priv: await crypto.subtle.exportKey('jwk', pair.privateKey), pub: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}
async function fixture(mode = 'escrow') {
  const providerKey = await keys(); const buyerKey = await keys();
  const soon = new Date(Date.now() + 3600_000).toISOString();
  const schema = { id: 'https://provider.test/manifest', version: '1', digest: SCHEMA, purpose: 'commitment-manifest' };
  const policy = { schemaVersion: 'saax-financial-agreement-v1', chainId: 84532,
    network: handoff.NETWORK, asset: `${handoff.NETWORK}/erc20:${handoff.USDC}`,
    custody: { address: handoff.CUSTODY, runtimeKeccak: '0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473' },
    token: { address: handoff.USDC, symbol: 'USDC', decimals: 6 },
    buyer: BUYER, seller: SELLER,
    evaluator: { address: EVALUATOR, permittedDecisions: ['release', 'refund'] },
    minReleaseTime: '0', recovery: { signedRefund: true, timeoutRefund: true, refundBeneficiary: 'buyer' } };
  const terms = { network: handoff.NETWORK, asset: `${handoff.NETWORK}/erc20:${handoff.USDC}`,
    rail: 'x402', mode,
    amount: '50000', unit: 'micro-units of settlement asset', currency: 'USDC',
    decimals: 6, financialTerms: 'financial', deadline: soon,
    policies: { financialAgreement: policy } };
  const profile = { providerId: PROVIDER, origin: 'https://provider.test', profileVersion: '1.0.0', expires: soon,
    signingKeys: [{ id: 'provider-key', jwk: providerKey.pub, status: 'active',
      validFrom: new Date(Date.now() - 60000).toISOString(), validUntil: soon }],
    capabilities: [{ id: 'security-scan', schemas: [schema] }],
    financialCompatibility: { supportedCombinations: [{ network: terms.network, asset: terms.asset,
      rail: terms.rail, mode: terms.mode, financialTerms: 'financial',
      settlementCurrency: 'USDC', settlementDecimals: 6 }] } };
  profile.signature = { keyId: 'provider-key', jws: await sign(profile, providerKey.priv, 'provider-key') };
  const proposal = { profileVersion: '1.0.0', proposalId: 'prop-test-1', nonce: 'proposal-nonce-1',
    requestDigest: hash('request'), provider: { providerId: PROVIDER, signingKeyId: 'provider-key' },
    audience: { buyer: BUYER }, manifest: { commitmentManifestVersion: '1', commitmentManifestDigest: SCHEMA, schema },
    terms, issuedAt: new Date().toISOString(), expires: soon };
  proposal.signature = { keyId: 'provider-key', jws: await sign(proposal, providerKey.priv, 'provider-key') };
  const proposalDigest = acceptanceCore.proposalDigestOf(proposal);
  const buyerDoc = { schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1',
    acceptanceId: 'acceptance-test-1', nonce: 'acceptance-nonce-1', buyer: BUYER,
    provider: { providerId: PROVIDER, signingKeyId: 'provider-key' },
    proposal: { proposalId: proposal.proposalId, proposalDigest },
    termsDigest: hash(discCrypto.jcs(terms)), audience: PROVIDER,
    notBefore: new Date(Date.now() - 60_000).toISOString(), notAfter: soon,
    versions: { profileVersion: proposal.profileVersion, manifestVersion: '1', schema: proposal.manifest.schema } };
  const acceptance = { ...buyerDoc, signature: { keyId: 'buyer-key', jws: await sign(buyerDoc, buyerKey.priv, 'buyer-key') } };
  const manifest = commitmentLib.buildManifest({ commitmentId: '0x' + 'b'.repeat(64),
    buyerAgentId: BUYER, sellerAgentId: PROVIDER, capability: 'security-scan',
    price: { amount: terms.amount, currency: terms.currency, decimals: terms.decimals },
    acceptanceCriteria: { type: 'hash', value: hash('request') }, deadline: soon, cancelCondition: 'buyer-cancel-before-delivery' });
  const srDoc = { signedRepresentationVersion: 'manifest-v1.1+saax-proposal-bound',
    commitmentId: manifest.commitmentId, proposalId: proposal.proposalId, proposalDigest,
    manifestDigest: manifest.manifestHash, acceptanceCriteria: manifest.acceptanceCriteria,
    deadline: manifest.deadline, price: manifest.price, sellerAgentId: manifest.sellerAgentId,
    buyerAgentId: manifest.buyerAgentId, capability: manifest.capability,
    evaluator: null, permittedDecisions: null, profileVersion: proposal.profileVersion,
    manifestVersion: '1', signedAt: new Date().toISOString() };
  const signedRepresentation = { version: srDoc.signedRepresentationVersion, keyId: 'provider-key',
    signedAt: srDoc.signedAt, manifestHash: manifest.manifestHash,
    jws: await sign(srDoc, providerKey.priv, 'provider-key') };
  const commitment = { commitmentId: manifest.commitmentId, manifestHash: manifest.manifestHash,
    manifest, terms: clone(terms), signedRepresentation };
  const ctx = { proposal, acceptance, profile,
    providerId: PROVIDER, origin: profile.origin, providerKeyId: 'provider-key',
    buyerScope: { buyer: BUYER, buyerPublicJwk: buyerKey.pub, buyerKeyId: 'buyer-key' },
    trustedThumbprints: [await calculateJwkThumbprint(providerKey.pub)] };
  return { commitment, ctx, providerKey, buyerKey };
}

async function main() {
  const { commitment, ctx } = await fixture();
  assert.equal((await handoff.buildEscrowFunding(commitment, ctx)).ok, true);
  const funding = (await handoff.buildEscrowFunding(commitment, ctx)).funding;
  assert.equal(funding.token, handoff.USDC);
  assert.equal(funding.buyer, BUYER); assert.equal(funding.seller, SELLER);
  assert.equal(funding.evaluator, EVALUATOR); assert.equal(funding.minReleaseTime, '0');
  assert.equal(funding.amount, '50000');
  assert.equal((await handoff.buildEscrowFunding(commitment)).errorCode, 'DSC_UNAUTHENTICATED_HANDOFF');
  assert.equal((await handoff.buildEscrowFunding({ ...commitment, handoff: ctx })).errorCode, 'DSC_UNAUTHENTICATED_HANDOFF');
  assert.equal((await handoff.buildEscrowFunding({ ...commitment, handoff: { proposal: ctx.proposal, acceptance: ctx.acceptance } },
    { profile: ctx.profile, buyerScope: ctx.buyerScope, trustedThumbprints: ctx.trustedThumbprints,
      providerId: ctx.providerId, origin: ctx.origin, providerKeyId: ctx.providerKeyId })).ok, true);
  const immediate = await fixture('x402');
  const requirement = await handoff.buildPaymentRequirements(immediate.commitment, immediate.ctx);
  assert.equal(requirement.ok, true); assert.equal(requirement.requirements.payTo, SELLER);
  assert.equal((await handoff.buildEscrowFunding(immediate.commitment, immediate.ctx)).errorCode, 'DSC_UNSUPPORTED_MODE');
  assert.equal((await handoff.buildPaymentRequirements(commitment, ctx)).errorCode, 'DSC_UNSUPPORTED_RAIL');

  async function denied(name, transform) {
    const c = clone(commitment), context = clone(ctx);
    transform(c, context);
    const result = await handoff.buildEscrowFunding(c, context);
    assert.equal(result.ok, false, name);
  }
  await denied('legacy mainnet network rejected', (_c, x) => { x.proposal.terms.network = 'eip155:8453'; });
  await denied('mainnet asset chain rejected', (_c, x) => { x.proposal.terms.asset = 'eip155:8453/erc20:' + handoff.USDC; });
  await denied('asset token rejected', (_c, x) => { x.proposal.terms.asset = 'eip155:84532/erc20:' + SELLER; });
  await denied('missing policy rejected', (_c, x) => { delete x.proposal.terms.policies.financialAgreement; });
  await denied('policy custody substitution rejected', (_c, x) => { x.proposal.terms.policies.financialAgreement.custody.address = SELLER; });
  await denied('policy evaluator substitution rejected', (_c, x) => { x.proposal.terms.policies.financialAgreement.evaluator.address = BUYER; });
  await denied('policy buyer substitution rejected', (_c, x) => { x.proposal.terms.policies.financialAgreement.buyer = SELLER; });
  await denied('policy decisions substitution rejected', (_c, x) => { x.proposal.terms.policies.financialAgreement.evaluator.permittedDecisions = ['release']; });
  await denied('external terms substitution rejected', (c) => { c.terms.amount = '50001'; });
  await denied('manifest spend substitution rejected', (c) => { c.manifest.price.amount = '50001'; });
  await denied('buyer acceptance substitution rejected', (_c, x) => { x.acceptance.termsDigest = hash('not-terms'); });
  await denied('provider SR substitution rejected', (c) => { c.signedRepresentation.jws += 'tamper'; });
  await denied('decimals missing rejected', (_c, x) => { delete x.proposal.terms.decimals; });
  await denied('wrong financialTerms rejected', (_c, x) => { x.proposal.terms.financialTerms = 'nonfinancial'; });
  await denied('changed external seller rejected', (c) => { c.terms.policies.financialAgreement.seller = BUYER; });
  await denied('untrusted embedded buyer scope rejected', (c, x) => {
    c.handoff = { proposal: x.proposal, acceptance: x.acceptance, buyerScope: x.buyerScope, profile: x.profile,
      trustedThumbprints: x.trustedThumbprints }; delete x.buyerScope;
  });
  // Re-sign a disallowed policy to ensure the guard itself rejects it, not
  // merely a broken provider JWS. Keep acceptance and SR digest bindings valid.
  async function signedPolicyDenied(name, change) {
    const f = await fixture();
    change(f.ctx.proposal.terms);
    const combination = f.ctx.profile.financialCompatibility.supportedCombinations[0];
    combination.network = f.ctx.proposal.terms.network;
    combination.asset = f.ctx.proposal.terms.asset;
    delete f.ctx.profile.signature;
    f.ctx.profile.signature = { keyId: 'provider-key', jws: await sign(f.ctx.profile, f.providerKey.priv, 'provider-key') };
    const p = f.ctx.proposal;
    const unsignedP = clone(p); delete unsignedP.signature;
    p.signature.jws = await sign(unsignedP, f.providerKey.priv, 'provider-key');
    const digest = acceptanceCore.proposalDigestOf(p);
    f.ctx.acceptance.proposal.proposalDigest = digest;
    f.ctx.acceptance.termsDigest = hash(discCrypto.jcs(p.terms));
    const unsignedA = clone(f.ctx.acceptance); delete unsignedA.signature;
    f.ctx.acceptance.signature.jws = await sign(unsignedA, f.buyerKey.priv, 'buyer-key');
    const srDoc = JSON.parse(Buffer.from(f.commitment.signedRepresentation.jws.split('.')[1], 'base64url').toString('utf8'));
    srDoc.proposalDigest = digest;
    f.commitment.signedRepresentation.jws = await sign(srDoc, f.providerKey.priv, 'provider-key');
    f.commitment.terms = clone(p.terms);
    // The policy mutation has fresh signatures and exact cross-artifact
    // digests, but the signed combination is still outside the handoff lane.
    const result = await handoff.buildEscrowFunding(f.commitment, f.ctx);
    assert.equal(result.ok, false, name);
  }
  await signedPolicyDenied('validly signed mainnet network still rejected', (t) => {
    t.network = 'eip155:8453'; t.asset = 'eip155:8453/erc20:' + handoff.USDC;
  });
  await signedPolicyDenied('validly signed alternative token still rejected', (t) => {
    t.asset = 'eip155:84532/erc20:' + SELLER;
  });
  await signedPolicyDenied('validly signed substituted custody still rejected', (t) => {
    t.policies.financialAgreement.custody.address = SELLER;
  });
  const prev = process.env.SAAX_USDC_ADDRESS;
  try {
    process.env.SAAX_USDC_ADDRESS = SELLER;
    assert.equal(handoff.canonicalUsdc(), handoff.USDC, 'env must not substitute token');
    assert.equal((await handoff.buildEscrowFunding(commitment, { ...ctx, buyer: SELLER, seller: BUYER, evaluator: BUYER, custody: BUYER })).funding.seller, SELLER);
  } finally { if (prev === undefined) delete process.env.SAAX_USDC_ADDRESS; else process.env.SAAX_USDC_ADDRESS = prev; }
  await assert.rejects(handoff.resolveAndEnforceChain({ getNetwork: async () => ({ chainId: 8453 }) }), /84532/);
  await assert.rejects(handoff.resolveAndEnforceChain({ getNetwork: async () => ({ chainId: 84532 }) }, 'eip155:8453'), /signed network/);
  assert.equal(await handoff.resolveAndEnforceChain({ getNetwork: async () => ({ chainId: 84532 }) }), 84532);
  const noNonce = await handoff.buildVerdict(commitment, 'release', { address: EVALUATOR, signTypedData: async () => { throw Error('must not sign'); } }, ctx);
  assert.equal(noNonce.errorCode, 'DSC_INVALID_NONCE');
  const wrongWallet = await handoff.buildVerdict(commitment, 'release', { address: BUYER, signTypedData: async () => { throw Error('must not sign'); } }, ctx, '1');
  assert.equal(wrongWallet.errorCode, 'DSC_INVALID_EVALUATOR');
  console.log('focused handoff tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
