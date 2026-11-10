// SAAX Protocol — live: reproduce the T2 502 (permit consumed but settle reports
// failure). Signs a valid permit with the CURRENT chain nonce, sends it through
// the live route-server, and prints the full response body reason.
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http: vh, createPublicClient } = require('viem');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const gateway = require('../endpoint/gateway.js');

const PORT = 8731;

function req(port, p, method, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: 'localhost', port, path: p, method, headers: headers || {} }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 80; i++) {
    try { const r = await req(port, '/health', 'GET'); if (r.status === 200) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server not up');
}

(async () => {
  const child = spawn(process.execPath, [path.join('endpoint', 'route-server.js')], {
    cwd: process.cwd(),
    env: { ...process.env, SAAX_PORT: String(PORT), SAAX_X402_MODE: 'self', SAAX_GATEWAY_DRY_RUN: '0', SAAX_RATE_LIMIT_STORE: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  try {
    await waitHealth(PORT);
    const buyer = privateKeyToAccount(process.env.SAAX_TEST_BUYER_KEY);
    const seller = gateway.getSellerAddress();
    // Read the CURRENT chain nonce (must match exactly for EIP-2612).
    const pub = createPublicClient({ chain: gateway.baseSepolia, transport: vh() });
    const abi = [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
    const chainNonce = Number(await pub.readContract({ address: gateway.USDC_BASE_SEPOLIA, abi, functionName: 'nonces', args: [buyer.address] }));
    console.log('chain permit nonce:', chainNonce);
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
    const payload = Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'urn:saax-protocol:route:v1' },
      accepted: { scheme: 'exact', network: gateway.NETWORK_CAIP2_BASE_SEPOLIA, amount: String(msg.value), asset: gateway.USDC_BASE_SEPOLIA, payTo: seller, maxTimeoutSeconds: 60 },
      payload: { signature: sig, authorization: { from: msg.owner, to: msg.spender, value: String(msg.value), validAfter: String(now - 60), validBefore: String(msg.deadline), nonce: String(chainNonce) } },
    })).toString('base64');
    const body = JSON.stringify({ capability: 'security scan', budget: 500, deadline: '2026-10-08' });
    const t = await req(PORT, '/route', 'POST', { 'Content-Type': 'application/json', 'payment-signature': payload }, body);
    console.log('HTTP ' + t.status);
    const j = JSON.parse(t.body);
    if (j.reason) console.log('REASON: ' + j.reason);
    const pr = t.headers && t.headers['payment-response'];
    if (pr) console.log('PAYMENT-RESPONSE: ' + Buffer.from(pr, 'base64').toString('utf8'));
  } finally {
    setTimeout(() => child.kill(), 500);
  }
})().catch(e => { console.error('CRASH', e.stack || e); process.exit(2); });