// Cross-process nonce-reservation test: two separate OS processes (each with
// their own D1Worker + own in-memory nonce counter) prepare operations for the
// SAME relayer account against the SAME sqlite store. The store's UNIQUE
// nonce_reservations constraint must guarantee no conflicting nonce usage even
// though each process would otherwise hand out the same nonce 0.
//
// Spawned via: node scripts/test-d1-cross-process.cjs spawn <dbpath> <opId>
// Orchestrated by the parent below.

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const WORKER_SNIPPET = `
(async () => {
  const path = require('node:path');
  const { D1Worker } = require(path.join(process.cwd(), 'worker', 'd1-worker.js'));
  const { loadCustodyAbi } = require(path.join(process.cwd(), 'worker', 'd1-abi.js'));
  const { Wallet } = require('ethers');
  const dbPath = process.argv[1];
  const opId = process.argv[2];
  const chain = { id: 31337, custody: '0x5a5472d751839cd4968cbf1b136baf862279ff5d' };
  // In-memory nonce counter: BOTH processes would hand out nonce 0 first.
  let next = 0;
  const w = new D1Worker({
    storePath: dbPath, abi: loadCustodyAbi(), chain,
    prereqs: { validatePrerequisites: async () => ({ ok: true, state: 'PERMITTED' }) },
    nextNonce: async () => { const n = next; next += 1; return n; },
    relayer: { account: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', wallet: new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d') },
  });
  const r = await w.prepare({
    opId, payloadDigest: 'sha256:' + 'a'.repeat(64), agreementRef: 'agr', escrowId: 'esc-' + opId,
    requestedAction: 'release', authNonce: 'n-' + opId, authRole: 'evaluator', authExpiry: Date.now() + 60000,
    actionArgs: { commitmentId: '0x' + '11'.repeat(32), commitmentDigest: '0x' + '22'.repeat(32), nonce: 1, issuedAt: Date.now(), v: 27, r: '0x' + '33'.repeat(32), s: '0x' + '44'.repeat(32), sigBytes: '0x' },
    bindings: {},
  });
  console.log('RESULT ' + opId + ' ok=' + r.ok + ' nonce=' + (r.tx ? r.tx.nonce : 'n/a') + ' reason=' + (r.reason || ''));
  process.exit(0);
})();
`;

function runChild(dbPath, opId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', WORKER_SNIPPET, dbPath, opId], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve({ out: out.trim(), code }));
  });
}

async function main() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd1-xproc-')), 's.sqlite');
  // Launch both children simultaneously; each would pick nonce 0 from its own counter.
  const [a, b] = await Promise.all([
    runChild(dbPath, 'xproc-A'),
    runChild(dbPath, 'xproc-B'),
  ]);
  console.log(a.out);
  console.log(b.out);
  const okA = a.out.includes('ok=true');
  const okB = b.out.includes('ok=true');
  const nonceA = /nonce=(\d+)/.exec(a.out);
  const nonceB = /nonce=(\d+)/.exec(b.out);
  const nA = nonceA ? Number(nonceA[1]) : -1;
  const nB = nonceB ? Number(nonceB[1]) : -1;
  let failed = 0;
  if (!(okA && okB)) { console.log('FAIL xproc both ops should prepare'); failed++; }
  else if (nA === nB) { console.log('FAIL xproc nonces must differ (store UNIQUE enforced) got ' + nA + '=' + nB); failed++; }
  else { console.log('PASS xproc nonces distinct across processes (' + nA + ' vs ' + nB + ')'); }
  // Also verify both prepared records exist (each op has exactly one prepared action)
  const { D1Store } = require('../worker/d1-store.js');
  const store = new D1Store(dbPath);
  const prep = store.listPrepared();
  const ids = prep.map((p) => p.opId).sort();
  if (ids.join(',') === 'xproc-A,xproc-B') { console.log('PASS xproc exactly one prepared action per op'); }
  else { console.log('FAIL xproc prepared ids: ' + ids.join(',')); failed++; }
  store.close();
  console.log('----');
  console.log('XPROC passed=' + (2 - failed) + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL ' + e.stack); process.exit(2); });