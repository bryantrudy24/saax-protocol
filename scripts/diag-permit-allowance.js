// SAAX Protocol — live: re-run the exact T2 two-step settle with the CURRENT chain
// nonce, logging the permit tx, reading allowance immediately after permit
// confirmation, then transferFrom. Captures the real failure point.
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const gateway = require('../endpoint/gateway.js');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http: vh, createPublicClient, decodeAbiParameters, parseAbiParameters } = require('viem');

(async () => {
  const buyer = privateKeyToAccount(process.env.SAAX_TEST_BUYER_KEY);
  const seller = gateway.getSellerAddress();
  const pub = createPublicClient({ chain: gateway.baseSepolia, transport: vh() });
  const abi = [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  const chainNonce = Number(await pub.readContract({ address: gateway.USDC_BASE_SEPOLIA, abi, functionName: 'nonces', args: [buyer.address] }));
  const allowAbi = [{ name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  console.log('chain nonce:', chainNonce);
  const allowanceBefore = await pub.readContract({ address: gateway.USDC_BASE_SEPOLIA, abi: allowAbi, functionName: 'allowance', args: [buyer.address, seller] });
  console.log('allowance before:', allowanceBefore.toString());

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
  const auth = { from: msg.owner, to: msg.spender, value: String(msg.value), validAfter: String(now - 60), validBefore: String(msg.deadline), nonce: String(chainNonce) };

  // Validate the FULL hardened settle path (permit -> allowance poll -> transferFrom).
  console.log('calling settleAuthorization (permit + allowance poll + transferFrom)...');
  try {
    const r = await gateway.settleAuthorization(auth, sig);
    console.log('SETTLE OK:', JSON.stringify(r));
  } catch (e) {
    console.log('SETTLE ERROR:', String(e.message || e).slice(0, 300));
  }
  process.exit(0);
})().catch(e => { console.error('CRASH', (e && e.stack) || e); process.exit(2); });