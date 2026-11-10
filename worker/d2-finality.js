// D2 finality adapter — explicit finality policy, local and public interfaces.
//
// E1A extension: explicit safe/finalized checking with trusted-config policy
// selection, chain-31337-local gating, bounded ancestry verification, and
// fail-closed semantics. No fallback from failed public checks to local
// confirmations; mainnet activation remains disabled.
//
// Policy principle (custody-policy + Phase D2 mandate):
//   - Local-test confirmations: policy 'local-confirmations', labeled
//     LOCAL ONLY, allowed ONLY on chain 31337 (local synthetic confirmations).
//     Never converted into a public-finality claim.
//   - OP Stack safe: policy 'op-stack-safe' waits for the L2 'safe' head
//     coverage (state root published to L1 but NOT yet finalized).
//   - OP Stack finalized: policy 'op-stack-finalized' waits for the L2
//     'finalized' head coverage (finalized on L1).
//   - SAFE must never be labeled consensus-finalized: a receipt covered only
//     by the safe head is SAFE (included+safe), not FINALIZED.
//
// RPC trust assumptions (documented):
//   - The configured provider/head-readers are TRUSTED sources of the
//     safe/finalized tags. A public tag (e.g. the optimistic-rollup safe/final
//     head) is a claim made by the node/sequencer we connect to; we do not
//     re-derive consensus from receipts. In tests, [MOCK] providers simulate
//     these tags; [REAL] local EVM 31337 has no safe/finalized tag and is
//     therefore local-confirmations only (31337 gate).
//   - Canonical-block verification is done by re-reading the block at the
//     receipt's recorded height and comparing hashes against the head ancestry
//     within a BOUNDED walk (never an unbounded chain crawl).
//   - Unavailable tags/history or exhausted ancestry bounds FAIL CLOSED:
//     never return final on a missing tag or a truncated walk.
//   - A single unchanged head is NOT a stall and NOT a disagreement. Stall
//     requires persisted progress observations over a configured threshold;
//     RPC_DISAGREEMENT requires two ACTUAL conflicting observations.

'use strict';

const LOCAL_ONLY_NOTE = 'local-test confirmation policy — NOT a public-finality claim; public-chain safe/finalized policy interface exists but is not activated';

const POLICIES = new Set(['local-confirmations', 'op-stack-safe', 'op-stack-finalized']);
// Local synthetic confirmations are allowed ONLY on the local EVM chain id.
const LOCAL_SYNTHETIC_CHAIN = 31337;
// E1 closure: explicit supported-network policy (repository-owned). Public
// finality checks are permitted ONLY on the explicit public-testnet chain
// (Base Sepolia 84532). Base mainnet 8453 and Ethereum chain 1 are
// recognized mainnets and stay BLOCKED; any other chain is unsupported.
const { classifyChain, assertSupportedNetwork, assertPublicFinalityChain, assertLocalConfirmationsChain } = require('../mainnet/design/support/supported-networks.js');
// Default bound on ancestry/RPC work when verifying coverage by a head.
const DEFAULT_MAX_DEPTH = 256;
// Default stall threshold (ms of no head progress before FINALITY_STALL).
const DEFAULT_STALL_MS = 30 * 60 * 1000;

function noLeadZero(h) {
  return String(h || '').toLowerCase().replace(/^0x/, '');
}

function sameHash(a, b) {
  return noLeadZero(a) === noLeadZero(b) && !!a && !!b;
}

class FinalityAdapter {
  /**
   * @param {object} opts
   * @param {Function} opts.getBlock async (tagOrNumber) => {number, hash, parentHash, timestamp}
   * @param {Function} opts.getReceipt async (txHash) => {status, blockNumber, blockHash, transactionHash?, ...} | null
   * @param {number}   [opts.confirmations] local confirmations for chain 31337 (default 1)
   * @param {number}   [opts.chainId] chain id this adapter is bound to (default 31337)
   * @param {string|object} [opts.policy] trusted-config finality policy:
   *        'local-confirmations' | 'op-stack-safe' | 'op-stack-finalized'
   *        or { mode, confirmations? } — selected from configured policy,
   *        NEVER inferred from chain data alone.
   * @param {Function} [opts.getSafeHead] async () => block of the 'safe' L2 head
   * @param {Function} [opts.getFinalizedHead] async () => block of the 'finalized' L2 head
   * @param {number}   [opts.maxDepth] ancestry/RPC walk bound (default 256)
   * @param {number}   [opts.stallMs] head-progress stall threshold (default 30m)
   * @param {object}   [opts.progress] persisted progress store:
   *        { get: async (key) => {block, at}, put: async (key, {block, at}) }
   *        — for stall detection across calls/restarts. Absent -> in-memory.
   */
  constructor(opts) {
    this.getBlock = opts.getBlock;
    this.getReceipt = opts.getReceipt;
    this.chainId = opts.chainId !== undefined ? Number(opts.chainId) : LOCAL_SYNTHETIC_CHAIN;
    this.confirmations = opts.confirmations || 1;
    this.maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH;
    this.stallMs = opts.stallMs || DEFAULT_STALL_MS;
    this.getSafeHead = opts.getSafeHead;
    this.getFinalizedHead = opts.getFinalizedHead;
    this.progressStore = opts.progress;
    if (this.progressStore) {
      if (typeof this.progressStore.get !== 'function' || typeof this.progressStore.put !== 'function') {
        throw new Error('FINALITY_CONFIG_PROGRESS_STORE_INVALID');
      }
    } else {
      const mem = new Map();
      this.progressStore = { get: async (k) => mem.get(k) || null, put: async (k, v) => { mem.set(k, v); } };
    }

    // Trusted-config policy selection — never inferred from chain data.
    const cfg = typeof opts.policy === 'object' && opts.policy ? opts.policy : { mode: opts.policy };
    const mode = String(cfg.mode || 'local-confirmations');
    if (!POLICIES.has(mode)) {
      throw new Error('FINALITY_POLICY_UNSUPPORTED:' + mode);
    }
    this.policy = { mode, label: mode === 'local-confirmations' ? 'local only' : (mode === 'op-stack-safe' ? 'op-stack safe' : 'op-stack finalized'), confirmations: this.confirmations, note: mode === 'local-confirmations' ? LOCAL_ONLY_NOTE : 'public safe/finalized policy' };

    if (mode === 'local-confirmations') {
      // Local synthetic confirmations are chain-31337-only. A non-31337 chain
      // with local-confirmations is a misconfiguration — fail closed (explicit
      // supported-network policy, never "not chain 1").
      assertLocalConfirmationsChain(this.chainId, { surface: 'FinalityAdapter' });
      // 31337 is always local-test class; local policy cannot run public checks.
    } else {
      // Public policies (op-stack-safe / op-stack-finalized) are permitted
      // ONLY on the explicit public-testnet chain (84532) under trusted
      // configuration. Ethereum chain 1 AND Base mainnet 8453 are recognized
      // mainnets and stay BLOCKED; arbitrary chains are unsupported.
      const cls = assertPublicFinalityChain(this.chainId, { surface: 'FinalityAdapter' });
      if (cls !== 'public-testnet') {
        // e.g. a public policy on the local-test chain 31337 is a downgrade
        // attempt (refused — never convert local confirmations into a public
        // claim).
        throw new Error('FINALITY_PUBLIC_POLICY_CHAIN_UNSUPPORTED:chain=' + this.chainId + ':class=' + cls);
      }
    }
    this._mode = mode;
  }

  get isLocalOnly() { return this._mode === 'local-confirmations'; }

  /**
   * Async bind of the head readers used by public policies. For OP Stack, the
   * safe/finalized heads are read through the trusted provider as tagged
   * blocks ('safe'/'finalized') when dedicated readers are not supplied.
   */
  async _taggedHead(tag) {
    if (this.getBlock && (tag === 'safe' || tag === 'finalized')) {
      try {
        const b = await this.getBlock(tag);
        if (!b || b.number === undefined || b.hash === undefined) return null;
        return b;
      } catch { return null; }
    }
    return null;
  }

  async _safeHead() {
    if (this.getSafeHead) { try { const b = await this.getSafeHead(); if (b && b.number !== undefined) return b; } catch { return null; } }
    return this._taggedHead('safe');
  }

  async _finalizedHead() {
    if (this.getFinalizedHead) { try { const b = await this.getFinalizedHead(); if (b && b.number !== undefined) return b; } catch { return null; } }
    return this._taggedHead('finalized');
  }

  /**
   * Verify a receipt is covered by a head block within a bounded ancestry walk.
   * Returns { ok, head, depth, reason? } — fails closed when the included
   * block is not reachable within maxDepth from the head, or head is missing.
   */
  async _coveredByHead(receipt, included, head) {
    if (!head || head.number === undefined || head.hash === undefined) {
      return { ok: false, reason: 'TAG_UNAVAILABLE' };
    }
    if (!included || included.number === undefined || included.hash === undefined) {
      return { ok: false, reason: 'INCLUDED_BLOCK_UNAVAILABLE' };
    }
    if (included.number > head.number) {
      return { ok: false, reason: 'INCLUDED_ABOVE_HEAD' };
    }
    const depth = Number(head.number) - Number(included.number);
    if (depth < 0) return { ok: false, reason: 'INCLUDED_ABOVE_HEAD' };
    if (depth > this.maxDepth) {
      return { ok: false, reason: 'BOUND_EXCEEDED', depth, maxDepth: this.maxDepth };
    }
    // Bound the ancestry walk: walk from head back to included.number, but
    // stop after maxDepth+1 steps. If the included block hash is not seen,
    // the receipt is not covered by this tagged head (fail closed).
    let cur = head;
    let steps = 0;
    while (cur && cur.number !== undefined && cur.number > included.number && steps <= this.maxDepth) {
      if (cur.number === included.number) break;
      let parent = null;
      try { parent = cur.parentHash ? await this.getBlock(cur.parentHash) : null; } catch { parent = null; }
      // Some providers only resolve by number; fall back to number-based walk.
      if (!parent || parent.number === undefined) {
        try { parent = await this.getBlock(cur.number - 1); } catch { parent = null; }
      }
      if (!parent || parent.number === undefined) break;
      cur = parent;
      steps += 1;
    }
    if (!cur || cur.number === undefined || cur.number !== included.number) {
      return { ok: false, reason: 'UNCOVERED_WITHIN_BOUNDS', depth, maxDepth: this.maxDepth };
    }
    if (!sameHash(cur.hash, included.hash)) {
      return { ok: false, reason: 'CANONICAL_BLOCK_MISMATCH', depth };
    }
    return { ok: true, head, depth };
  }

  /** Verify receipt identity + chain + canonical block hash against the chain. */
  async _verifyReceiptBasics(receipt, txHash) {
    // Receipt identity: the receipt must carry the hash we asked about.
    const receiptHash = receipt.hash || receipt.transactionHash;
    if (txHash && receiptHash && !sameHash(receiptHash, txHash)) {
      return { ok: false, reason: 'RECEIPT_IDENTITY_MISMATCH', detail: { asked: txHash, got: receiptHash } };
    }
    if (receipt.blockNumber === undefined || receipt.blockNumber === null ||
        receipt.blockHash === undefined || receipt.blockHash === null) {
      return { ok: false, reason: 'RECEIPT_INCOMPLETE' };
    }
    const head = await this.getBlock('latest');
    if (!head || head.number === undefined) return { ok: false, reason: 'HEAD_UNAVAILABLE' };
    // The canonical block at the included height must still match.
    let included = null;
    try { included = await this.getBlock(Number(receipt.blockNumber)); } catch { included = null; }
    if (!included || included.number === undefined) {
      return { ok: false, reason: 'CANONICAL_BLOCK_UNAVAILABLE' };
    }
    if (!sameHash(included.hash, receipt.blockHash)) {
      return { ok: false, reason: 'REORG_RECEIPT_BLOCK_HASH_CHANGED' };
    }
    return { ok: true, head, included };
  }

  /**
   * Reorg / canonical regression detection before finality (preserved from
   * D2): the included block must still be canonical at its height and the
   * head must not have regressed.
   */
  async _reorgCheck(head, included) {
    if (included) {
      if (head && head.number !== undefined && included.number > head.number) {
        return { final: false, reason: 'INCLUDED_ABOVE_HEAD', nowHead: head, includedBlock: included };
      }
      if (head && head.number !== undefined && included.number < head.number - this.maxDepth) {
        // Too far below head within one step is not itself a reorg; the
        // bounded-walk check handles coverage. Only a REGRESSED head is a
        // reorg signal.
      }
    }
    return null;
  }

