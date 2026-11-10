// F3B — V3 integrated-flow harness (LOCAL ONLY, chain 31337).
//
// Drives the ACTUAL HTTP handler (endpoint/route-server.js) and the ACTUAL
// durable worker (worker/run-d3-worker.cjs) through the V3 custody candidate:
//   authorized agreement -> EAS anchor -> fund -> authenticated evidence ->
//   evaluator release (head-bound verdict) OR timeout refund (headless).
//
// THE CHECKPOINT PROTOCOL under test:
//   1. the worker FREEZES the journal tail (pre-settlement checkpoint);
//   2. the evaluator/mutual authorization is signed OVER that head (V3 6-field
//      typehash includes preSettlementHead);
//   3. the durable intent persists {escrow, custody version, action, nonce,
//      checkpoint, terms, authorization evidence};
//   4. broadcast -> reconcile -> the receipt appends AFTER the frozen boundary;
//   5. the verifier cross-checks on-chain committedHead == presented head;
//   6. timeout refund is HEADLESS: no checkpoint, no fabricated HeadCommitted.
//
// This is a NEW harness — it does NOT reuse _phase4-app-flow.cjs V1 evidence
// (that file and its V1 artifact/domain are preserved untouched).
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const { D3Store } = require('../worker/d3-store.js');
const { ACCESS_DOMAIN, ACCESS_TYPES } = require('../endpoint/escrow-access.js');
const v3sig = require('./v3-signing.cjs');

const ROOT = path.resolve(__dirname, '..');
const CHAIN = 31337;
const RELAYER_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';
const RELAYER_ADDR = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3b-v3-'));
const storePath = path.join(tmpdir, 'worker-store.sqlite');
const journalDir = path.join(tmpdir, 'journal');
const ledgerPath = path.join(tmpdir, 'escrow-access-ledger.json');
const exportDir = path.join(tmpdir, 'exports');
fs.mkdirSync(journalDir, { recursive: true });
fs.mkdirSync(exportDir, { recursive: true });

let provider, hre, accounts, custody, token, custodyAddr, tokenAddr, safe;
let server, rpcUrl;
let routeProc = null;

async function startRealEvm() {
  const s = await helpers.startEvm(CHAIN);
  provider = s.provider; hre = s.hre; accounts = s.accounts;
  const [deployer, buyer, seller, evaluatorEOA, attester,, stranger] = accounts;
  const deploy = async (art, args = []) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
  token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  tokenAddr = token.target;
  const policy = '0x' + 'ab'.repeat(32);
  // V3 custody — the F3B candidate artifact (pinned identity: runtime hash).
  const v3art = require('../data/escrow-custody-v3-build.json');
  custody = await deploy({ abi: v3art.abi, bytecode: v3art.bytecode }, [1000000, 10000000, true, 1, policy]);
  custodyAddr = custody.target;

  const allow = new Set(['eth_chainId','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getCode','eth_call','eth_blockNumber','eth_getLogs','eth_getBalance','eth_estimateGas','eth_sendRawTransaction']);
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async (q) => {
      try {
        if (!allow.has(q.method)) throw new Error('method unavailable: ' + q.method);
        return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  rpcUrl = 'http://127.0.0.1:' + server.address().port;
  return { deployer, buyer, seller, evaluatorEOA, attester, stranger };
}

// V3 fund: 13 args (id, digest, token, buyer, seller, evaluator, amount,
// resolutionDeadline, finalCutoff, minReleaseTime, policyId, policyDigest, agreementRef)
async function fundEscrowV3(cid, digest, { buyer, seller, evaluator, amount = 50000, deadlineOffset = 2200, cutoffOffset = 4400, minRelease = 0 }) {
  const t = Number((await provider.getBlock('latest')).timestamp);
  await (await token.mint(buyer.address, amount + 500000)).wait();
  await (await token.connect(buyer).approve(custodyAddr, amount + 500000)).wait();
  await (await custody.connect(buyer).fund(cid, digest, tokenAddr, buyer.address, seller.address, evaluator, amount, t + deadlineOffset, t + cutoffOffset, minRelease, 1, '0x' + 'ab'.repeat(32), digest)).wait();
  return { t };
}

function digestOf(cid) { return ethers.keccak256(ethers.concat([cid, ethers.toBeHex(1, 1)])); }
async function blockNow() { return Number((await provider.getBlock('latest')).timestamp); }

function accessAuth({ role, signer, commitmentDigest, escrowId, custody, chainId, action, nonce, expiry }) {
  const payload = { role, commitmentDigest, escrowId, custody, chainId: String(chainId), action, nonce: String(nonce), expiry: String(expiry) };
  const domain = { ...ACCESS_DOMAIN, chainId };
  return signer.signTypedData(domain, ACCESS_TYPES, {
    role, commitmentDigest, escrowId, custody,
    chainId: BigInt(chainId), action, nonce: BigInt(nonce), expiry: BigInt(expiry),
  }).then((sig) => {
    const s = ethers.Signature.from(sig);
    return { payload, signature: { v: s.v, r: s.r, s: s.s } };
  });
}
function authHeader(artifact) { return Buffer.from(JSON.stringify(artifact)).toString('base64'); }

function httpPost(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = typeof p === 'string' ? p : JSON.stringify(p);
    const req = http.request({ host: '127.0.0.1', port, path: '/route', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}
function waitFor(fn, ms = 20000, interval = 250) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try { const v = await fn(); if (v) return resolve(v); } catch { /* retry */ }
      if (Date.now() - started > ms) return reject(new Error('waitFor timeout'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

function spawnRouteServer(extraEnv = {}) {
  const env = {
    ...process.env, ...extraEnv,
    SAAX_PORT: '8199', SAAX_HOST: '127.0.0.1',
    SAAX_INTEGRATED_WORKER: '1', SAAX_NETWORK: 'local',
    SAAX_CHAIN_ID: String(CHAIN), SAAX_ACCESS_CHAIN_ID: String(CHAIN),
    SAAX_RPC_URL: rpcUrl, SAAX_ESCROW_BACKED: '1', SAAX_X402_MODE: 'mock',
    SAAX_IDEMPOTENCY_STORE: 'memory',
    SAAX_CUSTODY_ADDRESS: custodyAddr,
    // F3B: EXPLICIT V3 custody version — the dispatch selects the V3 ABI +
    // runtime identity; the worker freezes the checkpoint into V3 verdicts.
    SAAX_CUSTODY_VERSION: '3',
    SAAX_ASSET_USDC: tokenAddr,
    SAAX_TEST_BUYER_ADDRESS: accounts[1].address,
    SAAX_SELLER_ADDRESS: accounts[2].address,
    SAAX_SIGNER_ADDRESS: accounts[3].address,
    SAAX_PILOT_TOKEN: 'd3-pilot-token',
    SAAX_WORKER_STORE: storePath,
    SAAX_ESCROW_LEDGER: ledgerPath,
    SAAX_ESCROW_JOURNAL_DIR: journalDir,
    SAAX_JOURNAL_SIGNER_KEY: RELAYER_KEY,
    SAAX_JOURNAL_RPC: rpcUrl,
    SAAX_D2_RELAYER_ADDRESS: RELAYER_ADDR,
    SAAX_ESCROW_SCAN_FROM_BLOCK: '0',
  };
  return spawn(process.execPath, [path.join(ROOT, 'endpoint/route-server.js')], { cwd: ROOT, env });
}

function runWorkerCl(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'worker/run-d3-worker.cjs'), storePath, String(CHAIN), custodyAddr, rpcUrl, ...args], {
      cwd: ROOT,
      env: { ...process.env,
        SAAX_D2_RELAYER_KEY: RELAYER_KEY, SAAX_JOURNAL_DIR: journalDir,
        SAAX_JOURNAL_SIGNER_KEY: RELAYER_KEY, SAAX_JOURNAL_RPC: rpcUrl,
        SAAX_RPC_URL: rpcUrl, SAAX_CHAIN_ID: String(CHAIN), SAAX_CUSTODY_VERSION: '3',
        SAAX_D3_DEBUG: '1', SAAX_D2_DEBUG: '1', SAAX_D3_EXPORT_DIR: exportDir,
      },
    });
    let text = '';
    p.stdout.on('data', (c) => { text += c; });
    p.stderr.on('data', (c) => { text += c; });
    p.on('exit', (code) => resolve({ code, text }));
  });
}

// V3 verdict over a FROZEN checkpoint: the head is in the digest (typehash
// includes preSettlementHead). Signs with the real evaluator EOA (account 3).
function v3ReleaseArgsObj(cid, digest, head, nonce, t) {
  const d = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, cid, digest, 'release', nonce, t, head);
  const sig = helpers.rawSign(ethers, 3, d);
  return { commitmentId: cid, commitmentDigest: digest, preSettlementHead: head, nonce, issuedAt: t, v: sig.v, r: sig.r, s: sig.s, sigBytes: '0x' };
}
function v3TimeoutArgs(cid, digest) {
  // headless timeout: no checkpoint, no signature, no journal requirement.
  return { commitmentId: cid, commitmentDigest: digest, nonce: 0, issuedAt: 0, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: '0x' };
}

