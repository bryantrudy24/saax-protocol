// Focused test: participant bearer-token gate (hosting access design, Item 4).
// With SAAX_PILOT_TOKEN set: no token -> 401; wrong token -> 401; correct token
// -> proceeds to the escrow-access path (200/402 depending on auth, but NOT
// 401-token); the token never appears in server logs. Without the env set, the
// gate is disabled (existing behavior preserved).
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '.env' });

const PORT = Number(process.env.SAAX_BIND_GATE_PORT || 8896);
const TOKEN = 'pilot-test-token-7f3a9c';
const escrows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'binding-test-escrows.json'), 'utf8'));
const CID = escrows.valid.CID;
const LEDGER = path.join(__dirname, '..', 'data', 'test-gate-ledger.json');
try { fs.unlinkSync(LEDGER); } catch (e) {}

function post(port, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ capability: 'security scan', deadline: '2026-10-08' });
    const req = http.request({ host: '127.0.0.1', port, path: '/route', method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function health() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
  });
}

(async () => {
  const results = [];
  const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail); };
  let child = null;
  let serverLog = '';
  try {
    child = spawn(process.execPath, ['endpoint/route-server.js'], {
      env: Object.assign({}, process.env, {
        SAAX_ESCROW_BACKED: '1', SAAX_X402_MODE: 'self', SAAX_X402_VERIFY_MODE: 'live',
        SAAX_RPC_URL: 'https://sepolia.base.org', SAAX_CHAIN_ID: '84532', SAAX_CUSTODY_ADDRESS: '0x5a5472d751839cd4968cbf1b136baf862279ff5d',
        SAAX_ESCROW_LEDGER: LEDGER, PORT: String(PORT), SAAX_IDEMPOTENCY_STORE: 'memory',
        SAAX_TEST_BUYER_ADDRESS: '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13',
        SAAX_PILOT_TOKEN: TOKEN,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { serverLog += d; process.stdout.write('[srv] ' + d); });
    child.stderr.on('data', d => { serverLog += d; process.stderr.write('[srv-err] ' + d); });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('boot timeout')), 15000);
      const poll = () => { http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, r => { clearTimeout(t); resolve(); }).on('error', () => setTimeout(poll, 250)); };
      poll();
    });

    // 1. No token -> 401 (gate blocks)
    const r1 = await post(PORT, { 'Content-Type': 'application/json' });
    record('gate-no-token-401', r1.status === 401 && String((r1.body && r1.body.error) || '').includes('pilot access token'), 'no token -> ' + r1.status + ' ' + JSON.stringify(r1.body || {}).slice(0, 80));

    // 2. Wrong token -> 401
    const r2 = await post(PORT, { 'Authorization': 'Bearer wrong-token' });
    record('gate-wrong-token-401', r2.status === 401, 'wrong token -> ' + r2.status + ' ' + JSON.stringify(r2.body || {}).slice(0, 80));

    // 3. Correct token -> NOT a token 401; proceeds (missing access auth -> 402 or
    //    escrow-auth flow; any status OTHER THAN the token-401 proves the gate passed)
    const r3 = await post(PORT, { 'Authorization': 'Bearer ' + TOKEN });
    record('gate-correct-token-passes', r3.status !== 401, 'correct token -> ' + r3.status + ' ' + JSON.stringify(r3.body || {}).slice(0, 100));

    // 4. Token never logged
    record('gate-token-not-logged', !serverLog.includes(TOKEN), 'server log does not contain the token value');

    // 5. Health still responds (gate does not block health)
    const h = await health();
    record('gate-health-ok', h.status === 200, 'health -> ' + h.status);
  } finally {
    if (child) { try { child.kill(); } catch (e) {} }
  }
  const failed = results.filter(r => !r.pass);
  console.log('\n==== GATE RESULT: ' + (results.length - failed.length) + '/' + results.length + ' PASS ====');
  process.exitCode = failed.length ? 1 : 0;
  // Explicit exit: the spawned child's stdio pipes can keep the parent's event
  // loop alive after child.kill() on Windows, which would otherwise hang the
  // run at the shell timeout despite all assertions passing.
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('GATE TEST FAIL', e.message); process.exit(1); });