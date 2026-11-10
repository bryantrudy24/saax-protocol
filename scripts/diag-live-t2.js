// SAAX Protocol — Day 9 live: diagnostic for T2 502 with the FUNDED stable buyer.
// Spawns route-server in self + live mode, captures stderr to a file, signs an
// EIP-3009 authorization with SAAX_TEST_BUYER_KEY (funded), sends it, and prints
// the full response body + the server's log tail so the real on-chain revert
// reason is visible.
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http: vh } = require('viem');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const gateway = require('../endpoint/gateway.js');

const PORT = 8721;
const LOG = path.join(__dirname, '..', 'daily-logs', 'day9-diag-stderr.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });

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
  let errLog = '';
  child.stderr.on('data', c => { errLog += c.toString(); });
  child.stdout.on('data', () => {});
  try {
    await waitHealth(PORT);
    const buyerPk = process.env.SAAX_TEST_BUYER_KEY;
    console.log('buyer key loaded: ' + !!buyerPk);
    const buyer = privateKeyToAccount(buyerPk);
    const seller = gateway.getSellerAddress();
    console.log('buyer ' + buyer.address + '  seller ' + seller);
    const now = Math.floor(Date.now() / 1000);
    // FiatTokenV2 Permit: owner=buyer, spender=seller, value, nonce (uint256
    // counter; buyer's on-chain nonce is 0), deadline=validBefore.
    const permitNonce = 0;
    const msg = {
      owner: buyer.address.toLowerCase(),
      spender: seller.toLowerCase(),
      value: BigInt(gateway.rawUnits(0.05)),
      nonce: BigInt(permitNonce),
      deadline: BigInt(now + 3600),
    };
    const domain = gateway.domainFor();
    const w = createWalletClient({ account: buyer, chain: gateway.baseSepolia, transport: vh() });
    const sig = await w.signTypedData({ domain, types: gateway.EIP3009_TYPES, primaryType: 'Permit', message: msg });
    const payload = Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'urn:saax-protocol:route:v1' },
      accepted: { scheme: 'exact', network: gateway.NETWORK_CAIP2_BASE_SEPOLIA, amount: String(msg.value), asset: gateway.USDC_BASE_SEPOLIA, payTo: seller, maxTimeoutSeconds: 60 },
      payload: { signature: sig, authorization: { from: msg.owner, to: msg.spender, value: String(msg.value), validAfter: String(now - 60), validBefore: String(msg.deadline), nonce: String(permitNonce) } },
    })).toString('base64');
    const body = JSON.stringify({ capability: 'security scan', budget: 500, deadline: '2026-10-08' });
    const t = await req(PORT, '/route', 'POST', { 'Content-Type': 'application/json', 'payment-signature': payload }, body);
    console.log('HTTP ' + t.status);
    console.log('BODY: ' + t.body);
    const pr = t.headers && t.headers['payment-response'];
    if (pr) console.log('PAYMENT-RESPONSE: ' + Buffer.from(pr, 'base64').toString('utf8'));
  } finally {
    setTimeout(() => { child.kill(); }, 300);
  }
  // Tail the server log (settlement errors land there)
  setTimeout(() => {
    try {
      const tail = errLog.trim().split('\n').slice(-30).join('\n');
      console.log('\n--- SERVER STDERR TAIL ---\n' + (tail || '(empty)'));
      fs.appendFileSync(LOG, errLog || '(empty stderr)\n');
    } catch (e) { console.log('log read fail ' + e.message); }
  }, 1200);
})().catch(e => { console.error('DIAG CRASHED: ' + (e && e.stack || e)); process.exit(2); });