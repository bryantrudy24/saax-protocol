// SAAX Discovery — Supabase proposal store contract test (mock RPC).
'use strict';
const { SupabaseProposalStore } = require('../../endpoint/supabase-proposal-store');
let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { passed += 1; console.log('[PASS] ' + name); } else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); } }
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

function makeMockDb() {
  const rows = new Map(); // nonce -> row
  return {
    rows,
    rpc: {
      async discovery_proposal_persist(p) {
        if (rows.has(p.p_client_nonce)) {
          const e = rows.get(p.p_client_nonce);
          return { created: false, ...e };
        }
        const row = { proposal_id: p.p_proposal_id, client_nonce: p.p_client_nonce, request_digest: p.p_request_digest, signed_payload: p.p_signed_payload, profile_version: p.p_profile_version, schema: { id: p.p_schema_id, version: p.p_schema_version, digest: p.p_schema_digest }, issued_at: p.p_issued_at, expires_at: p.p_expires_at, status: p.p_status };
        rows.set(p.p_client_nonce, row);
        return { created: true, ...row };
      },
    },
  };
}
function makeStore(db) {
  const fetchImpl = async (url, opts) => {
    const fn = url.split('/rpc/')[1];
    const data = await db.rpc[fn](JSON.parse(opts.body || '{}'));
    return { status: 200, async json() { return data; }, async text() { return JSON.stringify(data); } };
  };
  return new SupabaseProposalStore({ supabaseUrl: 'https://x', serviceRoleKey: 'k', fetchImpl });
}
const rec = (over = {}) => Object.assign({
  proposalId: 'prop_1', nonce: 'nonce-1', requestDigest: 'sha256:' + 'a'.repeat(64),
  signedPayload: { proposalId: 'prop_1', nonce: 'nonce-1' }, profileVersion: '1.0.0',
  schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) },
  issuedAt: '2026-11-05T12:00:00Z', expires: '2026-11-05T13:00:00Z', status: 'proposed',
}, over);

async function main() {
  const db = makeMockDb();
  const store = makeStore(db);
  const r1 = await store.persist(rec());
  eq(r1.ok, true, 'P1 fresh persist ok');
  eq(r1.duplicate, false, 'P2 not duplicate');
  const r2 = await store.persist(rec({ proposalId: 'prop_1b' }));
  eq(r2.duplicate, true, 'P3 same nonce + same digest -> duplicate');
  eq(r2.proposal.proposalId, 'prop_1', 'P4 duplicate returns the ORIGINAL proposal');
  const r3 = await store.persist(rec({ proposalId: 'prop_1c', requestDigest: 'sha256:' + 'c'.repeat(64) }));
  eq(r3.status, 'conflict', 'P5 same nonce + different digest -> conflict');
  // store_error on network failure
  const db2 = makeMockDb();
  db2.rpc.discovery_proposal_persist = async () => { throw new Error('down'); };
  const store2 = makeStore(db2);
  const r4 = await store2.persist(rec());
  eq(r4.status, 'store_error', 'P6 RPC failure -> store_error');
  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(failures.map((f) => ' - ' + f.name + ' :: ' + f.detail).join('\n')); process.exitCode = 1; }
}
main().catch((e) => { console.error('crash ' + (e && e.stack || e)); process.exitCode = 1; });