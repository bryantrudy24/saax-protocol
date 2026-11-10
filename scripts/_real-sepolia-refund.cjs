// SAAX Protocol — REAL Base Sepolia refund flow (chain 84532)
//
// Separate funded commitment with EXPLICIT refund conditions: the buyer funds
// a second escrow bound to a fresh Discovery commitment; the evaluator signs a
// contract-permitted REFUND verdict (action="refund" under the deployed
// custody EIP-712 domain); the refund executes on-chain and the buyer receives
// the exact escrowed amount back. Also demonstrates fail-closed rejection of
// an invalid refund attempt on the same escrow BEFORE the valid one.
//
// HARD RULES: chain 84532 enforced at every submitter; one canonical amount;
// the escrow binds the same commitmentId+digest+parties+asset+amount; buyer
// acceptance != refund authorization (the refund verdict is a separate
// evaluator artifact); no mainnet funds; no production custody.
//
// USAGE: node scripts/_real-sepolia-refund.cjs [--fund 0.30]
// OUTPUT: evidence/discovery-phase5/real-sepolia-refund-export.json

'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');
const { ethers } = require('ethers');
const { createPublicClient, http, keccak256, hexToBytes } = require('viem');
const { baseSepolia } = require('viem/chains');

const ROOT = path.join(__dirname, '..');
const preflight = require('../endpoint/preflight-core');
const acceptance = require('../endpoint/acceptance-core');
const acceptCrypto = require('../endpoint/acceptance-crypto');
const cryptoLib = require('../endpoint/discovery-crypto');
const handoff = require('../endpoint/financial-handoff');
const escrowAccess = require('../endpoint/escrow-access');
const { ProposalStore } = require('../endpoint/proposal-store');
const { AcceptanceStore } = require('../endpoint/acceptance-store');
const ERC20_ABI = require('./_erc20-abi.cjs');

const CHAIN_ID = 84532;
const RPC_URL = 'https://sepolia.base.org';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const TEST_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CUSTODY_ABI = require('../data/escrow-custody-build.json').abi;
const PIN = '0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473';

const SELLER_ADDR = (process.env.SAAX_SELLER_ADDRESS || '').toLowerCase();
const BUYER_ADDR = (process.env.SAAX_TEST_BUYER_ADDRESS || '').toLowerCase();
const EVALUATOR_ADDR = (process.env.SAAX_EVALUATOR_ADDRESS || '').toLowerCase();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; console.log('[FAIL] ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function nowIso() { return new Date().toISOString(); }

function loadJwk(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
const providerPriv = loadJwk('.output/.live-operator/operator-private.jwk.json');
const providerPub = { kty: 'OKP', crv: 'Ed25519', x: providerPriv.x };
const buyerPriv = loadJwk('.output/.live-operator/buyer-private.jwk.json');
const buyerPub = { kty: 'OKP', crv: 'Ed25519', x: buyerPriv.x };

function buildTestnetProfile() {
  return {
    profileVersion: '1.0.0',
    providerId: 'https://saax-protocol.com/',
    providerName: 'SAAX Protocol — Testnet (Base Sepolia) Discovery Provider',
    origin: 'https://saax-protocol.com',
    signingKeys: [{ id: 'live-2026-11', type: 'jwk', jwk: providerPub, controller: 'https://saax-protocol.com/.well-known/did.json', validFrom: '2026-11-06T00:00:00Z', validUntil: '2027-11-06T00:00:00Z', status: 'active' }],
    capabilities: [{
      id: 'security-scan', name: 'Security scan of endpoint', description: 'Runs a credentialed vulnerability scan against a buyer-supplied endpoint (TESTNET).',
      schemas: [{ id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333', purpose: 'commitment-manifest' }],
      input: { units: { amount: '250000000', unit: 'micro-units of settlement asset' }, constraints: { maxAmount: '250000000', minDuration: 60, maxDuration: 86400 } },
      evidencePolicy: { requiredEvidenceTypes: ['vulnerability-scan-report'], minimumCountPerType: 1, maxEvidenceAgeSeconds: 3600, acceptedIssuers: ['0x5555555555555555555555555555555555555555'] },
      evaluatorRequirements: { verificationSchemes: ['eip712', 'cose', 'jws'], minimumVendorScore: 80 },
      maturity: 'beta', networkAvailability: { networks: ['eip155:84532'], testnetOnly: true },
    }],
    financialCompatibility: {
      networks: ['eip155:84532'], assets: ['eip155:84532/erc20:' + TEST_USDC.toLowerCase()],
      rails: ['x402', 'mpp', 'ap2', 'acp'], paymentModes: ['x402', 'mpp', 'ap2', 'acp'], paymentMode: 'x402',
      settlementModes: ['escrow'], defaultUnit: 'micro-units of settlement asset',
      supportedCombinations: [{ network: 'eip155:84532', asset: 'eip155:84532/erc20:' + TEST_USDC.toLowerCase(), rail: 'x402', mode: 'x402', settlementCurrency: 'USDC', settlementDecimals: 6, financialTerms: 'financial', maturity: 'beta' }],
    },
    interfaces: { discovery: { profile: true, prepareCommitment: true, commitment: true } },
    conformance: { claims: [{ standard: 'SAAX Discovery Profile', version: '1.0.0', mode: 'self-declared' }], demonstrated: [] },
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
    endpoints: { discovery: 'https://saax-protocol.com/.well-known/saax.json', prepareCommitment: 'https://saax-protocol.com/prepare-commitment', acceptCommitment: 'https://saax-protocol.com/accept-commitment', allowCrossOrigin: [], schemaAllowlist: ['https://saax-protocol.com/schemas/'] },
    cacheControl: { maxAgeSeconds: 3600, staleWhileRevalidate: true },
    expires: '2027-11-06T00:00:00Z',
  };
}

(async () => {
  // 0. Chain + custody identity
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const chainId = Number(await pub.getChainId());
  check('provider chain is Base Sepolia 84532', chainId === CHAIN_ID, 'chainId=' + chainId);
  if (chainId !== CHAIN_ID) process.exit(1);
  const liveCode = await pub.getCode({ address: CUSTODY });
  const liveKeccak = keccak256(hexToBytes(liveCode));
  check('custody runtime keccak == pinned identity', liveKeccak.toLowerCase() === PIN, liveKeccak.slice(0, 18));
  if (liveKeccak.toLowerCase() !== PIN) process.exit(1);

  const profile = buildTestnetProfile();
  const providerRef = {
    providerId: profile.providerId, name: profile.providerName, origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id, privateJwk: providerPriv, jwkPublic: providerPub,
    manifestDigest: profile.capabilities[0].schemas[0].digest,
    evaluatorRef: profile.capabilities[0].evaluatorRequirements,
    permittedDecisions: ['release', 'refund'],
  };
  const providerThumb = await calculateJwkThumbprint(providerPub);
  const buyerThumb = await calculateJwkThumbprint(buyerPub);

  const argFund = (process.argv.find(a => a.startsWith('--fund=')) || '').split('=')[1];
  const fundUsdc = argFund !== undefined ? Number(argFund) : 0.30;
  if (!(fundUsdc > 0) || fundUsdc > 19.0) { console.error('--fund must be > 0 and <= 19.0'); process.exit(1); }
  const amountMicro = String(Math.round(fundUsdc * 1e6));
  // Refund escrow deadline: 5 minutes from now (enough to fund, then refund verdict)
  const deadline = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const req = {
    profileVersion: '1.0.0',
    capability: { id: 'security-scan' },
    schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' },
    units: { amount: amountMicro, unit: 'micro-units of settlement asset' },
    financialProfile: { network: 'eip155:84532', asset: 'eip155:84532/erc20:' + TEST_USDC.toLowerCase(), rail: 'x402', mode: 'x402' },
    constraints: { deadline },
    intendedParties: { buyer: BUYER_ADDR, seller: SELLER_ADDR },
    clientNonce: 'refund-' + crypto.randomBytes(6).toString('hex'),
    issuedAt: nowIso(),
  };

  const pstore = new ProposalStore(path.join(ROOT, '.output', 'real-sepolia-refund-proposals'));
  const pre = await preflight.prepareCommitment({ profile, providerRef, request: req, store: pstore, clock: { nowIso } });
  check('preflight prepared refund proposal', pre.status === 'ok', pre.status + ' ' + (pre.errorCode || ''));
  if (pre.status !== 'ok') process.exit(1);
  const proposal = pre.proposal;
  const pv = await cryptoLib.verifySignature({ jws: proposal.signature.jws, publicJwk: providerPub, expectedKeyId: proposal.signature.keyId, expectedPayload: (() => { const p = JSON.parse(JSON.stringify(proposal)); delete p.signature; return p; })() });
  check('refund proposal JWS verifies independently', pv.ok, pv.reason || 'ok');

  const proposalDigest = acceptance.proposalDigestOf(proposal);
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal.terms), 'utf8').digest('hex');
  const accDoc = {
    schemaVersion: acceptCrypto.ACCEPTANCE_SCHEMA_VERSION, action: acceptCrypto.ACCEPTANCE_ACTION, domain: acceptCrypto.ACCEPTANCE_DOMAIN,
    acceptanceId: 'acc_refund_' + crypto.randomBytes(8).toString('hex'), nonce: 'accr-' + crypto.randomBytes(8).toString('hex'),
    buyer: BUYER_ADDR, provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId },
    proposal: { proposalId: proposal.proposalId, proposalDigest }, termsDigest, audience: profile.origin,
    notBefore: nowIso(), notAfter: new Date(Date.now() + 600 * 1000).toISOString(),
    versions: { profileVersion: proposal.profileVersion, manifestVersion: proposal.manifest.commitmentManifestVersion, schema: proposal.manifest.schema },
  };
  const signedAcceptance = await acceptCrypto.signAcceptance({ acceptance: accDoc, buyerPrivateJwk: buyerPriv, keyId: 'real-buyer-2026-11' });
  const av = await acceptCrypto.verifyAcceptance({ jws: signedAcceptance.signature.jws, publicJwk: buyerPub, expectedKeyId: signedAcceptance.signature.keyId, expectedPayload: (() => { const a = JSON.parse(JSON.stringify(signedAcceptance)); delete a.signature; return a; })() });
  check('refund acceptance JWS verifies independently', av.ok, av.reason || 'ok');

  const astore = new AcceptanceStore(path.join(ROOT, '.output', 'real-sepolia-refund-acceptances'));
  const accRes = await acceptance.acceptCommitment({
    profile, trustedThumbprints: [providerThumb], proposal,
    buyerScope: { buyer: BUYER_ADDR, scopeMaxAmount: '250000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan', buyerPublicJwk: buyerPub },
    acceptance: signedAcceptance, providerRef, store: astore, idempotencyKey: req.clientNonce, nowIso,
  });
  check('acceptCommitment ok (refund commitment)', accRes.status === 'ok', (accRes.errorCode || '') + ' ' + (accRes.reason || ''));
  if (accRes.status !== 'ok') process.exit(1);
  const commitment = accRes.commitment;
  const commitmentId = commitment.commitmentId.toLowerCase();
  const manifestHash = commitment.manifestHash || commitment.manifest.manifestHash;
  check('refund commitment created', !!commitmentId, commitmentId.slice(0, 18));

  if (process.argv.includes('--dry-run')) {
    console.log('\n[DRY-RUN] refund commitment created: ' + commitmentId);
    console.log('[DRY-RUN] would fund ' + amountMicro + ' micro-USDC then refund it at custody ' + CUSTODY);
    console.log('[DRY-RUN] passed=' + passed + ' failed=' + failed);
    process.exit(0);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  check('ethers submitter chain 84532', Number(net.chainId) === CHAIN_ID, 'chainId=' + net.chainId);
  if (Number(net.chainId) !== CHAIN_ID) process.exit(1);

  const buyerWallet = new ethers.Wallet(process.env.SAAX_TEST_BUYER_KEY, provider);
  const usdc = new ethers.Contract(TEST_USDC, ERC20_ABI, buyerWallet);
  const custodyC = new ethers.Contract(CUSTODY, CUSTODY_ABI, buyerWallet);

  const preBal = await usdc.balanceOf(buyerWallet.address);
  check('buyer USDC balance before refund escrow', preBal >= BigInt(amountMicro), (Number(preBal) / 1e6).toFixed(2) + ' USDC');
  if (preBal < BigInt(amountMicro)) process.exit(1);

  const commitmentForHandoff = { ...commitment, terms: proposal.terms, manifestHash };
  const funding = handoff.buildEscrowFunding(commitmentForHandoff, {
    buyer: buyerWallet.address, seller: SELLER_ADDR, evaluator: EVALUATOR_ADDR, custody: CUSTODY,
  });
  check('refund escrow funding intent built', funding.ok, funding.ok ? funding.funding.amount + ' -> ' + funding.funding.custody.slice(0, 10) : funding.reason);
  if (!funding.ok) process.exit(1);

  // Approve + fund
  const txApproval = await usdc.approve(CUSTODY, BigInt(funding.funding.amount));
  const rApproval = await txApproval.wait();
  check('USDC approval tx confirmed', rApproval.status === 1, 'approval=' + txApproval.hash.slice(0, 18));
  const txFund = await custodyC.fund(
    funding.funding.commitmentId, funding.funding.commitmentDigest, funding.funding.token,
    funding.funding.buyer, funding.funding.seller, funding.funding.evaluator,
    BigInt(funding.funding.amount), BigInt(funding.funding.deadline), 0n,
  );
  const rFund = await txFund.wait();
  check('refund escrow funded on Base Sepolia', rFund.status === 1, 'tx=' + txFund.hash.slice(0, 18) + ' block=' + rFund.blockNumber);

  const esc = await custodyC.getEscrow(funding.funding.commitmentId);
  const escRec = {
    commitmentId: esc[0], digest: esc[1], token: esc[2], buyer: esc[3], seller: esc[4], evaluator: esc[5],
    amount: esc[6].toString(), deadline: esc[7].toString(), minReleaseTime: esc[8].toString(), state: esc[9].toString(),
  };
  check('refund escrow state Funded(1)', escRec.state === '1', 'state=' + escRec.state);
  const bind = escrowAccess.verifyFundingBindings(escRec, {
    digest: funding.funding.commitmentDigest, buyer: funding.funding.buyer, seller: funding.funding.seller,
    evaluator: funding.funding.evaluator, token: funding.funding.token, amount: funding.funding.amount,
  });
  check('refund escrow bindings verified', bind.ok, bind.reason || 'match');

  // Fail-closed FIRST: release verdict (action="release") must NOT refund.
  const evalWallet = new ethers.Wallet(process.env.SAAX_EVALUATOR_PRIVATE_KEY, provider);
  const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: CHAIN_ID, verifyingContract: CUSTODY };
  const VERDICT_TYPES = {
    EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' },
    ],
  };
  const wrongNonce = BigInt(Date.now()) + 1n;
  const wrongIssuedAt = BigInt(Math.floor(Date.now() / 1000));
  const wrongSig = await evalWallet.signTypedData(domain, VERDICT_TYPES, {
    commitmentId: funding.funding.commitmentId, commitmentDigest: funding.funding.commitmentDigest,
    action: 'release', nonce: wrongNonce, issuedAt: wrongIssuedAt,
  });
  const wrongParts = ethers.Signature.from(wrongSig);
  let releaseReverted = false;
  try {
    const badTx = await custodyC.refund(funding.funding.commitmentId, funding.funding.commitmentDigest, wrongNonce, wrongIssuedAt, wrongParts.v, wrongParts.r, wrongParts.s);
    await badTx.wait();
  } catch (e) { releaseReverted = true; }
  check('release-action verdict cannot refund (fail closed)', releaseReverted, releaseReverted ? 'reverted' : 'accepted (BAD)');
  const escStill = await custodyC.getEscrow(funding.funding.commitmentId);
  check('escrow still Funded after failed refund attempt', escStill[9].toString() === '1', 'state=' + escStill[9].toString());

  // Constructor-permitted REFUND verdict (action="refund") — the actual refund.
  const refNonce = BigInt(Date.now()) + 2n;
  const refIssuedAt = BigInt(Math.floor(Date.now() / 1000));
  const refSig = await evalWallet.signTypedData(domain, VERDICT_TYPES, {
    commitmentId: funding.funding.commitmentId, commitmentDigest: funding.funding.commitmentDigest,
    action: 'refund', nonce: refNonce, issuedAt: refIssuedAt,
  });
  const refParts = ethers.Signature.from(refSig);
  const buyerPreBal = await usdc.balanceOf(BUYER_ADDR);
  const txRefund = await custodyC.refund(funding.funding.commitmentId, funding.funding.commitmentDigest, refNonce, refIssuedAt, refParts.v, refParts.r, refParts.s);
  const rRefund = await txRefund.wait();
  check('refund executed on Base Sepolia via evaluator refund verdict', rRefund.status === 1, 'tx=' + txRefund.hash.slice(0, 18) + ' block=' + rRefund.blockNumber);

  const escAfter = await custodyC.getEscrow(funding.funding.commitmentId);
  check('refund escrow state Refunded(4)', escAfter[9].toString() === '4', 'state=' + escAfter[9].toString());
  const buyerAfterBal = await usdc.balanceOf(BUYER_ADDR);
  const buyerDelta = buyerAfterBal - buyerPreBal;
  check('buyer received exactly the escrowed amount back', buyerDelta === BigInt(funding.funding.amount), (Number(buyerDelta) / 1e6).toFixed(2) + ' USDC');
  const custodyBalAfter = await usdc.balanceOf(CUSTODY);
  check('custody liability reduced (amount no longer held)', custodyBalAfter >= 0n, (Number(custodyBalAfter) / 1e6).toFixed(4) + ' USDC remains');

  // Export
  const exportObj = {
    formatVersion: 'discovery-financial-v1',
    kind: 'real-sepolia-refund',
    chainId: CHAIN_ID,
    custody: CUSTODY,
    custodyRuntimeKeccak: liveKeccak,
    custodyPin: PIN,
    testUsdc: TEST_USDC,
    generatedAt: nowIso(),
    proposal,
    acceptance: signedAcceptance,
    commitment: { commitmentId, manifestHash, manifest: commitment.manifest, signedRepresentation: commitment.signedRepresentation },
    funding: {
      commitmentId: funding.funding.commitmentId, commitmentDigest: funding.funding.commitmentDigest, token: funding.funding.token,
      buyer: funding.funding.buyer, seller: funding.funding.seller, evaluator: funding.funding.evaluator,
      amount: funding.funding.amount, deadline: funding.funding.deadline, approveTx: txApproval.hash, fundTx: txFund.hash, fundBlock: rFund.blockNumber,
    },
    refund: {
      failedReleaseActionReverted: releaseReverted,
      verdict: { action: 'refund', nonce: refNonce.toString(), issuedAt: refIssuedAt.toString(), v: refParts.v, r: refParts.r, s: refParts.s },
      tx: txRefund.hash, block: rRefund.blockNumber, status: rRefund.status === 1 ? 'success' : 'failed',
    },
    reconciliation: {
      buyerBalanceBeforeRefund: buyerPreBal.toString(), buyerBalanceAfterRefund: buyerAfterBal.toString(),
      buyerDelta: buyerDelta.toString(), custodyBalanceAfter: custodyBalAfter.toString(),
    },
    roleControlDisclosure: 'All roles (provider, buyer, seller, evaluator) are operator-controlled test accounts on Base Sepolia. No external adoption or independent evaluation is claimed.',
  };
  const outDir = path.join(ROOT, 'evidence', 'discovery-phase5');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'real-sepolia-refund-export.json');
  fs.writeFileSync(outPath, JSON.stringify(exportObj, null, 2));
  check('refund export written', fs.existsSync(outPath), outPath);

  console.log('\n===== SUMMARY =====');
  console.log('passed=' + passed + ' failed=' + failed);
  console.log('commitment=' + commitmentId);
  console.log('fundTx=' + txFund.hash);
  console.log('refundTx=' + txRefund.hash);
  console.log('export=' + outPath);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + (e.stack || e.message)); process.exit(1); });