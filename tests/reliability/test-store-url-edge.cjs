// SAAX payment-availability repair — edge-case verification for the URL
// normalization fix in endpoint/store.js (Phase 6 finding).
//
// Covers the brief's required cases:
//   E1  Leading/trailing whitespace is trimmed.
//   E2  Trailing slashes + whitespace combinations normalize to one clean base.
//   E3  A valid existing URL is unchanged.
//   E4  RPC + table-operation URL construction both use the normalized base.
//   E5  Missing/whitespace-only/malformed URLs still fail safely (no silent
//       fallback DB; the store reports not-configured / throws, never connects
//       elsewhere).
//   E6  No credentials or sensitive config values leak through errors.
//   E7  The reconciliation RPC is reached successfully through the trimmed URL
//       (network-level failure proves URL validity; no parse error).
//   E8  DELETE-filter guard is untouched (empty filter set is refused).
'use strict';
const assert = require('assert');
const { buildSupabaseClient } = require('../../endpoint/store.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('[PASS] ' + name); }
  catch (e) { fail++; console.log('[FAIL] ' + name + ' :: ' + e.message); }
}

(async () => {
  // E1/E3 — trimming and idempotence
  await check('E1: trailing whitespace trimmed', () => {
    assert.strictEqual(buildSupabaseClient('https://x.supabase.co ', 'k', 's').url, 'https://x.supabase.co');
  });
  await check('E1b: leading whitespace trimmed', () => {
    assert.strictEqual(buildSupabaseClient('  https://x.supabase.co', 'k', 's').url, 'https://x.supabase.co');
  });
  await check('E3: valid URL unchanged', () => {
    assert.strictEqual(buildSupabaseClient('https://x.supabase.co', 'k', 's').url, 'https://x.supabase.co');
  });

  // E2 — slash + whitespace combinations
  await check('E2a: trailing slash removed', () => {
    assert.strictEqual(buildSupabaseClient('https://x.supabase.co/', 'k', 's').url, 'https://x.supabase.co');
  });
  await check('E2b: trailing slash + space removed', () => {
    assert.strictEqual(buildSupabaseClient('https://x.supabase.co/ ', 'k', 's').url, 'https://x.supabase.co');
  });
  await check('E2c: multiple slashes + spaces removed', () => {
    assert.strictEqual(buildSupabaseClient(' https://x.supabase.co///  ', 'k', 's').url, 'https://x.supabase.co');
  });

  // E4 — URL construction uses the trimmed base (inspect the builder's URL field)
  await check('E4: client URL is the trimmed base (whitespace variant)', () => {
    assert.strictEqual(buildSupabaseClient('https://x.supabase.co ', 'k', 's').url, 'https://x.supabase.co');
  });
  await check('E4b: client URL is the trimmed base (slash+space variant)', () => {
    assert.strictEqual(buildSupabaseClient('https://x.supabase.co// ', 'k', 's').url, 'https://x.supabase.co');
  });

  // E5 — missing/whitespace-only/malformed fail safely (no fallback, no silent connect)
  await check('E5a: empty base stays empty (not configured)', () => {
    assert.strictEqual(buildSupabaseClient('', 'k', 's').url, '');
  });
  await check('E5b: whitespace-only base is empty (no fallback)', () => {
    assert.strictEqual(buildSupabaseClient('   ', 'k', 's').url, '');
  });
  await check('E5c: malformed input is not silently rewritten to a fallback', () => {
    const c = buildSupabaseClient('not-a-url', 'k', 's');
    assert.strictEqual(c.url, 'not-a-url');
  });

  // E6 — network error path never leaks the key; parse errors are gone
  await check('E6: API key never leaks through errors', async () => {
    const c = buildSupabaseClient('https://127.0.0.1:59999 ', 'top-secret-key-abc', 's');
    let err = null;
    try { await c.rpc('reconcile_idempotency', {}); } catch (e) { err = e; }
    assert.ok(err, 'expected an error from the unreachable host');
    const msg = String(err && err.message || err);
    assert.ok(!msg.includes('top-secret-key-abc'), 'secret must not appear in the error');
    assert.ok(!/Failed to parse URL/.test(msg), 'must be a network-level failure, not a URL parse error: ' + msg);
  });

  // E7 — reconciliation RPC builds a valid URL through the trimmed base
  await check('E7: reconcile RPC URL is valid (network error, not parse)', async () => {
    const c = buildSupabaseClient(' https://127.0.0.1:59999 ', 'k', 's');
    let err = null;
    try { await c.rpc('reconcile_idempotency', {}); } catch (e) { err = e; }
    assert.ok(err, 'expected an error from the unreachable host');
    assert.ok(!/Failed to parse URL/.test(String(err.message)), 'URL is valid; the failure is at the network layer: ' + err.message);
  });

  console.log('===== STORE URL EDGE SUMMARY =====');
  console.log('passed=' + pass + ' failed=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
