// SAAX Protocol — Sprint 2 Item 4: analyze-outcomes.js
//
// Pulls the last 90 days of ranking outcomes with a resolved outcome
// (success/failure/dispute), computes per-component predictive power
// (point-biserial correlation between the SELECTED supplier's component score
// and outcome=success), and writes:
//   - report to stdout
//   - data/tuning-analysis-<date>.json
//
// Run (from saax-protocol/): node --env-file=.env scripts/tuning/analyze-outcomes.js
const fs = require('fs');
const path = require('path');
const lib = require('./tuning-lib.js');

async function main() {
  const client = lib.buildClient();
  const rows = await lib.fetchOutcomes(client, { days: 90 });
  const powers = lib.predictivePowers(rows, { onlySuccessVsFailure: true });

  const weightsUsed = rows.length ? (rows[0].weights_used || {}) : {};
  const report = {
    generated_at: new Date().toISOString(),
    window_days: 90,
    total_rows: rows.length,
    resolved: powers._meta,
    predictive_power: {
      reputation: powers.reputation,
      freshness: powers.freshness,
      price: powers.price,
    },
    current_weights_snapshot: weightsUsed,
    note: 'predictive power = |point-biserial correlation| between selected-supplier component score and outcome=success; n = rows with a resolvable component score for the selected supplier',
  };

  // Write analysis artifact (data/tuning-analysis-<date>.json).
  const date = lib.today();
  const outPath = path.join(__dirname, '..', '..', 'data', `tuning-analysis-${date}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // stdout report.
  console.log('=== SAAX Protocol — TUNING ANALYSIS (last 90 days) ===');
  console.log('generated:', report.generated_at);
  console.log('outcome rows with resolved outcome:', rows.length);
  console.log('  success:', powers._meta.nSuccess, '| failure:', powers._meta.nFailure, '| (disputes excluded from correlation but present in data)');
  console.log('');
  console.log('COMPONENT PREDICTIVE POWER (vs outcome=success)');
  for (const c of lib.COMPONENTS) {
    const p = powers[c];
    console.log(`  ${c.padEnd(12)} power=${p.power.toFixed(4)}  n=${p.n}  dir=${p.dir > 0 ? 'positive' : p.dir < 0 ? 'negative' : 'n/a'}`);
  }
  console.log('');
  console.log('current weights snapshot (first row):', JSON.stringify(weightsUsed));
  console.log('analysis written to: data/tuning-analysis-' + date + '.json');
  return report;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('FATAL', String(e)); process.exit(1); });
}

module.exports = main;