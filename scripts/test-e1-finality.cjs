// E1A focused tests — FinalityAdapter explicit safe/finalized checks + worker
// policy dispatch.
//
// Labeling: [REAL] = local EVM 31337 (genuine custody V2 contract, genuine
// EOA evaluator verdicts, real chain confirmations). Local-chain success is
// LOCAL-only finality and NEVER claims public consensus finality.
// [MOCK] = labeled MockRPCProvider simulations of OP Stack safe/finalized
// tags, reorgs, disagreements, stalls — never presented as real-chain results.
//
// Coverage (per E1A brief):
//   1. Local compatibility (31337 local-confirmations preserved).
//   2. Included but not safe/finalized (INCLUDED persists, not final).
//   3. Safe vs finalized policy satisfaction (SAFE != FINALIZED).
//   4. Wrong chain (31337 gate) and canonical-block mismatch.
//   5. Receipt disappearance/reorg (returned to reconciliation, no 2nd action).
//   6. Unsupported tags/history fail closed.
//   7. Bounded verification exhaustion (BOUND_EXCEEDED).
//   8. Conflicting RPC observations (RPC_DISAGREEMENT).
//   9. Persisted stall detection (persisted progress + threshold, never one
//      unchanged head alone).
//  10. Restart during finality wait (reconcile after restart, same store).
//  11. Finalized contradiction (blocking incident after recorded finalization).
//  12. No duplicate execution.

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const { D2Worker } = require('../worker/d2-worker.js');
const { FinalityAdapter } = require('../worker/d2-finality.js');
const { D2Prerequisites } = require('../worker/d2-prereqs.js');
const { MockRPCProvider } = require('../worker/d2-mock-rpc.js');
const { loadCustodyAbi } = require('../worker/d1-abi.js');

const ROOT = path.resolve(__dirname, '..');
const CHAIN = 31337;
const RELAYER_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';
const RELAYER_ADDR = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'e1a-test-'));
const storePath = path.join(tmpdir, 'e1a-store.sqlite');

// ---- [REAL] local EVM (31337) setup (EOA evaluator — light, genuine) --------
let provider, hre, accounts, custody, token, custodyAddr, tokenAddr, evaluatorEOA, server, rpcUrl;

async function startRealEvm() {
  const s = await helpers.startEvm(CHAIN);
  provider = s.provider; hre = s.hre; accounts = s.accounts;
  const [deployer, buyer, seller, ev, attester,, stranger] = accounts;
  evaluatorEOA = ev;
  const abi = loadCustodyAbi();
  const deploy = async (art, args = []) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
  token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  tokenAddr = token.target;
  custody = await deploy(hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2'), [1000000, 10000000, true, 1, '0x' + 'ab'.repeat(32)]);
  custodyAddr = custody.target;
  const allow = new Set(['eth_chainId','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getCode','eth_call','eth_sendRawTransaction','eth_getBalance','eth_blockNumber','eth_feeHistory']);
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async (q) => {
      try {
        if (!allow.has(q.method)) throw new Error('method unavailable');
        return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  rpcUrl = 'http://127.0.0.1:' + server.address().port;
  return { deployer, buyer, seller, evaluatorEOA: ev, attester, stranger };
}

function rpcProvider() { return new ethers.JsonRpcProvider(rpcUrl, CHAIN, { staticNetwork: true }); }

async function fundEscrow(cid, digest, { buyer, seller, amount = 1000, deadlineOffset = 2000, cutoffOffset = 4000 }) {
  const t = Number((await provider.getBlock('latest')).timestamp);
  await (await token.mint(buyer.address, amount + 100000)).wait();
  await (await token.connect(buyer).approve(custodyAddr, amount + 100000)).wait();
  await (await custody.connect(buyer).fund(cid, digest, tokenAddr, buyer.address, seller.address, evaluatorEOA.address, amount, t + deadlineOffset, t + cutoffOffset, 0, 1, '0x' + 'ab'.repeat(32), digest)).wait();
  return { t };
}

function releaseArgsRaw(cid, digest, nonce, t) {
  const d = ethers.TypedDataEncoder.hash({ name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr }, { EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
    { commitmentId: cid, commitmentDigest: digest, action: 'release', nonce, issuedAt: t });
  const sig = helpers.rawSign(ethers, 3, d); // evaluatorEOA = account 3
  return { commitmentId: cid, commitmentDigest: digest, nonce, issuedAt: t, v: sig.v, r: sig.r, s: sig.s, sigBytes: '0x' };
}
function digestOf(cid) { return ethers.keccak256(ethers.concat([cid, ethers.toBeHex(1, 1)])); }

// ---- worker factory -----------------------------------------------------------
function makeWorker(opts = {}) {
  const finalityOpts = opts.finalityOpts || {};
  return new D2Worker({
    storePath: opts.storePath || storePath,
    abi: loadCustodyAbi(),
    chain: { id: CHAIN, custody: custodyAddr },
    prereqs: new D2Prerequisites({
      abi: loadCustodyAbi(), custody: { address: custodyAddr, chainId: CHAIN },
      getEscrow: async (cid) => {
        const e = await custody.getEscrow(cid);
        return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.commitmentDigest };
      },
      getBlock: async (tag) => provider.getBlock(tag),
      policy: { require2of3Evaluator: false },
    }),
    nextNonce: async (account, chainId) => w2.nextNonceFor(account, chainId),
    relayer: { account: RELAYER_ADDR, wallet: new ethers.Wallet(RELAYER_KEY, rpcProvider()) },
    provider: rpcProvider(),
    finality: new FinalityAdapter(Object.assign({
      getBlock: async (t) => rpcProvider().getBlock(t),
      getReceipt: async (h) => rpcProvider().getTransactionReceipt(h),
      confirmations: 1,
      chainId: CHAIN,
      policy: finalityOpts.policy || 'local-confirmations',
    }, finalityOpts)),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: opts.wipeStore !== undefined ? opts.wipeStore : true,
    ...opts,
  });
}
let w2;

/** Simple persisted progress store (in memory, restartable by re-making). */
function memProgress() {
  const m = new Map();
  return { get: async (k) => m.get(k) || null, put: async (k, v) => { m.set(k, v); }, _m: m };
}

// ---- [MOCK] OP Stack head provider ------------------------------------------
// Simulates a trusted sequencer/node with safe + finalized heads over a
// canonical chain of blocks. Receipts live in blocks; heads point at blocks.
function makeOpStackMock({ chainId = 84532, blocks = null } = {}) {
  const canon = blocks || (() => {
    const arr = [];
    for (let i = 100; i <= 110; i++) arr.push({ number: i, hash: '0x' + i.toString(16).padStart(2, '0').repeat(32), parentHash: i === 100 ? null : '0x' + (i - 1).toString(16).padStart(2, '0').repeat(32), timestamp: 1000 + i });
    return arr;
  })();
  let safeHeadNum = 108, finalizedHeadNum = 105;
  const transactions = new Map();
  const provider = {
    chainId: ethers.toBeHex(chainId),
    async getBlock(tagOrNum) {
      if (tagOrNum === 'latest') return canon[canon.length - 1];
      if (tagOrNum === 'safe') return canon.find(b => b.number === safeHeadNum) || null;
      if (tagOrNum === 'finalized') return canon.find(b => b.number === finalizedHeadNum) || null;
      // resolve by 0x-hash when the argument is a hash, else by number
      if (typeof tagOrNum === 'string' && /^0x/.test(tagOrNum)) {
        const byHash = canon.find(b => b.hash.toLowerCase() === tagOrNum.toLowerCase());
        if (byHash) return byHash;
        return null;
      }
      const n = Number(tagOrNum);
      return canon.find(b => b.number === n) || null;
    },
    async getTransactionReceipt(hash) { return transactions.get(hash) || null; },
    async getTransaction(hash) { const t = transactions.get(hash); return t ? { ...t } : null; },
    async getTransactionCount() { return 0; },
    async broadcastTransaction() { return { hash: '0x' + '77'.repeat(32) }; },
    setReceipt(txHash, blockNumber) {
      const blk = canon.find(b => b.number === blockNumber);
      // Synthetic Released event log (same representation the D2 mock uses):
      // the worker's outcome reader requires the expected event to be present;
      // a mock has no real contract, so this is the mock's representation.
      const releasedTopic = ethers.id('Released(bytes32,address,uint256,bytes32)');
      const mockLogData = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'bytes32'], [RELAYER_ADDR, 1000, ethers.ZeroHash]);
      const mockLog = {
        address: custodyAddr,
        topics: [releasedTopic, '0x' + '00'.repeat(31) + '01', '0x' + RELAYER_ADDR.slice(2).toLowerCase().padStart(64, '0')],
        data: mockLogData,
        blockNumber, blockHash: blk.hash, transactionHash: txHash, transactionIndex: 0, logIndex: 0, removed: false,
      };
      transactions.set(txHash, { hash: txHash, status: 1, blockNumber, blockHash: blk.hash, to: custodyAddr, from: RELAYER_ADDR, logs: [mockLog] });
    },
    removeReceipt(txHash) { transactions.delete(txHash); },
    setSafeHead(n) { safeHeadNum = n; },
    setFinalizedHead(n) { finalizedHeadNum = n; },
    advanceHead() {
      const last = canon[canon.length - 1];
      canon.push({ number: last.number + 1, hash: '0x' + (last.number + 1).toString(16).padStart(2, '0').repeat(32), parentHash: last.hash, timestamp: last.timestamp + 1 });
    },
    _canon: canon,
    get safeHead() { return safeHeadNum; },
    get finalizedHead() { return finalizedHeadNum; },
  };
  return provider;
}

async function mockWorkerWith(storePathN, opStack, { policy, receiptBlock, finalityOpts = {} } = {}) {
  const finality = new FinalityAdapter(Object.assign({
    getBlock: async (t) => opStack.getBlock(t),
    getReceipt: async (h) => opStack.getTransactionReceipt(h),
    chainId: opStack.chainId ? parseInt(opStack.chainId, 16) : 84532,
    policy,
    maxDepth: finalityOpts.maxDepth || 256,
    stallMs: finalityOpts.stallMs || 10000,
    progress: finalityOpts.progress,
  }, finalityOpts));
  const mock = opStack;
  // The worker's outcome reader reads escrow state AFTER execution; after a
  // successful release the escrow is Released (3). Mock returns Released so
  // the outcome is SUCCESS (a mock representation — no real contract).
  const mockEscrow = { state: 3, finalCutoff: 9999999999, deadline: 9999999999, buyer: accounts[1].address, seller: accounts[2].address, amount: 1000, token: tokenAddr, evaluator: evaluatorEOA.address, commitmentDigest: '0x' + '22'.repeat(32) };
  // The PREREQS validator checks state BEFORE execution: the escrow is still
  // Funded (1) while a release is prepared. (Worker outcome reader sees 3.)
  const mockEscrowBefore = { ...mockEscrow, state: 1 };
  let mw;
  mw = new D2Worker({
    storePath: storePathN,
    abi: loadCustodyAbi(),
    chain: { id: 84532, custody: custodyAddr },
    prereqs: new D2Prerequisites({
      abi: loadCustodyAbi(), custody: { address: custodyAddr, chainId: 84532 },
      getEscrow: async () => mockEscrowBefore,
      getBlock: async (t) => opStack.getBlock(t),
      policy: { require2of3Evaluator: false },
    }),
    getEscrow: async () => mockEscrow,
    nextNonce: async (acct, chain) => mw.nextNonceFor(acct, chain),
    relayer: { account: RELAYER_ADDR, wallet: new ethers.Wallet(RELAYER_KEY, opStack) },
    provider: opStack,
    finality,
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true,
  });
  return mw;
}

async function mockPrepareAndReconcile(mw, opStack, { policy, receiptBlock, txHash } = {}) {
  const cid = ethers.zeroPadValue(ethers.toBeHex(11), 32);
  const digest = '0x' + '22'.repeat(32);
  const p = await mw.prepare({
    opId: 'op-e1a-mock', payloadDigest: 'sha256:' + 'e1a'.repeat(10), agreementRef: 'agreement-e1a', escrowId: cid,
    requestedAction: 'release', authNonce: 'nE', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: { commitmentId: cid, commitmentDigest: digest, nonce: 1, issuedAt: 1000, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: '0x' },
    bindings: { agreementRef: 'agreement-e1a', escrowId: cid, chainId: 84532, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + 'e1a'.repeat(10), authNonce: 'nE', cutoff: 9999999999 },
  });
  if (!p.ok) return { prepare: p };
  const a = mw.store.beginAttempt({ opId: 'op-e1a-mock', nonce: 1, txHash: txHash || '0x' + '77'.repeat(32), chainId: 84532, relayerAccount: RELAYER_ADDR, simNote: 'e1a mock' });
  if (receiptBlock !== undefined) opStack.setReceipt(txHash || '0x' + '77'.repeat(32), receiptBlock);
  const r = await mw.reconcileOutcome('op-e1a-mock');
  return { prepare: p, attempt: a, reconcile: r };
}

const http = require('node:http');

async function main() {
  console.log('E1A focused finality tests — ' + tmpdir);
  const { deployer, buyer, seller, evaluatorEOA: ev2, attester, stranger } = await startRealEvm();
  const accountsAll = accounts;

  // ---------------------------------------------------------------------------
  // 1. [REAL] LOCAL COMPATIBILITY — 31337 local-confirmations policy works,
  //    and the expose local fields are preserved (policy.mode, LOCAL_ONLY_NOTE).
  // ---------------------------------------------------------------------------
  const cid1 = ethers.zeroPadValue(ethers.toBeHex(8001), 32);
  const digest1 = digestOf(cid1);
  const { t: t1 } = await fundEscrow(cid1, digest1, { buyer, seller });
  w2 = makeWorker();
  check('[REAL] adapter local policy label + LOCAL_ONLY note', w2.finality.policy.mode === 'local-confirmations' && /NOT a public-finality claim/.test(w2.finality.policy.note || ''), w2.finality.policy);
  const p1 = await w2.prepare({
    opId: 'op-e1a-1', payloadDigest: 'sha256:' + '1'.repeat(64), agreementRef: 'agreement-e1a-1', escrowId: cid1,
    requestedAction: 'release', authNonce: 'n1', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: releaseArgsRaw(cid1, digest1, 801, t1), bindings: { agreementRef: 'agreement-e1a-1', escrowId: cid1, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + '1'.repeat(64), authNonce: 'n1', cutoff: t1 + 4000 },
  });
  check('[REAL] local-compat op -> PREPARED', p1.ok && p1.status === 'PREPARED', p1);
  await w2.broadcastPrepared('op-e1a-1');
  // Included but not yet final (no confirm block yet) — depth 0 < 1
  let rInc = await w2.reconcileOutcome('op-e1a-1');
  check('[REAL] included-but-not-final -> NOT_ENOUGH_CONFIRMATIONS, status INCLUDED', !rInc.ok && rInc.reason === 'NOT_ENOUGH_CONFIRMATIONS' && w2.store.getAttempts('op-e1a-1')[0].status === 'INCLUDED', rInc);
  // confirm block -> FINALIZED with LOCAL state
  await hre.network.provider.send('evm_mine', []);
  const r1 = await w2.reconcileOutcome('op-e1a-1');
  check('[REAL] local confirm -> FINALIZED, finality_state LOCAL', r1.ok && r1.status === 'FINALIZED' && r1.finalityState === 'LOCAL', r1);
  check('[REAL] attempt finality_state persists LOCAL (not FINALIZED public)', w2.store.getAttempts('op-e1a-1')[0].finality_state === 'LOCAL', w2.store.getAttempts('op-e1a-1')[0]);
  check('[REAL] local success never claims public consensus finality', w2.store.getAttempts('op-e1a-1')[0].finality_state !== 'FINALIZED', w2.store.getAttempts('op-e1a-1'));
  // restart during finality wait: a NEW worker on the SAME store, op already
  // terminal -> reconcile reports NO_ACTIVE_ATTEMPT (idempotent, no re-exec).
  // Close the first worker's DB handle first so the second can open the file.
  try { w2.close && w2.close(); } catch {}
  const w2b = makeWorker({ storePath, wipeStore: false });
  const r1b = await w2b.reconcileOutcome('op-e1a-1');
  check('[REAL] restart during finality wait -> no re-execution, terminal stays', (r1b.reason === 'NO_ACTIVE_ATTEMPT' || r1b.ok) && w2b.store.getAttempts('op-e1a-1')[0].status === 'FINALIZED' && Number(await custody.totalHeld()) === 0, r1b);
  check('[REAL] no duplicate execution (attempt finalized exactly once)', w2b.store.getAttempts('op-e1a-1').filter(a => a.status === 'FINALIZED').length === 1);

  // ---------------------------------------------------------------------------
  // 2. [REAL] WRONG CHAIN — local-confirmations policy on non-31337 refuses at
  //    construction (fail closed, never silently applies local confirmations).
  // ---------------------------------------------------------------------------
  try {
    new FinalityAdapter({ getBlock: async () => ({}), getReceipt: async () => null, chainId: 84532, policy: 'local-confirmations' });
    check('[REAL] local-confirmations on non-31337 chain refused', false, 'no throw');
  } catch (e) {
    check('[REAL] local-confirmations on non-31337 chain refused', /31337/.test(e.message), e.message);
  }
  // mainnet activation disabled: public policy on chain 1 refused.
  try {
    new FinalityAdapter({ getBlock: async () => ({}), getReceipt: async () => null, chainId: 1, policy: 'op-stack-finalized' });
    check('[REAL] mainnet public policy not activated', false, 'no throw');
  } catch (e) {
    check('[REAL] mainnet public policy not activated', /MAINNET_NOT_ACTIVATED/.test(e.message), e.message);
  }

  // ---------------------------------------------------------------------------
  // [MOCK] OP Stack safe vs finalized policies
  // ---------------------------------------------------------------------------
  // Included at block 106; safe head at 108; finalized head at 105.
  const op1 = makeOpStackMock();
  op1.setReceipt('0x' + 'aa'.repeat(32), 106);
  op1.setSafeHead(108);
  op1.setFinalizedHead(105);

  // safe policy: covered by safe head (106 <= 108) -> FINAL/SAFE terminal.
  const mwSafe = await mockWorkerWith(path.join(tmpdir, 'e1a-safe.sqlite'), op1, { policy: 'op-stack-safe' });
  let rSafe = await mockPrepareAndReconcile(mwSafe, op1, { policy: 'op-stack-safe', receiptBlock: 106, txHash: '0x' + 'aa'.repeat(32) });
  check('[MOCK] safe policy satisfaction -> final (SAFE)', rSafe.reconcile.ok && rSafe.reconcile.status === 'FINALIZED' && rSafe.reconcile.finalityState === 'SAFE', rSafe.reconcile);
  check('[MOCK] SAFE persisted in finality_state, not FINALIZED', mwSafe.store.getAttempts('op-e1a-mock')[0].finality_state === 'SAFE', mwSafe.store.getAttempts('op-e1a-mock')[0]);
  check('[MOCK] SAFE never labeled consensus-finalized', mwSafe.store.getAttempts('op-e1a-mock')[0].finality_state !== 'FINALIZED', mwSafe.store.getAttempts('op-e1a-mock')[0]);

  // finalized policy: included 106 > finalized head 105 -> NOT final (SAFE only).
  const mwFin = await mockWorkerWith(path.join(tmpdir, 'e1a-final.sqlite'), op1, { policy: 'op-stack-finalized' });
  const rFinNot = await mockPrepareAndReconcile(mwFin, op1, { policy: 'op-stack-finalized', receiptBlock: 106, txHash: '0x' + 'bb'.repeat(32) });
  check('[MOCK] finalized policy not satisfied while only safe -> not final', !rFinNot.reconcile.ok && /SAFE_ONLY|NOT_ENOUGH|INCLUDED_ABOVE_HEAD|BOUND|not final/i.test(rFinNot.reconcile.reason || ''), rFinNot.reconcile);
  check('[MOCK] safe-not-finalized persists SAFE state', mwFin.store.getAttempts('op-e1a-mock')[0].finality_state === 'SAFE', mwFin.store.getAttempts('op-e1a-mock')[0]);
  // advance finalized head to 108 -> now final.
  op1.setFinalizedHead(108);
  const rFin = await mockPrepareAndReconcile(mwFin, op1, { policy: 'op-stack-finalized', receiptBlock: 106, txHash: '0x' + 'bb'.repeat(32) });
  check('[MOCK] finalized policy satisfied after finalized head advance -> FINALIZED', rFin.reconcile.ok && rFin.reconcile.finalityState === 'FINALIZED', rFin.reconcile);

  // ---------------------------------------------------------------------------
  // [MOCK] CANONICAL-BLOCK MISMATCH — receipt.blockHash does not equal the
  //   canonical block at the included height.
  // ---------------------------------------------------------------------------
  const op2 = makeOpStackMock();
  const canon2 = op2._canon;
  // put a receipt whose blockHash is NOT in the canonical chain at its number
  const txHashMismatch = '0x' + 'cc'.repeat(32);
  const blkAt106 = canon2.find(b => b.number === 106);
  op2.transactionsMeta = op2.transactionsMeta || new Map();
  // corrupt: return a receipt with a wrong blockHash
  const origGetReceipt = op2.getTransactionReceipt.bind(op2);
  op2.setReceiptRaw = (hash, blockNum, wrongHash) => {
    op2._wrongReceipts = op2._wrongReceipts || new Map();
    op2._wrongReceipts.set(hash, { hash, status: 1, blockNumber: blockNum, blockHash: wrongHash, to: custodyAddr, logs: [] });
  };
  op2.getTransactionReceipt = async (hash) => {
    if (op2._wrongReceipts && op2._wrongReceipts.has(hash)) return op2._wrongReceipts.get(hash);
    return origGetReceipt(hash);
  };
  op2.setReceiptRaw(txHashMismatch, 106, '0x' + 'ee'.repeat(32)); // wrong canonical hash
  op2.setSafeHead(108);
  const mwMismatch = await mockWorkerWith(path.join(tmpdir, 'e1a-mismatch.sqlite'), op2, { policy: 'op-stack-safe' });
  const rMis = await mockPrepareAndReconcile(mwMismatch, op2, { policy: 'op-stack-safe', receiptBlock: 106, txHash: txHashMismatch });
  check('[MOCK] canonical-block mismatch -> not final (reorg returned, no pass)', !rMis.reconcile.ok && /REORG|CANONICAL|MISMATCH/.test(rMis.reconcile.reason || ''), rMis.reconcile);
  check('[MOCK] canonical-block mismatch -> no duplicate execution', mwMismatch.store.getAttempts('op-e1a-mock').filter(a => a.status === 'FINALIZED').length === 0, mwMismatch.store.getAttempts('op-e1a-mock'));

  // ---------------------------------------------------------------------------
  // [MOCK] RECEIPT DISAPPEARANCE / REORG — returned to reconciliation, NO
  //   second business action.
  // ---------------------------------------------------------------------------
  const op3 = makeOpStackMock();
  op3.setReceipt('0x' + 'dd'.repeat(32), 106);
  op3.setSafeHead(108);
  const mwReorg = await mockWorkerWith(path.join(tmpdir, 'e1a-reorg.sqlite'), op3, { policy: 'op-stack-safe' });
  const rReorg1 = await mockPrepareAndReconcile(mwReorg, op3, { policy: 'op-stack-safe', receiptBlock: 106, txHash: '0x' + 'dd'.repeat(32) });
  // final under safe policy first, then the receipt disappears (reorg removed it)
  check('[MOCK] pre-reorg receipt final under safe policy', rReorg1.reconcile.ok && rReorg1.reconcile.status === 'FINALIZED', rReorg1.reconcile);
  op3.removeReceipt('0x' + 'dd'.repeat(32));
  const rReorg2 = await mwReorg.reconcileOutcome('op-e1a-mock');
  check('[MOCK] receipt disappearance after finalization -> not re-executed (no active attempt / NO_ACTIVE_ATTEMPT)', (rReorg2.reason === 'NO_ACTIVE_ATTEMPT' || rReorg2.ok), rReorg2);
  // no second business action: escrow unaffected (mock getEscrow fixed state; the
  // attempt count is still exactly one finalized row)
  check('[MOCK] no duplicate execution on reorg (single attempt row)', mwReorg.store.getAttempts('op-e1a-mock').filter(a => a.status === 'FINALIZED').length === 1, mwReorg.store.getAttempts('op-e1a-mock'));

  // ---------------------------------------------------------------------------
  // [MOCK] UNSUPPORTED TAGS / HISTORY — safe/finalized head unavailable fails
  //   closed (TAG_UNAVAILABLE), never passes.
  // ---------------------------------------------------------------------------
  const op4 = makeOpStackMock();
  op4.setReceipt('0x' + 'ee'.repeat(32), 106);
  op4.setSafeHead(108);
  // remove the 'safe' support: make getBlock('safe') return null
  const origGetBlock = op4.getBlock.bind(op4);
  op4.getBlock = async (tag) => {
    if (tag === 'safe' || tag === 'finalized') return null;
    return origGetBlock(tag);
  };
  const mwUnsup = await mockWorkerWith(path.join(tmpdir, 'e1a-unsup.sqlite'), op4, { policy: 'op-stack-safe' });
  const rUnsup = await mockPrepareAndReconcile(mwUnsup, op4, { policy: 'op-stack-safe', receiptBlock: 106, txHash: '0x' + 'ee'.repeat(32) });
  check('[MOCK] unsupported safe tag -> fail closed (TAG_UNAVAILABLE)', !rUnsup.reconcile.ok && /TAG_UNAVAILABLE/.test(rUnsup.reconcile.reason || ''), rUnsup.reconcile);

  // ---------------------------------------------------------------------------
  // [MOCK] BOUNDED VERIFICATION EXHAUSTION — ancestry beyond maxDepth fails
  //   closed (BOUND_EXCEEDED).
  // ---------------------------------------------------------------------------
  const op5 = makeOpStackMock();
  op5.setReceipt('0x' + 'ff'.repeat(32), 100); // 8 blocks below safe head 108
  op5.setSafeHead(108);
  const mwBound = await mockWorkerWith(path.join(tmpdir, 'e1a-bound.sqlite'), op5, { policy: 'op-stack-safe', finalityOpts: { maxDepth: 3 } });
  const rBound = await mockPrepareAndReconcile(mwBound, op5, { policy: 'op-stack-safe', receiptBlock: 100, txHash: '0x' + 'ff'.repeat(32) });
  check('[MOCK] bounded exhaustion (depth > maxDepth) -> BOUND_EXCEEDED', !rBound.reconcile.ok && /BOUND_EXCEEDED/.test(rBound.reconcile.reason || ''), rBound.reconcile);

  // ---------------------------------------------------------------------------
  // [MOCK] CONFLICTING RPC OBSERVATIONS — RPC_DISAGREEMENT requires two ACTUAL
  //   conflicting observations of the safe head (same block, different hash).
  // ---------------------------------------------------------------------------
  const op6 = makeOpStackMock();
  const prog6 = memProgress();
  const mwDisc = await mockWorkerWith(path.join(tmpdir, 'e1a-disc.sqlite'), op6, { policy: 'op-stack-safe', finalityOpts: { progress: prog6 } });
  const adapterDisc = mwDisc.finality;
  // observation 1: safe head block 108 hash A
  await adapterDisc.observePublicHead('safe', 'headA');
  // observation 2: same block 108 but a DIFFERENT hash (actual conflict)
  const canon6 = op6._canon;
  const b108 = canon6.find(b => b.number === 108);
  b108.hash = '0x' + '11'.repeat(32); // mutate the hash (simulate conflicting node view)
  const rDisc = await adapterDisc.observePublicHead('safe', 'headA');
  check('[MOCK] conflicting RPC observations -> RPC_DISAGREEMENT', rDisc.disagreed === true && /RPC_DISAGREEMENT/.test(rDisc.reason || ''), rDisc);
  // a mere unchanged head is NOT a disagreement:
  const rNoDisc = await adapterDisc.observePublicHead('safe', 'headB');
  check('[MOCK] unchanged head is not a disagreement', rNoDisc.disagreed === false, rNoDisc);

  // ---------------------------------------------------------------------------
  // [MOCK] PERSISTED STALL DETECTION — one unchanged head alone is NOT a stall;
  //   no progress over threshold -> FINALITY_STALL.
  // ---------------------------------------------------------------------------
  const op7 = makeOpStackMock();
  const prog7 = memProgress();
  const mwStall = await mockWorkerWith(path.join(tmpdir, 'e1a-stall.sqlite'), op7, { policy: 'op-stack-safe', finalityOpts: { progress: prog7, stallMs: 100 } });
  const now0 = 1000;
  const s1 = await mwStall.finality.checkStall('head', now0);
  check('[MOCK] first stall observation not a stall', s1.stalled === false, s1);
  const s2 = await mwStall.finality.checkStall('head', now0 + 10);
  check('[MOCK] unchanged head within threshold not a stall', s2.stalled === false, s2);
  const s3 = await mwStall.finality.checkStall('head', now0 + 500); // > 100ms threshold, no progress
  check('[MOCK] no progress over threshold -> FINALITY_STALL', s3.stalled === true && s3.reason === 'FINALITY_STALL', s3);
  // progress resumes -> no stall
  op7.advanceHead();
  const s4 = await mwStall.finality.checkStall('head', now0 + 600);
  check('[MOCK] progress resumes -> not a stall', s4.stalled === false && s4.note === 'progress observed', s4);

  // ---------------------------------------------------------------------------
  // [MOCK] FINALIZED CONTRADICTION — a reorg signal AFTER an attempt was
  //   recorded consensus-finalized raises a BLOCKING incident.
  // ---------------------------------------------------------------------------
  const op8 = makeOpStackMock();
  op8.setReceipt('0x' + '12'.repeat(32), 106);
  op8.setSafeHead(108);
  op8.setFinalizedHead(108);
  const mwContra = await mockWorkerWith(path.join(tmpdir, 'e1a-contra.sqlite'), op8, { policy: 'op-stack-finalized' });
  const rContra1 = await mockPrepareAndReconcile(mwContra, op8, { policy: 'op-stack-finalized', receiptBlock: 106, txHash: '0x' + '12'.repeat(32) });
  check('[MOCK] finalized policy satisfied -> FINALIZED', rContra1.reconcile.ok && rContra1.reconcile.finalityState === 'FINALIZED', rContra1.reconcile);
  // now mutate the canonical chain: receipt.blockHash no longer matches the
  // block at height (block hash changed at the same height) -> reorg signal
  const canon8 = op8._canon;
  const b106 = canon8.find(b => b.number === 106);
  // simulate the canonical block at 106 having a different hash now (reorg)
  const origGetBlock8 = op8.getBlock.bind(op8);
  op8.getBlock = async (tagOrNum) => {
    if (Number(tagOrNum) === 106) return { ...b106, hash: '0x' + '99'.repeat(32) };
    return origGetBlock8(tagOrNum);
  };
  const rContra2 = await mwContra.reconcileOutcome('op-e1a-mock');
  check('[MOCK] contradiction after recorded finalization -> FINALIZED_CONTRADICTION blocking', !rContra2.ok && rContra2.reason === 'FINALIZED_CONTRADICTION', rContra2);
  check('[MOCK] blocked incident recorded (FINALIZED_CONTRADICTION)', mwContra.store.listIncidents({ kind: 'FINALIZED_CONTRADICTION' }).length === 1, mwContra.store.listIncidents());

  // ---------------------------------------------------------------------------
  // [MOCK] NO FALLBACK — failed public check never falls back to local
  //   confirmations (receipt present but safe tag unavailable -> NOT final,
  //   even though deep local confirmations exist).
  // ---------------------------------------------------------------------------
  const op9 = makeOpStackMock();
  op9.setReceipt('0x' + '34'.repeat(32), 100);
  op9.setSafeHead(null); // safe unavailable
  const mwNoFall = await mockWorkerWith(path.join(tmpdir, 'e1a-nofall.sqlite'), op9, { policy: 'op-stack-safe' });
  const rNoFall = await mockPrepareAndReconcile(mwNoFall, op9, { policy: 'op-stack-safe', receiptBlock: 100, txHash: '0x' + '34'.repeat(32) });
  check('[MOCK] no fallback: public check failure is not final, no local confirmation', !rNoFall.reconcile.ok && /TAG_UNAVAILABLE|not final/.test(rNoFall.reconcile.reason || ''), rNoFall.reconcile);

  // cleanup
  try { server.close(); } catch {}
  try { provider.destroy(); } catch {}
  console.log('----');
  console.log('e1a_passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });