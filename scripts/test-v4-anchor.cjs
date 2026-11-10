'use strict';
// LOCAL ONLY. Official EAS artifacts; no Safe suite, app DB, secrets or public RPC.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const canonical = require('../mainnet/design/support/v4-canonical');
const sig = require('../mainnet/design/support/v4-signatures');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence/v4-anchor');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
function check(name, ok, detail) { results.push({ name, pass: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' ' + detail : '')); }
let server;
(async () => {
  const hre = require('hardhat');
  await hre.run('compile');
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const [owner, buyer, seller, attester, other] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
  async function deploy(art, args = []) { const c = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(...args); await c.waitForDeployment(); return c; }
  const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
  const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
  const registry = await deploy(regArt);
  const eas = await deploy(easArt, [registry.target]);
  const policyFile = path.join(ROOT, 'verifier/v4-eas-policy.json');
  const computedPolicy = { policy: 'local-official-eas-1.7.1-v1', chainId: 84532, easAddress: eas.target, registryAddress: registry.target, runtimeCodeHash: ethers.keccak256(await provider.getCode(eas.target)), registryRuntimeCodeHash: ethers.keccak256(await provider.getCode(registry.target)) };
  if (process.argv.includes('--record-policy')) fs.writeFileSync(policyFile, JSON.stringify(computedPolicy, null, 2) + '\n');
  check('repository deployment/runtime identity equals official local contracts', JSON.stringify(require(policyFile)) === JSON.stringify(computedPolicy));
  const av = require('../verifier/v4-anchor');
  const { verifyV4 } = require('../verifier/verify-v4');
  await (await registry.register(av.SCHEMA, ethers.ZeroAddress, false)).wait();
  const token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  const policyDigest = '0x' + 'ab'.repeat(32);
  const custody = await deploy(hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2'), [1000000, 10000000, true, 1, policyDigest]);
  const now = Number(BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp));
  const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
  const m = {
    commitmentId: ethers.zeroPadValue('0xaa01', 32), buyerAgentId: buyer.address, sellerAgentId: seller.address,
    capability: 'local-anchor-control', price: { amount: '1000', currency: 'USDC', decimals: 6 }, acceptanceCriteria: { type: 'hash', value: 'synthetic' }, deadline: iso(now + 1000), cancelCondition: 'restricted', manifestVersion: 4,
    terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
    evaluator: other.address, evaluatorPermittedDecisions: ['release', 'refund'], policy: { version: 'saax-custody-policy-v1', digest: policyDigest, profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) }, profile: 'OBJECTIVE_DIGITAL',
    custody: { chainId: 84532, custodyAddress: custody.target, token: token.target, principal: '1000', fees: '0', reserve: '0' },
    consents: { buyer: { accepted: true, ref: 'local-buyer' }, seller: { accepted: true, ref: 'local-seller' }, sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' } },
    evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true }, deadlines: { delivery: iso(now + 500), resolution: iso(now + 1000), finalCutoff: iso(now + 2000) }, fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' }
  };
  const built = canonical.buildV4Manifest(m);
  m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
  const digest32 = '0x' + built.manifestHash.slice(7);
  const exp = { formatVersion: 4, agreement: m, commitmentDigest: built.manifestHash, lifecycleProfile: 'issue', authorizations: [], finality: { mode: 'local-synthetic' } };
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const auth = { role, walletType: 'EOA', nonce: '1', expiresAt: String(now + 900) };
    auth.signature = await signer.signTypedData(sig.agreementDomain(custody.target, 84532), sig.COMMITMENT_CONSENT_TYPES, { manifestHash: digest32, role, nonce: auth.nonce, expiresAt: auth.expiresAt });
    exp.authorizations.push(auth);
  }
  const data = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [m.commitmentId, digest32, ...Array(10).fill(''), 'issued', BigInt(now)]);
  async function anchor(dataValue = data, overrides = {}) {
    const req = { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: false, refUID: ethers.ZeroHash, data: dataValue, value: 0, ...overrides };
    const r = await (await eas.connect(attester).attest({ schema: av.SCHEMA_UID, data: req })).wait();
    const event = r.logs.map(l => { try { return eas.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'Attested');
    const a = { recordVersion: 1, chainId: 84532, easAddress: eas.target, schemaUid: av.SCHEMA_UID, uid: event.args.uid, txHash: r.hash, blockHash: r.blockHash, blockNumber: String(r.blockNumber), attester: attester.address, recipient: req.recipient, attestationData: dataValue, authorizations: [] };
    await authorize(a);
    return a;
  }
  async function authorize(a, expiry = String(now + 900)) {
    a.authorizations = [];
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) a.authorizations.push({ role, expiresAt: expiry, signature: await signer.signTypedData(av.domain(a), av.AUTH_TYPES, av.message(a, m, digest32, expiry)) });
  }
  exp.anchor = await anchor();
  const allow = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']);
  let mutateRpc = null;
  const methods = new Set();
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const p of req) body += p;
    const answer = async q => {
      methods.add(q.method);
      try {
        if (!allow.has(q.method)) throw new Error('read-only RPC: unavailable');
        let result = await hre.network.provider.send(q.method, q.params);
        if (mutateRpc) result = mutateRpc(q, structuredClone(result));
        return { jsonrpc: '2.0', id: q.id, result };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const rpc = 'http://127.0.0.1:' + server.address().port;
  async function verify(x) { return verifyV4(x, rpc); }
  const positive = await verify(exp);
  check('REAL CONTRACT: official EAS issuance anchor positive', positive.verdict === 'VERIFIED_ISSUANCE_ONLY' && !!positive.anchor, positive.reason);
  async function negative(name, edit, expected = 'NOT VERIFIED') {
    const x = structuredClone(exp); await edit(x);
    const r = await verify(x); check(name, r.verdict === expected, r.verdict + ': ' + r.reason);
  }
  await negative('wrong UID', x => { x.anchor.uid = ethers.ZeroHash; });
  await negative('wrong schema', x => { x.anchor.schemaUid = ethers.ZeroHash; }, 'INCOMPLETE_UNSUPPORTED');
  await negative('wrong digest data', async x => { x.anchor.attestationData = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [m.commitmentId, ethers.ZeroHash, ...Array(10).fill(''), 'issued', BigInt(now)]); await authorize(x.anchor); });
  const another = await anchor(ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [ethers.zeroPadValue('0xaa02', 32), digest32, ...Array(10).fill(''), 'issued', BigInt(now)]));
  await negative('REAL CONTRACT: anchor from another commitment', x => { x.anchor = another; });
  await negative('wrong attester', x => { x.anchor.attester = other.address; });
  await negative('wrong chain', x => { x.anchor.chainId = 8453; });
  await negative('unapproved EAS deployment', x => { x.anchor.easAddress = other.address; }, 'INCOMPLETE_UNSUPPORTED');
  await negative('missing anchor data', x => { delete x.anchor.attestationData; }, 'INCOMPLETE_UNSUPPORTED');
  await negative('modified descriptive data despite matching id/digest', async x => { const fields = ethers.AbiCoder.defaultAbiCoder().decode(av.TYPES, data).toArray(); fields[2] = 'modified'; x.anchor.attestationData = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, fields); await authorize(x.anchor); });
  await negative('missing party attester authority', x => { x.anchor.authorizations.pop(); });
  await negative('forged party attester authority', x => { x.anchor.authorizations[0].signature = x.anchor.authorizations[1].signature; });
  await negative('expired authority at creation', async x => { await authorize(x.anchor, String(now - 1)); });
  await negative('wrong block reference', x => { x.anchor.blockHash = ethers.ZeroHash; });
  await negative('wrong recipient', x => { x.anchor.recipient = buyer.address; });
  await negative('authority domain substitution', x => { x.anchor.authorizations[0].signature = exp.authorizations[0].signature; });
  const expiring = await anchor(data, { expirationTime: now + 800 });
  await negative('REAL CONTRACT: expiration disallowed by immutable anchor policy', x => { x.anchor = expiring; });
  // Irrevocable schema disallows revocable attestations in the actual contract.
  let revokeRejected = false;
  try { await (await eas.connect(attester).revoke({ schema: av.SCHEMA_UID, data: { uid: exp.anchor.uid, value: 0 } })).wait(); } catch (_) { revokeRejected = true; }
  check('REAL CONTRACT: immutable schema cannot be revoked', revokeRejected);
  const original = structuredClone(exp.anchor);
  mutateRpc = (q, r) => { if (q.method === 'eth_getTransactionReceipt' && r) r.status = '0x0'; return r; };
  await negative('MOCK RPC: reverted receipt rejected', () => {});
  mutateRpc = (q, r) => { if (q.method === 'eth_getTransactionReceipt' && r) r.logs = []; return r; };
  await negative('MOCK RPC: missing/mismatched Attested event', () => {});
  mutateRpc = (q, r) => { if (q.method === 'eth_getTransactionReceipt' && r) r.logs.forEach(l => { l.address = other.address; }); return r; };
  await negative('MOCK RPC: wrong event emitter', () => {});
  mutateRpc = (q, r) => { if (q.method === 'eth_call') throw new Error('archive state unavailable'); return r; };
  await negative('MOCK RPC: unavailable RPC capability incomplete', () => {}, 'INCOMPLETE_UNSUPPORTED');
  mutateRpc = null;
  mutateRpc = (q, r) => q.method === 'eth_getTransactionReceipt' ? null : r;
  await negative('MOCK RPC: missing receipt incomplete', () => {}, 'INCOMPLETE_UNSUPPORTED');
  mutateRpc = (q, r) => {
    if (q.method === 'eth_call' && q.params[0].data.startsWith(eas.interface.getFunction('getAttestation').selector)) {
      return ethers.AbiCoder.defaultAbiCoder().encode(['tuple(bytes32,bytes32,uint64,uint64,uint64,bytes32,address,address,bool,bytes)'], [[ethers.ZeroHash, ethers.ZeroHash, 0, 0, 0, ethers.ZeroHash, ethers.ZeroAddress, ethers.ZeroAddress, false, '0x']]);
    }
    return r;
  };
  await negative('MOCK RPC: missing attestation incomplete', () => {}, 'INCOMPLETE_UNSUPPORTED');
  mutateRpc = null;
  const tupleType = 'tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data)';
  for (const [field, value] of [['revocationTime', BigInt(now)], ['revocable', true], ['expirationTime', BigInt(now - 1)], ['refUID', '0x' + '12'.repeat(32)]]) {
    mutateRpc = (q, r) => {
      if (q.method === 'eth_call' && q.params[0].data.startsWith(eas.interface.getFunction('getAttestation').selector)) {
        const arr = ethers.AbiCoder.defaultAbiCoder().decode([tupleType], r)[0].toArray();
        const index = { revocationTime: 4, revocable: 8, expirationTime: 3, refUID: 5 }[field]; arr[index] = value;
        return ethers.AbiCoder.defaultAbiCoder().encode([tupleType], [arr]);
      }
      return r;
    };
    await negative('MOCK RPC: ' + field + ' invariant rejected', () => {});
  }
  mutateRpc = null;
  // Full lifecycle EOA control, separate from prior historical Safe evidence.
  await (await token.mint(buyer.address, 1000)).wait();
  await (await token.connect(buyer).approve(custody.target, 1000)).wait();
  const funded = await (await custody.connect(buyer).fund(m.commitmentId, digest32, token.target, buyer.address, seller.address, other.address, 1000, now + 1000, now + 2000, 0, 1, policyDigest, digest32)).wait();
  const verdict = await sig.signVerdict(other, { commitmentId: m.commitmentId, commitmentDigest: digest32, action: 'release', nonce: 1, issuedAt: now, verifyingContract: custody.target, chainId: 84532 });
  const settled = await (await custody.release(m.commitmentId, digest32, 1, now, verdict.v, verdict.r, verdict.s, '0x')).wait();
  const full = structuredClone(exp); full.lifecycleProfile = 'full';
  full.lifecycle = { funding: { txHash: funded.hash, blockHash: funded.blockHash }, settlement: { txHash: settled.hash, blockHash: settled.blockHash } };
  const fullResult = await verify(full);
  check('REAL CONTRACT: full lifecycle with independent anchor', fullResult.verdict === 'VERIFIED_WITH_LIMITATIONS' && !!fullResult.anchor, fullResult.reason);
  const missing = structuredClone(full); delete missing.anchor;
  const missingResult = await verify(missing);
  check('full lifecycle missing anchor incomplete', missingResult.verdict === 'INCOMPLETE_UNSUPPORTED', missingResult.reason);
  fs.writeFileSync(path.join(OUT, 'positive-export.json'), JSON.stringify(full, null, 2) + '\n');
  const childResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['verifier/verify-export.js', 'evidence/v4-anchor/positive-export.json', '--rpc', rpc], { cwd: ROOT, env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])) });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; }); child.on('error', reject); child.on('exit', code => resolve({ code, text }));
  });
  fs.writeFileSync(path.join(OUT, 'separate-process.txt'), childResult.text + '\nEXIT_CODE=' + childResult.code + '\n');
  check('separate-process CLI full export positive; no app DB/environment', childResult.code === 0 && childResult.text.includes('independent EAS anchor'), 'exit=' + childResult.code);
  check('child RPC read-only methods only', [...methods].every(x => allow.has(x)));
  // Frozen legacy dispatch output/exit regression; no Safe harness rerun.
  const oldPath = path.join(ROOT, 'verifier/.v4-anchor-baseline.cjs');
  fs.writeFileSync(oldPath, require('child_process').execFileSync('git', ['show', '5a3ba7dd:verifier/verify-export.js'], { cwd: ROOT, encoding: 'utf8' }));
  async function runLegacy(verifier, fixture) {
    return new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [verifier, fixture, '--rpc', 'http://127.0.0.1:9'], { cwd: ROOT, env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])) });
      let text = ''; c.stdout.on('data', b => { text += b; }); c.stderr.on('data', b => { text += b; }); c.on('error', reject); c.on('exit', code => resolve({ code, text: text.replace(/\.v4-anchor-baseline\.cjs/g, 'verify-export.js') }));
    });
  }
  try {
    for (const fixture of ['baseline-verified-commitment.json', 'baseline-v2-verified-commitment.json', 'baseline-v3-verified-commitment.json', 'v3-battery/fixture-full-lifecycle.json']) {
      const file = path.join(ROOT, 'evidence', fixture);
      const before = await runLegacy(oldPath, file), after = await runLegacy(path.join(ROOT, 'verifier/verify-export.js'), file);
      fs.writeFileSync(path.join(OUT, 'legacy-' + path.basename(fixture) + '.txt'), JSON.stringify({ before, after }, null, 2));
      check('legacy exact output/exit: ' + fixture, [0, 1].includes(before.code) && before.code === after.code && before.text === after.text, 'baseline=' + before.code + ', current=' + after.code);
    }
  } finally { fs.unlinkSync(oldPath); }
  const noRpc = await verifyV4(full);
  check('missing RPC incomplete', noRpc.verdict === 'INCOMPLETE_UNSUPPORTED');
  const summary = { baseline: '5a3ba7dd7e316255432b197d3fcaf67374c5a992', network: 'in-process Hardhat 84532 (NOT public Base Sepolia)', officialEasPackage: '1.7.1', realContractAndMockRpcCasesExplicitlyLabeled: true, policy: computedPolicy, results, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('anchor_passed=' + summary.passed + ' failed=' + summary.failed);
  await new Promise(r => server.close(r)); server = null;
  process.exitCode = summary.failed ? 1 : 0;
})().catch(e => { console.error(e.stack); if (server) server.close(); process.exitCode = 2; });
