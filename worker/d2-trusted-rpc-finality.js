// D2 trusted-RPC historical finality — an EXPLICIT, DISTINCT safe/finalized
// assertion for deep history that relies on the node's OWN canonical-chain and
// consensus-status assertions, WITHOUT an unbounded ancestry traversal and
// WITHOUT silently weakening the existing bounded-ancestry method.
//
// RELATION TO E1A/E1B/E1C:
//   - E1A FinalityAdapter (worker/d2-finality.js): bounded-ancestry walk from
//     the safe/finalized head back to the included block (maxDepth, default
//     256). Beyond the bound it FAILS CLOSED with BOUND_EXCEEDED.
//   - E1C HistoricalMembership (worker/d2-historical-finality.js): canonical
//     membership (receipt present, block hash canonical, tx in canonical
//     block) is EXPLICITLY NOT finality; assertPublicFinality is the distinct
//     bounded-walk public assertion with head-binding recheck.
//   - THIS MODULE: a THIRD, distinct method for DEEP history. It does NOT
//     walk ancestry at all. Instead it treats the node's safe/finalized tag
//     as the consensus-status assertion and establishes historical
//     SAFE/FINALIZED status from that assertion plus identity, canonical
//     membership, coverage, and consistency rechecks. The bounded-ancestry
//     method is untouched and never widened.
//
// DOCUMENTED TRUST MODEL (official Base / OP Stack semantics):
//   - OP Stack nodes expose three states over JSON-RPC: unsafe (served as the
//     `latest` block tag), `safe`, and `finalized`. Base's public RPC accepts
//     all three tags on eth_getBlockByNumber.
//       * `safe`: the block's data has been published to an Ethereum block;
//         ordering no longer depends on the Sequencer, but the Ethereum block
//         can still, in principle, reorg until Ethereum finalizes it.
//       * `finalized`: the Ethereum block containing the data has been
//         finalized by Ethereum's consensus mechanism; as final as an
//         ordinary Ethereum transaction.
//     Sources: docs.optimism.io/op-stack/transactions/transaction-finality;
//     docs.base.org/base-chain/api-reference/rpc-overview (block parameters).
//   - The configured provider is a TRUSTED source of the canonical chain, the
//     receipts, and the safe/finalized tags. An assertion here is an RPC
//     observation of the node's canonical-chain and consensus-status claims.
//     It is NOT independent consensus reconstruction and NOT a cryptographic
//     ancestry proof: we do not re-derive consensus from L1, replay
//     transactions, or reconstruct an L2 state root.
//   - CANONICAL MEMBERSHIP ALONE IS INSUFFICIENT (preserved): a transaction
//     present in a canonical block at its recorded height is on the
//     currently-canonical chain; it is NOT safe/finalized until the node's
//     consensus-status assertion (the safe/finalized tag) covers it. This
//     module requires BOTH the membership check AND the tagged-head coverage.
//
// WHAT "COVERED BY A TAGGED HEAD" MEANS HERE (no ancestry walk):
//   - The included block's number must be AT OR BELOW the tagged head's
//     number (arithmetic head-position coverage against the node's
//     assertion). Because the tagged head IS the node's assertion that every
//     canonical block up to that height is safe/finalized (per the official
//     OP Stack semantics above), arithmetic coverage is the correct, bounded
//     reading of that assertion for deep history.
//   - The tagged head must be STABLE across a verification-time recheck: the
//     node must re-present the SAME canonical hash at the SAME height (a
//     normally advancing head advances the NUMBER; the included block stays
//     at or below it — that is not a reorg). A REGRESSING or CHANGING head
//     (same number, different hash) fails closed. A tagged head below the
//     included block fails closed.
//   - We do not need to walk parents to prove "B is in the canonical prefix
//     covered by F": the node's tag claims the prefix; our stability recheck
//     verifies the node holds that claim across the verification window, and
//     the membership check verifies B is the canonical block at its height on
//     the SAME canonical chain (its hash is the canonical hash at that
//     height). Contradictory observations (changing hash, regressing head,
//     tag below included block, head binding changed) are explicit failures.
//
// CONSISTENCY POLICY FOR A NORMALLY ADVANCING HEAD (defined precisely):
//   - ADVANCING (number increases): always consistent. The verification-time
//     recheck reads the tag again; the included block remains at or below the
//     (possibly higher) head. No reorg is inferred from an advancing head.
//   - REGRESSING (number decreases): fails closed (HEAD_REGRESSED).
//   - CHANGING (same number, different hash): fails closed
//     (HEAD_BINDING_CHANGED).
//   - A tagged head missing / not resolvable / unsupported: fails closed
//     (TAG_UNAVAILABLE / TAG_UNSUPPORTED).
//
// REQUEST BUDGET (bounded): every send() is counted; a configured budget
// (default 12 reads) bounds the total RPC work. Exhaustion fails closed
// (REQUEST_BUDGET_EXHAUSTED) — never an unbounded crawl.
//
// BOUNDED RETRIES: a transient read failure is retried up to retryLimit
// (default 2) with the budget still enforced; a persistent failure fails
// closed (OBSERVATION_UNAVAILABLE).
//
// SAFE IS NEVER LABELED FINALIZED: op-stack-safe returns SAFE with
// finalized=false. op-stack-finalized requires finalized-head coverage; safe
// coverage alone is SAFE_ONLY (insufficient, final=false).
//
// Mainnet refusal (chain 1) and deployment-identity restrictions preserved:
// public policy on mainnet is refused (FINALITY_MAINNET_NOT_ACTIVATED);
// local-confirmations remain chain-31337-only; nothing here activates a
// public-chain deployment.

'use strict';

const LOCAL_SYNTHETIC_CHAIN = 31337;
const MAINNET_CHAIN = 1;
const DEFAULT_MAX_DEPTH = 256; // kept for interface compatibility; not used to widen any walk
const DEFAULT_REQUEST_BUDGET = 12;
const DEFAULT_RETRY_LIMIT = 2;
const TAGS = new Set(['safe', 'finalized']);

const { getBlockByRef } = require('./d2-historical-finality.js');
// E1 closure: explicit supported-network policy. Public finality checks are
// permitted ONLY on the explicit public-testnet chain (Base Sepolia 84532).
// Recognized mainnets (Ethereum 1, Base 8453) and arbitrary chains are
// rejected — never "not chain 1".
const { classifyChain, assertPublicFinalityChain } = require('../mainnet/design/support/supported-networks.js');

function noLeadZero(h) { return String(h || '').toLowerCase().replace(/^0x/, ''); }
function sameHash(a, b) { return noLeadZero(a) === noLeadZero(b) && !!a && !!b; }

/**
 * TrustedRpcFinality — explicit trusted-RPC safe/finalized assertion for
 * historical transactions (deep history), distinct from the bounded-ancestry
 * method and from canonical membership.
 */
class TrustedRpcFinality {
  /**
   * @param {object} opts
   * @param {object} opts.provider ethers JsonRpcProvider (send()-capable) —
   *   the TRUSTED source of canonical blocks, receipts, and safe/finalized tags.
   * @param {number} opts.chainId chain id this assertion is bound to
   * @param {number} [opts.requestBudget] max total send() reads before fail-closed (default 12)
   * @param {number} [opts.retryLimit] retries per transient read failure (default 2)
   * @param {number} [opts.maxDepth] accepted for interface compatibility only;
   *   this method performs NO ancestry walk.
   */
  constructor(opts) {
    this.provider = opts.provider;
    this.chainId = Number(opts.chainId);
    this.requestBudget = opts.requestBudget || DEFAULT_REQUEST_BUDGET;
    this.retryLimit = opts.retryLimit !== undefined ? opts.retryLimit : DEFAULT_RETRY_LIMIT;
    this.maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH;
    this._calls = 0;
    this._log = [];
  }

  /** Per-instance RPC accounting (the request budget). */
  _send(method, params) {
    this._calls += 1;
    this._log.push({ method, params: params.slice() });
    return this.provider.send(method, params);
  }

  async _readBlockByRef(ref) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retryLimit; attempt += 1) {
      if (this._calls >= this.requestBudget) {
        const e = new Error('REQUEST_BUDGET_EXHAUSTED');
        e.code = 'REQUEST_BUDGET_EXHAUSTED';
        throw e;
      }
      try {
        return await getBlockByRef({ send: (m, p) => this._send(m, p) }, ref);
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'REQUEST_BUDGET_EXHAUSTED') throw err;
      }
    }
    const e = new Error('OBSERVATION_UNAVAILABLE:' + String((lastErr && lastErr.message) || lastErr));
    e.code = 'OBSERVATION_UNAVAILABLE';
    throw e;
  }

  async _readReceipt(txHash) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retryLimit; attempt += 1) {
      if (this._calls >= this.requestBudget) {
        const e = new Error('REQUEST_BUDGET_EXHAUSTED');
        e.code = 'REQUEST_BUDGET_EXHAUSTED';
        throw e;
      }
      try {
        const r = await this._send('eth_getTransactionReceipt', [txHash]);
        return r;
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'REQUEST_BUDGET_EXHAUSTED') throw err;
      }
    }
    const e = new Error('OBSERVATION_UNAVAILABLE:' + String((lastErr && lastErr.message) || lastErr));
    e.code = 'OBSERVATION_UNAVAILABLE';
    throw e;
  }

  _readBlockNumberFromReceipt(r) {
    const n = parseInt(r.blockNumber, 16);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Establish historical SAFE/FINALIZED status for one transaction reference
   * from the node's OWN assertions. This is the DISTINCT method for E1D.
   *
   * @param {object} opts { txHash, policy, receipt? }
   *   policy: 'op-stack-safe' | 'op-stack-finalized'
   * @returns {Promise<object>} { final, reason, safeCovered, finalizedCovered,
   *   safeHead, finalizedHead, includedBlock, depth, observedAt, requests,
   *   requestLog, trustModel, consistency }
   *   - final:true only under the required tag coverage + stability rechecks.
   *   - SAFE is never labeled FINALIZED.
   *   - Explicit failures: RECEIPT_ABSENT, RECEIPT_INCOMPLETE,
   *     RECEIPT_IDENTITY_MISMATCH, CANONICAL_BLOCK_UNAVAILABLE,
   *     CANONICAL_BLOCK_HASH_MISMATCH, TX_NOT_IN_CANONICAL_BLOCK,
   *     HEAD_UNAVAILABLE, TAG_UNAVAILABLE, TAG_UNSUPPORTED,
   *     INCLUDED_ABOVE_HEAD, HEAD_REGRESSED, HEAD_BINDING_CHANGED,
   *     SAFE_ONLY (finalized policy, safe coverage only),
   *     REQUEST_BUDGET_EXHAUSTED, OBSERVATION_UNAVAILABLE,
   *     FINALITY_MAINNET_NOT_ACTIVATED, FINALITY_POLICY_UNSUPPORTED.
   */
  async assertHistoricalFinality(opts) {
    const observedAt = new Date().toISOString();
    const policy = String(opts.policy || '');
    if (!TAGS.has(policy) && policy !== 'op-stack-safe' && policy !== 'op-stack-finalized') {
      return this._result({ final: false, reason: 'FINALITY_POLICY_UNSUPPORTED:' + policy, observedAt });
    }
    const safePolicy = policy === 'op-stack-safe' || policy === 'safe';
    const finalizedPolicy = policy === 'op-stack-finalized' || policy === 'finalized';
    // E1 closure: explicit supported-network policy. Mainnet chains (1 and
    // 8453 Base mainnet) fail closed; arbitrary chains fail closed. Only the
    // explicit public-testnet chain (84532) may run public checks.
    if (this.chainId === MAINNET_CHAIN || classifyChain(this.chainId) === 'mainnet' || classifyChain(this.chainId) === 'unsupported') {
      const cls = classifyChain(this.chainId);
      return this._result({ final: false, reason: cls === 'mainnet' ? 'FINALITY_MAINNET_NOT_ACTIVATED:' + this.chainId : 'FINALITY_NETWORK_UNSUPPORTED:' + this.chainId, observedAt });
    }

    const txHash = String(opts.txHash || '').toLowerCase();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return this._result({ final: false, reason: 'INVALID_TX_HASH', observedAt });
    }

    // --- Chain and transaction/receipt identity checks ----------------------
    let r = opts.receipt;
    if (!r) {
      try { r = await this._readReceipt(txHash); }
      catch (e) { return this._result({ final: false, reason: e.code || 'OBSERVATION_UNAVAILABLE', detail: e.message, observedAt }); }
    }
    if (!r) return this._result({ final: false, reason: 'RECEIPT_ABSENT', observedAt });
    const receiptHash = r.transactionHash || r.hash;
    if (receiptHash && !sameHash(receiptHash, txHash)) {
      return this._result({ final: false, reason: 'RECEIPT_IDENTITY_MISMATCH', detail: { asked: txHash, got: receiptHash }, observedAt });
    }
    const receiptBlockNumber = this._readBlockNumberFromReceipt(r);
    const receiptBlockHash = r.blockHash;
    if (receiptBlockNumber === null || !receiptBlockHash) {
      return this._result({ final: false, reason: 'RECEIPT_INCOMPLETE', observedAt });
    }

    // --- Canonical block/hash and transaction-membership checks ------------
    // The canonical block at the recorded height (by NUMBER) must still match
    // the receipt's recorded block hash, and the tx must be present in that
    // canonical block. This is the SAME canonical-chain assertion the
    // verifier already uses; it is REQUIRED, never sufficient by itself.
    let canonical;
    try { canonical = await this._readBlockByRef(receiptBlockNumber); }
    catch (e) { return this._result({ final: false, reason: e.code || 'OBSERVATION_UNAVAILABLE', detail: e.message, observedAt }); }
    if (!canonical || canonical.number === null || canonical.number === undefined) {
      return this._result({ final: false, reason: 'CANONICAL_BLOCK_UNAVAILABLE', observedAt });
    }
    if (!sameHash(canonical.hash, receiptBlockHash)) {
      return this._result({ final: false, reason: 'CANONICAL_BLOCK_HASH_MISMATCH', detail: { receiptBlockHash, canonicalHash: canonical.hash }, observedAt });
    }
    let txInBlock = false;
    if (canonical.transactions) {
      txInBlock = canonical.transactions.some((t) => {
        const th = typeof t === 'string' ? t : (t && (t.hash || t.transactionHash));
        return th ? noLeadZero(th) === noLeadZero(txHash) : false;
      });
    } else {
      // Provider did not return the transaction list. For a full canonical
      // membership assertion this is an explicit failure (we cannot verify
      // membership). We NEVER infer membership from an absent list.
      return this._result({ final: false, reason: 'TX_IN_BLOCK_UNVERIFIABLE', observedAt });
    }
    if (!txInBlock) {
      return this._result({ final: false, reason: 'TX_NOT_IN_CANONICAL_BLOCK', observedAt });
    }

    // --- Required tagged-head observation + coverage + consistency ---------
    // Read the current latest head so we can detect a regressing/changing
    // canonical head across the verification window.
    let latest;
    try { latest = await this._readBlockByRef('latest'); }
    catch (e) { return this._result({ final: false, reason: e.code || 'HEAD_UNAVAILABLE', detail: e.message, observedAt }); }
    if (!latest || latest.number === null || latest.number === undefined) {
      return this._result({ final: false, reason: 'HEAD_UNAVAILABLE', observedAt });
    }

    // First observation of the required tag(s).
    let safeHead = null, finalHead = null;
    try {
      safeHead = await this._readBlockByRef('safe');
      finalHead = finalizedPolicy ? await this._readBlockByRef('finalized') : null;
    } catch (e) {
      return this._result({ final: false, reason: e.code || 'OBSERVATION_UNAVAILABLE', detail: e.message, observedAt });
    }
    if (!safeHead || safeHead.number === null || safeHead.number === undefined || !safeHead.hash) {
      return this._result({ final: false, reason: 'TAG_UNAVAILABLE', tag: 'safe', observedAt });
    }
    if (finalizedPolicy && (!finalHead || finalHead.number === null || finalHead.number === undefined || !finalHead.hash)) {
      return this._result({ final: false, reason: 'TAG_UNAVAILABLE', tag: 'finalized', observedAt });
    }

    const included = { number: receiptBlockNumber, hash: canonical.hash };
    const depth = Number(safeHead.number) - Number(included.number);

    // Coverage by the node's assertions (arithmetic, no ancestry walk):
    // included.number <= safeHead.number and, for the finalized policy,
    // included.number <= finalizedHead.number. A tagged head BELOW the
    // included block is a contradiction (the node's own assertion says the
    // block is not yet covered) -> INCLUDED_ABOVE_HEAD.
    const safeCovers = Number(included.number) <= Number(safeHead.number);
    const finalCovers = finalizedPolicy ? (finalHead ? Number(included.number) <= Number(finalHead.number) : false) : false;
    if (!safeCovers) {
      return this._result({ final: false, reason: 'INCLUDED_ABOVE_HEAD', tag: 'safe', safeHead, finalizedHead: finalHead, includedBlock: included, depth, observedAt });
    }
    if (finalizedPolicy && !finalCovers) {
      return this._result({ final: false, reason: 'INCLUDED_ABOVE_HEAD', tag: 'finalized', safeHead, finalizedHead: finalHead, includedBlock: included, depth, observedAt });
    }

    // --- Verification-time recheck (consistency across the window) ---------
    // The node must re-present the SAME canonical hash at the SAME height for
    // the required tag(s) — this is the head-binding/consistency recheck.
    //   - Advancing head (number increased): consistent; the included block
    //     stays at or below the (higher) head. NOT a reorg.
    //   - Regressing head (number decreased): HEAD_REGRESSED (fail closed).
    //   - Changing head (same number, different hash): HEAD_BINDING_CHANGED
    //     (fail closed).
    //   - Tag below included block on recheck: INCLUDED_ABOVE_HEAD.
    let safeNow = null, finalNow = null;
    try {
      safeNow = await this._readBlockByRef('safe');
      finalNow = finalizedPolicy ? await this._readBlockByRef('finalized') : null;
    } catch (e) {
      return this._result({ final: false, reason: e.code || 'OBSERVATION_UNAVAILABLE', detail: e.message, observedAt });
    }
    if (!safeNow || safeNow.number === null || safeNow.number === undefined || !safeNow.hash) {
      return this._result({ final: false, reason: 'TAG_UNAVAILABLE', tag: 'safe', observedAt });
    }
    if (finalizedPolicy && (!finalNow || finalNow.number === null || finalNow.number === undefined || !finalNow.hash)) {
      return this._result({ final: false, reason: 'TAG_UNAVAILABLE', tag: 'finalized', observedAt });
    }
    const safeChanged = !sameHash(safeNow.hash, safeHead.hash) || Number(safeNow.number) !== Number(safeHead.number);
    const finalChanged = finalizedPolicy ? (!finalNow || !sameHash(finalNow.hash, finalHead.hash) || Number(finalNow.number) !== Number(finalHead.number)) : false;

    const consistency = {
      policy,
      headBefore: { safe: { number: safeHead.number, hash: safeHead.hash }, finalized: finalHead ? { number: finalHead.number, hash: finalHead.hash } : null },
      headAfter: { safe: { number: safeNow.number, hash: safeNow.hash }, finalized: finalNow ? { number: finalNow.number, hash: finalNow.hash } : null },
      advancingIsConsistent: Number(safeNow.number) > Number(safeHead.number),
      regressedSafe: Number(safeNow.number) < Number(safeHead.number),
      changedSafe: Number(safeNow.number) === Number(safeHead.number) && !sameHash(safeNow.hash, safeHead.hash),
    };

    // The recheck of the CURRENT latest head: it must not have regressed below
    // the required tagged head (a canonical head that fell behind its own tag
    // is a contradiction).
    let latestNow;
    try { latestNow = await this._readBlockByRef('latest'); }
    catch (e) { /* non-fatal for consistency; the tag rechecks are authoritative */ latestNow = null; }
    if (latestNow && latestNow.number !== null && latestNow.number !== undefined) {
      consistency.latestBefore = latest.number;
      consistency.latestAfter = latestNow.number;
      consistency.latestRegressed = Number(latestNow.number) < Number(latest.number);
    }

    if (Number(safeNow.number) < Number(safeHead.number)) {
      return this._result({ final: false, reason: 'HEAD_REGRESSED', tag: 'safe', safeHead, finalizedHead: finalHead, includedBlock: included, depth, consistency, observedAt });
    }
    if (Number(safeNow.number) === Number(safeHead.number) && !sameHash(safeNow.hash, safeHead.hash)) {
      return this._result({ final: false, reason: 'HEAD_BINDING_CHANGED', tag: 'safe', safeHead, finalizedHead: finalHead, includedBlock: included, depth, consistency, observedAt });
    }
    if (finalizedPolicy) {
      if (Number(finalNow.number) < Number(finalHead.number)) {
        return this._result({ final: false, reason: 'HEAD_REGRESSED', tag: 'finalized', safeHead: safeNow, finalizedHead: finalHead, includedBlock: included, depth, consistency, observedAt });
      }
      if (Number(finalNow.number) === Number(finalHead.number) && !sameHash(finalNow.hash, finalHead.hash)) {
        return this._result({ final: false, reason: 'HEAD_BINDING_CHANGED', tag: 'finalized', safeHead: safeNow, finalizedHead: finalHead, includedBlock: included, depth, consistency, observedAt });
      }
    }

    // Recheck coverage against the (possibly advanced) rechecked heads: the
    // included block must remain at or below the rechecked tagged head.
    const safeCoversNow = Number(included.number) <= Number(safeNow.number);
    const finalCoversNow = finalizedPolicy ? Number(included.number) <= Number(finalNow.number) : false;
    if (!safeCoversNow) {
      return this._result({ final: false, reason: 'INCLUDED_ABOVE_HEAD', tag: 'safe', safeHead: safeNow, finalizedHead: finalHead, includedBlock: included, depth, observedAt });
    }
    if (finalizedPolicy && !finalCoversNow) {
      return this._result({ final: false, reason: 'INCLUDED_ABOVE_HEAD', tag: 'finalized', safeHead: safeNow, finalizedHead: finalNow, includedBlock: included, depth, observedAt });
    }

    const safeCovered = true;
    const finalizedCovered = finalizedPolicy ? true : false;

    // --- Result -------------------------------------------------------------
    if (safePolicy) {
      // op-stack-safe: safe coverage is SAFE, never consensus-finalized.
      return this._result({
        final: true,
        reason: 'SAFE_COVERED',
        safeCovered: true,
        finalizedCovered: false,
        safeHead: safeNow,
        finalizedHead: finalNow,
        includedBlock: included,
        depth: Number(safeNow.number) - Number(included.number),
        consistency,
        observedAt,
      });
    }
    // op-stack-finalized: requires finalized coverage. Safe coverage alone
    // would be SAFE_ONLY (already handled above by finalCovers checks).
    return this._result({
      final: true,
      reason: 'FINALIZED_COVERED',
      safeCovered: true,
      finalizedCovered: true,
      safeHead: safeNow,
      finalizedHead: finalNow,
      includedBlock: included,
      depth: Number(finalNow.number) - Number(included.number),
      consistency,
      observedAt,
    });
  }

  _result(base) {
    const requests = this._calls;
    return {
      ...base,
      requests,
      requestLog: this._log.slice(),
      trustModel: {
        kind: 'trusted-rpc-consensus-status-assertion',
        note: 'Relies on the configured node\'s canonical-chain and consensus-status (safe/finalized tag) assertions. Not independent consensus reconstruction and not a cryptographic ancestry proof. Canonical membership alone is insufficient; the required tagged-head coverage and consistency rechecks are also required.',
      },
    };
  }
}

module.exports = { TrustedRpcFinality, LOCAL_SYNTHETIC_CHAIN, MAINNET_CHAIN, DEFAULT_REQUEST_BUDGET, DEFAULT_RETRY_LIMIT, classifyChain, assertPublicFinalityChain };
