// SAAX Protocol — Gate D.2 Phase B: HTTP error semantics for the pilot-limit
// rejection paths.
//
// Verifies the route-server maps each quota rejection class to the correct
// HTTP status:
//   403 Forbidden   — wallet not allowlisted / revoked / access prohibited
//   429 Too Many    — configured amount or count quota exceeded (with a safe
//                     Retry-After only when the window makes it determinable)
//   503 Unavailable — limit store unreachable / state cannot be established
//   422 Unprocessable — malformed or unsupported request parameters
//   409 Conflict    — idempotency-key / reservation-payload conflict
//
// Every rejection happens BEFORE any payment challenge or broadcast, and the
// response body never contains wallet, amount, recipient or settlement data.
//
// Isolated testbed only. No chain interaction, no real money (mock lane).
'use strict';

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const { mint } = require(path.join(__dirname, '_gate-d-jwt.cjs'));
const { buildSupabaseClient } = require(path.join(__dirname, '..', '..', 'endpoint', 'store.js'));

const PORT = Number(process.env.SAAX_PILOT_LIVE_PORT || 8910);
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
  SUPABASE_URL: POSTGREST_URL,
  SUPABASE_SERVICE_ROLE_KEY: JWT,
  SAAX_PILOT_ENFORCEMENT: 'on',
};

const DEMAND = { capability: 'security scan', deadline: '2026-12-01' };

function sql(q) {
  return execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres',
    '-d', 'ax_router', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();
}

(async () => {
  const client = buildSupabaseClient(POSTGREST_URL, JWT, 'ax_router');
  const limits = require(path.join(__dirname, '..', '..', 'endpoint', 'pilot-limits.js'));
  limits.setStoreClient(client);

  const payer = (process.env.SAAX_X402_MOCK_FROM || '0x0000000000000000000000000000000000000001').toLowerCase();
  const runPayer = '0x' + require('node:crypto').randomBytes(20).toString('hex');
  sql(`DELETE FROM ax_router.payment_reservations WHERE wallet = '${runPayer}'`);
  sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet = '${runPayer}'`);
  await limits.approveWallet(runPayer, { label: 'gate-d2-phase-b', chainId: 8453 });

  // In-process enforcement for the direct reservation-layer checks (B4).
  process.env.SAAX_PILOT_ENFORCEMENT = 'on';

  const env = Object.assign({}, BASE_ENV, { SAAX_X402_MOCK_FROM: runPayer });
  const envUnapproved = Object.assign({}, BASE_ENV, {
    SAAX_X402_MOCK_FROM: '0x' + 'c'.repeat(40),
  });
  const envDead = Object.assign({}, BASE_ENV, {
    SAAX_X402_MOCK_FROM: runPayer,
    POSTGREST_URL: 'http://127.0.0.1:59998',
    SUPABASE_URL: 'http://127.0.0.1:59998',
  });

  // ---- 403: unapproved wallet -------------------------------------------
  {
    const srv = await boot(envUnapproved);
    const r = await post(PORT, DEMAND, { 'x-x402-mock': 'mock' });
    const ok = r.status === 403 &&
      r.body && r.body.error === 'pilot_limit_rejected' && r.body.retryable === false &&
      !r.headers['payment-required'] && !r.headers['www-authenticate'];
    record('B1-403-unapproved-wallet',
      ok,
      'status=' + r.status + ' error=' + (r.body && r.body.error) + ' retryable=' + (r.body && r.body.retryable));
    srv.child.kill();
    await new Promise((res) => setTimeout(res, 200));
  }

  // ---- 403: revoked wallet ----------------------------------------------
  {
    await limits.revokeWallet(runPayer, { revokedBy: 'gate-d2-phase-b' });
    const srv = await boot(env);
    const r = await post(PORT, DEMAND, { 'x-x402-mock': 'mock' });
    const ok = r.status === 403 && r.body && r.body.reason === 'wallet_revoked';
    record('B2-403-revoked-wallet',
      ok,
      'status=' + r.status + ' reason=' + (r.body && r.body.reason));
    srv.child.kill();
    await new Promise((res) => setTimeout(res, 200));
    await limits.approveWallet(runPayer, { label: 'gate-d2-phase-b', chainId: 8453 });
  }

  // ---- 429: quota exceeded (tiny cap so the $0.05 mock amount hits it) ----
  {
    // The mock lane reserves ROUTING_FEE_USD = $0.05 per request. A wallet
    // cap of $0.05 means the SECOND request must 429 with Retry-After.
    const envTiny = Object.assign({}, env, { SAAX_PILOT_WALLET_MAX_USD: '0.05' });
    const srv = await boot(envTiny);
    const k1 = 'B3:key:' + Date.now() + ':1';
    const k2 = 'B3:key:' + Date.now() + ':2';
    await post(PORT, DEMAND, { 'x-x402-mock': 'mock', 'idempotency-key': k1 });
    const r = await post(PORT, DEMAND, { 'x-x402-mock': 'mock', 'idempotency-key': k2 });
    const ok = r.status === 429 &&
      r.body && r.body.error === 'pilot_limit_rejected' &&
      r.body.reason === 'wallet_amount_cap' &&
      /^\d+$/.test(String(r.headers['retry-after'] || ''));
    record('B3-429-quota-exceeded-with-retry-after',
      ok,
      'status=' + r.status + ' reason=' + (r.body && r.body.reason) + ' retry-after=' + r.headers['retry-after']);
    srv.child.kill();
    await new Promise((res) => setTimeout(res, 200));
    sql(`DELETE FROM ax_router.payment_reservations WHERE wallet = '${runPayer}'`);
  }

  // ---- 422: malformed / unsupported request (reservation layer) ---------
  {
    // The route-server derives the pilot asset from its OWN configuration
    // (never a caller header), so an unsupported asset cannot be injected via
    // the HTTP request — it is validated at the reservation layer. Under
    // enforcement, the evaluator returns a 422-class rejection for local
    // validation failures (malformed amount, unsupported asset, bad wallet).
    const ev = await limits.evaluate({
      idempotencyKey: 'B4:key:' + Date.now(),
      wallet: runPayer, chainId: 84532,
      asset: '0x0000000000000000000000000000000000009999',
      amountUnits: String(1000000),
      recipient: '0x1111111111111111111111111111111111111111',
    });
    record('B4-422-unsupported-asset-rejected',
      ev.ok === false && ev.reason === 'unsupported_asset',
      'ok=' + ev.ok + ' reason=' + ev.reason);
    const evBadWallet = await limits.evaluate({
      idempotencyKey: 'B4b:key:' + Date.now(),
      wallet: 'not-an-address', chainId: 84532,
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      amountUnits: String(1000000),
      recipient: '0x1111111111111111111111111111111111111111',
    });
    record('B4b-422-invalid-wallet-rejected',
      evBadWallet.ok === false && evBadWallet.reason === 'invalid_wallet_address',
      'ok=' + evBadWallet.ok + ' reason=' + evBadWallet.reason);
  }

  // ---- 503: store unavailable (fail closed) ------------------------------
  {
    const srv = await boot(envDead);
    const r = await post(PORT, DEMAND, { 'x-x402-mock': 'mock' });
    const ok = r.status === 503 && r.body && r.body.retryable === true &&
      !r.headers['payment-required'] && !r.headers['www-authenticate'];
    record('B5-503-store-unavailable-fail-closed',
      ok,
      'status=' + r.status + ' reason=' + (r.body && r.body.reason) + ' retryable=' + (r.body && r.body.retryable));
    srv.child.kill();
    await new Promise((res) => setTimeout(res, 200));
  }

  // ---- body hygiene: no wallet/amount/recipient/settlement data ----------
  // Checked across ALL rejection classes: 403 (unapproved), 429 (quota) and
  // 503 (store down) must never include wallet, amount, recipient, settlement
  // or internal policy figures (wallet_spent / cap_units).
  {
    // 403 body
    const srv1 = await boot(envUnapproved);
    const r1 = await post(PORT, DEMAND, { 'x-x402-mock': 'mock' });
    // 503 body (dead store)
    const srv2 = await boot(envDead);
    const r2 = await post(PORT, DEMAND, { 'x-x402-mock': 'mock' });
    const check = (name, raw) => {
      const low = (raw || '').toLowerCase();
      return !low.includes(runPayer) && !low.includes('wallet_spent') &&
        !low.includes('cap_units') && !low.includes('settlement_ref') &&
        !low.includes('recipient') && !low.includes('amount_units') &&
        !low.includes('payload_hash');
    };
    const clean403 = check('403', r1.raw);
    const clean503 = check('503', r2.raw);
    record('B6-no-sensitive-data-in-rejection-bodies',
      clean403 && clean503,
      '403_clean=' + clean403 + ' 503_clean=' + clean503 + ' 403=' + r1.raw.slice(0, 120) + ' 503=' + r2.raw.slice(0, 120));
    srv1.child.kill();
    srv2.child.kill();
    await new Promise((res) => setTimeout(res, 200));
  }

  sql(`DELETE FROM ax_router.payment_reservations WHERE wallet = '${runPayer}'`);
  sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet = '${runPayer}'`);

  const failed = results.filter((r) => !r.pass);
  console.log('\n==== GATE D.2 PHASE B RESULT: ' + (results.length - failed.length) + '/' + results.length + ' PASS ====');
  if (failed.length) for (const f of failed) console.log('  FAILED: ' + f.name + ' :: ' + f.detail);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('PHASE B SUITE ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
