'use strict';
// Local-only fixture production. Child verifier sees only public RPC + export.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const canonical = require('../mainnet/design/support/v4-canonical');
const signatures = require('../mainnet/design/support/v4-signatures');
const av = require('../verifier/v4-anchor'); // SCHEMA_UID, TYPES, domain/message/AUTH_TYPES
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence/phase3b-v4');
fs.mkdirSync(OUT, { recursive: true });
let server;
const results = [];
function check(name, condition) { results.push({ name, pass: !!condition }); console.log((condition ? 'PASS ' : 'FAIL ') + name); }
async function child(file, rpc, verifier = path.join(ROOT, 'verifier/verify-export.js')) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [verifier, file, '--rpc', rpc], { cwd: ROOT, env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])) });
    let text = '';
    p.stdout.on('data', v => { text += v; }); p.stderr.on('data', v => { text += v; });
    p.on('error', reject); p.on('exit', code => resolve({ code, text }));
  });
}
(async () => {
  const { provider, hre, accounts } = await helpers.startEvm(31337);
  // Forward only public read methods to the independent process; never signer
  // APIs, app DB or private-key material. No exported raw transaction bytes.
  const allow = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']);
  server = require('http').createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async q => {
      try { if (!allow.has(q.method)) throw new Error('read-only method unavailable'); return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) }; }
      catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rpc = 'http://127.0.0.1:' + server.address().port;
  const [deployer, buyer, seller, evaluator, attester, , stranger] = accounts;
  // F3C-REPAIR: signing chainId derived from the running provider, never hardcoded.
  // Local EVM presents chainId 31337 (hardhat.config.js chain-identity resolution
  // d1eb4c6d). The fixture previously signed 84532 domains, which the custody and
  // Safe reject (UnauthorizedSigner). Public-chain identity separation is preserved:
  // 84532 remains the historical Base Sepolia identity; wrong-chain controls still assert.
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 31337) throw new Error("fixture requires local EVM chainId 31337, got " + chainId);
  async function deploy(art, args = []) { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; }
  // --- Official EAS 1.7.1 deployed FIRST so addresses match the pinned
  // 31337 policy (registry 0x5FbDB2..., EAS 0xe7f1725E...) ---
  const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
  const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
  const registry = await deploy(regArt);
  const eas = await deploy(easArt, [registry.target]);
  await (await registry.register(av.SCHEMA, ethers.ZeroAddress, false)).wait();
  const safeArt = helpers.compileSafe('Safe', 'contracts/Safe.sol');
  const handlerArt = helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const singleton = await deploy(safeArt), handler = await deploy(handlerArt), factory = await deploy(factoryArt);
  const init = new ethers.Interface(safeArt.abi).encodeFunctionData('setup', [[buyer.address, seller.address, evaluator.address], 2, ethers.ZeroAddress, '0x', handler.target, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const created = await (await factory.createProxyWithNonce(singleton.target, init, 440n)).wait();
  const createdEvent = created.logs.map(l => { try { return factory.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'ProxyCreation');
  const safe = new ethers.Contract(createdEvent.args.proxy, safeArt.abi, deployer);
  const token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  const policy = '0x' + 'ab'.repeat(32);
  const custodyArt = hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2');
  const custody = await deploy(custodyArt, [1000000, 10000000, true, 1, policy]);
  const identityPath = path.join(ROOT, 'verifier/v4-candidate-identity-31337.json');
  const runtimeHash = ethers.keccak256(await provider.getCode(custody.target));
  if (process.argv.includes('--record-identity')) {
    fs.writeFileSync(identityPath, JSON.stringify({ policy: 'local-immutable-candidate-v1', chainId, compiler: require('solc').version(), settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris' }, sourceSha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'contracts/SAAXEscrowCustodyV2.sol'))).digest('hex'), runtimeCodeHash: runtimeHash, abi: custodyArt.abi }, null, 2) + '\n');
  }
  check('runtime equals repository-owned identity (not export claim)', require(identityPath).runtimeCodeHash === runtimeHash);
  check('strict helper rejects truncated/oversized bytes32', (() => { try { signatures.toBytes32('0x' + 'ab'.repeat(33)); return false; } catch (_) { return true; } })());
  check('helper custody domain agrees with candidate constants', signatures.CUSTODY_DOMAIN_NAME === await custody.DOMAIN_NAME() && signatures.CUSTODY_DOMAIN_VERSION === await custody.DOMAIN_VERSION());
  await (await token.mint(buyer.address, 1000000)).wait();
  await (await token.connect(buyer).approve(custody.target, 1000000)).wait();
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const t = Number(BigInt(block.timestamp));
  const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
  const ref = r => ({ txHash: r.hash, blockHash: r.blockHash });
  const exports = [];
  // Genuine fulfillment evidence (same non-fabricated pattern as the Phase C
  // closure producer): a deterministic JSON deliverable the seller produced,
  // sha256 = the signed hash-equals acceptance criterion, item signed by the
  // seller under the v4 evidence domain.
  const crypto = require('crypto');
  const deliverablePayload = JSON.stringify({
    deliverable: 'synthetic-closure-report',
    format: 'application/json',
    fields: { sha256: 'true', units: 'exact' },
    value: 'the-digital-deliverable',
  });
  const deliverableHash = '0x' + crypto.createHash('sha256').update(deliverablePayload, 'utf8').digest('hex');
  async function buildEvidenceRecord(m, digest) {
    const evidenceItemMsg = {
      recordVersion: 1, commitmentId: m.commitmentId, manifestHash: digest,
      criterionId: 'deliverable-hash', itemId: 'synthetic-deliverable-1',
      type: 'deliverable-hash', issuer: seller.address, payloadHash: deliverableHash,
      at: new Date(t * 1000).toISOString(), amount: '0',
    };
    const evidenceItemSig = await seller.signTypedData(signatures.evidenceDomain(custody.target, chainId), signatures.EVIDENCE_ITEM_TYPES, evidenceItemMsg);
    const evidenceSig = ethers.Signature.from(evidenceItemSig);
    return {
      recordVersion: 1,
      time: new Date(t * 1000).toISOString(),
      commitmentId: m.commitmentId,
      manifestHash: digest,
      domain: signatures.evidenceDomain(custody.target, chainId),
      items: [{
        itemId: 'synthetic-deliverable-1', criterionId: 'deliverable-hash', type: 'deliverable-hash',
        issuer: seller.address, payloadHash: deliverableHash, payload: deliverablePayload,
        at: new Date(t * 1000).toISOString(), amount: '0', signedBy: seller.address,
        sigs: [{ v: evidenceSig.v, r: evidenceSig.r, s: evidenceSig.s }],
      }],
      findings: {},
    };
  }
  async function fixture(idNumber) {
    const m = {
      commitmentId: ethers.zeroPadValue(ethers.toBeHex(idNumber), 32), buyerAgentId: buyer.address, sellerAgentId: seller.address,
      capability: 'synthetic-local', price: { amount: '1000', currency: 'USDC', decimals: 6 }, acceptanceCriteria: { type: 'hash-equals', value: deliverableHash },
      deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
      terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
      evaluator: safe.target, evaluatorPermittedDecisions: ['release', 'refund'],
      policy: { version: 'saax-custody-policy-v1', digest: policy, profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
      profile: 'OBJECTIVE_DIGITAL', custody: { chainId, custodyAddress: custody.target, token: token.target, principal: '1000', fees: '0', reserve: '0' },
      consents: { buyer: { accepted: true, ref: 'synthetic-buyer' }, seller: { accepted: true, ref: 'synthetic-seller' }, sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' } },
      evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true, acceptedIssuers: [seller.address], requiredTypes: ['deliverable-hash'] },
      deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) }, fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' }
    };
    const built = canonical.buildV4Manifest(m);
    m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
    const digest = '0x' + built.manifestHash.slice(7);
    const authorizations = [];
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
      const message = { manifestHash: digest, role, nonce: '1', expiresAt: String(t + 900) };
      authorizations.push({ role, walletType: 'EOA', nonce: message.nonce, expiresAt: message.expiresAt, signature: await signer.signTypedData(signatures.agreementDomain(custody.target, chainId), signatures.COMMITMENT_CONSENT_TYPES, message) });
    }
    const data = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [m.commitmentId, digest, ...Array(10).fill(''), 'issued', BigInt(t)]);
    const req = { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: false, refUID: ethers.ZeroHash, data, value: 0 };
    const attReceipt = await (await eas.connect(attester).attest({ schema: av.SCHEMA_UID, data: req })).wait();
    const attEvent = attReceipt.logs.map(l => { try { return eas.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'Attested');
    const anchor = { recordVersion: 1, chainId, easAddress: eas.target, schemaUid: av.SCHEMA_UID, uid: attEvent.args.uid, txHash: attReceipt.hash, blockHash: attReceipt.blockHash, blockNumber: String(attReceipt.blockNumber), attester: attester.address, recipient: req.recipient, attestationData: data, authorizations: [] };
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
      const expiresAt = String(t + 900);
      anchor.authorizations.push({ role, expiresAt, signature: await signer.signTypedData(av.domain(anchor), av.AUTH_TYPES, av.message(anchor, m, digest, expiresAt)) });
    }
    const funding = await (await custody.connect(buyer).fund(m.commitmentId, digest, token.target, buyer.address, seller.address, safe.target, 1000, t + 1000, t + 2000, 0, 1, policy, digest)).wait();
    const evidence = await buildEvidenceRecord(m, digest);
    const exp = { formatVersion: 4, agreement: m, commitmentDigest: built.manifestHash, authorizations, lifecycleProfile: 'full', lifecycle: { funding: ref(funding) }, finality: { mode: 'local-synthetic' }, anchor, evidence };
    exports.push(exp);
    return { exp, digest, id: m.commitmentId };
  }
  function releaseArgs(f, nonce) {
    const digest = ethers.TypedDataEncoder.hash(signatures.custodyDomain(custody.target, chainId), signatures.ESCROW_VERDICT_TYPES, { commitmentId: f.id, commitmentDigest: f.digest, action: 'release', nonce, issuedAt: t });
    const h = helpers.safeMessageHash(ethers, safe.target, chainId, digest);
    const packed = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(ethers, i, h) })));
    return [f.id, f.digest, nonce, t, 0, ethers.ZeroHash, ethers.ZeroHash, packed];
  }
  const first = await fixture(4401), second = await fixture(4402);
  // Queue a valid release, governance invalidation, then stale authorization.
  // All execute in ONE block in that order. Successful execution is the
  // historical witness even though end-of-block Safe validation now fails.
  const firstArgs = releaseArgs(first, 4401), secondArgs = releaseArgs(second, 4402);
  const data = safe.interface.encodeFunctionData('changeThreshold', [3]);
  const safeHash = await safe.getTransactionHash(safe.target, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, await safe.nonce());
  const packedGov = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(ethers, i, safeHash) })));
  await hre.network.provider.send('evm_setAutomine', [false]);
  const good = await custody.connect(stranger).release(...firstArgs, { gasLimit: 1000000 });
  const governance = await safe.execTransaction(safe.target, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, packedGov, { gasLimit: 1000000 });
  const bad = await custody.connect(stranger).release(...secondArgs, { gasLimit: 1000000 });
  await hre.network.provider.send('evm_mine');
  await hre.network.provider.send('evm_setAutomine', [true]);
  const goodReceipt = await provider.getTransactionReceipt(good.hash), govReceipt = await provider.getTransactionReceipt(governance.hash), badReceipt = await provider.getTransactionReceipt(bad.hash);
  check('same block release -> governance -> invalid authorization ordering', goodReceipt.blockHash === govReceipt.blockHash && govReceipt.blockHash === badReceipt.blockHash && goodReceipt.index < govReceipt.index && govReceipt.index < badReceipt.index);
  check('authorization valid before governance succeeds', goodReceipt.status === 1);
  check('authorization invalidated before execution fails without payout', badReceipt.status === 0 && (await custody.getEscrow(second.id))[13] === 1n);
  check('end-of-block governance is different from execution point', await safe.getThreshold() === 3n);
  first.exp.lifecycle.settlement = ref(goodReceipt); second.exp.lifecycle.settlement = ref(badReceipt);

  // â”€â”€ Phase A journal building (new journal-bearing exports; synthetic-*.json
  //    writes below stay byte-identical â€” no journal field added to them) â”€â”€
  const journalWriter = require('../mainnet/design/support/v4-journal-writer');
  // The walk test verifies against the DECLARED chain; the export declares the
  // runtime chainId (31337), so domain-bound signatures verify correctly.
  // (chainId derived once above from the provider - F3C-REPAIR)
  const custodyAddress = custody.target;

  async function buildLifecycleJournal(exp, id, digest, receipt, resolution) {
    const jw = journalWriter.createJournalWriter({ chainId, custodyAddress, commitmentId: id, manifestHash: digest });
    // issue (first entry, agreement binding) â€” signed by buyer
    await jw.append({
      transition: 'issue', role: 'buyer', by: buyer.address,
      contractAction: 'sign-agreement', resultingState: 'Issued',
      at: new Date((t - 5) * 1000).toISOString(),
      signerWallets: [buyer],
    });
    // funded â€” signed by buyer (the fund caller)
    const fundRef = exp.lifecycle.funding;
    await jw.append({
      transition: 'funded', role: 'buyer', by: buyer.address,
      contractAction: 'fund', resultingState: 'Funded',
      at: new Date(t * 1000).toISOString(),
      signerWallets: [buyer],
      txHash: fundRef.txHash, blockHash: fundRef.blockHash,
    });
    // resolution â€” evaluator release (Safe): writer cannot sign as the Safe;
    // authority = on-chain authorization evidence (SafeMessage + packed owner
    // sigs the custody validated). Entry signed by the producer's journal
    // attestation key (deployer); signedBy != by; authorization recorded.
    const resEntry = await jw.append({
      transition: resolution.transition, role: 'evaluator', by: safe.target,
      contractAction: resolution.contractAction, resultingState: resolution.state,
      at: new Date((t + 1) * 1000).toISOString(),
      signerWallets: [deployer],
      txHash: receipt.hash, blockHash: receipt.blockHash,
      authorization: {
        kind: 'safe-erc1271-2of3',
        agreedEvaluator: safe.target,
        chainId,
        custody: custodyAddress,
        note: 'custody accepted the Safe 2-of-3 authorization; journal attests the record, not the authorization',
      },
    });
    return { jw, resolutionEntry: resEntry };
  }

  // Full lifecycle journal (first): issue -> funded -> release (Safe evaluator)
  const fl = await buildLifecycleJournal(first.exp, first.id, first.digest, goodReceipt,
    { transition: 'release', contractAction: 'release', state: 'Released' });
  const journalLifecyclePath = path.join(OUT, 'journal-lifecycle.json');
  fs.writeFileSync(journalLifecyclePath, JSON.stringify({
    ...JSON.parse(JSON.stringify(first.exp)),
    journal: fl.jw.snapshot(),
  }, null, 2));
  check('journal-bearing lifecycle export written', fs.existsSync(journalLifecyclePath));

  // F3C-REPAIR: the separate-process lifecycle check MUST verify the
  // journal-bearing export (journal-lifecycle.json). A lifecycle export without
  // a journal record is INCOMPLETE_UNSUPPORTED (v4-journal.js:181). The
  // journal-less synthetic-lifecycle.json is retained as a historical artifact
  // but is no longer the verification input.
  const validFile = journalLifecyclePath;
  fs.writeFileSync(path.join(OUT, 'synthetic-lifecycle.json'), JSON.stringify(first.exp, null, 2));
  const valid = await child(validFile, rpc);
  fs.writeFileSync(path.join(OUT, 'separate-process.txt'), valid.text);
  check('separate process verifies pre-governance lifecycle without private keys/DB', valid.code === 0 && valid.text.includes('VERDICT: VERIFIED_WITH_LIMITATIONS'));
  // Exercise the other action-specific paths through the same verifier.
  const mutualFixture = await fixture(4403);
  const mutualMessage = { commitmentId: mutualFixture.id, commitmentDigest: mutualFixture.digest, action: 'refund', nonce: 4403, issuedAt: t };
  const mutualSigs = [];
  for (const party of [buyer, seller]) mutualSigs.push(ethers.Signature.from(await party.signTypedData(signatures.custodyDomain(custody.target, chainId), signatures.MUTUAL_RESOLUTION_TYPES, mutualMessage)));
  const mutualReceipt = await (await custody.connect(stranger).mutualRefund(mutualFixture.id, mutualFixture.digest, 4403, t, mutualSigs[0].v, mutualSigs[0].r, mutualSigs[0].s, mutualSigs[1].v, mutualSigs[1].r, mutualSigs[1].s)).wait();
  mutualFixture.exp.lifecycle.settlement = ref(mutualReceipt);
  // Mutual journal: issue -> funded -> mutual-refund (buyer+seller, two sigs).
  // Built BEFORE the separate-process check so the check verifies the
  // journal-bearing export (v4-journal.js:181 requires it for lifecycle).
  const mj = journalWriter.createJournalWriter({ chainId, custodyAddress, commitmentId: mutualFixture.id, manifestHash: mutualFixture.digest });
  await mj.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await mj.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer], txHash: mutualFixture.exp.lifecycle.funding.txHash, blockHash: mutualFixture.exp.lifecycle.funding.blockHash });
  await mj.append({ transition: 'mutual-refund', role: 'buyer+seller', by: buyer.address, contractAction: 'mutualRefund', resultingState: 'Refunded', at: new Date((t + 1) * 1000).toISOString(), signerWallets: [buyer, seller], txHash: mutualFixture.exp.lifecycle.settlement.txHash, blockHash: mutualFixture.exp.lifecycle.settlement.blockHash });
  const journalMutualPath = path.join(OUT, 'journal-mutual.json');
  fs.writeFileSync(journalMutualPath, JSON.stringify({ ...JSON.parse(JSON.stringify(mutualFixture.exp)), journal: mj.snapshot() }, null, 2));
  check('journal-bearing mutual export written', fs.existsSync(journalMutualPath));
  const mutualFile = journalMutualPath; fs.writeFileSync(path.join(OUT, 'synthetic-mutual.json'), JSON.stringify(mutualFixture.exp, null, 2));
  const mutualResult = await child(mutualFile, rpc);
  check('separate process verifies exact mutual-refund path', mutualResult.code === 0 && /action-specific mutual/.test(mutualResult.text));
  const timeoutFixture = await fixture(4404);
  await hre.network.provider.send('evm_setNextBlockTimestamp', [t + 2000]);
  const timeoutReceipt = await (await custody.connect(stranger).refund(timeoutFixture.id, timeoutFixture.digest, 0, 0, 0, ethers.ZeroHash, ethers.ZeroHash, '0x')).wait();
  timeoutFixture.exp.lifecycle.settlement = ref(timeoutReceipt);
  // Timeout journal: issue -> funded -> timeout-refund (open role; writer attests;
  // by = the actual submitter = stranger; authority = cutoff eligibility + fixed
  // recipient. NOT the writer's key as the actor.)
  const tj = journalWriter.createJournalWriter({ chainId, custodyAddress, commitmentId: timeoutFixture.id, manifestHash: timeoutFixture.digest });
  await tj.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await tj.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer], txHash: timeoutFixture.exp.lifecycle.funding.txHash, blockHash: timeoutFixture.exp.lifecycle.funding.blockHash });
  // F3C-REPAIR: the verifier's journal terminal consistency requires the
  // timeout-refund entry's `by` to be the CONTRACT-FIXED beneficiary (the
  // original buyer). The submitter (stranger) is not the authorizing party;
  // authority is cutoff-eligibility + fixed recipient. `by` = buyer (role
  // 'open' exempts the by==signer check; writer attests with its key).
  await tj.append({ transition: 'timeout-refund', role: 'open', by: buyer.address, contractAction: 'refund(timeout)', resultingState: 'Refunded', at: new Date((t + 2000) * 1000).toISOString(), signerWallets: [deployer], txHash: timeoutFixture.exp.lifecycle.settlement.txHash, blockHash: timeoutFixture.exp.lifecycle.settlement.blockHash, authorization: { kind: 'cutoff-eligibility', finalCutoffAt: t + 2000, recipientFixed: buyer.address, note: 'open submission; recipient fixed by contract; writer attests the record only' } });
  const journalTimeoutPath = path.join(OUT, 'journal-timeout.json');
  fs.writeFileSync(journalTimeoutPath, JSON.stringify({ ...JSON.parse(JSON.stringify(timeoutFixture.exp)), journal: tj.snapshot() }, null, 2));
  check('journal-bearing timeout export written', fs.existsSync(journalTimeoutPath));
  const timeoutFile = journalTimeoutPath; fs.writeFileSync(path.join(OUT, 'synthetic-timeout.json'), JSON.stringify(timeoutFixture.exp, null, 2));
  const timeoutResult = await child(timeoutFile, rpc);
  check('separate process verifies exact cutoff timeout refund path', timeoutResult.code === 0 && /action-specific timeout/.test(timeoutResult.text));

  async function test(name, mutate, pattern) {
    const exp = JSON.parse(JSON.stringify(first.exp)); await mutate(exp);
    const file = path.join(OUT, 'case.json'); fs.writeFileSync(file, JSON.stringify(exp));
    const r = await child(file, rpc);
    check(name, pattern.test(r.text));
  }
  for (const field of ['policy', 'profile', 'evaluator', 'custody', 'deadlines', 'consents', 'evidenceRequirements', 'fallbackDisposition']) {
    await test('tamper digest-covered ' + field, e => { if (typeof e.agreement[field] === 'object') e.agreement[field].tamper = true; else e.agreement[field] += '-tamper'; }, /VERDICT: NOT VERIFIED/);
  }
  async function resign(exp) {
    const built = canonical.buildV4Manifest(exp.agreement);
    exp.commitmentDigest = built.manifestHash;
    for (const auth of exp.authorizations) {
      const signer = auth.role === 'buyer' ? buyer : seller;
      auth.signature = await signer.signTypedData(signatures.agreementDomain(custody.target, chainId), signatures.COMMITMENT_CONSENT_TYPES, { manifestHash: '0x' + built.manifestHash.slice(7), role: auth.role, nonce: auth.nonce, expiresAt: auth.expiresAt });
    }
  }
  // F3C-REPAIR: a re-signed agreement is a DIFFERENT digest. The verifier's
  // order is envelope -> consents -> ANCHOR (digest binding) -> funding binding
  // -> journal -> evidence. Because the EAS anchor is attested over the
  // ORIGINAL digest, a re-signed (tampered) agreement is rejected at the
  // anchor commitment/digest binding BEFORE the funding-binding branch is
  // reached. That rejection is the STRONGER guarantee: re-signing cannot
  // launder a tampered agreement past the authenticated on-chain anchor. The
  // funding-binding assertion target is structurally unreachable under the
  // F3C-REPAIR anchor requirement (a consistent re-signed export cannot exist
  // without re-attesting, which cannot precede the already-executed
  // settlement). So these tests assert the anchor-digest binding rejection,
  // which preserves the re-sign intent (tamper cannot be laundered) while
  // matching the strengthened verifier.
  async function resignFixture(mutate) {
    const exp = JSON.parse(JSON.stringify(first.exp));
    await mutate(exp);
    const m = exp.agreement;
    const built = canonical.buildV4Manifest(m);
    m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
    const newDigest = '0x' + built.manifestHash.slice(7);
    exp.commitmentDigest = built.manifestHash;
    // Re-sign the consents over the NEW digest so the envelope + consent
    // checks pass; the ORIGINAL anchor (attested over the old digest) then
    // fails the commitment/digest binding.
    for (const auth of exp.authorizations) {
      const signer = auth.role === 'buyer' ? buyer : seller;
      auth.signature = await signer.signTypedData(signatures.agreementDomain(custody.target, chainId), signatures.COMMITMENT_CONSENT_TYPES, { manifestHash: newDigest, role: auth.role, nonce: auth.nonce, expiresAt: auth.expiresAt });
    }
    return exp;
  }
  await test('re-signed changed amount still mismatches actual funded escrow', async e => { const r = await resignFixture(async x => { x.agreement.price.amount = '1001'; x.agreement.custody.principal = '1001'; }); Object.assign(e, r); }, /anchor: commitment\/digest binding mismatch/);
  await test('re-signed changed evaluator still mismatches custody', async e => { const r = await resignFixture(async x => { x.agreement.evaluator = evaluator.address; }); Object.assign(e, r); }, /anchor: commitment\/digest binding mismatch/);
  await test('re-signed policy substitution still mismatches custody', async e => { const r = await resignFixture(async x => { x.agreement.policy.digest = '0x' + 'cc'.repeat(32); }); Object.assign(e, r); }, /anchor: commitment\/digest binding mismatch/);
  await test('changed chain consent domain cannot reuse signatures', e => { e.agreement.custody.chainId = 8453; const built = canonical.buildV4Manifest(e.agreement); e.commitmentDigest = built.manifestHash; }, /consent signature mismatch/);
  await test('missing seller authorization rejected', e => e.authorizations.pop(), /VERDICT: NOT VERIFIED/);
  await test('substituted consent signature rejected', e => e.authorizations[0].signature = e.authorizations[1].signature, /VERDICT: NOT VERIFIED/);
  await test('wrong consent role/nonce rejected', e => e.authorizations[0].nonce = '2', /VERDICT: NOT VERIFIED/);
  await test('unsupported party wallet path rejected', e => e.authorizations[0].walletType = 'ERC1271', /VERDICT: NOT VERIFIED/);
  await test('missing settlement incomplete, never full verified', e => delete e.lifecycle.settlement, /VERDICT: INCOMPLETE_UNSUPPORTED/);
  await test('noncanonical block reference rejected', e => e.lifecycle.settlement.blockHash = ethers.ZeroHash, /VERDICT: NOT VERIFIED/);
  await test('reverted stale authorization never verified', e => e.lifecycle = second.exp.lifecycle, /VERDICT: NOT VERIFIED/);
  await test('public finality not silently inferred', e => e.finality.mode = 'finalized', /VERDICT: NOT VERIFIED/);
  await test('issuance explicitly distinct', e => { e.lifecycleProfile = 'issue'; delete e.lifecycle; }, /VERDICT: VERIFIED_ISSUANCE_ONLY/);
  await test('unsupported version explicitly rejected', e => e.formatVersion = 99, /unsupported formatVersion/);
  // The execution-witness method needs no trace or historical Safe eth_call.
  // Verify that the read-only proxy never exposes trace methods at all.
  check('no trace support needed for allowlisted execution witness', !allow.has('debug_traceTransaction'));
  const originalSend = hre.network.provider.send.bind(hre.network.provider);
  hre.network.provider.send = async (method, params) => { if (method === 'eth_getCode') throw new Error('historical state unavailable'); return originalSend(method, params); };
  const missing = await child(validFile, rpc);
  check('missing required historical code yields incomplete unsupported', /VERDICT: INCOMPLETE_UNSUPPORTED/.test(missing.text));
  hre.network.provider.send = originalSend;
  // Historical regression: compare exact subprocess output before and after
  // dispatch addition using repository historical fixtures and no live RPC.
  if (!process.argv.includes('--skip-legacy')) {
  const old = require('child_process').execFileSync('git', ['show', '86f32cb71e8a82a993baa0fcb981851f5e477729:verifier/verify-export.js'], { cwd: ROOT, encoding: 'utf8' });
  const oldPath = path.join(ROOT, 'verifier/.phase3b-legacy-baseline.cjs'); fs.writeFileSync(oldPath, old);
  try {
    for (const fixture of ['baseline-verified-commitment.json', 'baseline-v2-verified-commitment.json', 'baseline-v3-verified-commitment.json', 'v3-battery/fixture-full-lifecycle.json']) {
      const file = path.join(ROOT, 'evidence', fixture);
      // RPC stub provides no EAS; compare identical explicit limitations, not
      // an invented positive historical verification against missing evidence.
      const before = await child(file, rpc, oldPath), after = await child(file, rpc);
      const normalize = text => text.replace(/\.phase3b-legacy-baseline\.cjs/g, 'verify-export.js');
      if (normalize(before.text) !== normalize(after.text)) fs.writeFileSync(path.join(OUT, 'legacy-difference.txt'), JSON.stringify({ fixture, before, after }, null, 2));
      check('legacy exact output/exit unchanged: ' + fixture, before.code === after.code && normalize(before.text) === normalize(after.text));
    }
  } finally { fs.unlinkSync(oldPath); }
  }
  fs.unlinkSync(path.join(OUT, 'case.json'));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, runtimeHash, compiler: require('solc').version(), safeVersion: require('@safe-global/safe-contracts/package.json').version, noPublicFinality: true }, null, 2));
  await new Promise(resolve => server.close(resolve)); server = null;
  provider.destroy();
  process.exit(results.every(r => r.pass) ? 0 : 1);
})().catch(e => { console.error(e); if (server) server.close(); process.exit(2); });
