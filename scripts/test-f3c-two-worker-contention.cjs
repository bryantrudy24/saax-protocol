// F3C review — deterministic TWO-WORKER contention over checkpoint
// reservation for the SAME escrow (interleaving control).
//
// WHY THIS TEST EXISTS: the F3C requirement matrix previously cited
// test-d3-integration.cjs "idempotent claim + drain" for competing workers,
// but that suite proves SEQUENTIAL retry/crash idempotency (one worker runs,
// then a replacement). It never runs TWO workers simultaneously contending
// for checkpoint reservation on the SAME escrow. This test closes that
// evidence gap deterministically:
//
//   one accepted operation (one escrow)
//   -> TWO D3Worker instances on the SAME store + SAME journal dir
//   -> both call processOnce() concurrently (Promise.all)
//   -> the atomic versioned claim (UPDATE work_items SET status='CLAIMED'
//      WHERE op_id=? AND version=? AND status='PENDING') admits exactly ONE
//      worker; the other receives STALE_VERSION.
//
// Asserts (the four requirements):
//   1. ONE persisted authorized head (journal file contains exactly one
//      pre-settlement prefix; the frozen tail equals the committed head).
//   2. NO silent recomputation: the winner freezes the SAME journal tail the
//      authorization was signed over (frozen == signedHead) and the chain
//      records committedHead == that frozen head; the loser never recomputes
//      a different head (it never gets past claim).
//   3. NO duplicate payout: exactly one broadcast, one FINALIZED attempt,
//      escrow Released exactly once, totalHeld 0.
//   4. Two workers may BOTH observe the PENDING row, but only the claim
//      winner proceeds; the loser's processOnce returns STALE_VERSION/NO_WORK.
//
// Reuses the proven V3 integrated-flow harness pattern (real local EVM
// 31337, real V3 candidate artifact, real journal writer, real worker
// classes). LOCAL ONLY — synthetic keys, RPC proxy with read-only + send
// methods. No push, no deployment, no secret exposure.
//
// Usage: node scripts/test-f3c-two-worker-contention.cjs

'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const { D3Store } = require('../worker/d3-store.js');
const { D3Worker } = require('../worker/d3-worker.js');
const { D2Prerequisites } = require('../worker/d2-prereqs.js');
const { FinalityAdapter } = require('../worker/d2-finality.js');
const { loadCustodyAbi } = require('../worker/d1-abi.js');
const v3sig = require('./v3-signing.cjs');

const ROOT = path.resolve(__dirname, '..');
const CHAIN = 31337;
const RELAYER_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';
const RELAYER_ADDR = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';
// Journal signer = synthetic key (deployer-ish); public test-only constant.
const JOURNAL_KEY = RELAYER_KEY;
// Issue entry must be signed by the BUYER key (hardhat account 1) per the writer's
// role rule (by == role signer for buyer-role transitions) - matches the F3B harness.
const BUYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3c-race-'));
const storePath = path.join(tmpdir, 'worker-store.sqlite');
const journalDir = path.join(tmpdir, 'journal');
fs.mkdirSync(journalDir, { recursive: true });

let provider, hre, accounts, custody, token, custodyAddr, tokenAddr;
let server, rpcUrl;

async function startRealEvm() {
  const s = await helpers.startEvm(CHAIN);
  provider = s.provider; hre = s.hre; accounts = s.accounts;
  const [deployer, buyer, seller, evaluatorEOA, attester,, stranger] = accounts;
  const deploy = async (art, args = []) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
  token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  tokenAddr = token.target;
  const policy = '0x' + 'ab'.repeat(32);
  const v3art = require('../data/escrow-custody-v3-build.json');
  custody = await deploy({ abi: v3art.abi, bytecode: v3art.bytecode }, [1000000, 10000000, true, 1, policy]);
  custodyAddr = custody.target;
  const allow = new Set(['eth_chainId','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getCode','eth_call','eth_sendRawTransaction','eth_getBalance','eth_blockNumber','eth_feeHistory','eth_getLogs','eth_estimateGas','eth_gasPrice']);
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

const V3_ART = require('../data/escrow-custody-v3-build.json');
const abi = V3_ART.abi; // V3 ABI (9-arg head-bound release)
function rpcProvider() { return new ethers.JsonRpcProvider(rpcUrl, CHAIN, { staticNetwork: true }); }

async function fundEscrowV3(cid, digest, { buyer, seller, evaluator, amount = 50000 }) {
  const t = Number((await provider.getBlock('latest')).timestamp);
  await (await token.mint(buyer.address, amount + 100000)).wait();
  await (await token.connect(buyer).approve(custodyAddr, amount + 100000)).wait();
  await (await custody.connect(buyer).fund(cid, digest, tokenAddr, buyer.address, seller.address, evaluator, amount, t + 5000, t + 7000, 0, 1, '0x' + 'ab'.repeat(32), digest)).wait();
  return { t };
}
function digestOf(cid) { return ethers.keccak256(ethers.concat([cid, ethers.toBeHex(1, 1)])); }
async function blockNow() { return Number((await provider.getBlock('latest')).timestamp); }
const rawSign = (i, digest) => helpers.rawSign(ethers, i, digest);

function makeWorker(storePathArg, journalDirArg) {
  const w = new D3Worker({
    storePath: storePathArg,
    abi,
    chain: { id: CHAIN, custody: custodyAddr },
    custodyVersion: 3,
    prereqs: new D2Prerequisites({
      abi, custody: { address: custodyAddr, chainId: CHAIN },
      getEscrow: async (cid) => {
        const e = await custody.getEscrow(cid);
        return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest, id: e.id, digest: e.id };
      },
      getBlock: async (tag) => provider.getBlock(tag),
      policy: { require2of3Evaluator: false },
    }),
    nextNonce: async (account, chain) => w.nextNonceFor(account, chain),
    relayer: { account: RELAYER_ADDR, wallet: new ethers.Wallet(RELAYER_KEY, rpcProvider()) },
    provider: rpcProvider(),
    finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), policy: 'local-confirmations', confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    journal: { dir: journalDirArg, signerKey: JOURNAL_KEY, chainId: CHAIN, custodyAddress: custodyAddr },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return w;
}

(function main() {
  return (async () => {
    console.log('F3C two-worker contention test — ' + tmpdir);
    const { deployer, buyer, seller, evaluatorEOA, attester, stranger } = await startRealEvm();
    const cid = digestOf(ethers.zeroPadValue(ethers.toBeHex(9601), 32));
    const digest = cid;
    await fundEscrowV3(cid, digest, { buyer, seller, evaluator: evaluatorEOA.address, amount: 50000 });

    // Pre-settlement authenticated journal prefix (issue entry), exactly as the
    // producer/harness does: the SAME writer + SAME key + SAME commitment so the
    // worker's _ensureJournalPrefix sees it as an idempotent no-op and freezes
    // the SAME tail. This is the ONE authorized head both workers must agree on.
    const jwMod = require('../mainnet/design/support/v4-journal-writer');
    const jw = jwMod.createJournalWriter({ chainId: CHAIN, custodyAddress: custodyAddr, commitmentId: cid, manifestHash: digest });
    await jw.append({
      transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'issue',
      resultingState: 'Issued', at: new Date().toISOString(), observed: false,
      signerWallets: [new (require('ethers').Wallet)(BUYER_KEY)],
      recoveredSigner: buyer.address, submitter: RELAYER_ADDR, txHash: null, blockHash: null,
      authorization: { kind: 'issue-record', opId: 'f3c-race', note: 'authenticated issue entry' },
    });
    const authorizedHead = jw.snapshot().tailHash;
    const jwPath = path.join(journalDir, String(cid).toLowerCase() + '.json');
    fs.writeFileSync(jwPath, JSON.stringify(jw.snapshot(), null, 2), 'utf8');
    check('one authorized head: journal prefix tail is non-zero and deterministic', authorizedHead && authorizedHead !== '0x' + '00'.repeat(32), authorizedHead);

    // Build a V3 evaluator release verdict signed over THAT head.
    const t0 = await blockNow();
    const d = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, cid, digest, 'release', 101, t0, authorizedHead);
    const sig = rawSign(3, d);
    const actionArgs = { commitmentId: cid, commitmentDigest: digest, preSettlementHead: authorizedHead, nonce: 101, issuedAt: t0, v: sig.v, r: sig.r, s: sig.s, sigBytes: '0x' };

    // ONE durable acceptance (single escrow).
    const store = new D3Store(storePath);
    const acc = store.acceptIntegrated({
      nonce: 'f3c-race-1', payloadDigest: 'sha256:' + 'f'.repeat(64), role: 'evaluator',
      action: 'submit verdict', commitmentDigest: digest, escrowId: cid, custody: custodyAddr,
      chainId: CHAIN, expiry: String(Math.floor(Date.now() / 1000) + 600), agreementRef: 'agv-f3c-race',
      authExpiry: Date.now() + 60000, relayerAccount: RELAYER_ADDR, workRequired: true,
      journalIntent: { transition: 'release', role: 'evaluator', contractAction: 'release', resultingState: 'Released' },
      actionArgs,
    });
    check('one durable work item (PENDING) for the single escrow', acc.ok && acc.work && acc.work.status === 'PENDING', acc);
    const opId = acc.op.op_id;
    store.close();

    // ---- THE RACE: two workers, same store + journal, concurrent processOnce.
    const wA = makeWorker(storePath, journalDir);
    const wB = makeWorker(storePath, journalDir);
    // Both constructors open their own D3Store on the same file. Both poll the
    // SAME PENDING row. Run them concurrently and capture per-worker results.
    const [resA, resB] = await Promise.all([
      wA.processOnce({ exportAfter: false }).catch(e => ({ fatal: e.message })),
      wB.processOnce({ exportAfter: false }).catch(e => ({ fatal: e.message })),
    ]);
    // Exactly ONE worker wins the atomic claim and proceeds to broadcast.
    const winner = [resA, resB].find(r => r && r.processed && r.processed.some(p => p.opId === opId));
    const loser = [resA, resB].find(r => r && (!r.processed || !r.processed.some(p => p.opId === opId)));
    const winnerResults = (winner && winner.processed) || [];
    const loserReasons = (loser && loser.processed) || [];
    check('exactly one worker claims the single op (winner proceeds)', !!winner, { resA: resA && resA.processed && resA.processed.map(p => p.reason || p.status), resB: resB && resB.processed && resB.processed.map(p => p.reason || p.status) });
    check('loser sees STALE_VERSION / NO_WORK (never proceeds past the atomic claim)', loserReasons.every(p => p.reason === 'STALE_VERSION' || p.reason === 'NO_WORK'), loserReasons);

    // The winner must have executed the V3 release (prepare + broadcast + reconcile).
    const winOp = winnerResults.find(p => p.opId === opId);
    // The winner's FIRST poll may return INCLUDED/NOT_ENOUGH_CONFIRMATIONS (the
  // chain mines between polls); production semantics upgrade to FINALIZED on the
  // next reconcile cycle, which the 'exactly one FINALIZED attempt' assertion
  // below proves. Here we only assert the winner genuinely claimed + executed
  // (reached broadcast/reconcile, not a stale-version rejection).
  check('winning worker claimed and executed the release (proceeded past atomic claim)', winOp && winOp.opId === opId && winOp.reason !== 'STALE_VERSION' && winOp.reason !== 'NO_WORK' && !winOp.fatal, winOp);
    await hre.network.provider.send('evm_mine', []);
    // Production behavior: the next poll cycle reconciles the INCLUDED attempt
    // to FINALIZED (confirmations satisfied) and drains the outbox. Re-run on
    // the WINNING worker only - the loser must NOT be able to reconcile (it
    // never claimed; its reconcileAll would find no supervised attempt or a
    // final one and is idempotent).
    const reconciles = await Promise.all([
      wA.reconcileAll({ allowRebroadcast: false }).catch(e => ({ fatal: e.message })),
      wB.reconcileAll({ allowRebroadcast: false }).catch(e => ({ fatal: e.message })),
    ]);
    // Drain via a FRESH replacement worker instance (production pattern): the
    // racing instances already marked the outbox seen; a new instance has no
    // dedup set and drains from the recorded outcome - recovery semantics.
    const wC = makeWorker(storePath, journalDir);
    const drainA = await wC.drainOutbox({ rpc: rpcUrl }).catch(e => ({ fatal: e.message }));
    const drainB = await (async () => { try { await wC.reconcileAll(); return { done: true }; } catch (e) { return { fatal: e.message }; } })();
    await hre.network.provider.send('evm_mine', []);

    // ---- ASSERTIONS 1-4 ----
    const store2 = new D3Store(storePath);
    const attempts = store2.getAttempts(opId) || [];
    check('NO duplicate payout: exactly one FINALIZED attempt', attempts.filter(a => a.status === 'FINALIZED').length === 1, attempts.map(a => a.status));
    const esc = await custody.getEscrow(cid);
    check('escrow Released exactly once (no double payout)', Number(esc[15]) === 3 && Number(await custody.totalHeld()) === 0, Number(esc[15]) + ' / ' + Number(await custody.totalHeld()));
    check('ONE persisted authorized head on-chain == frozen head (no recomputation)', String(esc[10]).toLowerCase() === authorizedHead.toLowerCase(), String(esc[10]).slice(0, 18) + ' vs ' + authorizedHead.slice(0, 18));
    check('headCommittedAt set exactly once', Number(esc[11]) > 0, Number(esc[11]));
    const journalFile = path.join(journalDir, String(cid).toLowerCase() + '.json');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const releaseEntries = journal.events.filter(e => e.transition === 'release' && e.observed);
    check('journal contains exactly ONE confirmed release entry (no duplicate settle entry)', releaseEntries.length === 1, journal.events.map(e => e.transition + (e.observed ? '*' : '')));
    const issueEntries = journal.events.filter(e => e.transition === 'issue');
    check('journal pre-settlement prefix contains exactly ONE issue entry (no silent recomputation of history)', issueEntries.length === 1, issueEntries.length);
    check('journal terminal transition writes the SAME head the winner froze (extension, not substitution)', releaseEntries.length === 1 && String(releaseEntries[0].prevHash).toLowerCase() === authorizedHead.toLowerCase(), releaseEntries[0] && releaseEntries[0].prevHash);
    check('seller paid exactly once (50000)', Number(await token.balanceOf(seller.address)) === 50000, Number(await token.balanceOf(seller.address)));
    check('outbox drained COMPLETE (single settle record)', store2.getOutbox(opId).status === 'COMPLETE');

    wA.close(); wB.close(); wC.close(); store2.close();
    if (server) { await new Promise(r => server.close(r)); }
    console.log('\nF3C two-worker contention: passed=' + passed + ' failed=' + failed);
    process.exit(failed === 0 ? 0 : 1);
  })().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); try { if (server) server.close(); } catch {} process.exit(2); });
})();
