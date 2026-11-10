'use strict';
// Restricted custody lane: only fully specified legacy or EIP-1559 calls.
const { Transaction } = require('ethers');
const FIELDS = new Set(['to','from','data','value','chainId','nonce','type','gasLimit','gasPrice','maxFeePerGas','maxPriorityFeePerGas']);
function normalizeIntent(req) {
  for (const k of Object.keys(req)) if (!FIELDS.has(k)) throw new Error('UNSUPPORTED_TX_FIELD:' + k);
  const type = Number(req.type);
  if (![0,2].includes(type)) throw new Error('UNSUPPORTED_TX_TYPE');
  if (!/^0x[0-9a-f]{40}$/i.test(req.to) || !/^0x[0-9a-f]{40}$/i.test(req.from)) throw new Error('INVALID_TX_IDENTITY');
  if (!/^0x([0-9a-f]{2})*$/i.test(req.data)) throw new Error('INVALID_CALLDATA');
  if (!Number.isSafeInteger(Number(req.nonce)) || Number(req.nonce) < 0 || req.nonce == null) throw new Error('INVALID_NONCE');
  const positive = k => { if (req[k] == null || BigInt(req[k]) <= 0n) throw new Error('MISSING_POSITIVE:' + k); return BigInt(req[k]); };
  const out = {to:req.to.toLowerCase(),from:req.from.toLowerCase(),data:req.data.toLowerCase(),value:BigInt(req.value),chainId:positive('chainId'),nonce:Number(req.nonce),type,gasLimit:positive('gasLimit')};
  if (type === 0) { if (req.maxFeePerGas != null || req.maxPriorityFeePerGas != null) throw new Error('MIXED_FEES'); out.gasPrice=positive('gasPrice'); }
  else { if (req.gasPrice != null) throw new Error('MIXED_FEES'); out.maxFeePerGas=positive('maxFeePerGas'); out.maxPriorityFeePerGas=positive('maxPriorityFeePerGas'); if(out.maxPriorityFeePerGas>out.maxFeePerGas) throw new Error('PRIORITY_EXCEEDS_MAX'); }
  return Object.freeze(out);
}
function validateBytes(bytes, intent) {
  try {
    const tx=Transaction.from(bytes);
    if (!tx.signature || !tx.hash || !tx.from) throw new Error('UNSIGNED');
    if ((tx.accessList||[]).length || (tx.authorizationList||[]).length || tx.blobVersionedHashes?.length || tx.blobs?.length || tx.maxFeePerBlobGas != null) throw new Error('UNSUPPORTED_TX_FEATURE');
    for(const [k,v] of Object.entries(intent || {})) {
      if (!FIELDS.has(k)) throw new Error('UNSUPPORTED_TX_FIELD:' + k);
      if (v == null) continue; // absent field: caller did not constrain it
      const got=tx[k];
      // Numeric intents (chainId, nonce, value, fees, gasLimit) compare
      // numerically; addresses/data/selectors compare case-insensitively.
      const numLike = typeof v === 'bigint' || typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v));
      const norm = numLike ? BigInt(got) : typeof v === 'string' ? String(got).toLowerCase() : got;
      const want = numLike ? BigInt(v) : typeof v === 'string' ? v.toLowerCase() : v;
      if (norm !== want) return {ok:false,reason:k==='from'?'EXTERNAL_SIGNER_WRONG_KEY':'TX_INTENT_MISMATCH:'+k,detail:{expected:v,got:String(got)}};
    }
    return {ok:true,txHash:tx.hash.toLowerCase(),from:tx.from.toLowerCase()};
  } catch(e) { return {ok:false,reason:'EXTERNAL_SIGNER_MALFORMED_RESPONSE',detail:e.message}; }
}
module.exports={normalizeIntent,validateBytes};
