'use strict';
// E1B read-only Base Sepolia observation — chain 84532.
//
// READ-ONLY. No broadcast, no deployment, no funding, no spending: this
// script only issues eth_* READ calls to the public Base Sepolia RPC
// (https://sepolia.base.org). It observes the existing committed transaction
// hashes from evidence/terminal-state-escrows.json (fundTx, refundTx,
// disputeTx) and records:
//   - chain identity (eth_chainId must be 84532)
//   - receipt existence + canonical block references
//   - OP Stack safe/finalized head coverage via the E1A FinalityAdapter
//     (bounded ancestry walk; TAG_UNAVAILABLE / BOUND_EXCEEDED fail closed)
//   - arithmetic head positions (non-walking coverage note, clearly labeled)
//   - observation time and configured policy
//   - head references and RPC trust assumptions
//
// The output is an RPC observation, NOT independent consensus reconstruction:
// the safe/finalized tags are claims made by the node/sequencer we connect
// to. This is exactly the documented trust model of the E1A adapter and the
// E1B verifier integration.
//
// Bounded traversal: these committed transactions are ~100k blocks deep,
// far beyond the adapter's default bounded ancestry window (256). The bounded
// walk therefore reports BOUND_EXCEEDED and FAILS CLOSED — we do NOT widen or
// remove the safety check to make old history pass. As a separate, clearly
// labeled NON-WALKING note we record the arithmetic head positions (included
// block number vs safe/finalized head numbers), which is not ancestry proof.

'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { observeFinality } = require('../verifier/v4-finality-adapter');

const ROOT = path.resolve(__dirname, '..');
const RPC_URL = 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const MAX_DEPTH = 256;
const headRef = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
// Committed transaction hashes from evidence/terminal-state-escrows.json.
const escrows = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/terminal-state-escrows.json'), 'utf8'));

const OBS = {
  kind: 'read-only-rpc-observation',
  chainId: CHAIN_ID,
  rpc: RPC_URL,
  headRef,
  observedAt: new Date().toISOString(),
  scope: 'Committed Base Sepolia custody transactions (evidence/terminal-state-escrows.json). Read-only eth_* calls only; no broadcast/write.',
  trustAssumptions: [
    'The configured RPC (sepolia.base.org) is a TRUSTED source of receipts, canonical blocks, and the safe/finalized tags.',
    'Safe/finalized head coverage is an RPC observation, NOT independent consensus reconstruction (no L1 state-root replay).',
    'A single provider was used; disagreement detection across independent providers is out of scope for this checkpoint.',
    'Bounded ancestry walk with maxDepth=' + MAX_DEPTH + '. Old evidence beyond the bound reports BOUND_EXCEEDED (fail closed); arithmetic head positions are recorded separately as a non-walking coverage note, not as ancestry-walk proof.',
  ],
  maxDepth: MAX_DEPTH,
  transactions: [],
  observations: [],
};

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: false, batchMaxCount: 1 });
  const network = await provider.getNetwork();
  OBS.rpcChainId = Number(network.chainId);

  for (const [name, rec] of [['refunded', escrows.refunded], ['disputed', escrows.disputed]]) {
    for (const [role, txHash] of [['funding', rec.fundTx], ['settlement', roleOf(name, rec)]]) {
      if (!txHash) continue;
      const txObs = await observeTx(provider, txHash, role, name);
      OBS.transactions.push(txObs);
      for (const policy of ['op-stack-safe', 'op-stack-finalized']) {
        const fin = await observeFinality({ provider, chainId: CHAIN_ID, policy, txHash, maxDepth: MAX_DEPTH });
        const arithmetic = await arithmeticNote(provider, fin, txHash);
        OBS.observations.push({
          label: name + '.' + role,
          txHash,
          policy,
          final: fin.final,
          reason: fin.reason,
          safeCovered: !!fin.safeCovered,
          finalizedCovered: !!fin.finalizedCovered,
          safeHead: fin.safeHead,
          finalizedHead: fin.finalizedHead,
          includedBlock: fin.includedBlock,
          depth: fin.depth,
          observedAt: fin.observedAt,
          arithmeticHeadNote: arithmetic,
        });
      }
    }
  }

  // Head references (read at end of observation window).
  const heads = {};
  for (const tag of ['safe', 'finalized', 'latest']) {
    try {
      const b = await provider.send('eth_getBlockByNumber', [tag, false]);
      heads[tag] = b ? { number: b.number, hash: b.hash } : null;
    } catch { heads[tag] = null; }
  }
  OBS.headReferences = { ...heads, observedAt: new Date().toISOString() };
  OBS.summary = {
    chainMatches: OBS.rpcChainId === CHAIN_ID,
    transactionsObserved: OBS.transactions.length,
    observations: OBS.observations.length,
  };
  const out = path.join(ROOT, 'evidence/e1b-sepolia-observation.json');
  fs.writeFileSync(out, JSON.stringify(OBS, null, 2) + '\n');
  console.log('WROTE ' + out);
  console.log('SUMMARY ' + JSON.stringify(OBS.summary));
  console.log('transactions:');
  for (const t of OBS.transactions) console.log('  ' + t.label + ' ' + t.txHash + ' block=' + t.blockNumber + ' status=' + t.status + ' canonicalMatch=' + t.canonicalBlockMatches);
  console.log('finality:');
  for (const o of OBS.observations) console.log('  ' + o.label + ' ' + o.policy + ' final=' + o.final + ' reason=' + o.reason + ' arithBelowSafe=' + (o.arithmeticHeadNote ? o.arithmeticHeadNote.includedBelowSafe : 'n/a'));

  const chainOk = OBS.rpcChainId === CHAIN_ID;
  const receiptsOk = OBS.transactions.length >= 2 && OBS.transactions.every((t) => t.receiptFound && t.canonicalBlockMatches);
  process.exit(chainOk && receiptsOk ? 0 : 1);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });

function roleOf(name, rec) {
  if (name === 'refunded') return rec.refundTx;
  return rec.disputeTx;
}

async function arithmeticNote(provider, fin, txHash) {
  try {
    const [safeH, finH, inc] = await Promise.all([
      provider.send('eth_getBlockByNumber', ['safe', false]),
      provider.send('eth_getBlockByNumber', ['finalized', false]),
      provider.send('eth_getBlockByNumber', ['0x' + Number(fin.includedBlock ? fin.includedBlock.number : await receiptBlock(provider, txHash)).toString(16), false]),
    ]);
    const includedNumber = fin.includedBlock ? fin.includedBlock.number : (inc ? parseInt(inc.number, 16) : null);
    return {
      includedBlockNumber: includedNumber,
      safeHeadNumber: safeH ? parseInt(safeH.number, 16) : null,
      finalizedHeadNumber: finH ? parseInt(finH.number, 16) : null,
      includedBelowSafe: includedNumber !== null && safeH ? includedNumber <= parseInt(safeH.number, 16) : null,
      includedBelowFinalized: includedNumber !== null && finH ? includedNumber <= parseInt(finH.number, 16) : null,
      note: 'arithmetic head-position comparison only (no ancestry walk); not a finality pass',
    };
  } catch { return null; }
}

async function receiptBlock(provider, txHash) {
  const r = await provider.send('eth_getTransactionReceipt', [txHash]);
  return r ? parseInt(r.blockNumber, 16) : null;
}

async function observeTx(provider, txHash, role, recordName) {
  const base = { label: recordName + '.' + role, txHash, role };
  try {
    const tx = await provider.send('eth_getTransactionByHash', [txHash]);
    const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);
    if (!tx || !receipt) { base.receiptFound = false; base.reason = 'RECEIPT_ABSENT'; return base; }
    base.receiptFound = true;
    base.status = receipt.status;
    base.blockNumber = parseInt(receipt.blockNumber, 16);
    base.blockHash = receipt.blockHash;
    base.chainValidated = true;
    base.to = receipt.to;
    base.from = receipt.from;
    const canonical = await provider.send('eth_getBlockByNumber', [receipt.blockNumber, false]);
    base.canonicalBlockHash = canonical ? canonical.hash : null;
    base.canonicalBlockMatches = !!(canonical && canonical.hash.toLowerCase() === String(receipt.blockHash).toLowerCase());
    base.txInCanonicalBlock = !!(canonical && canonical.transactions && canonical.transactions.some((h) => String(h).toLowerCase() === String(txHash).toLowerCase()));
  } catch (e) {
    base.receiptFound = false;
    base.reason = 'RPC_ERROR:' + e.message;
  }
  return base;
}