'use strict';

// v4 finality adapter — trusted-config seam between the v4 candidate verifier
// and the E1A FinalityAdapter (worker/d2-finality.js).
//
// Purpose: let the v4 lifecycle verifier observe OP Stack safe/finalized head
// coverage for the ACTUAL funding and settlement transactions of an export,
// purely by READ-ONLY RPC observation, without any broadcast, spending,
// deployment, or consensus reconstruction.
//
// Trust model (documented): the configured provider is a TRUSTED source of
// the canonical chain, receipts, and the safe/finalized tags. We observe the
// tags the node reports; we do NOT re-derive consensus, replay transactions,
// or reconstruct the L2 state root from L1. Therefore an observation here is
// an RPC observation, never an independent consensus proof.
//
// Policy selection is TRUSTED CONFIG, never export-owned: the verifier passes
// the policy from environment/operator configuration (SAAX_V4_FINALITY), and
// an export's `finality.mode` can never lower, override, or select it. A
// public policy is only ever evaluated against a chain profile that is
// explicitly supported by repository-owned configuration (84532 historical
// local profile remains NOT a public deployment policy; see
// verifier/v4-eas-policy.json and v4-candidate-identity.json).
//
// Boundary semantics (identical to E1A):
//   - local-synthetic  -> chain 31337 only, NEVER public finality.
//   - op-stack-safe    -> SAFE stage only. A receipt covered by the safe head
//                         is SAFE (safeStage=true, finalized=false). It must
//                         never be labeled consensus-finalized.
//   - op-stack-finalized -> requires finalized-head coverage of every
//                         required reference; safe coverage alone is
//                         SAFE_ONLY (insufficient -> INCOMPLETE).
//   - Missing tags / bounded-ancestry exhaustion / receipt or canonical-block
//     mismatch -> reported reason, FAIL CLOSED (never final).
//
// E1D addition: observeHistoricalFinality — an EXPLICIT, DISTINCT trusted-RPC
// historical finality assertion for DEEP history (worker/d2-trusted-rpc-finality.js).
// It relies on the node's OWN canonical-chain and consensus-status (safe/
// finalized tag) assertions: identity checks, canonical block/hash + tx
// membership checks, required tagged-head observation, coverage (included <=
// tagged head) and consistency rechecks (stability across the verification
// window), bounded retries + request budget, explicit failure for
// contradictory/unstable/unavailable/unsupported observations. NO ancestry
// walk. The bounded-ancestry method (observeFinality) is untouched — this is
// ADDITIVE, never a weakening.

const { FinalityAdapter } = require('../worker/d2-finality.js');
// E1D: explicit trusted-RPC historical finality (deep history, no ancestry
// walk). Additive — the bounded-ancestry method stays the default.
const { TrustedRpcFinality } = require('../worker/d2-trusted-rpc-finality.js');
// E1 closure: explicit supported-network policy. Public finality checks are
// permitted ONLY on the explicit public-testnet chain (84532); Base mainnet
// 8453 and Ethereum chain 1 are explicitly BLOCKED; arbitrary chains are
// unsupported. Exported chain/method/policy values can never select a chain.
const { classifyChain, assertPublicFinalityChain } = require('../mainnet/design/support/supported-networks.js');

// Whitelist of OP Stack tag strings resolvable via eth_getBlockByNumber.
const TAG_BLOCK = new Set(['safe', 'finalized', 'latest', 'pending']);
// Default ancestry/RPC walk bound for coverage by a tagged head (matches the
// adapter default; the read-only observer can tighten it).
const DEFAULT_MAX_DEPTH = 256;

const LOCAL_ONLY = 'local-synthetic';
const MODES = new Set([LOCAL_ONLY, 'op-stack-safe', 'op-stack-finalized']);

function resolvePolicy(input) {
  // Trusted configuration may come from an operator-supplied string or an
  // explicit {mode} object. Unknown modes fail closed at construction.
  const raw = typeof input === 'object' && input ? input.mode : input;
  let mode = String(raw || LOCAL_ONLY).trim();
  // 'local-confirmations' is the E1A adapter's internal spelling for the
  // local-synthetic verifier mode; accept it as a trusted alias so operator
  // configuration and the adapter's public interface stay consistent.
  if (mode === 'local-confirmations') mode = LOCAL_ONLY;
  if (!MODES.has(mode)) {
    const e = new Error('FINALITY_POLICY_UNSUPPORTED:' + mode);
    e.code = 'FINALITY_POLICY_UNSUPPORTED';
    throw e;
  }
  return mode;
}

/**
 * Wrap an ethers JsonRpcProvider so the FinalityAdapter can read blocks,
 * receipts, and tagged heads through provider.send (raw JSON-RPC). This is a
 * read-only binding: only eth_* read methods are ever invoked.
 */
function bindProvider(provider, opts = {}) {
  const maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH;
  // The verifier surface uses 'local-synthetic' for the trusted-config local
  // mode; the E1A FinalityAdapter names that mode 'local-confirmations'.
  const adapterPolicy = String(opts.policy || LOCAL_ONLY) === LOCAL_ONLY ? 'local-confirmations' : opts.policy;
  const getBlock = async (tag) => {
    const s = String(tag);
    let param;
    if (TAG_BLOCK.has(s)) param = s;
    else if (/^0x[0-9a-fA-F]{64}$/.test(s)) param = s; // block hash
    else param = '0x' + Number(tag).toString(16); // block number -> hex quantity
    const b = await provider.send('eth_getBlockByNumber', [param, false]);
    if (!b) return null;
    return {
      number: parseInt(b.number, 16),
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: b.timestamp ? parseInt(b.timestamp, 16) : undefined,
    };
  };
  const getReceipt = async (txHash) => {
    const r = await provider.send('eth_getTransactionReceipt', [txHash]);
    if (!r) return null;
    return {
      transactionHash: r.transactionHash,
      hash: r.transactionHash,
      status: r.status,
      blockNumber: parseInt(r.blockNumber, 16),
      blockHash: r.blockHash,
      to: r.to,
      from: r.from,
      transactionIndex: parseInt(r.transactionIndex, 16),
      logs: r.logs || [],
    };
  };
  const adapter = new FinalityAdapter({
    getBlock,
    getReceipt,
    chainId: opts.chainId,
    policy: adapterPolicy,
    maxDepth,
    getSafeHead: () => getBlock('safe'),
    getFinalizedHead: () => getBlock('finalized'),
  });
  return { adapter, getBlock, getReceipt };
}

/**
 * Read-only finality observation for one transaction reference.
 * @param {object} opts { provider, chainId, policy, txHash, maxDepth?, receipt? }
 * @returns {Promise<object>} {
 *   final, mode, reason, safeCovered, finalizedCovered, safeHead, finalizedHead,
 *   includedBlock, depth, observedAt, policy, receipt? }
 *   - reason: 'SAFE_COVERED' | 'FINALIZED_COVERED' | 'SAFE_ONLY' | 'RECEIPT_ABSENT'
 *     | 'RECEIPT_INCOMPLETE' | 'HEAD_UNAVAILABLE' | 'CANONICAL_BLOCK_UNAVAILABLE'
 *     | 'REORG_RECEIPT_BLOCK_HASH_CHANGED' | 'TAG_UNAVAILABLE' | 'INCLUDED_ABOVE_HEAD'
 *     | 'BOUND_EXCEEDED' | 'UNCOVERED_WITHIN_BOUNDS' | 'CANONICAL_BLOCK_MISMATCH'
 *     | 'FINALITY_PUBLIC_NOT_ACTIVATED' | 'POLICY_NOT_LOCAL_CONFIRMATIONS'
 *     | 'INCLUDED_BLOCK_UNAVAILABLE'
 */
async function observeFinality(opts) {
  const policy = resolvePolicy(opts.policy);
  const observedAt = new Date().toISOString();
  const txHash = String(opts.txHash || '').toLowerCase();
  const chainId = Number(opts.chainId);
  if (policy === LOCAL_ONLY) {
    // Fail closed BEFORE constructing the adapter: local synthetic
    // confirmations are chain-31337-only (explicit supported-network policy).
    if (classifyChain(chainId) !== 'local') {
      return { final: false, mode: policy, reason: 'FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337', observedAt, policy: { mode: LOCAL_ONLY, label: 'local only' } };
    }
  } else {
    // Public policy: explicit chain gate — 84532 (public-testnet) ONLY.
    try {
      const cls = assertPublicFinalityChain(chainId, { surface: 'v4-observeFinality' });
      if (cls !== 'public-testnet') {
        return { final: false, mode: policy, reason: 'FINALITY_PUBLIC_POLICY_CHAIN_UNSUPPORTED:chain=' + chainId + ':class=' + cls, observedAt, policy: { mode: policy, label: 'op-stack' } };
      }
    } catch (e) {
      return { final: false, mode: policy, reason: e.message, observedAt, policy: { mode: policy, label: 'op-stack' } };
    }
  }
  const { adapter, getReceipt } = bindProvider(opts.provider, {
    chainId: opts.chainId,
    policy,
    maxDepth: opts.maxDepth,
  });
  const receipt = opts.receipt || await getReceipt(txHash);

  if (policy === LOCAL_ONLY) {
    const r = await adapter.establishLocalFinality(receipt, { txHash, confirmations: opts.confirmations || 1 });
    return { final: r.final, mode: policy, reason: r.reason, observedAt, policy: adapter.policy, depth: r.depth, includedBlock: r.includedBlock, nowHead: r.nowHead };
  }

  const r = await adapter.establishFinality(receipt, { txHash });
  return {
    final: !!r.final,
    mode: policy,
    reason: r.reason || 'NOT_FINAL',
    safeCovered: !!r.safeCovered,
    finalizedCovered: !!r.finalizedCovered,
    safeHead: r.safe || null,
    finalizedHead: r.finalized || null,
    includedBlock: r.includedBlock || null,
    depth: r.depth !== undefined ? r.depth : null,
    observedAt,
    policy: adapter.policy,
  };
}

/**
 * E1D: read-only trusted-RPC historical finality observation for one
 * transaction reference, using the node's OWN canonical-chain and
 * consensus-status (safe/finalized tag) assertions. Deep history is
 * established WITHOUT an ancestry walk; the tagged head IS the node's
 * assertion of the canonical prefix it covers. Requires identity checks,
 * canonical membership, required-tagged-head observation, coverage and
 * consistency rechecks, bounded retries/request budget, and explicit failure
 * for contradictory/unstable/unavailable/unsupported observations.
 *
 * Policy selection is TRUSTED CONFIG, never export-owned (same as
 * observeFinality). An export can never select or lower this method.
 *
 * @param {object} opts { provider, chainId, policy, txHash, requestBudget?,
 *                        retryLimit?, receipt? }
 *   policy: 'op-stack-safe' | 'op-stack-finalized' (trusted config only)
 * @returns {Promise<object>} the TrustedRpcFinality assertion result plus
 *   { mode, policy, observedAt }.
 */
async function observeHistoricalFinality(opts) {
  const policy = resolvePolicy(opts.policy);
  const txHash = String(opts.txHash || '').toLowerCase();
  const observedAt = new Date().toISOString();
  const chainId = Number(opts.chainId);
  if (policy === LOCAL_ONLY) {
    if (classifyChain(chainId) !== 'local') {
      return { final: false, mode: policy, reason: 'FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337', observedAt, policy: { mode: LOCAL_ONLY, label: 'local only' } };
    }
    return { final: false, mode: policy, reason: 'FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337', observedAt, policy: { mode: LOCAL_ONLY, label: 'local only' } };
  }
  // Public policy: explicit chain gate — 84532 (public-testnet) ONLY.
  try {
    const cls = assertPublicFinalityChain(chainId, { surface: 'v4-observeHistoricalFinality' });
    if (cls !== 'public-testnet') {
      return { final: false, mode: policy, reason: 'FINALITY_PUBLIC_POLICY_CHAIN_UNSUPPORTED:chain=' + chainId + ':class=' + cls, observedAt, policy: { mode: policy, label: 'op-stack' } };
    }
  } catch (e) {
    return { final: false, mode: policy, reason: e.message, observedAt, policy: { mode: policy, label: 'op-stack' } };
  }
  const trusted = new TrustedRpcFinality({
    provider: opts.provider,
    chainId: opts.chainId,
    requestBudget: opts.requestBudget,
    retryLimit: opts.retryLimit,
  });
  const res = await trusted.assertHistoricalFinality({ txHash, policy, receipt: opts.receipt });
  return {
    final: !!res.final,
    mode: policy,
    reason: res.reason,
    safeCovered: !!res.safeCovered,
    finalizedCovered: !!res.finalizedCovered,
    safeHead: res.safeHead || null,
    finalizedHead: res.finalizedHead || null,
    includedBlock: res.includedBlock || null,
    depth: res.depth !== undefined ? res.depth : null,
    observedAt,
    policy: { mode: policy, label: policy === 'op-stack-safe' ? 'op-stack safe (trusted-rpc)' : 'op-stack finalized (trusted-rpc)', method: 'trusted-rpc' },
    requests: res.requests,
    consistency: res.consistency || null,
    trustModel: res.trustModel || null,
  };
}

module.exports = { observeFinality, observeHistoricalFinality, bindProvider, resolvePolicy, LOCAL_ONLY, MODES, DEFAULT_MAX_DEPTH, classifyChain, assertPublicFinalityChain };