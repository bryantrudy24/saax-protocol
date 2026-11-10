// SAAX Protocol — Sprint 2 Item 3+4: propose-weights.js (the tuning job)
//
// The self-tuning loop. Queries saax_router.ranking_outcomes for resolved
// outcomes in the last 90 days, computes per-component predictive power,
// proposes new weights proportional to that power with guardrails, and writes:
//   - saax_router.tuning_history  (every run: old/new weights, sample size,
//                                predictive powers, applied=false)
//   - saax_router.tuning_proposals (review queue; status='pending' — the
//                                OPERATOR reviews and approves; NOTHING
//                                auto-applies)
//   - daily-logs/tuning-<date>.md  (per-cycle analysis: which components
//                                gained/lost predictive power, interpretation,
//                                removal candidates, new-factor proposals)
//
// Guardrails (operator spec):
//   - min sample: 100 completed transactions with a resolved outcome; below
//     that -> insufficient_data, keep current weights, log it.
//   - new weights within ±0.15 of current per component per cycle.
//   - no component below 0.1 or above 0.7.
//
// Run (from saax-protocol/): node --env-file=.env scripts/tuning/propose-weights.js
//
// ** Operator-gated: this job NEVER updates production weights. It writes
//    proposals that require operator approval + apply-weights.js --confirm. **
const fs = require('fs');
const path = require('path');
const lib = require('./tuning-lib.js');
const weights = require('../../endpoint/weights.js');

const MIN_SAMPLE = Number(process.env.SAAX_TUNING_MIN_SAMPLE || 100);

async function main() {
  const client = lib.buildClient();
  const rows = await lib.fetchOutcomes(client, { days: 90 });
  const current = weights.currentWeights();
  const powers = lib.predictivePowers(rows, { onlySuccessVsFailure: true });
  const sample = powers._meta.total;

  const date = lib.today();
  const analysis = {
    generated_at: new Date().toISOString(),
    window_days: 90,
    sample_size: sample,
    predictive_powers: {
      reputation: powers.reputation.power,
      freshness: powers.freshness.power,
      price: powers.price.power,
    },
    predictive_detail: powers,
  };

  // ---- Minimum sample gate -------------------------------------------------
  if (sample < MIN_SAMPLE) {
    const historyRow = {
      old_weights: current,
      new_weights: null,
      sample_size: sample,
      predictive_powers: analysis.predictive_powers,
      applied: false,
      status: 'insufficient_data',
      notes: `sample size ${sample} < minimum ${MIN_SAMPLE}; keeping current weights`,
    };
    await lib.insertHistory(client, historyRow);
    await writeDailyLog({ date, current, proposed: null, analysis, status: 'insufficient_data', sample });
    console.log('=== SAAX Protocol — TUNING PROPOSAL (insufficient data) ===');
    console.log(`sample size ${sample} < ${MIN_SAMPLE}: no proposal. current weights kept:`, JSON.stringify(current));
    console.log('tuning_history logged: insufficient_data');
    return { status: 'insufficient_data', ...historyRow };
  }

  // ---- Proposal proportional to predictive power ---------------------------
  const raw = {
    reputation: powers.reputation.power,
    freshness: powers.freshness.power,
    price: powers.price.power,
  };
  const guarded = lib.applyGuardrails(raw, current, { maxDelta: 0.15, minW: 0.1, maxW: 0.7 });
  const { _guardrails, ...proposed } = guarded;

  const proposalRow = {
    analysis_date: date,
    old_weights: current,
    new_weights: proposed,
    sample_size: sample,
    predictive_powers: analysis.predictive_powers,
    status: 'pending',
  };
  await lib.insertProposal(client, proposalRow);

  const historyRow = {
    old_weights: current,
    new_weights: proposed,
    sample_size: sample,
    predictive_powers: analysis.predictive_powers,
    applied: false,
    status: 'proposed',
    notes: 'proposal written to tuning_proposals; operator review required (human-gated)',
  };
  await lib.insertHistory(client, historyRow);

  // ---- Removal candidates (two consecutive cycles below 0.05) --------------
  // Read the LAST tuning_history entry for each component's power; if the
  // current cycle AND the previous cycle are both < 0.05, flag for removal.
  const removalFlags = [];
  const prev = await previousCyclePowers(client);
  if (prev) {
    for (const c of lib.COMPONENTS) {
      const curP = powers[c].power;
      const prevP = prev[c] != null ? prev[c] : null;
      if (curP < 0.05 && prevP != null && prevP < 0.05) {
        removalFlags.push(c);
      }
    }
  }

  await writeDailyLog({ date, current, proposed, analysis, status: 'proposed', sample, removalFlags });

  console.log('=== SAAX Protocol — TUNING PROPOSAL (pending operator review) ===');
  console.log('sample size:', sample, '| window: 90 days');
  console.log('');
  console.log('PREDICTIVE POWER (correlation with success):');
  for (const c of lib.COMPONENTS) {
    console.log(`  ${c.padEnd(12)} ${powers[c].power.toFixed(4)}  (n=${powers[c].n})`);
  }
  console.log('');
  console.log('WEIGHTS:');
  console.log('  old:', JSON.stringify(current));
  console.log('  proposed:', JSON.stringify(proposed), '(guardrails applied: ±0.15, 0.1-0.7)');
  console.log('');
  if (removalFlags.length) {
    console.log('REMOVAL CANDIDATES (predictive power < 0.05 for 2 consecutive cycles):', removalFlags.join(', '));
  } else {
    console.log('REMOVAL CANDIDATES: none');
  }
  console.log('proposal written to saax_router.tuning_proposals (pending)');
  console.log('tuning_history entry written (applied=false)');
  console.log('daily log: daily-logs/tuning-' + date + '.md');
  return { ...proposalRow, status: 'proposed', removalFlags };
}

// Last completed tuning cycle's per-component predictive powers. The minimal
// PostgREST client has no .order(); fetch the newest 20 history rows and pick
// the most recent with predictive_powers.
async function previousCyclePowers(client) {
  const res = await client.from('tuning_history').select('predictive_powers,run_at,status').limit(20);
  if (res.error) return null;
  const rows = (res.data || []).filter(r => r && r.predictive_powers);
  if (!rows.length) return null;
  rows.sort((a, b) => new Date(b.run_at) - new Date(a.run_at));
  const latest = rows[0].predictive_powers || {};
  return {
    reputation: latest.reputation != null ? latest.reputation : null,
    freshness: latest.freshness != null ? latest.freshness : null,
    price: latest.price != null ? latest.price : null,
  };
}

async function writeDailyLog({ date, current, proposed, analysis, status, sample, removalFlags }) {
  const dir = path.join(__dirname, '..', '..', 'daily-logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tuning-${date}.md`);
  const lines = [];
  lines.push(`# SAAX Protocol — Tuning Cycle (${date})`);
  lines.push('');
  lines.push(`- **Status:** ${status}`);
  lines.push(`- **Sample size (resolved outcomes, last 90d):** ${sample}${sample < MIN_SAMPLE ? ` (below minimum ${MIN_SAMPLE} — no proposal)` : ''}`);
  lines.push(`- **Weights:** old \`${JSON.stringify(current)}\`` + (proposed ? ` → proposed \`${JSON.stringify(proposed)}\`` : ''));
  lines.push('');
  if (proposed) {
    lines.push('## Predictive power (correlation with success)');
    for (const c of lib.COMPONENTS) {
      const p = analysis.predictive_detail[c];
      lines.push(`- **${c}:** ${p.power.toFixed(4)} (n=${p.n}, dir=${p.dir > 0 ? 'positive' : p.dir < 0 ? 'negative' : 'n/a'})`);
    }
    lines.push('');
    lines.push('## Interpretation');
    const sorted = lib.COMPONENTS.slice().sort((a, b) => analysis.predictive_powers[b] - analysis.predictive_powers[a]);
    const top = sorted[0];
    lines.push(`- **${top}** has the strongest predictive power this cycle — buyers who picked suppliers ranked high on ${top} succeeded more. The proposal shifts weight toward it (within ±0.15).`);
    const bottom = sorted[2];
    lines.push(`- **${bottom}** has the weakest predictive power — its contribution to routing success is the smallest. If it stays below 0.05 next cycle it becomes a removal candidate.`);
    if (removalFlags && removalFlags.length) {
      lines.push('');
      lines.push('## ⚠️ Removal candidates (2 consecutive cycles < 0.05)');
      for (const c of removalFlags) lines.push(`- **${c}** flagged for removal from the formula — see ` + '`tuning_history`' + ' for both cycles.');
    }
    lines.push('');
    lines.push('## New factor scan');
    lines.push('- No new factor (delivery latency, dispute rate, category patterns) is currently logged in `ranking_outcomes`. The `component_scores` column is in place so a new component can be added + analyzed once data lands. *(Proposal requires supporting data.)*');
  } else {
    lines.push('## Insufficient data');
    lines.push(`- Only ${sample} resolved outcomes in the last 90 days; the tuning job requires ${MIN_SAMPLE}. Current weights kept.`);
    lines.push('- No proposal written to `tuning_proposals`.');
  }
  lines.push('');
  lines.push('---');
  lines.push('*Operator-gated: `apply-weights.js --confirm` is the ONLY path that changes production weights, after operator approval of the proposal.*');
  fs.writeFileSync(file, lines.join('\n'));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('FATAL', String(e)); process.exit(1); });
}

module.exports = main;