  /**
   * Public safe/finalized policy check (OP Stack).
   * - safe policy: requires coverage by the 'safe' head.
   * - finalized policy: requires coverage by the 'finalized' head (and, by
   *   implication, the safe head — safe is a weaker claim).
   * - If the required tag is unavailable, FAIL CLOSED (TAG_UNAVAILABLE) —
   *   never a local-confirmations fallback.
   * Returns { final, reason, safe, finalized, head? }
   */
  async checkSafe(txHash, receipt = null) {
    if (this._mode === 'local-confirmations') return { final: false, reason: 'FINALITY_PUBLIC_NOT_ACTIVATED', policy: this.policy };
    const r = receipt || await this.getReceipt(txHash);
    if (!r) return { final: false, reason: 'RECEIPT_ABSENT', policy: this.policy };
    const base = await this._verifyReceiptBasics(r, txHash);
    if (!base.ok) return { final: false, reason: base.reason, policy: this.policy };
    const safe = await this._safeHead();
    const cov = await this._coveredByHead(r, base.included, safe);
    if (!cov.ok) return { final: false, reason: cov.reason, policy: this.policy, safe: safe || null, included: base.included, depth: cov.depth };
    return { final: true, reason: 'SAFE_COVERED', policy: this.policy, safe, included: base.included, depth: cov.depth };
  }

  async checkFinalized(txHash, receipt = null) {
    if (this._mode === 'local-confirmations') return { final: false, reason: 'FINALITY_PUBLIC_NOT_ACTIVATED', policy: this.policy };
    const r = receipt || await this.getReceipt(txHash);
    if (!r) return { final: false, reason: 'RECEIPT_ABSENT', policy: this.policy };
    const base = await this._verifyReceiptBasics(r, txHash);
    if (!base.ok) return { final: false, reason: base.reason, policy: this.policy };
    const safe = await this._safeHead();
    const finalized = await this._finalizedHead();
    const cov = await this._coveredByHead(r, base.included, finalized);
    if (!cov.ok) return { final: false, reason: cov.reason, policy: this.policy, finalized: finalized || null, safe: safe || null, included: base.included, depth: cov.depth };
    // SAFE coverage alone is NOT finalization: a receipt covered by safe but
    // not finalized is SAFE. Report both booleans so the worker persists the
    // accurate state.
    let safeCovered = false;
    if (safe && safe.number !== undefined) {
      const scov = await this._coveredByHead(r, base.included, safe);
      safeCovered = scov.ok;
    }
    const finalizedCovered = cov.ok;
    return { final: finalizedCovered, reason: finalizedCovered ? 'FINALIZED_COVERED' : 'SAFE_ONLY', policy: this.policy, safe, finalized, included: base.included, depth: cov.depth, safeCovered, finalizedCovered };
  }

  /**
   * Establish finality for a receipt under the configured policy.
   * Returns { final, policy, reason, nowHead?, includedBlock?, safe?, finalized?,
   *           depth?, safeCovered?, finalizedCovered? }
   * - local-confirmations: chain 31337 only; reorg detection preserved.
   * - op-stack-safe:        final when covered by the safe head.
   * - op-stack-finalized:   final when covered by the finalized head.
   * No fallback from a failed public check to local confirmations.
   */
  async establishFinality(receipt, opts = {}) {
    const txHash = opts.txHash || receipt.hash || receipt.transactionHash;
    if (this._mode === 'local-confirmations') {
      const r = await this.establishLocalFinality(receipt, opts);
      return { ...r, policy: this.policy };
    }
    const safeRes = await this.checkSafe(txHash, receipt);
    if (safeRes.final) {
      // SAFE: included + covered by safe head — NOT consensus-finalized.
      if (this._mode === 'op-stack-safe') {
        return { final: true, reason: 'SAFE_COVERED', policy: this.policy, safe: safeRes.safe, includedBlock: safeRes.included, depth: safeRes.depth, safeCovered: true, finalizedCovered: false };
      }
      // finalized policy: must also be covered by the finalized head.
      const finRes = await this.checkFinalized(txHash, receipt);
      if (finRes.final) {
        return { final: true, reason: 'FINALIZED_COVERED', policy: this.policy, safe: finRes.safe, finalized: finRes.finalized, includedBlock: finRes.included, depth: finRes.depth, safeCovered: true, finalizedCovered: true };
      }
      return { final: false, reason: finRes.reason || 'SAFE_ONLY', policy: this.policy, safe: finRes.safe, finalized: finRes.finalized, includedBlock: finRes.included, depth: finRes.depth, safeCovered: true, finalizedCovered: false };
    }
    return { final: false, reason: safeRes.reason || 'NOT_FINAL', policy: this.policy, depth: safeRes.depth, safe: safeRes.safe, includedBlock: safeRes.included };
  }

  /** Alias preserved for D2 compatibility (local path only). */
  async establishLocalFinality(receipt, opts = {}) {
    if (this._mode !== 'local-confirmations') {
      return { final: false, reason: 'POLICY_NOT_LOCAL_CONFIRMATIONS', policy: this.policy };
    }
    const confirmations = opts.confirmations || this.confirmations;
    const head = await this.getBlock('latest');
    const included = receipt.blockNumber !== undefined && receipt.blockNumber !== null
      ? await this.getBlock(Number(receipt.blockNumber))
      : null;

    // Reorg / removal detection (preserved from D2).
    if (included) {
      if (receipt.blockHash && included.hash && !sameHash(receipt.blockHash, included.hash)) {
        return { final: false, reason: 'REORG_RECEIPT_BLOCK_HASH_CHANGED', policy: this.policy, nowHead: head, includedBlock: included };
      }
      if (included.parentHash && head.hash && !sameHash(included.hash, head.hash) && head.number - included.number < 0) {
        return { final: false, reason: 'CANONICAL_HEAD_REGRESSED', policy: this.policy, nowHead: head, includedBlock: included };
      }
    }

    const depth = Number(head.number) - Number(included ? included.number : receipt.blockNumber);
    if (depth < 0) {
      return { final: false, reason: 'INCLUDED_ABOVE_HEAD', policy: this.policy, nowHead: head, includedBlock: included };
    }
    if (depth >= confirmations) {
      return { final: true, reason: 'CONFIRMED', policy: this.policy, confirmations: Math.max(depth + 1, confirmations), nowHead: head, includedBlock: included, safeCovered: false, finalizedCovered: false };
    }
    return { final: false, reason: 'NOT_ENOUGH_CONFIRMATIONS', needed: confirmations, depth, policy: this.policy, nowHead: head, includedBlock: included, safeCovered: false, finalizedCovered: false };
  }

  /**
   * Persisted stall detection: uses persisted progress observations of the
   * canonical head (block + timestamp) across calls. A single unchanged head
   * is NOT a stall; only when NO progress occurs over stallMs do we report
   * FINALITY_STALL (prevents treating one unchanged head as a stall).
   */
  async checkStall(key = 'head', now = Date.now()) {
    const prev = await this.progressStore.get(key);
    const head = await this.getBlock('latest');
    const cur = head && head.number !== undefined ? { block: head.number, at: now, hash: head.hash || null } : null;
    await this.progressStore.put(key, cur);
    if (!prev || prev.block === undefined) return { stalled: false, note: 'first observation' };
    if (cur && cur.block > prev.block) return { stalled: false, note: 'progress observed' };
    const elapsed = now - (prev.at || now);
    if (elapsed >= this.stallMs) {
      return { stalled: true, reason: 'FINALITY_STALL', prevBlock: prev.block, curBlock: cur ? cur.block : null, elapsedMs: elapsed, thresholdMs: this.stallMs };
    }
    return { stalled: false, note: 'no progress yet within threshold', elapsedMs: elapsed, thresholdMs: this.stallMs };
  }

  /**
   * RPC disagreement: requires two ACTUAL conflicting observations of the
   * safe/finalized head. Callers accumulate observations via observePublicHead.
   * Returns { disagreed, observations, reason? }.
   */
  async observePublicHead(tag, key = 'publicHead') {
    const headBlock = tag === 'safe' ? await this._safeHead() : await this._finalizedHead();
    const obs = { tag, block: headBlock ? headBlock.number : null, hash: headBlock ? headBlock.hash : null, at: Date.now() };
    const prev = await this.progressStore.get(key + '.' + tag);
    await this.progressStore.put(key + '.' + tag, obs);
    if (prev && prev.hash && obs.hash && prev.block === obs.block && !sameHash(prev.hash, obs.hash)) {
      return { disagreed: true, reason: 'RPC_DISAGREEMENT', prev, obs };
    }
    return { disagreed: false, prev, obs };
  }

  /** A fixed waiting period is NOT finality — this never returns final. */
  async fixedWaitFinality(/* receipt */) {
    return { final: false, reason: 'FIXED_WAIT_IS_NOT_FINALITY', policy: this.policy };
  }
}

module.exports = { FinalityAdapter, LOCAL_ONLY_NOTE, POLICIES, LOCAL_SYNTHETIC_CHAIN, classifyChain, assertSupportedNetwork, assertPublicFinalityChain, assertLocalConfirmationsChain };