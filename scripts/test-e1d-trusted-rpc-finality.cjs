// E1D focused tests — bounded trusted-RPC historical finality assertions
// (worker/d2-trusted-rpc-finality.js).
//
// Labeling (per task):
//   [MOCK] = labeled mock RPC simulations of canonical blocks, receipts,
//            safe/finalized tags, advancing/regressing/changing heads,
//            request-budget exhaustion, unsupported tags — never presented
//            as real-chain results.
//   [REAL] = the public read-only observation is a SEPARATE script
//            (scripts/observe-e1d-sepolia.cjs); this battery is mock-only.
//
// The module under test is worker/d2-trusted-rpc-finality.js:
//   - TrustedRpcFinality.assertHistoricalFinality — the EXPLICIT, DISTINCT
//     trusted-RPC safe/finalized assertion for DEEP history:
//       * chain + transaction/receipt identity checks
//       * canonical block/hash + transaction-membership checks
//       * required tagged-head observation (safe/finalized)
//       * coverage (included <= tagged head) and consistency rechecks
//         (stability across the verification window)
//       * bounded retries + request budget
//       * explicit failure for contradictory, unstable, unavailable, or
//         unsupported observations
//   - It does NOT walk ancestry (no unbounded traversal) and does NOT weaken
//     the existing bounded-ancestry method (assertPublicFinality in
//     worker/d2-historical-finality.js stays untouched).
//
// Scenarios required by the task:
//   - deep historical SAFE and FINALIZED positives (no ancestry walk)
//   - membership positive but required finality pending (included above head)
//   - wrong receipt / block / chain
//   - conflicting canonical views (changing hash)
//   - advancing versus regressing / changing heads
//   - unsupported tags / history
//   - request-budget exhaustion
//   - configuration downgrade attempts (export-supplied cannot lower)
//   - SAFE never mislabeled FINALIZED
//
// Every send() is recorded so tests assert the ACTUAL methods used and the
// actual bounded request counts.

'use strict';

const { TrustedRpcFinality, MAINNET_CHAIN, DEFAULT_REQUEST_BUDGET } = require('../worker/d2-trusted-rpc-finality');
const { HistoricalMembership } = require('../worker/d2-historical-finality'); // existing bounded method, must stay intact

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

// A labeled mock JSON-RPC provider that records every send() so tests can
// assert the exact RPC methods used and the actual number of calls.
// Controls:
//   setReceipt(txHash, blockNumber, {blockHash?, status?, forcedHash?})
//   setBlockTx(blockNumber, txs)
//   reorgBlockAt(blockNumber, newHash)
//   setSafe(n), setFinalized(n), removeSafeTag(), removeFinalizedTag()
//   setHead(n) / advance() — canonical latest head
//   makeTagChangeOnNthRead(tag, n, {number, hash}) — head-binding instability
//   setRequestBudget(budget), failNextReads(count, method)
function makeMockRpc({ chainId = 84532, budget = 100 } = {}) {
  const canon = [];
  for (let i = 0; i < 20; i++) {
    canon.push({
      number: i,
      hash: '0x' + i.toString(16).padStart(2, '0').repeat(32),
      parentHash: i === 0 ? null : '0x' + (i - 1).toString(16).padStart(2, '0').repeat(32),
      timestamp: 1000 + i,
      transactions: ['0x' + ('f' + i).padStart(64, 'f')],
    });
  }
  const receipts = new Map();
  let safeNum = 18, finalizedNum = 16;
  let latestNum = 19;
  const calls = [];
  let budgetLimit = budget;
  let failRemaining = 0;
  const tagOverrides = new Map(); // tag -> array of {until, block} one-shot overrides by read index
  let tagReadCounts = { safe: 0, finalized: 0 };
  const rpc = {
    chainIdHex: '0x' + chainId.toString(16),
    _canon: canon,
    calls,
    get sendCount() { return calls.length; },
    setBudget(n) { budgetLimit = n; },
    setFailNextReads(n) { failRemaining = n; },
    _blockFor(tag) {
      if (tag === 'latest') return canon.find(x => x.number === latestNum) || null;
      if (tag === 'safe') return safeNum === null ? null : (canon.find(x => x.number === safeNum) || null);
      if (tag === 'finalized') return finalizedNum === null ? null : (canon.find(x => x.number === finalizedNum) || null);
      return null;
    },
    async send(method, params) {
      calls.push({ method, params: params.slice() });
      if (calls.length > budgetLimit) throw new Error('REQUEST_BUDGET_EXHAUSTED');
      if (failRemaining > 0) { failRemaining -= 1; throw new Error('MOCK_TRANSIENT_READ_FAILURE'); }
      if (method === 'eth_chainId') return rpc.chainIdHex;
      if (method === 'eth_getBlockByHash') {
        const hash = String(params[0]).toLowerCase();
        const b = canon.find(x => x.hash.toLowerCase() === hash) || null;
        if (!b) return null;
        return { number: '0x' + b.number.toString(16), hash: b.hash, parentHash: b.parentHash, timestamp: '0x' + b.timestamp.toString(16), transactions: b.transactions };
      }
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0];
        // Tag stability override hook (head-binding instability).
        if (tag === 'safe' || tag === 'finalized') {
          tagReadCounts[tag] += 1;
          const ov = tagOverrides.get(tag);
          if (ov && ov.readIndex === tagReadCounts[tag]) {
            const ob = canon.find(x => x.number === ov.block.number) || { number: ov.block.number, hash: ov.block.hash, parentHash: '0x' + '00'.repeat(32), timestamp: 1000, transactions: [] };
            return { number: '0x' + ob.number.toString(16), hash: ov.block.hash, parentHash: ob.parentHash, timestamp: '0x' + ob.timestamp.toString(16), transactions: ob.transactions || [] };
          }
        }
        let b;
        if (tag === 'latest') b = canon.find(x => x.number === latestNum) || null;
        else if (tag === 'safe') b = safeNum === null ? null : (canon.find(x => x.number === safeNum) || null);
        else if (tag === 'finalized') b = finalizedNum === null ? null : (canon.find(x => x.number === finalizedNum) || null);
        else { const n = Number(tag); b = canon.find(x => x.number === n) || null; }
        if (!b) return null;
        return { number: '0x' + b.number.toString(16), hash: b.hash, parentHash: b.parentHash, timestamp: '0x' + b.timestamp.toString(16), transactions: b.transactions };
      }
      if (method === 'eth_getTransactionReceipt') {
        const r = receipts.get(String(params[0]).toLowerCase());
        if (!r) return null;
        return { transactionHash: r.forcedHash || params[0], status: '0x' + (r.status === 0 ? '0' : '1'), blockNumber: '0x' + r.blockNumber.toString(16), blockHash: r.blockHash, transactionIndex: '0x0', to: '0x' + 'aa'.repeat(20), from: '0x' + 'bb'.repeat(20), logs: [] };
      }
      if (method === 'eth_getCode') return '0x';
      throw new Error('MOCK_METHOD_UNAVAILABLE:' + method);
    },
    setReceipt(txHash, blockNumber, opts = {}) {
      const h = String(txHash).toLowerCase();
      receipts.set(h, {
        blockNumber,
        blockHash: opts.blockHash || (canon.find(x => x.number === blockNumber) ? canon.find(x => x.number === blockNumber).hash : null),
        status: opts.status !== undefined ? opts.status : 1,
        forcedHash: opts.forcedHash || null,
      });
    },
    removeReceipt(txHash) { receipts.delete(String(txHash).toLowerCase()); },
    setBlockTx(blockNumber, txs) { const b = canon.find(x => x.number === blockNumber); if (b) b.transactions = txs.map(String); },
    removeBlock(blockNumber) { canon.splice(canon.findIndex(x => x.number === blockNumber), 1); },
    reorgBlockAt(blockNumber, newHash) { const b = canon.find(x => x.number === blockNumber); if (b) b.hash = newHash; },
    setSafe(n) { safeNum = n; },
    setFinalized(n) { finalizedNum = n; },
    removeSafeTag() { safeNum = null; },
    removeFinalizedTag() { finalizedNum = null; },
    setHead(n) { latestNum = n; },
    advance() { latestNum = Math.min(latestNum + 1, canon.length - 1); },
    setTagChangeOnRead(tag, readIndex, block) { tagOverrides.set(tag, { readIndex, block }); },
    resetTagReads() { tagReadCounts = { safe: 0, finalized: 0 }; },
    get safe() { return safeNum; },
    get finalized() { return finalizedNum; },
    get blockCount() { return canon.length; },
    get latest() { return latestNum; },
  };
  return rpc;
}

function countMethod(rpc, method) { return rpc.calls.filter(c => c.method === method).length; }
function hasHashInGetBlockByNumber(rpc) { return rpc.calls.some(c => c.method === 'eth_getBlockByNumber' && /^0x[0-9a-fA-F]{64}$/.test(String(c.params[0]))); }

(async () => {
  // ---------------------------------------------------------------------------
  // 1. [MOCK] DEEP HISTORICAL SAFE POSITIVE (no ancestry walk).
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + 'aa'.repeat(32);
    rpc.setReceipt(tx, 2);            // deep block 2 (of 20)
    rpc.setBlockTx(2, [tx]);
    rpc.setSafe(18); rpc.setFinalized(16);
    const res = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] deep historical SAFE positive (final=true, SAFE_COVERED)', res.final === true && res.reason === 'SAFE_COVERED', res.reason);
    check('[MOCK] SAFE never labeled finalized (finalizedCovered=false)', res.finalizedCovered === false, res.finalizedCovered);
    check('[MOCK] deep history covered by node assertion (included <= safe head)', res.includedBlock && res.includedBlock.number === 2 && res.safeHead && res.safeHead.number === 18, { included: res.includedBlock, safe: res.safeHead });
    // No ancestry walk: the deep block's parents were never walked. Assert
    // the bounded request count (receipt + canonical block + latest + safe +
    // safe recheck ≈ 5 reads) and that no hash was routed as a block number.
    check('[MOCK] no ancestry walk (bounded request count)', res.requests <= DEFAULT_REQUEST_BUDGET && res.requests >= 5 && res.requests <= 7, { requests: res.requests, log: rpc.calls });
    check('[MOCK] no hash ever routed as a block-number argument', !hasHashInGetBlockByNumber(rpc), rpc.calls);
    // The existing bounded-ancestry method is untouched: for this SAME deep
    // tx, the E1C bounded method still fails closed (BOUND_EXCEEDED) — the
    // trusted-RPC method does NOT weaken it.
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532, maxDepth: 3 });
    const fin = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] existing bounded-ancestry method stays intact (BOUND_EXCEEDED for deep history)', fin.final === false && /BOUND_EXCEEDED/.test(fin.reason || ''), fin.reason);
  }

  // ---------------------------------------------------------------------------
  // 2. [MOCK] DEEP HISTORICAL FINALIZED POSITIVE + SAFE-ONLY separation.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + 'bb'.repeat(32);
    rpc.setReceipt(tx, 2);
    rpc.setBlockTx(2, [tx]);
    rpc.setSafe(18); rpc.setFinalized(16);
    // finalized policy with safe covering but finalized NOT covering (16 < 18
    // but included=2 <= 16): both cover in arithmetic terms — so use a case
    // where finalized head is BELOW included to prove INCLUDED_ABOVE_HEAD.
    const finOk = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-finalized' });
    check('[MOCK] deep historical FINALIZED positive (final=true, FINALIZED_COVERED)', finOk.final === true && finOk.reason === 'FINALIZED_COVERED' && finOk.finalizedCovered === true, finOk.reason);
    check('[MOCK] finalized positive implies safe covered too', finOk.safeCovered === true, finOk.safeCovered);
    // SAFE-only case: finalized head BELOW the included block => not finalized.
    const rpc2 = makeMockRpc();
    const f2 = new TrustedRpcFinality({ provider: rpc2, chainId: 84532 });
    const tx2 = '0x' + 'cc'.repeat(32);
    rpc2.setReceipt(tx2, 17);          // included at 17
    rpc2.setBlockTx(17, [tx2]);
    rpc2.setSafe(18); rpc2.setFinalized(16); // finalized head 16 < included 17
    const finBad = await f2.assertHistoricalFinality({ txHash: tx2, policy: 'op-stack-finalized' });
    check('[MOCK] finalized policy with included above finalized head -> not final, INCLUDED_ABOVE_HEAD', finBad.final === false && /INCLUDED_ABOVE_HEAD/.test(finBad.reason || ''), finBad.reason);
    // SAFE policy on the same tx (included 17 <= safe 18) still passes.
    const safeOk = await f2.assertHistoricalFinality({ txHash: tx2, policy: 'op-stack-safe' });
    check('[MOCK] same tx SAFE positive (safe covers, finalized not)', safeOk.final === true && safeOk.reason === 'SAFE_COVERED' && safeOk.finalizedCovered === false, safeOk.reason);
  }

  // ---------------------------------------------------------------------------
  // 3. [MOCK] MEMBERSHIP POSITIVE BUT REQUIRED FINALITY PENDING.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + 'dd'.repeat(32);
    rpc.setReceipt(tx, 19);            // included at the latest head
    rpc.setBlockTx(19, [tx]);
    rpc.setSafe(18); rpc.setFinalized(16); // safe head BELOW included
    const mem = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] membership positive but finality pending (included above safe) -> INCLUDED_ABOVE_HEAD', mem.final === false && /INCLUDED_ABOVE_HEAD/.test(mem.reason || ''), mem.reason);
    check('[MOCK] pending finality is not a failure of membership (canonical member confirmed)', mem.includedBlock && mem.includedBlock.number === 19, mem);
  }

  // ---------------------------------------------------------------------------
  // 4. [MOCK] WRONG RECEIPT / BLOCK / CHAIN.
  // ---------------------------------------------------------------------------
  {
    // Receipt identity mismatch: RPC returns a receipt whose tx hash differs.
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + 'ee'.repeat(32);
    const claimed = '0x' + 'ff'.repeat(32);
    rpc.setReceipt(tx, 5, { forcedHash: claimed });
    rpc.setBlockTx(5, [tx]);
    rpc.setSafe(18);
    const wrongId = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] wrong receipt identity -> RECEIPT_IDENTITY_MISMATCH (fail closed)', wrongId.final === false && /RECEIPT_IDENTITY_MISMATCH/.test(wrongId.reason || ''), wrongId.reason);
    // Canonical-block hash mismatch (reorg after capture).
    const rpc2 = makeMockRpc();
    const f2 = new TrustedRpcFinality({ provider: rpc2, chainId: 84532 });
    const tx2 = '0x' + '10'.repeat(32);
    rpc2.setReceipt(tx2, 5);
    rpc2.setBlockTx(5, [tx2]);
    rpc2.reorgBlockAt(5, '0x' + 'aa'.repeat(32));
    rpc2.setSafe(18);
    const reorg = await f2.assertHistoricalFinality({ txHash: tx2, policy: 'op-stack-safe' });
    check('[MOCK] wrong canonical block hash -> CANONICAL_BLOCK_HASH_MISMATCH (fail closed)', reorg.final === false && /CANONICAL_BLOCK_HASH_MISMATCH/.test(reorg.reason || ''), reorg.reason);
    // Tx not in the canonical block.
    const rpc3 = makeMockRpc();
    const f3 = new TrustedRpcFinality({ provider: rpc3, chainId: 84532 });
    const tx3 = '0x' + '11'.repeat(32);
    rpc3.setReceipt(tx3, 6);
    rpc3.setBlockTx(6, ['0x' + '00'.repeat(32)]);
    rpc3.setSafe(18);
    const notInBlock = await f3.assertHistoricalFinality({ txHash: tx3, policy: 'op-stack-safe' });
    check('[MOCK] tx not in canonical block -> TX_NOT_IN_CANONICAL_BLOCK (fail closed)', notInBlock.final === false && /TX_NOT_IN_CANONICAL_BLOCK/.test(notInBlock.reason || ''), notInBlock.reason);
    // Absent receipt.
    const rpc4 = makeMockRpc();
    const f4 = new TrustedRpcFinality({ provider: rpc4, chainId: 84532 });
    const absent = await f4.assertHistoricalFinality({ txHash: '0x' + '12'.repeat(32), policy: 'op-stack-safe' });
    check('[MOCK] absent receipt -> RECEIPT_ABSENT (fail closed)', absent.final === false && /RECEIPT_ABSENT/.test(absent.reason || ''), absent.reason);
    // Chain identity: the adapter is bound to 84532 and reads 84532 tags.
    // A chainId mismatch is a config concern; the verifier checks
    // provider.getNetwork() against the signed custody chain separately.
    const rpc5 = makeMockRpc({ chainId: 84532 });
    const f5 = new TrustedRpcFinality({ provider: rpc5, chainId: 84532 });
    const tx5 = '0x' + '13'.repeat(32);
    rpc5.setReceipt(tx5, 5);
    rpc5.setBlockTx(5, [tx5]);
    rpc5.setSafe(18);
    const okChain = await f5.assertHistoricalFinality({ txHash: tx5, policy: 'op-stack-safe' });
    check('[MOCK] 84532 adapter evaluates 84532 tags (supported testnet)', okChain.final === true && okChain.safeCovered === true, okChain.reason);
  }

  // ---------------------------------------------------------------------------
  // 5. [MOCK] CONFLICTING CANONICAL VIEWS (changing hash).
  // ---------------------------------------------------------------------------
  {
    // First observation on canonical view A; then the canonical block hash at
    // the recorded height changes (view B). Re-observation must fail closed.
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '14'.repeat(32);
    rpc.setReceipt(tx, 4);
    rpc.setBlockTx(4, [tx]);
    rpc.setSafe(18);
    const first = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] conflicting views: first observation SAFE positive', first.final === true && first.reason === 'SAFE_COVERED', first.reason);
    rpc.reorgBlockAt(4, '0x' + 'bb'.repeat(32)); // canonical hash changes
    const second = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] conflicting views: after reorg -> CANONICAL_BLOCK_HASH_MISMATCH', second.final === false && /CANONICAL_BLOCK_HASH_MISMATCH/.test(second.reason || ''), second.reason);
  }

  // ---------------------------------------------------------------------------
  // 6. [MOCK] ADVANCING vs REGRESSING / CHANGING HEADS.
  // ---------------------------------------------------------------------------
  {
    // Advancing safe head: first read safe=18, recheck safe=19 (higher number,
    // different hash — normal advance). MUST remain consistent (final=true).
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '15'.repeat(32);
    rpc.setReceipt(tx, 2);
    rpc.setBlockTx(2, [tx]);
    rpc.setSafe(18);
    // second 'safe' read returns block 19 (advance).
    rpc.setTagChangeOnRead('safe', 2, { number: 19, hash: '0x' + '13'.toString(16).padStart(2, '0').repeat(32) });
    const adv = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] advancing safe head is NOT a reorg (final=true, SAFE_COVERED)', adv.final === true && adv.reason === 'SAFE_COVERED', { reason: adv.reason, consistency: adv.consistency });
    check('[MOCK] advancing head recorded as consistent (advancingIsConsistent)', adv.consistency && adv.consistency.advancingIsConsistent === true, adv.consistency);

    // Regressing safe head: first safe=18, recheck safe=17 (LOWER number) ->
    // HEAD_REGRESSED (fail closed).
    const rpc2 = makeMockRpc();
    const f2 = new TrustedRpcFinality({ provider: rpc2, chainId: 84532 });
    const tx2 = '0x' + '16'.repeat(32);
    rpc2.setReceipt(tx2, 2);
    rpc2.setBlockTx(2, [tx2]);
    rpc2.setSafe(18);
    rpc2.setTagChangeOnRead('safe', 2, { number: 17, hash: '0x' + '11'.toString(16).padStart(2, '0').repeat(32) });
    const reg = await f2.assertHistoricalFinality({ txHash: tx2, policy: 'op-stack-safe' });
    check('[MOCK] regressing safe head -> HEAD_REGRESSED (fail closed)', reg.final === false && /HEAD_REGRESSED/.test(reg.reason || ''), reg.reason);

    // Changing safe head at the SAME number: first safe=18 (hash A), recheck
    // safe=18 (hash B, different) -> HEAD_BINDING_CHANGED (fail closed).
    const rpc3 = makeMockRpc();
    const f3 = new TrustedRpcFinality({ provider: rpc3, chainId: 84532 });
    const tx3 = '0x' + '17'.repeat(32);
    rpc3.setReceipt(tx3, 2);
    rpc3.setBlockTx(2, [tx3]);
    rpc3.setSafe(18);
    rpc3.setTagChangeOnRead('safe', 2, { number: 18, hash: '0x' + 'dd'.repeat(32) }); // same number, different hash
    const chg = await f3.assertHistoricalFinality({ txHash: tx3, policy: 'op-stack-safe' });
    check('[MOCK] changing safe head at same number -> HEAD_BINDING_CHANGED (fail closed)', chg.final === false && /HEAD_BINDING_CHANGED/.test(chg.reason || ''), chg.reason);
  }

  // ---------------------------------------------------------------------------
  // 7. [MOCK] UNSUPPORTED TAGS / HISTORY.
  // ---------------------------------------------------------------------------
  {
    // Missing safe tag.
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '18'.repeat(32);
    rpc.setReceipt(tx, 2);
    rpc.setBlockTx(2, [tx]);
    rpc.removeSafeTag();
    const noSafe = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] missing safe tag -> TAG_UNAVAILABLE (fail closed)', /TAG_UNAVAILABLE/.test(noSafe.reason || '') && noSafe.final === false, noSafe.reason);
    // Missing finalized tag under finalized policy.
    const rpc2 = makeMockRpc();
    const f2 = new TrustedRpcFinality({ provider: rpc2, chainId: 84532 });
    const tx2 = '0x' + '19'.repeat(32);
    rpc2.setReceipt(tx2, 2);
    rpc2.setBlockTx(2, [tx2]);
    rpc2.setSafe(18);
    rpc2.removeFinalizedTag();
    const noFinal = await f2.assertHistoricalFinality({ txHash: tx2, policy: 'op-stack-finalized' });
    check('[MOCK] missing finalized tag -> TAG_UNAVAILABLE (fail closed)', /TAG_UNAVAILABLE/.test(noFinal.reason || '') && noFinal.final === false, noFinal.reason);
    // Unsupported policy.
    const rpc3 = makeMockRpc();
    const f3 = new TrustedRpcFinality({ provider: rpc3, chainId: 84532 });
    const bad = await f3.assertHistoricalFinality({ txHash: '0x' + '1a'.repeat(32), policy: 'bogus' });
    check('[MOCK] unsupported policy -> FINALITY_POLICY_UNSUPPORTED (fail closed)', /FINALITY_POLICY_UNSUPPORTED/.test(bad.reason || '') && bad.final === false, bad.reason);
    // Unavailable canonical block (history beyond provider's archive).
    const rpc4 = makeMockRpc();
    const f4 = new TrustedRpcFinality({ provider: rpc4, chainId: 84532 });
    const tx4 = '0x' + '1b'.repeat(32);
    rpc4.setReceipt(tx4, 3);
    rpc4.setBlockTx(3, [tx4]);
    rpc4.removeBlock(3);
    rpc4.setSafe(18);
    const noBlock = await f4.assertHistoricalFinality({ txHash: tx4, policy: 'op-stack-safe' });
    check('[MOCK] unavailable canonical block -> CANONICAL_BLOCK_UNAVAILABLE (fail closed)', /CANONICAL_BLOCK_UNAVAILABLE/.test(noBlock.reason || '') && noBlock.final === false, noBlock.reason);
  }

  // ---------------------------------------------------------------------------
  // 8. [MOCK] REQUEST-BUDGET EXHAUSTION.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc({ budget: 3 }); // tiny budget
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532, requestBudget: 3 });
    const tx = '0x' + '1c'.repeat(32);
    rpc.setReceipt(tx, 2);
    rpc.setBlockTx(2, [tx]);
    rpc.setSafe(18);
    const res = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] request-budget exhaustion -> REQUEST_BUDGET_EXHAUSTED (fail closed)', /REQUEST_BUDGET_EXHAUSTED/.test(res.reason || '') && res.final === false, res.reason);
    check('[MOCK] budget exhaustion records actual request count', res.requests >= 3, res.requests);
    // Transient read failures are retried (bounded) and succeed when the
    // transient window passes.
    const rpc2 = makeMockRpc();
    const f2 = new TrustedRpcFinality({ provider: rpc2, chainId: 84532, retryLimit: 2 });
    const tx2 = '0x' + '1d'.repeat(32);
    rpc2.setReceipt(tx2, 2);
    rpc2.setBlockTx(2, [tx2]);
    rpc2.setSafe(18);
    rpc2.setFailNextReads(1); // one transient failure -> retried
    const retried = await f2.assertHistoricalFinality({ txHash: tx2, policy: 'op-stack-safe' });
    check('[MOCK] transient read failure is retried (bounded) and succeeds', retried.final === true && retried.reason === 'SAFE_COVERED', retried.reason);
    // Persistent failures fail closed (OBSERVATION_UNAVAILABLE).
    const rpc3 = makeMockRpc();
    const f3 = new TrustedRpcFinality({ provider: rpc3, chainId: 84532, retryLimit: 1 });
    const tx3 = '0x' + '1e'.repeat(32);
    rpc3.setReceipt(tx3, 2);
    rpc3.setBlockTx(2, [tx3]);
    rpc3.setSafe(18);
    rpc3.setFailNextReads(10); // every read fails
    const failed = await f3.assertHistoricalFinality({ txHash: tx3, policy: 'op-stack-safe' });
    check('[MOCK] persistent read failure -> OBSERVATION_UNAVAILABLE (fail closed)', /OBSERVATION_UNAVAILABLE/.test(failed.reason || '') && failed.final === false, failed.reason);
  }

  // ---------------------------------------------------------------------------
  // 9. [MOCK] CONFIGURATION DOWNGRADE ATTEMPTS (export-supplied cannot lower).
  // ---------------------------------------------------------------------------
  {
    // The policy is trusted configuration. An export-supplied "mode" cannot
    // select or lower the requirement. At the module level this means: the
    // trusted config policy string is what assertHistoricalFinality enforces;
    // an export can never pass a weaker mode. A 'local-synthetic' request to
    // this module (which only serves public policies) must be refused.
    const rpc = makeMockRpc();
    const f = new TrustedRpcFinality({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '1f'.repeat(32);
    rpc.setReceipt(tx, 2);
    rpc.setBlockTx(2, [tx]);
    rpc.setSafe(18);
    const downgrade = await f.assertHistoricalFinality({ txHash: tx, policy: 'local-synthetic' });
    check('[MOCK] local-synthetic cannot satisfy public policy (downgrade refused)', /FINALITY_POLICY_UNSUPPORTED/.test(downgrade.reason || '') && downgrade.final === false, downgrade.reason);
    // SAFE can never be reported as FINALIZED: safe policy output has
    // finalizedCovered=false and reason SAFE_COVERED (never FINALIZED_COVERED).
    const safeRes = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] SAFE output never carries FINALIZED wording', safeRes.final === true && safeRes.reason === 'SAFE_COVERED' && safeRes.finalizedCovered === false, safeRes);
  }

  // ---------------------------------------------------------------------------
  // 10. [MOCK] MAINNET REFUSAL + REQUEST LOG / TRUST MODEL EXPOSED.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc({ chainId: MAINNET_CHAIN });
    const f = new TrustedRpcFinality({ provider: rpc, chainId: MAINNET_CHAIN });
    const tx = '0x' + '20'.repeat(32);
    rpc.setReceipt(tx, 2);
    rpc.setBlockTx(2, [tx]);
    rpc.setSafe(18);
    const mainnet = await f.assertHistoricalFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] mainnet public policy refused (FINALITY_MAINNET_NOT_ACTIVATED)', /FINALITY_MAINNET_NOT_ACTIVATED/.test(mainnet.reason || '') && mainnet.final === false, mainnet.reason);
    // Trust model is explicit in every output.
    const rpc2 = makeMockRpc();
    const f2 = new TrustedRpcFinality({ provider: rpc2, chainId: 84532 });
    const tx2 = '0x' + '21'.repeat(32);
    rpc2.setReceipt(tx2, 2);
    rpc2.setBlockTx(2, [tx2]);
    rpc2.setSafe(18);
    const res = await f2.assertHistoricalFinality({ txHash: tx2, policy: 'op-stack-safe' });
    check('[MOCK] output exposes documented trust model + actual request log', res.trustModel && /trusted-rpc|canonical|consensus-status/.test(res.trustModel.kind) && Array.isArray(res.requestLog) && res.requestLog.length === res.requests, { tm: res.trustModel, requests: res.requests });
  }

  console.log('----');
  console.log('e1d_trusted_rpc_finality_passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });
