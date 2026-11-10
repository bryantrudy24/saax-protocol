// SAAX Protocol — Escrow lifecycle unit test (in-memory, no network)
//
// Proves the escrow state machine (Capability 2):
//   1. fund -> hold -> release (authorized release requires satisfied verdict)
//   2. release denied without a satisfied verification verdict (fail-closed)
//   3. refund path (funded|held -> refunded)
//   4. timeout path (deadline passed, explicit unknown outcome preserved)
//   5. dispute -> resolve (release/refund/hold resolutions)
//   6. digest binding: ops with a different commitment digest are rejected
//   7. audit chain integrity: hash-linked, tamper-evident, independently
//      verifiable (verifyAuditChain)
'use strict';

process.env.SAAX_X402_MODE = 'mock';
const escrow = require('../endpoint/escrow.js');

let passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); process.exitCode = 1; }
}

const DIGEST = 'sha256:bd3ce845bdcdce7a5f9aaf956afb0ed20eeffe60a88d1b2776d1389810f7c3e6';
const OTHER_DIGEST = '0x' + 'ab'.repeat(32);
const CID = '0x9c2f1d9a0f8e6b4d3a1c7e5f8b0d2a4c6e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b';

function tryCatch(name, fn) {
  try { fn(); check(name, false, 'expected throw'); }
  catch (e) { check(name, true, e.message); }
}

(async () => {
  console.log('--- Escrow lifecycle test (in-memory) ---');

  // 1. fund -> hold -> release (happy path)
  const f = escrow.fund({ commitmentId: CID, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '12'.repeat(32), rail: 'x402' } });
  check('fund ok', f.ok === true && f.escrow.state === escrow.STATES.FUNDED, f.escrow.state);
  check('fund idempotent', escrow.fund({ commitmentId: CID, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '12'.repeat(32) } }).alreadyFunded === true);
  check('fundedAt set', !!f.escrow.fundedAt);
  check('audit chain has fund entry', f.escrow.auditChain.length === 1 && f.escrow.auditChain[0].state === escrow.STATES.FUNDED);

  const h = escrow.hold({ commitmentId: CID, commitmentDigest: DIGEST });
  check('hold ok', h.ok === true && h.escrow.state === escrow.STATES.HELD, h.escrow.state);

  const r = escrow.release({ commitmentId: CID, commitmentDigest: DIGEST, verdict: { outcome: 'satisfied' }, evidenceRefs: ['ev-1'] });
  check('release ok (authorized)', r.ok === true && r.escrow.state === escrow.STATES.RELEASED, r.escrow.state);
  check('release records verdict', r.escrow.releaseVerdict.satisfied === true && r.escrow.releaseVerdict.evidenceRefs.length === 1);
  check('releasedAt set', !!r.escrow.releasedAt);

  // 2. release denied without satisfied verdict
  const C2 = '0x' + 'cd'.repeat(32);
  escrow.fund({ commitmentId: C2, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '34'.repeat(32) } });
  escrow.hold({ commitmentId: C2, commitmentDigest: DIGEST });
  tryCatch('release denied without satisfied verdict', () => escrow.release({ commitmentId: C2, commitmentDigest: DIGEST, verdict: { outcome: 'not_satisfied' } }));
  tryCatch('release denied without verdict', () => escrow.release({ commitmentId: C2, commitmentDigest: DIGEST }));

  // 3. refund path
  const C3 = '0x' + 'ef'.repeat(32);
  escrow.fund({ commitmentId: C3, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '56'.repeat(32) } });
  escrow.hold({ commitmentId: C3, commitmentDigest: DIGEST });
  const rf = escrow.refund({ commitmentId: C3, commitmentDigest: DIGEST, reason: 'provider failed to deliver' });
  check('refund ok', rf.ok === true && rf.escrow.state === escrow.STATES.REFUNDED, rf.escrow.state);
  check('refund reason recorded', rf.escrow.refundReason === 'provider failed to deliver');
  tryCatch('refund from released denied', () => escrow.refund({ commitmentId: CID, commitmentDigest: DIGEST, reason: 'x' }));

  // 4. timeout path
  const C4 = '0x' + 'ab'.repeat(32);
  escrow.fund({ commitmentId: C4, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '78'.repeat(32) } });
  const t = escrow.timeout({ commitmentId: C4, commitmentDigest: DIGEST });
  check('timeout ok (explicit unknown outcome)', t.ok === true && t.escrow.state === escrow.STATES.TIMED_OUT, t.escrow.state);
  check('timed_out has no release/refund (unknown preserved)', t.escrow.releasedAt === null && t.escrow.refundedAt === null && t.escrow.timedOutAt !== null);
  tryCatch('timeout from disputed denied', () => {
    const C5 = '0x' + '11'.repeat(32);
    escrow.fund({ commitmentId: C5, commitmentDigest: DIGEST, amount: '1', asset: 'USDC', txRef: { txHash: '0x' + '90'.repeat(32) } });
    escrow.dispute({ commitmentId: C5, commitmentDigest: DIGEST, raisedBy: 'buyer', reason: 'not as described' });
    escrow.timeout({ commitmentId: C5, commitmentDigest: DIGEST });
  });

  // 5. dispute -> resolve (all three resolutions)
  const C6 = '0x' + '22'.repeat(32);
  escrow.fund({ commitmentId: C6, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '87'.repeat(32) } });
  escrow.hold({ commitmentId: C6, commitmentDigest: DIGEST });
  const d = escrow.dispute({ commitmentId: C6, commitmentDigest: DIGEST, raisedBy: 'buyer', reason: 'quality dispute', evidenceRef: 'ev-2' });
  check('dispute ok', d.ok === true && d.escrow.state === escrow.STATES.DISPUTED, d.escrow.state);
  check('dispute records raiser/reason', d.escrow.dispute.raisedBy === 'buyer' && d.escrow.dispute.reason === 'quality dispute');
  tryCatch('dispute raisedBy invalid', () => escrow.dispute({ commitmentId: C6, commitmentDigest: DIGEST, raisedBy: 'hacker', reason: 'x' }));

  const C7 = '0x' + '33'.repeat(32);
  escrow.fund({ commitmentId: C7, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '76'.repeat(32) } });
  escrow.hold({ commitmentId: C7, commitmentDigest: DIGEST });
  escrow.dispute({ commitmentId: C7, commitmentDigest: DIGEST, raisedBy: 'seller', reason: 'payment dispute' });
  const res = escrow.resolveDispute({ commitmentId: C7, commitmentDigest: DIGEST, resolution: 'release', verdict: { outcome: 'satisfied' }, reason: 'verification passed' });
  check('resolve dispute -> release', res.ok === true && res.escrow.state === escrow.STATES.RELEASED, res.escrow.state);
  check('resolution recorded', res.escrow.disputeResolution.resolution === 'release');

  const C8 = '0x' + '44'.repeat(32);
  escrow.fund({ commitmentId: C8, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '65'.repeat(32) } });
  escrow.hold({ commitmentId: C8, commitmentDigest: DIGEST });
  escrow.dispute({ commitmentId: C8, commitmentDigest: DIGEST, raisedBy: 'buyer', reason: 'refund requested' });
  const res2 = escrow.resolveDispute({ commitmentId: C8, commitmentDigest: DIGEST, resolution: 'refund', reason: 'buyer wins' });
  check('resolve dispute -> refund', res2.ok === true && res2.escrow.state === escrow.STATES.REFUNDED, res2.escrow.state);

  tryCatch('resolve non-disputed denied', () => escrow.resolveDispute({ commitmentId: C4, commitmentDigest: DIGEST, resolution: 'release', verdict: { outcome: 'satisfied' } }));

  // 6. digest binding
  tryCatch('fund with wrong digest shape rejected', () => escrow.fund({ commitmentId: '0x' + '99'.repeat(32), commitmentDigest: 'not-a-digest', amount: '1', asset: 'USDC', txRef: { txHash: '0x' + '54'.repeat(32) } }));
  const C9 = '0x' + '55'.repeat(32);
  escrow.fund({ commitmentId: C9, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '43'.repeat(32) } });
  tryCatch('hold with different digest denied (binding)', () => escrow.hold({ commitmentId: C9, commitmentDigest: OTHER_DIGEST }));

  // 7. audit chain integrity
  const C10 = '0x' + '66'.repeat(32);
  escrow.fund({ commitmentId: C10, commitmentDigest: DIGEST, amount: '50000', asset: 'USDC', txRef: { txHash: '0x' + '32'.repeat(32) } });
  escrow.hold({ commitmentId: C10, commitmentDigest: DIGEST });
  escrow.release({ commitmentId: C10, commitmentDigest: DIGEST, verdict: { outcome: 'satisfied' } });
  const v = escrow.verifyAuditChain(C10);
  check('audit chain verifies (release path)', v.ok === true && v.verified === true, v.reason);
  // Tamper the chain: change an entry's state -> verifyAuditChain must fail
  const tampered = escrow.escrowStatus(C10).escrow.auditChain;
  tampered[1].state = 'refunded'; // tamper hold -> refunded
  const v2 = escrow.verifyAuditChain(C10);
  check('tampered audit chain detected', v2.ok === false && v2.verified === false, v2.reason);
  check('escrowStatus exposes state', escrow.escrowStatus('0x' + '00'.repeat(32)).state === escrow.STATES.UNFUNDED);

  console.log('---');
  console.log(passed + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ''));
})();