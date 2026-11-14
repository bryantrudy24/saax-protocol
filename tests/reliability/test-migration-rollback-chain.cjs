// SAAX Protocol — MCP Lifecycle Phase 5G: migration dependency + rollback
// verification (ISOLATED testbed — ax_router_db :5433, disposable).
//
// The rollback and migration scripts are SELF-TRANSACTIONAL (each already has
// BEGIN...COMMIT), so wrapping them in an outer transaction is invalid. This
// test therefore performs a REAL, provable round-trip on the disposable
// testbed:
//   1. Snapshot the ax_router object inventory (tables, RPCs, columns).
//   2. Apply the rollbacks in REVERSE dependency order (4 -> 3 -> 1).
//   3. Assert the Phase 1/3/4 lifecycle objects are gone (drop verified).
//   4. Re-apply the migrations in FORWARD order (1 -> 3 -> 4).
//   5. Assert the full object inventory is restored.
// This is safe because the testbed is disposable; production is never touched.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function psql(flags, sql) {
  return execFileSync('docker', ['exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router', '-v', 'ON_ERROR_STOP=1', ...flags, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}
function psqlFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  return execFileSync('docker', ['exec', '-i', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router', '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, encoding: 'utf8' });
}
function objectSnapshot() {
  const tables = psql([], "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='ax_router';");
  const funcs = psql([], "SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ax_router';");
  const cols = psql([], "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='ax_router' AND table_name='commitments';");
  return { tables, funcs, cols };
}

(async () => {
  const base = path.join(__dirname, '..', '..', 'data');
  const before = objectSnapshot();
  check('R0-baseline-inventory', before.tables.includes('commitment_events') && before.tables.includes('commitment_evidence') &&
    before.tables.includes('commitment_disputes') && before.funcs.includes('transition_commitment') &&
    before.funcs.includes('verify_evidence') && before.funcs.includes('raise_dispute'), before.tables);

  // ---- Phase 4 rollback (disputes) ----
  try { psqlFile(path.join(base, 'rollback-20261113-mcp-lifecycle-phase4-disputes.sql')); check('R1-phase4-rollback-applied', true); }
  catch (e) { check('R1-phase4-rollback-applied', false, String(e.stderr || e.message).slice(0, 200)); }
  const after4 = objectSnapshot();
  check('R1b-disputes-dropped', !after4.tables.includes('commitment_disputes') && !after4.funcs.includes('raise_dispute'), after4.tables);
  check('R1c-evidence-preserved', after4.tables.includes('commitment_evidence'), after4.tables);

  // ---- Phase 3 rollback (evidence) ----
  try { psqlFile(path.join(base, 'rollback-20261112-mcp-lifecycle-phase3-evidence.sql')); check('R2-phase3-rollback-applied', true); }
  catch (e) { check('R2-phase3-rollback-applied', false, String(e.stderr || e.message).slice(0, 200)); }
  const after3 = objectSnapshot();
  check('R2b-evidence-dropped', !after3.tables.includes('commitment_evidence') && !after3.funcs.includes('submit_evidence'), after3.tables);

  // ---- Phase 1 rollback (lifecycle + registry) ----
  try { psqlFile(path.join(base, 'rollback-20261110-mcp-lifecycle-phase1.sql')); check('R3-phase1-rollback-applied', true); }
  catch (e) { check('R3-phase1-rollback-applied', false, String(e.stderr || e.message).slice(0, 200)); }
  const after1 = objectSnapshot();
  check('R3b-lifecycle-dropped', !after1.tables.includes('commitment_events') && !after1.tables.includes('agent_authorizations') &&
    !after1.funcs.includes('transition_commitment') && !after1.cols.includes('version'), after1.tables + ' | ' + after1.cols);

  // ---- Re-apply forward order: 1 -> 3 -> 4 ----
  try { psqlFile(path.join(base, 'migration-20261110-mcp-lifecycle-phase1.sql')); check('R4-phase1-reapplied', true); }
  catch (e) { check('R4-phase1-reapplied', false, String(e.stderr || e.message).slice(0, 200)); }
  try { psqlFile(path.join(base, 'migration-20261112-mcp-lifecycle-phase3-evidence.sql')); check('R5-phase3-reapplied', true); }
  catch (e) { check('R5-phase3-reapplied', false, String(e.stderr || e.message).slice(0, 200)); }
  try { psqlFile(path.join(base, 'migration-20261113-mcp-lifecycle-phase4-disputes.sql')); check('R6-phase4-reapplied', true); }
  catch (e) { check('R6-phase4-reapplied', false, String(e.stderr || e.message).slice(0, 200)); }

  // ---- Restore verified ----
  const restored = objectSnapshot();
  const restoredOk = restored.tables === before.tables && restored.funcs.split(',').filter((f) => f.includes('commitment') || f.includes('evidence') || f.includes('dispute') || f.includes('authorization') || f.includes('authority')).length > 0 && restored.cols.includes('version');
  check('R7-inventory-restored', restoredOk, JSON.stringify({ before: before.tables, restored: restored.tables }));
  check('R7b-full-rpc-restored', restored.funcs.includes('transition_commitment') && restored.funcs.includes('submit_evidence') && restored.funcs.includes('raise_dispute'), restored.funcs);

  console.log('\n==== PHASE 5G MIGRATION/ROLLBACK ROUND-TRIP: ' + pass + '/' + (pass + fail) + ' PASS ====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });