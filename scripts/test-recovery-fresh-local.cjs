'use strict';
/**
 * Focused module-level recovery/restart test on a FRESH LOCAL ledger.
 *
 * Adapts the essential recovery cases from test-recovery-resume.cjs (which is
 * blocked on stale resolved Base Sepolia escrows) to a genuinely fresh local
 * ledger file, WITHOUT a public-chain dependency:
 *
 *   1. acceptOperation stores a durable accepted record (externalEffect null).
 *   2. PROCESS RESTART: a fresh child process (fresh module cache) loads the
 *      same ledger — the accepted record survives.
 *   3. Identical retry (same nonce + identical payload) returns the recorded
 *      result with idempotent:true — NO second logical acceptance, NO
 *      re-execution.
 *   4. Changed payload using the same nonce is rejected (conflict).
 *   5. Same operation under a new nonce is rejected as a duplicate (retry
 *      semantics contract: use the original nonce).
 *   6. reconcile sets externalEffect without re-executing; re-reconcile is
 *      idempotent (no duplicate execution).
 *
 * Runs each phase in a separate child process to simulate restart without app
 * DB or participant keys. No public RPC, no chain writes, no secrets.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(ROOT, 'data', 'test-fresh-recovery-ledger.json');
try { fs.unlinkSync(LEDGER); } catch (e) {}

let passed = 0, failed = 0;
function check(name, cond, detail) { if (cond) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); } }
function runChild(script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { SAAX_ESCROW_LEDGER: LEDGER }),
    });
    let out = '';
    p.stdout.on('data', b => { out += b; });
    p.stderr.on('data', b => { out += b; });
    p.on('error', reject);
    p.on('exit', code => resolve({ code, out }));
  });
}
async function writeScript(name, body) {
  fs.writeFileSync(path.join(__dirname, name), body);
}

(async () => {
  const PAYLOAD = {
    role: 'buyer', action: 'execute', commitmentDigest: '0x' + '22'.repeat(32),
    escrowId: '0x' + '22'.repeat(32), custody: '0x5a5472d751839cd4968cbf1b136baf862279ff5d',
    chainId: '84532', nonce: '128001', expiry: String(Math.floor(Date.now() / 1000) + 3600),
  };

  // Phase 1: accept + persist (child A)
  await writeScript('_reco-a-accept.cjs', `
'use strict';
const access = require('../endpoint/escrow-access');
const payload = ${JSON.stringify(PAYLOAD)};
const r = access.acceptOperation(payload, { recoveredSigner: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', channelRef: 'test' });
console.log('ACCEPT:' + JSON.stringify({ ok: r.ok, status: r.recorded && r.recorded.status, effect: r.recorded && r.recorded.externalEffect }));
process.exit(r.ok ? 0 : 1);
`);
  const a = await runChild('_reco-a-accept.cjs');
  check('phase1: operation durably accepted (externalEffect null)', a.code === 0 && /"status":"accepted"/.test(a.out) && /"effect":null/.test(a.out), a.out.trim());

  // Phase 2: RESTART — fresh child, same ledger (reload = process restart)
  await writeScript('_reco-b-after-restart.cjs', `
'use strict';
const access = require('../endpoint/escrow-access');
const payload = ${JSON.stringify(PAYLOAD)};
const recorded = access.getAccepted(payload.nonce);
const retry = access.acceptOperation(payload, null);
console.log('AFTER_RESTART:' + JSON.stringify({ recordedStatus: recorded && recorded.status, recordedEffect: recorded && recorded.externalEffect, retryOk: retry.ok, idempotent: retry.idempotent, returnedSameRecord: !!(retry.recorded && retry.recorded.nonce === payload.nonce && retry.recorded.payloadHash === recorded.payloadHash) }));
process.exit(retry.idempotent === true ? 0 : 1);
`);
  const b = await runChild('_reco-b-after-restart.cjs');
  check('phase2: restart — accepted record survives (durable)', b.code === 0 && /"recordedStatus":"accepted"/.test(b.out) && /"retryOk":false/.test(b.out) && /"idempotent":true/.test(b.out), b.out.trim());
  check('phase2: identical retry returns recorded result (no re-execute)', /"returnedSameRecord":true/.test(b.out), b.out.trim());

  // Phase 3: changed payload same nonce → conflict (child C)
  await writeScript('_reco-c-conflict.cjs', `
'use strict';
const access = require('../endpoint/escrow-access');
const changed = ${JSON.stringify(Object.assign({}, PAYLOAD, { action: 'request refund' }))};
const r = access.acceptOperation(changed, null);
console.log('CONFLICT:' + JSON.stringify({ ok: r.ok, conflict: r.conflict, reason: r.reason }, null, 0));
process.exit(r.conflict === true ? 0 : 1);
`);
  const c = await runChild('_reco-c-conflict.cjs');
  check('phase3: changed payload same nonce rejected (conflict)', c.code === 0 && /"conflict":true/.test(c.out) && /already consumed with a DIFFERENT payload/i.test(c.out), c.out.trim());

  // Phase 4: same operation under NEW nonce → duplicate (child D)
  await writeScript('_reco-d-duplicate.cjs', `
'use strict';
const access = require('../endpoint/escrow-access');
const dup = ${JSON.stringify(Object.assign({}, PAYLOAD, { nonce: '128002' }))};
const r = access.acceptOperation(dup, null);
console.log('DUP:' + JSON.stringify({ ok: r.ok, duplicate: r.duplicate, reason: r.reason }, null, 0));
process.exit(r.duplicate === true ? 0 : 1);
`);
  const d = await runChild('_reco-d-duplicate.cjs');
  check('phase4: same operation under a new nonce rejected (duplicate)', d.code === 0 && /"duplicate":true/.test(d.out) && /duplicate operation: same action\/digest\/escrow/i.test(d.out), d.out.trim());

  // Phase 5: reconcile sets externalEffect, idempotent re-reconcile (child E)
  await writeScript('_reco-e-reconcile.cjs', `
'use strict';
const access = require('../endpoint/escrow-access');
const outcome = { occurred: true, txHash: '0x' + 'aa'.repeat(32), block: '0x' + 'bb'.repeat(32), state: 'Released', at: Math.floor(Date.now() / 1000) };
const r1 = access.reconcile('128001', outcome);
const again = access.reconcile('128001', Object.assign({}, outcome, { state: 'Released-again' }));
const rec = access.getAccepted('128001');
console.log('RECONCILE:' + JSON.stringify({ status: rec.status, occurred: rec.externalEffect && rec.externalEffect.occurred, state: rec.externalEffect && rec.externalEffect.state, secondIdempotent: again && again.idempotent, secondState: again && again.recorded && again.recorded.externalEffect && again.recorded.externalEffect.state }, null, 0));
process.exit(rec.status === 'complete' && rec.externalEffect.occurred === true && again.idempotent === true ? 0 : 1);
`);
  const e = await runChild('_reco-e-reconcile.cjs');
  check('phase5: reconcile records external effect; re-reconcile idempotent', e.code === 0 && /"status":"complete"/.test(e.out) && /"occurred":true/.test(e.out) && /"secondState":"Released"/.test(e.out), e.out.trim());

  console.log('\nRESULT: ' + passed + '/' + (passed + failed) + ' PASS');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });