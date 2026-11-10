// SAAX Reliability Investigation — Phase 2: Durable idempotency store unit tests
//
// Verifies the file-backed durable store's atomicity, restart-reload,
// reconciliation semantics, and the idempotency.js integration
// (durable fallback path). These tests PASS on the fixed architecture.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DurableIdempotencyStore } = require('../../endpoint/idempotency-durable.js');

let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? '[PASS]' : '[FAIL]') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
  if (ok) passes++; else failures++;
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'saax-idem-'));
}

(async () => {
  // 1. acquire -> update -> reload (restart) -> get returns settled row
  {
    const dir = tmpdir();
    let s = new DurableIdempotencyStore(dir);
    const r1 = s.acquire('key-A', 'ph-1', 24);
    check('1a acquire inserts', r1 === 'inserted', String(r1));
    s.update('key-A', 'settled', 200, JSON.stringify({ ok: true }));
    // Restart (new instance, same dir)
    s = new DurableIdempotencyStore(dir);
    const row = s.get('key-A');
    check('1b row survives restart', row && row.status === 'settled', row && row.status);
    check('1c cached response body survives', row && row.response_body === JSON.stringify({ ok: true }), row && row.response_body);
    // Re-acquire after settle -> conflict with cached response
    const r2 = s.acquire('key-A', 'ph-1', 24);
    check('1d settle -> conflict cached', r2 && r2.conflict && r2.status === 'settled' && r2.response_body, JSON.stringify(r2));
  }

  // 2. payload hash mismatch -> throws (protocol violation)
  {
    const dir = tmpdir();
    const s = new DurableIdempotencyStore(dir);
    s.acquire('key-B', 'ph-orig', 24);
    let threw = false;
    try { s.acquire('key-B', 'ph-diff', 24); } catch (e) { threw = /payload hash mismatch/.test(e.message); }
    check('2 payload-hash mismatch throws', threw, '');
  }

  // 3. pending row + mock reconcile -> failed (nothing broadcast)
  {
    const dir = tmpdir();
    const s = new DurableIdempotencyStore(dir);
    s.acquire('key-C', 'ph-1', 24);
    // Fake the creation time as stale (older than PENDING_STALE_MS)
    const f = path.join(dir, require('crypto').createHash('sha256').update('key-C').digest('hex') + '.json');
    const row = JSON.parse(fs.readFileSync(f, 'utf8'));
    row.created_at = new Date(Date.now() - 120000).toISOString();
    fs.writeFileSync(f, JSON.stringify(row));
    const res = await s.reconcilePending({ mode: 'mock' });
    check('3a mock pending reconciled to failed', s.get('key-C').status === 'failed', s.get('key-C').status);
    check('3b reconciliation counted 1', res.reconciled === 1, String(res.reconciled));
  }

  // 4. pending row + self mode + chain known consumed -> settled (recovered)
  {
    const dir = tmpdir();
    const s = new DurableIdempotencyStore(dir);
    s.acquire('key-D', 'ph-1', 24, { nonce: 'n1' });
    const f = path.join(dir, require('crypto').createHash('sha256').update('key-D').digest('hex') + '.json');
    const row = JSON.parse(fs.readFileSync(f, 'utf8'));
    row.created_at = new Date(Date.now() - 120000).toISOString();
    fs.writeFileSync(f, JSON.stringify(row));
    const res = await s.reconcilePending({ mode: 'self', chainCheck: async () => ({ known: true, consumed: true }) });
    const got = s.get('key-D');
    check('4a consumed -> settled', got.status === 'settled', got.status);
    check('4b recovery marker present', got.meta && got.meta.recovery === 'chain-reconciled-consumed', got.meta && got.meta.recovery);
    check('4c no fabricated receipt body', !got.response_body, String(got.response_body));
  }

  // 5. pending row + self mode + chain known NOT consumed -> failed
  {
    const dir = tmpdir();
    const s = new DurableIdempotencyStore(dir);
    s.acquire('key-E', 'ph-1', 24);
    const f = path.join(dir, require('crypto').createHash('sha256').update('key-E').digest('hex') + '.json');
    const row = JSON.parse(fs.readFileSync(f, 'utf8'));
    row.created_at = new Date(Date.now() - 120000).toISOString();
    fs.writeFileSync(f, JSON.stringify(row));
    await s.reconcilePending({ mode: 'self', chainCheck: async () => ({ known: true, consumed: false }) });
    check('5 not-consumed -> failed', s.get('key-E').status === 'failed', s.get('key-E').status);
  }

  // 6. pending row + self mode + no chain consult (offline) -> UNRESOLVED, blocked
  {
    const dir = tmpdir();
    const s = new DurableIdempotencyStore(dir);
    s.acquire('key-F', 'ph-1', 24);
    const f = path.join(dir, require('crypto').createHash('sha256').update('key-F').digest('hex') + '.json');
    const row = JSON.parse(fs.readFileSync(f, 'utf8'));
    row.created_at = new Date(Date.now() - 120000).toISOString();
    fs.writeFileSync(f, JSON.stringify(row));
    const res = await s.reconcilePending({ mode: 'self' });
    const got = s.get('key-F');
    check('6a offline -> stays pending', got.status === 'pending', got.status);
    check('6b unresolved marker', got.meta && got.meta.recovery === 'unresolved-offline', got.meta && got.meta.recovery);
    check('6c counted as unresolved', res.unresolved === 1, String(res.unresolved));
  }

  // 7. idempotency.js integration: durable fallback path (no Supabase)
  {
    const dir = tmpdir();
    const idem = require('../../endpoint/idempotency.js');
    const dstore = new DurableIdempotencyStore(dir);
    // Reset module state for isolated test
    idem.setStoreClient(null);
    idem.setStoreMode('memory');
    idem.setStoreMode(null);
    idem.setDurableStore(dstore);
    const gate = await idem.idempotencyGate(
      { headers: { 'idempotency-key': 'key-G' } },
      { payload: { capability: 'x', budget: 1, deadline: 'd' }, buyerAddress: '0x1', nonce: 'n' }
    );
    check('7a durable acquire fresh', gate.ok && gate.fresh === true, JSON.stringify(gate).slice(0, 100));
    // Retry same key+payload -> cached replay (NOT fresh)
    const gate2 = await idem.idempotencyGate(
      { headers: { 'idempotency-key': 'key-G' } },
      { payload: { capability: 'x', budget: 1, deadline: 'd' }, buyerAddress: '0x1', nonce: 'n' }
    );
    // NOTE: pending row -> conflict (409) because we never settled it. That is
    // the correct in-flight behavior. Verify conflict status:
    check('7b durable retry while pending -> conflict 409', !gate2.ok && gate2.status === 409, gate2.status + ' ' + (gate2.reason || ''));
    // Settle it, then retry -> cached
    await idem.markSettled('key-G', 200, JSON.stringify({ cached: true }));
    const gate3 = await idem.idempotencyGate(
      { headers: { 'idempotency-key': 'key-G' } },
      { payload: { capability: 'x', budget: 1, deadline: 'd' }, buyerAddress: '0x1', nonce: 'n' }
    );
    check('7c durable settled -> cached replay', !gate3.ok && gate3.cached && gate3.cached.status === 200 && /cached/.test(gate3.cached.body), JSON.stringify(gate3.cached).slice(0, 100));
    // Restart (new store instance over same dir) — row must survive
    const dstore2 = new DurableIdempotencyStore(dir);
    idem.setDurableStore(dstore2);
    const gate4 = await idem.idempotencyGate(
      { headers: { 'idempotency-key': 'key-G' } },
      { payload: { capability: 'x', budget: 1, deadline: 'd' }, buyerAddress: '0x1', nonce: 'n' }
    );
    check('7d durable cached row survives store restart', !gate4.ok && gate4.cached && gate4.cached.status === 200, JSON.stringify(gate4.cached).slice(0, 100));
  }

  // 8. gateway nonce store integration (durable backing, restart-safe)
  {
    const dir = tmpdir();
    const gateway = require('../../endpoint/gateway.js');
    const dstore = new DurableIdempotencyStore(dir);
    gateway.setNonceStore(dstore);
    gateway.clearNonces();
    gateway.setNonce('0xabc', 'settled', { txHash: '0x1234' });
    // Restart: fresh Map + same durable store
    gateway.clearNonces();
    gateway.setNonceStore(dstore);
    const got = gateway.getNonce('0xabc');
    check('8a nonce survives restart via durable store', got && got.status === 'settled' && got.recovered === true, JSON.stringify(got));
    // Cleanup: reset module state so other tests aren't polluted
    gateway.clearNonces();
    gateway.setNonceStore(null);
  }

  console.log('\n===== DURABLE IDEMPOTENCY SUMMARY =====');
  console.log('passed=' + passes + ' failed=' + failures);
  process.exit(failures > 0 ? 1 : 0);
})().catch(e => {
  console.error('TEST ERROR: ' + (e && e.stack || e));
  process.exit(2);
});
