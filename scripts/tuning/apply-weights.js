// SAAX Protocol — Sprint 2 Item 4: apply-weights.js (operator-gated)
//
// Applies an APPROVED weight proposal to the environment. This is the ONLY
// path that changes production weights, and it requires:
//   1. a proposal in saax_router.tuning_proposals with status='approved'
//      (the operator reviewed + approved it — the tuning job itself never
//      auto-applies), AND
//   2. the --confirm flag on the command line.
//
// What it does:
//   - reads the latest approved proposal from the DB
//   - validates it (guardrails re-checked: ±0.15 vs old weights, 0.1-0.7)
//   - updates .env (SAAX_W_REPUTATION / SAAX_W_FRESHNESS / SAAX_W_PRICE)
//   - sets process env so already-loaded modules see the new weights on next
//     require (rank-suppliers reads them at load; a server restart applies)
//   - marks the proposal status='applied' and tuning_history applied=true
//     for the matching run
//
// Run (from saax-protocol/): node --env-file=.env scripts/tuning/apply-weights.js --confirm
// Without --confirm: prints the pending/approved proposal and exits 1.
const fs = require('fs');
const path = require('path');
const lib = require('./tuning-lib.js');
const weights = require('../../endpoint/weights.js');

const ENV_FILE = path.join(__dirname, '..', '..', '.env');

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--confirm');
  const proposalId = args.find(a => a.startsWith('--proposal='));

  const client = lib.buildClient();

  // Find the proposal to apply: --proposal=<id>, else latest approved.
  let proposal;
  if (proposalId) {
    const id = proposalId.split('=')[1];
    const res = await client.from('tuning_proposals').select('*').eq('id', id);
    if (res.error) throw res.error;
    proposal = (res.data || [])[0];
  } else {
    // Latest approved proposal (minimal client: fetch recent, sort client-side).
    const res = await client.from('tuning_proposals').select('*').eq('status', 'approved').limit(20);
    if (res.error) throw res.error;
    const rows = (res.data || []).filter(r => r && r.status === 'approved');
    if (!rows.length) {
      console.log('NO APPROVED PROPOSAL FOUND. The tuning job writes pending proposals only.');
      console.log('Approve a proposal manually (UPDATE tuning_proposals SET status=\'approved\' WHERE id=...) then re-run with --confirm.');
      process.exit(1);
    }
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    proposal = rows[0];
  }

  if (!proposal) {
    console.log('PROPOSAL NOT FOUND.');
    process.exit(1);
  }

  console.log('=== SAAX Protocol — APPLY WEIGHTS (operator-gated) ===');
  console.log('proposal id:', proposal.id);
  console.log('old weights :', JSON.stringify(proposal.old_weights));
  console.log('new weights :', JSON.stringify(proposal.new_weights));
  console.log('sample size :', proposal.sample_size);
  console.log('status      :', proposal.status);

  if (proposal.status !== 'approved') {
    console.log('');
    console.log('NOT APPLIED: proposal status is "' + proposal.status + '" — must be "approved" (operator approval) before --confirm applies it.');
    process.exit(1);
  }

  if (!confirmed) {
    console.log('');
    console.log('NOT APPLIED: missing --confirm (operator confirmation flag).');
    console.log('Re-run with --confirm to write the new weights to .env and mark the proposal applied.');
    process.exit(1);
  }

  // Re-validate guardrails against the CURRENT weights (safety: the current
  // weights may have moved since the proposal was created).
  const current = weights.currentWeights();
  const guarded = lib.applyGuardrails(proposal.new_weights, current, { maxDelta: 0.15, minW: 0.1, maxW: 0.7 });
  const names = ['reputation', 'freshness', 'price'];
  let guardrailOk = true;
  for (const c of names) {
    if (Math.abs(guarded[c] - current[c]) > 0.15 + 1e-9) guardrailOk = false;
    if (guarded[c] < 0.1 - 1e-9 || guarded[c] > 0.7 + 1e-9) guardrailOk = false;
  }
  if (!guardrailOk) {
    console.log('NOT APPLIED: proposal violates guardrails against current weights:', JSON.stringify(guarded));
    process.exit(1);
  }

  // Write .env
  let env = '';
  try { env = fs.readFileSync(ENV_FILE, 'utf8'); } catch (_) {}
  const setLine = (key, val) => {
    const re = new RegExp('^' + key + '=.*$', 'm');
    if (re.test(env)) env = env.replace(re, key + '=' + val);
    else env += (env.endsWith('\n') ? '' : '\n') + key + '=' + val + '\n';
  };
  setLine('SAAX_W_REPUTATION', String(proposal.new_weights.reputation));
  setLine('SAAX_W_FRESHNESS', String(proposal.new_weights.freshness));
  setLine('SAAX_W_PRICE', String(proposal.new_weights.price));
  fs.writeFileSync(ENV_FILE, env);

  // Process env (so the next require sees the new weights).
  weights.applyWeightsToEnv(proposal.new_weights);

  // Mark proposal applied + history applied=true.
  const upd = await client.from('tuning_proposals').update({ status: 'applied', reviewed_at: new Date().toISOString(), reviewer: 'operator', notes: 'applied via apply-weights.js --confirm' }).eq('id', proposal.id);
  if (upd.error) console.log('WARN: could not mark proposal applied: ' + upd.error.message);
  const histRes = await client.from('tuning_history').select('id').limit(20);
  if (!histRes.error) {
    const rows = (histRes.data || []).filter(h => h && JSON.stringify(h.old_weights) === JSON.stringify(proposal.old_weights));
    rows.sort((a, b) => new Date(b.run_at) - new Date(a.run_at));
    const latest = rows[0];
    if (latest) {
      const hu = await client.from('tuning_history').update({ applied: true, status: 'applied', notes: 'applied via apply-weights.js --confirm' }).eq('id', latest.id);
      if (hu.error) console.log('WARN: could not mark tuning_history applied: ' + hu.error.message);
    }
  }

  console.log('');
  console.log('APPLIED. New weights written to .env and process env:');
  console.log('  SAAX_W_REPUTATION=' + proposal.new_weights.reputation);
  console.log('  SAAX_W_FRESHNESS=' + proposal.new_weights.freshness);
  console.log('  SAAX_W_PRICE=' + proposal.new_weights.price);
  console.log('NOTE: rank-suppliers/route-server read weights at load — restart the server for the change to take effect.');
  return proposal;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('FATAL', String(e)); process.exit(1); });
}

module.exports = main;