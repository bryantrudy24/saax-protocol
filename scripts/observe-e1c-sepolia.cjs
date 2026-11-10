'use strict';
// E1C read-only Base Sepolia observation — canonical membership vs finality.
//
// READ-ONLY. No broadcast, no deployment, no funding, no spending: this script
// only issues eth_* READ calls to the public Base Sepolia RPC
// (https://sepolia.base.org). It observes the FULL COMMITTED transaction
// hashes from evidence/terminal-state-escrows.json (fundTx / refundTx /
// disputeTx — full 32-byte hashes) and records, SEPARATELY for every output:
//   - MEMBERSHIP: canonical membership via worker/d2-historical-finality.js
//     (receipt present, canonical block hash match, tx present in the
//     canonical block). Deep history needs no ancestry walk: the canonical
//     block at the recorded height is the source of membership.
//   - FINALITY: the DISTINCT public safe/finalized assertion
//     (assertPublicFinality) with its own head-binding/consistency checks and
//     bounded ancestry walk (maxDepth=256). These committed txs are ~103k
//     blocks deep, so the bounded walk reports BOUND_EXCEEDED and FAILS CLOSED
//     — membership PASS never closes the finality requirement.
//   - ANCHOR references (cid/digest commitment refs) alongside funding/
//     settlement, recorded where the escrow record carries them.
//   - head references (safe/finalized/latest) at end of the window.
//
// The output is an RPC observation, NOT independent consensus reconstruction:
// the safe/finalized tags are claims made by the node/sequencer we connect to
// (same documented trust model as E1A/E1B). A membership PASS means "the
// trusted RPC reports this tx in the currently-canonical block at its recorded
// height" — it is NOT a finality claim.

'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { HistoricalMembership } = require('../worker/d2-historical-finality');

const ROOT = path.resolve(__dirname, '..');
const RPC_URL = 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const MAX_DEPTH = 256;
const headRef = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const escrows = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/terminal-state-escrows.json'), 'utf8'));

const OBS = {
  kind: 'read-only-rpc-membership-vs-finality',
  chainId: CHAIN_ID,
  rpc: RPC_URL,
  headRef,
  observedAt: new Date().toISOString(),
  scope: 'Full committed Base Sepolia custody transaction hashes (evidence/terminal-state-escrows.json). Read-only eth_* calls only; no broadcast/write.',
  trustAssumptions: [
    'The configured RPC (sepolia.base.org) is a TRUSTED source of canonical blocks, receipts, and the safe/finalized tags.',
    'Canonical membership is an observation of the canonical view served at verification time; a member result is valid as of that observation, not a proof the block can never be reorged.',
    'Safe/finalized head coverage is an RPC observation, NOT independent consensus reconstruction (no L1 state-root replay).',
    'Bounded ancestry walk with maxDepth=' + MAX_DEPTH + ' for the finality assertion. Old evidence beyond the bound reports BOUND_EXCEEDED (fail closed). Membership does not use an ancestry walk.',
    'A single provider was used; disagreement detection across independent providers is out of scope for this checkpoint.',
  ],
  maxDepth: MAX_DEPTH,
  transactions: [],
  membership: [],
  finality: [],
  anchorRefs: [],
};

async function run() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: false, batchMaxCount: 1 });
  const membership = new HistoricalMembership({ provider, chainId: CHAIN_ID, maxDepth: MAX_DEPTH });
  const network = await provider.getNetwork();
  OBS.rpcChainId = Number(network.chainId);

  const refs = [];
  for (const [name, rec] of [['refunded', escrows.refunded], ['disputed', escrows.disputed]]) {
    const settleKey = name === 'refunded' ? 'refundTx' : 'disputeTx';
    refs.push({ label: name + '.funding', txHash: rec.fundTx, role: 'funding' });
    refs.push({ label: name + '.' + settleKey.replace('Tx', ''), txHash: rec[settleKey], role: 'settlement' });
    // Anchor references (cid/digest) recorded alongside the funding/settlement
    // hashes for each record, where the escrow record carries them.
    if (rec.cid) OBS.anchorRefs.push({ label: name + '.commitment', cid: rec.cid, digest: rec.digest || null });
  }

  for (const ref of refs) {
    // MEMBERSHIP observation (no ancestry walk).
    const mem = await membership.checkMembership(ref.txHash);
    OBS.membership.push({
      label: ref.label,
      txHash: ref.txHash,
      role: ref.role,
      member: mem.member,
      reason: mem.reason,
      details: mem.details || null,
      observedAt: mem.observedAt,
    });
    OBS.transactions.push({
      label: ref.label,
      txHash: ref.txHash,
      role: ref.role,
      member: mem.member,
      reason: mem.reason,
      ...(mem.details ? { blockNumber: mem.details.receiptBlockNumber, canonicalBlockMatches: mem.member } : {}),
    });
    // FINALITY observation — SEPARATE finding. Both policies observed.
    for (const policy of ['op-stack-safe', 'op-stack-finalized']) {
      const fin = await membership.assertPublicFinality({ txHash: ref.txHash, policy });
      OBS.finality.push({
        label: ref.label,
        txHash: ref.txHash,
        policy,
        final: fin.final,
        reason: fin.reason,
        safeCovered: !!fin.safeCovered,
        finalizedCovered: !!fin.finalizedCovered,
        safeHead: fin.safeHead ? { number: fin.safeHead.number, hash: fin.safeHead.hash } : null,
        finalizedHead: fin.finalizedHead ? { number: fin.finalizedHead.number, hash: fin.finalizedHead.hash } : null,
        includedBlock: fin.includedBlock || null,
        depth: fin.depth !== undefined ? fin.depth : null,
        headBinding: fin.headBinding ? { recheckAt: fin.headBinding.recheckAt, changedTag: fin.headBinding.changedTag || null } : null,
        observedAt: fin.observedAt,
      });
    }
  }

  // Head references (read at end of observation window).
  const heads = {};
  for (const tag of ['safe', 'finalized', 'latest']) {
    try {
      const b = await provider.send('eth_getBlockByNumber', [tag, false]);
      heads[tag] = b ? { number: parseInt(b.number, 16), hash: b.hash } : null;
    } catch { heads[tag] = null; }
  }
  OBS.headReferences = { ...heads, observedAt: new Date().toISOString() };
  OBS.summary = {
    chainMatches: OBS.rpcChainId === CHAIN_ID,
    transactionsObserved: OBS.membership.length,
    membershipPass: OBS.membership.filter(m => m.member).length,
    membershipFail: OBS.membership.filter(m => !m.member).length,
    finalityPass: OBS.finality.filter(f => f.final).length,
    finalityFailClosed: OBS.finality.filter(f => !f.final).length,
    safeCoveredCount: OBS.finality.filter(f => f.safeCovered).length,
    finalizedCoveredCount: OBS.finality.filter(f => f.finalizedCovered).length,
    anchorRefs: OBS.anchorRefs.length,
    note: 'membership and finality are separate findings; membership PASS does not close the finality requirement.',
  };

  const out = path.join(ROOT, 'evidence/e1c-sepolia-membership.json');
  fs.writeFileSync(out, JSON.stringify(OBS, null, 2) + '\n');
  console.log('WROTE ' + out);
  console.log('SUMMARY ' + JSON.stringify(OBS.summary));
  console.log('membership:');
  for (const m of OBS.membership) console.log('  ' + m.label + ' member=' + m.member + ' reason=' + m.reason);
  console.log('finality (separate):');
  for (const f of OBS.finality) console.log('  ' + f.label + ' ' + f.policy + ' final=' + f.final + ' reason=' + f.reason + ' safe=' + f.safeCovered + ' fin=' + f.finalizedCovered);
  console.log('anchorRefs: ' + OBS.anchorRefs.map(a => a.label).join(', '));

  const chainOk = OBS.rpcChainId === CHAIN_ID;
  const allMembers = OBS.membership.every(m => m.member);
  // Exit 0 only when chain matches AND every committed hash is a canonical
  // member. Finality being fail-closed (BOUND_EXCEEDED) is EXPECTED and does
  // NOT fail the run — it is recorded as the separate finality finding.
  process.exit(chainOk && OBS.membership.length >= 2 && allMembers ? 0 : 1);
}

run().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });
