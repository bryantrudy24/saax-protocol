// v3 tampering battery — proves the corrected verifier enforces the four
// evaluator bindings (agreement->evaluator, escrow->agreement, journal->agreement,
// verdict->escrow) with SPECIFIC rejection reasons, plus the positive
// attester != evaluator test. Re-runs every v2 case (baseline + 51 tampered)
// against the v3 baseline and full-lifecycle fixture.
//
// USAGE:
//   node scripts/v3-battery.cjs [--baseline <export.json>] [--fixture <full-lifecycle.json>] [--out <dir>]
//
// Defaults: baseline evidence/baseline-v3-verified-commitment.json
//           fixture  evidence/v3-battery/fixture-full-lifecycle.json
//           out      evidence/v3-battery
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
const BASE = path.resolve(argOf('--baseline', path.join(__dirname, '..', 'evidence', 'baseline-v3-verified-commitment.json')));
const FIXTURE = path.resolve(argOf('--fixture', path.join(__dirname, '..', 'evidence', 'v3-battery', 'fixture-full-lifecycle.json')));
const OUT = path.resolve(argOf('--out', path.join(__dirname, '..', 'evidence', 'v3-battery')));
fs.mkdirSync(OUT, { recursive: true });

const real = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(real));
const cloneFixture = () => JSON.parse(JSON.stringify(fixture));

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
    out = execFileSync(process.execPath, [V, p, '--rpc', RPC], { encoding: 'utf8', timeout: 120000 });
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
    + (failedChecks.length ? '  caught_by=[' + failedChecks.join(' | ').slice(0, 200) + ']' : ''));
  return { case: name, exit: code, verdict, checks, failedChecks, stdout: out };
}

// ---- case generators -------------------------------------------------------
const cases = {};

// [0] baseline (must VERIFY — issuance profile; attester != evaluator)
cases['case-00-baseline-v3'] = clone();

// ---- every v2 tamper case, re-run against the v3 baseline ------------------
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

// ---- the 11 previously-undetected defects, re-run against v3 ----------------
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
cases['case-41-downgrade-manifestVersion-to-v1'] = (() => { const e = clone(); e.agreement.manifestVersion = 1; return e; })();
cases['case-42-unsigned-manifestVersion-removed'] = (() => { const e = clone(); delete e.agreement.manifestVersion; return e; })();
cases['case-43-formatVersion-claim-v1-on-v3'] = (() => { const e = clone(); e.formatVersion = 1; return e; })();

// ---- omitted-field cases ------------------------------------------------------
cases['case-44-omitted-terms'] = (() => { const e = clone(); delete e.agreement.terms; return e; })();
cases['case-45-omitted-deadline'] = (() => { const e = clone(); delete e.agreement.deadline; return e; })();
cases['case-46-omitted-acceptanceCriteria'] = (() => { const e = clone(); delete e.agreement.acceptanceCriteria; return e; })();

// ---- conflicting-version cases ------------------------------------------------
cases['case-47-conflicting-version'] = (() => { const e = clone(); e.formatVersion = 1; e.agreement.manifestVersion = 3; return e; })();
cases['case-48-conflicting-version-reverse'] = (() => { const e = clone(); e.formatVersion = 3; e.agreement.manifestVersion = 1; return e; })();

// ---- cross-record substitution cases -------------------------------------------
cases['case-49-cross-record-anchor-substitution'] = (() => {
  const e = clone();
  const other = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-verified-commitment.json'), 'utf8'));
  e.anchor = Object.assign({}, e.anchor, { uid: other.anchor.uid, txHash: other.anchor.txHash, commitmentId: other.anchor.commitmentId, commitmentDigest: other.anchor.commitmentDigest });
  return e;
})();
cases['case-50-cross-record-journal-substitution'] = (() => {
  const e = clone();
  const other = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-verified-commitment.json'), 'utf8'));
  e.journal = JSON.parse(JSON.stringify(other.journal));
  return e;
})();
cases['case-51-cross-record-signature-substitution'] = (() => {
  const e = clone();
  const other = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-verified-commitment.json'), 'utf8'));
  e.authorizations = JSON.parse(JSON.stringify(other.authorizations));
  return e;
})();

// ---- v3 evaluator binding cases (Item 8) --------------------------------------
// Evaluator substitution — agreement: change the agreement's digest-covered
// evaluator -> digest mismatch (the tampered evaluator is not authenticated).
cases['case-60-evaluator-substitution-agreement'] = (() => { const e = clone(); e.agreement.evaluator = '0x1111111111111111111111111111111111111111'; return e; })();
// Evaluator substitution — escrow: change the escrow's evaluator to a different
// address -> escrow-agreement mismatch.
cases['case-61-evaluator-substitution-escrow'] = (() => {
  const e = cloneFixture();
  if (e.escrow) e.escrow.evaluator = '0x2222222222222222222222222222222222222222';
  return e;
})();
// Evaluator substitution — journal: a consequential event signed by a different
// key -> authority mismatch. (Change the journal evaluator field to a different
// address — the journal binding then fails against the agreement evaluator.)
cases['case-62-evaluator-substitution-journal'] = (() => { return JSON.parse(fs.readFileSync(path.join(OUT, 'fixture-eval-sub-journal.json'), 'utf8')); })();
// Evaluator substitution — verdict: change the verdict's evaluator (its signer)
// -> authority mismatch; the verdict no longer shows the digest-covered evaluator.
cases['case-63-evaluator-substitution-verdict'] = (() => {
  const e = cloneFixture();
  if (e.escrow && e.escrow.releaseVerdict && e.escrow.releaseVerdict.verdict) {
    e.escrow.releaseVerdict.verdict.sig = { v: 27, r: '0x' + '44'.repeat(32), s: '0x' + '55'.repeat(32) };
  }
  return e;
})();
// Permitted decision violation: a verdict action outside evaluatorPermittedDecisions.
cases['case-64-permitted-decision-violation'] = (() => {
  const e = cloneFixture();
  if (e.escrow && e.escrow.releaseVerdict && e.escrow.releaseVerdict.verdict) {
    e.escrow.releaseVerdict.verdict.action = 'steal_funds';
    e.escrow.releaseVerdict.verdict.sig = null;
  }
  return e;
})();
// Verdict binding failure: verdict references a DIFFERENT commitment/digest/escrow.
cases['case-65-verdict-binding-failure'] = (() => {
  const e = cloneFixture();
  if (e.escrow && e.escrow.releaseVerdict && e.escrow.releaseVerdict.verdict) {
    const v = e.escrow.releaseVerdict.verdict;
    v.commitmentId = '0x' + '77'.repeat(32);
    v.commitmentDigest = '0x' + '88'.repeat(32);
    v.escrowRef = 'escrow-v3-different-commitment';
  }
  return e;
})();
// Positive test: attester != evaluator. The v3 baseline itself has distinct
// attester (0x59B41A...) and evaluator (0x04867F...) addresses and MUST verify
// (case-00-baseline-v3) — this is the explicit named positive case.
cases['case-66-positive-attester-ne-evaluator'] = cloneFixture();

// ---- run -------------------------------------------------------------------
const results = {};
const order = Object.keys(cases).filter(n => cases[n]);
const skipped = Object.keys(cases).filter(n => !cases[n]);
for (const name of order) results[name] = run(name, cases[name]);

const everFailed = new Set();
for (const r of Object.values(results)) {
  for (const c of r.checks) if (c.result === 'fail') everFailed.add(c.name);
}

const baselineOk = results['case-00-baseline-v3'].verdict === 'VERIFIED';
const positiveOk = results['case-66-positive-attester-ne-evaluator'].verdict === 'VERIFIED';
const tampered = order.filter(n => !n.startsWith('case-00-') && !n.startsWith('case-66-'));
const allTamperedRejected = tampered.every(n => results[n].verdict === 'NOT VERIFIED');
const specificReason = tampered.filter(n => results[n].failedChecks.length > 0);
const genericReason = tampered.filter(n => results[n].failedChecks.length === 0 && results[n].verdict === 'NOT VERIFIED');

const summary = {
  baseline: BASE,
  fixture: FIXTURE,
  rpc: RPC,
  generatedAt: new Date().toISOString(),
  baselineVerified: baselineOk,
  positiveAttesterNeEvaluatorVerified: positiveOk,
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
fs.writeFileSync(path.join(OUT, 'v3-battery-summary.json'), JSON.stringify(summary, null, 2));

console.log('');
console.log('--- baseline VERIFIED: ' + baselineOk);
console.log('--- positive attester != evaluator VERIFIED: ' + positiveOk);
console.log('--- total cases: ' + order.length + ' (baseline + ' + tampered.length + ' tampered + positive)');
console.log('--- all tampered rejected: ' + allTamperedRejected);
console.log('--- specific-reason count: ' + specificReason.length);
console.log('--- generic-reason count: ' + genericReason.length);
console.log('--- VERIFIED on tampered (should be 0): ' + summary.verifiedOnTampered);
console.log('--- summary: ' + path.join(OUT, 'v3-battery-summary.json'));

process.exit(baselineOk && positiveOk && allTamperedRejected && summary.verifiedOnTampered === 0 ? 0 : 1);