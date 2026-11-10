// SAAX Protocol — Day 5: End-to-end endpoint verification (required output #1)
//
// Spawns the real route-server on an ephemeral port, then drives it over HTTP:
//   1. POST /route "security scan" with a real PAYMENT-SIGNATURE header
//      (base64, mock-signed) -> 200, SYBIL + Apex Leviathan on x402 with mock
//      receipts, Surf AI on MPP stubbed, Captain Dackie/Agent 2290 excluded.
//   2. POST /route with NO header -> 402 x402 v2 challenge.
//   3. POST /route legacy x-x402-mock: mock -> 200 (Day 4 compat).
//   4. POST /route with a MUTATED payment payload (non-base64) -> 402 rejected.
//   5. POST /route "!!!" -> 422 security gate (sanitization still in force).
// Exits non-zero on any failed assertion.
const { spawn } = require('child_process');
const http = require('http');
const x402 = require('./x402.js');

const PORT = 8399;
let failures = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
};

function request(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: PORT, method, path: pathname, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await request('GET', '/health', {}, null);
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

(async () => {
  const child = spawn(process.execPath, ['endpoint/route-server.js'], {
    env: { ...process.env, SAAX_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  try {
    await waitForServer();

    // Build a valid PAYMENT-SIGNATURE header (base64 x402 V2 payload, mock-signed)
    const req = {
      scheme: 'exact',
      amount: x402.rawUnits(0.05),
      asset: x402.USDC_ADDRESS.base,
      networkName: 'base',
      network: x402.NETWORK_CAIP2.base,
      payTo: (process.env.SAAX_X402_PAYTO || '0x0000000000000000000000000000000000000001').toLowerCase(),
      maxTimeoutSeconds: 60,
    };
    const payload = x402.signMockPayload(req);
    const sigHeader = Buffer.from(JSON.stringify(payload)).toString('base64');

    // ---- 1. security scan with valid payment signature
    console.log('\n== E2E 1: POST /route security scan + PAYMENT-SIGNATURE ==');
    const r1 = await request('POST', '/route',
      { 'Content-Type': 'application/json', 'payment-signature': sigHeader },
      JSON.stringify({ capability: 'security scan', budget: 500, deadline: '2026-10-08' }));
    const j1 = JSON.parse(r1.body);
    console.log('  HTTP ' + r1.status);
    if (r1.status !== 200) { console.log('  BODY: ' + r1.body); }
    check('HTTP 200', r1.status === 200, String(r1.status));
    check('status ok', j1.status === 'ok', j1.status);
    check('payment.verified via mock branch', j1.payment && j1.payment.verified === true && j1.payment.mode === 'mock',
      JSON.stringify(j1.payment));
    if (!j1.matches) { check('response has matches array', false, 'no matches in body'); }
    const sybil = j1.matches.find(m => m.agent_id === 84667);
    const apex = j1.matches.find(m => m.agent_id === 85380);
    const surf = j1.matches.find(m => m.agent_id === 51085);
    const excluded = j1.excluded.map(e => e.agent_id);
    check('SYBIL on x402 + settled receipt', sybil && sybil.selectedRail === 'x402' && sybil.settlement && sybil.settlement.status === 'settled',
      sybil && sybil.selectedRail + '/' + (sybil.settlement && sybil.settlement.status));
    check('SYBIL receipt txHash mock_<uuid>', sybil && sybil.settlement && /^mock_[0-9a-f-]{36}$/.test(sybil.settlement.txHash),
      sybil && sybil.settlement && sybil.settlement.txHash);
    check('Apex Leviathan on x402 + settled receipt (upto)', apex && apex.selectedRail === 'x402' && apex.settlement && apex.settlement.scheme === 'upto',
      apex && apex.selectedRail + '/' + (apex.settlement && apex.settlement.scheme));
    check('Surf AI on MPP stubbed', surf && surf.selectedRail === 'mpp' && surf.settlement && surf.settlement.status === 'stubbed',
      surf && surf.selectedRail + '/' + (surf.settlement && surf.settlement.status));
    check('Captain Dackie + Agent 2290 excluded (unsupported)', excluded.includes(1380) && excluded.includes(2290), excluded.join(','));
    const dec = j1.decisionLog.filter(d => d.capability === 'security scan');
    check('decision log has 5 entries for security scan (2 x402, 1 mpp, 2 unsupported)',
      dec.length === 5 && dec.filter(d => d.selectedRail === 'x402').length === 2 && dec.filter(d => d.selectedRail === 'mpp').length === 1 && dec.filter(d => d.selectedRail === 'unsupported').length === 2,
      dec.length + ' entries: ' + dec.map(d => d.selectedRail).join(','));

    // ---- 2. no header -> 402 challenge
    console.log('\n== E2E 2: POST /route no payment header -> 402 ==');
    const r2 = await request('POST', '/route', { 'Content-Type': 'application/json' },
      JSON.stringify({ capability: 'security scan', budget: 500 }));
    const j2 = JSON.parse(r2.body);
    check('HTTP 402', r2.status === 402, String(r2.status));
    check('x402 v2 challenge shape', j2.error === '402 Payment Required' && j2.accepts && j2.accepts[0].scheme === 'x402',
      j2.error + ' / ' + (j2.accepts && j2.accepts[0] && j2.accepts[0].scheme));

    // ---- 3. legacy x-x402-mock header still works (Day 4 compat)
    console.log('\n== E2E 3: legacy x-x402-mock: mock header -> 200 ==');
    const r3 = await request('POST', '/route', { 'Content-Type': 'application/json', 'x-x402-mock': 'mock' },
      JSON.stringify({ capability: 'security scan', budget: 500 }));
    const j3 = JSON.parse(r3.body);
    check('HTTP 200', r3.status === 200, String(r3.status));
    check('same routing (SYBIL x402, Surf mpp, others excluded)',
      j3.matches.find(m => m.agent_id === 84667).selectedRail === 'x402' &&
      j3.matches.find(m => m.agent_id === 51085).selectedRail === 'mpp' &&
      j3.excluded.some(e => e.agent_id === 1380), 'ok');

    // ---- 4. malformed payment header -> 402 rejected
    console.log('\n== E2E 4: malformed PAYMENT-SIGNATURE -> 402 with rejectReason ==');
    const r4 = await request('POST', '/route', { 'Content-Type': 'application/json', 'payment-signature': '!!!not-base64!!!' },
      JSON.stringify({ capability: 'security scan' }));
    const j4 = JSON.parse(r4.body);
    check('HTTP 402', r4.status === 402, String(r4.status));
    check('rejectReason surfaced', !!j4.rejectReason, j4.rejectReason);

    // ---- 5. security gate: 422 on empty-after-sanitization
    console.log('\n== E2E 5: security gate still in force -> 422 ==');
    const r5 = await request('POST', '/route', { 'Content-Type': 'application/json', 'x-x402-mock': 'mock' },
      JSON.stringify({ capability: '!!!', budget: 1 }));
    check('HTTP 422', r5.status === 422, String(r5.status));
    check('sanitization error message', /capability field empty after sanitization/.test(r5.body), r5.body.slice(0, 60));

  } finally {
    child.kill();
  }

  console.log('\n' + (failures === 0 ? 'ALL E2E TESTS PASSED' : failures + ' E2E TEST(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('E2E CRASHED: ' + e); process.exit(2); });