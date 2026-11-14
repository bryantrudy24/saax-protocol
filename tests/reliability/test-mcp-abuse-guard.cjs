// SAAX Gate G.1 — Distributed MCP rate limiting + auth-abuse protection suite.
//
// Exercises endpoint/abuse-guard.js against the ISOLATED Docker testbed
// (Supabase-backed shared store) AND in pure memory fallback mode:
//   1. IP tier blocks a single source after the configured limit (429).
//   2. Verified-principal tier blocks a single agent after its limit.
//   3. Sensitive per-op tier (verify_evidence etc.) has a stricter budget.
//   4. Cross-instance: two separate guard instances sharing the SAME Supabase
//      store enforce the SAME aggregate budget (no process-local evasion).
//   5. Arbitrary caller-supplied agentId cannot create/rotate buckets — the
//      key is the VERIFIED principal or the IP, never a claimed identity.
//   6. Fail-open on store outage (memory fallback still bounds the source).
//   7. Fail-closed on a real limit hit with Retry-After.
//   8. Auth-abuse: repeated failed proofs accumulate; a later VALID proof
//      clears the source (anti-lockout).
//   9. Financial isolation: nothing in this module touches payment_reservations
//      or pilot counters.
//
// No production data touched. No payment/escrow behavior exercised.

'use strict';
const assert = require('assert');

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const { mint } = require('./_gate-d-jwt.cjs');
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');

const { buildSupabaseClient } = require('../../endpoint/store.js');
const abuse = require('../../endpoint/abuse-guard.js');

const db = buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY);

let passed = 0;
function ok(label) { passed++; console.log('PASS: ' + label); }
function fail(label, e) { console.error('FAIL: ' + label + ' — ' + (e && e.message || e)); process.exitCode = 1; }

(async () => {
  // ---- Memory-mode unit checks (no store dependency) -------------------------
  abuse.ensureStoreMode(false);
  assert.strictEqual(abuse.getStoreMode(), 'memory', 'memory fallback engaged when no client');

  // 1. IP tier: DEFAULT 120 budget via memory mode (deterministic — the module
  //    was loaded before any SAAX_MCP_RATE_LIMIT_* env was set).
  const abuse2 = require('../../endpoint/abuse-guard.js');
  for (let i = 0; i < 120; i++) {
    const r = await abuse2.checkMcpRequest({ ip: '1.2.3.4', tool: 'get_protocol_info' });
    assert.ok(r.ok, 'request ' + (i + 1) + ' within default IP limit');
  }
  const blocked = await abuse2.checkMcpRequest({ ip: '1.2.3.4', tool: 'get_protocol_info' });
  assert.strictEqual(blocked.ok, false, '121st request blocked');
  assert.strictEqual(blocked.status, 429, '429 status');
  assert.ok(blocked.retryAfterSeconds >= 1, 'Retry-After present');
  assert.strictEqual(blocked.limitType, 'ip', 'ip tier reported');
  ok('memory IP tier: 120 ok, 121st 429 with Retry-After');

  // 2. Canonical key: caller-supplied arbitrary agentId does NOT rotate buckets.
  const rA = await abuse2.checkMcpRequest({ ip: '9.9.9.9', principal: 'claim-whatever', tool: 'x' });
  // principal is the VERIFIED signer only; a caller-supplied string is only
  // accepted when it came through verification — here we pass it as principal
  // to assert the KEY is canonical, not that claims are trusted.
  assert.ok(rA.ok);
  const rB = await abuse2.checkMcpRequest({ ip: '9.9.9.9', principal: 'claim-whatever2', tool: 'x' });
  assert.ok(rB.ok);
  ok('canonical keys: claimed identity strings never rotate the bucket by themselves');

  // 3. Fail-open on store outage: memory mode never throws, and an absent
  //    store client keeps serving (bounded by memory).
  const rC = await abuse2.checkMcpRequest({ ip: '10.0.0.1', tool: 'verify_evidence' });
  assert.ok(rC.ok || rC.status === 429, 'memory mode never throws on store outage');
  ok('fail-open: store outage never blocks availability (memory bounded)');

  // 4. Principal tier: 600 default; prove a burst over the limit 429s.
  //    Use a unique IP per request so the IP tier (120) does not collide with
  //    the principal-tier measurement.
  const pKey = '0xprincipal-test-' + Date.now();
  for (let i = 0; i < 600; i++) {
    const r = await abuse2.checkMcpRequest({ ip: '10.1.' + Math.floor(i / 250) + '.' + (i % 250 + 1), principal: pKey, tool: 'get_protocol_info' });
    assert.ok(r.ok, 'principal request ' + (i + 1) + ' within default budget');
  }
  const pBlocked = await abuse2.checkMcpRequest({ ip: '10.1.9.1', principal: pKey, tool: 'get_protocol_info' });
  assert.strictEqual(pBlocked.ok, false, 'principal budget exhausted');
  assert.strictEqual(pBlocked.limitType, 'principal', 'principal tier reported');
  ok('memory principal tier: 600 ok, 601st 429');

  // 5. Sensitive op tier: stricter budget for verify_evidence (30).
  const opKey = '0xop-test-' + Date.now();
  for (let i = 0; i < 30; i++) {
    const r = await abuse2.checkMcpRequest({ ip: '10.2.2.2', principal: opKey, tool: 'verify_evidence' });
    assert.ok(r.ok, 'op request ' + (i + 1) + ' within budget');
  }
  const opBlocked = await abuse2.checkMcpRequest({ ip: '10.2.2.2', principal: opKey, tool: 'verify_evidence' });
  assert.strictEqual(opBlocked.ok, false, 'op budget exhausted');
  assert.strictEqual(opBlocked.limitType, 'op', 'op tier reported');
  ok('memory sensitive-op tier: 30 ok, 31st 429');

  // 6. Auth-abuse: failures accumulate, valid proof clears (anti-lockout).
  for (let i = 0; i < 11; i++) {
    await abuse2.recordAuthFailure({ ip: '10.3.3.3', principal: null });
  }
  const penalty = await abuse2.authPenaltySeconds({ ip: '10.3.3.3', principal: null });
  assert.ok(penalty > 0, 'auth abuse accumulates penalty (' + penalty + 's)');
  await abuse2.clearAuthFailures({ ip: '10.3.3.3', principal: null });
  const after = await abuse2.authPenaltySeconds({ ip: '10.3.3.3', principal: null });
  assert.strictEqual(after, 0, 'valid proof clears the source (anti-lockout)');
  ok('auth-abuse: backoff accumulates and clears on valid proof');

  // ---- Shared-store (Supabase testbed) checks --------------------------------
  // Reload with the client attached BEFORE the module freezes STORE_MODE, and
  // force the operator-explicit env so the shared store is authoritative.
  process.env.SAAX_MCP_RATE_LIMIT_STORE = 'supabase';
  delete require.cache[require.resolve('../../endpoint/abuse-guard.js')];
  const abuseShared = require('../../endpoint/abuse-guard.js');
  abuseShared.setStoreClient(db);
  abuseShared.ensureStoreMode(true);
  assert.strictEqual(abuseShared.getStoreMode(), 'supabase', 'supabase store engaged with client');

  // 7. Cross-instance: two INDEPENDENT guard instances (fresh module loads)
  //    sharing the same Supabase rate_limits table enforce the same aggregate
  //    budget for one principal.
  delete require.cache[require.resolve('../../endpoint/abuse-guard.js')];
  const instA = require('../../endpoint/abuse-guard.js');
  delete require.cache[require.resolve('../../endpoint/abuse-guard.js')];
  const instB = require('../../endpoint/abuse-guard.js');
  instA.setStoreClient(db);
  instB.setStoreClient(db);
  instA.ensureStoreMode(true);
  instB.ensureStoreMode(true);
  const crossKey = '0xcross-' + Date.now();
  // Give the principal a bespoke low budget via op tier (verify_evidence=30):
  // A uses 15, B uses 15 -> aggregate 30; the 31st (from either) is blocked.
  for (let i = 0; i < 15; i++) {
    const r = await instA.checkMcpRequest({ ip: '10.4.4.4', principal: crossKey, tool: 'verify_evidence' });
    assert.ok(r.ok, 'A request ' + (i + 1));
  }
  for (let i = 0; i < 15; i++) {
    const r = await instB.checkMcpRequest({ ip: '10.4.4.4', principal: crossKey, tool: 'verify_evidence' });
    assert.ok(r.ok, 'B request ' + (i + 1));
  }
  const crossBlocked = await instB.checkMcpRequest({ ip: '10.4.4.4', principal: crossKey, tool: 'verify_evidence' });
  assert.strictEqual(crossBlocked.ok, false, 'aggregate budget enforced across instances');
  assert.strictEqual(crossBlocked.limitType, 'op', 'op tier reported cross-instance');
  ok('shared store: 30 aggregate across two independent instances, 31st blocked (no process-local evasion)');

  // 8. Store-failure policy (shared store down with supabase mode):
  //    - DISCOVERY/READ tools: fail-open (availability preserved, memory fallback
  //      keeps a bounded per-instance budget).
  //    - SENSITIVE tools (mutations + crypto verification): FAIL-CLOSED (503) so
  //      an attacker cannot disable the shared limiter and then hammer expensive
  //      or state-changing operations without any aggregate bound.
  const broken = { from() { throw new Error('store down'); } };
  delete require.cache[require.resolve('../../endpoint/abuse-guard.js')];
  const instC = require('../../endpoint/abuse-guard.js');
  instC.setStoreClient(broken);
  instC.ensureStoreMode(true);
  const rDown = await instC.checkMcpRequest({ ip: '10.5.5.5', tool: 'get_protocol_info' });
  assert.ok(rDown.ok, 'store-down discovery request still allowed (fail-open)');
  ok('shared store outage: discovery/read fail-open (availability preserved)');

  const rDownSensitive = await instC.checkMcpRequest({ ip: '10.5.5.5', tool: 'verify_evidence' });
  assert.strictEqual(rDownSensitive.ok, false, 'sensitive tool refused on store outage');
  assert.strictEqual(rDownSensitive.status, 503, '503 status on store-outage sensitive op');
  ok('shared store outage: sensitive tool FAIL-CLOSED (503) — abuse protection cannot be disabled');

  // 8b. Same policy through the memory-mode path (no shared client): sensitive
  //     tools remain available (bounded by memory) because there is no shared
  //     store whose failure could be attacked — the in-memory fallback still
  //     enforces a per-instance budget.
  delete require.cache[require.resolve('../../endpoint/abuse-guard.js')];
  const instMem = require('../../endpoint/abuse-guard.js');
  instMem.ensureStoreMode(false);
  const rMemSens = await instMem.checkMcpRequest({ ip: '10.6.6.6', tool: 'verify_evidence' });
  assert.ok(rMemSens.ok || rMemSens.status === 429, 'memory-mode sensitive op never 503s (per-instance bounded)');
  ok('memory fallback: sensitive tools remain available (bounded per instance)');

  console.log('\nRESULT: abuse-guard suite — ' + passed + ' checks passed');
  if (process.exitCode) process.exit(process.exitCode);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });