// SAAX Protocol — Gate D.1: live HTTP integration of the pilot-limit gate.
//
// Starts the REAL route server against the ISOLATED testbed and proves the gate
// is wired into the payment path, not merely unit-tested:
//   * enforcement OFF  -> the payment path behaves exactly as before
//   * enforcement ON   -> an unapproved wallet is refused with 403 and NO
//                         payment challenge is presented
//   * enforcement ON   -> an approved wallet is admitted to the payment path
//
// No chain interaction, no real money: the mock lane is used throughout.
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { mint } = require(path.join(__dirname, '_gate-d-jwt.cjs'));
const { buildSupabaseClient } = require(path.join(__dirname, '..', '..', 'endpoint', 'store.js'));

const PORT = Number(process.env.SAAX_PILOT_LIVE_PORT || 8907);
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const JWT = process.env.SAAX_POSTGREST_KEY || mint('service_role');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail);
}

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/route', method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }, headers || {}),
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function health(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

async function boot(env) {
  const child = spawn(process.execPath, ['endpoint/route-server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('boot timeout: ' + log.slice(-400))), 20000);
    const poll = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, () => { clearTimeout(t); resolve(); })
        .on('error', () => setTimeout(poll, 250));
    };
    poll();
  });
  return { child, log: () => log };
}

const BASE_ENV = {
  PORT: String(PORT),
  SAAX_X402_MODE: 'mock',
  SAAX_X402_VERIFY_MODE: 'mock',
  SAAX_IDEMPOTENCY_STORE: 'memory',
  SAAX_RATE_LIMIT_STORE: 'memory',
  POSTGREST_URL,
  SAAX_POSTGREST_KEY: JWT,
  SAAX_KILL_SWITCH: '0',
  // The commitment store reads its own env family (D-2 finding: two parallel
  // variable families). Point it at the same isolated testbed so the request
  // reaches the payment path where the pilot gate lives.
  SUPABASE_URL: POSTGREST_URL,
  SUPABASE_SERVICE_ROLE_KEY: JWT,
};

const DEMAND = { capability: 'security scan', deadline: '2026-12-01' };

(async () => {
  const client = buildSupabaseClient(POSTGREST_URL, JWT, 'ax_router');
  const limits = require(path.join(__dirname, '..', '..', 'endpoint', 'pilot-limits.js'));
  limits.setStoreClient(client);

  // The mock lane's payer identity is SAAX_X402_MOCK_FROM; approve exactly that
  // address so test C exercises the ADMITTED path rather than a different one.
  const approved = (process.env.SAAX_X402_MOCK_FROM || '0x0000000000000000000000000000000000000001').toLowerCase();
  const unapproved = '0x' + 'c'.repeat(40);

  // Clean + seed the allowlist for this test only.
  const { execFileSync } = require('child_process');
  const sql = (q) => execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres',
    '-d', 'ax_router', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();
  sql(`DELETE FROM ax_router.payment_reservations WHERE wallet IN ('${approved}','${unapproved}')`);
  sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet IN ('${approved}','${unapproved}')`);
  await limits.approveWallet(approved, { label: 'gate-d1-live', chainId: 8453 });

  // ---- A. Enforcement OFF: unchanged behavior ----------------------------
  {
    const srv = await boot(Object.assign({}, BASE_ENV, { SAAX_PILOT_ENFORCEMENT: 'off' }));
    try {
      const r = await post(PORT, DEMAND, { 'x-x402-mock': 'mock', 'x-buyer-address': unapproved });
      record('A-enforcement-off-unaffected',
        r.status !== 403,
        'status=' + r.status + ' (no pilot rejection when enforcement is off)');
    } finally { srv.child.kill(); }
  }

  // ---- B. Enforcement ON: unapproved wallet refused ----------------------
  // The mock lane's payer IS SAAX_X402_MOCK_FROM, so the unapproved case boots
  // the server with that identity set to an address absent from the allowlist.
  {
    const srv = await boot(Object.assign({}, BASE_ENV, {
      SAAX_PILOT_ENFORCEMENT: 'on',
      SAAX_X402_MOCK_FROM: unapproved,
    }));
    try {
      const r = await post(PORT, DEMAND, { 'x-x402-mock': 'mock' });
      const isPilotReject = r.status === 403 && r.body && r.body.error === 'pilot_limit_rejected';
      record('B-unapproved-wallet-403',
        isPilotReject,
        'status=' + r.status + ' error=' + (r.body && r.body.error) + ' reason=' + (r.body && r.body.reason));
      record('B-no-payment-challenge-presented',
        !r.headers['payment-required'] && !r.headers['www-authenticate'],
        'payment-required=' + (r.headers['payment-required'] ? 'PRESENT' : 'absent') +
        ' www-authenticate=' + (r.headers['www-authenticate'] ? 'PRESENT' : 'absent'));
    } finally { srv.child.kill(); }
  }

  // ---- C. Enforcement ON: approved wallet admitted -----------------------
  {
    const srv = await boot(Object.assign({}, BASE_ENV, { SAAX_PILOT_ENFORCEMENT: 'on' }));
    try {
      // The mock lane's payer identity is SAAX_X402_MOCK_FROM (the lane's own
      // identity), so the approved wallet must be that address.
      const r = await post(PORT, DEMAND, { 'x-x402-mock': 'mock' });
      record('C-approved-wallet-admitted',
        r.status !== 403,
        'status=' + r.status + ' reason=' + (r.body && r.body.reason) + ' (not a pilot rejection)');
    } finally { srv.child.kill(); }
  }

  // ---- Teardown ----------------------------------------------------------
  sql(`DELETE FROM ax_router.payment_reservations WHERE wallet IN ('${approved}','${unapproved}')`);
  sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet IN ('${approved}','${unapproved}')`);

  const failed = results.filter((r) => !r.pass);
  console.log('\n==== GATE D.1 LIVE RESULT: ' + (results.length - failed.length) + '/' + results.length + ' PASS ====');
  if (failed.length) for (const f of failed) console.log('  FAILED: ' + f.name + ' :: ' + f.detail);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('LIVE SUITE ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
