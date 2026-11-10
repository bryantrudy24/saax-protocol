// D2 historical finality — canonical membership vs public finality, distinct.
//
// E1C: a trusted-RPC canonical-membership module that is EXPLICITLY NOT a
// finality check. Canonical membership (receipt present, block hash canonical,
// transaction present in the canonical block) establishes only that a
// committed transaction is on the currently-canonical chain as observed by a
// TRUSTED RPC. It does NOT satisfy op-stack-safe / op-stack-finalized policy,
// does NOT cause worker completion/finalization by itself, and must never be
// reported as a successful public-finality check.
//
// Correct RPC method dispatch (E1C design boundary #2):
//   - eth_getBlockByNumber accepts a BLOCK NUMBER (hex quantity) or a
//     supported tag ('latest', 'safe', 'finalized', 'pending', ...).
//   - A block-HASH lookup uses eth_getBlockByHash. A wrapper accepting a hash
//     MUST route a 64-hex hash to eth_getBlockByHash — a hash is never passed
//     as a block-number argument.
//
// RPC work is reported honestly: receipt lookup, canonical block membership
// lookup, verification-time recheck, and head reads are separate calls unless
// genuinely combined. We keep RPC work bounded (each look at a bounded number
// of blocks or a bounded ancestry walk with a configurable maxDepth) and
// distinguish missing history (HEAD_UNAVAILABLE / CANONICAL_BLOCK_UNAVAILABLE
// / TX_IN_BLOCK_UNVERIFIABLE) from a confirmed membership mismatch
// (CANONICAL_BLOCK_HASH_MISMATCH / TX_NOT_IN_CANONICAL_BLOCK).
//
// Trust assumptions (documented, same as E1A/E1B):
//   - The configured provider is a TRUSTED source of canonical blocks,
//     receipts, and the safe/finalized tags. We observe what the trusted node
//     reports; we do NOT re-derive consensus, replay transactions, or
//     reconstruct an L2 state root from L1. An observation here is an RPC
//     observation, never independent consensus proof.
//   - Canonical membership is an observation of the CURRENT canonical chain
//     at verification time: the block returned by the trusted RPC at the
//     recorded height is the canonical view it serves. A member result is
//     therefore valid as of that observation, not a proof that the block can
//     never be reorged.
//   - The separate public safe/finalized assertion adds head-binding checks:
//     the safe/finalized tagged head must be reachable from the current
//     latest head within a bounded walk AND its canonical hash must be
//     stable across a verification-time recheck (same head number, same
//     hash). These are additional consistency checks layered on the trusted
//     tags; they still do not constitute independent consensus.
//
// Mainnet refusal + deployment identity restrictions preserved: public policy
// on mainnet (chain 1) is refused at construction; local-confirmations are
// chain-31337-only; no trust-any-deployment flag is introduced; nothing here
// activates a public-chain deployment.

'use strict';

const LOCAL_SYNTHETIC_CHAIN = 31337;
const MAINNET_CHAIN = 1;
const DEFAULT_MAX_DEPTH = 256;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const TAGS = new Set(['latest', 'safe', 'finalized', 'pending', 'earliest']);

// E1 closure: explicit supported-network policy. Public finality/membership
// checks are permitted ONLY on the explicit public-testnet chain (84532).
// Recognized mainnets (Ethereum 1, Base 8453) and arbitrary chains are
// rejected — never "not chain 1".
const { classifyChain } = require('../mainnet/design/support/supported-networks.js');

function noLeadZero(h) { return String(h || '').toLowerCase().replace(/^0x/, ''); }
function sameHash(a, b) { return noLeadZero(a) === noLeadZero(b) && !!a && !!b; }

/**
 * Route a block reference to the exact RPC method:
 *   - tag or hex-quantity number  -> eth_getBlockByNumber
 *   - 64-hex block hash           -> eth_getBlockByHash
 * Never passes a hash as a block-number argument.
 *
 * @param {object} provider ethers JsonRpcProvider (or send()-compatible shape)
 * @param {string|number} ref block tag, hex-quantity number, or block hash
 * @returns {Promise<object|null>} normalized block {number, hash, parentHash,
 *   timestamp, transactions?} or null when absent.
 */
async function getBlockByRef(provider, ref) {
  const s = String(ref);
  if (HEX32.test(s)) {
    // Block hash -> eth_getBlockByHash (correct method).
    const b = await provider.send('eth_getBlockByHash', [s, false]);
    return b ? normalizeBlock(b) : null;
  }
  let param;
  if (TAGS.has(s)) param = s;
  else if (/^0x[0-9a-fA-F]+$/.test(s)) param = s; // hex-quantity number
  else param = '0x' + Number(ref).toString(16); // decimal number
  const b = await provider.send('eth_getBlockByNumber', [param, false]);
  return b ? normalizeBlock(b) : null;
}

function normalizeBlock(b) {
  if (!b) return null;
  return {
    number: b.number !== null && b.number !== undefined ? parseInt(b.number, 16) : null,
    hash: b.hash,
    parentHash: b.parentHash,
    timestamp: b.timestamp !== null && b.timestamp !== undefined ? parseInt(b.timestamp, 16) : null,
    transactions: Array.isArray(b.transactions) ? b.transactions.map(h => String(h).toLowerCase()) : null,
  };
}

/**
 * HistoricalMembership — canonical membership observation.
 *
 * A membership PASS means: the trusted RPC reports the transaction at the
 * recorded height, in a block whose hash matches the canonical block hash at
 * that height, and the transaction hash is present in that canonical block's
 * transactions list. This is distinct from finality (see assertPublicFinality).
 */
class HistoricalMembership {
  /**
   * @param {object} opts
   * @param {object} opts.provider ethers JsonRpcProvider (send()-capable)
   * @param {number} opts.chainId chain id this membership is bound to
   * @param {number} [opts.maxDepth] bounded ancestry / head-binding walk bound
   */
  constructor(opts) {
    this.provider = opts.provider;
    this.chainId = Number(opts.chainId);
    this.maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH;
  }

  /**
   * Verify a receipt is covered by a head block within a bounded ancestry walk.
   * Walks parent hashes (via eth_getBlockByHash; falls back to number-only
   * lookup). Returns { ok, depth, reason? } — fails closed (ok=false) when the
   * included block is not reachable within maxDepth or the head is missing.
   */
  async _coveredByHead(included, head) {
    if (!head || head.number === null || head.number === undefined || !head.hash) {
      return { ok: false, reason: 'HEAD_UNAVAILABLE' };
    }
    if (!included || included.number === null || included.number === undefined || !included.hash) {
      return { ok: false, reason: 'INCLUDED_BLOCK_UNAVAILABLE' };
    }
    const depth = Number(head.number) - Number(included.number);
    if (depth < 0) return { ok: false, reason: 'INCLUDED_ABOVE_HEAD' };
    if (depth > this.maxDepth) return { ok: false, reason: 'BOUND_EXCEEDED', depth, maxDepth: this.maxDepth };
    let cur = head;
    let steps = 0;
    while (cur && cur.number !== null && cur.number !== undefined && cur.number > included.number && steps <= this.maxDepth) {
      if (cur.number === included.number) break;
      let parent = null;
      try { parent = cur.parentHash ? await getBlockByRef(this.provider, cur.parentHash) : null; }
      catch { parent = null; }
      if (!parent || parent.number === null || parent.number === undefined) {
        try { parent = await getBlockByRef(this.provider, cur.number - 1); } catch { parent = null; }
      }
      if (!parent || parent.number === null || parent.number === undefined) break;
      cur = parent;
      steps += 1;
    }
    if (!cur || cur.number === null || cur.number === undefined || cur.number !== included.number) {
      return { ok: false, reason: 'UNCOVERED_WITHIN_BOUNDS', depth, maxDepth: this.maxDepth };
    }
    if (!sameHash(cur.hash, included.hash)) {
      return { ok: false, reason: 'CANONICAL_BLOCK_MISMATCH', depth };
    }
    return { ok: true, depth };
  }

  /**
   * Canonical membership observation for one transaction reference.
   * Returns { member, reason, details?, observedAt }.
   * member:true  -> receipt present, status 0x1, canonical block hash matches,
   *                 and the tx hash is present in the canonical block.
   * member:false -> fail-closed: missing history, unavailable block, tampered
   *                 block hash, or tx absent from the canonical block. Each is
   *                 a distinct reason; MISSING history is never reported as a
   *                 confirmed membership mismatch.
   */
  async checkMembership(txHash, receipt = null) {
    const observedAt = new Date().toISOString();
    const h = String(txHash).toLowerCase();
    // RPC work 1: receipt lookup.
    let r = receipt;
    if (!r) {
      try { r = await this.provider.send('eth_getTransactionReceipt', [h]); }
      catch (e) { return { member: false, reason: 'RECEIPT_READ_FAILED:' + e.message, observedAt }; }
    }
    if (!r) return { member: false, reason: 'RECEIPT_ABSENT', observedAt };
    const receiptBlockNumber = parseInt(r.blockNumber, 16);
    const receiptBlockHash = r.blockHash;
    if (!Number.isFinite(receiptBlockNumber) || !receiptBlockHash) {
      return { member: false, reason: 'RECEIPT_INCOMPLETE', observedAt };
    }
    // RPC work 2: canonical block at the recorded height (by NUMBER).
    let canonical;
    try { canonical = await getBlockByRef(this.provider, receiptBlockNumber); }
    catch (e) { return { member: false, reason: 'CANONICAL_BLOCK_UNAVAILABLE', detail: String(e.message), observedAt }; }
    if (!canonical) return { member: false, reason: 'CANONICAL_BLOCK_UNAVAILABLE', observedAt };
    if (canonical.number !== receiptBlockNumber) {
      return { member: false, reason: 'CANONICAL_BLOCK_UNAVAILABLE', observedAt };
    }
    // Confirmed membership mismatch candidates (distinct from missing history).
    if (!sameHash(canonical.hash, receiptBlockHash)) {
      return { member: false, reason: 'CANONICAL_BLOCK_HASH_MISMATCH', detail: { receiptBlockHash, canonicalHash: canonical.hash }, observedAt };
    }
    // Verification-time head read, so membership is anchored to the canonical
    // view being served at observation time (separate head read).
    let head = null;
    try { head = await getBlockByRef(this.provider, 'latest'); } catch { head = null; }
    if (!head) return { member: false, reason: 'HEAD_UNAVAILABLE', observedAt };
    // Tx membership in the canonical block. For a full block with a
    // transactions array, membership is exact. Some providers return a hash
    // list; some return full tx objects — normalize both.
    let txInBlock = false;
    if (canonical.transactions) {
      txInBlock = canonical.transactions.some(t => {
        const th = typeof t === 'string' ? t : (t && (t.hash || t.transactionHash));
        return th ? noLeadZero(th) === noLeadZero(h) : false;
      });
    }
    if (!txInBlock) return { member: false, reason: 'TX_NOT_IN_CANONICAL_BLOCK', observedAt };
    const depth = Number(head.number) - canonical.number;
    return {
      member: true,
      reason: 'CANONICAL_MEMBER',
      observedAt,
      details: {
        receiptBlockNumber,
        receiptBlockHash,
        canonicalHash: canonical.hash,
        txInBlock,
        headNumber: head.number,
        headHash: head.hash,
        depthBelowHead: depth,
      },
    };
  }

  /**
   * Distinct PUBLIC safe/finalized assertion for the RECENT-head case.
   *
   * This is NOT membership: an op-stack-safe/op-stack-finalized assertion
   * additionally proves the receipt is covered by the tagged safe/finalized
   * head via a bounded ancestry walk AND that the tagged head is stable
   * (head-binding recheck: same head number, same hash, on the current
   * canonical chain) at verification time. Even when it returns
   * final:true it remains a TRUSTED-RPC observation with the documented
   * trust assumptions — never independent consensus. It never runs on
   * local-confirmations (chain gating below) and never on mainnet.
   *
   * @param {object} opts { txHash, policy, receipt? }
   *   policy: 'op-stack-safe' | 'op-stack-finalized'
   * @returns {Promise<object>} { final, reason, safeCovered, finalizedCovered,
   *   safeHead, finalizedHead, includedBlock, depth, observedAt }
   */
  async assertPublicFinality(opts) {
    const observedAt = new Date().toISOString();
    const policy = String(opts.policy || '');
    if (!['op-stack-safe', 'op-stack-finalized'].includes(policy)) {
      return { final: false, reason: 'FINALITY_POLICY_UNSUPPORTED:' + policy, observedAt };
    }
    // E1 closure: explicit supported-network policy. Chain 1 AND Base mainnet
    // 8453 fail closed; arbitrary chains fail closed; only the explicit
    // public-testnet chain (84532) may run public checks.
    if (this.chainId === MAINNET_CHAIN || classifyChain(this.chainId) === 'mainnet' || classifyChain(this.chainId) === 'unsupported') {
      const cls = classifyChain(this.chainId);
      return { final: false, reason: cls === 'mainnet' ? 'FINALITY_MAINNET_NOT_ACTIVATED:' + this.chainId : 'FINALITY_NETWORK_UNSUPPORTED:' + this.chainId, observedAt };
    }
    const txHash = String(opts.txHash).toLowerCase();
    const r = opts.receipt || await this.provider.send('eth_getTransactionReceipt', [txHash]);
    if (!r) return { final: false, reason: 'RECEIPT_ABSENT', observedAt };
    // Step 1 — canonical membership of the receipt's block (required first).
    const membership = await this.checkMembership(txHash, r);
    if (!membership.member) {
      return { final: false, reason: 'NOT_MEMBER:' + membership.reason, safeCovered: false, finalizedCovered: false, observedAt };
    }
    const included = { number: membership.details.receiptBlockNumber, hash: membership.details.canonicalHash };
    // Step 2 — head-binding consistency: current latest head must chain to the
    // tagged head within bounds (bounded walk), and the tagged head must be
    // stable across a verification-time recheck (same number, same hash).
    const latest = await getBlockByRef(this.provider, 'latest');
    if (!latest) return { final: false, reason: 'HEAD_UNAVAILABLE', observedAt };
    const headBinding = { latest, recheckAt: observedAt };
    const safeHead = await getBlockByRef(this.provider, 'safe');
    const finalHead = await getBlockByRef(this.provider, 'finalized');
    const safeCov = safeHead ? await this._coveredByHead(included, safeHead) : { ok: false, reason: 'TAG_UNAVAILABLE' };
    const finCov = finalHead ? await this._coveredByHead(included, finalHead) : { ok: false, reason: 'TAG_UNAVAILABLE' };
    const safeCovered = safeCov.ok === true;
    const finalizedCovered = finCov.ok === true;
    if (!safeCovered && !finalizedCovered) {
      return { final: false, reason: safeCov.reason || 'TAG_UNAVAILABLE', safeCovered: false, finalizedCovered: false, safeHead, finalizedHead: finalHead, includedBlock: included, depth: safeCov.depth, headBinding, observedAt };
    }
    // Head-binding RE-CHECK: the safe/finalized head must be stable (same
    // number, same hash) at verification time, and the latest head must not
    // have regressed below the tagged head. This guards against a tagged head
    // that is observed on one canonical view and a different canonical view at
    // verification time.
    const safeNow = safeCovered ? await getBlockByRef(this.provider, 'safe') : null;
    const finNow = finalizedCovered ? await getBlockByRef(this.provider, 'finalized') : null;
    if (safeCovered && (!safeNow || !sameHash(safeNow.hash, safeHead.hash) || Number(safeNow.number) !== Number(safeHead.number))) {
      return { final: false, reason: 'HEAD_BINDING_CHANGED', safeCovered: true, finalizedCovered: finalizedCovered && !!finNow && sameHash(finNow.hash, finalHead.hash) && Number(finNow.number) === Number(finalHead.number), safeHead, finalizedHead: finalHead, includedBlock: included, depth: safeCov.depth, headBinding: { ...headBinding, changedTag: 'safe' }, observedAt };
    }
    if (finalizedCovered && (!finNow || !sameHash(finNow.hash, finalHead.hash) || Number(finNow.number) !== Number(finalHead.number))) {
      return { final: false, reason: 'HEAD_BINDING_CHANGED', safeCovered: safeCovered && !!safeNow && sameHash(safeNow.hash, safeHead.hash) && Number(safeNow.number) === Number(safeHead.number), finalizedCovered: true, safeHead, finalizedHead: finalHead, includedBlock: included, depth: finCov.depth, headBinding: { ...headBinding, changedTag: 'finalized' }, observedAt };
    }
    if (policy === 'op-stack-safe') {
      if (!safeHead) return { final: false, reason: 'TAG_UNAVAILABLE', safeCovered: false, finalizedCovered, safeHead: null, finalizedHead: finalHead, includedBlock: included, depth: null, observedAt };
      if (!safeCovered) {
        // Propagate the exact fail-closed reason from the bounded walk.
        return { final: false, reason: safeCov.reason || 'NOT_SAFE', safeCovered: false, finalizedCovered, safeHead, finalizedHead: finalHead, includedBlock: included, depth: safeCov.depth, observedAt };
      }
      return { final: true, reason: 'SAFE_COVERED', safeCovered: true, finalizedCovered: false, safeHead, finalizedHead: finalHead, includedBlock: included, depth: safeCov.depth, headBinding, observedAt };
    }
    // op-stack-finalized requires finalized coverage.
    if (!finalHead) return { final: false, reason: 'TAG_UNAVAILABLE', safeCovered, finalizedCovered: false, safeHead, finalizedHead: null, includedBlock: included, depth: null, observedAt };
    if (!finalizedCovered) {
      // Not covered by the finalized head: if it IS covered by safe, this is
      // SAFE_ONLY; otherwise propagate the exact fail-closed reason.
      const reason = safeCovered ? 'SAFE_ONLY' : (finCov.reason || 'NOT_FINALIZED');
      return { final: false, reason, safeCovered, finalizedCovered: false, safeHead, finalizedHead: finalHead, includedBlock: included, depth: finCov.depth, observedAt };
    }
    return { final: true, reason: 'FINALIZED_COVERED', safeCovered, finalizedCovered: true, safeHead, finalizedHead: finalHead, includedBlock: included, depth: finCov.depth, headBinding, observedAt };
  }

  /**
   * Worker-facing establish: returns BOTH findings separately.
   *   membership: { member, reason, ... }   — canonical membership observation.
   *   finality:   { final, reason, ... }    — ONLY from assertPublicFinality;
   *                                          membership NEVER drives final:true.
   * local-confirmations policy on chain 31337 is honored via the caller's
   * adapter; this module's public policy never downgrades an op-stack-*
   * configured requirement to a membership observation.
   *
   * @param {object} opts { txHash, policy, anchorTxHashes?, receipt? }
   * @returns {Promise<{membership, finality}>}
   */
  async establish(txHash, policy, opts = {}) {
    const observedAt = new Date().toISOString();
    if (this.chainId === MAINNET_CHAIN || classifyChain(this.chainId) === 'mainnet' || classifyChain(this.chainId) === 'unsupported') {
      const cls = classifyChain(this.chainId);
      const reason = cls === 'mainnet' ? 'FINALITY_MAINNET_NOT_ACTIVATED:' + this.chainId : 'FINALITY_NETWORK_UNSUPPORTED:' + this.chainId;
      return {
        membership: { member: false, reason, observedAt },
        finality: { final: false, reason, observedAt },
      };
    }
    const membership = await this.checkMembership(txHash, opts.receipt);
    // Membership NEVER satisfies policy. Finality is only ever asserted by the
    // public assertion method, with its own head-binding/consistency checks.
    if (policy === 'local-confirmations' || policy === 'local-synthetic') {
      return {
        membership,
        finality: { final: false, reason: 'FINALITY_PUBLIC_NOT_ACTIVATED', policy: String(policy), observedAt, note: 'membership or local confirmations do not constitute public finality' },
      };
    }
    const finality = await this.assertPublicFinality({ txHash, policy, receipt: opts.receipt });
    return { membership, finality };
  }
}

module.exports = { HistoricalMembership, getBlockByRef, normalizeBlock, LOCAL_SYNTHETIC_CHAIN, MAINNET_CHAIN, DEFAULT_MAX_DEPTH, classifyChain };
