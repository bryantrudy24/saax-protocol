// Phase 6 finding regression: trailing whitespace in SUPABASE_URL must not
// break the custom PostgREST client (reconcile_idempotency, acquire_idempotency,
// sweeps). The fix trims the base URL; previously every URL was malformed and
// fetch threw "Failed to parse URL".
'use strict';
const assert = require('assert');
const { buildSupabaseClient } = require('../../endpoint/store.js');

// 1. A malformed (trailing-space) URL must be normalized.
const c = buildSupabaseClient('https://codboejrwohkjidrrcgl.supabase.co ', 'test-key', 'ax_router');
assert.strictEqual(c.url, 'https://codboejrwohkjidrrcgl.supabase.co', 'base URL must be trimmed');
console.log('PASS: base URL trimmed');

// 2. rpc() must construct a valid URL (no parse error). Use an unreachable host
//    with a valid URL — the request must FAIL with a network error, not a parse error.
// The custom client THROWS on network failure (fetch failed) with a cause.
// A malformed URL instead throws "Failed to parse URL from <url with space>".
function assertNetworkFailure(err, label) {
  assert.ok(err, label + ': expected a thrown error');
  assert.ok(!/Failed to parse URL/.test(String(err.message)), label + ': must not be a URL parse error: ' + err.message);
  assert.ok(err.cause || /ECONNREFUSED|fetch failed/i.test(String(err.message)), label + ': must be a network-level failure (cause): ' + err.message);
  console.log('PASS: ' + label + ' builds a valid URL (network error, not parse error):', err.message.slice(0, 70));
}

(async () => {
  const c2 = buildSupabaseClient(' https://127.0.0.1:59999 ', 'k', 'ax_router');
  let err;
  try { await c2.rpc('reconcile_idempotency', {}); } catch (e) { err = e; }
  assertNetworkFailure(err, 'rpc()');

  // 3. Table reads/deletes also construct valid URLs.
  err = null;
  try { await c2.from('idempotency_keys').select('key').eq('key', 'x').limit(1); } catch (e) { err = e; }
  assertNetworkFailure(err, 'from().select()');

  // 4. Leading whitespace is trimmed too, and a NULL/empty base stays falsy.
  assert.strictEqual(buildSupabaseClient('   ', 'k', 'ax_router').url, '', 'whitespace-only base -> empty');
  console.log('PASS: whitespace-only base is normalized to empty');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
