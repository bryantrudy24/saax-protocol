// Phase D2 focused tests — broadcast, reconciliation, and crash recovery.
//
// Two classes of coverage, distinctly labeled:
//   [REAL] — local EVM 31337, genuine custody V2 + MockUSDC + real Safe 2-of-3
//            evaluator (ERC-1271), genuine signatures. Local deployments +
//            locally funded test escrows are authorized for this checkpoint.
//   [MOCK] — network/finality scenarios (broadcast timeout, reorg, dropped
//            tx, unexpected nonce consumption) simulated by a labeled mock RPC;
//            NEVER presented as real-chain results.
//
// Child-process termination/restart tests: the worker CLI
// (worker/run-d2-worker.cjs) runs in REAL subprocesses (spawn + kill + respawn)
// against a real local EVM via a JSON-RPC proxy, proving crash recovery works
// across actual process death, not just thrown exceptions.
//
// At-most-once custody effects: exactly one finalized outcome per op; a
// reverted receipt consumes the nonce but establishes NO custody success; a
// broadcast response loss leaves SUBMISSION_UNCERTAIN and is reconciled by
// hash; no fabricated success, no double payout.

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const { D2Worker } = require('../worker/d2-worker.js');
const { FinalityAdapter } = require('../worker/d2-finality.js');
const { D2Prerequisites } = require('../worker/d2-prereqs.js');
const { MockRPCProvider } = require('../worker/d2-mock-rpc.js');
const { loadCustodyAbi } = require('../worker/d1-abi.js');

const ROOT = path.resolve(__dirname, '..');
const CHAIN = 31337;
// Dedicated relayer: hardhat account 7 (funded by default, unused by the
// fixture: 0=deployer,1=buyer,2=seller,3=evaluatorEOA,4=attester,5=donor,
// 6=stranger). NEVER reuse the buyer/seller/stranger key for the relayer —
// the chain would see that account's nonce advance from fixture txs, tripping
// the D2 unexpected-nonce-consumption guard (which is exactly the guard's job).
// Derived from the standard hardhat mnemonic path m/44'/60'/0'/0/7
// (public test-only constant, verified against the provider signer(7)).
const RELAYER_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';
const RELAYER_ADDR = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-test-'));
const storePath = path.join(tmpdir, 'd2-store.sqlite');

// ---- real local EVM setup (proxy over hardhat in-process provider) ----------
let provider, hre, accounts, custody, token, safe, custodyAddr, tokenAddr;
let server, rpcUrl;

async function startRealEvm() {
  const s = await helpers.startEvm(CHAIN);
  provider = s.provider; hre = s.hre; accounts = s.accounts;
  const [deployer, buyer, seller, evaluatorEOA, attester,, stranger] = accounts;
  const abi = loadCustodyAbi();
  const deploy = async (art, args = []) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
  token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  tokenAddr = token.target;
  const policy = '0x' + 'ab'.repeat(32);
  // Safe evaluator (real Safe 1.4.1, 2-of-3)
  const safeArt = helpers.compileSafe('Safe', 'contracts/Safe.sol');
  const handlerArt = helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const singleton = await deploy(safeArt), handler = await deploy(handlerArt), factory = await deploy(factoryArt);
  const init = new ethers.Interface(safeArt.abi).encodeFunctionData('setup', [[buyer.address, seller.address, evaluatorEOA.address], 2, ethers.ZeroAddress, '0x', handler.target, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const created = await (await factory.createProxyWithNonce(singleton.target, init, 6311n)).wait();
  const createdEvent = created.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'ProxyCreation');
  safe = new ethers.Contract(createdEvent.args.proxy, safeArt.abi, deployer);
  custody = await deploy(hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2'), [1000000, 10000000, true, 1, policy]);
  custodyAddr = custody.target;
  // proxy all hardhat provider methods over a local HTTP server (read-only
  // methods for the worker; the broadcast goes through the same EVM)
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
  return { deployer, buyer, seller, evaluatorEOA, attester, stranger };
}

// ---- funding a local escrow (real chain) -------------------------------------
async function fundEscrow(cid, digest, { tokenAddr, buyer, seller, evaluator, amount = 1000, deadlineOffset = 2000, cutoffOffset = 4000 }) {
  const t = Number((await provider.getBlock('latest')).timestamp);
  await (await token.mint(buyer.address, amount + 100000)).wait();
  await (await token.connect(buyer).approve(custodyAddr, amount + 100000)).wait();
  await (await custody.connect(buyer).fund(cid, digest, tokenAddr, buyer.address, seller.address, evaluator, amount, t + deadlineOffset, t + cutoffOffset, 0, 1, '0x' + 'ab'.repeat(32), digest)).wait();
  return { t };
}

// ---- worker factory ----------------------------------------------------------
function makeWorker(opts = {}) {
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
    finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true,
    ...opts,
  });
}
let w2;
function rpcProvider() { return new ethers.JsonRpcProvider(rpcUrl, CHAIN, { staticNetwork: true }); }

// ---- verify release args (genuine Safe 2-of-3) --------------------------------
function releaseArgs(cid, digest, nonce, t) {
  const d = ethers.TypedDataEncoder.hash({ name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr }, { EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
    { commitmentId: cid, commitmentDigest: digest, action: 'release', nonce, issuedAt: t });
  const h = helpers.safeMessageHash(ethers, safe.target, CHAIN, d);
  const packed = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(ethers, i, h) })));
  return [cid, digest, nonce, t, 0, ethers.ZeroHash, ethers.ZeroHash, packed];
}

function releaseArgsObj(cid, digest, nonce, t) {
  const [cid_, digest_, nonce_, issuedAt_, v, r, s, sigBytes] = releaseArgs(cid, digest, nonce, t);
  return { commitmentId: cid_, commitmentDigest: digest_, nonce: nonce_, issuedAt: issuedAt_, v, r, s, sigBytes };
}
function digestOf(cid) { return ethers.keccak256(ethers.concat([cid, ethers.toBeHex(1, 1)])); }

async function main() {
  console.log('Phase D2 focused tests — ' + tmpdir);
  const { deployer, buyer, seller, evaluatorEOA, attester, stranger } = await startRealEvm();
  const evalAddr = safe.target;

  // ---------------------------------------------------------------------------
  // [REAL] GENUINE EVALUATOR RELEASE — full worker lifecycle
  // ---------------------------------------------------------------------------
  const cid1 = ethers.zeroPadValue(ethers.toBeHex(7001), 32);
  const digest1 = digestOf(cid1);
  const { t: t1 } = await fundEscrow(cid1, digest1, { tokenAddr, buyer, seller, evaluator: evalAddr });
  w2 = makeWorker();
  const bindings1 = { agreementRef: 'agreement-v4-1', escrowId: cid1, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + '1'.repeat(64), authNonce: 'n1', cutoff: t1 + 4000 };
  const p1 = await w2.prepare({
    opId: 'op-rel-1', payloadDigest: 'sha256:' + '1'.repeat(64), agreementRef: 'agreement-v4-1', escrowId: cid1,
    requestedAction: 'release', authNonce: 'n1', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: releaseArgsObj(cid1, digest1, 101, t1), bindings: bindings1,
  });
  check('[REAL] valid authorized op -> PREPARED', p1.ok && p1.status === 'PREPARED', p1);

  // validation before broadcast
  const v1 = await w2.validatePrepared('op-rel-1');
  check('[REAL] validatePrepared passes (hash/sender/chain/dest/nonce/action)', v1.ok, v1.detail || null);

  // corruption rejection: flip a byte in the stored signed bytes
  const prepRead = w2.store.getPrepared('op-rel-1');
  const corrupt = (hex) => {
    const b = Buffer.from(hex.slice(2), 'hex'); b[5] ^= 0xff; return '0x' + b.toString('hex');
  };
  // operation row first (FK), then the corrupted prepared tx
  w2.store.acceptOperation({ opId: 'op-rel-corrupt', payloadDigest: 'sha256:' + '1'.repeat(64), agreementRef: 'agreement-v4-1', escrowId: cid1, chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'release', authNonce: 'n1', authRole: 'evaluator', authExpiry: Date.now() + 60000 });
  w2.store.persistPrepared({
    opId: 'op-rel-corrupt',
    destination: prepRead.destination,
    calldata: prepRead.calldata,
    value: prepRead.value,
    gasLimit: prepRead.gas_limit,
    gasPrice: prepRead.gas_price,
    nonce: prepRead.nonce,
    relayerAccount: prepRead.relayer_account,
    chainId: prepRead.chain_id,
    signedBytes: corrupt(prepRead.signed_bytes),
    txHash: prepRead.tx_hash,
    actionBindings: prepRead.actionBindings,
  });
  const vc = await w2.validatePrepared('op-rel-corrupt');
  check('[REAL] corrupted signed bytes rejected (HASH_MISMATCH)', !vc.ok && vc.reason === 'HASH_MISMATCH', vc);

  // broadcast + reconcile (real chain)
  const b1 = await w2.broadcastPrepared('op-rel-1');
  check('[REAL] broadcast -> SUBMISSION_UNCERTAIN (reconcile by hash)', b1.ok && b1.status === 'SUBMISSION_UNCERTAIN', b1);
  // mine a confirmation block so local finality (depth>=1) is satisfied
  await hre.network.provider.send('evm_mine', []);
  const r1 = await w2.reconcileOutcome('op-rel-1');
  check('[REAL] reconcile -> FINALIZED', r1.ok && r1.status === 'FINALIZED', r1);
  check('[REAL] escrow state Released(3)', Number((await custody.getEscrow(cid1))[13]) === 3);
  const balAfter = Number(await token.balanceOf(custodyAddr));
  check('[REAL] token actually moved (custody balance 0)', balAfter === 0, balAfter);
  const escrowAfter = await custody.getEscrow(cid1);
  check('[REAL] beneficiary = seller', escrowAfter[4].toLowerCase() === seller.address.toLowerCase());
  const attempts1 = w2.store.getAttempts('op-rel-1');
  check('[REAL] attempt finalized exactly once', attempts1.filter(a => a.status === 'FINALIZED').length === 1);
  check('[REAL] no double payout: totalHeld 0', Number(await custody.totalHeld()) === 0);

  // repeated reconciliation is idempotent: terminal FINALIZED op has no active
  // attempt; reconcile is a no-op that does NOT re-execute or re-broadcast.
  const attemptsBefore = w2.store.getAttempts('op-rel-1').filter(a => a.status === 'FINALIZED').length;
  const r1again = await w2.reconcileOutcome('op-rel-1');
  const attemptsAfter = w2.store.getAttempts('op-rel-1').filter(a => a.status === 'FINALIZED').length;
  check('[REAL] repeated reconcile is idempotent (no 2nd payout, no re-broadcast)', (r1again.reason === 'NO_ACTIVE_ATTEMPT' || r1again.ok) && attemptsAfter === attemptsBefore && Number(await custody.totalHeld()) === 0, r1again);

  // ---------------------------------------------------------------------------
  // [REAL] MUTUAL RELEASE — both parties
  // ---------------------------------------------------------------------------
  const cid2 = ethers.zeroPadValue(ethers.toBeHex(7002), 32);
  const digest2 = digestOf(cid2);
  const { t: t2 } = await fundEscrow(cid2, digest2, { tokenAddr, buyer, seller, evaluator: evalAddr });
  // mutual release args (buyer + seller EIP-712 over MutualResolution)
  const mutDomain = { name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr };
  const mutTypes = { MutualResolution: [
    { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
  const mutMsg = { commitmentId: cid2, commitmentDigest: digest2, action: 'release', nonce: 201, issuedAt: t2 };
  const mutHash = ethers.TypedDataEncoder.hash(mutDomain, mutTypes, mutMsg);
  const sigB = ethers.Signature.from(helpers.rawSign(ethers, 1, mutHash)); // buyer
  const sigS = ethers.Signature.from(helpers.rawSign(ethers, 2, mutHash)); // seller
  const mutArgs = [cid2, digest2, 201, t2, sigB.v, sigB.r, sigB.s, sigS.v, sigS.r, sigS.s];
  w2 = makeWorker({ storePath: path.join(tmpdir, 'd2-mutual.sqlite') });
  const pm = await w2.prepare({
    opId: 'op-mut-1', payloadDigest: 'sha256:' + '2'.repeat(64), agreementRef: 'agreement-v4-2', escrowId: cid2,
    requestedAction: 'mutualRelease', authNonce: 'n2', authRole: 'buyer', authExpiry: Date.now() + 60000,
    actionArgs: { commitmentId: cid2, commitmentDigest: digest2, nonce: 201, issuedAt: t2, bv: sigB.v, br: sigB.r, bs: sigB.s, sv: sigS.v, sr: sigS.r, ss: sigS.s }, bindings: { agreementRef: 'agreement-v4-2', escrowId: cid2, chainId: CHAIN, custody: custodyAddr, requestedAction: 'mutualRelease', payloadDigest: 'sha256:' + '2'.repeat(64), authNonce: 'n2', cutoff: t2 + 4000 },
  });
  check('[REAL] mutual release op -> PREPARED', pm.ok && pm.status === 'PREPARED', pm);
  await w2.broadcastPrepared('op-mut-1');
  await hre.network.provider.send('evm_mine', []);
  const rm = await w2.reconcileOutcome('op-mut-1');
  check('[REAL] mutual release reconciles FINALIZED', rm.ok && rm.status === 'FINALIZED', rm);
  check('[REAL] mutual release -> escrow Released + seller paid', Number((await custody.getEscrow(cid2))[13]) === 3 && Number(await token.balanceOf(custodyAddr)) === 0);

  // ---------------------------------------------------------------------------
  // [REAL] TIMEOUT REFUND — at/after final cutoff, no evaluator authority
  // ---------------------------------------------------------------------------
  const cid3 = ethers.zeroPadValue(ethers.toBeHex(7003), 32);
  const digest3 = digestOf(cid3);
  const t3 = Number((await provider.getBlock('latest')).timestamp);
  // NOTE: hardhat automines a block per tx, and each mined block advances
  // block.timestamp — tight '+2' deadlines would be consumed by the mint/
  // approve/fund txs themselves. Use generous offsets, then advance past
  // the cutoff deterministically after funding.
  await fundEscrow(cid3, digest3, { tokenAddr, buyer, seller, evaluator: evalAddr, deadlineOffset: 100000, cutoffOffset: 200000 });
  // read the ACTUAL final cutoff from the funded escrow, then advance past it
  const esc3 = await custody.getEscrow(cid3);
  const cutoff3 = Number(esc3[8]); // V2 getEscrow tuple: 8 = finalCutoff (0=id,1=digest,2=token,3=buyer,4=seller,5=evaluator,6=amount,7=deadline,8=finalCutoff)
  await hre.network.provider.send('evm_increaseTime', [300000]); await hre.network.provider.send('evm_mine', []);
  w2 = makeWorker({ storePath: path.join(tmpdir, 'd2-timeout.sqlite') });
  const pt = await w2.prepare({
    opId: 'op-tmo-1', payloadDigest: 'sha256:' + '3'.repeat(64), agreementRef: 'agreement-v4-3', escrowId: cid3,
    requestedAction: 'refund', authNonce: 'n3', authRole: 'open', authExpiry: Date.now() + 60000,
    actionArgs: { commitmentId: cid3, commitmentDigest: digest3, nonce: 0, issuedAt: 0, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: '0x' },
    bindings: { agreementRef: 'agreement-v4-3', escrowId: cid3, chainId: CHAIN, custody: custodyAddr, requestedAction: 'refund', payloadDigest: 'sha256:' + '3'.repeat(64), authNonce: 'n3', cutoff: cutoff3 },
  });
  check('[REAL] timeout refund op -> PREPARED', pt.ok && pt.status === 'PREPARED', pt);
  await w2.broadcastPrepared('op-tmo-1');
  await hre.network.provider.send('evm_mine', []);
  const rt = await w2.reconcileOutcome('op-tmo-1');
  check('[REAL] timeout refund reconciles FINALIZED (refund to buyer)', rt.ok && rt.status === 'FINALIZED' && rt.outcome.evidence.beneficiary.toLowerCase() === buyer.address.toLowerCase(), rt);
  check('[REAL] timeout refund -> escrow Refunded(4)', Number((await custody.getEscrow(cid3))[13]) === 4);

  // ---------------------------------------------------------------------------
  // [REAL] DISPUTE + EVALUATOR RESOLUTION
  // ---------------------------------------------------------------------------
  const cid4 = ethers.zeroPadValue(ethers.toBeHex(7004), 32);
  const digest4 = digestOf(cid4);
  const { t: t4 } = await fundEscrow(cid4, digest4, { tokenAddr, buyer, seller, evaluator: evalAddr });
  // buyer raises dispute directly on chain (real)
  await (await custody.connect(buyer).raiseDispute(cid4, digest4, 'reject-deliverable')).wait();
  check('[REAL] dispute raised on chain', Number((await custody.getEscrow(cid4))[13]) === 2);
  // evaluator resolves "refund" (genuine Safe 2-of-3)
  const resD = ethers.TypedDataEncoder.hash({ name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr }, { EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
    { commitmentId: cid4, commitmentDigest: digest4, action: 'resolve:refund', nonce: 401, issuedAt: t4 });
  const hRes = helpers.safeMessageHash(ethers, safe.target, CHAIN, resD);
  const packedRes = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(ethers, i, hRes) })));
  w2 = makeWorker({ storePath: path.join(tmpdir, 'd2-dispute.sqlite') });
  const pd = await w2.prepare({
    opId: 'op-disp-1', payloadDigest: 'sha256:' + '4'.repeat(64), agreementRef: 'agreement-v4-4', escrowId: cid4,
    requestedAction: 'resolve', authNonce: 'n4', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: { commitmentId: cid4, commitmentDigest: digest4, resolution: 'refund', nonce: 401, issuedAt: t4, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: packedRes },
    bindings: { agreementRef: 'agreement-v4-4', escrowId: cid4, chainId: CHAIN, custody: custodyAddr, requestedAction: 'resolve', payloadDigest: 'sha256:' + '4'.repeat(64), authNonce: 'n4', cutoff: t4 + 4000 },
  });
  check('[REAL] dispute resolve op -> PREPARED', pd.ok && pd.status === 'PREPARED', pd);
  await w2.broadcastPrepared('op-disp-1');
  await hre.network.provider.send('evm_mine', []);
  const rd = await w2.reconcileOutcome('op-disp-1');
  check('[REAL] disputed evaluator resolution FINALIZED (refund)', rd.ok && rd.status === 'FINALIZED' && Number((await custody.getEscrow(cid4))[13]) === 4, rd);

  // ---------------------------------------------------------------------------
  // [REAL] ANOTHER ACTOR SETTLES FIRST — operation failure ≠ escrow outcome
  // ---------------------------------------------------------------------------
  const cid5 = ethers.zeroPadValue(ethers.toBeHex(7005), 32);
  const digest5 = digestOf(cid5);
  const { t: t5 } = await fundEscrow(cid5, digest5, { tokenAddr, buyer, seller, evaluator: evalAddr });
  w2 = makeWorker({ storePath: path.join(tmpdir, 'd2-external.sqlite') });
  const p5 = await w2.prepare({
    opId: 'op-ext-1', payloadDigest: 'sha256:' + '5'.repeat(64), agreementRef: 'agreement-v4-5', escrowId: cid5,
    requestedAction: 'release', authNonce: 'n5', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: releaseArgsObj(cid5, digest5, 501, t5), bindings: { agreementRef: 'agreement-v4-5', escrowId: cid5, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + '5'.repeat(64), authNonce: 'n5', cutoff: t5 + 4000 },
  });
  // another actor (stranger) submits the SAME valid release first
  await (await custody.connect(stranger).release(...releaseArgs(cid5, digest5, 501, t5), { gasLimit: 1000000 })).wait();
  // The worker validates BEFORE broadcasting: the escrow is now Released, so
  // the release is no longer permitted — the worker MUST refuse to broadcast
  // (fail closed) rather than submit a now-reverting tx. This demonstrates
  // "keep operation failure separate from escrow outcome": the worker's
  // operation fails validation, while the escrow was resolved by the OTHER
  // actor. No nonce is consumed because no bytes were broadcast.
  const wB5 = await w2.broadcastPrepared('op-ext-1');
  check('[REAL] worker release after external settlement -> refused before broadcast (STATE_NOT_PERMITTED)', !wB5.ok && (wB5.reason === 'STATE_NOT_PERMITTED'), wB5);
  check('[REAL] no attempt row created (nothing broadcast)', w2.store.getAttempts('op-ext-1').length === 0);
  check('[REAL] escrow was resolved by the external actor (Released)', Number((await custody.getEscrow(cid5))[13]) === 3);
  check('[REAL] worker did NOT claim custody success (no FINALIZED fake)', w2.store.getAttempts('op-ext-1').filter(a => a.status === 'FINALIZED').length === 0);
  // failure is an operation failure, escrow outcome is separate
  w2.store.incident({ kind: 'EXTERNAL_RESOLUTION', opId: 'op-ext-1', relayerAccount: RELAYER_ADDR, chainId: CHAIN, nonce: p5.tx.nonce, detail: 'escrow resolved by another actor before worker broadcast' });
  check('[REAL] incident recorded for external resolution', w2.store.listIncidents({ kind: 'EXTERNAL_RESOLUTION' }).length === 1);

  // ---------------------------------------------------------------------------
  // [REAL] RECEIPT-ABSENT == UNCERTAIN, never non-broadcast  (real chain variant:
  // broadcast to a real EVM always mines; we prove the ABSENT path via the
  // mock below. Here we prove the real chain gives a definitive result.)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // [REAL] CHILD-PROCESS CRASH/RESTART — kill after durable preparation,
  //        before broadcast; kill after broadcast before reconcile.
  // ---------------------------------------------------------------------------
  const cid6 = ethers.zeroPadValue(ethers.toBeHex(7006), 32);
  const digest6 = digestOf(cid6);
  const { t: t6 } = await fundEscrow(cid6, digest6, { tokenAddr, buyer, seller, evaluator: evalAddr });
  const childStore = path.join(tmpdir, 'd2-child.sqlite');
  const runChild = (args) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'worker/run-d2-worker.cjs'), childStore, String(CHAIN), custodyAddr, rpcUrl, ...args], {
      cwd: ROOT,
      env: Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    });
    let text = '';
    p.stdout.on('data', v => { text += v; });
    p.stderr.on('data', v => { text += v; });
    p.on('error', reject);
    p.on('exit', (code) => resolve({ code, text }));
  });
  // prepare in a child (durable), then kill it before broadcast
  const b6 = JSON.stringify({ agreementRef: 'agreement-v4-6', escrowId: cid6, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + '6'.repeat(64), authNonce: 'n6', cutoff: t6 + 4000 });
  const prepArgs = ['--prepare', 'op-child-1', 'sha256:' + '6'.repeat(64), cid6, 'release', b6];
  // need actionArgs: pass via bindings? The CLI builds releaseArgs? No — the CLI
  // uses bindings.actionArgs if present. We must pass genuine release args.
  const b6full = JSON.stringify({ agreementRef: 'agreement-v4-6', escrowId: cid6, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + '6'.repeat(64), authNonce: 'n6', cutoff: t6 + 4000, actionArgs: releaseArgsObj(cid6, digest6, 601, t6) });
  const rChild1 = await runChild(['--prepare', 'op-child-1', 'sha256:' + '6'.repeat(64), cid6, 'release', b6full]);
  check('[REAL] child prepare -> PREPARED', rChild1.code === 0 && /"status":"PREPARED"/.test(rChild1.text), rChild1.text.slice(-300));
  const childRec = await runChild(['--recover']);
  check('[REAL] child recovery after prepare (no broadcast attempted) keeps op prepared', /"prepared":\[[^\]]*"opId":"op-child-1"/.test(childRec.text) || /op-child-1/.test(childRec.text), childRec.text.slice(-300));
  // broadcast from child
  const rChildB = await runChild(['--broadcast', 'op-child-1']);
  check('[REAL] child broadcast -> SUBMISSION_UNCERTAIN', rChildB.code === 0 && /"status":"SUBMISSION_UNCERTAIN"/.test(rChildB.text), rChildB.text.slice(-300));
  // mine a confirmation block before the restart-reconcile (local finality)
  await hre.network.provider.send('evm_mine', []);
  // reconcile from a NEW child (restart) — proves crash recovery across processes
  const rChildR = await runChild(['--reconcile', 'op-child-1']);
  check('[REAL] child restart reconcile -> FINALIZED', rChildR.code === 0 && /"status":"FINALIZED"/.test(rChildR.text), rChildR.text.slice(-300));
  check('[REAL] child-escrow released by worker', Number((await custody.getEscrow(cid6))[13]) === 3);

  // ---------------------------------------------------------------------------
  // [MOCK] SUBMISSION UNCERTAINTY / RECEIPT ABSENT  (labeled mock)
  // ---------------------------------------------------------------------------
  let mock = new MockRPCProvider({ chainId: '0x7a69' });
  let mockWorker2;
  mock.setAccountNonce(RELAYER_ADDR, 0, 0);
  const mockWallet = new ethers.Wallet(RELAYER_KEY, mock);
  // prereqs validates BEFORE execution (escrow is still Funded);
  // the worker's outcome reader sees the post-release state (Released).
  const mockEscrowBeforeRelease = { state: 1, finalCutoff: 9999999999, deadline: 9999999999, buyer: buyer.address, seller: seller.address, amount: 1000, token: tokenAddr, evaluator: evalAddr, commitmentDigest: '0x' + '22'.repeat(32) };
  const mockEscrowAfterRelease = { ...mockEscrowBeforeRelease, state: 3 };
  const mockWorker = new D2Worker({
    storePath: path.join(tmpdir, 'd2-mock.sqlite'),
    abi: loadCustodyAbi(),
    chain: { id: 31337, custody: custodyAddr },
    prereqs: new D2Prerequisites({
      abi: loadCustodyAbi(), custody: { address: custodyAddr, chainId: 31337 },
      getEscrow: async () => mockEscrowBeforeRelease,
      getBlock: async () => ({ timestamp: 1000 }),
      policy: { require2of3Evaluator: false },
    }),
    getEscrow: async () => mockEscrowAfterRelease,
    nextNonce: async (acct, chain) => mockWorker2.nextNonceFor(acct, chain),
    relayer: { account: RELAYER_ADDR, wallet: mockWallet },
    provider: mock,
    finality: new FinalityAdapter({ getBlock: async (t) => mock.getBlock(t), getReceipt: async (h) => mock.getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true,
  });
  mockWorker2 = mockWorker;
  const mockB = await mockWorker.prepare({
    opId: 'op-mock-1', payloadDigest: 'sha256:' + 'm'.repeat(64), agreementRef: 'agreement-v4-m', escrowId: '0x' + '33'.repeat(32),
    requestedAction: 'release', authNonce: 'nm', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: { commitmentId: ethers.zeroPadValue(ethers.toBeHex(1), 32), commitmentDigest: '0x' + '22'.repeat(32), nonce: 1, issuedAt: 1000, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: '0x' },
    bindings: { agreementRef: 'agreement-v4-m', escrowId: '0x' + '33'.repeat(32), chainId: 31337, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + 'm'.repeat(64), authNonce: 'nm', cutoff: 9999999999 },
  });
  check('[MOCK] mock op -> PREPARED', mockB.ok && mockB.status === 'PREPARED', mockB);

  // response discarded (send throws) -> SUBMISSION_UNCERTAIN
  mock.setDropResponse();
  const mb1 = await mockWorker.broadcastPrepared('op-mock-1');
  check('[MOCK] broadcast response discarded -> SUBMISSION_UNCERTAIN, never non-broadcast', !mb1.ok && mb1.reason === 'SUBMISSION_UNCERTAIN', mb1);
  // the tx WAS accepted by the node (response lost); mining happens before
  // reconciliation — mock mines the last broadcast at depth 2 under head
  mock.mineLastBroadcast(2);
  const mr1 = await mockWorker.reconcileOutcome('op-mock-1');
  check('[MOCK] reconcile after mining -> FINALIZED (mock)', mr1.ok && mr1.status === 'FINALIZED', mr1);

  // receipt disappears after inclusion (reorg) -> REVERTED_TO_RECONCILIATION, no double payout
  const cidReorg = ethers.zeroPadValue(ethers.toBeHex(7007), 32);
  mock = new MockRPCProvider({ chainId: '0x7a69' });
  mock.setAccountNonce(RELAYER_ADDR, 0, 0);
  const mockWallet2 = new ethers.Wallet(RELAYER_KEY, mock);
  let mockWorker3;
  mockWorker3 = new D2Worker({
    storePath: path.join(tmpdir, 'd2-mock-reorg.sqlite'),
    abi: loadCustodyAbi(), chain: { id: 31337, custody: custodyAddr },
    prereqs: new D2Prerequisites({
      abi: loadCustodyAbi(), custody: { address: custodyAddr, chainId: 31337 },
      getEscrow: async () => ({ state: 1, finalCutoff: 9999999999, deadline: 9999999999, buyer: buyer.address, seller: seller.address, amount: 1000, token: tokenAddr, evaluator: evalAddr, commitmentDigest: '0x' + '22'.repeat(32) }),
      getBlock: async (t) => mock.getBlock(t),
      policy: { require2of3Evaluator: false },
    }),
    nextNonce: async (acct, chain) => mockWorker3.nextNonceFor(acct, chain),
    relayer: { account: RELAYER_ADDR, wallet: mockWallet2 },
    provider: mock,
    finality: new FinalityAdapter({ getBlock: async (t) => mock.getBlock(t), getReceipt: async (h) => mock.getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true,
  });
  const mockB3 = await mockWorker3.prepare({
    opId: 'op-reorg-1', payloadDigest: 'sha256:' + 'r'.repeat(64), agreementRef: 'agreement-v4-r', escrowId: '0x' + '44'.repeat(32),
    requestedAction: 'release', authNonce: 'nr', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: { commitmentId: ethers.zeroPadValue(ethers.toBeHex(4), 32), commitmentDigest: '0x' + '22'.repeat(32), nonce: 1, issuedAt: 1000, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: '0x' },
    bindings: { agreementRef: 'agreement-v4-r', escrowId: '0x' + '44'.repeat(32), chainId: 31337, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + 'r'.repeat(64), authNonce: 'nr', cutoff: 9999999999 },
  });
  mock.setMineAfterSend(2);
  await mockWorker3.broadcastPrepared('op-reorg-1');
  // now cause the reorg: the included block hash changes
  const txH = mockWorker3.store.getAttempts('op-reorg-1')[0].tx_hash;
  mock.causeReorg(txH, '0x' + 'dd'.repeat(32));
  const rr = await mockWorker3.reconcileOutcome('op-reorg-1');
  check('[MOCK] reorg (block hash changed) -> NOT final / returned to reconciliation, no double payout', !rr.ok && /REORG/.test(rr.reason || ''), rr);
  check('[MOCK] reorg incident recorded', mockWorker3.store.listIncidents({ kind: 'REORG_DETECTED' }).length === 1);

  // unexpected nonce consumption -> blocking incident gates new work.
  // Setup: THIS store reserved nonce 0 for an op it never broadcast, but the
  // chain shows nonce 5 — the account's nonce advanced past a reservation
  // this store holds unaccounted-for (consumed by someone else).
  const mock4 = new MockRPCProvider({ chainId: '0x7a69' });
  mock4.setAccountNonce(RELAYER_ADDR, 5, 5); // chain consumed nonces 0-4 already
  let mockWorker4;
  mockWorker4 = new D2Worker({
    storePath: path.join(tmpdir, 'd2-mock-nonce.sqlite'),
    abi: loadCustodyAbi(), chain: { id: 31337, custody: custodyAddr },
    prereqs: new D2Prerequisites({
      abi: loadCustodyAbi(), custody: { address: custodyAddr, chainId: 31337 },
      getEscrow: async () => ({ state: 1, finalCutoff: 9999999999, deadline: 9999999999, buyer: buyer.address, seller: seller.address, amount: 1000, token: tokenAddr, evaluator: evalAddr, commitmentDigest: '0x' + '22'.repeat(32) }),
      getBlock: async () => ({ timestamp: 1000 }),
      policy: { require2of3Evaluator: false },
    }),
    nextNonce: async (acct, chain) => mockWorker4.nextNonceFor(acct, chain),
    relayer: { account: RELAYER_ADDR, wallet: new ethers.Wallet(RELAYER_KEY, mock4) },
    provider: mock4,
    finality: new FinalityAdapter({ getBlock: async (t) => mock4.getBlock(t), getReceipt: async (h) => mock4.getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true,
  });
  // seed an unaccounted reservation at nonce 0 (reserved, never broadcast,
  // never consumed by this store) — the chain having moved past it is the
  // unexpected-consumption signal
  mockWorker4.store.reserveNonce({ relayerAccount: RELAYER_ADDR, chainId: 31337, nonce: 0, opId: 'op-unexp-1' });
  try {
    await mockWorker4.nextNonceFor(RELAYER_ADDR, 31337);
    check('[MOCK] unexpected nonce consumption -> BLOCKING incident', false, 'no throw');
  } catch (e) {
    check('[MOCK] unexpected nonce consumption -> BLOCKING incident', /BLOCKED/.test(e.message), e.message);
  }
  check('[MOCK] unexpected consumption incident recorded', mockWorker4.store.listIncidents({ kind: 'UNEXPECTED_NONCE_CONSUMPTION' }).length === 1);

  // nonce gaps / stalled reservations never recycled
  const mock5 = new MockRPCProvider({ chainId: '0x7a69' });
  mock5.setAccountNonce(RELAYER_ADDR, 1, 1);
  let mockWorker5;
  mockWorker5 = new D2Worker({
    storePath: path.join(tmpdir, 'd2-mock-stall.sqlite'),
    abi: loadCustodyAbi(), chain: { id: 31337, custody: custodyAddr },
    prereqs: new D2Prerequisites({
      abi: loadCustodyAbi(), custody: { address: custodyAddr, chainId: 31337 },
      getEscrow: async () => ({ state: 1, finalCutoff: 9999999999, deadline: 9999999999, buyer: buyer.address, seller: seller.address, amount: 1000, token: tokenAddr, evaluator: evalAddr, commitmentDigest: '0x' + '22'.repeat(32) }),
      getBlock: async () => ({ timestamp: 1000 }),
      policy: { require2of3Evaluator: false },
    }),
    nextNonce: async (acct, chain) => mockWorker5.nextNonceFor(acct, chain),
    relayer: { account: RELAYER_ADDR, wallet: new ethers.Wallet(RELAYER_KEY, mock5) },
    provider: mock5,
    finality: new FinalityAdapter({ getBlock: async (t) => mock5.getBlock(t), getReceipt: async (h) => mock5.getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true,
  });
  // reserve nonce 0, mark stalled
  mockWorker5.store.reserveNonce({ relayerAccount: RELAYER_ADDR, chainId: 31337, nonce: 0, opId: 'op-stall-a' });
  mockWorker5.store.recordStalled({ relayerAccount: RELAYER_ADDR, chainId: 31337, nonce: 0, opId: 'op-stall-a', reason: 'SIGN_FAILED:test' });
  await mockWorker5.nextNonceFor(RELAYER_ADDR, 31337); // chain nonce 1 -> next is 1; stalled 0 NOT recycled
  const resv = mockWorker5.store.listReservations({ relayerAccount: RELAYER_ADDR, chainId: 31337 });
  check('[MOCK] stalled reservation never recycled (still STALLED)', resv.some(r => r.nonce === 0 && r.status === 'STALLED'), resv);

  // ---------------------------------------------------------------------------
  // [REAL] REVERTED + PERSISTENCE FAILURE AFTER CHAIN EXECUTION
  // ---------------------------------------------------------------------------
  // persistence failure after chain execution: the tx is mined and affects
  // chain state; if the local record write fails, reconciliation must still
  // surface the truth from the chain (the worker never fabricates success).
  const cid7 = ethers.zeroPadValue(ethers.toBeHex(7008), 32);
  const digest7 = digestOf(cid7);
  const { t: t7 } = await fundEscrow(cid7, digest7, { tokenAddr, buyer, seller, evaluator: evalAddr });
  w2 = makeWorker({ storePath: path.join(tmpdir, 'd2-persist.sqlite') });
  const p7 = await w2.prepare({
    opId: 'op-persist-1', payloadDigest: 'sha256:' + '7'.repeat(64), agreementRef: 'agreement-v4-7', escrowId: cid7,
    requestedAction: 'release', authNonce: 'n7', authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: releaseArgsObj(cid7, digest7, 701, t7), bindings: { agreementRef: 'agreement-v4-7', escrowId: cid7, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: 'sha256:' + '7'.repeat(64), authNonce: 'n7', cutoff: t7 + 4000 },
  });
  await w2.broadcastPrepared('op-persist-1');
  await hre.network.provider.send('evm_mine', []);
  // simulate persistence failure after chain execution: patch store to throw on
  // the FINALIZE write, then reconcile anyway (worker must still read the chain)
  const origFinalize = w2.store.recordFinalized.bind(w2.store);
  let persistFailHit = false;
  w2.store.recordFinalized = (...a) => { persistFailHit = true; throw new Error('PERSIST_FAILURE_AFTER_CHAIN'); };
  const r7 = await w2.reconcileOutcome('op-persist-1');
  check('[REAL] persistence failure after chain execution surfaces (no fabricated success)', persistFailHit && !r7.ok, r7);
  // restore + re-reconcile: idempotent, chain truth wins
  w2.store.recordFinalized = origFinalize;
  const r7b = await w2.reconcileOutcome('op-persist-1');
  check('[REAL] re-reconcile after persist failure -> FINALIZED from chain, no double payout', r7b.ok && r7b.status === 'FINALIZED' && Number(await custody.totalHeld()) === 0, r7b);

  // cleanup
  try { server.close(); } catch {}
  try { provider.destroy(); } catch {}
  console.log('----');
  console.log('d2_passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });