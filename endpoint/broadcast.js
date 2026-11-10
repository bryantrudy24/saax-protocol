// SAAX Protocol — Day 7: Live Broadcast Activation (wired but INERT — Sprint 1 mock)
//
// PRE-DAY 7 ITEM 2. The dry-run feedback transaction is signed with a mock key.
// On live, the signed transaction must be BROADCAST to Base, pay gas, and land
// in a block. This module is the live broadcast path. It is a config-change swap:
//   SAAX_FEEDBACK_SIGN_MODE=mock  -> dry-run only, NO broadcast (Sprint 1)  [default]
//   SAAX_FEEDBACK_SIGN_MODE=live  -> signed tx is broadcast via broadcastTransaction,
//                                  gas paid from the operator wallet.
//
// The broadcast helper below is DOCUMENTED and unit-testable in isolation:
//   broadcastSignedTx(signedTxHex, { rpcUrl, confirmations, timeoutMs })
//     - parse the raw signed tx -> ethers Transaction
//     - compute gas estimate (gasLimit * gasPrice) for the operator report
//     - send via provider.broadcastTransaction
//     - poll getTransactionReceipt until `confirmations` deep (default 1;
//       operator confirmation threshold on Base is 1 block for finality,
//       checklist documents the recommendation)
// It is NEVER called in mock mode (guard below). No transaction is broadcast
// during Sprint 1 — the call site only exists in the live branch and every
// invocation in mock mode throws BEFORE any network RPC.
//
// See daily-logs/day7-wallet-checklist.md §"Live Broadcast Activation" for the
// exact operator steps, gas estimate, BaseScan URL pattern, confirmation
// threshold, failure recovery and rollback.
const { Transaction } = require('ethers');

const LIVE_RPC_DEFAULT = 'https://base-rpc.publicnode.com';
const CONFIRMATIONS_DEFAULT = 1; // Base: 1 block = final for this use (checklist §Live)
const POLL_MS = 2000;

function getBroadcastMode() {
  return (process.env.SAAX_FEEDBACK_SIGN_MODE || 'mock').toString().trim().toLowerCase();
}

// ---- Gas estimate (fractions of a cent on Base at current gas prices) -----------
// baseFee = gasLimit * gasPrice(wei) ; weiPerEth = 1e18 ; usd = eth * SAAX_ETH_USD
// gasPrice read LIVE from the RPC for the report (eth_gasPrice) so the number is
// current, not stale. Fallback constants are labeled estimates for offline docs.
function estimateGasUsd(gasLimit, gasPriceWei, ethUsd) {
  const gasWei = BigInt(String(gasLimit || 0)) * BigInt(String(gasPriceWei || 0));
  const eth = Number(gasWei) / 1e18;
  return { gasWei: gasWei.toString(), eth, usd: Math.round(eth * Number(ethUsd || 0) * 1e6) / 1e6 };
}

// ---- The live broadcast call. THROWS in mock mode (inert). ----------------------
// Returns { txHash, blockNumber, confirmations, gas } on success.
async function broadcastSignedTx(signedTxHex, opts = {}) {
  const mode = getBroadcastMode();
  if (mode !== 'live') {
    throw new Error('broadcast is INERT in mock mode (SAAX_FEEDBACK_SIGN_MODE=' + mode +
      '). Sprint 1 is dry-run only. Set SAAX_FEEDBACK_SIGN_MODE=live to enable broadcast.');
  }
  const rpc = opts.rpcUrl || process.env.SAAX_RPC_URL || LIVE_RPC_DEFAULT;
  const confirmations = opts.confirmations || CONFIRMATIONS_DEFAULT;
  const timeoutMs = opts.timeoutMs || 120000;

  // 1. Parse the raw signed tx structurally.
  const tx = Transaction.from(hexStringToBytes(signedTxHex));
  if (!tx.from) throw new Error('broadcast: cannot recover sender from signed tx');

  // 2. Gas estimate for the operator report.
  //    Fields: tx.maxFeePerGas (bytes32 hex string) is the EIP-1559 max fee.
  //    tx.gasPrice may be an accessor that errors unless the tx is a legacy
  //    type — normalize defensively. We report the COST AT THE CURRENT GAS
  //    PRICE (live eth_gasPrice when reachable, else the tx's own fee fields)
  //    — the honest number for "what will this cost", not the fee ceiling.
  let gasPriceWei;
  try {
    const prov = new JsonRpcProvider(rpc);
    gasPriceWei = await prov.getFeeData().then(fd => String(fd.maxFeePerGas || fd.gasPrice || '0')).catch(() => null) ||
      (await prov.send('eth_gasPrice', []).catch(() => null));
  } catch (_) { gasPriceWei = null; }
  const maxFee = tx.maxFeePerGas ? String(tx.maxFeePerGas) : '0';
  let txGasPrice;
  try { txGasPrice = tx.gasPrice ? String(tx.gasPrice) : '0'; } catch (_) { txGasPrice = '0'; }
  const txFee = (maxFee === '0x0' || maxFee === '0') ? txGasPrice : maxFee;
  if (!gasPriceWei || gasPriceWei === '0' || gasPriceWei === '0x0') gasPriceWei = txFee;
  const ethUsd = Number(process.env.SAAX_ETH_USD || 2703.68); // current estimate, operator may override
  const gas = estimateGasUsd(Number(tx.gasLimit), gasPriceWei, ethUsd);

  // 3. Send. ethers v6: provider.broadcastTransaction(signedTx).
  const { JsonRpcProvider } = require('ethers');
  const provider = new JsonRpcProvider(rpc);
  const txHash = await provider.broadcastTransaction(signedTxHex);

  // 4. Wait for `confirmations` blocks (poll receipt).
  const start = Date.now();
  let blockNumber = null;
  while (Date.now() - start < timeoutMs) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && receipt.blockNumber) {
      const current = await provider.getBlockNumber();
      const depth = Math.max(0, current - Number(receipt.blockNumber) + 1);
      if (depth >= confirmations) {
        blockNumber = Number(receipt.blockNumber);
        return { txHash, blockNumber, confirmations: depth, gas };
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error('broadcast: tx ' + txHash + ' in mempool but did not reach ' +
    confirmations + ' confirmations within ' + timeoutMs + 'ms');
}

function hexStringToBytes(hex) {
  const s = String(hex || '').replace(/^0x/, '');
  if (s.length % 2 !== 0) throw new Error('broadcast: malformed signed tx hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

module.exports = {
  getBroadcastMode,
  estimateGasUsd,
  broadcastSignedTx,
  CONFIRMATIONS_DEFAULT,
  LIVE_RPC_DEFAULT,
};