// Baseline battery — proves every verifier check has a real failure mode.
//
// Runs the STANDALONE verifier (fresh process, no SAAX DB) on an unmodified
// baseline export and on tampered copies of that same export. For each case it
// records the per-check structured results (name / result / reason) so a check
// that never fails can be identified as a defect.
//
// USAGE:
//   node scripts/baseline-battery.cjs [--baseline <export.json>] [--out <dir>]
//
// Defaults: baseline evidence/baseline-verified-commitment.json
//           out      evidence/baseline-battery
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
const BASE = path.resolve(argOf('--baseline', path.join(__dirname, '..', 'evidence', 'baseline-verified-commitment.json')));
const OUT = path.resolve(argOf('--out', path.join(__dirname, '..', 'evidence', 'baseline-battery')));
fs.mkdirSync(OUT, { recursive: true });

const real = JSON.parse(fs.readFileSync(BASE, 'utf8'));

// Parse the verifier's named PASS/FAIL lines into structured results.
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
  const verdict = /VERDICT: VERIFIED/.test(out) ? 'VERIFIED' : 'NOT VERIFIED';
  const failedChecks = checks.filter(c => c.result === 'fail').map(c => c.name);
  console.log(name + ': ' + checks.filter(c => c.result === 'pass').length + 'P/'
    + failedChecks.length + 'F ' + verdict + ' exit=' + code
    + (failedChecks.length ? '  caught_by=[' + failedChecks.join(' | ') + ']' : ''));
  return { case: name, exit: code, verdict, checks, failedChecks, stdout: out };
}

const clone = () => JSON.parse(JSON.stringify(real));

// ---- tamper generators (all on deep copies of the verified baseline) -------
const cases = {};
cases['case-00-baseline'] = clone();

cases['case-01-modified-terms'] = (() => {
  const e = clone();
  e.agreement.price = Object.assign({}, e.agreement.price, { amount: '99999' });
  return e;
})();

cases['case-02-wrong-attestation-uid'] = (() => {
  const e = clone();
  e.anchor.uid = '0x' + '11'.repeat(32);
  return e;
})();

cases['case-03-substituted-anchor-digest'] = (() => {
  const e = clone();
  e.anchor.commitmentDigest = 'sha256:' + 'ab'.repeat(32);
  return e;
})();

cases['case-04-altered-journal-state'] = (() => {
  const e = clone();
  if (e.journal && e.journal.events && e.journal.events.length) e.journal.events[0].state = 'FULFILLED';
  return e;
})();

cases['case-05-reordered-journal'] = (() => {
  const e = clone();
  if (e.journal && e.journal.events && e.journal.events.length > 1) {
    const ev = e.journal.events.shift();
    e.journal.events.push(ev);
  }
  return e;
})();

cases['case-06-missing-history'] = (() => {
  const e = clone();
  if (e.journal && e.journal.events && e.journal.events.length) e.journal.events.pop();
  return e;
})();

cases['case-07-forged-buyer-authorization'] = (() => {
  const e = clone();
  if (e.authorizations && e.authorizations.length) {
    e.authorizations[0].v = 27;
    e.authorizations[0].r = '0x' + 'aa'.repeat(32);
    e.authorizations[0].s = '0x' + 'bb'.repeat(32);
  }
  return e;
})();

cases['case-08-substituted-party'] = (() => {
  const e = clone();
  // Claim the buyer authorization was signed by a different party than the one
  // the digest-covered agreement names (the field the verifier actually reads).
  if (e.authorizations) {
    for (const a of e.authorizations) {
      if (a.role === 'buyer') a.expectedParty = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271';
    }
  }
  return e;
})();

cases['case-09-modified-digest-field'] = (() => {
  const e = clone();
  // The top-level canonical hash field is `commitmentDigest`.
  e.commitmentDigest = 'sha256:' + 'cd'.repeat(32);
  return e;
})();

// The forged-authorization case that exposed the verifier defect: an unrelated
// key signs the buyer authorization AND the export declares that attacker as
// the expected party. A verifier that trusts the self-declared field accepts it.
cases['case-12-forged-authorization-selfasserted-party'] = (() => {
  const e = clone();
  const forged = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'baseline-battery', 'probe-selfassert.json'), 'utf8'));
  e.authorizations = forged.authorizations;
  return e;
})();

// Exercises the three export-input checks that the earlier case set left
// unexercised (so they cannot be dismissed as no-ops).
cases['case-13-anchor-commitmentId-mismatch'] = (() => {
  const e = clone();
  if (e.anchor) e.anchor.commitmentId = 'fresh-does-not-exist';
  return e;
})();

cases['case-14-anchor-resolver-nonzero'] = (() => {
  // Declaring a non-zero resolver changes the recomputed schema UID, so the
  // on-chain schema can no longer match. Proves the derivation encodes the
  // ACTUAL resolver rather than hardcoding the zero-resolver packing.
  const e = clone();
  if (e.anchor) e.anchor.resolver = '0x000000000000000000000000000000000000dEaD';
  return e;
})();

cases['case-15-forged-seller-authorization'] = (() => {
  const e = clone();
  if (e.authorizations) {
    for (const a of e.authorizations) {
      if (a.role === 'seller') {
        a.v = 27;
        a.r = '0x' + 'cc'.repeat(32);
        a.s = '0x' + 'dd'.repeat(32);
      }
    }
  }
  return e;
})();

cases['case-16-anchor-points-at-revocable-attestation'] = (() => {
  // Points the anchor at a real, revocable attestation so the
  // `EAS anchor revocable=false` policy check has to fail. Skipped when no
  // revocable UID was resolved (then the case is simply absent).
  const uid = (fs.existsSync(path.join(__dirname, '..', 'evidence', 'revocable-uid.txt')))
    ? fs.readFileSync(path.join(__dirname, '..', 'evidence', 'revocable-uid.txt'), 'utf8').trim()
    : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(uid)) return null;
  const e = clone();
  e.anchor = Object.assign({}, e.anchor, { uid });
  return e;
})();

cases['case-10-relabeled-lifecycle-profile'] = (() => {
  const e = clone();
  e.lifecycleProfile = 'full';
  return e;
})();

cases['case-11-substituted-escrow-reference'] = (() => {
  const e = clone();
  if (e.escrow && typeof e.escrow === 'object') {
    e.escrow.custody = '0x000000000000000000000000000000000000dEaD';
    e.escrow.transactionHash = '0x' + 'ef'.repeat(32);
  } else {
    e.escrow = { custody: '0x000000000000000000000000000000000000dEaD', state: 'released', commitmentId: e.commitmentId };
  }
  return e;
})();

// ---- coverage extension: fields confirmed detectable by the gap probe ------
// Each tampers ONLY the named field on a deep copy of the verified baseline.

// agreement.buyerAgentId — the digest-covered party identity for the buyer role.
cases['case-17-tampered-buyerAgentId'] = (() => {
  const e = clone();
  e.agreement.buyerAgentId = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271';
  return e;
})();

// agreement.sellerAgentId — the digest-covered party identity for the seller role.
cases['case-18-tampered-sellerAgentId'] = (() => {
  const e = clone();
  e.agreement.sellerAgentId = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';
  return e;
})();

// agreement.acceptanceCriteria — part of the canonical manifest.
cases['case-19-tampered-acceptanceCriteria'] = (() => {
  const e = clone();
  if (e.agreement.acceptanceCriteria && typeof e.agreement.acceptanceCriteria === 'object') {
    e.agreement.acceptanceCriteria = Object.assign({}, e.agreement.acceptanceCriteria, { value: 'tampered_criteria' });
  } else {
    e.agreement.acceptanceCriteria = 'tampered_criteria';
  }
  return e;
})();

// agreement.signatureHex — the COSE envelope signature the digest is built over.
cases['case-20-tampered-agreement-signature'] = (() => {
  const e = clone();
  e.agreement.signatureHex = '0x' + '00'.repeat(65);
  return e;
})();

