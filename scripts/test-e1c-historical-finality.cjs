'use strict';
// E1C focused tests — historical-membership module + explicit method dispatch
// (worker/d2-historical-finality.js).
//
// Labeling (per task):
//   [MOCK] = labeled mock RPC simulations of canonical blocks, receipts,
//            reorgs, missing history, deep history — never real-chain results.
//
// The module under test is worker/d2-historical-finality.js:
//   - HistoricalMembership.checkMembership — canonical membership observation
//     (receipt present, canonical block hash match, tx in canonical block).
//   - assertPublicFinality — DISTINCT public safe/finalized assertion with
//     head-binding/consistency checks; never satisfied by membership alone.
//   - establish — worker-facing split: membership and finality findings are
//     kept separate in every output.
//   - getBlockByRef — explicit method dispatch: 64-hex hash -> eth_getBlockByHash;
//     tag / hex-quantity / decimal number -> eth_getBlockByNumber.
//
// Scenarios required by the task:
//   - deep-history positive membership (no ancestry walk needed; canonical
//     block at recorded height is the source of membership)
//   - tampering (canonical block hash mismatch; tx removed from canonical block)
//   - unavailable history (canonical block / head / receipt absent)
//   - changing canonical views (reorg: block hash changes between observations)
//   - policy-downgrade prevention (membership never satisfies op-stack-*; an
//     op-stack-* configured requirement is never lowered to a membership pass)
//   - mainnet refusal (chain 1 refused; no public policy on mainnet)
//   - correct method dispatch (hash routed to eth_getBlockByHash)
//   - actual bounded RPC work measured (no invented "2 reads" claim)

'use strict';

const { HistoricalMembership, getBlockByRef, MAINNET_CHAIN } = require('../worker/d2-historical-finality');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

// A labeled mock JSON-RPC provider that records EVERY send() so tests can
// assert the exact RPC methods used and the actual number of calls.
function makeMockRpc({ chainId = 84532 } = {}) {
  const canon = [];
  for (let i = 0; i < 20; i++) {
    canon.push({
      number: i,
      hash: '0x' + i.toString(16).padStart(2, '0').repeat(32),
      parentHash: i === 0 ? null : '0x' + (i - 1).toString(16).padStart(2, '0').repeat(32),
      timestamp: 1000 + i,
      transactions: [ '0x' + ('f' + i).padStart(64, 'f') ],
    });
  }
  const receipts = new Map();
  let safeNum = 18, finalizedNum = 16;
  const calls = [];
  const rpc = {
    chainIdHex: '0x' + chainId.toString(16),
    _canon: canon,
    calls,
    async send(method, params) {
      calls.push({ method, params: params.slice() });
      if (method === 'eth_chainId') return rpc.chainIdHex;
      if (method === 'eth_getBlockByHash') {
        const hash = String(params[0]).toLowerCase();
        const b = canon.find(x => x.hash.toLowerCase() === hash) || null;
        if (!b) return null;
        return { number: '0x' + b.number.toString(16), hash: b.hash, parentHash: b.parentHash, timestamp: '0x' + b.timestamp.toString(16), transactions: b.transactions };
      }
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0];
        let b;
        if (tag === 'latest') b = canon[canon.length - 1];
        else if (tag === 'safe') b = canon.find(x => x.number === safeNum) || null;
        else if (tag === 'finalized') b = canon.find(x => x.number === finalizedNum) || null;
        else { const n = Number(tag); b = canon.find(x => x.number === n) || null; }
        if (!b) return null;
        return { number: '0x' + b.number.toString(16), hash: b.hash, parentHash: b.parentHash, timestamp: '0x' + b.timestamp.toString(16), transactions: b.transactions };
      }
      if (method === 'eth_getTransactionReceipt') {
        const r = receipts.get(String(params[0]).toLowerCase());
        if (!r) return null;
        return { transactionHash: params[0], status: '0x1', blockNumber: '0x' + r.blockNumber.toString(16), blockHash: r.capturedHash, transactionIndex: '0x0', to: '0x' + 'aa'.repeat(20), from: '0x' + 'bb'.repeat(20), logs: [] };
      }
      if (method === 'eth_getCode') return '0x';
      throw new Error('MOCK_METHOD_UNAVAILABLE:' + method);
    },
    setReceipt(txHash, blockNumber, opts = {}) {
      const h = String(txHash).toLowerCase();
      receipts.set(h, {
        blockNumber,
        capturedHash: opts.blockHash || (canon.find(x => x.number === blockNumber) ? canon.find(x => x.number === blockNumber).hash : null),
      });
    },
    removeReceipt(txHash) { receipts.delete(String(txHash).toLowerCase()); },
    setBlockTx(blockNumber, txs) { const b = canon.find(x => x.number === blockNumber); if (b) b.transactions = txs.map(String); },
    removeBlock(blockNumber) { canon.splice(canon.findIndex(x => x.number === blockNumber), 1); },
    // Reorg: change the canonical hash of a block AFTER a receipt captured it.
    reorgBlockAt(blockNumber, newHash) { const b = canon.find(x => x.number === blockNumber); if (b) b.hash = newHash; },
    setSafe(n) { safeNum = n; },
    setFinalized(n) { finalizedNum = n; },
    removeSafeTag() { safeNum = null; },
    removeFinalizedTag() { finalizedNum = null; },
    advance() {
      const last = canon[canon.length - 1];
      canon.push({ number: last.number + 1, hash: '0x' + (last.number + 1).toString(16).padStart(2, '0').repeat(32), parentHash: last.hash, timestamp: last.timestamp + 1, transactions: ['0x' + ('f' + (last.number + 1)).padStart(64, 'f')] });
    },
    get safe() { return safeNum; },
    get finalized() { return finalizedNum; },
    get blockCount() { return canon.length; },
  };
  return rpc;
}

// count calls of a method in the recorded log
function countMethod(rpc, method) { return rpc.calls.filter(c => c.method === method).length; }
function hasHashToGetBlockByHash(rpc) { return rpc.calls.some(c => c.method === 'eth_getBlockByHash' && /^0x[0-9a-fA-F]{64}$/.test(String(c.params[0]))); }
function hasHashInGetBlockByNumber(rpc) { return rpc.calls.some(c => c.method === 'eth_getBlockByNumber' && /^0x[0-9a-fA-F]{64}$/.test(String(c.params[0]))); }

(async () => {
  // ---------------------------------------------------------------------------
  // 1. [MOCK] EXPLICIT METHOD DISPATCH.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    // A block hash must route to eth_getBlockByHash, never eth_getBlockByNumber.
    const h = '0x' + '0b'.repeat(32); // block 11's hash
    const block = await getBlockByRef(rpc, h);
    check('[MOCK] hash ref routes to eth_getBlockByHash', hasHashToGetBlockByHash(rpc) && !hasHashInGetBlockByNumber(rpc), rpc.calls);
    check('[MOCK] hash lookup resolves correct block number', block && block.number === 11, block);
    rpc.calls.length = 0;
    // A tag and a hex-quantity number route to eth_getBlockByNumber.
    const safe = await getBlockByRef(rpc, 'safe');
    const byNumber = await getBlockByRef(rpc, '0x5');
    check('[MOCK] tag routes to eth_getBlockByNumber', safe && safe.number === 18 && countMethod(rpc, 'eth_getBlockByNumber') === 2, rpc.calls);
    check('[MOCK] hex-quantity number resolves', byNumber && byNumber.number === 5, byNumber);
    // A decimal number also routes to eth_getBlockByNumber (hex-quantity).
    rpc.calls.length = 0;
    const byDec = await getBlockByRef(rpc, 3);
    check('[MOCK] decimal number routes to eth_getBlockByNumber', byDec && byDec.number === 3 && countMethod(rpc, 'eth_getBlockByNumber') === 1, rpc.calls);
  }

  // ---------------------------------------------------------------------------
  // 2. [MOCK] DEEP-HISTORY POSITIVE MEMBERSHIP (no ancestry walk required).
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532 });
    const tx = '0x' + 'ab'.repeat(32);
    rpc.setReceipt(tx, 2); // deep block 2; canonical block contains tx '0xfff2...'
    rpc.setBlockTx(2, [tx]); // make the tx an actual member
    const res = await m.checkMembership(tx);
    check('[MOCK] deep-history canonical membership PASS', res.member === true && res.reason === 'CANONICAL_MEMBER', res);
    check('[MOCK] membership records canonical details', res.details && res.details.receiptBlockNumber === 2 && res.details.txInBlock === true, res.details);
    // RPC work: receipt lookup + canonical block + head read = 3 calls,
    // all bounded (no ancestry walk). Assert the actual count and methods.
    const recv = countMethod(rpc, 'eth_getTransactionReceipt');
    const blkByNum = countMethod(rpc, 'eth_getBlockByNumber');
    check('[MOCK] membership RPC work is bounded and measured (receipt+block+head)', recv === 1 && blkByNum === 2, { recv, blkByNum, calls: rpc.calls });
  }

  // ---------------------------------------------------------------------------
  // 3. [MOCK] TAMPERING — canonical block hash mismatch and tx removed.
  // ---------------------------------------------------------------------------
  {
    // 3a. Receipt captures block hash; canonical block hash then changes (reorg
    //     of the SAME block number to a different hash). Membership fails with
    //     CANONICAL_BLOCK_HASH_MISMATCH (confirmed mismatch, not missing history).
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532 });
    const tx = '0x' + 'cd'.repeat(32);
    rpc.setReceipt(tx, 5);
    rpc.setBlockTx(5, [tx]);
    rpc.reorgBlockAt(5, '0x' + 'deadbeef'.repeat(4) + '11'.repeat(24)); // canonical hash changes AFTER capture
    const res = await m.checkMembership(tx);
    check('[MOCK] tampered canonical block hash -> CANONICAL_BLOCK_HASH_MISMATCH (member=false)', res.member === false && res.reason === 'CANONICAL_BLOCK_HASH_MISMATCH', res);
    check('[MOCK] mismatch is distinct from missing history', res.reason !== 'CANONICAL_BLOCK_UNAVAILABLE' && res.reason !== 'HEAD_UNAVAILABLE', res.reason);
    // 3b. Tx is NOT in the canonical block's transactions list.
    const rpc2 = makeMockRpc();
    const m2 = new HistoricalMembership({ provider: rpc2, chainId: 84532 });
    const tx2 = '0x' + 'ef'.repeat(32);
    rpc2.setReceipt(tx2, 6);
    rpc2.setBlockTx(6, ['0x' + '00'.repeat(32)]); // canonical block does NOT contain tx2
    const res2 = await m2.checkMembership(tx2);
    check('[MOCK] tx not in canonical block -> TX_NOT_IN_CANONICAL_BLOCK (member=false)', res2.member === false && res2.reason === 'TX_NOT_IN_CANONICAL_BLOCK', res2);
  }

  // ---------------------------------------------------------------------------
  // 4. [MOCK] UNAVAILABLE HISTORY (missing block / head / receipt).
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '10'.repeat(32);
    rpc.setReceipt(tx, 3);
    rpc.setBlockTx(3, [tx]);
    rpc.removeBlock(3); // canonical block at that height is unavailable
    const noBlock = await m.checkMembership(tx);
    check('[MOCK] unavailable canonical block -> CANONICAL_BLOCK_UNAVAILABLE (member=false, missing history)', noBlock.member === false && noBlock.reason === 'CANONICAL_BLOCK_UNAVAILABLE', noBlock);
    // Missing receipt.
    const txAbsent = '0x' + '11'.repeat(32);
    const noReceipt = await m.checkMembership(txAbsent);
    check('[MOCK] absent receipt -> RECEIPT_ABSENT (member=false)', noReceipt.member === false && noReceipt.reason === 'RECEIPT_ABSENT', noReceipt);
    // Missing history is never reported as a confirmed mismatch.
    check('[MOCK] missing history distinct from mismatch', noBlock.reason !== 'CANONICAL_BLOCK_HASH_MISMATCH' && noBlock.reason !== 'TX_NOT_IN_CANONICAL_BLOCK', noBlock.reason);
  }

  // ---------------------------------------------------------------------------
  // 5. [MOCK] CHANGING CANONICAL VIEWS (reorg).
  // ---------------------------------------------------------------------------
  {
    // First observation: member. Then the canonical view changes (block hash
    // reorged at same height). A re-observation must fail closed.
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '20'.repeat(32);
    rpc.setReceipt(tx, 4);
    rpc.setBlockTx(4, [tx]);
    const first = await m.checkMembership(tx);
    check('[MOCK] changing view: first observation member', first.member === true, first);
    rpc.reorgBlockAt(4, '0x' + 'aa'.repeat(32));
    const second = await m.checkMembership(tx);
    check('[MOCK] changing view: after reorg -> CANONICAL_BLOCK_HASH_MISMATCH (member=false)', second.member === false && second.reason === 'CANONICAL_BLOCK_HASH_MISMATCH', second);
  }

  // ---------------------------------------------------------------------------
  // 6. [MOCK] POLICY-DOWNGRADE PREVENTION — membership never satisfies policy.
  // ---------------------------------------------------------------------------
  {
    // Deep-history member, but far below the safe head: assertPublicFinality
    // must NOT return final:true just because membership passed. Use a bounded
    // adapter (maxDepth=3) so the ancestry walk to the head (depth 16) exceeds
    // the bound and fails closed — exactly the E1B Sepolia scenario where the
    // committed txs are ~100k blocks deep.
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532, maxDepth: 3 });
    const tx = '0x' + '30'.repeat(32);
    rpc.setReceipt(tx, 2);
    rpc.setBlockTx(2, [tx]);
    rpc.setSafe(18);
    rpc.setFinalized(16);
    const mem = await m.checkMembership(tx);
    const fin = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] deep-history membership PASS does NOT satisfy safe policy', mem.member === true && fin.final === false, { mem, fin });
    check('[MOCK] safe assertion reports BOUND_EXCEEDED (bounded walk, fail closed)', /BOUND_EXCEEDED/.test(fin.reason || ''), fin.reason);
    const finFin = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-finalized' });
    check('[MOCK] deep-history membership PASS does NOT satisfy finalized policy', finFin.final === false && /BOUND_EXCEEDED/.test(finFin.reason || ''), finFin.reason);
    // establish() keeps membership and finality findings separate.
    const est = await m.establish(tx, 'op-stack-safe');
    check('[MOCK] establish returns separate membership + finality findings', est.membership && est.membership.member === true && est.finality && est.finality.final === false, { m: est.membership, f: est.finality });
    check('[MOCK] membership never drives final:true', !(est.membership.member === true && est.finality.final === true), est);
    // An op-stack-* configured requirement is never downgraded to local.
    const estLocal = await m.establish(tx, 'local-confirmations');
    check('[MOCK] local policy path never returns public finality', estLocal.finality.final === false && /PUBLIC_NOT_ACTIVATED/.test(estLocal.finality.reason || ''), estLocal.finality);
    check('[MOCK] membership PASS with local policy is never labeled final', !(estLocal.membership.member === true && estLocal.finality.final === true), estLocal);
  }

  // ---------------------------------------------------------------------------
  // 7. [MOCK] PUBLIC SAFE/FINALIZED RECENT-HEAD POSITIVE (distinct assertion).
  // ---------------------------------------------------------------------------
  {
    // Recent-head case: receipt at block 17, safe head 18 (depth 1) covers it;
    // finalized head 16 does not (17 > 16). Safe assertion must pass, finalized
    // must fail with SAFE_ONLY. Head-binding recheck keeps tags stable.
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '40'.repeat(32);
    rpc.setReceipt(tx, 17);
    rpc.setBlockTx(17, [tx]);
    rpc.setSafe(18); rpc.setFinalized(16);
    const mem = await m.checkMembership(tx);
    const safe = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] recent-head safe assertion PASS (final=true, SAFE_COVERED)', mem.member === true && safe.final === true && safe.reason === 'SAFE_COVERED', safe);
    check('[MOCK] SAFE never labeled finalized (finalizedCovered=false)', safe.finalizedCovered === false, safe);
    const fin = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-finalized' });
    check('[MOCK] finalized not satisfied by safe coverage alone -> SAFE_ONLY', fin.final === false && /SAFE_ONLY/.test(fin.reason || '') && fin.safeCovered === true && fin.finalizedCovered === false, fin);
    // advance finalized head to 18 -> both covered.
    rpc.setFinalized(18);
    const fin2 = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-finalized' });
    check('[MOCK] finalized satisfied after finalized head advance (FINALIZED_COVERED)', fin2.final === true && fin2.finalizedCovered === true && fin2.reason === 'FINALIZED_COVERED', fin2.reason);
    // Missing tags fail closed.
    rpc.removeSafeTag();
    const noTag = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] missing safe tag -> TAG_UNAVAILABLE (fail closed)', /TAG_UNAVAILABLE/.test(noTag.reason || '') && noTag.final === false, noTag.reason);
  }

  // ---------------------------------------------------------------------------
  // 8. [MOCK] HEAD-BINDING CHANGE — tagged head unstable across recheck.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '50'.repeat(32);
    rpc.setReceipt(tx, 17);
    rpc.setBlockTx(17, [tx]);
    rpc.setSafe(18); rpc.setFinalized(18);
    // Force the safe tag to CHANGE between the first read and the recheck:
    // we make the first read return safe=18 and then change safe to 19 before
    // the recheck runs. Simpler: directly test that when the recheck sees a
    // different hash at the same number, HEAD_BINDING_CHANGED fires.
    // We emulate by registering a one-shot override: the second 'safe' read
    // returns a DIFFERENT block at the same number.
    let safeReads = 0;
    const orig = rpc.send.bind(rpc);
    rpc.send = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === 'safe') {
        safeReads += 1;
        if (safeReads === 2) {
          // second read: same number 18, DIFFERENT hash (changed canonical view)
          return { number: '0x12', hash: '0x' + 'bb'.repeat(32), parentHash: '0x' + '11'.repeat(32), timestamp: '0x1000', transactions: [] };
        }
      }
      return orig(method, params);
    };
    const safe = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] unstable tagged head across recheck -> HEAD_BINDING_CHANGED (fail closed)', /HEAD_BINDING_CHANGED/.test(safe.reason || '') && safe.final === false, safe.reason);
  }

  // ---------------------------------------------------------------------------
  // 9. [MOCK] MAINNET REFUSAL + UNSUPPORTED POLICY.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc({ chainId: MAINNET_CHAIN });
    const m = new HistoricalMembership({ provider: rpc, chainId: MAINNET_CHAIN });
    const tx = '0x' + '60'.repeat(32);
    rpc.setReceipt(tx, 3);
    rpc.setBlockTx(3, [tx]);
    const fin = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-safe' });
    check('[MOCK] mainnet public policy refused (FINALITY_MAINNET_NOT_ACTIVATED)', /FINALITY_MAINNET_NOT_ACTIVATED/.test(fin.reason || '') && fin.final === false, fin.reason);
    const est = await m.establish(tx, 'op-stack-safe');
    check('[MOCK] establish refuses mainnet for both findings', /FINALITY_MAINNET_NOT_ACTIVATED/.test(est.membership.reason || '') && /FINALITY_MAINNET_NOT_ACTIVATED/.test(est.finality.reason || ''), est);
    const rpc2 = makeMockRpc();
    const m2 = new HistoricalMembership({ provider: rpc2, chainId: 84532 });
    const bad = await m2.assertPublicFinality({ txHash: tx, policy: 'bogus' });
    check('[MOCK] unsupported policy -> FINALITY_POLICY_UNSUPPORTED (fail closed)', /FINALITY_POLICY_UNSUPPORTED/.test(bad.reason || '') && bad.final === false, bad.reason);
  }

  // ---------------------------------------------------------------------------
  // 10. [MOCK] RPC WORK IS BOUNDED AND MEASURED on the public assertion path.
  // ---------------------------------------------------------------------------
  {
    const rpc = makeMockRpc();
    const m = new HistoricalMembership({ provider: rpc, chainId: 84532 });
    const tx = '0x' + '70'.repeat(32);
    rpc.setReceipt(tx, 17);
    rpc.setBlockTx(17, [tx]);
    rpc.setSafe(18); rpc.setFinalized(18);
    const res = await m.assertPublicFinality({ txHash: tx, policy: 'op-stack-finalized' });
    check('[MOCK] finalized positive returns structured result with heads', res.final === true && res.safeHead && res.finalizedHead && res.includedBlock, res);
    // Bounded: no unbounded crawl. The finality path issues a bounded number of
    // block reads (receipt, canonical block, latest, safe, finalized, safe
    // recheck, finalized recheck). Assert no call is a hash passed as number.
    check('[MOCK] no hash ever routed as a block-number argument', !hasHashInGetBlockByNumber(rpc), rpc.calls);
    check('[MOCK] finality path reports actual measured work (calls recorded)', rpc.calls.length >= 5 && rpc.calls.length <= 12, { calls: rpc.calls.length, log: rpc.calls });
  }

  console.log('----');
  console.log('e1c_historical_finality_passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });
