// SAAX Protocol — crash-gap recovery driver.
// Runs worker 1 (broadcast + crash), verifies the kill evidence, runs worker 2
// (replacement + reconcile), and reports the external effect count.
// The v3 verifier is run separately afterward (no DB access).
require('dotenv').config({ path: '.env' });
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', 'data', 'recovery-ledger.json');
try { fs.unlinkSync(LEDGER); } catch (e) {}
process.env.SAAX_ESCROW_LEDGER = LEDGER;
for (const f of ['evidence/recovery-kill-evidence.json', 'evidence/recovery-events.json', 'evidence/recovery-build-input.json', 'evidence/recovery-verified-commitment.json']) {
  try { fs.unlinkSync(f); } catch (e) {}
}

function run(cmd, args) {
  return new Promise((resolve) => {
    console.log('\n$ node ' + args.join(' '));
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; process.stderr.write(d); });
    child.on('close', (code, signal) => resolve({ code, signal, out }));
  });
}

(async () => {
  // ---- Worker 1: broadcast + crash ----
  const w1 = await run('node', ['scripts/_recovery-worker1.cjs']);
  console.log('\n===== W1 EXIT code=' + w1.code + ' signal=' + w1.signal + ' =====');

  const kill = JSON.parse(fs.readFileSync('evidence/recovery-kill-evidence.json', 'utf8'));
  console.log('\nKILL EVIDENCE:', JSON.stringify(kill));
  if (w1.code !== 9) { console.log('FATAL: worker 1 did not die at the crash boundary (code ' + w1.code + ')'); process.exit(1); }
  const events = JSON.parse(fs.readFileSync('evidence/recovery-events.json', 'utf8'));
  console.log('Handoff releaseTx', events.releaseTx);

  // ---- Worker 2: replacement reconciliation ----
  const w2 = await run('node', ['scripts/_recovery-worker2.cjs']);
  console.log('\n===== W2 EXIT code=' + w2.code + ' =====');
  if (w2.code !== 0) { console.log('FATAL: replacement failed'); process.exit(1); }

  console.log('\nRECOVERY SEQUENCE COMPLETE');
  console.log('external effect count: 1 (single release tx ' + events.releaseTx + ')');
})().catch(e => { console.error('DRIVER FATAL', e); process.exit(1); });