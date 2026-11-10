// Phase 2 — Tampering battery against the fresh passing baseline
// (evidence/fresh-commitment-live2.json). Runs the standalone verifier on
// copies of the verified export with each tamper class applied, asserting
// NOT VERIFIED / exit 1 for every tampered case and VERIFIED / exit 0 for the
// unmodified baseline.
//
// USAGE: node scripts/day20-tamper-battery.cjs
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RPC = 'https://sepolia.base.org';
const V = path.join(__dirname, '..', 'verifier', 'verify-export.js');
const BASE = path.join(__dirname, '..', 'evidence', 'fresh-commitment-live4.json');
const OUT = path.join(__dirname, '..', 'evidence', 'day20-battery');
fs.mkdirSync(OUT, { recursive: true });

const real = JSON.parse(fs.readFileSync(BASE, 'utf8'));

function run(name, exp) {
  const p = path.join(OUT, name + '.json');
  fs.writeFileSync(p, JSON.stringify(exp, null, 2));
  let code = -1, out = '';
  try {
    out = execFileSync(process.execPath, [V, p, '--rpc', RPC], { encoding: 'utf8', timeout: 90000 });
    code = 0;
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : -1;
    out = String(e.stdout || '');
  }
  const passes = (out.match(/PASS\s/g) || []).length;
  const fails = (out.match(/FAIL\s/g) || []).length;
  const verdict = /VERDICT: VERIFIED/.test(out) ? 'VERIFIED' : 'NOT VERIFIED';
  console.log(name + ': ' + passes + 'P/' + fails + 'F ' + verdict + ' exit=' + code);
  return { code, passes, fails, verdict, out };
}

// ---- tamper generators (all on deep copies) --------------------------------
const cases = {};
cases['case-00-baseline'] = JSON.parse(JSON.stringify(real));
cases['case-01-modified-terms'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  e.agreement.price = { amount: '99999', currency: 'USDC', decimals: 6 };
  return e;
})();
cases['case-02-wrong-attestation'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  e.anchor.uid = '0x' + '11'.repeat(32);
  return e;
})();
cases['case-03-substituted-anchor-digest'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  e.anchor.commitmentDigest = 'sha256:' + 'ab'.repeat(32);
  return e;
})();
cases['case-04-altered-journal'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  e.journal.events[0].state = 'FULFILLED';
  return e;
})();
cases['case-05-reordered-journal'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  const ev = e.journal.events.shift();
  e.journal.events.push(ev);
  return e;
})();
cases['case-06-missing-history'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  e.journal.events.pop();
  return e;
})();
cases['case-07-forged-authorization'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  // Substitute an unrelated signature (attacker's) for the buyer auth.
  e.authorizations[0].v = 27;
  e.authorizations[0].r = '0x' + 'aa'.repeat(32);
  e.authorizations[0].s = '0x' + 'bb'.repeat(32);
  return e;
})();
cases['case-08-wrong-expected-party'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  e.authorizations[0].expectedParty = '0x1111111111111111111111111111111111111111';
  return e;
})();
cases['case-09-modified-digest-field'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  e.agreement.deadline = new Date(Date.now() + 9999999999).toISOString();
  return e;
})();
cases['case-10-relabeled-profile'] = (() => {
  const e = JSON.parse(JSON.stringify(real));
  // An attacker relabels the issuance profile to 'full' — the verifier must
  // then require an escrow and fail (incomplete), not verify.
  e.lifecycleProfile = 'full';
  return e;
})();

const results = {};
let failures = 0;
for (const [n, e] of Object.entries(cases)) {
  const r = run(n, e);
  results[n] = r.code;
  const expect = (n === 'case-00-baseline') ? 0 : 1;
  if (r.code !== expect) {
    failures++;
    console.log('  *** UNEXPECTED: expected exit ' + expect + ' for ' + n);
    console.log(r.out.split('\n').slice(0, 14).join('\n'));
  }
}
fs.writeFileSync(path.join(OUT, 'battery-summary.json'), JSON.stringify(results, null, 2));
console.log('BATTERY_EXIT_UNEXPECTED=' + failures);
if (failures) process.exit(1);
console.log('ALL_TAMPER_CASES_REJECTED; BASELINE_VERIFIES');
process.exit(0);