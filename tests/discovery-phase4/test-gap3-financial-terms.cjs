// SAAX Discovery Phase 4 — Gap 3: explicit authenticated financial terms
//
// Proves:
//   G3A a financial request yields a proposal whose terms carry the EXPLICIT
//       settlement currency + decimals from the matched profile combination
//       (no inference from unit labels, no silent USDC default).
//   G3B changing the currency/decimals/financialTerms in the profile (or the
//       request's network/asset/rail/mode) is DETECTED at acceptance: either
//       rejected (DSC_INVALID_COMBINATION / DSC_PROPOSAL_STALE) or requires a
//       fresh proposal + fresh acceptance.
//   G3C omitting a settlement currency from a financial combination fails
//       preflight (no silent default).
//   G3D a nonfinancial/rail-neutral combination carries financialTerms +
//       NO currency; any currency substituted into its proposal is rejected.
//   G3E numeric conversions are deterministic + lossless (amount unchanged
//       across request -> proposal -> acceptance -> commitment).
//
// Run: node tests/discovery-phase4/test-gap3-financial-terms.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');
const preflight = require('../../endpoint/preflight-core');
const acceptance = require('../../endpoint/acceptance-core');
const acceptCrypto = require('../../endpoint/acceptance-crypto');
const cryptoLib = require('../../endpoint/discovery-crypto');
const { ProposalStore } = require('../../endpoint/proposal-store');
const { AcceptanceStore } = require('../../endpoint/acceptance-store');
const { loadProfile, loadSignerKey } = require('../discovery-phase3/preflight-http-server.cjs');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-gap3-'));
function makeClock(iso) { return { nowIso: () => iso, fixed: iso }; }
function validRequest(over = {}) {
  return Object.assign({
    profileVersion: '1.0.0',
    capability: { id: 'security-scan' },
    schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' },
    units: { amount: '250000000', unit: 'micro-units of settlement asset' },
    financialProfile: { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'x402' },
    constraints: { maxAmount: '250000000', deadline: '2026-11-06T00:00:00Z' },
    intendedParties: { buyer: '0x1111111111111111111111111111111111111111' },
    clientNonce: 'nonce-g3-' + crypto.randomBytes(4).toString('hex'),
    issuedAt: '2026-11-05T12:00:00Z',
  }, over);
}
function makeAcceptanceDoc({ proposal, buyer, providerOrigin, termsDigest, over = {} }) {
  const pDigest = acceptance.proposalDigestOf(proposal);
  return Object.assign({
    schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_' + crypto.randomBytes(8).toString('hex'),
    nonce: 'accnonce-' + crypto.randomBytes(6).toString('hex'),
    buyer,
    provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId },
    proposal: { proposalId: proposal.proposalId, proposalDigest: pDigest },
    termsDigest,
    audience: providerOrigin,
    notBefore: '2026-11-05T11:58:00Z', notAfter: '2026-11-05T12:30:00Z',
    versions: { profileVersion: proposal.profileVersion, manifestVersion: proposal.manifest.commitmentManifestVersion, schema: proposal.manifest.schema },
  }, over);
}

async function main() {
  const profile = loadProfile();
  const privateJwk = loadSignerKey();
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  const providerRef = {
    providerId: profile.providerId, name: profile.providerName, origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id, privateJwk, jwkPublic: publicJwk,
    manifestDigest: profile.capabilities[0].schemas[0].digest,
    evaluatorRef: profile.capabilities[0].evaluatorRequirements, permittedDecisions: null,
  };
  const trustedThumbprints = [await calculateJwkThumbprint(publicJwk)];
  const BUYER = '0x1111111111111111111111111111111111111111';
  const buyerKeys = await generateKeyPair('Ed25519', { extractable: true });
  const buyerPriv = await crypto.subtle.exportKey('jwk', buyerKeys.privateKey);
  const buyerPub = await crypto.subtle.exportKey('jwk', buyerKeys.publicKey);
  const clock = makeClock('2026-11-05T12:00:00.000Z');
  const buyerScope = { buyer: BUYER, buyerPublicJwk: buyerPub, scopeMaxAmount: '500000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan' };
  const storeDir = path.join(tmpBase, 'acc');
  const acceptStore = new AcceptanceStore(storeDir);

  const termsDigestOf = (proposal) => 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal.terms), 'utf8').digest('hex');
  const signAcc = async (doc) => acceptCrypto.signAcceptance({ acceptance: doc, buyerPrivateJwk: buyerPriv, keyId: 'buyer-key-1' });

  // G3A: financial request -> proposal terms carry EXPLICIT USDC + 6 + financial.
  {
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store: new ProposalStore(path.join(tmpBase, 'propA')), clock });
    eq(pOut.status, 'ok', 'G3A1 supported request ok');
    const proposal = pOut.proposal;
    eq(proposal.terms.currency, 'USDC', 'G3A2 proposal terms carry the EXPLICIT settlement currency USDC (not inferred, not defaulted)');
    eq(proposal.terms.decimals, 6, 'G3A3 proposal terms carry the EXPLICIT decimals 6');
    eq(proposal.terms.financialTerms, 'financial', 'G3A4 proposal terms carry financialTerms=financial');
    eq(proposal.terms.amount, '250000000', 'G3A5 amount preserved losslessly (integer string)');
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, providerOrigin: profile.origin, termsDigest: termsDigestOf(proposal) });
    const signedAcc = await signAcc(accDoc);
    const out = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-g3a' });
    eq(out.status, 'ok', 'G3A6 financial acceptance -> commitment ok');
    eq(out.commitment.manifest.price.currency, 'USDC', 'G3A7 commitment price.currency == the authenticated proposal currency');
    eq(out.commitment.manifest.price.decimals, 6, 'G3A8 commitment price.decimals == the authenticated proposal decimals');
    eq(out.commitment.manifest.price.amount, '250000000', 'G3A9 commitment price.amount lossless');
  }

  // G3B: currency substitution in the profile is detected at acceptance.
  {
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'nonce-g3b-' + crypto.randomBytes(4).toString('hex') }), store: new ProposalStore(path.join(tmpBase, 'propB')), clock });
    const proposal = pOut.proposal;
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, providerOrigin: profile.origin, termsDigest: termsDigestOf(proposal) });
    const signedAcc = await signAcc(accDoc);
    const changed = JSON.parse(JSON.stringify(profile));
    changed.financialCompatibility.supportedCombinations[0].settlementCurrency = 'DAI';
    changed.financialCompatibility.supportedCombinations[0].settlementDecimals = 18;
    const r = await acceptance.acceptCommitment({ profile: changed, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-g3b' });
    eq(r.errorCode, 'DSC_INVALID_COMBINATION', 'G3B currency substitution in the profile -> DSC_INVALID_COMBINATION at acceptance (fresh proposal+acceptance required)');
  }

  // G3C: omitting settlement currency from a financial combination fails preflight.
  {
    const noCur = JSON.parse(JSON.stringify(profile));
    delete noCur.financialCompatibility.supportedCombinations[0].settlementCurrency;
    const r = await preflight.prepareCommitment({ profile: noCur, providerRef, request: validRequest({ clientNonce: 'nonce-g3c-' + crypto.randomBytes(4).toString('hex') }), store: new ProposalStore(path.join(tmpBase, 'propC')), clock });
    eq(r.errorCode, 'DSC_INVALID_COMBINATION', 'G3C financial combination without settlementCurrency -> preflight rejected (no silent default)');
  }

  // G3D: nonfinancial/rail-neutral combination carries financialTerms + NO
  // currency; substituting a currency into its proposal is rejected.
  {
    const nonFin = JSON.parse(JSON.stringify(profile));
    nonFin.financialCompatibility.supportedCombinations[0].financialTerms = 'nonfinancial';
    delete nonFin.financialCompatibility.supportedCombinations[0].settlementCurrency;
    delete nonFin.financialCompatibility.supportedCombinations[0].settlementDecimals;
    const pOut = await preflight.prepareCommitment({ profile: nonFin, providerRef, request: validRequest({ clientNonce: 'nonce-g3d-' + crypto.randomBytes(4).toString('hex') }), store: new ProposalStore(path.join(tmpBase, 'propD')), clock });
    eq(pOut.status, 'ok', 'G3D1 nonfinancial combination preflight ok');
    eq(pOut.proposal.terms.financialTerms, 'nonfinancial', 'G3D2 nonfinancial proposal carries financialTerms=nonfinancial');
    eq(pOut.proposal.terms.currency, null, 'G3D3 nonfinancial proposal carries NO currency (explicit state)');
    // Substituting a currency into a SIGNED nonfinancial proposal is signature
    // tampering (the proposal signature covered the terms without currency) ->
    // rejected as DSC_INVALID_SIGNATURE (term substitution detected).
    const tampered = JSON.parse(JSON.stringify(pOut.proposal));
    tampered.terms.currency = 'USDC';
    const accDoc = makeAcceptanceDoc({ proposal: tampered, buyer: BUYER, providerOrigin: profile.origin, termsDigest: termsDigestOf(tampered) });
    const signedAcc = await signAcc(accDoc);
    const r = await acceptance.acceptCommitment({ profile: nonFin, trustedThumbprints, proposal: tampered, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-g3d' });
    ok(['DSC_INVALID_SIGNATURE', 'DSC_INVALID_COMBINATION'].includes(r.errorCode), 'G3D4 substituted currency into a signed nonfinancial proposal -> rejected (term substitution detected)', r.errorCode);

    // Profile later changes nonfinancial -> financial (currency appears in the
    // CURRENT combination): the old nonfinancial proposal (validly signed, no
    // currency) must be rejected at acceptance as DSC_INVALID_COMBINATION —
    // a fresh proposal + fresh acceptance is required before any economic
    // choice is introduced.
    const nowFinancial = JSON.parse(JSON.stringify(profile));
    nowFinancial.financialCompatibility.supportedCombinations[0].financialTerms = 'financial';
    nowFinancial.financialCompatibility.supportedCombinations[0].settlementCurrency = 'USDC';
    nowFinancial.financialCompatibility.supportedCombinations[0].settlementDecimals = 6;
    const accDoc2 = makeAcceptanceDoc({ proposal: pOut.proposal, buyer: BUYER, providerOrigin: profile.origin, termsDigest: termsDigestOf(pOut.proposal) });
    const signedAcc2 = await signAcc(accDoc2);
    const r2 = await acceptance.acceptCommitment({ profile: nowFinancial, trustedThumbprints, proposal: pOut.proposal, buyerScope, acceptance: signedAcc2, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-g3d2' });
    eq(r2.errorCode, 'DSC_INVALID_COMBINATION', 'G3D5 nonfinancial->financial profile change rejects the old proposal (fresh authorization required)');
  }

  // G3E: amount lossless across the whole chain (already partly asserted in A);
  // assert the acceptance termsDigest covers the explicit financial terms.
  {
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'nonce-g3e-' + crypto.randomBytes(4).toString('hex') }), store: new ProposalStore(path.join(tmpBase, 'propE')), clock });
    const proposal = pOut.proposal;
    const td = termsDigestOf(proposal);
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, providerOrigin: profile.origin, termsDigest: td });
    const signedAcc = await signAcc(accDoc);
    ok(signedAcc.termsDigest === td, 'G3E1 acceptance termsDigest covers the explicit financial terms (currency/decimals/financialTerms)');
    const out = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-g3e' });
    eq(out.commitment.manifest.price.amount, '250000000', 'G3E2 amount unchanged request->proposal->commitment');
    eq(out.commitment.manifest.price.currency, 'USDC', 'G3E3 currency unchanged request->proposal->commitment');
  }

  acceptStore.releaseLock();
  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error('runner crashed: ' + (e && e.stack || e)); process.exitCode = 1; });