// journal.tailHash — the declared completeness boundary of the event chain.
cases['case-21-tampered-journal-tailHash'] = (() => {
  const e = clone();
  if (e.journal) e.journal.tailHash = 'ff'.repeat(32);
  return e;
})();

// journal.events[i].sig — the evaluator signature authenticating an event.
cases['case-22-tampered-journal-event-signature'] = (() => {
  const e = clone();
  if (e.journal && e.journal.events && e.journal.events.length) {
    e.journal.events[0].sig = { v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
  }
  return e;
})();

// journal.events[i].prevHash — the parent reference linking an event to its predecessor.
cases['case-23-tampered-journal-prevHash'] = (() => {
  const e = clone();
  if (e.journal && e.journal.events && e.journal.events.length > 1) e.journal.events[1].prevHash = 'deadbeef';
  return e;
})();

// journal.eventCount — declared count vs actual events (suffix-truncation guard).
cases['case-24-tampered-journal-eventCount'] = (() => {
  const e = clone();
  if (e.journal) e.journal.eventCount = (Number(e.journal.eventCount) || (e.journal.events || []).length) + 1;
  return e;
})();

// authorization domain.chainId — the EIP-712 signing domain a party bound to.
cases['case-25-tampered-auth-domain-chainId'] = (() => {
  const e = clone();
  if (e.authorizations && e.authorizations.length) e.authorizations[0].domain = Object.assign({}, e.authorizations[0].domain, { chainId: 1 });
  return e;
})();

// authorization message.scope — the signed authorization scope.
cases['case-26-tampered-auth-message-scope'] = (() => {
  const e = clone();
  if (e.authorizations && e.authorizations.length) {
    e.authorizations[0].message = Object.assign({}, e.authorizations[0].message, { scope: 'steal_funds' });
  }
  return e;
})();

// authorization expectedParty — a declaration that contradicts the agreement.
cases['case-27-contradictory-declared-party'] = (() => {
  const e = clone();
  if (e.authorizations && e.authorizations.length) {
    e.authorizations[0].expectedParty = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271';
  }
  return e;
})();

// ---- run -------------------------------------------------------------------
const results = {};
// A generator may return null when its precondition is unmet (e.g. no revocable
// attestation UID was discovered); such a case is omitted, never silently
// counted as a pass.
const order = Object.keys(cases).filter(n => cases[n]);
const skipped = Object.keys(cases).filter(n => !cases[n]);
for (const name of order) results[name] = run(name, cases[name]);

// Which checks NEVER failed across every tamper case? A check that cannot fail
// is a defect (it would pass regardless of input).
const everFailed = new Set();
const everPassed = new Set();
for (const r of Object.values(results)) {
  for (const c of r.checks) (c.result === 'fail' ? everFailed : everPassed).add(c.name);
}
const noOpSuspects = [...everPassed].filter(n => !everFailed.has(n));

const baselineOk = results['case-00-baseline'].verdict === 'VERIFIED';
const allTamperedRejected = order.filter(n => n !== 'case-00-baseline')
  .every(n => results[n].verdict === 'NOT VERIFIED');

const summary = {
  baseline: BASE,
  rpc: RPC,
  generatedAt: new Date().toISOString(),
  baselineVerified: baselineOk,
  allTamperedRejected,
  checksSeen: [...new Set([].concat(...Object.values(results).map(r => r.checks.map(c => c.name))))],
  checksThatFailedAtLeastOnce: [...everFailed].sort(),
  checksThatNeverFailed: noOpSuspects.sort(),
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
console.log('--- all tampered rejected: ' + allTamperedRejected);
console.log('--- checks seen: ' + summary.checksSeen.length);
console.log('--- checks that failed at least once: ' + summary.checksThatFailedAtLeastOnce.length);
console.log('--- checks that NEVER failed (no-op suspects): '
  + (noOpSuspects.length ? noOpSuspects.join(' | ') : 'none'));
console.log('--- summary: ' + path.join(OUT, 'battery-summary.json'));

process.exit(baselineOk && allTamperedRejected ? 0 : 1);
