// SAAX Final Production Reliability Gate — Phase 1+2 integration harness
// Tests the route-server SELF-mode fail-closed store guard + the DB
// reconciliation wiring end-to-end:
//   1. SELF mode + no durable store + payment header -> 503, no processing.
//   2. SELF mode + challenge probe (no payment header) -> still available.
//   3. Mock mode + memory store + payment header -> processes (dev lane).
//   4. DB reconcile module: wraps the RPC, never auto-replays unknowns.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? '[PASS]' : '[FAIL]') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
  if (ok) passes++; else failures++;
};

const SERVER = path.join(__dirname, '..', '..', 'endpoint', 'route-server.js');
const PORT = 18891;

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, SAAX_PORT: String(PORT), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    const t0 = Date.now();
    const iv = setInterval(() => {
      http.get('http://127.0.0.1:' + PORT + '/route', { method: 'GET' }, () => {})
        .on('error', () => {});
      if (out.includes('route endpoint') || Date.now() - t0 > 8000) {
        clearInterval(iv);
        resolve({ child, out });
      }
    }, 200);
    child.on('exit', code => reject(new Error('server exited ' + code + '\n' + out)));
  });
}

function request(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // ---- Test 1: SELF mode + NO durable store + payment header -> 503 ----
  // SAAX_X402_MODE=self, no SUPABASE_URL, no POSTGREST_URL, and force the
  // in-memory store via SAAX_IDEMPOTENCY_STORE=memory (the only way to be
  // sure no file fallback kicks in).
  let child1;
  try {
    child1 = await startServer({
      SAAX_X402_MODE: 'self',
      SAAX_IDEMPOTENCY_STORE: 'memory',
      SAAX_SIGNER_PRIVATE_KEY: '0x' + '11'.repeat(32),
      SAAX_SIGNER_ADDRESS: '0x0000000000000000000000000000000000000001',
      SAAX_PAYTO_ADDRESS: '0x0000000000000000000000000000000000000002',
    });
    const pay = await request('POST', '/route', {
      'Content-Type': 'application/json',
      'payment-signature': '{"payload":{"authorization":{"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","value":"1000000","validAfter":"0","validBefore":"9999999999","nonce":"0x0000000000000000000000000000000000000000000000000000000000000001"}}}',
    }, JSON.stringify({ capability: 'test-cap', budget: '1', deadline: '9999999999' }));
    check('SELF + no durable store + payment -> 503 fail-closed', pay.status === 503, 'status=' + pay.status + ' body=' + pay.body.slice(0, 120));
    check('503 body says no payment initiated', /no payment was initiated/.test(pay.body), pay.body.slice(0, 120));
  } finally {
    if (child1) child1.child.kill();
  }

  // ---- Test 2: SELF mode + no durable store + challenge probe -> open ----
  let child2;
  try {
    child2 = await startServer({
      SAAX_X402_MODE: 'self',
      SAAX_IDEMPOTENCY_STORE: 'memory',
      SAAX_SIGNER_PRIVATE_KEY: '0x' + '11'.repeat(32),
      SAAX_SIGNER_ADDRESS: '0x0000000000000000000000000000000000000001',
      SAAX_PAYTO_ADDRESS: '0x0000000000000000000000000000000000000002',
    });
    const probe = await request('POST', '/route', { 'Content-Type': 'application/json' },
      JSON.stringify({ capability: 'test-cap', budget: '1', deadline: '9999999999' }));
    check('SELF + no durable store + challenge probe -> not 503 (idempotency-neutral)', probe.status !== 503, 'status=' + probe.status);
  } finally {
    if (child2) child2.child.kill();
  }

  // ---- Test 3: mock mode + memory store + payment header -> processes ----
  let child3;
  try {
    child3 = await startServer({
      SAAX_X402_MODE: 'mock',
      SAAX_IDEMPOTENCY_STORE: 'memory',
    });
    const pay = await request('POST', '/route', {
      'Content-Type': 'application/json',
      'x-x402-mock': 'mock',
      'x-mock-buyer': '0x0000000000000000000000000000000000000001',
    }, JSON.stringify({ capability: 'test-cap', budget: '1', deadline: '9999999999' }));
    check('mock + memory + payment -> not 503 (dev lane open)', pay.status !== 503, 'status=' + pay.status);
  } finally {
    if (child3) child3.child.kill();
  }

  // ---- Test 4: reconcile module policy (unit) ----
  try {
    const rec = require('../../endpoint/idempotency-reconcile.js');
    // no client -> skipped, nothing resolved
    const r1 = await rec.reconcile({});
    check('reconcile no client -> skipped, error set', r1.error === 'no store client' && r1.reconciled === 0, JSON.stringify(r1).slice(0, 80));
    // client that fails (outage) -> error, nothing resolved
    const r2 = await rec.reconcile({ client: { rpc: async () => { throw new Error('boom'); } } });
    check('reconcile outage -> error, nothing resolved', !!r2.error && r2.reconciled === 0 && r2.unresolved === 0, JSON.stringify(r2).slice(0, 80));
    // client that resolves rows -> counts surfaced
    const r3 = await rec.reconcile({ client: { rpc: async () => ({ data: { reconciled: 2, unresolved: 1, notes: ['a', 'b'] }, error: null }) } });
    check('reconcile success -> counts surfaced', r3.reconciled === 2 && r3.unresolved === 1 && r3.notes.length === 2, JSON.stringify(r3).slice(0, 80));
  } catch (e) {
    check('reconcile module unit', false, e.message);
  }

  console.log('\n=== ' + passes + ' passed, ' + failures + ' failed ===');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });