// Re-run the preserved v1 defect artifacts under the corrected verifier.
// Item 7: each must return VERIFIED_WITH_LIMITATIONS (v1 path) or NOT VERIFIED
// (downgrade/unauthenticated-version path), never plain VERIFIED.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const V = 'verifier/verify-export.js';
const RPC = process.env.SAAX_VERIFY_RPC_URL || 'https://sepolia.base.org';
const dir = 'evidence/coverage-defects';

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'defects-summary.json').sort();
const results = [];
for (const f of files) {
  let out = '', code = -1;
  try {
    out = execFileSync(process.execPath, [V, path.join(dir, f), '--rpc', RPC], { encoding: 'utf8', timeout: 90000 });
    code = 0;
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : -1;
    out = String(e.stdout || '');
  }
  const fails = out.split(/\r?\n/).filter(l => l.startsWith('FAIL')).map(l => l.slice(7));
  const verdict = /VERDICT: VERIFIED_WITH_LIMITATIONS/.test(out) ? 'VERIFIED_WITH_LIMITATIONS'
    : (/VERDICT: VERIFIED/.test(out) ? 'VERIFIED' : 'NOT VERIFIED');
  results.push({ file: f, verdict, exit: code, fails });
  console.log(f.padEnd(48) + ' ' + verdict.padEnd(26) + ' exit=' + code
    + (fails.length ? ' | ' + fails.join('; ').slice(0, 140) : ''));
}

const bad = results.filter(r => r.verdict === 'VERIFIED');
console.log('');
console.log('artifacts processed: ' + results.length);
console.log('returned VERIFIED (defect): ' + bad.length);
console.log('returned VERIFIED_WITH_LIMITATIONS or NOT VERIFIED: ' + (results.length - bad.length));
fs.writeFileSync('evidence/v2-rerun/rerun-summary.json', JSON.stringify(results, null, 2));
console.log('wrote evidence/v2-rerun/rerun-summary.json');
process.exit(bad.length ? 1 : 0);