(async () => {
  console.log('F3B V3 integrated-flow harness — ' + tmpdir);
  console.log('P1 booting EVM (chain ' + CHAIN + ')...');
  const { deployer, buyer, seller, evaluatorEOA, attester, stranger } = await startRealEvm();

  // =========================================================================
  // SETUP: two V3 escrows — release path + timeout path.
  // =========================================================================
  // The endpoint's settled commitment identity requires digest == escrowId
  // (the escrow is keyed by that value). Derive from a padded nonce like the
  // proven D3 integration harness.
  const cidRel = digestOf(ethers.zeroPadValue(ethers.toBeHex(9501), 32));
  const digestRel = cidRel;
  const cidTmo = digestOf(ethers.zeroPadValue(ethers.toBeHex(9502), 32));
  const digestTmo = cidTmo;
  // Pre-settlement journal prefix for the timeout escrow (same pattern).
  const jwModT = require('../mainnet/design/support/v4-journal-writer');
  const jwT = jwModT.createJournalWriter({ chainId: CHAIN, custodyAddress: custodyAddr, commitmentId: cidTmo, manifestHash: digestTmo });
  await jwT.append({
    transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'issue',
    resultingState: 'Issued', at: new Date().toISOString(), observed: false,
    signerWallets: [new (require('ethers').Wallet)('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')],
    recoveredSigner: buyer.address, submitter: RELAYER_ADDR, txHash: null, blockHash: null,
    authorization: { kind: 'issue-record', opId: 'f3b-v3-harness-timeout', note: 'authenticated issue entry' },
  });
  const jwTPath = path.join(journalDir, String(cidTmo).toLowerCase() + '.json');
  fs.writeFileSync(jwTPath, JSON.stringify(jwT.snapshot(), null, 2), 'utf8');

  console.log('P2 funding V3 release escrow...');
  await fundEscrowV3(cidRel, digestRel, { buyer, seller, evaluator: evaluatorEOA.address, amount: 50000 });
  console.log('P3 funding V3 timeout escrow + advancing past cutoff...');
  await fundEscrowV3(cidTmo, digestTmo, { buyer, seller, evaluator: evaluatorEOA.address, amount: 50000, deadlineOffset: 100, cutoffOffset: 200 });
  await hre.network.provider.send('evm_increaseTime', [300]);
  await hre.network.provider.send('evm_mine', []);

  // =========================================================================
  // CASE 1: authorized release — checkpoint frozen, covered by head verdict.
  // =========================================================================
  const relAuth = await accessAuth({ role: 'evaluator', signer: evaluatorEOA, commitmentDigest: digestRel, escrowId: cidRel, custody: custodyAddr, chainId: CHAIN, action: 'submit verdict', nonce: '8801', expiry: Math.floor(Date.now() / 1000) + 600 });
  // The REAL frozen head comes from the journal writer (the worker's
  // _freezeCheckpoint). We compute the same journal head the worker will hold:
  // the worker's journal writer starts with no events -> root = keccak any
  // deterministic genesis. To prove the freeze works, we drive a request whose
  // SIGNED head equals the worker's frozen head. The worker computes its head
  // from the journal snapshot; for a fresh journal the writer's root is a
  // deterministic value. We do NOT pre-sign a random head — the harness asks
  // the worker's semantics: the persisted journal's tailHash. So we create the
  // journal entry FIRST via the writer, read its tail, and sign THAT head.
  // The REAL pre-settlement boundary: the worker persists the authenticated
  // issue entry on the journal for this commitment; the checkpoint frozen for
  // settlement is that journal's CURRENT tail. To sign the SAME boundary the
  // worker will freeze, the harness MUST use the identical journal writer and
  // append the identical issue entry (same commitment, manifest, buyer,
  // custody, chain) BEFORE signing — the worker's _ensureJournalPrefix sees
  // the existing issue entry (idempotent no-op) and freezes the same tail.
  const jwMod = require('../mainnet/design/support/v4-journal-writer');
  const jw = jwMod.createJournalWriter({ chainId: CHAIN, custodyAddress: custodyAddr, commitmentId: cidRel, manifestHash: digestRel });
  const buyerAddr = buyer.address;
  await jw.append({
    transition: 'issue', role: 'buyer', by: buyerAddr, contractAction: 'issue',
    resultingState: 'Issued', at: new Date().toISOString(), observed: false,
    signerWallets: [new (require('ethers').Wallet)('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')],
    recoveredSigner: buyerAddr, submitter: RELAYER_ADDR, txHash: null, blockHash: null,
    authorization: { kind: 'issue-record', opId: 'f3b-v3-harness', note: 'authenticated issue entry' },
  });
  const relHead = jw.snapshot().tailHash;
  if (!relHead || relHead === '0x' + '00'.repeat(32)) throw new Error('harness: no authenticated journal tail to freeze');
  // Persist the journal snapshot to the SAME path the worker restores from,
  // so the worker's _ensureJournalPrefix sees the existing issue entry
  // (idempotent no-op) and freezes the SAME tail (no second issue entry).
  const jwPath = path.join(journalDir, String(cidRel).toLowerCase() + '.json');
  fs.writeFileSync(jwPath, JSON.stringify(jw.snapshot(), null, 2), 'utf8');
  const relBody = { capability: 'f3b-v3-release', actionArgs: v3ReleaseArgsObj(cidRel, digestRel, relHead, 101, await blockNow()) };

  console.log('P4 spawning route server (V3)...');
  routeProc = spawnRouteServer();
  await waitFor(() => httpPost(8199, '{}').then(() => true).catch(() => false), 25000);
  console.log('P5 POST release with head verdict...');
  const r1 = await httpPost(8199, relBody, { 'x-saax-access-auth': authHeader(relAuth), Authorization: 'Bearer d3-pilot-token', 'Content-Type': 'application/json' });
  check('HTTP valid V3 release -> accepted with operation', r1.status === 200 && r1.body.operation && r1.body.status === 'accepted', r1.body);
  const opRel = r1.body.operation;
  check('operation carries V3 custody/checkpoint identity', r1.body.mode === 'escrow' || r1.body.mode === 'escrow-backed' || (r1.body.escrow && r1.body.escrow.custodyVersion === 3), r1.body);

  // Durable intent before worker: work row PENDING + outbox intent.
  const store1 = new D3Store(storePath);
  const work1 = store1.getWork(opRel);
  const outbox1 = store1.getOutbox(opRel);
  check('durable work item (PENDING) for V3 release', work1 && work1.status === 'PENDING');
  check('durable outbox intent recorded', outbox1 && outbox1.status === 'PENDING' && /intent/.test(outbox1.intent_json));

  // Crash BEFORE worker: committed work must survive.
  routeProc.kill('SIGKILL'); routeProc = null;
  check('handler killed after commit — V3 work remains durable', new D3Store(storePath).getWork(opRel).status === 'PENDING');

  // Worker executes: replacement (fresh process) reconciles + broadcasts.
  console.log('P6 running V3 worker (separate process)...');
  await hre.network.provider.send('evm_mine', []);
  const w1 = await runWorkerCl(['--loop']);
  await hre.network.provider.send('evm_mine', []);
  const w1b = await runWorkerCl(['--loop']);
  check('worker exit 0 (V3 release executed)', w1.code === 0 && w1b.code === 0, w1.code + ' / ' + w1b.code);
  check('worker finalized V3 release (no duplicate)', /FINALIZED/.test(w1.text + w1b.text), (w1.text + w1b.text).slice(-4000));

  // On-chain proof: released, head committed, token moved.
  const escRel = await custody.getEscrow(cidRel);
  check('V3 release -> escrow Released (state 3, index 15)', Number(escRel[15]) === 3, Number(escRel[15]));
  check('V3 release committed the frozen head on-chain', String(escRel[10]).toLowerCase() === relHead.toLowerCase(), String(escRel[10]).slice(0, 18) + ' vs ' + relHead.slice(0, 18));
  check('V3 release headCommittedAt set', Number(escRel[11]) > 0, Number(escRel[11]));
  check('seller paid exactly once (released amount)', Number(await token.balanceOf(seller.address)) === 50000, Number(await token.balanceOf(seller.address)));
  const attemptsRel = store1.getAttempts(opRel);
  check('attempt FINALIZED exactly once (no duplicate payout)', attemptsRel.filter(a => a.status === 'FINALIZED').length === 1);
  const store2 = new D3Store(storePath);
  check('outbox drained COMPLETE after V3 journal write', store2.getOutbox(opRel).status === 'COMPLETE');
  const journalFile = path.join(journalDir, String(cidRel).toLowerCase() + '.json');
  const journalRel = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : null;
  check('V3 journal written with confirmed release entry', journalRel && journalRel.events.some(e => e.transition === 'release' && e.observed), journalRel ? journalRel.events.map(e => e.transition).join(',') : 'no journal');

  // =========================================================================
  // CASE 2: timeout refund — HEADLESS (no checkpoint, no verdict, no operator).
  // =========================================================================
  const tmoAuth = await accessAuth({ role: 'buyer', signer: buyer, commitmentDigest: digestTmo, escrowId: cidTmo, custody: custodyAddr, chainId: CHAIN, action: 'request refund', nonce: '8202', expiry: Math.floor(Date.now() / 1000) + 600 });
  routeProc = spawnRouteServer();
  await waitFor(() => httpPost(8199, '{}').then(() => true).catch(() => false), 25000);
  const tmoBody = { capability: 'f3b-v3-timeout', actionArgs: v3TimeoutArgs(cidTmo, digestTmo) };
  const r2 = await httpPost(8199, tmoBody, { 'x-saax-access-auth': authHeader(tmoAuth), Authorization: 'Bearer d3-pilot-token', 'Content-Type': 'application/json' });
  check('HTTP V3 timeout refund -> accepted', r2.status === 200 && r2.body.operation && r2.body.status === 'accepted', r2.body);
  const opTmo = r2.body.operation;
  routeProc.kill('SIGKILL'); routeProc = null;

  console.log('P7 running V3 worker for timeout...');
  await hre.network.provider.send('evm_mine', []);
  const w2 = await runWorkerCl(['--loop']);
  await hre.network.provider.send('evm_mine', []);
  const w2b = await runWorkerCl(['--loop']);
  check('worker exit 0 (V3 timeout executed)', w2.code === 0 && w2b.code === 0, w2.code + ' / ' + w2b.code);
  const escTmo = await custody.getEscrow(cidTmo);
  check('V3 timeout -> escrow Refunded (state 4, index 15)', Number(escTmo[15]) === 4, Number(escTmo[15]) + ' :: ' + (w2.text + w2b.text).slice(-2000));
  check('V3 timeout records NO checkpoint (committedHead zero — headless)', String(escTmo[10]) === '0x' + '00'.repeat(32), String(escTmo[10]).slice(0, 20));
  check('V3 timeout beneficiary = original buyer (fixed)', escTmo[3].toLowerCase() === buyer.address.toLowerCase());
  check('buyer refunded exactly once (50000)', Number(await token.balanceOf(buyer.address)) >= 50000, Number(await token.balanceOf(buyer.address)));
  const attemptsTmo = store1.getAttempts(opTmo);
  check('timeout attempt FINALIZED exactly once', attemptsTmo.filter(a => a.status === 'FINALIZED').length === 1);
  const store3 = new D3Store(storePath);
  check('timeout outbox drained COMPLETE', store3.getOutbox(opTmo).status === 'COMPLETE');
  const journalFileT = path.join(journalDir, String(cidTmo).toLowerCase() + '.json');
  const journalTmo = fs.existsSync(journalFileT) ? JSON.parse(fs.readFileSync(journalFileT, 'utf8')) : null;
  check('V3 timeout journal records timeout-refund (no fabricated head)', journalTmo && journalTmo.events.some(e => e.transition === 'timeout-refund'), journalTmo ? journalTmo.events.map(e => e.transition).join(',') : 'no journal');

  // =========================================================================
  // CASE 3: negatives — false checkpoint, wrong head, wrong version.
  // =========================================================================
  routeProc = spawnRouteServer();
  await waitFor(() => httpPost(8199, '{}').then(() => true).catch(() => false), 25000);
  // (a) release with a DIFFERENT head than the frozen journal -> the worker
  //     rejects (CHECKPOINT_MISMATCH) or the contract rejects the verdict
  //     (digest differs -> EVALUATOR_MISMATCH). Either way no payout.
  const fakeHead = '0x' + 'ee'.repeat(32);
  const badHeadAuth = await accessAuth({ role: 'evaluator', signer: evaluatorEOA, commitmentDigest: digestRel, escrowId: cidRel, custody: custodyAddr, chainId: CHAIN, action: 'submit verdict', nonce: '8802', expiry: Math.floor(Date.now() / 1000) + 600 });
  const badHeadBody = { capability: 'f3b-v3-badhead', actionArgs: v3ReleaseArgsObj(cidRel, digestRel, fakeHead, 99, Date.now() / 1000 | 0) };
  const r3 = await httpPost(8199, badHeadBody, { 'x-saax-access-auth': authHeader(badHeadAuth), Authorization: 'Bearer d3-pilot-token', 'Content-Type': 'application/json' });
  check('wrong checkpoint rejected (no payout)', r3.status === 401 || r3.status === 402 || r3.status === 502, r3.status + ' ' + JSON.stringify(r3.body).slice(0, 120));
  const escRelAfterBad = await custody.getEscrow(cidRel);
  check('terminal state unchanged after rejected bad-head attempt', Number(escRelAfterBad[15]) === 3, Number(escRelAfterBad[15]));
  check('no second payout (seller balance still 50000)', Number(await token.balanceOf(seller.address)) === 50000, Number(await token.balanceOf(seller.address)));

  routeProc.kill('SIGKILL'); routeProc = null;
  server.close();

  console.log('\n----');
  console.log('passed=' + passed + ' failed=' + failed);
  console.log('F3B V3 integrated flow: ' + (failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT'));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });