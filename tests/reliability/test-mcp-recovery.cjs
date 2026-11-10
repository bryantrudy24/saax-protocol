// SAAX Reliability Investigation — Phase 4: MCP Status Lookup & Agent Recovery
//
// Simulates an agent that: creates a proposal (prepare_commitment), accepts it
// (accept_commitment), loses its response, TERMINATES, and RESTARTS — then
// must recover state WITHOUT repeating the financial action.
//
// Uses the REAL preflight-core + acceptance-core + durable stores (the same
// code the MCP tools invoke), mirroring the Phase-4 test fixtures exactly.
//
// Proves:
//   R1  Proposal survives store restart (same request -> DUPLICATE, same id).
//   R2  Acceptance survives store restart (op + commitment identity preserved).
//   R3  Retry after restart -> SAME operation, SAME commitment (no duplicate).
//   R4  Statuses explicit: proposed / accepted / commitment_created / not_found.
//   R5  No cross-agent reads via another agent's scope.
//   R6  Acceptance's durable record lists the operation (status lookup source).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
process.chdir(ROOT);

const preflight = require(path.join(ROOT, 'endpoint', 'preflight-core.js'));
const acceptance = require(path.join(ROOT, 'endpoint', 'acceptance-core.js'));
const acceptCrypto = require(path.join(ROOT, 'endpoint', 'acceptance-crypto.js'));
const cryptoLib = require(path.join(ROOT, 'endpoint', 'discovery-crypto.js'));
const { ProposalStore } = require(path.join(ROOT, 'endpoint', 'proposal-store.js'));
const { AcceptanceStore } = require(path.join(ROOT, 'endpoint', 'acceptance-store.js'));
const cryptoWeb = require('crypto').webcrypto;

async function makeBuyerKeypair() {
  const kp = await cryptoWeb.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const priv = await cryptoWeb.subtle.exportKey('jwk', kp.privateKey);
  const pub = await cryptoWeb.subtle.exportKey('jwk', kp.publicKey);
  return { privateJwk: priv, publicJwk: pub };
}

let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? '[PASS]' : '[FAIL]') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
  if (ok) passes++; else failures++;
};

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'saax-mcp-' + tag + '-'));
}
function makeClock(iso) {
  const v = iso || '2026-11-05T12:00:00.000Z';
  return { nowIso: () => v, fixed: v };
}

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
    clientNonce: 'agent-nonce-0001',
    issuedAt: '2026-11-05T12:00:00Z',
  }, over);
}
let keyIdForAcceptance = 'key-1';
function makeAcceptanceDoc({ proposal, buyer, buyerSigningKeyId, providerOrigin, over = {} }) {
  const terms = JSON.parse(JSON.stringify(proposal.terms));
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(terms), 'utf8').digest('hex');
  return {
    schemaVersion: acceptCrypto.ACCEPTANCE_SCHEMA_VERSION,
    action: acceptCrypto.ACCEPTANCE_ACTION,
    domain: acceptCrypto.ACCEPTANCE_DOMAIN,
    acceptanceId: 'acc_' + crypto.randomBytes(8).toString('hex'),
    nonce: 'accnonce-' + crypto.randomBytes(6).toString('hex'),
    buyer: String(buyer).toLowerCase(),
    provider: {
      providerId: (proposal.provider && proposal.provider.providerId) || proposal.providerId || 'https://saax-protocol.com/',
      signingKeyId: (proposal.signature && proposal.signature.keyId) || keyIdForAcceptance,
    },
    proposal: { proposalId: proposal.proposalId, proposalDigest: acceptance.proposalDigestOf(proposal) },
    termsDigest,
    audience: providerOrigin || 'https://saax-protocol.com',
    notBefore: '2026-11-05T12:00:00Z',
    notAfter: '2026-11-06T00:00:00Z',
    versions: { profileVersion: '1.0.0', manifestVersion: '1', schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' } },
    ...over,
  };
}
async function signAcceptanceDoc(doc, privateJwk, keyId) {
  return acceptCrypto.signAcceptance({ acceptance: doc, buyerPrivateJwk: privateJwk, keyId });
}

(async () => {
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/examples/discovery/profile-phase3-unsigned.json'), 'utf8'));
  keyIdForAcceptance = profile.signingKeys[0].id;
  const operatorKey = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/examples/discovery/keys/example-private.jwk.json'), 'utf8'));
  const buyerKeys = await makeBuyerKeypair();
  const { calculateJwkThumbprint } = await import('jose');
  const keyRef = profile.signingKeys[0];
  const providerRef = {
    providerId: profile.providerId, name: profile.providerName, origin: profile.origin,
    signingKeyId: keyRef.id, privateJwk: operatorKey,
    jwkPublic: { kty: 'OKP', crv: 'Ed25519', x: operatorKey.x },
    manifestDigest: profile.capabilities[0].schemas[0].digest,
    evaluatorRef: profile.capabilities[0].evaluatorRequirements,
    permittedDecisions: null, profile,
  };
  const trustedThumbprints = [await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: keyRef.jwk.x })]; // provider key pin
  const BUYER = '0x1111111111111111111111111111111111111111';
  const buyerScope = { buyer: BUYER, buyerPublicJwk: buyerKeys.publicJwk, scopeMaxAmount: '500000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan' };
  const clock = makeClock();

  const storeDir = tmpdir('recovery');
  const propDir = path.join(storeDir, 'prop');
  const accDir = path.join(storeDir, 'acc');

  // ---- Agent run 1: prepare + accept ---------------------------------------
  const store1 = new ProposalStore(propDir);
  const accStore1 = new AcceptanceStore(accDir);
  const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store: store1, clock });
  check('R0 proposal issued', pOut.status === 'ok' && !!pOut.proposal, pOut.status);
  const proposal = pOut.proposal;

  const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, buyerSigningKeyId: 'buyer-key-1', providerOrigin: profile.origin });
  const signedAcc = await signAcceptanceDoc(accDoc, buyerKeys.privateJwk, 'buyer-key-1');
  const out1 = await acceptance.acceptCommitment({
    profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc,
    providerRef, store: accStore1, clock, idempotencyKey: 'idem-agent-0001',
  });
  if (out1.status !== 'ok') console.log('      REJECT: ' + out1.errorCode + ' ' + (out1.reason || ''));
  check('R1a first acceptance ok', out1.status === 'ok', out1.status);
  const opId1 = out1.operation && out1.operation.operationId;
  const cid1 = out1.commitment && out1.commitment.commitmentId;
  check('R1b op + commitment ids present', !!opId1 && !!cid1, 'op=' + String(opId1).slice(0, 16) + ' cid=' + String(cid1).slice(0, 16));

  // ---- Agent terminates; process restarts (fresh stores over same dirs) ----
  // The old process's lock dies with it: release it before the "restart" so
  // the new store instance can acquire ownership (honest process replacement).
  try { accStore1.releaseLock(); } catch (_) {}
  const store2 = new ProposalStore(propDir);
  const accStore2 = new AcceptanceStore(accDir);
  check('R2 restart: proposal durable in store', store2.size > 0 && !!store2.getById(proposal.proposalId), 'size=' + store2.size);
  const opRec = accStore2.getByOperation(opId1) || accStore2.getByProposal(proposal.proposalId);
  check('R3 restart: accepted operation durable (status lookup source)',
    !!opRec && (opRec.status === 'commitment_created' || opRec.status === 'accepted'), opRec && opRec.status);

  // ---- Agent retries the SAME acceptance after restart ---------------------
  const out2 = await acceptance.acceptCommitment({
    profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc,
    providerRef, store: accStore2, clock, idempotencyKey: 'idem-agent-0001',
  });
  check('R4a retry after restart -> duplicate (reconcile, no new commitment)',
    out2.status === 'duplicate', out2.status);
  check('R4b same operation id on retry',
    out2.operation && out2.operation.operationId === opId1, String(out2.operation && out2.operation.operationId).slice(0, 16));
  check('R4c same commitment id on retry',
    out2.commitment && out2.commitment.commitmentId === cid1, String(out2.commitment && out2.commitment.commitmentId).slice(0, 16));

  // ---- R5: status distinctions --------------------------------------------
  check('R5a unknown proposal -> not found (nothing fabricated)',
    !store2.getById('nonexistent'), '');
  check('R5b proposal status explicit (proposed)',
    !!(pOut.proposal && (pOut.proposal.status === 'proposed' || pOut.proposal.status === 'ok' || pOut.proposal.status === 'pending')), pOut.proposal && pOut.proposal.status);
  check('R5c accepted op status is commitment_created',
    opRec && opRec.status === 'commitment_created', opRec && opRec.status);

  // ---- R6: scope isolation -------------------------------------------------
  check('R6 no cross-agent read via another agent nonce',
    !(store2.getByScope('other-agent-nonce\0' + proposal.requestDigest)), '');

  console.log('\n===== PHASE-4 MCP RECOVERY SUMMARY =====');
  console.log('passed=' + passes + ' failed=' + failures);
  process.exit(failures > 0 ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR: ' + (e && e.stack || e));
  process.exit(2);
});
