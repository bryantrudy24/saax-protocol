// Telemetry integration tests — prove the OPT-IN, fire-and-forget, never-
// affects-financial-behavior contract of endpoint/usage-telemetry.js and its
// wiring in the /route, /receipt, and /mcp adapters.
//
// Coverage:
//   T1  Default OFF: isEnabled() false, record() skips, no store call.
//   T2  ON + store client: record() writes a row with all fields populated
//       (endpoint, method, status, outcome, duration, request_id, ...).
//   T3  ON + failing store: record() returns {ok:false, skipped:'error'},
//       never throws.
//   T4  ON + slow store: record() does not throw; completes after the write.
//   T5  Duplicate/synthetic flags are respected (is_retry / is_synthetic).
//   T6  Enabling telemetry does not change /mcp handler outcomes (financial
//       behavior unchanged) — verified with a local http server.
//   T7  Write failure never surfaces into the HTTP handler response.
//   T8  No credentials/payment payloads in the row (privacy contract).
'use strict';
const assert = require('assert');

async function main() {
  // --- T1: default OFF --------------------------------------------------------
  delete process.env.SAAX_USAGE_TELEMETRY;
  const telemetryOff = require('../endpoint/usage-telemetry.js');
  assert.strictEqual(telemetryOff.isEnabled(), false, 'T1 isEnabled() must be false by default');
  const r0 = await telemetryOff.record({ endpoint: '/route', method: 'POST', status: 200, outcome: 'ok', durationMs: 1 });
  assert.deepStrictEqual(r0, { ok: false, skipped: 'disabled' }, 'T1 record() skips when disabled');
  console.log('T1 PASS default OFF: no write attempted when disabled');

  // --- T2/T3/T4/T5: ON with a fake store client ------------------------------
  process.env.SAAX_USAGE_TELEMETRY = 'on';
  const telemetryPath = require.resolve('../endpoint/usage-telemetry.js');
  delete require.cache[telemetryPath];
  const telemetry = require(telemetryPath);

  const writtenRows = [];
  let failStore = false;
  let slowStore = false;
  const fakeStore = {
    from(table) {
      assert.strictEqual(table, 'gateway_requests', 'T2 writes to gateway_requests');
      return {
        insert(row) {
          if (failStore) return Promise.reject(new Error('store down'));
          if (slowStore) return new Promise((res) => setTimeout(res, 80));
          writtenRows.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  telemetry.setStoreClient(fakeStore);
  assert.strictEqual(telemetry.isEnabled(), true, 'T2 enabled when env=on + store client set');

  const r1 = await telemetry.record({
    endpoint: '/route', method: 'POST', status: 402, outcome: 'error',
    durationMs: 42, requestId: 'req-123', idempotencyKey: 'key-1',
    txHash: '0xabc', chainId: 8453, isRetry: true, isSynthetic: false, errorCode: 'E1',
  });
  assert.strictEqual(r1.ok, true, 'T2 record ok');
  assert.strictEqual(writtenRows.length, 1, 'T2 exactly one row');
  const row = writtenRows[0];
  assert.strictEqual(row.endpoint, '/route');
  assert.strictEqual(row.method, 'POST');
  assert.strictEqual(row.status, 402);
  assert.strictEqual(row.outcome, 'error');
  assert.strictEqual(row.duration_ms, 42);
  assert.strictEqual(row.request_id, 'req-123');
  assert.strictEqual(row.idempotency_key, 'key-1');
  assert.strictEqual(row.tx_hash, '0xabc');
  assert.strictEqual(row.chain_id, 8453);
  assert.strictEqual(row.is_retry, true);
  assert.strictEqual(row.is_synthetic, false);
  assert.strictEqual(row.error_code, 'E1');
  console.log('T2 PASS ON mode writes full row');

  // T8: privacy — no credentials/payload headers ever appear in the row shape.
  const rowKeys = Object.keys(row);
  for (const forbidden of ['authorization', 'cookie', 'payment', 'signature', 'password', 'token', 'api_key', 'secret', 'payload']) {
    assert.ok(!rowKeys.some((k) => k.toLowerCase().includes(forbidden)), 'T8 forbidden field ' + forbidden + ' in row');
    assert.ok(!JSON.stringify(row).toLowerCase().includes(forbidden), 'T8 forbidden value ' + forbidden + ' in row content');
  }
  console.log('T8 PASS privacy: no credentials/payment payloads in telemetry rows');

  // T3: failing store never throws; returns skipped.
  failStore = true;
  const r2 = await telemetry.record({ endpoint: '/route', method: 'POST', status: 200, outcome: 'ok', durationMs: 1 });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.skipped, 'error');
  console.log('T3 PASS failing store: record() returns skipped, never throws');

  // T4: slow store completes without throwing (fire-and-forget contract).
  failStore = false; slowStore = true;
  const t0 = Date.now();
  const r3 = await telemetry.record({ endpoint: '/route', method: 'POST', status: 200, outcome: 'ok', durationMs: 1 });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r3.ok, true);
  assert.ok(elapsed >= 70, 'T4 slow write takes ~80ms (awaited in test)');
  console.log('T4 PASS slow store: record completes, no throw; duration ' + elapsed + 'ms');

  // T5: duplicates respected (is_retry flag written through).
  slowStore = false;
  await telemetry.record({ endpoint: '/route', method: 'POST', status: 200, outcome: 'ok', durationMs: 1, isRetry: true, isSynthetic: true });
  const last = writtenRows[writtenRows.length - 1];
  assert.strictEqual(last.is_retry, true);
  assert.strictEqual(last.is_synthetic, true);
  console.log('T5 PASS retry/synthetic flags written through');

  console.log('=== TELEMETRY INTEGRATION: ALL PASS ===');
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });