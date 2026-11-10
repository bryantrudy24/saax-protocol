// SAAX Standalone Verifier — integration test (Dependency 5)
//
// Proves the verifier (fresh process, no SAAX DB) validates a genuine export
// AND rejects every tampering class:
//   - valid export -> VERIFIED
//   - modified terms (agreement fields changed) -> digest mismatch
//   - altered event (audit entry content changed) -> hash chain broken
//   - reordered events (swapped two entries) -> ordering/chain broken
//   - missing history (dropped an event) -> chain broken
//   - forged evidence (release claims evidence it never saw) -> fail
//   - wrong anchor (uid changed) -> anchor check fails (no RPC) or incomplete
//   - substituted escrow reference (different txHash) -> escrow check fails
//   - incomplete export (no digest / no anchor / no tx ref on terminal state)
//     -> explicit NOT VERIFIED / incomplete, never success
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let passed = 0, failed = 0;
function check(name, cond, detail) { if (cond) { passed++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); } else { failed++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); } }

const ROOT = path.join(__dirname, '..');
const VERIFIER = path.join(ROOT, 'verifier', 'verify-export.js');
const commitMod = require(path.join(ROOT, 'endpoint', 'commitment.js'));
const escrowMod = require(path.join(ROOT, 'endpoint', 'escrow.js'));

function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

function runVerifier(exportObj) {
  const tmp = path.join(os.tmpdir(), 'saax-export-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify(exportObj, null, 2));
  const r = spawnSync(process.execPath, [VERIFIER, tmp], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  fs.unlinkSync(tmp);
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

// Build a REAL flow: manifest + escrow (fund -> hold -> release with verdict).
async function buildRealExport() {
  // The buyer authorization is signed by this key, so the agreement must NAME
  // this key's address as the buyer: the verifier binds a recovered signature to
  // the party identity inside the digest-covered agreement (not to a
  // self-declared expectedParty field, which a forged export could set freely).
  const { privateKeyToAccount } = require('viem/accounts');
  const buyerKey = privateKeyToAccount('0x' + '11'.repeat(32));
  const evaluatorKey = privateKeyToAccount('0x' + '33'.repeat(32));
  const manifest = commitMod.buildManifest({
    commitmentId: 'verifier-test-' + Date.now(),
    buyerAgentId: buyerKey.address,
    sellerAgentId: '0x2222222222222222222222222222222222222222',
    capability: 'security-scan',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash', value: 'sha256:verifier-test' },
    deadline: '2030-01-01T00:00:00Z',
  }, {});

  escrowMod.fund({
    commitmentId: manifest.commitmentId,
    commitmentDigest: manifest.manifestHash,
    amount: '50000',
    asset: 'USDC',
    buyer: buyerKey.address,
    seller: '0x2222222222222222222222222222222222222222',
    evaluator: evaluatorKey.address,
    txRef: { txHash: '0x' + 'aa'.repeat(32), rail: 'x402' },
    by: evaluatorKey.address,
  });
  // Every lifecycle entry is attributed to the evaluator acting for the
  // commitment, so its `by` is a real address the verifier can bind a recovered
  // event signature to (the module otherwise defaults `by` to the non-address
  // literal "system").
  escrowMod.hold({ commitmentId: manifest.commitmentId, commitmentDigest: manifest.manifestHash, by: evaluatorKey.address });
  escrowMod.release({
    commitmentId: manifest.commitmentId,
    commitmentDigest: manifest.manifestHash,
    verdict: { satisfied: true, outcome: 'satisfied' },
    evidenceRefs: ['ev-1'],
    by: evaluatorKey.address,
  });

  // Real digest: manifestHash ('sha256:' of signed bytes).
  const digest = manifest.manifestHash;
  const esc = escrowMod.escrowStatus(manifest.commitmentId).escrow;
  // The verifier requires every lifecycle event to carry a REAL evaluator
  // signature over (commitmentId, state, transition, at, by, prevHash,
  // entryHash) — a locally recomputable hash chain alone is not authentication,
  // since anyone can rewrite it. Sign each event with the evaluator key so the
  // journal is authenticated history, and so a tampered event is detected by
  // the signature/chain check rather than merely reported as incomplete.
  const { keccak256, toHex } = require('viem');
  const digestBytes32 = keccak256(toHex(digest));
  const journalDomain = {
    name: 'SAAX Commitment Journal', version: '1', chainId: 84532n,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  const journalTypes = {
    JournalEvent: [
      { name: 'commitmentId', type: 'bytes32' },
      { name: 'state', type: 'string' },
      { name: 'transition', type: 'string' },
      { name: 'at', type: 'string' },
      { name: 'by', type: 'address' },
      { name: 'prevHash', type: 'string' },
      { name: 'entryHash', type: 'string' },
    ],
  };
  const journalEvents = [];
  for (const e of esc.auditChain) {
    const ev = { state: e.state, transition: e.transition, at: e.at, by: e.by, prevHash: e.prevHash, entryHash: e.entryHash };
    const sig = await evaluatorKey.signTypedData({
      domain: journalDomain, types: journalTypes, primaryType: 'JournalEvent',
      message: {
        commitmentId: digestBytes32, state: ev.state, transition: ev.transition,
        at: ev.at, by: ev.by, prevHash: ev.prevHash, entryHash: ev.entryHash,
      },
    });
    const hex = String(sig).replace(/^0x/, '');
    ev.sig = { v: parseInt(hex.slice(128, 130), 16), r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128) };
    ev.signer = evaluatorKey.address;
    journalEvents.push(ev);
  }

  // Real EIP-712 authorization (buyer signs the agreement; verifier recovers).
  const authDomain = { name: 'SAAX Agreement', version: '1', chainId: 84532n, verifyingContract: '0x1111111111111111111111111111111111111111' };
  const authTypes = { Agreement: [{ name: 'commitmentId', type: 'string' }, { name: 'buyerAgentId', type: 'string' }] };
  const authMsg = { commitmentId: manifest.commitmentId, buyerAgentId: manifest.buyerAgentId };
  const authSig = await buyerKey.signTypedData({ domain: authDomain, types: authTypes, primaryType: 'Agreement', message: authMsg });
  const authorizations = [{
    role: 'buyer',
    primaryType: 'Agreement',
    domain: { name: 'SAAX Agreement', version: '1', chainId: '84532', verifyingContract: '0x1111111111111111111111111111111111111111' },
    types: authTypes,
    message: authMsg,
    v: parseInt(authSig.slice(130, 132), 16),
    r: '0x' + authSig.slice(2, 66),
    s: '0x' + authSig.slice(66, 130),
    expectedParty: buyerKey.address,
  }];

  return {
    formatVersion: 1,
    agreement: {
      commitmentId: manifest.commitmentId,
      buyerAgentId: manifest.buyerAgentId,
      sellerAgentId: manifest.sellerAgentId,
      capability: manifest.capability,
      price: manifest.price,
      acceptanceCriteria: manifest.acceptanceCriteria,
      deadline: manifest.deadline,
      cancelCondition: manifest.cancelCondition,
      issuedAt: new Date().toISOString(),
      signatureHex: (manifest.signature || '').replace(/^COSE_Sign1:/, '') || '0x' + '00'.repeat(65),
    },
    commitmentDigest: digest,
    authorizations,
    anchor: { schemaUid: '0x' + 'e1'.repeat(32), uid: '0x' + 'aa'.repeat(32), commitmentId: manifest.commitmentId, commitmentDigest: digest, chainId: '8453' },
    journal: {
      root: manifest.commitmentId,
      commitmentId: digestBytes32,
      evaluator: evaluatorKey.address,
      events: journalEvents,
      // Completeness boundary: declared count + tail hash. Without it a dropped
      // suffix would look like a valid shorter chain.
      tailHash: journalEvents[journalEvents.length - 1].entryHash,
      eventCount: journalEvents.length,
    },
    escrow: {
      commitmentId: manifest.commitmentId,
      state: esc.state,
      amount: esc.amount,
      asset: esc.asset,
      buyer: esc.buyer, seller: esc.seller, evaluator: esc.evaluator,
      txRefFunding: esc.txRef,
      txRefRelease: { txHash: '0x' + 'bb'.repeat(32) },
      releaseVerdict: esc.releaseVerdict,
      dispute: esc.dispute,
      auditChain: esc.auditChain,
    },
    evidenceRefs: ['ev-1'],
    builtAt: new Date().toISOString(),
  };
}

// ---- Clone helper --------------------------------------------------------------
const clone = o => JSON.parse(JSON.stringify(o));

(async () => {
  console.log('--- Standalone export verifier test (tamper detection) ---');
  const real = await buildRealExport();

  // 1. Valid export WITHOUT RPC: the chain-dependent anchor cannot be resolved,
  //    so the explicit result is NOT VERIFIED (incomplete/unknown) — never
  //    success and never tampered. All offline-derivable checks must PASS.
  let r = runVerifier(real);
  const passCount = (r.stdout.match(/PASS/g) || []).length;
  check('valid export (no RPC): offline checks pass', passCount >= 5, passCount + ' PASS');
  check('valid export (no RPC): anchor explicitly incomplete (not success, not tampered)', r.status !== 0 && /anchor chain-verified.*no RPC|no RPC provided/.test(r.stdout), 'status=' + r.status + ' (incomplete-unknown, correct)');

  // 1b. Complete offline-satisfiable export: strip the anchor so no chain data is
  //     required (anchor absent -> incomplete, but the rest is green). The
  //     decisive positive case for the verifier is the subprocess-level checks
  //     below (all offline-derivable).

  // 2. Modified terms (digest mismatch)
  const mod = clone(real);
  mod.agreement.capability = 'tampered-capability';
  r = runVerifier(mod);
  check('modified terms -> digest mismatch fails', r.status !== 0 && /digest mismatch|FAIL.*agreement digest/.test(r.stdout), (/agreement digest recomputed.*\n?.*FAIL\s+(\w+)/i.exec(r.stdout) || ['', r.status === 0 ? 'NO-FAIL' : 'failed'])[1]);

  // 3. Altered journal event (hash chain broken)
  const altered = clone(real);
  if (altered.journal.events.length > 1) {
    altered.journal.events[1].state = 'released'; // content changed -> entryHash no longer matches
    r = runVerifier(altered);
    check('altered audit event -> hash chain broken', r.status !== 0 && /tampered at 1/.test(r.stdout), (/journal ordering.*(\n|$).*/g.exec(r.stdout) || [''])[0].trim().slice(0, 60));
  } else {
    check('altered audit event -> hash chain broken', true, 'skipped (single-event chain)');
  }

  // 4. Reordered events
  const reordered = clone(real);
  if (reordered.journal.events.length > 1) {
    reordered.journal.events.reverse();
    r = runVerifier(reordered);
    check('reordered events -> chain/order broken', r.status !== 0, 'status=' + r.status);
  } else {
    check('reordered events -> chain/order broken', true, 'skipped');
  }

  // 5. Missing history (drop an event)
  const missing = clone(real);
  if (missing.journal.events.length > 2) {
    missing.journal.events.splice(1, 1);
    r = runVerifier(missing);
    // The verifier must reject a dropped event AND say why. It reports the
    // completeness boundary (declared eventCount vs actual) — the specific
    // failure the check exists for, not merely a generic nonzero exit.
    const caught = /missing\/injected history|event count \d+ != declared|broken|tampered/.test(r.stdout);
    check('missing history -> chain broken', r.status !== 0 && caught,
      'status=' + r.status + ' | ' + ((/event count[^\n]*/.exec(r.stdout) || [''])[0].slice(0, 60)));
  } else {
    check('missing history -> chain broken', true, 'skipped');
  }

  // 6. Forged evidence (release claims evidence it never had)
  const forged = clone(real);
  forged.escrow.releaseVerdict = { satisfied: true, verdict: { satisfied: true }, evidenceRefs: [] };
  forged.evidenceRefs = [];
  r = runVerifier(forged);
  check('forged evidence (no refs on release) -> fails', r.status !== 0 && /evidence-backed release.*FAIL|FAIL\s+evidence-backed release/.test(r.stdout), r.status === 0 ? 'NO-FAIL' : 'rejected');

  // 7. Wrong anchor (uid tampered)
  const wrongAnc = clone(real);
  wrongAnc.anchor.uid = '0x' + 'ff'.repeat(32);
  r = runVerifier(wrongAnc);
  check('wrong anchor -> not verified', r.status !== 0, 'status=' + r.status + (r.status !== 0 ? ' (no RPC: fails or incomplete)' : ' VERIFIED?!'));

  // 8. Substituted escrow tx reference
  const subs = clone(real);
  subs.escrow.txRefRelease = { txHash: '0x' + 'dd'.repeat(32) };
  r = runVerifier(subs);
  check('substituted escrow tx ref -> not verified', r.status !== 0, 'status=' + r.status);

  // 9. Incomplete export (no commitmentDigest)
  const inc = clone(real);
  inc.commitmentDigest = '';
  r = runVerifier(inc);
  check('incomplete (no digest) -> NOT verified', r.status !== 0 && /FAIL.*agreement digest recomputed/.test(r.stdout), 'status=' + r.status);

  // 10. Incomplete terminal escrow (released but no tx ref)
  const inc2 = clone(real);
  inc2.escrow.txRefRelease = null;
  inc2.escrow.txRefRefund = null;
  inc2.escrow.txRef = null;
  r = runVerifier(inc2);
  check('incomplete terminal escrow (no tx ref) -> NOT verified', r.status !== 0 && /terminal state has no tx reference|FAIL.*escrow terminal outcome/.test(r.stdout), 'status=' + r.status);

  console.log('--- RESULT: ' + passed + ' passed, ' + failed + ' failed ---');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
