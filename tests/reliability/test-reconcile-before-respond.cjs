// SAAX Reliability Remediation — F-4 reconcile-before-respond HTTP harness
//
// Runs the REAL route-server against a LOCAL PostgREST-compatible stub so the
// whole payment path (idempotency acquire RPC + commitment upsert RPC + lookup
// RPC) is exercised over real HTTP — with full control to inject persistence
// failures and response loss.
//
// Proves (accepted remediation requirements):
//   F4-1  Lost response after successful persistence: an identical retry
//         (same idempotency key) resolves to the SAME commitment ID and ONE
//         durable row — never a duplicate.
//   F4-2  Persistence failure BEFORE acknowledgment: the server responds 503
//         (retryable), never 200, and never presents a payment challenge for
//         an unrecorded commitment.
//   F4-3  Concurrent identical requests -> exactly ONE commitment row.
//   F4-4  A changed request under the same key -> 422 (protocol violation),
//         still no duplicate.
//   F4-5  Deterministic commitment ID underlies the reconcile (stub DB asserts
//         single row across restart).
//
// The stub is a minimal PostgREST emulation: it implements the three RPCs the
// stack calls (acquire_idempotency, upsert_commitment, lookup_commitment_by_id)
// plus the table-style idempotency update used by markSettled. It keeps a
// durable in-memory map keyed by idempotency key and by commitment ID (with
// PK-uniqueness semantics: upsert on conflict). No network, no real money.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
process.chdir(ROOT);
const x402 = require(path.join(ROOT, 'endpoint', 'x402.js'));

let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? '[PASS]' : '[FAIL]') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
  if (ok) passes++; else failures++;
};

// ---- PostgREST stub ----------------------------------------------------------
// State: idempotency rows (key -> {status,payload_hash,response_status,response_body})
//        commitment rows (commitment_id -> row), with PK-atomic upsert.
function makeStub(opts = {}) {
  const idemRows = new Map();
  const commitRows = new Map();
  let failUpsert = false;   // when true, upsert_commitment returns 503
  const server = http.createServer((req, res) => {
    // CORS/JSON for PostgREST-style calls
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = req.url || '';
      if (url.endsWith('/rpc/acquire_idempotency')) {
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch (_) {}
        const key = p.p_key;
        const hash = p.p_payload_hash;
        const ttl = p.p_ttl_hours;
        const existing = idemRows.get(key);
        if (!existing) {
          idemRows.set(key, { key, status: 'pending', payload_hash: hash, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + (ttl || 24) * 3600000).toISOString() });
          return send(200, { conflict: false, status: 'pending' });
        }
        if (existing.payload_hash && hash && existing.payload_hash !== hash) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'payload hash mismatch: idempotency key reused for a different request' }));
        }
        if (existing.status === 'pending') return send(200, { conflict: true, status: 'pending' });
        return send(200, { conflict: true, status: existing.status, response_status: existing.response_status, response_body: existing.response_body });
      }
      if (url.endsWith('/rpc/upsert_commitment')) {
        if (failUpsert) return send(500, { message: 'stub: simulated store failure' });
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch (_) {}
        // PK-atomic upsert: same commitment_id -> overwrite (single row).
        commitRows.set(p.p_commitment_id, p);
        return send(200, p);
      }
      if (url.endsWith('/rpc/lookup_commitment_by_id')) {
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch (_) {}
        const row = commitRows.get(p.p_commitment_id);
        return send(200, row ? [row] : []);
      }
      // table endpoint for idempotency update: PATCH /idempotency_keys?key=eq.X
      if (url.startsWith('/idempotency_keys')) {
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch (_) {}
        const m = /key=eq\.([^&]+)/.exec(url);
        if (m && req.method === 'PATCH') {
          const key = decodeURIComponent(m[1]);
          const row = idemRows.get(key) || {};
          idemRows.set(key, { ...row, ...p });
          return send(200, { ...row, ...p });
        }
        if (m) {
          const key = decodeURIComponent(m[1]);
          return send(200, idemRows.get(key) ? [idemRows.get(key)] : []);
        }
        return send(200, Array.from(idemRows.values()));
      }
      // receipt lookup RPC (lookup_receipt_by_txhash) not needed for this harness
      return send(404, { message: 'no such rpc ' + url });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, idemRows, commitRows, get failUpsert() { return failUpsert; }, setFailUpsert(v) { failUpsert = v; } });
    });
  });
}

function request(port, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    try {
      const r = await request(port, 'GET', '/health', {}, null);
      if (r.status === 200) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

function killChild(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
    setTimeout(resolve, 500);
  });
}

function paymentHeader({ amount, nonce }) {
  const req = {
    scheme: 'exact', amount: String(amount || 50000),
    asset: x402.USDC_ADDRESS['base'], networkName: 'base', network: x402.NETWORK_CAIP2['base'],
    payTo: '0x0000000000000000000000000000000000000001', maxTimeoutSeconds: 60,
  };
  const payload = x402.signMockPayload(req);
  payload.payload.authorization.nonce = nonce || payload.payload.authorization.nonce;
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

const BODY = JSON.stringify({ capability: 'security scan', budget: 500, deadline: '2026-11-07' });

async function spawnServer(port, stubPort, dir, idemDir) {
  const child = spawn(process.execPath, ['endpoint/route-server.js'], {
    env: {
      ...process.env,
      SAAX_PORT: String(port),
      // Point the whole store stack at the local PostgREST stub.
      POSTGREST_URL: 'http://127.0.0.1:' + stubPort,
      SAAX_POSTGREST_KEY: 'test-key',
      SUPABASE_URL: 'http://127.0.0.1:' + stubPort,
      SUPABASE_ANON_KEY: 'test-key',
      // Force the durable idempotency dir to an isolated temp (restart-safe).
      SAAX_IDEMPOTENCY_DIR: idemDir,
      // Mock x402 mode (no real chain).
      SAAX_X402_MODE: 'mock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitForServer(port);
  return child;
}

const APP_PORT = 8592;

(async () => {
  const idemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-f4-idem-'));
  const stub = await makeStub();
  console.log('--- F4-1: lost response after successful persistence (identical retry -> SAME commitment) ---');
  {
    let child = await spawnServer(APP_PORT, stub.port, idemDir, idemDir);
    const key = 'f4-lost-response-1';
    const hdr = paymentHeader({ amount: 50000, nonce: '0x' + 'aa'.repeat(32) });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'Payment-Signature': hdr };
    const r1 = await request(APP_PORT, 'POST', '/route', headers, BODY);
    check('F4-1 first request 200', r1.status === 200, 'status=' + r1.status);
    const cid1 = (function () { const m = /0x[0-9a-f]{64}/.exec(r1.body); return m ? m[0] : null; })();
    const rowsAfterFirst = stub.commitRows.size;
    check('F4-1 exactly one commitment row after first', rowsAfterFirst === 1, 'rows=' + rowsAfterFirst);
    await killChild(child);

    // Restart (server process dies, response to the client is "lost"; the row
    // is durable in the stub). Retry with the SAME key.
    child = await spawnServer(APP_PORT, stub.port, idemDir, idemDir);
    const r2 = await request(APP_PORT, 'POST', '/route', headers, BODY);
    check('F4-1 identical retry after restart 200', r2.status === 200, 'status=' + r2.status);
    if (r2.status !== 200) console.log('      retry body: ' + r2.body.slice(0, 200));
    if (r2.status !== 200) {
      console.log('      stub idemRows for key: ' + JSON.stringify(stub.idemRows.get(key)).slice(0, 160));
    }
    const cid2 = (function () { const m = /0x[0-9a-f]{64}/.exec(r2.body); return m ? m[0] : null; })();
    check('F4-1 SAME commitment ID on retry (reconcile, no duplicate)', !!cid1 && cid1 === cid2, (cid1 || '').slice(0, 16));
    check('F4-1 still exactly ONE commitment row', stub.commitRows.size === 1, 'rows=' + stub.commitRows.size);
    await killChild(child);
  }

  console.log('--- F4-2: persistence failure before ack -> 503, never 200, no payment challenge ---');
  {
    stub.commitRows.clear();
    stub.setFailUpsert(true);
    let child = await spawnServer(APP_PORT, stub.port, idemDir, idemDir);
    const key = 'f4-fail-before-ack-2';
    const hdr = paymentHeader({ amount: 50000, nonce: '0x' + 'bb'.repeat(32) });
    const r1 = await request(APP_PORT, 'POST', '/route', {
      'Content-Type': 'application/json', 'Idempotency-Key': key, 'Payment-Signature': hdr,
    }, BODY);
    check('F4-2 persistence failure -> 503', r1.status === 503, 'status=' + r1.status);
    check('F4-2 error body names retryable', /retryable/.test(r1.body), r1.body.slice(0, 90));
    // No payment-required challenge may have been presented.
    check('F4-2 no PAYMENT-REQUIRED header (no challenge for unrecorded commitment)', !r1.headers['payment-required'], '');
    check('F4-2 no commitment row created', stub.commitRows.size === 0, 'rows=' + stub.commitRows.size);
    // Recover: retry after store heals -> succeeds and creates exactly one row.
    stub.setFailUpsert(false);
    const r2 = await request(APP_PORT, 'POST', '/route', {
      'Content-Type': 'application/json', 'Idempotency-Key': key, 'Payment-Signature': hdr,
    }, BODY);
    check('F4-2 retry after recovery succeeds (200)', r2.status === 200, 'status=' + r2.status);
    check('F4-2 exactly one row after recovery', stub.commitRows.size === 1, 'rows=' + stub.commitRows.size);
    const cidFinal = (function () { const m = /0x[0-9a-f]{64}/.exec(r2.body); return m ? m[0] : null; })();
    check('F4-2 deterministic commitment id present', !!cidFinal, cidFinal || '');
    await killChild(child);
  }

  console.log('--- F4-3: concurrent identical requests -> exactly ONE commitment ---');
  {
    stub.commitRows.clear();
    let child = await spawnServer(APP_PORT, stub.port, idemDir, idemDir);
    const key = 'f4-concurrent-3';
    const hdr = paymentHeader({ amount: 50000, nonce: '0x' + 'cc'.repeat(32) });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'Payment-Signature': hdr };
    const results = await Promise.all(Array.from({ length: 6 }, () => request(APP_PORT, 'POST', '/route', headers, BODY)));
    const okCount = results.filter(r => r.status === 200).length;
    const cids = new Set(results.map(r => { const m = /0x[0-9a-f]{64}/.exec(r.body); return m ? m[0] : null; }).filter(Boolean));
    check('F4-3 at least one 200 (others may be in-flight/duplicate)', okCount >= 1, 'ok=' + okCount);
    check('F4-3 exactly ONE commitment row among all workers', stub.commitRows.size === 1, 'rows=' + stub.commitRows.size);
    check('F4-3 exactly ONE distinct commitment id', cids.size === 1, 'distinct=' + cids.size);
    await killChild(child);
  }

  console.log('--- F4-4: changed request under same key -> 422 (no duplicate) ---');
  {
    stub.commitRows.clear();
    let child = await spawnServer(APP_PORT, stub.port, idemDir, idemDir);
    const key = 'f4-changed-4';
    const hdr = paymentHeader({ amount: 50000, nonce: '0x' + 'dd'.repeat(32) });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'Payment-Signature': hdr };
    const r1 = await request(APP_PORT, 'POST', '/route', headers, BODY);
    check('F4-4 first request 200', r1.status === 200, 'status=' + r1.status);
    // Same key, changed payload (budget differs)
    const altered = JSON.stringify({ capability: 'security scan', budget: 999, deadline: '2026-11-07' });
    const hdr2 = paymentHeader({ amount: 50000, nonce: '0x' + 'ee'.repeat(32) });
    const r2 = await request(APP_PORT, 'POST', '/route', {
      'Content-Type': 'application/json', 'Idempotency-Key': key, 'Payment-Signature': hdr2,
    }, altered);
    check('F4-4 changed payload under same key -> 422', r2.status === 422, 'status=' + r2.status);
    check('F4-4 no duplicate commitment row', stub.commitRows.size === 1, 'rows=' + stub.commitRows.size);
    await killChild(child);
  }

  stub.server.close();
  console.log('\n===== F-4 RECONCILE-BEFORE-RESPOND SUMMARY =====');
  console.log('passed=' + passes + ' failed=' + failures);
  process.exit(failures > 0 ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR: ' + (e && e.stack || e));
  process.exit(2);
});