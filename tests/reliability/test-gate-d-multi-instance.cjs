// SAAX Gate D — Phase C: multi-instance reliability verification.
//
// Runs TWO independently started application instances (separate OS processes,
// separate ports) against ONE shared Postgres/PostgREST testbed, reproducing the
// production topology (Vercel serverless = many instances, one Supabase).
//
// Scope: ISOLATED local testbed only (ax_router_db :5433 + ax_router_postgrest
// :3000). No production endpoint is contacted, no real funds move, no mainnet
// transaction is created. Payment verification is exercised through the mock
// lane (SAAX_X402_MODE unset) so no chain call is made.
//
// What this proves vs. what it does NOT:
//   PROVES  — cross-instance serialization of the idempotency gate through the
//             shared DB (advisory lock), payload binding, nonce uniqueness,
//             restart recovery, reconciliation, and fail-closed behavior when
//             the shared store is unreachable.
//   DOES NOT PROVE — live production concurrency. Production is observed
//             read-only in this gate; see 22-multi-instance-verification.md.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { mint } = require('./_gate-d-jwt.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
// PostgREST is configured with PGRST_DB_URI=.../ax_router, so the application
// writes into the `ax_router` DATABASE. Assertions must read the same database
// or they observe an empty (unused) `postgres` database and report false
// failures. Verified from the container's own environment.
const PG_DB = 'ax_router';

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; results.push('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function psql(sql) {
  const { execFileSync } = require('node:child_process');
  return execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', PG_DB,
    '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

function resetTables() {
  psql('delete from ax_router.idempotency_keys;');
  psql('delete from ax_router.commitments;');
}

// Start one app instance on its own port, sharing the same PostgREST/DB.
//
// NOTE (Gate D finding, documented in 20-gate-d-architecture-verification.md):
// the two persistence adapters read DIFFERENT environment variables.
//   endpoint/store.js            -> POSTGREST_URL + SAAX_POSTGREST_KEY
//   endpoint/commitment-store.js -> SUPABASE_URL + SUPABASE_ANON_KEY
// Production sets both families, so the split is invisible there; the testbed
// must set both to reproduce production behavior faithfully.
function startInstance(port, extraEnv) {
  const token = mint('service_role');
  const storeUrl = (extraEnv && extraEnv.__storeUrl) || 'http://127.0.0.1:3000';
  const env = {
    ...process.env,
    PORT: String(port),
    SAAX_HOST: '127.0.0.1',
    POSTGREST_URL: storeUrl,
    SAAX_POSTGREST_KEY: token,
    SUPABASE_URL: storeUrl,
    SUPABASE_ANON_KEY: token,
    SUPABASE_SERVICE_ROLE_KEY: '',
    SAAX_IDEMPOTENCY_STORE: '',
    SAAX_X402_MODE: '',
    SAAX_KILL_SWITCH: '',
    SAAX_RATE_LIMIT_IP: '100000',
    SAAX_RATE_LIMIT_WALLET: '100000',
    ...(extraEnv || {}),
  };
  delete env.__storeUrl;
  const child = spawn(process.execPath, [path.join(ROOT, 'endpoint', 'route-server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, port, out: '', ready: false };
  child.stdout.on('data', d => { state.out += d.toString(); });
  child.stderr.on('data', d => { state.out += d.toString(); });
  return state;
}

async function waitReady(inst, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:' + inst.port + '/route', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability: 'readiness', budget: 1, deadline: '2026-12-01' }),
      });
      if (r.status > 0) { inst.ready = true; return true; }
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function stop(inst) {
  try { inst.child.kill('SIGKILL'); } catch (_) {}
}

// A payment-bearing request. The mock lane verifies without a chain call.
function payReq(port, { key, capability, budget, deadline, nonce }) {
  const headers = { 'Content-Type': 'application/json', 'x-x402-mock': 'mock' };
  if (key) headers['Idempotency-Key'] = key;
  return fetch('http://127.0.0.1:' + port + '/route', {
    method: 'POST', headers,
    body: JSON.stringify({ capability, budget, deadline, nonce }),
  }).then(async r => ({ status: r.status, body: await r.text() }));
}

(async () => {
  console.log('=== SAAX Gate D — multi-instance reliability (isolated testbed) ===\n');
  resetTables();

  const A = startInstance(18081);
  const B = startInstance(18082);
  const okA = await waitReady(A);
  const okB = await waitReady(B);
  check('two independent instances started', okA && okB, 'ports 18081/18082');
  if (!okA || !okB) {
    console.log(A.out.slice(-2000)); console.log(B.out.slice(-2000));
    stop(A); stop(B); process.exit(1);
  }
  check('both instances report the shared supabase store',
    /store=supabase/.test(A.out) && /store=supabase/.test(B.out),
    'store=supabase in both startup banners');

  // ---- 1. Concurrent identical requests across BOTH instances --------------
  resetTables();
  const key1 = 'gate-d-identical-' + crypto.randomUUID();
  const payload1 = { key: key1, capability: 'security scan', budget: 500, deadline: '2026-12-01' };
  const [r1, r2] = await Promise.all([payReq(18081, payload1), payReq(18082, payload1)]);
  const rows1 = Number(psql("select count(*) from ax_router.idempotency_keys where key='" + key1 + "';"));
  const statuses1 = [r1.status, r2.status].sort();
  check('1. concurrent identical across instances -> exactly ONE key row',
    rows1 === 1, 'rows=' + rows1 + ' statuses=' + statuses1.join(','));
  const fresh1 = [r1, r2].filter((r) => {
    if (r.status !== 200) return false;
    try { const j = JSON.parse(r.body); return j && j.replay !== true && !!(j.commitment && j.commitment.commitmentId); } catch (_) { return false; }
  }).length;
  check('1b. at most one FRESH authorization across both instances (replays allowed)',
    fresh1 <= 1,
    'statuses=' + statuses1.join(',') + ' fresh=' + fresh1);

  // ---- 2. Concurrent CONFLICTING payloads, same key ------------------------
  resetTables();
  const key2 = 'gate-d-conflict-' + crypto.randomUUID();
  const [c1, c2] = await Promise.all([
    payReq(18081, { key: key2, capability: 'security scan', budget: 500, deadline: '2026-12-01' }),
    payReq(18082, { key: key2, capability: 'data pipeline', budget: 999, deadline: '2026-12-02' }),
  ]);
  const rows2 = Number(psql("select count(*) from ax_router.idempotency_keys where key='" + key2 + "';"));
  const conflictRejected = [c1.status, c2.status].some(s => s === 422 || s === 409);
  check('2. conflicting payloads on one key -> rejected, no second authorization',
    conflictRejected && rows2 === 1, 'statuses=' + [c1.status, c2.status].join(',') + ' rows=' + rows2);

  // ---- 3. Simultaneous key acquisition (N workers, both instances) ---------
  resetTables();
  const key3 = 'gate-d-acquire-' + crypto.randomUUID();
  const burst = [];
  for (let i = 0; i < 8; i++) {
    burst.push(payReq(i % 2 === 0 ? 18081 : 18082,
      { key: key3, capability: 'security scan', budget: 500, deadline: '2026-12-01' }));
  }
  const burstRes = await Promise.all(burst);
  const rows3 = Number(psql("select count(*) from ax_router.idempotency_keys where key='" + key3 + "';"));
  // UPDATED (Gate D.2): count AUTHORIZATIONS, not raw HTTP statuses. Once the
  // winner settles, concurrent duplicates correctly get the CACHED 200
  // (settled-replay — the property validated by case 8). A 200 replay is NOT
  // a second authorization; the invariant is exactly one row and at most one
  // FRESH commitment across all workers.
  const freshAuth = burstRes.filter((r) => {
    if (r.status !== 200) return false;
    try { const j = JSON.parse(r.body); return j && j.replay !== true && !!(j.commitment && j.commitment.commitmentId); } catch (_) { return false; }
  }).length;
  const ok200 = burstRes.filter(r => r.status === 200).length;
  check('3. 8 simultaneous acquisitions -> exactly ONE row, at most one fresh authorization',
    rows3 === 1 && freshAuth <= 1, 'rows=' + rows3 + ' 200s=' + ok200 + ' fresh_auth=' + freshAuth);

  // ---- 4. Worker termination during pending settlement ---------------------
  resetTables();
  const key4 = 'gate-d-crash-' + crypto.randomUUID();
  // Insert a pending row directly (simulating a worker that died mid-flight).
  psql("insert into ax_router.idempotency_keys(key,status,payload_hash,created_at,expires_at) values ('" +
    key4 + "','pending','ph:crash', now() - interval '10 minutes', now() + interval '24 hours');");
  const pendingBefore = psql("select status from ax_router.idempotency_keys where key='" + key4 + "';");
  check('4. crashed worker leaves a durable pending row', pendingBefore === 'pending', 'status=' + pendingBefore);

  // ---- 5. Worker restart + reconciliation ---------------------------------
  // Restart instance A: startup reconciliation must NOT invent a settlement.
  stop(A);
  const A2 = startInstance(18081);
  const okA2 = await waitReady(A2);
  check('5. instance restarted', okA2, 'port 18081');
  await new Promise(r => setTimeout(r, 1500)); // let the lazy reconcile run
  const afterReconcile = psql("select status from ax_router.idempotency_keys where key='" + key4 + "';");
  check('5b. reconciliation did NOT fabricate a settlement (row still pending)',
    afterReconcile === 'pending', 'status=' + afterReconcile);
  check('5c. reconciliation ran without error',
    !/reconciliation error/i.test(A2.out), 'no reconciliation error in startup log');

  // ---- 6. Database connection interruption --------------------------------
  // Point an instance at a dead PostgREST port: the gate must fail CLOSED.
  const C = startInstance(18083, { __storeUrl: 'http://127.0.0.1:3999' });
  const okC = await waitReady(C);
  check('6. instance with unreachable store still starts (challenge path open)', okC, 'port 18083');
  const deadRes = await payReq(18083, { key: 'gate-d-deadstore-' + crypto.randomUUID(), capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  check('6b. payment request with store unreachable -> 503 fail-closed (no payment initiated)',
    deadRes.status === 503, 'status=' + deadRes.status + ' body=' + deadRes.body.slice(0, 120));
  stop(C);

  // ---- 7. PostgREST timeout / retry ---------------------------------------
  // A slow store must not be interpreted as success. Simulate by pointing at a
  // port that accepts but never answers (blackhole) — expect fail-closed.
  const D = startInstance(18084, { __storeUrl: 'http://127.0.0.1:3998' });
  const okD = await waitReady(D);
  const slowRes = await payReq(18084, { key: 'gate-d-timeout-' + crypto.randomUUID(), capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  check('7. store timeout -> 503 (timeout is NOT proof of failure or success)',
    okD && slowRes.status === 503, 'status=' + slowRes.status);
  stop(D);

  // ---- 8. Duplicate settlement evidence -----------------------------------
  resetTables();
  const key8 = 'gate-d-dupsettle-' + crypto.randomUUID();
  await payReq(18081, { key: key8, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  const st8a = psql("select status from ax_router.idempotency_keys where key='" + key8 + "';");
  const replay8 = await payReq(18082, { key: key8, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  const st8b = psql("select status from ax_router.idempotency_keys where key='" + key8 + "';");
  check('8. duplicate settlement evidence -> cached replay, state unchanged',
    st8a === st8b && replay8.status === 200, 'before=' + st8a + ' after=' + st8b + ' replay=' + replay8.status);

  // ---- 9. Unknown settlement outcomes ------------------------------------
  // The fixture's payload_hash MUST equal the hash the gate computes for the
  // request below, otherwise the gate correctly returns 422 (payload binding)
  // and never reaches the pending branch this test is about. Hash formula is
  // endpoint/idempotency.js payloadHash(): 'ph:' + sha256(capability|budget|deadline).
  resetTables();
  const key9 = 'gate-d-unknown-' + crypto.randomUUID();
  const ph9 = 'ph:' + crypto.createHash('sha256')
    .update('security scan|500|2026-12-01', 'utf8').digest('hex');
  psql("insert into ax_router.idempotency_keys(key,status,payload_hash,created_at,expires_at) values ('" +
    key9 + "','pending','" + ph9 + "', now() - interval '2 hours', now() + interval '24 hours');");
  const unknownRes = await payReq(18082, { key: key9, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  const st9 = psql("select status from ax_router.idempotency_keys where key='" + key9 + "';");
  check('9. unknown outcome stays unresolved (409, never auto-settled)',
    unknownRes.status === 409 && st9 === 'pending', 'status=' + unknownRes.status + ' row=' + st9);

  // ---- 10. Expired idempotency records -----------------------------------
  resetTables();
  const key10 = 'gate-d-expired-' + crypto.randomUUID();
  psql("insert into ax_router.idempotency_keys(key,status,payload_hash,created_at,expires_at) values ('" +
    key10 + "','settled','ph:exp', now() - interval '48 hours', now() - interval '24 hours');");
  const expiredRes = await payReq(18081, { key: key10, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  check('10. expired record is not treated as a live replay (re-processed or rejected, never silently settled)',
    expiredRes.status === 200 || expiredRes.status === 409 || expiredRes.status === 422,
    'status=' + expiredRes.status);

  // ---- 11. Multiple reconciliation workers -------------------------------
  resetTables();
  const key11 = 'gate-d-multirecon-' + crypto.randomUUID();
  psql("insert into ax_router.idempotency_keys(key,status,payload_hash,created_at,expires_at) values ('" +
    key11 + "','pending','ph:mr', now() - interval '1 hour', now() + interval '24 hours');");
  // Two instances reconcile concurrently via the RPC (advisory-locked).
  const token = mint('service_role');
  const recon = () => fetch('http://127.0.0.1:3000/rpc/reconcile_idempotency', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: token, Authorization: 'Bearer ' + token, 'Content-Profile': 'ax_router' },
    body: JSON.stringify({ p_stale_after_seconds: 60, p_limit: 100, p_force_unknown: false, p_confirmed_keys: [], p_failed_keys: [] }),
  }).then(async r => ({ status: r.status, body: await r.text() }));
  const [m1, m2] = await Promise.all([recon(), recon()]);
  const st11 = psql("select status from ax_router.idempotency_keys where key='" + key11 + "';");
  check('11. concurrent reconciliation workers -> no fabricated settlement',
    st11 === 'pending' && m1.status === 200 && m2.status === 200,
    'row=' + st11 + ' rpc=' + m1.status + '/' + m2.status);

  // ---- 12. Cross-instance status lookups ---------------------------------
  resetTables();
  const key12 = 'gate-d-crosslookup-' + crypto.randomUUID();
  await payReq(18081, { key: key12, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  const seenByB = psql("select count(*) from ax_router.idempotency_keys where key='" + key12 + "';");
  const replayOnB = await payReq(18082, { key: key12, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  check('12. instance B sees the row written by instance A (shared durable state)',
    Number(seenByB) === 1 && replayOnB.status === 200, 'rows=' + seenByB + ' replayB=' + replayOnB.status);

  // ---- 13. Failed persistence and recovery -------------------------------
  resetTables();
  const key13 = 'gate-d-persistfail-' + crypto.randomUUID();
  // Break the commitments RPC target by revoking EXECUTE, then restore.
  psql("revoke execute on function ax_router.upsert_commitment(text,text,text,text,jsonb,text,jsonb,text,text) from anon, authenticated, service_role;");
  const failRes = await payReq(18081, { key: key13, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  psql("grant execute on function ax_router.upsert_commitment(text,text,text,text,jsonb,text,jsonb,text,text) to anon, authenticated, service_role;");
  const failRows = Number(psql("select count(*) from ax_router.commitments;"));
  check('13. persistence failure -> 503, NO commitment row, no payment challenge',
    failRes.status === 503 && failRows === 0, 'status=' + failRes.status + ' rows=' + failRows);
  const recoverRes = await payReq(18081, { key: key13, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  const recoverRows = Number(psql("select count(*) from ax_router.commitments;"));
  check('13b. after store recovery the same key succeeds to exactly ONE commitment',
    recoverRes.status === 200 && recoverRows === 1, 'status=' + recoverRes.status + ' rows=' + recoverRows);

  // ---- 14. Concurrent requests with DIFFERENT valid keys -----------------
  resetTables();
  const keys14 = Array.from({ length: 6 }, () => 'gate-d-distinct-' + crypto.randomUUID());
  const distinctRes = await Promise.all(keys14.map((k, i) => payReq(i % 2 === 0 ? 18081 : 18082,
    { key: k, capability: 'security scan', budget: 500, deadline: '2026-12-01' })));
  const rows14 = Number(psql("select count(*) from ax_router.idempotency_keys;"));
  const commit14 = Number(psql("select count(*) from ax_router.commitments;"));
  check('14. 6 distinct keys -> 6 rows, 6 distinct commitments (no cross-contamination)',
    rows14 === 6 && commit14 === 6, 'keys=' + rows14 + ' commitments=' + commit14);

  // ---- 15. Prevention of duplicate payment authorization -----------------
  resetTables();
  const key15 = 'gate-d-nodupay-' + crypto.randomUUID();
  const first15 = await payReq(18081, { key: key15, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  const second15 = await payReq(18082, { key: key15, capability: 'security scan', budget: 500, deadline: '2026-12-01' });
  const commit15 = Number(psql("select count(*) from ax_router.commitments;"));
  check('15. retry across instances -> ONE commitment, second is a cached replay',
    commit15 === 1 && second15.status === 200, 'commitments=' + commit15 + ' retry=' + second15.status);

  stop(A2); stop(B);

  console.log(results.join('\n'));
  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(1);
});
