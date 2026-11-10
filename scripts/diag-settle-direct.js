// SAAX Protocol — live: reproduce the two-step permit+transferFrom settlement at the
// gateway level (no HTTP), with the current chain nonce, to isolate whether
// transferFrom fails after a successful permit broadcast.
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const gateway = require('../endpoint/gateway.js');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http: vh, createPublicClient } = require('viem');

(async () => {
  const buyer = privateKeyToAccount(process.env.SAAX_TEST_BUYER_KEY);
  const seller = gateway.getSellerAddress();
  const pub = createPublicClient({ chain: gateway.baseSepolia, transport: vh() });
  const abi = [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  const chainNonce = Number(await pub.readContract({ address: gateway.USDC_BASE_SEPOLIA, abi, functionName: 'nonces', args: [buyer.address] }));
  console.log('chain nonce:', chainNonce);
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    owner: buyer.address.toLowerCase(),
    spender: seller.toLowerCase(),
    value: BigInt(gateway.rawUnits(0.05)),
    nonce: BigInt(chainNonce),
    deadline: BigInt(now + 3600),
  };
  const w = createWalletClient({ account: buyer, chain: gateway.baseSepolia, transport: vh() });
  const sig = await w.signTypedData({ domain: gateway.domainFor(), types: gateway.EIP3009_TYPES, primaryType: 'Permit', message: msg });

  // Call the gateway's settleAuthorization DIRECTLY (same code path as the
  // server) and see if it throws.
  const auth = {
    from: msg.owner,
    to: msg.spender,
    value: String(msg.value),
    validAfter: String(now - 60),
    validBefore: String(msg.deadline),
    nonce: String(chainNonce),
  };
  try {
    const r = await gateway.settleAuthorization(auth, sig);
    console.log('SETTLE OK:', JSON.stringify(r));
  } catch (e) {
    console.log('SETTLE ERROR:', String(e.message || e).slice(0, 400));
  }
  process.exit(0);
})().catch(e => { console.error('CRASH', e.stack || e); process.exit(2); });