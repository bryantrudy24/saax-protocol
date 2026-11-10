// SAAX Reliability Remediation — store.js DELETE filter regression + safeguards
//
// Locks the usage-audit finding: the custom PostgREST client's
// .delete().in(col, vals) MUST include the filter in the DELETE URL.
// Before the fix, the arrow _exec read `this._filters` where `this` was the
// BUILDER chain (empty), so every delete went out as
//   DELETE /rate_limits            (no filter)  -> PostgREST 400
//     "DELETE requires a WHERE clause" (the observed hourly sweep failures)
// instead of
//   DELETE /rate_limits?id=in.(<ids>)
//
// Extended safeguards (verification-gap closure):
//   E1  Empty ID list never produces an unfiltered DELETE.
//   E2  Delete with NO filter at all fails safely (never fires a bare DELETE).
//   E3  Chained filters (.in + .eq) are preserved in the URL.
//   E4  Special characters in ids are percent-encoded safely.
//   E5  The filter targets exactly the intended expired ids.
//   E6  Database errors (non-2xx) surface as { error }, never swallowed.
'use strict';
const http = require('http');

let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? '[PASS]' : '[FAIL]') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
  if (ok) passes++; else failures++;
};

function makeStub({ failRateLimitsDelete = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: b });
      if (failRateLimitsDelete && /\/rate_limits\?/.test(req.url) && req.method === 'DELETE') {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ code: 'PGRST106', message: 'DELETE requires a WHERE clause' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end('{}');
      }
    });
  });
  return { server, seen };
}

(async () => {
  // ---- First stub: happy path (filtered deletes succeed) ---------------------
  const s1 = makeStub();
  await new Promise(r => s1.server.listen(0, '127.0.0.1', r));
  const port1 = s1.server.address().port;

  process.env.POSTGREST_URL = 'http://127.0.0.1:' + port1;
  process.env.SAAX_POSTGREST_KEY = 'test-key';
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + port1;
  process.env.SUPABASE_ANON_KEY = 'test-key';

  const store = require('../../endpoint/store.js');
  const client = store.buildStoreClient();

  // D1-D4: rate-limit sweep path.
  const r1 = await client.from('rate_limits').delete().in('id', ['aaa', 'bbb']);
  check('D1 delete+in returns no error', !r1.error, r1.error ? r1.error.message : 'ok');
  const del = s1.seen.find(s => s.method === 'DELETE');
  check('D2 DELETE was sent', !!del, del ? del.url : 'none');
  const hasInFilter = del && /id=in\.\(/.test(del.url);
  check('D3 DELETE URL carries the id=in filter (regression lock)', !!hasInFilter, del ? del.url : '');
  check('D4 no unfiltered DELETE to the table root', !s1.seen.some(s => s.method === 'DELETE' && /\/rate_limits(\?|$)/.test(s.url) && !/id=in\./.test(s.url)), '');

  // D5-D6: idempotency sweep path.
  const r2 = await client.from('idempotency_keys').delete().in('key', ['k1', 'k2']);
  check('D5 idempotency delete+in returns no error', !r2.error, r2.error ? r2.error.message : 'ok');
  const del2 = s1.seen.filter(s => s.method === 'DELETE' && /idempotency_keys/.test(s.url)).pop();
  check('D6 idempotency DELETE carries key=in filter', !!del2 && /key=in\.\(/.test(del2.url), del2 ? del2.url : 'none');

  await new Promise(r => s1.server.close(r));

  // ---- Second stub: safety cases + E6 error surfacing ------------------------
  const s2 = makeStub();
  await new Promise(r => s2.server.listen(0, '127.0.0.1', r));
  const port2 = s2.server.address().port;

  process.env.POSTGREST_URL = 'http://127.0.0.1:' + port2;
  delete require.cache[require.resolve('../../endpoint/store.js')];
  const store2 = require('../../endpoint/store.js');
  const client2 = store2.buildStoreClient();

  // E1: empty id list -> URL still carries key=in.(), never a bare DELETE.
  await client2.from('idempotency_keys').delete().in('key', []);
  check('E1 empty id list never produces an unfiltered DELETE',
    !s2.seen.some(s => s.method === 'DELETE' && /\/idempotency_keys(\?|$)/.test(s.url) && !/key=in\./.test(s.url)), '');
  check('E1b empty in() filter is still present in the URL',
    s2.seen.some(s => s.method === 'DELETE' && /key=in\.\(\)/.test(s.url)),
    s2.seen.filter(s => s.method === 'DELETE' && /idempotency_keys/.test(s.url)).map(s => s.url).join(' | '));

  // E2: .delete() with no chained filter must NOT fire a bare DELETE.
  const e2res = await client2.from('idempotency_keys').delete();
  check('E2 delete() with NO filter does not fire an unfiltered DELETE',
    !s2.seen.some(s => s.method === 'DELETE' && /\/idempotency_keys(\?|$)/.test(s.url) && !/key=in\.|id=in\.|=.+\./.test(s.url)), '');
  check('E2b delete() with NO filter returns a refusal error',
    !!e2res.error && /no filter chained/.test(e2res.error.message), e2res.error ? e2res.error.message : 'no error?!');

  // E3: chained .in + .eq both preserved.
  await client2.from('idempotency_keys').delete().in('key', ['k1', 'k2']).eq('environment', 'prod');
  const e3del = s2.seen.filter(s => s.method === 'DELETE' && /idempotency_keys/.test(s.url) && /key=in\.\(/.test(s.url) && /environment=eq\.prod/.test(s.url)).pop();
  check('E3 chained filters (in + eq) both preserved', !!e3del, e3del ? e3del.url : 'none');

  // E4: special characters in ids are percent-encoded, not raw.
  const sneaky = "k'1 OR 1=1--";
  await client2.from('idempotency_keys').delete().in('key', [sneaky]);
  const e4del = s2.seen.filter(s => s.method === 'DELETE' && /idempotency_keys/.test(s.url)).pop();
  const encoded = e4del && (e4del.url.includes("%27") || !e4del.url.includes("'"));
  check('E4 special characters are percent-encoded in the filter', !!encoded, e4del ? e4del.url : 'none');

  // E5: filter targets exactly the intended ids.
  await client2.from('idempotency_keys').delete().in('key', ['expired-1', 'expired-2']);
  const e5del = s2.seen.filter(s => s.method === 'DELETE' && /idempotency_keys/.test(s.url) && /key=in\.\(expired-1%2Cexpired-2\)/.test(s.url)).pop();
  check('E5 filter targets exactly the intended expired ids', !!e5del, e5del ? e5del.url : 'none');

  // E6: DB error surfaces as error (use a third stub that 400s rate_limits).
  const s3 = makeStub({ failRateLimitsDelete: true });
  await new Promise(r => s3.server.listen(0, '127.0.0.1', r));
  process.env.POSTGREST_URL = 'http://127.0.0.1:' + s3.server.address().port;
  delete require.cache[require.resolve('../../endpoint/store.js')];
  const store3 = require('../../endpoint/store.js');
  const client3 = store3.buildStoreClient();
  const e6 = await client3.from('rate_limits').delete().in('id', ['x1']);
  check('E6 DB 400 surfaces as error, not success', !!e6.error, e6.error ? e6.error.message : 'no error?!');

  console.log('\n===== STORE DELETE FILTER SUMMARY =====');
  console.log('passed=' + passes + ' failed=' + failures);
  // Tear down stub servers cleanly to avoid the Windows libuv
  // "handle->flags & UV_HANDLE_CLOSING" assertion on process exit.
  try { s1.server.closeAllConnections?.(); } catch (_) {}
  try { s2.server.closeAllConnections?.(); } catch (_) {}
  try { s3.server.closeAllConnections?.(); } catch (_) {}
  await new Promise(r => setTimeout(r, 50));
  process.exit(failures > 0 ? 1 : 0);
})().catch(e => {
  console.error('TEST ERROR: ' + (e && e.stack || e));
  process.exit(2);
});