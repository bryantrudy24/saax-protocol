'use strict';
// E1D read-only Base Sepolia observation — bounded trusted-RPC historical
// finality assertions for DEEP history.
//
// READ-ONLY. No broadcast, no deployment, no funding, no spending: this
// script only issues eth_* READ calls to the public Base Sepolia RPC
// (https://sepolia.base.org). It observes the FULL COMMITTED transaction
// hashes from evidence/terminal-state-escrows.json (fundTx / refundTx /
// disputeTx — full 32-byte hashes) and records, SEPARATELY for every output:
//   - MEMBERSHIP: canonical membership via worker/d2-historical-finality.js
//     (receipt present, canonical block hash match, tx present in the
//     canonical block). Deep history needs no ancestry walk.
//   - FINALITY (TRUSTED-RPC, E1D): the EXPLICIT, DISTINCT
//     worker/d2-trusted-rpc-finality.js assertion for deep history. It relies
//     on the node's OWN canonical-chain and consensus-status (safe/finalized
//     tag) assertions: identity checks, canonical block/hash + membership
//     checks, required tagged-head observation, coverage (included <= tagged
//     head) and consistency rechecks (stability across the verification
//     window), bounded retries + request budget. NO ancestry walk — the
//     tagged head IS the node's assertion of the canonical prefix it covers.
//   - ANCHOR references (cid/digest commitment refs) alongside funding/
//     settlement, recorded where the escrow record carries them.
//   - head references (safe/finalized/latest) at end of the window.
//
// The output is an RPC observation, NOT independent consensus reconstruction:
// the safe/finalized tags are claims made by the node/sequencer we connect to
// (same documented trust model as E1A/E1B/E1C; official Base/OP Stack
// semantics: safe = data published to an Ethereum block (ordering fixed, block
// can still reorg until finalized); finalized = the Ethereum block containing
// the data was finalized by Ethereum's consensus mechanism). A positive here
// means "the trusted RPC asserts this historical transaction is covered by its
// safe/finalized head" — never a cryptographic ancestry proof and never
// independent consensus. A COMPONENT positive does not make a full public
// export supported (deployment identity is a separate axis and remains
// unsupported).

'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { HistoricalMembership } = require('../worker/d2-historical-finality');
const { TrustedRpcFinality } = require('../worker/d2-trusted-rpc-finality');

const ROOT = path.resolve(__dirname, '..');
const RPC_URL = 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const REQUEST_BUDGET = 20;
const headRef = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const escrows = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/terminal-state-escrows.json'), 'utf8'));

const OBS = {
  kind: 'read-only-rpc-trusted-finality-assertions',
  chainId: CHAIN_ID,
  rpc: RPC_URL,
  headRef,
  observedAt: new Date().toISOString(),
  scope: 'Full committed Base Sepolia custody transaction hashes (evidence/terminal-state-escrows.json). Read-only eth_* calls only; no broadcast/write.',
  trustAssumptions: [
    'The configured RPC (sepolia.base.org) is a TRUSTED source of canonical blocks, receipts, and the safe/finalized tags.',
    'Canonical membership is an observation of the canonical view served at verification time; a member result is valid as of that observation, not a proof the block can never be reorged.',
    'The trusted-RPC finality assertion (E1D) relies on the node\'s OWN canonical-chain and consensus-status (safe/finalized tag) assertions. safe = data published to an Ethereum block (ordering fixed; the block can still reorg until finalized); finalized = the Ethereum block containing the data was finalized by Ethereum consensus (docs.optimism.io/op-stack/transactions/transaction-finality; docs.base.org/base-chain/api-reference/rpc-overview).',
    'It is NOT independent consensus reconstruction and NOT a cryptographic ancestry proof: no L1 state-root replay, no unbounded ancestry traversal.',
    'Canonical membership alone is insufficient: the required tagged-head coverage + consistency rechecks are also required.',
    'Request budget ' + REQUEST_BUDGET + ' read calls per assertion; bounded retries; budget/read exhaustion fails closed.',
    'A single provider was used; disagreement detection across independent providers is out of scope for this checkpoint.',
  ],
  requestBudget: REQUEST_BUDGET,
  transactions: [],
  membership: [],
  finality: [],
  anchorRefs: [],
};

async function run() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: false, batchMaxCount: 1 });
  const membership = new HistoricalMembership({ provider, chainId: CHAIN_ID });
  // A FRESH TrustedRpcFinality per assertion so each (tx, policy) observation
  // gets its full request budget (the budget is per-assertion, never shared).
  const newTrusted = () => new TrustedRpcFinality({ provider, chainId: CHAIN_ID, requestBudget: REQUEST_BUDGET });
  const network = await provider.getNetwork();
  OBS.rpcChainId = Number(network.chainId);

  const refs = [];
  for (const [name, rec] of [['refunded', escrows.refunded], ['disputed', escrows.disputed]]) {
    const settleKey = name === 'refunded' ? 'refundTx' : 'disputeTx';
    refs.push({ label: name + '.funding', txHash: rec.fundTx, role: 'funding' });
    refs.push({ label: name + '.' + settleKey.replace('Tx', ''), txHash: rec[settleKey], role: 'settlement' });
    if (rec.cid) OBS.anchorRefs.push({ label: name + '.commitment', cid: rec.cid, digest: rec.digest || null });
  }

  for (const ref of refs) {
    // MEMBERSHIP observation (no ancestry walk) — separate finding.
    const mem = await membership.checkMembership(ref.txHash);
    OBS.membership.push({ label: ref.label, txHash: ref.txHash, role: ref.role, member: mem.member, reason: mem.reason, details: mem.details || null, observedAt: mem.observedAt });
    OBS.transactions.push({ label: ref.label, txHash: ref.txHash, role: ref.role, member: mem.member, reason: mem.reason, ...(mem.details ? { blockNumber: mem.details.receiptBlockNumber, canonicalBlockMatches: mem.member } : {}) });

    // FINALITY (TRUSTED-RPC, E1D) — SEPARATE finding. Both policies observed.
    for (const policy of ['op-stack-safe', 'op-stack-finalized']) {
      const fin = await newTrusted().assertHistoricalFinality({ txHash: ref.txHash, policy });
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
        consistency: fin.consistency ? {
          headBefore: fin.consistency.headBefore,
          headAfter: fin.consistency.headAfter,
          advancingIsConsistent: !!fin.consistency.advancingIsConsistent,
          regressedSafe: !!fin.consistency.regressedSafe,
          changedSafe: !!fin.consistency.changedSafe,
          latestBefore: fin.consistency.latestBefore !== undefined ? fin.consistency.latestBefore : null,
          latestAfter: fin.consistency.latestAfter !== undefined ? fin.consistency.latestAfter : null,
        } : null,
        requests: fin.requests,
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
    note: 'membership and finality are separate findings; a component positive does not make a full public export supported (deployment identity is a separate unsupported axis).',
  };

  const out = path.join(ROOT, 'evidence/e1d-sepolia-trusted-finality.json');
  fs.writeFileSync(out, JSON.stringify(OBS, null, 2) + '\n');
  console.log('WROTE ' + out);
  console.log('SUMMARY ' + JSON.stringify(OBS.summary));
  console.log('membership:');
  for (const m of OBS.membership) console.log('  ' + m.label + ' member=' + m.member + ' reason=' + m.reason);
  console.log('finality (trusted-rpc, separate):');
  for (const f of OBS.finality) console.log('  ' + f.label + ' ' + f.policy + ' final=' + f.final + ' reason=' + f.reason + ' safe=' + f.safeCovered + ' fin=' + f.finalizedCovered + ' reqs=' + f.requests);
  console.log('anchorRefs: ' + OBS.anchorRefs.map(a => a.label).join(', '));

  const chainOk = OBS.rpcChainId === CHAIN_ID;
  const allMembers = OBS.membership.every(m => m.member);
  // Exit 0 only when chain matches AND every committed hash is a canonical
  // member AND no assertion unexpectedly failed on an availability error.
  // Finality being fail-closed (e.g. TAG_UNAVAILABLE on a provider that does
  // not serve tags, or INCLUDED_ABOVE_HEAD) is a REAL finding and does NOT by
  // itself fail the run — it is recorded as the separate finality finding.
  process.exit(chainOk && OBS.membership.length >= 2 && allMembers ? 0 : 1);
}

run().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });
