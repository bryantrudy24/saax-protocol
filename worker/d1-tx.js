// D1 transaction construction for the execution worker.
// Constructs the exact destination, calldata, value, fees and gas parameters,
// signs through an interface that does NOT broadcast, computes the transaction
// hash locally, and returns { signedBytes, txHash, nonce }.
//
// SECURITY: this module contains NO sendTransaction / broadcast / provider.send.
// The signed bytes are executable material and are NEVER exported or logged by
// the worker (only the hash + nonce leave the preparation boundary).

'use strict';

const { keccak256 } = require('ethers');

/** Compute the locally-computed tx hash from raw signed serialized tx bytes. */
function computeTxHash(signedSerializedBytes) {
  // ethers returns the signed serialized tx as 0x-prefixed hex; the tx hash is
  // keccak256 of the raw bytes.
  const raw = signedSerializedBytes.startsWith('0x') ? signedSerializedBytes.slice(2) : signedSerializedBytes;
  return keccak256(Buffer.from(raw, 'hex'));
}

/**
 * Sign a transaction without broadcasting.
 * @param {ethers.Wallet} wallet
 * @param {object} params { to, data, value, gasLimit, gasPrice, nonce, chainId }
 * @returns {{ signedBytes: string, txHash: string, nonce: number }}
 */
async function signTransactionLocal(wallet, { to, data, value, gasLimit, gasPrice, nonce, chainId }) {
  const fee = BigInt(gasPrice || '1000000000');
  const tx = {
    to,
    data: data || '0x',
    value: value || 0n,
    gasLimit,
    nonce,
    chainId,
    type: 2, // EIP-1559 (Base is 1559-native)
    maxFeePerGas: fee,
    maxPriorityFeePerGas: fee / 2n, // deterministic tip
  };
  // Do NOT pass an RPC provider: signTransaction never sends. ethers populates only
  // fields present in the object; we supply every field so no network lookup occurs.
  const signedBytes = await wallet.signTransaction(tx);
  const txHash = computeTxHash(signedBytes);
  return { signedBytes, txHash, nonce };
}

/**
 * Build calldata for a custody action. Supports the V2 restricted-profile
 * actions (release, refund, mutualRelease, mutualRefund, raiseDispute,
 * resolve) AND the F3B V3 head-bound actions (release/refundVerdict/resolve/
 * mutualRelease/mutualRefund with a preSettlementHead, plus the headless
 * refundTimeout). The ABI is loaded from the committed artifact; the action
 * dispatch is VERSION-AWARE — the caller passes custodyVersion (1|2|3) which
 * selects the exact ABI signature. V2 behavior is byte-preserved when
 * custodyVersion is unset/2.
 */
function buildCustodyCalldata(abi, action, args, custodyVersion) {
  const iface = require('ethers').Interface.from(abi);
  const v = Number(custodyVersion || 2);
  switch (action) {
    case 'release':
      if (v === 3) {
        // V3: release(bytes32,bytes32,bytes32 preSettlementHead,uint256 nonce,
        //     uint256 issuedAt,uint8 v,bytes32 r,bytes32 s,bytes sigBytes)
        return iface.encodeFunctionData('release', [
          args.commitmentId, args.commitmentDigest,
          args.preSettlementHead || '0x' + '00'.repeat(32),
          args.nonce, args.issuedAt,
          args.v, args.r, args.s, args.sigBytes,
        ]);
      }
      return iface.encodeFunctionData('release', [
        args.commitmentId, args.commitmentDigest,
        args.nonce, args.issuedAt,
        args.v, args.r, args.s, args.sigBytes,
      ]);
    case 'refund':
      if (v === 3) {
        // V3 refund path is refundVerdict (head-bound evaluator refund) or
        // refundTimeout (headless, 2-arg). A caller that prepared a V3
        // 'refund' with sigBytes / verdict args uses refundVerdict; a caller
        // with the timeout args (no sig) uses refundTimeout.
        const emptyVerdict = !args.sigBytes || args.sigBytes === '0x' || args.sigBytes === '0x0';
        const headless = emptyVerdict && !args.preSettlementHead;
        if (headless) {
          return iface.encodeFunctionData('refundTimeout', [
            args.commitmentId, args.commitmentDigest,
          ]);
        }
        return iface.encodeFunctionData('refundVerdict', [
          args.commitmentId, args.commitmentDigest,
          args.preSettlementHead || '0x' + '00'.repeat(32),
          args.nonce, args.issuedAt,
          args.v, args.r, args.s, args.sigBytes,
        ]);
      }
      return iface.encodeFunctionData('refund', [
        args.commitmentId, args.commitmentDigest,
        args.nonce, args.issuedAt,
        args.v, args.r, args.s, args.sigBytes,
      ]);
    case 'mutualRelease':
    case 'mutualRefund':
      if (v === 3) {
        return iface.encodeFunctionData((action === 'mutualRelease' ? 'mutualRelease' : 'mutualRefund'), [
          args.commitmentId, args.commitmentDigest,
          args.preSettlementHead || '0x' + '00'.repeat(32),
          args.nonce, args.issuedAt,
          args.bv, args.br, args.bs,
          args.sv, args.sr, args.ss,
        ]);
      }
      return iface.encodeFunctionData((action === 'mutualRelease' ? 'mutualRelease' : 'mutualRefund'), [
        args.commitmentId, args.commitmentDigest,
        args.nonce, args.issuedAt,
        args.bv, args.br, args.bs,
        args.sv, args.sr, args.ss,
      ]);
    case 'raiseDispute':
      return iface.encodeFunctionData('raiseDispute', [
        args.commitmentId, args.commitmentDigest, args.reason,
      ]);
    case 'resolve':
      if (v === 3) {
        return iface.encodeFunctionData('resolve', [
          args.commitmentId, args.commitmentDigest, args.resolution,
          args.preSettlementHead || '0x' + '00'.repeat(32),
          args.nonce, args.issuedAt,
          args.v, args.r, args.s, args.sigBytes,
        ]);
      }
      return iface.encodeFunctionData('resolve', [
        args.commitmentId, args.commitmentDigest, args.resolution,
        args.nonce, args.issuedAt,
        args.v, args.r, args.s, args.sigBytes,
      ]);
    case 'refundTimeout':
      // Explicit headless timeout path (V3 only; V2 has no timeout function).
      return iface.encodeFunctionData('refundTimeout', [
        args.commitmentId, args.commitmentDigest,
      ]);
    default:
      throw new Error('unsupported_action:' + action);
  }
}

module.exports = { computeTxHash, signTransactionLocal, buildCustodyCalldata };