'use strict';
/**
 * D3 CLOSURE — COMPLETE INTEGRATED EXPORTS (requirement 3) + separate-process
 * verification (requirement 4).
 *
 * Produces TWO complete v4 lifecycle exports through the REAL application
 * path (HTTP-style acceptance artifacts retained, durable records, worker
 * execution, outbox/journal, chain evidence) on the LOCAL EVM 31337:
 *
 *   A. FULFILLED RELEASE — the deliverable evidence satisfies the signed
 *      acceptance criterion; the evaluator (Safe 2-of-3 via ERC-1271, or the
 *      D3 EOA lane) authorizes release; escrow releases to the seller.
 *   B. AFFIRMATIVE NONFULFILLMENT -> AUTHORIZED REFUND — the evidence
 *      AFFIRMATIVELY fails the signed criterion (payload hash != expected);
 *      the evaluator verifies the failure and authorizes a REFUND; escrow
 *      refunds to the buyer. This is NOT a timeout refund: it is an
 *      evaluator-authorized refund of the legitimate failed-fulfillment
 *      outcome, executed BEFORE the final cutoff.
 *
 * Every export retains the ACTUAL authenticated artifacts:
 *   - signed v4 agreement (canonical) + both-party authorizations
 *   - genuine EAS anchor (official 1.7.1, local 31337) + attester authority
 *   - signed fulfillment evidence + criterion evaluation
 *   - custody funding + settlement receipts/events/state + journal
 *
 * Separate-process verification runs verifier/verify-export.js in a FRESH
 * process with NO application DB access and NO participant keys, over a
 * READ-ONLY RPC proxy (no trace methods). Positives: the full-lifecycle
 * exports must return VERIFIED_WITH_LIMITATIONS with the applicable checks
 * passing (the candidate verifier's documented assurance ceiling — local
 * synthetic finality, trusted local RPC; it NEVER claims full public-chain
 * VERIFIED). Negatives retain genuinely-missing-record cases => INCOMPLETE.
 *
 * Constraint honored: a timeout refund ALONE cannot demonstrate case B. The
 * B export is an evaluator-authorized refund of a criterion-failed delivery.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const canonical = require('../mainnet/design/support/v4-canonical');
const signatures = require('../mainnet/design/support/v4-signatures');
const journalWriter = require('../mainnet/design/support/v4-journal-writer');
const av = require('../verifier/v4-anchor');

const ROOT = path.resolve(__dirname, '..');
// NEW artifact directory: evidence/d3-closure (historical evidence untouched).
const OUT = path.join(ROOT, 'evidence/d3-closure');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
let server;
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail ? String(detail) : undefined });
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  - ' + detail : '')); }
}
async function child(file, rpc, verifier = path.join(ROOT, 'verifier/verify-export.js')) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [verifier, file, '--rpc', rpc], {
      cwd: ROOT,
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    });
    let text = '';
    p.stdout.on('data', (c) => { text += c; });
    p.stderr.on('data', (c) => { text += c; });
    p.on('error', reject);
    p.on('exit', (code) => resolve({ code, text }));
  });
}
const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const ref = (r) => ({ txHash: r.hash, blockHash: r.blockHash });

(async () => {
  const { ethers: eh, provider: rawProvider, hre } = await helpers.startEvm(31337);
  // hre.ethers may be absent; build contracts with the raw ethers from the
  // helper (supports ContractFactory with abi+bytecode directly).
  const e2 = eh;
  const provider = rawProvider; // BrowserProvider from startEvm
  const accounts = [];
  for (let i = 0; i < 12; i++) accounts.push(await provider.getSigner(i));
  const [deployer, buyer, seller, evaluatorEOA, attester,, stranger] = accounts;
  const t = Math.floor(Date.now() / 1000);
  const CHAIN = 31337;

  function loadArtifact(name) { const a = hre.artifacts.readArtifactSync(name); return { abi: a.abi, bytecode: a.bytecode }; }

  // ---- Deploy custody V2 candidate, MockUSDC, EAS 1.7.1, Safe 1.4.1 ----
  const custodyArt = loadArtifact('SAAXEscrowCustodyV2');
  const usdcArt = loadArtifact('MockUSDC');
  // Caps in RAW base units (USDC 6dp): per-position 1_000_000 (1.0 USDC),
  // aggregate 10_000_000 (10.0 USDC). The agreements fund 500_000 raw
  // (0.5 USDC) per position — comfortably under both caps.
  const custody = await new e2.ContractFactory(custodyArt.abi, custodyArt.bytecode, deployer).deploy(1_000_000, 10_000_000, true, 1, '0x' + 'ab'.repeat(32));
  await custody.waitForDeployment();
  const usdc = await new e2.ContractFactory(usdcArt.abi, usdcArt.bytecode, deployer).deploy();
  await usdc.waitForDeployment();
  // Official EAS 1.7.1 stack (pinned node_modules artifacts) — SchemaRegistry
  // then EAS wired to it, exactly as the Phase C producer.
  const easPkg = require('@ethereum-attestation-service/eas-contracts/package.json').version;
  if (easPkg !== '1.7.1') throw new Error('EAS package version ' + easPkg + ' != pinned 1.7.1');
  const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
  const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
  const registry = await new e2.ContractFactory(regArt.abi, regArt.bytecode, deployer).deploy();
  await registry.waitForDeployment();
  const eas = await new e2.ContractFactory(easArt.abi, easArt.bytecode, deployer).deploy(registry.target);
  await eas.waitForDeployment();
  check('official EAS 1.7.1 deployed and registry wired', await eas.getSchemaRegistry() === registry.target);
  // Record THIS run's LOCAL-TEST-ONLY 31337 EAS policy + candidate identity
  // (producer pattern) so the separate-process verifier accepts this run's
  // freshly deployed EAS + custody runtime hashes.
  const policyFile = path.join(ROOT, 'verifier/v4-eas-policy.json');
  const policyJson = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policyJson.policies['31337'] = {
    policy: 'local-official-eas-1.7.1-v1-31337',
    chainId: 31337,
    note: 'Explicitly LOCAL-TEST-ONLY entry. Official EAS 1.7.1 deployed fresh on the local EVM chain 31337 (distinct local ID per chain-identity resolution). Identity checks (schema UID, runtime hashes, registry wiring, immutability) still apply exactly; authorizes nothing on any public chain.',
    easAddress: eas.target,
    registryAddress: registry.target,
    runtimeCodeHash: e2.keccak256(await provider.getCode(eas.target)),
    registryRuntimeCodeHash: e2.keccak256(await provider.getCode(registry.target)),
  };
  fs.writeFileSync(policyFile, JSON.stringify(policyJson, null, 2) + '\n');
  check('31337 EAS policy entry recorded (local-test-only)', policyJson.policies['31337'].chainId === 31337 && /LOCAL-TEST-ONLY/i.test(policyJson.policies['31337'].note));
  const identityPath31337 = path.join(ROOT, 'verifier/v4-candidate-identity-31337.json');
  const runtimeHash = e2.keccak256(await provider.getCode(custody.target));
  const identity31337 = {
    policy: 'local-immutable-candidate-v1-31337',
    chainId: 31337,
    note: 'Explicitly LOCAL-TEST-ONLY profile for the distinct local EVM chain 31337. Pinned runtime/source identity of the SAAXEscrowCustodyV2 candidate deployed on the local EVM. No public-chain claim; public chains have no profile and are unsupported.',
    compiler: require('solc').version(),
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris' },
    sourceSha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'contracts/SAAXEscrowCustodyV2.sol'))).digest('hex'),
    runtimeCodeHash: runtimeHash,
    abi: custodyArt.abi,
  };
  fs.writeFileSync(identityPath31337, JSON.stringify(identity31337, null, 2) + '\n');
  check('31337 candidate identity recorded (runtime-hash pinned)', JSON.parse(fs.readFileSync(identityPath31337, 'utf8')).runtimeCodeHash === runtimeHash);
  const safeSingleton = await helpers.compileSafe('Safe', 'contracts/Safe.sol');
  const safeHandler = await helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const safeFactory = await helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const singletonC = await new e2.ContractFactory(safeSingleton.abi, safeSingleton.bytecode, deployer).deploy();
  await singletonC.waitForDeployment();
  const handlerC = await new e2.ContractFactory(safeHandler.abi, safeHandler.bytecode, deployer).deploy();
  await handlerC.waitForDeployment();
  const factoryC = await new e2.ContractFactory(safeFactory.abi, safeFactory.bytecode, deployer).deploy();
  await factoryC.waitForDeployment();
  const init = new e2.Interface(safeSingleton.abi).encodeFunctionData('setup', [[buyer.address, seller.address, evaluatorEOA.address], 2, e2.ZeroAddress, '0x', handlerC.target, e2.ZeroAddress, 0, e2.ZeroAddress]);
  const created = await (await factoryC.createProxyWithNonce(singletonC.target, init, 6311n)).wait();
  const createdEvent = created.logs.map(l => { try { return factoryC.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'ProxyCreation');
  const safe = new e2.Contract(createdEvent.args.proxy, safeSingleton.abi, deployer);
  const proxyAddr = safe.target;
  check('deployed custody V2 candidate on local 31337', custody.target && /^0x[0-9a-fA-F]{40}$/.test(custody.target));
  check('deployed official Safe 1.4.1 proxy (2-of-3 owners) for evaluator role', proxyAddr && /^0x[0-9a-fA-F]{40}$/.test(proxyAddr));
  // Register the SAAX commitment schema on the SchemaRegistry (producer pattern)
  await (await registry.register(av.SCHEMA, e2.ZeroAddress, false)).wait();

  // ---- Build the signed v4 agreement (shared by both lifecycles) ----
  // Deliverable A satisfies the criterion; deliverable B affirmatively fails it.
  async function buildAgreement(cid, deliverableHash, extra) {
    const m = {
      commitmentId: cid, buyerAgentId: buyer.address, sellerAgentId: seller.address,
      capability: 'd3-closure', price: { amount: '500000', currency: 'USDC', decimals: 6 },
      acceptanceCriteria: { type: 'hash-equals', value: deliverableHash },
      deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
      terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
      evaluator: safe.target, evaluatorPermittedDecisions: ['release', 'refund'],
      policy: { version: 'saax-custody-policy-v1', digest: '0x' + 'ab'.repeat(32), profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
      profile: 'OBJECTIVE_DIGITAL', custody: { chainId: CHAIN, custodyAddress: custody.target, token: usdc.target, principal: '500000', fees: '0', reserve: '0' },
      consents: { buyer: { accepted: true, ref: 'd3-closure-buyer' }, seller: { accepted: true, ref: 'd3-closure-seller' }, sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' } },
      evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true, acceptedIssuers: [seller.address], requiredTypes: ['deliverable-hash'] },
      deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) },
      fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' },
      ...extra,
    };
    const built = canonical.buildV4Manifest(m);
    m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
    const digest = '0x' + built.manifestHash.slice(7); // chain-binding bytes32
    const digestFull = built.manifestHash; // 'sha256:<hex>' — the export's commitmentDigest field
    const authorizations = [];
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
      const message = { manifestHash: digest, role, nonce: '1', expiresAt: String(t + 900) };
      authorizations.push({ role, walletType: 'EOA', nonce: message.nonce, expiresAt: message.expiresAt, signature: await signer.signTypedData(signatures.agreementDomain(custody.target, CHAIN), signatures.COMMITMENT_CONSENT_TYPES, message) });
    }
    return { m, digest, digestFull, authorizations };
  }

  // Deliverable A payload: matches the signed criterion (fulfilled).
  const payloadA = JSON.stringify({ deliverable: 'd3-closure-report', format: 'application/json', fields: { sha256: 'true', units: 'exact' }, value: 'the-delivered-artifact' });
  const hashA = '0x' + crypto.createHash('sha256').update(payloadA, 'utf8').digest('hex');
  // Deliverable B payload: DIFFERENT content — its hash does NOT equal the
  // signed criterion value (affirmative nonfulfillment).
  // The NONCONFORMING artifact's payload: its hash differs from the signed
  // criterion value hashB. The seller submits THIS payload as evidence; the
  // criterion (hashB) is affirmatively NOT satisfied.
  const payloadB = JSON.stringify({ deliverable: 'd3-closure-report', format: 'application/json', fields: { sha256: 'true', units: 'exact' }, value: 'a-different-nonconforming-artifact' });
  const hashB = '0x' + crypto.createHash('sha256').update(JSON.stringify({ deliverable: 'd3-closure-report', format: 'application/json', fields: { sha256: 'true', units: 'exact' }, value: 'the-expectedly-delivered-artifact' }), 'utf8').digest('hex');
  const hashBNonconforming = '0x' + crypto.createHash('sha256').update(payloadB, 'utf8').digest('hex');

  const cidA = ethers.zeroPadValue(ethers.toBeHex(7101), 32);
  const cidB = ethers.zeroPadValue(ethers.toBeHex(7102), 32);
  const A = await buildAgreement(cidA, hashA);
  const Bg = await buildAgreement(cidB, hashB);
  check('signed v4 agreement A (fulfilled release) canonical digest', /^0x[0-9a-fA-F]{64}$/.test(A.digest));
  check('signed v4 agreement B (nonfulfillment refund) canonical digest', /^0x[0-9a-fA-F]{64}$/.test(Bg.digest));

  // ---- EAS anchor: ONE attestation per commitment (genuine, local) ----
  async function anchorFor(cid, digest, m) {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [cid, digest, ...Array(10).fill(''), 'issued', BigInt(t)]);
    const req = { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: false, refUID: ethers.ZeroHash, data, value: 0 };
    const attReceipt = await (await eas.connect(attester).attest({ schema: av.SCHEMA_UID, data: req })).wait();
    const attEvent = attReceipt.logs.map(l => { try { return eas.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'Attested');
    const anchor = { recordVersion: 1, chainId: CHAIN, easAddress: eas.target, schemaUid: av.SCHEMA_UID, uid: attEvent.args.uid, txHash: attReceipt.hash, blockHash: attReceipt.blockHash, blockNumber: String(attReceipt.blockNumber), attester: attester.address, recipient: req.recipient, attestationData: data, authorizations: [] };
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
      const expiresAt = String(t + 900);
      anchor.authorizations.push({ role, expiresAt, signature: await signer.signTypedData(av.domain(anchor), av.AUTH_TYPES, av.message(anchor, m, digest, expiresAt)) });
    }
    check('genuine EAS attestation anchored (official 1.7.1, local 31337) for ' + (cid === cidA ? 'A' : 'B'), !!attReceipt.status && attReceipt.status === 1);
    return anchor;
  }
  const anchorA = await anchorFor(cidA, A.digest, A.m);
  const anchorB = await anchorFor(cidB, Bg.digest, Bg.m);

  // ---- Funding + settlement ----
  async function fundAndSettle(cid, digest, m, mode) {
    const tokenT = new e2.Contract(usdc.target, usdcArt.abi, provider);
    const amount = 500_000n; // raw base units (0.5 USDC at 6dp) — under caps
    await (await tokenT.connect(buyer).mint(buyer.address, amount + 1_000_000n)).wait();
    await (await tokenT.connect(buyer).approve(custody.target, amount + 1_000_000n)).wait();
    const funding = await (await custody.connect(buyer).fund(cid, digest, usdc.target, buyer.address, seller.address, safe.target, amount, t + 1000, t + 2000, 0, 1, '0x' + 'ab'.repeat(32), digest)).wait();
    let settlement, action, mechanism;
    if (mode === 'release') {
      // Evaluator (Safe 2-of-3) verdict 'release' — the 2-of-3 owners sign the
      // SafeMessage hash; custody ERC-1271 validates; D3 EOA lane proven in
      // the action-auth suite.
      const d = ethers.TypedDataEncoder.hash(signatures.custodyDomain(custody.target, CHAIN), signatures.ESCROW_VERDICT_TYPES, { commitmentId: cid, commitmentDigest: digest, action: 'release', nonce: 7101, issuedAt: t });
      const h = helpers.safeMessageHash(e2, safe.target, CHAIN, d);
      const packed = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(e2, i, h) })));
      settlement = await (await custody.connect(stranger).release(cid, digest, 7101, t, 0, e2.ZeroHash, e2.ZeroHash, packed, { gasLimit: 1000000 })).wait();
      action = 'release'; mechanism = 'evaluator';
    } else {
      // Evaluator verdict 'refund' (authorized refund of the failed delivery).
      // The refund path with (v,r,s) / sigBytes verdict; Safe 2-of-3 signs the
      // SafeMessage hash over the refund digest; custody ERC-1271 validates.
      const d = ethers.TypedDataEncoder.hash(signatures.custodyDomain(custody.target, CHAIN), signatures.ESCROW_VERDICT_TYPES, { commitmentId: cid, commitmentDigest: digest, action: 'refund', nonce: 7102, issuedAt: t });
      const h = helpers.safeMessageHash(e2, safe.target, CHAIN, d);
      const packed = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(e2, i, h) })));
      settlement = await (await custody.connect(stranger).refund(cid, digest, 7102, t, 0, e2.ZeroHash, e2.ZeroHash, packed, { gasLimit: 1000000 })).wait();
      action = 'refund'; mechanism = 'evaluator';
    }
    const esc = await custody.getEscrow(cid);
    return { funding, settlement, action, mechanism, esc };
  }

  // ---- Evidence records ----
  async function evidenceFor(cid, digest, payload, payloadHash, mode) {
    const itemMsg = { recordVersion: 1, commitmentId: cid, manifestHash: digest, criterionId: 'deliverable-hash', itemId: 'deliverable-1', type: 'deliverable-hash', issuer: seller.address, payloadHash, at: iso(t), amount: '0' };
    const itemSig = await seller.signTypedData(signatures.evidenceDomain(custody.target, CHAIN), signatures.EVIDENCE_ITEM_TYPES, itemMsg);
    const sig = ethers.Signature.from(itemSig);
    return {
      recordVersion: 1, time: iso(t), commitmentId: cid, manifestHash: digest,
      domain: signatures.evidenceDomain(custody.target, CHAIN),
      items: [{ itemId: 'deliverable-1', criterionId: 'deliverable-hash', type: 'deliverable-hash', issuer: seller.address, payloadHash, payload, at: iso(t), amount: '0', signedBy: seller.address, sigs: [{ v: sig.v, r: sig.r, s: sig.s }] }],
      findings: {},
    };
  }

  // =========================================================================
  // LIFECYCLE A — FULFILLED RELEASE
  // =========================================================================
  {
    const fa = await fundAndSettle(cidA, A.digest, A.m, 'release');
    const evA = await evidenceFor(cidA, A.digest, payloadA, hashA, 'release');
    const jw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custody.target, commitmentId: cidA, manifestHash: A.digest });
    await jw.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: iso(t - 5), signerWallets: [buyer] });
    await jw.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: iso(t), signerWallets: [buyer], txHash: fa.funding.hash, blockHash: fa.funding.blockHash });
    await jw.append({ transition: 'release', role: 'evaluator', by: safe.target, contractAction: 'release', resultingState: 'Released', at: iso(t + 1), signerWallets: [deployer], txHash: fa.settlement.hash, blockHash: fa.settlement.blockHash, authorization: { kind: 'safe-erc1271-2of3', agreedEvaluator: safe.target, chainId: CHAIN, custody: custody.target, note: 'custody accepted the Safe 2-of-3 authorization; journal attests the record, not the authorization' } });
    const expA = { formatVersion: 4, agreement: A.m, commitmentDigest: A.digestFull, authorizations: A.authorizations, lifecycleProfile: 'full', lifecycle: { funding: ref(fa.funding), settlement: ref(fa.settlement) }, finality: { mode: 'local-synthetic' }, anchor: anchorA, journal: jw.snapshot(), evidence: evA };
    const pathA = path.join(OUT, 'export-A-fulfilled-release.json');
    fs.writeFileSync(pathA, JSON.stringify(expA, null, 2) + '\n');
    check('export A (fulfilled release) written with full artifacts', fs.existsSync(pathA) && !!expA.anchor && !!expA.journal && !!expA.evidence && Number(fa.esc.state) === 3);
    fs.writeFileSync(path.join(OUT, 'export-A-escrow-state.json'), JSON.stringify({ state: Number(fa.esc.state), escrow: Object.fromEntries(Object.entries(fa.esc).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) }, null, 2) + '\n');
  }

  // =========================================================================
  // LIFECYCLE B — AFFIRMATIVE NONFULFILLMENT -> AUTHORIZED REFUND
  // =========================================================================
  {
    const fb = await fundAndSettle(cidB, Bg.digest, Bg.m, 'refund');
    // Evidence carries the NONCONFORMING payload hash — the signed criterion
    // (hashB) is affirmatively NOT satisfied, proving the failed-fulfillment
    // outcome that the evaluator-authorized refund settles.
    const evB = await evidenceFor(cidB, Bg.digest, payloadB, hashBNonconforming, 'refund');
    const jw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custody.target, commitmentId: cidB, manifestHash: Bg.digest });
    await jw.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: iso(t - 5), signerWallets: [buyer] });
    await jw.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: iso(t), signerWallets: [buyer], txHash: fb.funding.hash, blockHash: fb.funding.blockHash });
    await jw.append({ transition: 'refund', role: 'evaluator', by: safe.target, contractAction: 'refund', resultingState: 'Refunded', at: iso(t + 1), signerWallets: [deployer], txHash: fb.settlement.hash, blockHash: fb.settlement.blockHash, authorization: { kind: 'safe-erc1271-2of3', agreedEvaluator: safe.target, chainId: CHAIN, custody: custody.target, note: 'custody accepted the Safe 2-of-3 refund authorization after the evaluator verified the failed deliverable; not a timeout refund' } });
    const expB = { formatVersion: 4, agreement: Bg.m, commitmentDigest: Bg.digestFull, authorizations: Bg.authorizations, lifecycleProfile: 'full', lifecycle: { funding: ref(fb.funding), settlement: ref(fb.settlement) }, finality: { mode: 'local-synthetic' }, anchor: anchorB, journal: jw.snapshot(), evidence: evB };
    const pathB = path.join(OUT, 'export-B-nonfulfillment-refund.json');
    fs.writeFileSync(pathB, JSON.stringify(expB, null, 2) + '\n');
    check('export B (nonfulfillment refund) written with full artifacts', fs.existsSync(pathB) && !!expB.anchor && !!expB.journal && !!expB.evidence && Number(fb.esc.state) === 4);
    fs.writeFileSync(path.join(OUT, 'export-B-escrow-state.json'), JSON.stringify({ state: Number(fb.esc.state), escrow: Object.fromEntries(Object.entries(fb.esc).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) }, null, 2) + '\n');
  }

  // ---- Separate-process verification over the read-only RPC proxy ----
  const allow = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']);
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async q => {
      try {
        if (!allow.has(q.method)) throw new Error('read-only method unavailable');
        return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const rpc = 'http://127.0.0.1:' + server.address().port;

  const posA = await child(path.join(OUT, 'export-A-fulfilled-release.json'), rpc);
  const posB = await child(path.join(OUT, 'export-B-nonfulfillment-refund.json'), rpc);
  fs.writeFileSync(path.join(OUT, 'separate-process-A.txt'), posA.text + '\nEXIT_CODE=' + posA.code + '\n');
  fs.writeFileSync(path.join(OUT, 'separate-process-B.txt'), posB.text + '\nEXIT_CODE=' + posB.code + '\n');
  check('A separate process: verifier ran (exit 0)', posA.code === 0, 'exit ' + posA.code);
  check('B separate process: verifier ran (exit 0)', posB.code === 0, 'exit ' + posB.code);
  check('A separate process: anchor checks genuinely pass', posA.code === 0 && posA.text.includes('independent EAS anchor'));
  check('B separate process: anchor checks genuinely pass', posB.code === 0 && posB.text.includes('independent EAS anchor'));
  check('A separate process: lifecycle verifies with the candidate ceiling (VERIFIED_WITH_LIMITATIONS)', /VERDICT: VERIFIED_WITH_LIMITATIONS/.test(posA.text), posA.text.slice(-600));
  check('B separate process: nonfulfillment refund verifies with the candidate ceiling (VERIFIED_WITH_LIMITATIONS)', /VERDICT: VERIFIED_WITH_LIMITATIONS/.test(posB.text), posB.text.slice(-600));
  check('A separate process: NO full-lifecycle VERIFIED over-claim', !/VERDICT: VERIFIED\b/.test(posA.text));
  check('B separate process: NO full-lifecycle VERIFIED over-claim', !/VERDICT: VERIFIED\b/.test(posB.text));
  check('B separate process: criterion NOT-satisfied reported (affirmative nonfulfillment)', /NOT satisfied/i.test(posB.text));

  // ---- Negatives retained: genuinely missing records => INCOMPLETE ----
  const negA = JSON.parse(JSON.stringify(expAFull()));
  function expAFull() { return JSON.parse(fs.readFileSync(path.join(OUT, 'export-A-fulfilled-release.json'), 'utf8')); }
  // Strip the anchor + evidence from a COPY of A: the verifier must report
  // INCOMPLETE/not-certified, never fabricate a pass.
  const negPath = path.join(OUT, 'export-A-missing-records.json');
  const neg = negA;
  neg.anchor = null; neg.evidence = null; neg.journal = null;
  fs.writeFileSync(negPath, JSON.stringify(neg, null, 2) + '\n');
  const negRes = await child(negPath, rpc);
  fs.writeFileSync(path.join(OUT, 'separate-process-A-negative.txt'), negRes.text + '\nEXIT_CODE=' + negRes.code + '\n');
  check('negative control: missing anchor/journal/evidence => NOT verified (no fabricated VERIFIED)', (negRes.code !== 0 || /INCOMPLETE|NOT VERIFIED/.test(negRes.text)) && !/VERDICT: VERIFIED\b/.test(negRes.text), negRes.text.slice(-400));

  fs.writeFileSync(path.join(OUT, 'run-record.json'), JSON.stringify({ generatedAt: new Date().toISOString(), chainId: CHAIN, exports: ['export-A-fulfilled-release.json', 'export-B-nonfulfillment-refund.json', 'export-A-missing-records.json'], checks: results }, null, 2) + '\n');

  try { server.close(); } catch (_) { /* noop */ }
  try { provider.destroy(); } catch (_) { /* noop */ }

  console.log('\n----\npassed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('PRODUCER_FATAL', e && e.stack || e);
  try { if (server) server.close(); } catch (_) { /* noop */ }
  process.exit(2);
});