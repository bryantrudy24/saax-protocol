// SAAX Protocol — Negative cases for the financial-lifecycle verifier.
//
// UPDATED (Gate D.2, Phase E): the verifier interface moved from
//   --provider-jwk=/--buyer-jwk=   (pre-closeout)
// to
//   --trust=<trust.json>           (current, closeout+)
// and the v1 export format ("real-sepolia-*-export.json") is now HISTORICAL:
// the verifier refuses to promote it to VERIFIED and returns
// "E_OLD_FORMAT_INCOMPLETE" (INCOMPLETE) for every input, by design —
// "Only discovery-financial-v2 is verifiable."
//
// This test therefore asserts the HISTORICAL-FORMAT BOUNDARY: every mutation
// of a v1 export (and the unmutated v1 export itself) must yield INCOMPLETE
// (--expect-incomplete -> exit 0), never VERIFIED. That the mutated fields
// (funding tx, custody, chain, amount, commitment id, buyer, evaluator, …)
// cannot be promoted is a meaningful regression assertion: a verifier bug
// that started treating v1 as verifiable (or that threw instead of returning
// the documented incomplete verdict) fails this test.
//
// Full v2 mutation coverage lives in tests/discovery-phase6/
// test-financial-export-negative.cjs (22 cases) — this suite complements it.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VERIFIER = path.join(ROOT, 'verifier', 'verify-financial-export.js');
const TRUST = path.join(ROOT, 'evidence', 'discovery-phase6', 'trust.json');
const RELEASE = path.join(ROOT, 'evidence', 'discovery-phase5', 'real-sepolia-release-export.json');
const REFUND = path.join(ROOT, 'evidence', 'discovery-phase5', 'real-sepolia-refund-export.json');

let passed = 0, failed = 0;
function runCase(name, exportObj, expectIncomplete) {
  const tmp = path.join(ROOT, '.output', 'neg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.json');
  fs.writeFileSync(tmp, JSON.stringify(exportObj, null, 2));
  const args = [VERIFIER, tmp, '--trust=' + TRUST];
  if (expectIncomplete) args.push('--expect-incomplete');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
  fs.unlinkSync(tmp);
  const ok = r.status === 0;
  const hasIncomplete = /VERDICT: INCOMPLETE/.test(r.stdout + r.stderr);
  if (ok && hasIncomplete) { passed++; console.log('[PASS] ' + name); }
  else { failed++; console.log('[FAIL] ' + name + ' (status=' + r.status + ' verdict=' + (hasIncomplete ? 'incomplete' : 'missing') + ')'); }
}

const release = JSON.parse(fs.readFileSync(RELEASE, 'utf8'));
const refund = JSON.parse(fs.readFileSync(REFUND, 'utf8'));

// Clean v1 exports must be INCOMPLETE (historical, not promoted).
runCase('clean v1 release export stays incomplete', release, true);
runCase('clean v1 refund export stays incomplete', refund, true);

// 1. substituted funding transaction (another commitment's tx)
runCase('substituted funding tx cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.funding.fundTx = '0x1111111111111111111111111111111111111111111111111111111111111111'; return x; })(), true);

// 2. wrong custody address in export
runCase('wrong custody address cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.custody = '0x1111111111111111111111111111111111111111'; x.custodyPin = '0x9999999999999999999999999999999999999999999999999999999999999999'; return x; })(), true);

// 3. wrong chain (claim 1 instead of 84532)
runCase('wrong chain cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.chainId = 1; return x; })(), true);

// 4. altered amount in export (funding.amount bumped)
runCase('altered amount cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.funding.amount = String(Number(x.funding.amount) + 1); return x; })(), true);

// 5. altered terms amount in the proposal
runCase('altered proposal terms amount cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.proposal.terms.amount = '999999'; return x; })(), true);

// 6. substituted commitment reference (commitmentId swapped)
runCase('substituted commitment id cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.commitment.commitmentId = '0x' + 'ab'.repeat(32); return x; })(), true);

// 7. forged release transaction (a random success tx — not a custody release)
runCase('forged terminal tx cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(refund)); x.refund.tx = '0x' + 'cd'.repeat(32); return x; })(), true);

// 8. verdict action mismatch (release export claims refund action)
runCase('verdict action mismatch cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.release.verdict.action = 'refund'; return x; })(), true);

// 9. tampered acceptance (buyer swapped)
runCase('substituted buyer cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.acceptance.buyer = '0x1111111111111111111111111111111111111111'; return x; })(), true);

// 10. tampered provider key (acceptance provider mismatch)
runCase('substituted provider cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(refund)); x.acceptance.provider.providerId = 'https://evil.example/'; return x; })(), true);

// 11. missing terminal receipt (empty tx)
runCase('missing terminal tx cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.release.tx = '0x' + '00'.repeat(32); return x; })(), true);

// 12. wrong evaluator in escrow bindings
runCase('substituted evaluator cannot be promoted', (() => { const x = JSON.parse(JSON.stringify(release)); x.funding.evaluator = '0x1111111111111111111111111111111111111111'; return x; })(), true);

console.log('\n===== NEGATIVE SUMMARY =====');
console.log('passed=' + passed + ' failed=' + failed);
process.exit(failed > 0 ? 1 : 0);
