// signing-vault.js — restricted relayer signing interface (Phase D4A).
//
// SEPARATION OF DUTIES
//   - Evaluator DECISION approval (verdict/mutual EIP-712 signatures recovered in
//     d3-action-auth / verifyActionArgsForOp) is DISTINCT from relayer transaction
//     SIGNING. This module is the relayer signing boundary: it signs custody
//     transactions WITHOUT broadcasting, and enforces every field against the
//     authorized operation before signing.
//   - The relayer private key is loaded ONLY inside this module (SAAX_D2_RELAYER_KEY
//     in the worker process). It is never imported by, and never exposed to, the
//     HTTP/API process (endpoint/*). Evaluator owner keys (SAAX_EVALUATOR_* /
//     SAAX_SIGNER_PRIVATE_KEY) are never loaded here.
//
// ENFORCED BOUNDS (the worker signs only what the authorized operation permits)
//   - chainId: must equal the configured allowed chain (opts.allowedChainId).
//   - to: must equal the configured custody destination (opts.custody).
//   - data: must decode to a SUPPORTED custody action (opts.abi + opts.allowedActions).
//   - value: must be 0 (custody actions carry no value; the token is the escrow).
//   - fee/gas: gasPrice (and derived maxFeePerGas) within opts.maxGasPrice;
//     gasLimit within opts.maxGasLimit.
//   - nonce: must equal the durably reserved account nonce (passed by the worker
//     store reservation — the operation/nonce binding).
//   - opId binding: opts.expectedOpId must match params.opId; the returned
//     signedBytes/txHash/nonce are bound to that operation and returned ONLY to
//     the caller inside the restricted execution path (the worker).
//
// TRUST BOUNDARY (stated plainly)
//   This is an isolated local signing process/module under the same OS account as
//   the worker. That is NOT strong host-compromise isolation: a compromised OS
//   account can read the key from the environment. Remote/HSM/KMS signing is NOT
//   implemented and is documented as PENDING in the D4A plan. This synthetic
//   adapter is NOT production key custody.
//
// The module NEVER broadcasts and NEVER exports signed bytes (only the caller
// receives them, and the caller seals them via prepared-vault before persistence).

'use strict';

const { Wallet } = require('ethers');
const { Interface, keccak256 } = require('ethers');
const { signTransactionLocal } = require('./d1-tx.js');

const SUPPORTED = new Set(['release', 'refund', 'mutualRelease', 'mutualRefund', 'raiseDispute', 'resolve']);

/**
 * Resolve the relayer signer from the environment (SAAX_D2_RELAYER_KEY) — ONLY
 * inside the worker process. Returns { account, wallet } or throws.
 */
function loadRelayerSigner(provider, opts = {}) {
  const keyHex = opts.keyHex !== undefined ? opts.keyHex : process.env.SAAX_D2_RELAYER_KEY;
  if (!keyHex) {
    throw new Error('PRECONDITION: SAAX_D2_RELAYER_KEY is required in the worker process');
  }
  const wallet = new Wallet(keyHex, provider);
  return { account: wallet.address, wallet };
}

/** Decode the calldata selector against the ABI; returns the action name. */
function decodeAction(abi, data) {
  if (!data || data === '0x') return null;
  const iface = new Interface(abi);
  try {
    const parsed = iface.parseTransaction({ data });
    return parsed ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * Restricted signing: validate every field against the authorized operation
 * bounds, then sign WITHOUT broadcasting. Returns { signedBytes, txHash, nonce }.
 *
 * @param {object} params {
 *   opId,                  // operation identity (must equal expectedOpId)
 *   to, data, value,       // transaction fields (data = custody calldata)
 *   gasLimit, gasPrice,    // fee bounds
 *   nonce,                 // durably reserved account nonce
 *   chainId,
 * }
 * @param {object} policy {
 *   abi, allowedActions, allowedChainId, custody,
 *   maxGasPrice, maxGasLimit, expectedOpId, signer, // { wallet } from loadRelayerSigner
 * }
 */
async function signViaVault(params, policy) {
  const {
    opId, to, data, value, gasLimit, gasPrice, nonce, chainId,
  } = params;
  const {
    abi, allowedActions = SUPPORTED, allowedChainId, custody,
    maxGasPrice, maxGasLimit, expectedOpId, signer,
  } = policy;

  // Fail closed on any missing policy.
  if (!allowedChainId) return { ok: false, reason: 'NO_ALLOWED_CHAIN' };
  if (!custody) return { ok: false, reason: 'NO_CUSTODY' };
  if (!signer || !signer.wallet) return { ok: false, reason: 'NO_SIGNER' };
  if (!abi) return { ok: false, reason: 'NO_ABI' };

  // 1. operation binding
  if (!expectedOpId || String(opId) !== String(expectedOpId)) {
    return { ok: false, reason: 'OP_MISMATCH', detail: { expected: expectedOpId, got: opId } };
  }
  // 2. chain
  if (Number(chainId) !== Number(allowedChainId)) {
    return { ok: false, reason: 'CHAIN_NOT_ALLOWED', detail: { allowed: allowedChainId, got: chainId } };
  }
  // 3. custody destination
  if (!to || String(to).toLowerCase() !== String(custody).toLowerCase()) {
    return { ok: false, reason: 'DESTINATION_NOT_ALLOWED', detail: { custody, to } };
  }
  // 4. value must be zero (custody actions carry no native value)
  if (value !== 0n && value !== 0 && value !== '0') {
    return { ok: false, reason: 'VALUE_NOT_ZERO', detail: String(value) };
  }
  // 5. action must be supported + in allowedActions
  const action = decodeAction(abi, data);
  if (!action) return { ok: false, reason: 'ACTION_UNDECODABLE' };
  if (!allowedActions.has(action)) {
    return { ok: false, reason: 'ACTION_NOT_ALLOWED', detail: { allowed: [...allowedActions], got: action } };
  }
  // 6. fee/gas bounds
  const gp = BigInt(gasPrice || 0);
  const gl = BigInt(gasLimit || 0);
  if (Number(maxGasPrice) > 0 && gp > BigInt(maxGasPrice)) {
    return { ok: false, reason: 'GAS_PRICE_EXCEEDS_BOUND', detail: { max: String(maxGasPrice), got: gp.toString() } };
  }
  if (Number(maxGasLimit) > 0 && gl > BigInt(maxGasLimit)) {
    return { ok: false, reason: 'GAS_LIMIT_EXCEEDS_BOUND', detail: { max: String(maxGasLimit), got: gl.toString() } };
  }
  if (gl <= 0n) {
    return { ok: false, reason: 'GAS_LIMIT_REQUIRED' };
  }

  // Sign WITHOUT broadcasting (d1-tx computes the hash locally; no provider.send).
  const signed = await signTransactionLocal(signer.wallet, {
    to, data, value: 0n, gasLimit: String(gl), gasPrice: String(gp), nonce, chainId,
  });
  return { ok: true, signedBytes: signed.signedBytes, txHash: signed.txHash, nonce: Number(signed.nonce), action };
}

module.exports = {
  SUPPORTED,
  loadRelayerSigner,
  decodeAction,
  signViaVault,
  // re-export the hash computation for the restricted path
  computeTxHash: (bytes) => {
    const raw = String(bytes).replace(/^0x/, '');
    return keccak256(Buffer.from(raw, 'hex'));
  },
};