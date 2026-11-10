// Isolated check of verifyAuthorization on a tampered (attacker-signed) permit.
// Should return verified:false — the attacker's signature must NOT recover to
// the buyer's address.
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const gateway = require('../endpoint/gateway.js');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { createWalletClient, http: vh } = require('viem');

(async () => {
  const seller = gateway.getSellerAddress();
  const buyer = privateKeyToAccount(process.env.SAAX_TEST_BUYER_KEY);
  const attacker = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const value = gateway.rawUnits(0.05);
  const domain = gateway.domainFor();
  const w = createWalletClient({ account: attacker, chain: gateway.baseSepolia, transport: vh() });
  const msg = {
    owner: attacker.address.toLowerCase(),
    spender: seller.toLowerCase(),
    value: BigInt(value),
    nonce: BigInt(999999),
    deadline: BigInt(now + 3600),
  };
  const sig = await w.signTypedData({ domain, types: gateway.EIP3009_TYPES, primaryType: 'Permit', message: msg });
  const payload = {
    x402Version: 2,
    accepted: { scheme: 'exact', network: gateway.NETWORK_CAIP2_BASE_SEPOLIA, amount: String(value), asset: gateway.USDC_BASE_SEPOLIA, payTo: seller },
    payload: { signature: sig, authorization: { from: buyer.address.toLowerCase(), to: seller.toLowerCase(), value: String(value), validAfter: String(now - 60), validBefore: String(now + 3600), nonce: '999999' } },
  };
  const v = await gateway.verifyAuthorization(payload, { payTo: seller, amount: String(value), network: gateway.NETWORK_CAIP2_BASE_SEPOLIA, asset: gateway.USDC_BASE_SEPOLIA });
  console.log('T4-STYLE VERIFY RESULT:', JSON.stringify(v));
  console.log(v.verified === false ? 'EXPECTED: REJECTED (PASS)' : 'UNEXPECTED: ACCEPTED (FAIL)');
  process.exit(0);
})().catch(e => { console.error('CRASH', e.stack || e); process.exit(2); });