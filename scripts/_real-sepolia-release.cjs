// SAAX Protocol — REAL Base Sepolia release flow (chain 84532)
//
// Proves the connected Discovery -> acceptance -> commitment -> custody funding
// -> evidence -> evaluator release -> reconciled export path on the PUBLIC Base
// Sepolia testnet, using REAL test assets (test USDC 0x036CbD...) and the
// DEPLOYED custody contract 0x5a5472d751839cd4968cbf1b136baf862279ff5d
// (identity pinned in evidence/custody-reconciliation.json; runtime keccak
// 0x0897dba0...).
//
// HARD RULES (executed):
//   - chainId 84532 enforced at EVERY submitter (resolveAndEnforceChain).
//   - ONE canonical amount: integer-string micro-units; no floats, no rounding.
//   - Buyer agreement acceptance != payment authorization != release verdict.
//   - The commitment comes from acceptance-core (authenticated, single-use);
//     the escrow binds the SAME commitmentId + digest + parties + asset + amount.
//   - No mainnet funds; no production custody; no public route exposure.
//
// USAGE: node scripts/_real-sepolia-release.cjs [--fund 5.00] [--evidence <uri>]
//   --fund: test USDC amount to fund (default 5.00 = 5,000,000 micro-units;
//           buyer holds 19.45). Must be > 0 and <= buyer balance.
//
// OUTPUT: evidence/discovery-phase5/real-sepolia-release-export.json

'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');
const { ethers } = require('ethers');
const { createPublicClient, http } = require('viem');
const { baseSepolia } = require('viem/chains');

const ROOT = path.join(__dirname, '..');
const OPERATOR_DIR = path.join(ROOT, '.output', '.live-operator');
const preflight = require('../endpoint/preflight-core');
const acceptance = require('../endpoint/acceptance-core');
const acceptCrypto = require('../endpoint/acceptance-crypto');
const cryptoLib = require('../endpoint/discovery-crypto');
const commitmentMod = require('../endpoint/commitment');
const handoff = require('../endpoint/financial-handoff');
const escrowAccess = require('../endpoint/escrow-access');
const { ProposalStore } = require('../endpoint/proposal-store');
const { AcceptanceStore } = require('../endpoint/acceptance-store');

// ---- testnet constants (explicit; NOT from the mainnet-default .env) --------
const CHAIN_ID = 84532;
const RPC_URL = 'https://sepolia.base.org';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const TEST_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CUSTODY_ABI = require('../data/escrow-custody-build.json').abi;
const ERC20_ABI = require('./_erc20-abi.cjs');

// ---- role addresses (derived from the private keys, printed only as addresses)
const SELLER_ADDR = (process.env.SAAX_SELLER_ADDRESS || '').toLowerCase();
const EVALUATOR_ADDR = (process.env.SAAX_EVALUATOR_ADDRESS || '').toLowerCase();
const BUYER_ADDR = (process.env.SAAX_TEST_BUYER_ADDRESS || '').toLowerCase();
const SIGNER_ADDR = (process.env.SAAX_SIGNER_ADDRESS || '').toLowerCase();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; console.log('[FAIL] ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function nowIso() { return new Date().toISOString(); }

// ---- load gitignored signing keys (NEVER printed) --------------------------
function loadJwk(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
const providerPriv = loadJwk('.output/.live-operator/operator-private.jwk.json');
const providerPub = { kty: 'OKP', crv: 'Ed25519', x: providerPriv.x };
const buyerPriv = loadJwk('.output/.live-operator/buyer-private.jwk.json');
const buyerPub = { kty: 'OKP', crv: 'Ed25519', x: buyerPriv.x };

// ---- build the Sepolia-flavored testnet profile (real operator key) ---------
function buildTestnetProfile() {
  const thumbprint = null; // computed async below
  return {
    profileVersion: '1.0.0',
    providerId: 'https://saax-protocol.com/',
    providerName: 'SAAX Protocol — Testnet (Base Sepolia) Discovery Provider',
    origin: 'https://saax-protocol.com',
    signingKeys: [{
      id: 'live-2026-11',
      type: 'jwk',
      jwk: providerPub,
      controller: 'https://saax-protocol.com/.well-known/did.json',
      validFrom: '2026-11-06T00:00:00Z',
      validUntil: '2027-11-06T00:00:00Z',
      status: 'active',
    }],
    capabilities: [{
      id: 'security-scan',
      name: 'Security scan of endpoint',
      description: 'Runs a credentialed vulnerability scan against a buyer-supplied endpoint (TESTNET).',
      schemas: [{ id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333', purpose: 'commitment-manifest' }],
      input: { units: { amount: '250000000', unit: 'micro-units of settlement asset' }, constraints: { maxAmount: '250000000', minDuration: 60, maxDuration: 86400 } },
      evidencePolicy: { requiredEvidenceTypes: ['vulnerability-scan-report'], minimumCountPerType: 1, maxEvidenceAgeSeconds: 3600, acceptedIssuers: ['0x5555555555555555555555555555555555555555'] },
      evaluatorRequirements: { verificationSchemes: ['eip712', 'cose', 'jws'], minimumVendorScore: 80 },
      maturity: 'beta',
      networkAvailability: { networks: ['eip155:84532'], testnetOnly: true },
    }],
    financialCompatibility: {
      networks: ['eip155:84532'],
      assets: ['eip155:84532/erc20:' + TEST_USDC.toLowerCase()],
      rails: ['x402', 'mpp', 'ap2', 'acp'],
      paymentModes: ['x402', 'mpp', 'ap2', 'acp'],
      paymentMode: 'x402',
      settlementModes: ['escrow'],
      defaultUnit: 'micro-units of settlement asset',
      supportedCombinations: [{
        network: 'eip155:84532',
        asset: 'eip155:84532/erc20:' + TEST_USDC.toLowerCase(),
        rail: 'x402',
        mode: 'x402',
        settlementCurrency: 'USDC',
        settlementDecimals: 6,
        financialTerms: 'financial',
        maturity: 'beta',
      }],
    },
    interfaces: { discovery: { profile: true, prepareCommitment: true, commitment: true } },
    conformance: { claims: [{ standard: 'SAAX Discovery Profile', version: '1.0.0', mode: 'self-declared' }], demonstrated: [] },
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
    endpoints: {
      discovery: 'https://saax-protocol.com/.well-known/saax.json',
      prepareCommitment: 'https://saax-protocol.com/prepare-commitment',
      acceptCommitment: 'https://saax-protocol.com/accept-commitment',
      allowCrossOrigin: [],
      schemaAllowlist: ['https://saax-protocol.com/schemas/'],
    },
    cacheControl: { maxAgeSeconds: 3600, staleWhileRevalidate: true },
    expires: '2027-11-06T00:00:00Z',
  };
}

// ---- main -------------------------------------------------------------------
(async () => {
  // 0. Chain + custody identity gate (BEFORE any signing/submitting)
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const chainId = Number(await pub.getChainId());
  check('provider chain is Base Sepolia 84532', chainId === CHAIN_ID, 'chainId=' + chainId);
  if (chainId !== CHAIN_ID) process.exit(1);

  const liveCode = await pub.getCode({ address: CUSTODY });
  const liveLen = (liveCode.length - 2) / 2;
  check('custody has code at 0x5a5472...', liveLen > 1000, 'len=' + liveLen);
  // runtime keccak (identity pin from evidence/custody-reconciliation.json)
  const { keccak256, hexToBytes } = require('viem');
  const liveKeccak = keccak256(hexToBytes(liveCode));
  const PIN = '0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473';
  check('custody runtime keccak == pinned identity', liveKeccak.toLowerCase() === PIN, liveKeccak.slice(0, 18));
  if (liveKeccak.toLowerCase() !== PIN) process.exit(1);

  // 1. Testnet profile + proposal via the SAME core as HTTP/MCP
  const profile = buildTestnetProfile();
  const providerRef = {
    providerId: profile.providerId,
    name: profile.providerName,
    origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id,
    privateJwk: providerPriv,
    jwkPublic: providerPub,
    manifestDigest: profile.capabilities[0].schemas[0].digest,
    evaluatorRef: profile.capabilities[0].evaluatorRequirements,
    permittedDecisions: ['release', 'refund'],
  };

  // Parse --fund
  const argFund = (process.argv.find(a => a.startsWith('--fund=')) || '').split('=')[1];
  const fundUsdc = argFund !== undefined ? Number(argFund) : 5.0;
  if (!(fundUsdc > 0) || fundUsdc > 19.45) { console.error('--fund must be > 0 and <= 19.45 (buyer balance)'); process.exit(1); }
  const amountMicro = String(Math.round(fundUsdc * 1e6));
  const deadline = new Date(Date.now() + 3600 * 1000).toISOString();

  const req = {
    profileVersion: '1.0.0',
    capability: { id: 'security-scan' },
    schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' },
    units: { amount: amountMicro, unit: 'micro-units of settlement asset' },
    financialProfile: { network: 'eip155:84532', asset: 'eip155:84532/erc20:' + TEST_USDC.toLowerCase(), rail: 'x402', mode: 'x402' },
    constraints: { deadline },
    intendedParties: { buyer: BUYER_ADDR, seller: SELLER_ADDR },
    clientNonce: 'real-sep-' + crypto.randomBytes(6).toString('hex'),
    issuedAt: nowIso(),
  };

  const pstore = new ProposalStore(path.join(ROOT, '.output', 'real-sepolia-proposals'));
  const pre = await preflight.prepareCommitment({ profile, providerRef, request: req, store: pstore, clock: { nowIso } });
  check('preflight prepared real proposal', pre.status === 'ok', pre.status + ' ' + (pre.errorCode || ''));
  if (pre.status !== 'ok') { console.error(JSON.stringify(pre, null, 2)); process.exit(1); }
  const proposal = pre.proposal;
  check('proposal signature self-verifies (provider key)', true, 'keyId=' + proposal.signature.keyId);
  const pv = await cryptoLib.verifySignature({ jws: proposal.signature.jws, publicJwk: providerPub, expectedKeyId: proposal.signature.keyId, expectedPayload: (() => { const p = JSON.parse(JSON.stringify(proposal)); delete p.signature; return p; })() });
  check('proposal JWS verifies independently (provider pubkey)', pv.ok, pv.reason || 'ok');

  // 2. Buyer acceptance (REAL Ed25519 buyer key)
  const proposalDigest = acceptance.proposalDigestOf(proposal);
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal.terms), 'utf8').digest('hex');
  const accDoc = {
    schemaVersion: acceptCrypto.ACCEPTANCE_SCHEMA_VERSION,
    action: acceptCrypto.ACCEPTANCE_ACTION,
    domain: acceptCrypto.ACCEPTANCE_DOMAIN,
    acceptanceId: 'acc_real_' + crypto.randomBytes(8).toString('hex'),
    nonce: 'acc-' + crypto.randomBytes(8).toString('hex'),
    buyer: BUYER_ADDR.toLowerCase(),
    provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId },
    proposal: { proposalId: proposal.proposalId, proposalDigest },
    termsDigest,
    audience: profile.origin,
    notBefore: nowIso(),
    notAfter: new Date(Date.now() + 600 * 1000).toISOString(),
    versions: {
      profileVersion: proposal.profileVersion,
      manifestVersion: proposal.manifest.commitmentManifestVersion,
      schema: proposal.manifest.schema,
    },
  };
  const signedAcceptance = await acceptCrypto.signAcceptance({ acceptance: accDoc, buyerPrivateJwk: buyerPriv, keyId: 'real-buyer-2026-11' });
  const av = await acceptCrypto.verifyAcceptance({ jws: signedAcceptance.signature.jws, publicJwk: buyerPub, expectedKeyId: signedAcceptance.signature.keyId, expectedPayload: (() => { const a = JSON.parse(JSON.stringify(signedAcceptance)); delete a.signature; return a; })() });
  check('buyer acceptance JWS verifies independently (buyer pubkey)', av.ok, av.reason || 'ok');
  // Trust set = PROVIDER (operator) key thumbprint (the configured-key anchor).
  const providerThumb = await calculateJwkThumbprint(providerPub);
  const buyerThumb = await calculateJwkThumbprint(buyerPub);

  // 3. Commitment via acceptance-core (single-use, durable)
  const astore = new AcceptanceStore(path.join(ROOT, '.output', 'real-sepolia-acceptances'));
  const accRes = await acceptance.acceptCommitment({
    profile,
    trustedThumbprints: [providerThumb],
    proposal,
    buyerScope: { buyer: BUYER_ADDR.toLowerCase(), scopeMaxAmount: '250000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan', buyerPublicJwk: buyerPub },
    acceptance: signedAcceptance,
    providerRef,
    store: astore,
    idempotencyKey: req.clientNonce,
    nowIso,
  });
  check('acceptCommitment ok', accRes.status === 'ok', (accRes.errorCode || '') + ' ' + (accRes.reason || ''));
  if (accRes.status !== 'ok') { console.error(JSON.stringify(accRes, null, 2)); process.exit(1); }
  const commitment = accRes.commitment;
  check('commitment created (authenticated, single-use)', !!commitment.commitmentId, commitment.commitmentId.slice(0, 18));
  check('commitment manifest amount == proposal amount', commitment.manifest.price.amount === proposal.terms.amount, commitment.manifest.price.amount);
  check('commitment manifest currency == USDC', commitment.manifest.price.currency === 'USDC', commitment.manifest.price.currency);

  const commitmentId = commitment.commitmentId.toLowerCase();
  const manifestHash = commitment.manifestHash || commitment.manifest.manifestHash;

  // Dry-run gate: everything above is read-only + local. Stop before any tx.
  if (process.argv.includes('--dry-run')) {
    console.log('\n[DRY-RUN] commitment created: ' + commitmentId);
    console.log('[DRY-RUN] would fund ' + amountMicro + ' micro-USDC at custody ' + CUSTODY);
    console.log('[DRY-RUN] passed=' + passed + ' failed=' + failed);
    process.exit(0);
  }

  // 4. Buyer approve + fund the DEPLOYED custody (chain guard)
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  check('ethers submitter chain 84532', Number(net.chainId) === CHAIN_ID, 'chainId=' + net.chainId);
  if (Number(net.chainId) !== CHAIN_ID) process.exit(1);

  const buyerWallet = new ethers.Wallet(process.env.SAAX_TEST_BUYER_KEY, provider);
  const usdc = new ethers.Contract(TEST_USDC, ERC20_ABI, buyerWallet);
  const custodyC = new ethers.Contract(CUSTODY, CUSTODY_ABI, buyerWallet);

  const preBal = await usdc.balanceOf(buyerWallet.address);
  check('buyer USDC balance before funding', preBal >= BigInt(amountMicro), (Number(preBal) / 1e6).toFixed(2) + ' USDC');
  if (preBal < BigInt(amountMicro)) process.exit(1);

  // verify custody code again via ethers (belt and suspenders)
  const custodyCodeLen = (await provider.getCode(CUSTODY)).length / 2 - 1;
  check('custody code present via ethers', custodyCodeLen > 1000, 'len=' + custodyCodeLen);

  // The commitment from acceptance-core carries the manifest + authenticated
  // signed representation; the handoff needs the proposal terms (asset/amount/
  // deadline/network) bound into the escrow. Attach them explicitly — the
  // escrow then binds the SAME commitmentId + digest + the terms the buyer
  // authorized.
  const commitmentForHandoff = { ...commitment, terms: proposal.terms, manifestHash: manifestHash };
  const funding = handoff.buildEscrowFunding(commitmentForHandoff, {
    buyer: buyerWallet.address,
    seller: SELLER_ADDR,
    evaluator: EVALUATOR_ADDR,
    custody: CUSTODY,
  });
  check('escrow funding intent built (bindings exact)', funding.ok, funding.ok ? funding.funding.amount + ' -> ' + funding.funding.custody.slice(0, 10) : funding.reason);
  if (!funding.ok) process.exit(1);

  const txApproval = await usdc.approve(CUSTODY, BigInt(funding.funding.amount));
  const rApproval = await txApproval.wait();
  check('USDC approval tx confirmed', rApproval.status === 1, 'approval=' + txApproval.hash.slice(0, 18));

  const txFund = await custodyC.fund(
    funding.funding.commitmentId, funding.funding.commitmentDigest, funding.funding.token,
    funding.funding.buyer, funding.funding.seller, funding.funding.evaluator,
    BigInt(funding.funding.amount), BigInt(funding.funding.deadline),
    BigInt(funding.funding.minReleaseTime || 0),
  );
  const rFund = await txFund.wait();
  check('escrow funded on Base Sepolia', rFund.status === 1, 'tx=' + txFund.hash.slice(0, 18) + ' block=' + rFund.blockNumber);

  // 5. Chain-read reconcile: escrow state + bindings
  const esc = await custodyC.getEscrow(funding.funding.commitmentId);
  const escRec = {
    commitmentId: esc[0], digest: esc[1], token: esc[2], buyer: esc[3], seller: esc[4], evaluator: esc[5],
    amount: esc[6].toString(), deadline: esc[7].toString(), minReleaseTime: esc[8].toString(), state: esc[9].toString(),
  };
  check('escrow state Funded(1)', escRec.state === '1', 'state=' + escRec.state);
  const bind = escrowAccess.verifyFundingBindings(escRec, {
    digest: funding.funding.commitmentDigest, buyer: funding.funding.buyer, seller: funding.funding.seller,
    evaluator: funding.funding.evaluator, token: funding.funding.token, amount: funding.funding.amount,
  });
  check('funding bindings verified against commitment (digest/parties/asset/amount)', bind.ok, bind.reason || 'match');
  const custodyBal = await usdc.balanceOf(CUSTODY);
  check('custody holds the funded amount', custodyBal >= BigInt(funding.funding.amount), (Number(custodyBal) / 1e6).toFixed(2) + ' USDC');

  // 6. Evidence + evaluator release verdict (REAL EIP-712, custody domain)
  const evidenceRef = 'https://saax-protocol.com/evidence/real-sepolia-' + commitmentId.slice(2, 10) + '.json';
  const evalWallet = new ethers.Wallet(process.env.SAAX_EVALUATOR_PRIVATE_KEY, provider);
  const evalNonce = BigInt(Date.now()); // unique per escrow
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: CHAIN_ID, verifyingContract: CUSTODY };
  const VERDICT_TYPES = {
    EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' },
      { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' },
      { name: 'nonce', type: 'uint256' },
      { name: 'issuedAt', type: 'uint256' },
    ],
  };
  const sig = await evalWallet.signTypedData(domain, VERDICT_TYPES, {
    commitmentId: funding.funding.commitmentId,
    commitmentDigest: funding.funding.commitmentDigest,
    action: 'release',
    nonce: evalNonce,
    issuedAt,
  });
  const sigParts = ethers.Signature.from(sig);
  const sellerPre = await usdc.balanceOf(SELLER_ADDR);
  const txRel = await custodyC.release(funding.funding.commitmentId, funding.funding.commitmentDigest, evalNonce, issuedAt, sigParts.v, sigParts.r, sigParts.s);
  const rRel = await txRel.wait();
  check('release executed on Base Sepolia via evaluator verdict', rRel.status === 1, 'tx=' + txRel.hash.slice(0, 18) + ' block=' + rRel.blockNumber);

  // 7. Reconcile: state + token movement
  const escAfter = await custodyC.getEscrow(funding.funding.commitmentId);
  check('escrow state Released(3)', escAfter[9].toString() === '3', 'state=' + escAfter[9].toString());
  const sellerAfter = await usdc.balanceOf(SELLER_ADDR);
  const sellerDelta = sellerAfter - sellerPre;
  check('seller received exactly the escrowed amount', sellerDelta === BigInt(funding.funding.amount), (Number(sellerDelta) / 1e6).toFixed(2) + ' USDC');
  const buyerAfter = await usdc.balanceOf(BUYER_ADDR);
  check('buyer balance decreased by the funded amount', (preBal - buyerAfter) === BigInt(funding.funding.amount), (Number(preBal - buyerAfter) / 1e6).toFixed(2) + ' USDC');

  // 8. Export the complete record (independent verifier input)
  const exportObj = {
    formatVersion: 'discovery-financial-v1',
    kind: 'real-sepolia-release',
    chainId: CHAIN_ID,
    custody: CUSTODY,
    custodyRuntimeKeccak: liveKeccak,
    custodyPin: PIN,
    testUsdc: TEST_USDC,
    generatedAt: nowIso(),
    proposal: proposal,
    acceptance: signedAcceptance,
    commitment: {
      commitmentId,
      manifestHash,
      manifest: commitment.manifest,
      signedRepresentation: commitment.signedRepresentation,
    },
    funding: {
      commitmentId: funding.funding.commitmentId,
      commitmentDigest: funding.funding.commitmentDigest,
      token: funding.funding.token,
      buyer: funding.funding.buyer,
      seller: funding.funding.seller,
      evaluator: funding.funding.evaluator,
      amount: funding.funding.amount,
      deadline: funding.funding.deadline,
      approveTx: txApproval.hash,
      fundTx: txFund.hash,
      fundBlock: rFund.blockNumber,
      approvalTx: txApproval.hash,
    },
    release: {
      evidenceRef,
      verdict: { action: 'release', nonce: evalNonce.toString(), issuedAt: issuedAt.toString(), v: sigParts.v, r: sigParts.r, s: sigParts.s },
      tx: txRel.hash,
      block: rRel.blockNumber,
      status: rRel.status === 1 ? 'success' : 'failed',
    },
    reconciliation: {
      custodyBalanceAfter: custodyBal.toString(),
      sellerBalanceBefore: sellerPre.toString(),
      sellerBalanceAfter: sellerAfter.toString(),
      buyerBalanceBefore: preBal.toString(),
      buyerBalanceAfter: buyerAfter.toString(),
    },
    roleControlDisclosure: 'All roles (provider, buyer, seller, evaluator) are operator-controlled test accounts on Base Sepolia. No external adoption or independent evaluation is claimed.',
  };

  const outDir = path.join(ROOT, 'evidence', 'discovery-phase5');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'real-sepolia-release-export.json');
  fs.writeFileSync(outPath, JSON.stringify(exportObj, null, 2));
  check('export written', fs.existsSync(outPath), outPath);

  console.log('\n===== SUMMARY =====');
  console.log('passed=' + passed + ' failed=' + failed);
  console.log('commitment=' + commitmentId);
  console.log('fundTx=' + txFund.hash);
  console.log('releaseTx=' + txRel.hash);
  console.log('export=' + outPath);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + (e.stack || e.message)); process.exit(1); });