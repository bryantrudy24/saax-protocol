'use strict';
/**
 * SAAX V4 Producer/Anchor Drift Closure — consolidated local producer.
 *
 * Produces ONE reproducible local v4 lifecycle export containing BOTH a
 * genuine EAS anchor and the Phase A journal, on the LOCAL EVM chain 31337
 * (the chain-identity resolution's distinct local ID — never 84532), using:
 *   - official @ethereum-attestation-service/eas-contracts@1.7.1 (pinned)
 *   - repository custody candidate SAAXEscrowCustodyV2
 *   - MockUSDC (local testing only)
 *   - official Safe contracts 1.4.1 (evaluator, 2-of-3 via ERC-1271)
 *   - synthetic local accounts
 *
 * The export carries:
 *   - formatVersion/agreement/commitmentDigest/authorizations/lifecycle/finality
 *   - anchor   : genuine EAS attestation record (official 1.7.1, schema-UID
 *                bound, both-party attester authority) on the LOCAL 31337 EVM
 *   - journal  : Phase A hash-chain journal (issue -> funded -> release)
 *
 * Outputs (NEW evidence directory, historical evidence untouched):
 *   evidence/phase3b-v4-closure/lifecycle-anchored-journal.json
 *   evidence/phase3b-v4-closure/separate-process.txt
 *   evidence/phase3b-v4-closure/run-record.json
 *   evidence/phase3b-v4-closure/results.json
 *
 * It also writes the repository-owned 31337 policy + identity files:
 *   verifier/v4-eas-policy.json            (adds 31337 local-test-only entry)
 *   verifier/v4-candidate-identity-31337.json  (pinned local runtime identity)
 *
 * The EAS 31337 policy entry is EXPLICITLY LOCAL-TEST-ONLY. It authorizes
 * nothing on any public chain: the same schema-UID, runtime-hash, registry
 * wiring and immutability checks apply. Public deployment restrictions
 * (84532 public-facing profile policy + no public deployment) are unchanged.
 *
 * Separate-process verification runs the existing v4 verifier (via
 * verifier/verify-export.js) against the new export over a READ-ONLY RPC
 * proxy (no app DB, no participant keys, no trace methods), asserting the
 * exact expected assurance: anchor checks genuinely pass; journal
 * verification implemented (Phase B) and passing; fulfillment/finality/
 * governance limitations stay explicit; NO full-lifecycle VERIFIED claim
 * beyond demonstrated checks.
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
// Phase C outputs go to a NEW evidence directory (phase3c-v4). The Phase B
// closure evidence (evidence/phase3b-v4-closure/) is committed historical
// evidence with a pre-evidence agreement shape; it stays byte-identical and
// is NOT regenerated or overwritten. Under the Phase C verifier that older
// export correctly reports INCOMPLETE (missing fulfillment evidence).
const OUT = path.join(ROOT, 'evidence/phase3c-v4');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
let server;
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}
async function child(file, rpc, verifier = path.join(ROOT, 'verifier/verify-export.js')) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [verifier, file, '--rpc', rpc], {
      cwd: ROOT,
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    });
    let text = '';
    p.stdout.on('data', v => { text += v; });
    p.stderr.on('data', v => { text += v; });
    p.on('error', reject);
    p.on('exit', code => resolve({ code, text }));
  });
}

(async () => {
  const CHAIN = 31337;
  const revision = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const { provider, hre, accounts } = await helpers.startEvm(CHAIN);
  const [deployer, buyer, seller, evaluator, attester, , stranger] = accounts;

  async function deploy(art, args = []) { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; }

  // ——— Official EAS 1.7.1 stack ———
  const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
  const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
  const registry = await deploy(regArt);
  const eas = await deploy(easArt, [registry.target]);
  const easPackageVersion = require('@ethereum-attestation-service/eas-contracts/package.json').version;

  // ——— Safe evaluator stack ———
  const safeArt = helpers.compileSafe('Safe', 'contracts/Safe.sol');
  const handlerArt = helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const singleton = await deploy(safeArt), handler = await deploy(handlerArt), factory = await deploy(factoryArt);
  const init = new ethers.Interface(safeArt.abi).encodeFunctionData('setup', [[buyer.address, seller.address, evaluator.address], 2, ethers.ZeroAddress, '0x', handler.target, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const created = await (await factory.createProxyWithNonce(singleton.target, init, 6311n)).wait();
  const createdEvent = created.logs.map(l => { try { return factory.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'ProxyCreation');
  const safe = new ethers.Contract(createdEvent.args.proxy, safeArt.abi, deployer);

  // ——— Token + custody ———
  const token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  const policy = '0x' + 'ab'.repeat(32);
  const custodyArt = hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2');
  const custody = await deploy(custodyArt, [1000000, 10000000, true, 1, policy]);

  check('31337 EVM running', Number((await provider.getNetwork()).chainId) === 31337);
  check('official EAS 1.7.1 deployed', easPackageVersion === '1.7.1' && !!eas.target && !!registry.target);
  check('registry wired to EAS', await eas.getSchemaRegistry() === registry.target);

  // ——— Record the 31337 LOCAL-TEST-ONLY policy + candidate identity ———
  const policyFile = path.join(ROOT, 'verifier/v4-eas-policy.json');
  const policyJson = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policyJson.policies['31337'] = {
    policy: 'local-official-eas-1.7.1-v1-31337',
    chainId: 31337,
    note: 'Explicitly LOCAL-TEST-ONLY entry. Official EAS 1.7.1 deployed fresh on the local EVM chain 31337 (distinct local ID per chain-identity resolution). Identity checks (schema UID, runtime hashes, registry wiring, immutability) still apply exactly; authorizes nothing on any public chain.',
    easAddress: eas.target,
    registryAddress: registry.target,
    runtimeCodeHash: ethers.keccak256(await provider.getCode(eas.target)),
    registryRuntimeCodeHash: ethers.keccak256(await provider.getCode(registry.target)),
  };
  fs.writeFileSync(policyFile, JSON.stringify(policyJson, null, 2) + '\n');
  check('31337 EAS policy entry recorded (local-test-only)', policyJson.policies['31337'].chainId === 31337 && /LOCAL-TEST-ONLY/i.test(policyJson.policies['31337'].note));

  const identityPath31337 = path.join(ROOT, 'verifier/v4-candidate-identity-31337.json');
  const runtimeHash = ethers.keccak256(await provider.getCode(custody.target));
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
  check('31337 candidate identity recorded (runtime-hash pinned)', require(identityPath31337).runtimeCodeHash === runtimeHash);

  // ——— Schema registration + signing ———
  await (await registry.register(av.SCHEMA, ethers.ZeroAddress, false)).wait();
  await (await token.mint(buyer.address, 1000000)).wait();
  await (await token.connect(buyer).approve(custody.target, 1000000)).wait();

  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const t = Number(BigInt(block.timestamp));
  const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
  const ref = r => ({ txHash: r.hash, blockHash: r.blockHash });

  const cid = ethers.zeroPadValue(ethers.toBeHex(6311), 32);
  // ——— Genuine fulfillment evidence (Phase C) ———
  // The deliverable is a narrow, precisely defined digital artifact: a
  // synthetic machine-readable report. Its canonical payload is deterministic
  // (a JSON report the seller produced), its sha256 is the signed acceptance
  // criterion. The evidence item is genuinely signed by the seller under the
  // v4 evidence domain.
  const deliverablePayload = JSON.stringify({
    deliverable: 'synthetic-closure-report',
    format: 'application/json',
    fields: { sha256: 'true', units: 'exact' },
    value: 'the-digital-deliverable',
  });
  const deliverableHash = '0x' + crypto.createHash('sha256').update(deliverablePayload, 'utf8').digest('hex');
  const m = {
    commitmentId: cid, buyerAgentId: buyer.address, sellerAgentId: seller.address,
    capability: 'closure-31337', price: { amount: '1000', currency: 'USDC', decimals: 6 }, acceptanceCriteria: { type: 'hash-equals', value: deliverableHash },
    deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
    terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
    evaluator: safe.target, evaluatorPermittedDecisions: ['release', 'refund'],
    policy: { version: 'saax-custody-policy-v1', digest: policy, profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
    profile: 'OBJECTIVE_DIGITAL', custody: { chainId: CHAIN, custodyAddress: custody.target, token: token.target, principal: '1000', fees: '0', reserve: '0' },
    consents: { buyer: { accepted: true, ref: 'closure-buyer' }, seller: { accepted: true, ref: 'closure-seller' }, sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' } },
    evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true, acceptedIssuers: [seller.address], requiredTypes: ['deliverable-hash'] },
    deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) }, fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' },
  };
  const built = canonical.buildV4Manifest(m);
  m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
  const digest = '0x' + built.manifestHash.slice(7);
  const authorizations = [];
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const message = { manifestHash: digest, role, nonce: '1', expiresAt: String(t + 900) };
    authorizations.push({ role, walletType: 'EOA', nonce: message.nonce, expiresAt: message.expiresAt, signature: await signer.signTypedData(signatures.agreementDomain(custody.target, CHAIN), signatures.COMMITMENT_CONSENT_TYPES, message) });
  }
  check('canonical v4 agreement signed', /^0x[0-9a-fA-F]{130}$/.test(m.signatureHex));

  // ——— Genuine EAS anchor (local 31337) ———
  const data = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [cid, digest, ...Array(10).fill(''), 'issued', BigInt(t)]);
  const req = { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: false, refUID: ethers.ZeroHash, data, value: 0 };
  const attReceipt = await (await eas.connect(attester).attest({ schema: av.SCHEMA_UID, data: req })).wait();
  const attEvent = attReceipt.logs.map(l => { try { return eas.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'Attested');
  const anchor = { recordVersion: 1, chainId: CHAIN, easAddress: eas.target, schemaUid: av.SCHEMA_UID, uid: attEvent.args.uid, txHash: attReceipt.hash, blockHash: attReceipt.blockHash, blockNumber: String(attReceipt.blockNumber), attester: attester.address, recipient: req.recipient, attestationData: data, authorizations: [] };
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const expiresAt = String(t + 900);
    anchor.authorizations.push({ role, expiresAt, signature: await signer.signTypedData(av.domain(anchor), av.AUTH_TYPES, av.message(anchor, m, digest, expiresAt)) });
  }
  check('genuine EAS attestation anchored (official 1.7.1, local 31337)', !!attReceipt.status && attReceipt.status === 1);

  // ——— Funding + evaluator release ———
  const funding = await (await custody.connect(buyer).fund(cid, digest, token.target, buyer.address, seller.address, safe.target, 1000, t + 1000, t + 2000, 0, 1, policy, digest)).wait();
  function releaseArgs(nonce) {
    const d = ethers.TypedDataEncoder.hash(signatures.custodyDomain(custody.target, CHAIN), signatures.ESCROW_VERDICT_TYPES, { commitmentId: cid, commitmentDigest: digest, action: 'release', nonce, issuedAt: t });
    const h = helpers.safeMessageHash(ethers, safe.target, CHAIN, d);
    const packed = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(ethers, i, h) })));
    return [cid, digest, nonce, t, 0, ethers.ZeroHash, ethers.ZeroHash, packed];
  }
  const settlement = await (await custody.connect(stranger).release(...releaseArgs(6311), { gasLimit: 1000000 })).wait();
  const escrow = await custody.getEscrow(cid);
  check('local custody lifecycle executed (fund -> release)', escrow[13] === 3n);

  // ——— Phase A journal (issue -> funded -> release) ———
  const jw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custody.target, commitmentId: cid, manifestHash: digest });
  await jw.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await jw.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer], txHash: funding.hash, blockHash: funding.blockHash });
  await jw.append({ transition: 'release', role: 'evaluator', by: safe.target, contractAction: 'release', resultingState: 'Released', at: new Date((t + 1) * 1000).toISOString(), signerWallets: [deployer], txHash: settlement.hash, blockHash: settlement.blockHash, authorization: { kind: 'safe-erc1271-2of3', agreedEvaluator: safe.target, chainId: CHAIN, custody: custody.target, note: 'custody accepted the Safe 2-of-3 authorization; journal attests the record, not the authorization' } });
  check('journal chain intact (3 entries)', jw.count() === 3);

  // ——— Phase C: signed fulfillment evidence (genuine seller signature) ———
  const evidenceItemMsg = {
    recordVersion: 1, commitmentId: cid, manifestHash: digest,
    criterionId: 'deliverable-hash', itemId: 'closure-report-1',
    type: 'deliverable-hash', issuer: seller.address, payloadHash: deliverableHash,
    at: new Date(t * 1000).toISOString(), amount: '0',
  };
  const evidenceItemSig = await seller.signTypedData(signatures.evidenceDomain(custody.target, CHAIN), signatures.EVIDENCE_ITEM_TYPES, evidenceItemMsg);
  const evidenceSig = ethers.Signature.from(evidenceItemSig);
  const evidenceRecord = {
    recordVersion: 1,
    time: new Date(t * 1000).toISOString(),
    commitmentId: cid,
    manifestHash: digest,
    domain: signatures.evidenceDomain(custody.target, CHAIN),
    items: [{
      itemId: 'closure-report-1', criterionId: 'deliverable-hash', type: 'deliverable-hash',
      issuer: seller.address, payloadHash: deliverableHash, payload: deliverablePayload,
      at: new Date(t * 1000).toISOString(), amount: '0', signedBy: seller.address,
      sigs: [{ v: evidenceSig.v, r: evidenceSig.r, s: evidenceSig.s }],
    }],
    findings: {},
  };
  check('genuine seller-signed evidence item for the digital deliverable', evidenceRecord.items[0].signedBy === seller.address && /^0x[0-9a-fA-F]{64}$/.test(evidenceRecord.items[0].payloadHash));

  const exp = { formatVersion: 4, agreement: m, commitmentDigest: built.manifestHash, authorizations, lifecycleProfile: 'full', lifecycle: { funding: ref(funding), settlement: ref(settlement) }, finality: { mode: 'local-synthetic' }, anchor, journal: jw.snapshot(), evidence: evidenceRecord };
  const expPath = path.join(OUT, 'lifecycle-anchored-journal.json');
  fs.writeFileSync(expPath, JSON.stringify(exp, null, 2) + '\n');
  check('full export with anchor + journal + evidence written', fs.existsSync(expPath) && !!exp.anchor && !!exp.journal && !!exp.evidence && exp.agreement.custody.chainId === 31337);

  // ——— Separate-process verification (read-only RPC proxy) ———
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

  const positive = await child(expPath, rpc);
  fs.writeFileSync(path.join(OUT, 'separate-process.txt'), positive.text + '\nEXIT_CODE=' + positive.code + '\n');
  check('separate process: anchor checks genuinely pass', positive.code === 0 && positive.text.includes('independent EAS anchor') && positive.text.includes('VERDICT: VERIFIED_WITH_LIMITATIONS'));
  check('separate process: NO full-lifecycle VERIFIED claim (limited assurance only)', /VERDICT: VERIFIED_WITH_LIMITATIONS/.test(positive.text) && !/VERDICT: VERIFIED\b/.test(positive.text));
  check('separate process: journal verification implemented and passing (Phase B)', positive.code === 0 && positive.text.includes('journal authenticated association to signed agreement') && positive.text.includes('journal terminal consistency with independently checked custody execution'));
  check('separate process: finality limitation explicit', /no public-chain finality|no independent consensus/i.test(positive.text));
  check('separate process: governance limitation explicit', /does not establish approved 2-of-3 Safe governance/.test(positive.text));
  check('separate process: evidence authenticity + sufficiency + criterion pass (Phase C)', positive.code === 0 && positive.text.includes('evidence record strict schema and agreement-bound domain') && positive.text.includes('evidence evidence acceptance criterion satisfied') && positive.text.includes('evidence evidence sufficiency: type, count, uniqueness, freshness, deadline window'));
  check('separate process: evidence does NOT claim real-world truth', /does NOT establish the truth|truth of the real-world assertion/.test(positive.text));
  check('separate process: evidence limitations explicit (objective-only, no subjective/physical/high-value)', /Subjective services, physical delivery and high-value profiles require distinct evidence/.test(positive.text));

  // ——— Anchor substitution negative (different UID, same rest) ———
  const neg1 = JSON.parse(JSON.stringify(exp));
  neg1.anchor.uid = ethers.ZeroHash;
  const neg1File = path.join(OUT, 'case-anchor-uid-substitution.json');
  fs.writeFileSync(neg1File, JSON.stringify(neg1));
  const neg1Result = await child(neg1File, rpc);
  check('negative: anchor UID substitution NOT VERIFIED (specific reason)', neg1Result.code === 1 && /NOT VERIFIED|INCOMPLETE_UNSUPPORTED/.test(neg1Result.text) && /anchor/.test(neg1Result.text));

  // ——— Digest substitution negative (changed agreement, re-signed?) ———
  // Re-signing the agreement keeps canonical integrity but changes the digest,
  // which then mismatches the anchor data and the funded escrow — the verifier
  // must reject via digest binding, not by trusting the export's claim.
  const neg2 = JSON.parse(JSON.stringify(exp));
  neg2.agreement.price.amount = '1001';
  neg2.agreement.custody.principal = '1001';
  const rebuilt = canonical.buildV4Manifest(neg2.agreement);
  neg2.agreement.signatureHex = rebuilt.signature.slice('COSE_Sign1:'.length);
  neg2.commitmentDigest = rebuilt.manifestHash;
  for (const auth of neg2.authorizations) {
    const signer = auth.role === 'buyer' ? buyer : seller;
    auth.signature = await signer.signTypedData(signatures.agreementDomain(custody.target, CHAIN), signatures.COMMITMENT_CONSENT_TYPES, { manifestHash: '0x' + rebuilt.manifestHash.slice(7), role: auth.role, nonce: auth.nonce, expiresAt: auth.expiresAt });
  }
  neg2.anchor.authorizations = [];
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const expiresAt = String(t + 900);
    neg2.anchor.authorizations.push({ role, expiresAt, signature: await signer.signTypedData(av.domain(neg2.anchor), av.AUTH_TYPES, av.message(neg2.anchor, neg2.agreement, '0x' + rebuilt.manifestHash.slice(7), expiresAt)) });
  }
  const neg2File = path.join(OUT, 'case-digest-substitution.json');
  fs.writeFileSync(neg2File, JSON.stringify(neg2));
  const neg2Result = await child(neg2File, rpc);
  check('negative: digest substitution (re-signed changed amount) rejected', neg2Result.code === 1 && /NOT VERIFIED/.test(neg2Result.text) && /funding binding mismatch|anchor/.test(neg2Result.text));

  // ——— Issue-only positive control (anchor-only, no lifecycle) ———
  const issueOnly = JSON.parse(JSON.stringify(exp));
  delete issueOnly.lifecycle; issueOnly.lifecycleProfile = 'issue'; delete issueOnly.journal; delete issueOnly.evidence;
  const issueFile = path.join(OUT, 'case-issue-only-anchor.json');
  fs.writeFileSync(issueFile, JSON.stringify(issueOnly));
  const issueResult = await child(issueFile, rpc);
  check('positive control: issue-only with anchor = VERIFIED_ISSUANCE_ONLY', issueResult.code === 0 && /VERDICT: VERIFIED_ISSUANCE_ONLY/.test(issueResult.text));

  // ——— Phase C evidence negatives (each asserts a specific reason) ———
  const neg3 = JSON.parse(JSON.stringify(exp));
  // wrong issuer: re-sign the SAME payload with the deployer key (not seller)
  const wrongIssuerMsg = {
    recordVersion: 1, commitmentId: cid, manifestHash: digest,
    criterionId: 'deliverable-hash', itemId: 'closure-report-1',
    type: 'deliverable-hash', issuer: deployer.address, payloadHash: deliverableHash,
    at: new Date(t * 1000).toISOString(), amount: '0',
  };
  const wrongIssuerSig = ethers.Signature.from(await deployer.signTypedData(signatures.evidenceDomain(custody.target, CHAIN), signatures.EVIDENCE_ITEM_TYPES, wrongIssuerMsg));
  neg3.evidence.items[0].issuer = deployer.address;
  neg3.evidence.items[0].signedBy = deployer.address;
  neg3.evidence.items[0].sigs = [{ v: wrongIssuerSig.v, r: wrongIssuerSig.r, s: wrongIssuerSig.s }];
  const neg3File = path.join(OUT, 'case-evidence-wrong-issuer.json');
  fs.writeFileSync(neg3File, JSON.stringify(neg3));
  const neg3Result = await child(neg3File, rpc);
  check('negative: evidence wrong issuer (re-signed by non-seller) rejected', neg3Result.code === 1 && /NOT VERIFIED|INCOMPLETE_UNSUPPORTED/.test(neg3Result.text) && /signer != issuer|issuer not in signed acceptedIssuers|signedBy|issuer/.test(neg3Result.text));

  const neg4 = JSON.parse(JSON.stringify(exp));
  // wrong payload: correct seller signature but payload does NOT match the
  // signed expected digest — criterion affirmatively fails (not a generic error)
  const wrongPayload = JSON.stringify({ deliverable: 'synthetic-closure-report', value: 'something-else' });
  const wrongPayloadHash = '0x' + crypto.createHash('sha256').update(wrongPayload, 'utf8').digest('hex');
  const wrongPayloadMsg = {
    recordVersion: 1, commitmentId: cid, manifestHash: digest,
    criterionId: 'deliverable-hash', itemId: 'closure-report-1',
    type: 'deliverable-hash', issuer: seller.address, payloadHash: wrongPayloadHash,
    at: new Date(t * 1000).toISOString(), amount: '0',
  };
  const wrongPayloadSig = ethers.Signature.from(await seller.signTypedData(signatures.evidenceDomain(custody.target, CHAIN), signatures.EVIDENCE_ITEM_TYPES, wrongPayloadMsg));
  neg4.evidence.items[0].payload = wrongPayload;
  neg4.evidence.items[0].payloadHash = wrongPayloadHash;
  neg4.evidence.items[0].sigs = [{ v: wrongPayloadSig.v, r: wrongPayloadSig.r, s: wrongPayloadSig.s }];
  const neg4File = path.join(OUT, 'case-evidence-criterion-fail.json');
  fs.writeFileSync(neg4File, JSON.stringify(neg4));
  const neg4Result = await child(neg4File, rpc);
  check('negative: correctly signed evidence that FAILS the criterion rejected (specific reason)', neg4Result.code === 1 && /acceptance criterion NOT satisfied/.test(neg4Result.text));

  const neg5 = JSON.parse(JSON.stringify(exp));
  // missing evidence on a lifecycle export => INCOMPLETE (never success)
  delete neg5.evidence;
  const neg5File = path.join(OUT, 'case-evidence-missing.json');
  fs.writeFileSync(neg5File, JSON.stringify(neg5));
  const neg5Result = await child(neg5File, rpc);
  check('negative: lifecycle export missing evidence INCOMPLETE (not VERIFIED)', neg5Result.code === 1 && /INCOMPLETE_UNSUPPORTED/.test(neg5Result.text) && /fulfillment evidence record required/.test(neg5Result.text));

  fs.writeFileSync(path.join(OUT, 'run-record.json'), JSON.stringify({
    command: 'node scripts/test-v4-producer-closure.cjs',
    revision, chainId: CHAIN, easPackage: '1.7.1', safePackage: require('@safe-global/safe-contracts/package.json').version,
    ethersVersion: require('ethers').version, solcVersion: require('solc').version(),
    network: 'in-process local EVM (NOT public Base Sepolia)', noPublicFinality: true,
    outputs: ['lifecycle-anchored-journal.json', 'separate-process.txt', 'case-anchor-uid-substitution.json', 'case-digest-substitution.json', 'case-issue-only-anchor.json', 'case-evidence-wrong-issuer.json', 'case-evidence-criterion-fail.json', 'case-evidence-missing.json'],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, passed, failed, revision, chainId: CHAIN }, null, 2) + '\n');
  console.log('closure_passed=' + passed + ' failed=' + failed);
  await new Promise(r => server.close(r)); server = null;
  provider.destroy();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); if (server) server.close(); process.exit(2); });
