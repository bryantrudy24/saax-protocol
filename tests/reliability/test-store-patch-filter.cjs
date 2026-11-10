// SAAX Reliability Remediation — store.js PATCH filter regression test
//
// Locks the fault-injection finding: the custom PostgREST client's
// .update(patch).eq(col,val) MUST include the filter in the PATCH URL.
// Before the fix, .eq() filters were silently dropped and
//   PATCH /idempotency_keys            (no filter)
// was sent instead of
//   PATCH /idempotency_keys?key=eq.<key>
//
// Consequence if it regresses: markSettled/markVerified/markFailed update
// EVERY row (or are ignored), breaking per-key idempotency state — a
// duplicate-payment hazard after restart.
'use strict';
const http = require('http');

let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? '[PASS]' : '[FAIL]') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
  if (ok) passes++; else failures++;
};

(async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: b });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Point store.js at the stub via env BEFORE requiring it.
  process.env.POSTGREST_URL = 'http://127.0.0.1:' + port;
  process.env.SAAX_POSTGREST_KEY = 'test-key';
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + port;
  process.env.SUPABASE_ANON_KEY = 'test-key';

  const store = require('../../endpoint/store.js');
  const client = store.buildStoreClient();
  const r = await client.from('idempotency_keys').update({ status: 'settled', response_status: 200 }).eq('key', 'key-123');
  check('P1 update+eq returns no error', !r.error, r.error ? r.error.message : 'ok');
  const patch = seen.find(s => s.method === 'PATCH');
  check('P2 PATCH was sent', !!patch, patch ? patch.url : 'none');
  const hasFilter = patch && /key=eq\.key-123/.test(patch.url);
  check('P3 PATCH URL carries the key=eq filter (regression lock)', !!hasFilter, patch ? patch.url : '');
  check('P4 no unfiltered PATCH to the table root', !seen.some(s => s.method === 'PATCH' && /\/idempotency_keys(\?|$)/.test(s.url) && !/key=eq\./.test(s.url)), '');

  server.close();
  console.log('\n===== STORE PATCH FILTER REGRESSION SUMMARY =====');
  console.log('passed=' + passes + ' failed=' + failures);
  process.exit(failures > 0 ? 1 : 0);
})().catch(e => {
  console.error('TEST ERROR: ' + (e && e.stack || e));
  process.exit(2);
});