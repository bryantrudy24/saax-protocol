// Re-validation of the SAAX Custody V3 independent-review snapshot against the CURRENT repo state (HEAD 29ab8602).
// Task-owned addendum (2026-11-06): re-resolves every entry of 10-review-snapshot-manifest.json at its pinned
// revision and verifies it is unchanged at HEAD, recomputes SHA-256 + byte counts, and reports any drift.
// Usage: node review/f3c-candidate/scripts/_validate-snapshot-current.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST = path.join(ROOT, 'review', 'f3c-candidate', '10-review-snapshot-manifest.json');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

function gitShow(rev, file) {
  return execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
let keccakFn = null;
try { keccakFn = require(path.join(ROOT, 'node_modules', 'ethers')).keccak256; } catch (e) { /* keccak optional */ }

const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
let total = 0, ok = 0, fail = 0;
const issues = [];
const drift = [];

for (const [group, entries] of Object.entries(man.components)) {
  for (const [file, ent] of Object.entries(entries)) {
    total++;
    const rev = ent.revision;
    if (typeof rev !== 'string' || rev.startsWith('(working tree')) {
      const p = path.join(ROOT, file);
      const buf = fs.readFileSync(p);
      const h = sha256(buf);
      if (h === ent.sha256 && buf.length === ent.bytes) { ok++; } else { fail++; issues.push(`${file}: working-tree copy mismatch (${h} vs ${ent.sha256})`); }
      continue;
    }
    try {
      const pinnedBuf = Buffer.from(gitShow(rev, file), 'utf8');
      const pinnedSha = sha256(pinnedBuf);
      const headBuf = Buffer.from(gitShow(HEAD, file), 'utf8');
      const headSha = sha256(headBuf);
      const lenOk = pinnedBuf.length === ent.bytes;
      const shaOk = pinnedSha === ent.sha256;
      if (!lenOk || !shaOk) { fail++; issues.push(`${file} @ ${rev}: len ${pinnedBuf.length} (want ${ent.bytes}), sha ${pinnedSha} (want ${ent.sha256})`); }
      else ok++;
      if (headSha !== pinnedSha) drift.push(`${file}: HEAD bytes differ from pinned revision (drift)`);
    } catch (e) {
      fail++; issues.push(`${file} @ ${rev}: cannot resolve (${e.message})`);
    }
  }
}

const integrity = man.integrity || {};
let intOk = true;
try {
  const rs9066 = sha256(Buffer.from(gitShow('9066ace628cd96c569163830f3614e18b6eb0b2f', 'scripts/test-custody-v3-realsafe-candidate.cjs'), 'utf8'));
  const rs7c = sha256(Buffer.from(gitShow('7c26838b7709366ae032ccf6f80971692589ee37', 'scripts/test-custody-v3-realsafe-candidate.cjs'), 'utf8'));
  const bd7c = sha256(Buffer.from(gitShow('7c26838b7709366ae032ccf6f80971692589ee37', 'scripts/test-custody-v3-candidate-boundary.cjs'), 'utf8'));
  const src7c = sha256(Buffer.from(gitShow('7c26838b7709366ae032ccf6f80971692589ee37', 'contracts/SAAXEscrowCustodyV3.sol'), 'utf8'));
  const src2e = sha256(Buffer.from(gitShow('2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8', 'contracts/SAAXEscrowCustodyV3.sol'), 'utf8'));
  if (rs9066 !== integrity.realsafeHarness.at9066ace6 || rs7c !== integrity.realsafeHarness.at7c26838b) { intOk = false; issues.push('integrity: realsafe harness hash mismatch'); }
  if (bd7c !== integrity.boundaryHarness.at7c26838b) { intOk = false; issues.push('integrity: boundary harness hash mismatch'); }
  if (src7c !== src2e) { intOk = false; issues.push('integrity: candidate source changed between 2e49625b and 7c26838b'); }
} catch (e) { intOk = false; issues.push('integrity block check threw: ' + e.message); }

console.log(`HEAD=${HEAD}`);
console.log(`manifest-sha256=${sha256(fs.readFileSync(MANIFEST))}`);
console.log(`resolved=${total} ok=${ok} fail=${fail}`);
console.log(`integrity=${intOk ? 'OK' : 'FAIL'}`);
if (drift.length) { console.log('DRIFT-AT-HEAD:'); drift.forEach(d => console.log('  ' + d)); }
else console.log('drift-at-HEAD: none (all pinned revisions are ancestors of HEAD; files byte-identical at HEAD)');
if (issues.length) { console.log('ISSUES:'); issues.forEach(i => console.log('  ' + i)); }
process.exit(fail === 0 && intOk ? 0 : 1);
