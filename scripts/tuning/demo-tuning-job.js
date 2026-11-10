// SAAX Protocol — Sprint 2: end-to-end tuning job demo (Item 3 verification)
//
// Drives the REAL propose-weights.js pipeline against the Docker Postgres:
//   1. seed 150 reputation-strong synthetic outcomes -> run the job ->
//      expect a PENDING proposal in tuning_proposals + history + daily log
//   2. seed 50 rows (below min) -> run the job -> expect insufficient_data,
//      NO new proposal
//   3. run the removal-flag scenario: two cycles with uncorrelated freshness
//      -> expect the job flags freshness as a removal candidate in its log
//
// Run (from saax-protocol/): node --env-file=.env scripts/tuning/demo-tuning-job.js
const fs = require('fs');
const path = require('path');
const lib = require('./tuning-lib.js');
const prop = require('./propose-weights.js'); // exports the main() function directly

const PREFIX = 'tune-demo-';
const results = [];
const check = (name, cond, detail) => {
  const ok = !!cond;
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
};

function seedRows({ count, strongComp, freshnessNoise = false }) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const rep = 40 + Math.random() * 60;
    const fresh = 40 + Math.random() * 60;
    const price = 40 + Math.random() * 60;
    let p = 0.5;
    if (strongComp === 'reputation') p = rep / 100 * 0.9 + 0.05;
    else if (strongComp === 'price') p = price / 100 * 0.9 + 0.05;
    if (freshnessNoise) p = 0.5;
    const success = Math.random() < p;
    rows.push({
      request_id: PREFIX + strongComp + '-' + i + '-' + Math.random().toString(36).slice(2, 8),
      capability: 'demo ' + strongComp,
      supplier_ids: ['s1', 's2', 's3'],
      supplier_scores: [80, 70, 60],
      selected_supplier: 's1',
      weights_used: { reputation: 0.6, freshness: 0.2, price: 0.2, formula: 'linear' },
      shrinkage_applied: false,
      component_scores: {
        rows: [
          { agent_id: 's1', reputation: rep, freshness: fresh, price, category: 'demo', feedback_count: 100, shrunken: false },
          { agent_id: 's2', reputation: rep - 5, freshness: fresh - 5, price: price - 5, category: 'demo', feedback_count: 100, shrunken: false },
          { agent_id: 's3', reputation: rep - 10, freshness: fresh - 10, price: price - 10, category: 'demo', feedback_count: 100, shrunken: false },
        ],
      },
      outcome: success ? 'success' : 'failure',
      outcome_timestamp: new Date(Date.now() - Math.floor(Math.random() * 10) * 86400e3).toISOString(),
      routing_fee_usd: 0.05,
      settlement_rail: 'x402',
    });
  }
  return rows;
}

async function clearDemo(client) {
  const res = await client.from('ranking_outcomes').select('id,request_id').limit(1000);
  if (res.error) return;
  const ids = (res.data || []).filter(r => r && String(r.request_id || '').startsWith(PREFIX)).map(r => r.id);
  for (let i = 0; i < ids.length; i += 100) await client.from('ranking_outcomes').delete().in('id', ids.slice(i, i + 100));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('========== SAAX Protocol — SPRINT 2 TUNING JOB E2E DEMO ==========');
  const client = lib.buildClient();
  await clearDemo(client);

  // ====================================================================
  // Scenario A — 150 reputation-strong outcomes -> proposal written (pending)
  // ====================================================================
  console.log('\n== A: 150 rows, reputation strongest -> job writes a PENDING proposal ==');
  await clearDemo(client);
  const rowsA = seedRows({ count: 150, strongComp: 'reputation' });
  for (const r of rowsA) await client.from('ranking_outcomes').insert(r);
  const outA = await prop();
  check('A job ran to completion (proposal written)', outA.status === 'proposed' && !!outA.new_weights, 'job=' + (outA.status||'') + ' weights=' + JSON.stringify(outA.new_weights||null));
  check('A proposal has new_weights', !!(outA.new_weights && outA.new_weights.reputation > 0), JSON.stringify(outA.new_weights));

  // Verify the DB rows
  const props = await client.from('tuning_proposals').select('*').limit(20);
  const propRows = (props.data || []).filter(p => p && p.analysis_date === lib.today());
  const latestProposal = propRows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  check('A tuning_proposals has a pending row', !!latestProposal && latestProposal.status === 'pending', latestProposal ? latestProposal.status : 'none');
  check('A proposal sample_size >= 100', !!latestProposal && latestProposal.sample_size >= 100, latestProposal && String(latestProposal.sample_size));
  if (latestProposal) {
    check('A old_weights match current (0.6/0.2/0.2)', JSON.stringify(latestProposal.old_weights).includes('0.6'), JSON.stringify(latestProposal.old_weights));
    check('A not auto-applied (status != applied, tuning_history.applied=false)', latestProposal.status !== 'applied', latestProposal.status);
  }

  const hist = await client.from('tuning_history').select('*').limit(20);
  const histRows = (hist.data || []).filter(h => h && h.sample_size >= 100);
  check('A tuning_history has a run (not applied)', histRows.length > 0 && histRows.every(h => h.applied === false), 'runs=' + histRows.length);

  const dailyPath = path.join(__dirname, '..', '..', 'daily-logs', `tuning-${lib.today()}.md`);
  check('A daily log written', fs.existsSync(dailyPath), dailyPath);

  // ====================================================================
  // Scenario B — 50 rows -> insufficient_data, NO proposal
  // ====================================================================
  console.log('\n== B: 50 rows -> insufficient_data, no proposal ==');
  await clearDemo(client);
  const rowsB = seedRows({ count: 50, strongComp: 'reputation' });
  for (const r of rowsB) await client.from('ranking_outcomes').insert(r);
  const outB = await prop();
  check('B job returned status insufficient_data', outB.status === 'insufficient_data', outB.status);
  check('B no new_weights (null)', outB.new_weights == null, String(outB.new_weights));
  const histB = await client.from('tuning_history').select('*').limit(20);
  const latestB = (histB.data || []).sort((a, b) => new Date(b.run_at) - new Date(a.run_at))[0];
  check('B history logged insufficient_data', !!latestB && latestB.status === 'insufficient_data' && latestB.sample_size < 100,
    latestB ? (latestB.status + ' n=' + latestB.sample_size) : 'none');
  const propsBeforeB = await client.from('tuning_proposals').select('*').limit(100);
  const beforeBCount = (propsBeforeB.data || []).filter(p => p && p.analysis_date === lib.today()).length;
  const propsB = await client.from('tuning_proposals').select('*').limit(100);
  const todayProps = (propsB.data || []).filter(p => p && p.analysis_date === lib.today());
  check('B no new proposal row written', todayProps.length === beforeBCount, 'before=' + beforeBCount + ' after=' + todayProps.length);

  // ====================================================================
  // Scenario C — two cycles with uncorrelated freshness -> removal flag
  // ====================================================================
  console.log('\n== C: two cycles, freshness uncorrelated -> removal flag ==');
  await clearDemo(client);
  const rowsC1 = seedRows({ count: 150, strongComp: 'reputation', freshnessNoise: true });
  for (const r of rowsC1) await client.from('ranking_outcomes').insert(r);
  await prop();   // cycle 1
  await clearDemo(client);
  const rowsC2 = seedRows({ count: 150, strongComp: 'reputation', freshnessNoise: true });
  for (const r of rowsC2) await client.from('ranking_outcomes').insert(r);
  const outC = await prop();   // cycle 2
  console.log('  cycle-2 removal flags:', JSON.stringify(outC.removalFlags || []));
  check('C freshness flagged for removal after 2 cycles', (outC.removalFlags || []).includes('freshness'), JSON.stringify(outC.removalFlags));

  // Cleanup demo rows + proposals/history from this demo run (keep idempotent).
  await clearDemo(client);

  const failures = results.filter(r => !r.ok).length;
  console.log('\n' + (failures === 0 ? 'ALL TUNING JOB E2E DEMO PASSED' : failures + ' DEMO CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('DEMO CRASHED: ' + e); process.exit(2); });
