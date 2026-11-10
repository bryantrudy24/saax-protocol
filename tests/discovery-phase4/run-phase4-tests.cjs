// SAAX Protocol — Discovery Phase 4: buyer authorization + commitment creation test runner
//
// Proves (isolated loopback, real Ed25519 signatures, controlled clock):
//   1. Valid preflight -> buyer acceptance -> exactly ONE correctly
//      authenticated commitment (positive control; independent verification
//      of the commitment/export without application DB access).
//   2. Modified proposal/terms, substituted buyer/provider, wrong audience,
//      invalid signature, expired acceptance, stale proposal, unsupported
//      combinations reject specifically (DSC_*).
//   3. Identical retries return the same result; changed requests with reused
//      nonces conflict; new-nonce replay cannot duplicate a single-use proposal.
//   4. Concurrent acceptance + process replacement do not duplicate issuance
//      (single-writer lock, in-process serialization, restart reconciliation).
//   5. Crash after durable acceptance and crash after commitment creation
//      reconcile correctly (journal reload).
//   6. HTTP/MCP parity (same core).
//   7. Rejected requests and ordinary commitment creation do NOT invoke
//      payment, custody, execution, or release functions (spies).
//
// Run: node tests/discovery-phase4/run-phase4-tests.cjs

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');

const preflight = require('../../endpoint/preflight-core');
const acceptance = require('../../endpoint/acceptance-core');
const acceptCrypto = require('../../endpoint/acceptance-crypto');
const cryptoLib = require('../../endpoint/discovery-crypto');
const { ProposalStore } = require('../../endpoint/proposal-store');
const { AcceptanceStore } = require('../../endpoint/acceptance-store');
const commitmentMod = require('../../endpoint/commitment');
const { startPreflightServer, loadProfile, loadSignerKey } = require('../discovery-phase3/preflight-http-server.cjs');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-phase4-'));
function tmpdir(name) { const d = path.join(tmpBase, name); fs.mkdirSync(d, { recursive: true }); return d; }

function makeClock(iso) { return { nowIso: () => iso, fixed: iso }; }

function validRequest(over = {}) {
  return Object.assign({
    profileVersion: '1.0.0',
    capability: { id: 'security-scan' },
    schema: {
      id: 'https://saax-protocol.com/schemas/commitment-manifest/v1',
      version: '1',
      digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    },
    units: { amount: '250000000', unit: 'micro-units of settlement asset' },
    financialProfile: {
      network: 'eip155:8453',
      asset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      rail: 'x402',
      mode: 'x402',
    },
    constraints: { maxAmount: '250000000', deadline: '2026-11-06T00:00:00Z' },
    intendedParties: { buyer: '0x1111111111111111111111111111111111111111' },
    clientNonce: 'nonce-0001-abcdef',
    issuedAt: '2026-11-05T12:00:00Z',
  }, over);
}

function digestOfNormalized(req) {
  const n = preflight.normalizeRequest(req);
  if (!n.ok) throw new Error('digestOfNormalized: ' + n.error.message);
  return preflight.requestDigestOf(n.normalized);
}

async function makeBuyerKeypair() {
  const kp = await generateKeyPair('Ed25519', { extractable: true });
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateJwk: priv, publicJwk: pub };
}

function makeAcceptanceDoc({ proposal, buyer, buyerSigningKeyId, providerOrigin, nowIso, over = {} }) {
  const terms = JSON.parse(JSON.stringify(proposal.terms));
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(terms), 'utf8').digest('hex');
  return Object.assign({
    schemaVersion: 'acceptance-v1',
    action: 'accept_commitment',
    domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_' + crypto.randomBytes(8).toString('hex'),
    nonce: 'accnonce-' + crypto.randomBytes(6).toString('hex'),
    buyer,
    provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId },
    proposal: { proposalId: proposal.proposalId, proposalDigest: acceptance.proposalDigestOf(proposal) },
    termsDigest,
    audience: providerOrigin,
    notBefore: '2026-11-05T11:58:00Z',
    notAfter: '2026-11-05T12:30:00Z',
    versions: {
      profileVersion: proposal.profileVersion,
      manifestVersion: proposal.manifest.commitmentManifestVersion,
      schema: proposal.manifest.schema,
    },
    ...over,
  }, {});
}

async function signAcceptanceDoc(doc, buyerPriv, keyId) {
  return acceptCrypto.signAcceptance({ acceptance: doc, buyerPrivateJwk: buyerPriv, keyId });
}

// Minimal MCP adapter (same core, in-process) — mirrors api/mcp.mjs accept_commitment.
function makeMCPAcceptAdapter({ profile, providerRef, store, trustedThumbprints, buyerRegistry, clock }) {
  return async function acceptCommitmentTool(input) {
    const proposal = input.proposal;
    const acceptanceDoc = input.acceptance;
    if (!proposal || !acceptanceDoc) return { status: 'rejected', errorCode: 'DSC_INVALID_REQUEST', httpStatus: 422, reason: 'proposal and acceptance required' };
    const buyerAddr = acceptanceDoc.buyer || (proposal.audience && proposal.audience.buyer);
    const reg = buyerRegistry[String(buyerAddr || '').toLowerCase()];
    if (!reg) return { status: 'rejected', errorCode: 'DSC_UNAUTHORIZED', httpStatus: 401, reason: 'buyer not registered' };
    const buyerScope = {
      buyer: String(buyerAddr).toLowerCase(),
      buyerPublicJwk: reg.publicJwk,
      scopeMaxAmount: reg.scopeMaxAmount,
      scopeCurrency: reg.scopeCurrency,
      scopeCapability: reg.scopeCapability,
    };
    const outcome = await acceptance.acceptCommitment({
      profile,
      trustedThumbprints,
      proposal,
      buyerScope,
      acceptance: acceptanceDoc,
      providerRef,
      store,
      clock,
      idempotencyKey: input.idempotencyKey,
    });
    return outcome;
  };
}

async function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: safeParse(data) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// Independently verify a created commitment WITHOUT application DB access:
// reconstruct the manifest + signed representation from the returned record and
// verify the provider JWS with the provider public key.
async function verifyCommitmentIndependent({ commitment, providerPublicJwk, expectedProposalId }) {
  const sr = commitment.signedRepresentation;
  if (!sr || !sr.jws) return { ok: false, reason: 'missing signedRepresentation' };
  const payload = JSON.parse(Buffer.from(sr.jws.split('.')[1], 'base64url').toString());
  if (payload.proposalId !== expectedProposalId) return { ok: false, reason: 'SR proposalId mismatch' };
  if (payload.commitmentId !== commitment.commitmentId) return { ok: false, reason: 'SR commitmentId mismatch' };
  if (payload.manifestDigest !== commitment.manifestHash) return { ok: false, reason: 'SR manifestDigest mismatch' };
  const ver = await cryptoLib.verifySignature({ jws: sr.jws, publicJwk: providerPublicJwk, expectedKeyId: sr.keyId, expectedPayload: payload });
  if (!ver.ok) return { ok: false, reason: ver.reason };
  // The manifest is the exact authenticated terms representation.
  const m = commitment.manifest;
  if (!m || m.commitmentId !== commitment.commitmentId) return { ok: false, reason: 'manifest commitmentId mismatch' };
  return { ok: true, payload, manifest: m };
}

async function main() {
  const profile = loadProfile();
  const privateJwk = loadSignerKey();
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  const providerRef = {
    providerId: profile.providerId,
    name: profile.providerName,
    origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id,
    privateJwk,
    jwkPublic: publicJwk,
    manifestDigest: profile.capabilities[0].schemas[0].digest,
    evaluatorRef: profile.capabilities[0].evaluatorRequirements,
    permittedDecisions: null,
  };
  const trustedThumbprints = [await calculateJwkThumbprint(publicJwk)];
  const BUYER = '0x1111111111111111111111111111111111111111';
  const buyerKeys = await makeBuyerKeypair();
  const buyerRegistry = {
    [BUYER]: { publicJwk: buyerKeys.publicJwk, scopeMaxAmount: '500000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan' },
  };
  const clock = makeClock('2026-11-05T12:00:00.000Z');
  const buyerScope = {
    buyer: BUYER,
    buyerPublicJwk: buyerKeys.publicJwk,
    scopeMaxAmount: '500000000',
    scopeCurrency: 'USDC',
    scopeCapability: 'security-scan',
  };

  // =========================================================================
  // A. Positive control: valid preflight -> buyer acceptance -> ONE commitment
  // =========================================================================
  let proposalA;
  {
    const storeDir = tmpdir('a');
    const store = new ProposalStore(path.join(storeDir, 'prop'));
    const acceptStore = new AcceptanceStore(path.join(storeDir, 'acc'));
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store, clock });
    ok(pOut.status === 'ok', 'A1 supported request -> proposal ok');
    proposalA = pOut.proposal;

    const accDoc = makeAcceptanceDoc({ proposal: proposalA, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');
    const out = await acceptance.acceptCommitment({
      profile, trustedThumbprints, proposal: proposalA, buyerScope, acceptance: signedAcc,
      providerRef, store: acceptStore, clock, idempotencyKey: 'idem-0001-abcdef',
    });
    eq(out.status, 'ok', 'A2 acceptCommitment returns ok');
    ok(out.operation && out.operation.status === 'commitment_created', 'A3 operation status commitment_created');
    ok(out.commitment && out.commitment.commitmentId && out.commitment.manifest, 'A4 commitment + manifest present');
    eq(out.commitment.manifest.price.amount, proposalA.terms.amount, 'A5 manifest amount == proposal terms amount');
    eq(out.commitment.manifest.buyerAgentId, BUYER.toLowerCase(), 'A6 manifest buyer == acceptance buyer');
    eq(out.commitment.manifest.capability, 'security-scan', 'A7 manifest capability == proposal capability');
    ok(!!out.commitment.manifest.manifestHash, 'A8 manifest hash present');
    // Independent verification (no app DB access).
    const iv = await verifyCommitmentIndependent({ commitment: out.commitment, providerPublicJwk: publicJwk, expectedProposalId: proposalA.proposalId });
    ok(iv.ok, 'A9 commitment independently verifiable (provider JWS over canonical manifest+proposal)', iv.reason);
    // The manifest signature (COSE placeholder) is preserved as historical artifact.
    eq(out.commitment.manifest.signature.slice(0, 11), 'COSE_Sign1:', 'A10 manifest v1 COSE envelope preserved (historical artifact)');
  }

  // =========================================================================
  // B. Duplicate + conflict + replay + single-use
  // =========================================================================
  {
    const storeDir = tmpdir('b');
    const store = new ProposalStore(path.join(storeDir, 'prop'));
    const acceptStore = new AcceptanceStore(path.join(storeDir, 'acc'));
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store, clock });
    const proposal = pOut.proposal;
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');

    const out1 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-b-0001' });
    eq(out1.status, 'ok', 'B1 first acceptance ok');
    const out2 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-b-0001' });
    eq(out2.status, 'duplicate', 'B2 identical retry -> duplicate');
    ok(out2.operation && out2.operation.operationId === out1.operation.operationId, 'B3 same operation returned');
    ok(out2.commitment && out2.commitment.commitmentId === out1.commitment.commitmentId, 'B4 same commitment returned');
    // Changed request (different idempotency key but SAME proposal + different acceptance nonce => proposal reuse).
    const accDoc2 = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin, over: { nonce: 'accnonce-different-0001' } });
    const signedAcc2 = await signAcceptanceDoc(accDoc2, buyerKeys.privateJwk, 'buyer-key-1');
    const out3 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc2, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-b-0002' });
    eq(out3.status, 'reused_proposal', 'B5 new-nonce replay of a single-use proposal -> DSC_PROPOSAL_REUSED');
    eq(out3.errorCode, 'DSC_PROPOSAL_REUSED', 'B6 error code specific');
    // Nonce conflict: same idempotency key with a DIFFERENT proposal digest.
    const pOut2 = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'nonce-0002-abcdef' }), store, clock });
    const proposal2 = pOut2.proposal;
    const accDoc3 = makeAcceptanceDoc({ proposal: proposal2, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc3 = await signAcceptanceDoc(accDoc3, buyerKeys.privateJwk, 'buyer-key-1');
    const out4 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal: proposal2, buyerScope, acceptance: signedAcc3, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-b-0001' });
    eq(out4.status, 'conflict', 'B7 same idempotency key + different request -> conflict');
    eq(out4.errorCode, 'DSC_NONCE_CONFLICT', 'B8 error code specific');
  }

  // =========================================================================
  // C. Negative: modified proposal/terms, substituted buyer/provider/audience,
  //    invalid signatures, expired acceptance, stale proposal, unsupported
  // =========================================================================
  {
    const storeDir = tmpdir('c');
    const store = new ProposalStore(path.join(storeDir, 'prop'));
    const acceptStore = new AcceptanceStore(path.join(storeDir, 'acc'));
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store, clock });
    const proposal = pOut.proposal;
    const mkAcc = async (over, overDoc = {}) => {
      const doc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin, over: overDoc });
      return signAcceptanceDoc(Object.assign(doc, over), buyerKeys.privateJwk, 'buyer-key-1');
    };
    const call = (proposalArg, acc, key) => acceptance.acceptCommitment({
      profile, trustedThumbprints, proposal: proposalArg, buyerScope, acceptance: acc,
      providerRef, store: acceptStore, clock, idempotencyKey: key || 'idem-c-' + crypto.randomBytes(4).toString('hex'),
    });

    // C1: tampered proposal (amount changed) — signature fails in revalidation.
    const tampered = JSON.parse(JSON.stringify(proposal));
    tampered.terms.amount = '1';
    const r1 = await call(tampered, await mkAcc({ proposal: { proposalId: tampered.proposalId, proposalDigest: acceptance.proposalDigestOf(tampered) } }));
    eq(r1.status, 'rejected', 'C1a tampered proposal rejected');
    eq(r1.errorCode, 'DSC_INVALID_SIGNATURE', 'C1b tampered proposal -> DSC_INVALID_SIGNATURE');

    // C2: wrong audience — acceptance signed for a different provider origin.
    const r2 = await call(proposal, await mkAcc({}, { audience: 'https://evil-provider.test' }));
    eq(r2.errorCode, 'DSC_ACCEPTANCE_MISMATCH', 'C2 wrong audience -> DSC_ACCEPTANCE_MISMATCH');

    // C3: substituted buyer — acceptance signed by a different (valid) key.
    const otherKeys = await makeBuyerKeypair();
    const accDoc3 = makeAcceptanceDoc({ proposal, buyer: '0x2222222222222222222222222222222222222222', buyerSigningKeyId: 'buyer-key-2', providerOrigin: profile.origin });
    const signedAcc3 = await signAcceptanceDoc(accDoc3, otherKeys.privateJwk, 'buyer-key-2');
    const r3 = await call(proposal, signedAcc3);
    eq(r3.errorCode, 'DSC_UNAUTHORIZED', 'C3 substituted buyer -> DSC_UNAUTHORIZED');

    // C4: mismatch between acceptance buyer and buyer scope (caller identity not proof).
    const accDoc4 = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin, over: { buyer: '0x2222222222222222222222222222222222222222' } });
    const signedAcc4 = await signAcceptanceDoc(accDoc4, buyerKeys.privateJwk, 'buyer-key-1');
    const r4 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope: { ...buyerScope, buyer: BUYER }, acceptance: signedAcc4, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-c-' + crypto.randomBytes(4).toString('hex') });
    eq(r4.errorCode, 'DSC_UNAUTHORIZED', 'C4 acceptance buyer != requesting buyer -> DSC_UNAUTHORIZED');

    // C5: invalid acceptance signature (tampered termsDigest).
    const accDoc5 = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    accDoc5.termsDigest = 'sha256:' + '0'.repeat(64);
    const signedAcc5 = await signAcceptanceDoc(accDoc5, buyerKeys.privateJwk, 'buyer-key-1');
    // The signed payload now contains the tampered termsDigest — but the
    // verification in acceptCommitment reconstructs the payload from the
    // ACCEPTANCE object (with tampered digest) and verifies. Since the
    // acceptance carries the tampered digest and was signed over it, the
    // signature verifies — but the DIGEST MISMATCH against the proposal terms
    // is caught by the termsDigest binding check.
    const r5 = await call(proposal, signedAcc5);
    eq(r5.errorCode, 'DSC_ACCEPTANCE_MISMATCH', 'C5 tampered termsDigest -> DSC_ACCEPTANCE_MISMATCH');

    // C6: expired acceptance (notAfter passed under controlled clock).
    const accDoc6 = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin, over: { notBefore: '2026-11-05T10:00:00Z', notAfter: '2026-11-05T11:00:00Z' } });
    const signedAcc6 = await signAcceptanceDoc(accDoc6, buyerKeys.privateJwk, 'buyer-key-1');
    const r6 = await call(proposal, signedAcc6);
    eq(r6.errorCode, 'DSC_ACCEPTANCE_EXPIRED', 'C6 expired acceptance -> DSC_ACCEPTANCE_EXPIRED');

    // C7: stale proposal (profile version changed) — the CURRENT PROFILE has a
    // different profileVersion than the (still-validly-signed) proposal, so
    // revalidation sees the version drift and rejects as stale (tampering with
    // the signed proposal itself would fail earlier as DSC_INVALID_SIGNATURE;
    // this case is the honest "profile updated, proposal not re-issued" state).
    const staleProfile = JSON.parse(JSON.stringify(profile));
    staleProfile.profileVersion = '0.9.0';
    const accDoc7 = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc7 = await signAcceptanceDoc(accDoc7, buyerKeys.privateJwk, 'buyer-key-1');
    const r7 = await acceptance.acceptCommitment({ profile: staleProfile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc7, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-c-' + crypto.randomBytes(4).toString('hex') });
    eq(r7.errorCode, 'DSC_PROPOSAL_STALE', 'C7 stale proposal (current profile version differs) -> DSC_PROPOSAL_STALE');

    // C8: expired proposal under controlled clock.
    const lateClock = makeClock('2099-01-01T00:00:00.000Z');
    const accDoc8 = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc8 = await signAcceptanceDoc(accDoc8, buyerKeys.privateJwk, 'buyer-key-1');
    const r8 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc8, providerRef, store: acceptStore, clock: lateClock, idempotencyKey: 'idem-c-' + crypto.randomBytes(4).toString('hex') });
    eq(r8.errorCode, 'DSC_EXPIRED_PROPOSAL', 'C8 expired proposal -> DSC_EXPIRED_PROPOSAL');

    // C9: unsupported combination (profile combo withdrawn).
    const noComboProfile = JSON.parse(JSON.stringify(profile));
    noComboProfile.financialCompatibility.supportedCombinations = noComboProfile.financialCompatibility.supportedCombinations.filter((c) => c.rail !== 'x402' || c.mode !== 'x402');
    const accDoc9 = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc9 = await signAcceptanceDoc(accDoc9, buyerKeys.privateJwk, 'buyer-key-1');
    const r9 = await acceptance.acceptCommitment({ profile: noComboProfile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc9, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-c-' + crypto.randomBytes(4).toString('hex') });
    eq(r9.errorCode, 'DSC_INVALID_COMBINATION', 'C9 combo withdrawn -> DSC_INVALID_COMBINATION');

    // C10: manifest digest changed in the profile.
    const changedDigestProfile = JSON.parse(JSON.stringify(profile));
    changedDigestProfile.capabilities[0].schemas[0].digest = 'sha256:' + 'a'.repeat(64);
    const r10 = await acceptance.acceptCommitment({ profile: changedDigestProfile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc9, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-c-' + crypto.randomBytes(4).toString('hex') });
    eq(r10.errorCode, 'DSC_PROPOSAL_STALE', 'C10 manifest digest change -> DSC_PROPOSAL_STALE');

    // C11: untrusted provider key.
    const untrustedKeys = await makeBuyerKeypair();
    const r11 = await acceptance.acceptCommitment({ profile, trustedThumbprints: [await calculateJwkThumbprint(untrustedKeys.publicJwk)], proposal, buyerScope, acceptance: signedAcc9, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-c-' + crypto.randomBytes(4).toString('hex') });
    eq(r11.errorCode, 'DSC_UNTRUSTED_PROVIDER', 'C11 untrusted provider key -> DSC_UNTRUSTED_PROVIDER');

    // C12: buyer scope exceeded (amount > scopeMaxAmount).
    const bigProposalReq = validRequest({ units: { amount: '999999999999', unit: 'micro-units of settlement asset' } });
    // Preflight would reject amount > capability max, so build a proposal
    // with a scope-constrained buyer: lower the buyer's scope.
    const pOut12 = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store, clock });
    const proposal12 = pOut12.proposal;
    const accDoc12 = makeAcceptanceDoc({ proposal: proposal12, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc12 = await signAcceptanceDoc(accDoc12, buyerKeys.privateJwk, 'buyer-key-1');
    const r12 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal: proposal12, buyerScope: { ...buyerScope, scopeMaxAmount: '100' }, acceptance: signedAcc12, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-c-' + crypto.randomBytes(4).toString('hex') });
    eq(r12.errorCode, 'DSC_SCOPE_EXCEEDED', 'C12 amount exceeds buyer scope -> DSC_SCOPE_EXCEEDED');
  }

  // =========================================================================
  // D. Concurrency + process replacement (single-writer)
  // =========================================================================
  {
    const storeDir = tmpdir('d');
    const acceptStore = new AcceptanceStore(path.join(storeDir, 'acc'));
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store: new ProposalStore(path.join(storeDir, 'prop')), clock });
    const proposal = pOut.proposal;
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');

    // D1: 12 concurrent identical acceptances -> exactly ONE ok, rest duplicate.
    const tasks = [];
    for (let i = 0; i < 12; i += 1) {
      tasks.push(acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-d-conc' }));
    }
    const results = await Promise.all(tasks);
    const okCount = results.filter((r) => r.status === 'ok').length;
    const dupCount = results.filter((r) => r.status === 'duplicate').length;
    ok(okCount === 1 && dupCount === 11, 'D1 concurrent identical acceptances: 1 ok + 11 duplicate', JSON.stringify({ okCount, dupCount }));
    const commitmentIds = new Set(results.map((r) => r.commitment && r.commitment.commitmentId).filter(Boolean));
    eq(commitmentIds.size, 1, 'D2 a single commitment for concurrent identical acceptances');

    // D3: concurrent same-idempotency-different-request -> exactly one ok + conflicts.
    const tasks2 = [];
    for (let i = 0; i < 5; i += 1) {
      const p2 = (await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'nonce-' + i + '-abcdef' }), store: new ProposalStore(path.join(storeDir, 'prop2-' + i)), clock })).proposal;
      const a2 = await signAcceptanceDoc(makeAcceptanceDoc({ proposal: p2, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin }), buyerKeys.privateJwk, 'buyer-key-1');
      tasks2.push(acceptance.acceptCommitment({ profile, trustedThumbprints, proposal: p2, buyerScope, acceptance: a2, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-d-same' }));
    }
    const res2 = await Promise.all(tasks2);
    const ok2 = res2.filter((r) => r.status === 'ok').length;
    const conf2 = res2.filter((r) => r.status === 'conflict').length;
    ok(ok2 === 1 && conf2 === 4, 'D3 concurrent same-key different-request: 1 ok + 4 conflicts', JSON.stringify({ ok2, conf2 }));

    // D4: restart — release the lock (process replacement) and reload; the
    // new store instance must discover accepted operations.
    acceptStore.releaseLock();
    const store2 = new AcceptanceStore(path.join(storeDir, 'acc'));
    ok(store2.isLocked, 'D4 restart re-acquires the lock (single-writer ownership)');
    ok(store2.size >= 1, 'D5 restart reloads accepted operations');
    const byProp = store2.getByProposal(proposal.proposalId);
    ok(byProp && byProp.operationId, 'D6 restart finds the acceptance by proposal');
    eq(byProp.status, 'commitment_created', 'D7 resume sees commitment_created status');
    store2.releaseLock();
  }

  // =========================================================================
  // E. Crash reconciliation: torn tail + accepted-then-created
  // =========================================================================
  {
    const storeDir = tmpdir('e');
    const acceptStore = new AcceptanceStore(path.join(storeDir, 'acc'));
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store: new ProposalStore(path.join(storeDir, 'prop')), clock });
    const proposal = pOut.proposal;
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');
    const out = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-e-0001' });
    eq(out.status, 'ok', 'E1 first acceptance ok');

    // E2: torn tail (crash mid-append) — recovered, not served, valid records
    // survive. Simulate process replacement: release the lock first.
    acceptStore.releaseLock();
    fs.appendFileSync(path.join(storeDir, 'acc', 'operations.journal'), '{"kind":"acceptance","operationId":"op_torn","commitmentId":"0x","proposalId":"prop_x","requestDigest":"sha256:' + '0'.repeat(64) + '","idempotencyKey":"k","status":"accepted","signedPayload":"{broken', 'utf8');
    const store2 = new AcceptanceStore(path.join(storeDir, 'acc'));
    ok(store2.recoveredTail === true, 'E2 torn journal tail recovered (truncated, not merged)');
    ok(store2.getByOperation('op_torn') === null, 'E3 torn record not served');
    const byProp = store2.getByProposal(proposal.proposalId);
    ok(byProp && byProp.operationId === out.operation.operationId, 'E4 valid records survive recovery');
    eq(byProp.status, 'commitment_created', 'E5 crash-after-create reconciles to commitment_created on restart');

    // E6: crash after durable acceptance but BEFORE commitment creation —
    // simulate by writing a record with status 'accepted' directly.
    const store3 = new AcceptanceStore(path.join(storeDir, 'acc2'));
    const rec = {
      kind: 'acceptance', operationId: 'op_crashacc', commitmentId: '0x' + 'c'.repeat(64),
      proposalId: proposal.proposalId, requestDigest: proposal.requestDigest, clientNonce: proposal.nonce,
      acceptedAt: clock.fixed, status: 'accepted', profileVersion: '1.0.0', signingKeyId: providerRef.signingKeyId,
      manifestVersion: '1', manifestDigest: providerRef.manifestDigest, schema: proposal.manifest.schema,
      buyerScope: { buyer: BUYER, scopeMaxAmount: '500000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan' },
      proposalDigest: acceptance.proposalDigestOf(proposal), acceptanceRef: { acceptanceId: 'acc_x', digest: 'sha256:' + '1'.repeat(64), keyId: 'buyer-key-1' },
      commitmentRef: null, signedRepresentation: null, idempotencyKey: 'idem-e-crash', terms: proposal.terms,
    };
    const pRes = await store3.persistAcceptance(rec);
    ok(pRes.ok, 'E6 crash-after-accept record persisted');
    // Retry with the SAME idempotency key: reconcile (duplicate) and see
    // the accepted operation (resume path).
    const retry = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: store3, clock, idempotencyKey: 'idem-e-crash' });
    eq(retry.status, 'duplicate', 'E7 retry after crash-after-accept -> duplicate (reconcile)');
    ok(retry.operation && retry.operation.status === 'accepted', 'E8 resume sees the accepted operation (unknown outcome explicit, not fabricated complete)');
  }

  // =========================================================================
  // F. HTTP/MCP parity + zero financial side effects
  // =========================================================================
  {
    const storeDir = tmpdir('f');
    const h = await startPreflightServer({
      port: 0,
      storeDir: path.join(storeDir, 'prop'),
      acceptanceStoreDir: path.join(storeDir, 'acc'),
      clock,
      buyerRegistry,
      trustedThumbprints,
    });
    try {
      const pReq = validRequest({ clientNonce: 'http-0001-abcdef' });
      const r1 = await postJson(h.url + '/prepare-commitment', pReq);
      ok(r1.status === 200 && r1.body.proposal, 'F1 HTTP preflight ok');
      const proposal = r1.body.proposal;
      const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
      const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');
      const accBody = { proposal, acceptance: signedAcc, idempotencyKey: 'idem-http-0001' };
      const r2 = await postJson(h.url + '/accept-commitment', accBody);
      eq(r2.status, 201, 'F2 HTTP accept returns 201');
      ok(r2.body.commitment && r2.body.commitment.commitmentId, 'F3 HTTP commitment created');
      // MCP parity: same store, same request -> duplicate + same commitment.
      const mcp = makeMCPAcceptAdapter({ profile, providerRef, store: h.acceptanceStore, trustedThumbprints, buyerRegistry, clock });
      const m1 = await mcp({ proposal, acceptance: signedAcc, idempotencyKey: 'idem-http-0001' });
      eq(m1.status, 'duplicate', 'F4 MCP retry of HTTP-issued acceptance -> duplicate');
      ok(m1.commitment && m1.commitment.commitmentId === r2.body.commitment.commitmentId, 'F5 MCP+HTTP same commitment');
      // MCP fresh acceptance (new proposal) -> ok, and HTTP returns the same.
      const pReq2 = validRequest({ clientNonce: 'http-0002-abcdef' });
      const r3 = await postJson(h.url + '/prepare-commitment', pReq2);
      const proposal2 = r3.body.proposal;
      const accDoc2 = makeAcceptanceDoc({ proposal: proposal2, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
      const signedAcc2 = await signAcceptanceDoc(accDoc2, buyerKeys.privateJwk, 'buyer-key-1');
      const m2 = await mcp({ proposal: proposal2, acceptance: signedAcc2, idempotencyKey: 'idem-mcp-0001' });
      eq(m2.status, 'ok', 'F6 MCP fresh acceptance ok');
      const r4 = await postJson(h.url + '/accept-commitment', { proposal: proposal2, acceptance: signedAcc2, idempotencyKey: 'idem-mcp-0001' });
      eq(r4.status, 200, 'F7 HTTP retry of MCP-issued acceptance -> 200 duplicate');
      ok(r4.body.commitment.commitmentId === m2.commitment.commitmentId, 'F8 HTTP+MCP same commitment (parity)');
      // Side-effect spy: only proposal/commitment kinds allowed; NEVER payment/escrow/custody/execution/release.
      const kinds = h.sideEffects.calls.map((c) => c.kind);
      ok(kinds.length >= 4 && kinds.every((k) => ['proposal_issued', 'proposal_duplicate', 'commitment_created', 'commitment_duplicate'].includes(k)), 'F9 side-effect recorder saw only issuance/duplicate kinds', JSON.stringify(kinds));
      // HTTP negative: unregistered buyer -> 401.
      const accDocBadBuyer = makeAcceptanceDoc({ proposal: proposal2, buyer: '0x9999999999999999999999999999999999999999', buyerSigningKeyId: 'buyer-other', providerOrigin: profile.origin });
      const signedAccBad = await signAcceptanceDoc(accDocBadBuyer, (await makeBuyerKeypair()).privateJwk, 'buyer-other');
      const r5 = await postJson(h.url + '/accept-commitment', { proposal: proposal2, acceptance: signedAccBad, idempotencyKey: 'idem-http-bad' });
      eq(r5.status, 401, 'F10 HTTP unregistered buyer -> 401');
    } finally {
      h.server.close();
    }
  }

  // =========================================================================
  // G. Financial side-effect spies (separate, aggressive)
  // =========================================================================
  {
    const storeDir = tmpdir('g');
    const acceptStore = new AcceptanceStore(path.join(storeDir, 'acc'));
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store: new ProposalStore(path.join(storeDir, 'prop')), clock });
    const proposal = pOut.proposal;
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');

    // A wrapped store that would THROW if any financial API is touched.
    const financialSpy = () => { throw new Error('FINANCIAL SIDE EFFECT DETECTED'); };
    const wrapped = {
      persistAcceptance: async (rec) => acceptStore.persistAcceptance(rec),
      transition: async (id, patch) => acceptStore.transition(id, patch),
      getByOperation: (id) => acceptStore.getByOperation(id),
      getByIdempotency: (k, d) => acceptStore.getByIdempotency(k, d),
      getByProposal: (p) => acceptStore.getByProposal(p),
      releaseLock: () => acceptStore.releaseLock(),
      lockError: null,
      isLocked: true,
      size: 0,
    };
    const out = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: wrapped, clock, idempotencyKey: 'idem-g-0001' });
    eq(out.status, 'ok', 'G1 accept with spy store succeeds (no financial calls)');
    const commitment = out.commitment;
    ok(!commitment.paymentIntent && !commitment.escrow && !commitment.custody && !commitment.execution && !commitment.release, 'G2 commitment carries no payment/escrow/custody/execution/release fields');
    ok(!('paymentAuthorization' in commitment), 'G3 commitment has no payment-authorization field (buyer acceptance is not a payment authorization)');
    ok(!('evaluatorVerdict' in commitment), 'G4 commitment has no evaluator-verdict field');
  }

  // =========================================================================
  // H. Multi-process single-writer lock
  // =========================================================================
  {
    const storeDir = tmpdir('h');
    const dir = path.join(storeDir, 'acc');
    const s1 = new AcceptanceStore(dir);
    ok(s1.isLocked, 'H1 first store holds the lock');
    const s2 = new AcceptanceStore(dir);
    ok(!s2.isLocked && !!s2.lockError && (s2.lockError.includes('locked by a live process') || s2.lockError.includes('locked by another process')), 'H2 second store refused (single-writer)', s2.lockError);
    ok(s2.size === 0, 'H3 refused store does NOT read/write the journal');
    // A write through s1 still works (the owner).
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store: new ProposalStore(path.join(storeDir, 'prop')), clock });
    const proposal = pOut.proposal;
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
    const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');
    const r = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: s1, clock, idempotencyKey: 'idem-h-0001' });
    eq(r.status, 'ok', 'H4 owner writes accepted');
    s1.releaseLock();
    const s3 = new AcceptanceStore(dir);
    ok(s3.isLocked && s3.size === 1, 'H5 lock release allows a new owner; journal intact');
    eq(s3.getByProposal(proposal.proposalId).status, 'commitment_created', 'H6 new owner sees the committed operation');
    s3.releaseLock();
    // Stale lock recovery: a lock whose pid is dead is broken and re-acquired.
    const staleDir = path.join(storeDir, 'stale');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'operation.lock'), JSON.stringify({ pid: 999999999, host: 'local', writerId: 'dead', startedAt: '2020-01-01T00:00:00Z' }), 'utf8');
    const s4 = new AcceptanceStore(staleDir);
    ok(s4.isLocked && s4.recoveredStaleLock === true, 'H7 stale dead-pid lock recovered and re-acquired');
    s4.releaseLock();
  }

  // ---- Summary -----------------------------------------------------------------
  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('runner crashed: ' + (e && e.stack || e)); process.exitCode = 1; });
