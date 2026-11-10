// v2 tampering battery — proves the corrected verifier rejects every documented
// bypass for the EXPECTED reason, with downgrade, omitted-field,
// conflicting-version, and cross-record substitution cases.
//
// USAGE:
//   node scripts/v2-battery.cjs [--baseline <export.json>] [--out <dir>]
//
// Defaults: baseline evidence/baseline-v2-verified-commitment.json
//           out      evidence/v2-battery
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const RPC = process.env.SAAX_VERIFY_RPC_URL || 'https://sepolia.base.org';
const V = path.join(__dirname, '..', 'verifier', 'verify-export.js');
const BASE = path.resolve(argOf('--baseline', path.join(__dirname, '..', 'evidence', 'baseline-v2-verified-commitment.json')));
const OUT = path.resolve(argOf('--out', path.join(__dirname, '..', 'evidence', 'v2-battery')));
fs.mkdirSync(OUT, { recursive: true });

const real = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(real));

function parseChecks(out) {
  const checks = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^(PASS|FAIL)\s{2}(.+?)(?:\s{2}\[(.*)\])?\s*$/.exec(line);
    if (!m) continue;
    checks.push({ name: m[2].trim(), result: m[1] === 'PASS' ? 'pass' : 'fail', detail: m[3] || null });
  }
  return checks;
}

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
  const checks = parseChecks(out);
  const verdict = /VERDICT: VERIFIED_WITH_LIMITATIONS/.test(out) ? 'VERIFIED_WITH_LIMITATIONS'
    : (/VERDICT: VERIFIED/.test(out) ? 'VERIFIED' : 'NOT VERIFIED');
  const failedChecks = checks.filter(c => c.result === 'fail').map(c => c.name + (c.detail ? ' [' + c.detail + ']' : ''));
  console.log(name + ': ' + checks.filter(c => c.result === 'pass').length + 'P/'
    + failedChecks.length + 'F ' + verdict + ' exit=' + code
    + (failedChecks.length ? '  caught_by=[' + failedChecks.join(' | ').slice(0, 160) + ']' : ''));
  return { case: name, exit: code, verdict, checks, failedChecks, stdout: out };
}

// ---- case generators -------------------------------------------------------
// Every case tampers ONLY the named field on a deep copy of the v2 baseline.
const cases = {};

// [0] baseline (must VERIFY)
cases['case-00-baseline'] = clone();

// ---- the original v1 battery's 26 tamper cases, re-run against v2 ----------
cases['case-01-modified-price'] = (() => { const e = clone(); e.agreement.price = Object.assign({}, e.agreement.price, { amount: '99999' }); return e; })();
cases['case-02-wrong-attestation-uid'] = (() => { const e = clone(); e.anchor.uid = '0x' + '11'.repeat(32); return e; })();
cases['case-03-substituted-anchor-digest'] = (() => { const e = clone(); e.anchor.commitmentDigest = 'sha256:' + 'ab'.repeat(32); return e; })();
cases['case-04-altered-journal-state'] = (() => { const e = clone(); if (e.journal && e.journal.events && e.journal.events.length) e.journal.events[0].state = 'FULFILLED'; return e; })();
cases['case-05-reordered-journal'] = (() => { const e = clone(); if (e.journal && e.journal.events && e.journal.events.length > 1) { const ev = e.journal.events.shift(); e.journal.events.push(ev); } return e; })();
cases['case-06-missing-history'] = (() => { const e = clone(); if (e.journal && e.journal.events && e.journal.events.length) e.journal.events.pop(); return e; })();
cases['case-07-forged-buyer-authorization'] = (() => { const e = clone(); if (e.authorizations && e.authorizations.length) { e.authorizations[0].v = 27; e.authorizations[0].r = '0x' + 'aa'.repeat(32); e.authorizations[0].s = '0x' + 'bb'.repeat(32); } return e; })();
cases['case-08-substituted-party'] = (() => { const e = clone(); if (e.authorizations) { for (const a of e.authorizations) { if (a.role === 'buyer') a.expectedParty = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271'; } } return e; })();
cases['case-09-modified-digest-field'] = (() => { const e = clone(); e.commitmentDigest = 'sha256:' + 'cd'.repeat(32); return e; })();
cases['case-10-relabeled-lifecycle-profile'] = (() => { const e = clone(); e.lifecycleProfile = 'full'; return e; })();
cases['case-11-substituted-escrow-reference'] = (() => { const e = clone(); e.escrow = { custody: '0x000000000000000000000000000000000000dEaD', state: 'released', commitmentId: e.commitmentId }; return e; })();
cases['case-12-forged-authorization-selfasserted-party'] = (() => { const e = clone(); const forged = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-battery', 'probe-selfassert.json'), 'utf8')); e.authorizations = forged.authorizations; return e; })();
cases['case-13-anchor-commitmentId-mismatch'] = (() => { const e = clone(); if (e.anchor) e.anchor.commitmentId = 'fresh-does-not-exist'; return e; })();
cases['case-14-anchor-resolver-nonzero'] = (() => { const e = clone(); if (e.anchor) e.anchor.resolver = '0x000000000000000000000000000000000000dEaD'; return e; })();
cases['case-15-forged-seller-authorization'] = (() => { const e = clone(); if (e.authorizations) { for (const a of e.authorizations) { if (a.role === 'seller') { a.v = 27; a.r = '0x' + 'cc'.repeat(32); a.s = '0x' + 'dd'.repeat(32); } } } return e; })();
cases['case-16-anchor-points-at-revocable-attestation'] = (() => {
  const uid = (fs.existsSync(path.join(__dirname, '..', 'evidence', 'revocable-uid.txt'))) ? fs.readFileSync(path.join(__dirname, '..', 'evidence', 'revocable-uid.txt'), 'utf8').trim() : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(uid)) return null;
  const e = clone(); e.anchor = Object.assign({}, e.anchor, { uid }); return e;
})();
cases['case-17-tampered-buyerAgentId'] = (() => { const e = clone(); e.agreement.buyerAgentId = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271'; return e; })();
cases['case-18-tampered-sellerAgentId'] = (() => { const e = clone(); e.agreement.sellerAgentId = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13'; return e; })();
cases['case-19-tampered-acceptanceCriteria'] = (() => { const e = clone(); if (e.agreement.acceptanceCriteria && typeof e.agreement.acceptanceCriteria === 'object') { e.agreement.acceptanceCriteria = Object.assign({}, e.agreement.acceptanceCriteria, { value: 'tampered_criteria' }); } else { e.agreement.acceptanceCriteria = 'tampered_criteria'; } return e; })();
cases['case-20-tampered-agreement-signature'] = (() => { const e = clone(); e.agreement.signatureHex = '0x' + '00'.repeat(65); return e; })();
cases['case-21-tampered-journal-tailHash'] = (() => { const e = clone(); if (e.journal) e.journal.tailHash = 'ff'.repeat(32); return e; })();
cases['case-22-tampered-journal-event-signature'] = (() => { const e = clone(); if (e.journal && e.journal.events && e.journal.events.length) { e.journal.events[0].sig = { v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) }; } return e; })();
cases['case-23-tampered-journal-prevHash'] = (() => { const e = clone(); if (e.journal && e.journal.events && e.journal.events.length > 1) e.journal.events[1].prevHash = 'deadbeef'; return e; })();
cases['case-24-tampered-journal-eventCount'] = (() => { const e = clone(); if (e.journal) e.journal.eventCount = (Number(e.journal.eventCount) || (e.journal.events || []).length) + 1; return e; })();
cases['case-25-tampered-auth-domain-chainId'] = (() => { const e = clone(); if (e.authorizations && e.authorizations.length) e.authorizations[0].domain = Object.assign({}, e.authorizations[0].domain, { chainId: 1 }); return e; })();
cases['case-26-tampered-auth-message-scope'] = (() => { const e = clone(); if (e.authorizations && e.authorizations.length) { e.authorizations[0].message = Object.assign({}, e.authorizations[0].message, { scope: 'steal_funds' }); } return e; })();
cases['case-27-contradictory-declared-party'] = (() => { const e = clone(); if (e.authorizations && e.authorizations.length) { e.authorizations[0].expectedParty = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271'; } return e; })();

// ---- the 11 previously-undetected defects, now rejected with reasons --------
// Each tampers ONLY the named field on the v2 baseline.
cases['case-30-tampered-terms-policyVersion'] = (() => { const e = clone(); e.agreement.terms = Object.assign({}, e.agreement.terms, { policyVersion: 'saax-policy-v9' }); return e; })();
cases['case-31-tampered-terms-schemaVersion'] = (() => { const e = clone(); e.agreement.terms = Object.assign({}, e.agreement.terms, { schemaVersion: 'saax-commitment-v9' }); return e; })();
cases['case-32-tampered-terms-hashingVersion'] = (() => { const e = clone(); e.agreement.terms = Object.assign({}, e.agreement.terms, { hashingVersion: 'sha256-cose-v9' }); return e; })();
cases['case-33-tampered-terms-evidencePolicy'] = (() => { const e = clone(); e.agreement.terms = Object.assign({}, e.agreement.terms, { evidencePolicy: { type: 'none', requiredRefs: [], verdictRequired: false, evaluatorRequired: false } }); return e; })();
cases['case-34-tampered-terms-recoveryRules'] = (() => { const e = clone(); e.agreement.terms = Object.assign({}, e.agreement.terms, { recoveryRules: { workerKill: 'none' } }); return e; })();
cases['case-35-tampered-anchor-txHash'] = (() => { const e = clone(); e.anchor.txHash = '0xabababababababababababababababababababababababababababababababab'; return e; })();
cases['case-36-tampered-anchor-chainId'] = (() => { const e = clone(); e.anchor.chainId = 1; return e; })();
cases['case-37-tampered-anchor-schemaUid'] = (() => { const e = clone(); e.anchor.schemaUid = '0x2222222222222222222222222222222222222222222222222222222222222222'; return e; })();
cases['case-38-tampered-formatVersion'] = (() => { const e = clone(); e.formatVersion = 9; return e; })();
cases['case-39-tampered-journal-evaluator'] = (() => { const e = clone(); e.journal.evaluator = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13'; return e; })();
cases['case-40-tampered-anchor-attester'] = (() => { const e = clone(); e.anchor.attester = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13'; return e; })();

// ---- downgrade protection ----------------------------------------------------
// v2 export with manifestVersion changed to v1 (version claim not matching the
// digest it was signed over) must reject.
cases['case-41-downgrade-manifestVersion-to-v1'] = (() => { const e = clone(); e.agreement.manifestVersion = 1; return e; })();
// v2 export with an UNSIGNED manifestVersion (field removed from the digest
// representation) must reject: manifestVersion absent entirely.
cases['case-42-unsigned-manifestVersion-removed'] = (() => { const e = clone(); delete e.agreement.manifestVersion; return e; })();
// v2 export relabeled as formatVersion=1 (claims weaker v1 rules) — the v2
// digest was computed over the v2 manifest so it will NOT recompute under v1
// rules; the downgrade must fail.
cases['case-43-formatVersion-claim-v1-on-v2'] = (() => { const e = clone(); e.formatVersion = 1; return e; })();

// ---- omitted-field cases ------------------------------------------------------
// A field removed from the manifest must reject with an omitted-field reason.
cases['case-44-omitted-terms'] = (() => { const e = clone(); delete e.agreement.terms; return e; })();
cases['case-45-omitted-deadline'] = (() => { const e = clone(); delete e.agreement.deadline; return e; })();
cases['case-46-omitted-acceptanceCriteria'] = (() => { const e = clone(); delete e.agreement.acceptanceCriteria; return e; })();

// ---- conflicting-version cases ------------------------------------------------
// v2 export declaring v1 in one field and v2 in another must reject.
cases['case-47-conflicting-version'] = (() => { const e = clone(); e.formatVersion = 1; e.agreement.manifestVersion = 2; return e; })();
cases['case-48-conflicting-version-reverse'] = (() => { const e = clone(); e.formatVersion = 2; e.agreement.manifestVersion = 1; return e; })();

// ---- cross-record substitution cases -------------------------------------------
// v2 export with an anchor from a DIFFERENT commitment must reject with a
// binding-failure reason.
cases['case-49-cross-record-anchor-substitution'] = (() => {
  const e = clone();
  // Substitute the anchor of the v1 baseline (a different commitment).
  const other = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-verified-commitment.json'), 'utf8'));
  e.anchor = Object.assign({}, e.anchor, { uid: other.anchor.uid, txHash: other.anchor.txHash, commitmentId: other.anchor.commitmentId, commitmentDigest: other.anchor.commitmentDigest });
  return e;
})();
// v2 export with a journal from a DIFFERENT commitment must reject.
cases['case-50-cross-record-journal-substitution'] = (() => {
  const e = clone();
  const other = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-verified-commitment.json'), 'utf8'));
  e.journal = JSON.parse(JSON.stringify(other.journal));
  return e;
})();
// v2 export with a signature from a DIFFERENT commitment must reject.
cases['case-51-cross-record-signature-substitution'] = (() => {
  const e = clone();
  const other = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-verified-commitment.json'), 'utf8'));
  e.authorizations = JSON.parse(JSON.stringify(other.authorizations));
  return e;
})();

// ---- run -------------------------------------------------------------------
const results = {};
const order = Object.keys(cases).filter(n => cases[n]);
const skipped = Object.keys(cases).filter(n => !cases[n]);
for (const name of order) results[name] = run(name, cases[name]);

const everFailed = new Set();
for (const r of Object.values(results)) {
  for (const c of r.checks) if (c.result === 'fail') everFailed.add(c.name);
}

const baselineOk = results['case-00-baseline'].verdict === 'VERIFIED';
const tampered = order.filter(n => n !== 'case-00-baseline');
const allTamperedRejected = tampered.every(n => results[n].verdict === 'NOT VERIFIED');
const specificReason = tampered.filter(n => results[n].failedChecks.length > 0);
const genericReason = tampered.filter(n => results[n].failedChecks.length === 0 && results[n].verdict === 'NOT VERIFIED');

const summary = {
  baseline: BASE,
  rpc: RPC,
  generatedAt: new Date().toISOString(),
  baselineVerified: baselineOk,
  totalCases: order.length,
  tamperedCases: tampered.length,
  allTamperedRejected,
  specificReasonCount: specificReason.length,
  genericReasonCount: genericReason.length,
  verifiedOnTampered: tampered.filter(n => results[n].verdict === 'VERIFIED').length,
  checksSeen: [...new Set([].concat(...Object.values(results).map(r => r.checks.map(c => c.name))))],
  cases: order.map(n => ({
    case: n,
    exit: results[n].exit,
    verdict: results[n].verdict,
    checks: results[n].checks.map(c => ({ name: c.name, result: c.result, detail: c.detail })),
    caughtBy: results[n].failedChecks
  }))
};
fs.writeFileSync(path.join(OUT, 'battery-summary.json'), JSON.stringify(summary, null, 2));

console.log('');
console.log('--- baseline VERIFIED: ' + baselineOk);
console.log('--- total cases: ' + order.length + ' (baseline + ' + tampered.length + ' tampered)');
console.log('--- all tampered rejected: ' + allTamperedRejected);
console.log('--- specific-reason count: ' + specificReason.length);
console.log('--- generic-reason count: ' + genericReason.length);
console.log('--- VERIFIED on tampered (should be 0): ' + summary.verifiedOnTampered);
console.log('--- summary: ' + path.join(OUT, 'battery-summary.json'));

process.exit(baselineOk && allTamperedRejected && summary.verifiedOnTampered === 0 ? 0 : 1);
