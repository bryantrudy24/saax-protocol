// Phase-4 end-to-end evidence producer: signed proposal -> buyer acceptance ->
// created commitment -> independent verification. Writes evidence JSON + the
// exact one-request/one-proposal/one-commitment transcript to evidence/.
'use strict';
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); process.exit(1); });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');
const preflight = require('../endpoint/preflight-core');
const acceptance = require('../endpoint/acceptance-core');
const acceptCrypto = require('../endpoint/acceptance-crypto');
const cryptoLib = require('../endpoint/discovery-crypto');
const { ProposalStore } = require('../endpoint/proposal-store');
const { AcceptanceStore } = require('../endpoint/acceptance-store');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence', 'discovery-phase4');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/examples/discovery/profile-phase3-unsigned.json'), 'utf8'));
  const priv = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/examples/discovery/keys/example-private.jwk.json'), 'utf8'));
  const pub = { kty: 'OKP', crv: 'Ed25519', x: priv.x };
  const providerRef = {
    providerId: profile.providerId, name: profile.providerName, origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id, privateJwk: priv, jwkPublic: pub,
    manifestDigest: profile.capabilities[0].schemas[0].digest,
    evaluatorRef: profile.capabilities[0].evaluatorRequirements, permittedDecisions: null,
  };
  const trustedThumbprints = [await calculateJwkThumbprint(pub)];

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'saax-p4-evidence-'));
  const store = new ProposalStore(path.join(dir, 'prop'));
  const acceptStore = new AcceptanceStore(path.join(dir, 'acc'));
  const clock = { nowIso: () => '2026-11-05T12:00:00.000Z' };

  // 1. One complete request
  const request = {
    profileVersion: '1.0.0',
    capability: { id: 'security-scan' },
    schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' },
    units: { amount: '250000000', unit: 'micro-units of settlement asset' },
    financialProfile: { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'x402' },
    constraints: { maxAmount: '250000000', deadline: '2026-11-06T00:00:00Z' },
    intendedParties: { buyer: '0x1111111111111111111111111111111111111111' },
    clientNonce: 'nonce-evidence-0001',
    issuedAt: '2026-11-05T11:59:00Z',
  };

  // 2. Signed proposal
  const propOut = await preflight.prepareCommitment({ profile, providerRef, request, store, clock });
  if (propOut.status !== 'ok') throw new Error('proposal failed: ' + propOut.reason);
  const proposal = propOut.proposal;
  const propVerify = await cryptoLib.verifySignature({
    jws: proposal.signature.jws, publicJwk: pub, expectedKeyId: proposal.signature.keyId,
    expectedPayload: (() => { const p = JSON.parse(JSON.stringify(proposal)); delete p.signature; return p; })(),
  });

  // 3. Buyer acceptance (real buyer keypair)
  const kp = await generateKeyPair('Ed25519', { extractable: true });
  const buyerPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const buyerPub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(JSON.parse(JSON.stringify(proposal.terms))), 'utf8').digest('hex');
  const accDoc = {
    schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_' + crypto.randomBytes(8).toString('hex'), nonce: 'accnonce-evidence-0001',
    buyer: '0x1111111111111111111111111111111111111111',
    provider: { providerId: profile.providerId, signingKeyId: profile.signingKeys[0].id },
    proposal: { proposalId: proposal.proposalId, proposalDigest: acceptance.proposalDigestOf(proposal) },
    termsDigest,
    audience: profile.origin,
    notBefore: '2026-11-05T11:58:00Z', notAfter: '2026-11-05T12:30:00Z',
    versions: { profileVersion: '1.0.0', manifestVersion: '1', schema: proposal.manifest.schema },
  };
  const signedAcc = await acceptCrypto.signAcceptance({ acceptance: accDoc, buyerPrivateJwk: buyerPriv, keyId: 'buyer-key-evidence' });
  const accVerify = await cryptoLib.verifySignature({
    jws: signedAcc.signature.jws, publicJwk: buyerPub, expectedKeyId: 'buyer-key-evidence',
    expectedPayload: (() => { const a = JSON.parse(JSON.stringify(signedAcc)); delete a.signature; return a; })(),
  });

  // 4. acceptCommitment (buyer scope from registry)
  const buyerScope = { buyer: '0x1111111111111111111111111111111111111111', buyerPublicJwk: buyerPub, scopeMaxAmount: '500000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan' };
  const res = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-evidence-0001' });
  if (res.status !== 'ok') throw new Error('accept failed: ' + res.errorCode + ' ' + res.reason);

  // 5. Independent verification of the commitment (no app DB access)
  const sr = res.commitment.signedRepresentation;
  const srPayload = JSON.parse(Buffer.from(sr.jws.split('.')[1], 'base64url').toString());
  const srVerify = await cryptoLib.verifySignature({ jws: sr.jws, publicJwk: pub, expectedKeyId: sr.keyId, expectedPayload: srPayload });
  const manifestCheck = res.commitment.manifest.price.amount === proposal.terms.amount
    && res.commitment.manifest.buyerAgentId === buyerScope.buyer.toLowerCase()
    && res.commitment.manifest.capability === 'security-scan'
    && !!res.commitment.manifest.manifestHash;

  // 6. Duplicate replay (idempotency)
  const dup = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: 'idem-evidence-0001' });

  const artifact = {
    phase: '4',
    generatedAt: new Date().toISOString(),
    repo: 'solvent-applied-saax-protocol',
    request,
    proposal: { status: propOut.status, proposalId: proposal.proposalId, requestDigest: proposal.requestDigest, signatureVerified: propVerify.ok },
    acceptance: { schemaVersion: signedAcc.schemaVersion, acceptanceId: signedAcc.acceptanceId, buyer: signedAcc.buyer, signatureVerified: accVerify.ok, termsDigest },
    commitment: {
      status: res.status,
      operationId: res.operation.operationId,
      operationStatus: res.operation.status,
      commitmentId: res.commitment.commitmentId,
      manifestHash: res.commitment.manifestHash,
      manifest: res.commitment.manifest,
      signedRepresentation: {
        version: sr.version, keyId: sr.keyId, signedAt: sr.signedAt,
        payload: srPayload,
        signatureVerified: srVerify.ok,
        bindingChecks: { proposalId: srPayload.proposalId === proposal.proposalId, commitmentId: srPayload.commitmentId === res.commitment.commitmentId, manifestDigest: srPayload.manifestDigest === res.commitment.manifestHash },
      },
      manifestChecks: { amountMatches: manifestCheck, buyerBound: res.commitment.manifest.buyerAgentId === buyerScope.buyer.toLowerCase() },
    },
    duplicateReplay: { status: dup.status, sameOperation: dup.operation && dup.operation.operationId === res.operation.operationId },
    financialSideEffects: 'NONE (acceptance path calls only the acceptance store + crypto signer; no payment/custody/execution/release fields in the commitment)',
  };

  fs.writeFileSync(path.join(OUT, 'end-to-end-evidence.json'), JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({
    proposalStatus: propOut.status, proposalId: proposal.proposalId, proposalSignatureVerified: propVerify.ok,
    acceptanceSignatureVerified: accVerify.ok,
    commitmentStatus: res.status, commitmentId: res.commitment.commitmentId, operationStatus: res.operation.status,
    srSignatureVerified: srVerify.ok, srBinding: { proposalId: srPayload.proposalId === proposal.proposalId, commitmentId: srPayload.commitmentId === res.commitment.commitmentId, manifestDigest: srPayload.manifestDigest === res.commitment.manifestHash },
    manifestOk: manifestCheck, duplicate: dup.status === 'duplicate',
    artifact: 'evidence/discovery-phase4/end-to-end-evidence.json',
  }, null, 2));
}

main().catch((e) => { console.error('EVIDENCE FAIL:', e); process.exit(1); });
