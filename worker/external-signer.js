// external-signer.js — Phase D4B external signer interface (relayer transaction
// signing ONLY, never broadcasting, never evaluator authority).
//
// PURPOSE
//   Provide a restricted interface through which the worker obtains a signed
//   transaction from an EXTERNALLY HELD relayer key. The interface supports:
//     - obtaining/verifying the expected public signing identity,
//     - signing a fully specified transaction WITHOUT broadcasting,
//     - explicit timeout, unavailable-provider, malformed-response, and
//       wrong-key errors,
//     - independent recovery/validation of the returned signed transaction.
//   Authorization/policy validation happens BEFORE signing (the caller passes a
//   fully validated "sign request" — the worker's signing-vault already
//   enforced chain/custody/action/value/fee/op bounds); the external signer
//   re-validates the request against its OWN configured policy and refuses
//   anything outside it. Returned bytes are re-validated against the immutable
//   prepared intent by the caller (hash recompute + field decode) before any
//   broadcast.
//
// THE EXTERNAL SIGNER MUST NOT SILENTLY BECOME THE EVALUATOR.
//   Evaluator approval remains through the agreed Safe authorization mechanism
//   (2-of-3 Safe + ERC-1271, Phase 3B). This interface signs RELAYER
//   TRANSACTIONS ONLY; it never produces or substitutes evaluator verdict
//   signatures, and the worker never treats its bytes as evaluator approval.
//
// PROVIDER ADAPTERS
//   - A real provider (HSM/KMS/remote signer) is NOT configured in this phase.
//     Actual HSM/KMS integration and production key custody are UNVERIFIED /
//     PENDING (see D4A plan §7 and this module's TRUST BOUNDARY).
//   - A separate-process SYNTHETIC REFERENCE IMPLEMENTATION is provided
//     (external-signer-refserver.js + signerRefClient below) so the interface
//     and the protected pipeline can be exercised end-to-end on local EVM
//     31337 with a synthetic isolated signer. It is a REFERENCE implementation,
//     not a product. It is NOT an HSM and is never labeled one.
//
// TRUST BOUNDARY (stated plainly)
//   - This is an isolated local signing process/module under the same OS
//     account as the worker. That is NOT strong host-compromise isolation: a
//     compromised OS account can read the key from the environment.
//   - The reference server holds the relayer key ONLY in its own process
//     (passed via env or a key file); the worker/API process never holds it.
//   - A remote/HSM/KMS adapter is not implemented; do not label this synthetic
//     adapter as production key custody.

'use strict';

const { Wallet, Transaction } = require('ethers');
const crypto = require('node:crypto');

/** Canonical, provider-independent error codes (the interface contract). */
const ERR = {
  TIMEOUT: 'EXTERNAL_SIGNER_TIMEOUT',
  UNAVAILABLE: 'EXTERNAL_SIGNER_UNAVAILABLE',
  MALFORMED_RESPONSE: 'EXTERNAL_SIGNER_MALFORMED_RESPONSE',
  WRONG_KEY: 'EXTERNAL_SIGNER_WRONG_KEY',
  POLICY_REJECTED: 'EXTERNAL_SIGNER_POLICY_REJECTED',
  BAD_REQUEST: 'EXTERNAL_SIGNER_BAD_REQUEST',
  INTERNAL: 'EXTERNAL_SIGNER_INTERNAL',
};

/** Normalize a 0x-hex address to lowercase (throws on malformed). */
function normAddr(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new Error('bad address: ' + String(a));
  }
  return a.toLowerCase();
}

/**
 * The external signer interface. Implementations:
 *   - getSignerIdentity(): resolve the expected public signing identity
 *     (address) of the externally held key. Throws ERR.UNAVAILABLE /
 *     ERR.TIMEOUT when the provider cannot be reached.
 *   - signTransaction(req): sign a FULLY SPECIFIED transaction WITHOUT
 *     broadcasting. req is validated against the implementation's own policy
 *     first; returns { signedBytes, txHash, from, nonce }. Never broadcasts.
 *     Throws the ERR.* codes on timeout/unavailable/malformed/wrong-key.
 */
class ExternalSigner {
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs || 10000;
  }

  async getSignerIdentity() {
    throw new Error('not implemented');
  }
  async signTransaction() {
    throw new Error('not implemented');
  }

  /**
   * Re-validate a signed serialized transaction against the immutable prepared
   * intent and recompute its hash. This is INDEPENDENT of the provider: the
   * caller uses it to validate returned bytes (wrong key / tampered bytes /
   * mismatched intent all fail closed).
   * @param {string} signedBytes 0x-hex serialized signed tx
   * @param {object} intent { to, chainId, value, data, nonce, from? } expected
   * @returns {{ ok, txHash?, from?, reason? }}
   */
  static validateSignedBytes(signedBytes, intent) {
    return require('./transaction-intent.js').validateBytes(signedBytes, intent);
  }
}

/**
 * In-process SYNTHETIC REFERENCE implementation of ExternalSigner.
 * Holds the key ONLY in its own module instance. Enforces its own policy
 * (allowedChainId, custody, allowedActions/selectors, maxGasPrice, maxGasLimit,
 * expected signer address) BEFORE signing. Uses the same EIP-1559
 * signTransactionLocal shape (type 2). Labeled: reference, not production.
 */
class SyntheticReferenceSigner extends ExternalSigner {
  constructor(opts = {}) {
    super(opts);
    // keyHex: synthetic ONLY (test constants or env). In a real adapter the key
    // would never reach this process.
    this.wallet = new Wallet(opts.keyHex);
    this.policy = {
      allowedChainId: opts.allowedChainId,
      custody: opts.custody ? normAddr(opts.custody) : null,
      allowedActions: opts.allowedActions || new Set(),
      maxGasPrice: opts.maxGasPrice, // string/bigint
      maxGasLimit: opts.maxGasLimit,
      requireFrom: opts.expectedFrom ? normAddr(opts.expectedFrom) : null,
    };
    // fault injection (tests only)
    this._faults = opts.faults || {};
  }

  async getSignerIdentity() {
    if (this._faults.unavailable) throw Object.assign(new Error('provider unavailable'), { code: ERR.UNAVAILABLE });
    if (this._faults.timeout) throw Object.assign(new Error('timeout'), { code: ERR.TIMEOUT });
    return { address: this.wallet.address.toLowerCase(), label: 'synthetic-reference-signer' };
  }

  async signTransaction(req) {
    if (this._faults.timeout) throw Object.assign(new Error('timeout'), { code: ERR.TIMEOUT });
    if (this._faults.unavailable) throw Object.assign(new Error('provider unavailable'), { code: ERR.UNAVAILABLE });
    // ---- policy validation BEFORE signing (fail closed) ----
    const { to, data, value, gasLimit, gasPrice, nonce, chainId } = req;
    if (!this.policy.allowedChainId || Number(chainId) !== Number(this.policy.allowedChainId)) {
      return { ok: false, reason: ERR.POLICY_REJECTED + ':CHAIN', detail: { allowed: this.policy.allowedChainId, got: chainId } };
    }
    if (!this.policy.custody || !to || normAddr(to) !== this.policy.custody) {
      return { ok: false, reason: ERR.POLICY_REJECTED + ':DEST', detail: { custody: this.policy.custody, got: to } };
    }
    if (value !== 0n && value !== 0 && value !== '0') {
      return { ok: false, reason: ERR.POLICY_REJECTED + ':VALUE', detail: String(value) };
    }
    if (this.policy.allowedActions.size > 0 && data) {
      const sig = String(data).slice(0, 10).toLowerCase();
      const allowedSigs = [...this.policy.allowedActions].map((a) => a.toLowerCase());
      if (!allowedSigs.includes(sig)) {
        return { ok: false, reason: ERR.POLICY_REJECTED + ':ACTION', detail: { allowed: allowedSigs, got: sig } };
      }
    }
    const gp = BigInt(gasPrice || 0);
    const gl = BigInt(gasLimit || 0);
    if (this.policy.maxGasPrice && gp > BigInt(this.policy.maxGasPrice)) {
      return { ok: false, reason: ERR.POLICY_REJECTED + ':GASPRICE', detail: { max: String(this.policy.maxGasPrice), got: gp.toString() } };
    }
    if (this.policy.maxGasLimit && gl > BigInt(this.policy.maxGasLimit)) {
      return { ok: false, reason: ERR.POLICY_REJECTED + ':GASLIMIT', detail: { max: String(this.policy.maxGasLimit), got: gl.toString() } };
    }
    if (gl <= 0n) return { ok: false, reason: ERR.POLICY_REJECTED + ':GASLIMIT_REQUIRED' };
    if (this._faults.malformed) {
      // return garbage bytes — the caller's independent validation must reject
      return { ok: true, signedBytes: '0x' + 'ab'.repeat(4), txHash: '0x' + '00'.repeat(32), nonce: Number(nonce || 0) };
    }
    // ---- sign WITHOUT broadcasting ----
    // A wallet-style request may omit `type`/`from`; infer the type from the
    // fee fields (maxFeePerGas -> EIP-1559, gasPrice -> legacy) and default
    // `from` to THIS signer's own identity. The policy checks below still
    // enforce the configured expected identity, and validateBytes re-verifies
    // the recovered sender before any broadcast.
    const inferredType = req.type ?? (req.maxFeePerGas != null ? 2 : req.gasPrice != null ? 0 : 2);
    const tx = { ...require('./transaction-intent.js').normalizeIntent({ type: inferredType, from: req.from ?? this.wallet.address.toLowerCase(), ...req }) };
    if (this.policy.requireFrom && tx.from !== this.policy.requireFrom) return {ok:false, reason:ERR.WRONG_KEY};
    const fee = tx.type === 0 ? tx.gasPrice : tx.maxFeePerGas;
    if (!this.policy.maxGasPrice || fee > BigInt(this.policy.maxGasPrice)) return {ok:false,reason:ERR.POLICY_REJECTED+':GASPRICE'};
    delete tx.from;
    const signedBytes = await this.wallet.signTransaction(tx);
    const raw = signedBytes.startsWith('0x') ? signedBytes.slice(2) : signedBytes;
    const txHash = require('ethers').keccak256(Buffer.from(raw, 'hex'));
    return { ok: true, signedBytes, txHash, from: this.wallet.address.toLowerCase(), nonce: Number(nonce) };
  }
}

/**
 * HTTP client for a SEPARATE-PROCESS reference signer (see
 * external-signer-refserver.js). Transport: JSON-RPC 2.0 over localhost HTTP.
 * Implements the ExternalSigner interface: identity + sign, with timeout and
 * unavailable handling. The server holds the key; this client never does.
 */
class RefSignerClient extends ExternalSigner {
  constructor(opts = {}) {
    super(opts);
    this.endpoint = opts.endpoint; // http://127.0.0.1:PORT
    this.authToken = opts.authToken || process.env.SAAX_EXTERNAL_SIGNER_TOKEN || null;
    this.fetchImpl = opts.fetchImpl || ((url, init) => fetch(url, init));
  }

  _headers() {
    const h = { 'content-type': 'application/json' };
    if (this.authToken) h.authorization = 'Bearer ' + this.authToken;
    return h;
  }

  async _rpc(method, params) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(t);
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message || e)));
      throw Object.assign(new Error(aborted ? 'signer timeout' : 'signer unavailable: ' + (e && e.message || e)), {
        code: aborted ? ERR.TIMEOUT : ERR.UNAVAILABLE,
      });
    }
    clearTimeout(t);
    let body;
    try { body = await res.json(); } catch (e) {
      throw Object.assign(new Error('malformed response'), { code: ERR.MALFORMED_RESPONSE });
    }
    if (body.error) {
      const code = (body.error && body.error.code) || ERR.INTERNAL;
      throw Object.assign(new Error('signer rpc error: ' + (body.error.message || 'unknown')), { code });
    }
    return body.result;
  }

  async getSignerIdentity() {
    const r = await this._rpc('signer_identity', {});
    if (!r || typeof r.address !== 'string') throw Object.assign(new Error('malformed identity'), { code: ERR.MALFORMED_RESPONSE });
    return { address: r.address.toLowerCase(), label: r.label || 'external-signer' };
  }

  async signTransaction(req) {
    // JSON cannot serialize BigInt; normalize numeric fields to strings for the
    // wire. The server re-validates all of them anyway (policy before signing).
    const wireReq = {};
    for (const [k, v] of Object.entries(req || {})) {
      wireReq[k] = typeof v === 'bigint' ? v.toString() : v;
    }
    const r = await this._rpc('signer_sign', { req: wireReq });
    if (!r || typeof r.signedBytes !== 'string') throw Object.assign(new Error('malformed sign response'), { code: ERR.MALFORMED_RESPONSE });
    return { ok: true, signedBytes: r.signedBytes, txHash: r.txHash, from: r.from ? r.from.toLowerCase() : null, nonce: Number(r.nonce) };
  }
}

module.exports = {
  ERR,
  ExternalSigner,
  SyntheticReferenceSigner,
  RefSignerClient,
  normAddr,
};
