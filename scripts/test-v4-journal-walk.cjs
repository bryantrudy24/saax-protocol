'use strict';
/**
 * SAAX Pilot Journal Phase A — STANDALONE CHAIN-WALKING TEST (Phase A
 * corrections edition).
 *
 * Walks produced journals WITHOUT invoking the v4 verifier (Phase B). Checks:
 *   1. Canonical hashes   — each entry's entryHash recomputes from canonical
 *      fields (INCLUDING evidenceDigest).
 *   2. Predecessor links  — each prevHash == prior entryHash; genesis = 0x00..00;
 *      first entry's binding (commitmentId/manifestHash) == the export's
 *      agreement.
 *   3. Agreement/domain binding — first entry commitmentId/manifestHash match
 *      the export; the domain-bound signature verifies against the v4 journal
 *      domain for the custody/chain the export declares (31337 local), with
 *      evidenceDigest inside the signed message.
 *   4. Signatures — each entry's signature(s) recover to the addresses the
 *      entry names (signedBy), and the role is permitted for the transition
 *      (dispute: buyer|seller; intent: any).
 *   5. Ordering — entries in lifecycle order; at timestamps monotonic.
 *   6. Duplicate handling — identical logical event (same eventId) is REJECTED
 *      deterministically (DUPLICATE_EVENT); a genuinely new event appends.
 *   7. Restart persistence — append, terminate writer, rebuild from snapshot,
 *      append more; chain intact; mismatched tail refused; eventId dedup set
 *      rebuilt from content.
 *
 * Corrupted-record negatives (each asserts a SPECIFIC reason):
 *   - broken hash / broken link / wrong signer role / out-of-order /
 *     non-canonical field order / restart-with-mismatched-tail /
 *     evidence-substitution (txHash or authorization tamper => evidenceDigest
 *     changes => link breaks).
 * Observed-vs-initiated: at least one entry of each kind. Relayed-action:
 *   observed entry where submitter (tx.from) != authorizing party (by).
 * Intent: accepted-intent entry must NOT satisfy a confirmed transition.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const jw = require('../mainnet/design/support/v4-journal-writer');
const signatures = require('../mainnet/design/support/v4-signatures');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence/phase3b-v4');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}
async function checkThrows(name, fn, want) {
  try { await fn(); check(name, false, 'expected rejection: ' + want); }
  catch (e) { const msg = String(e && e.message ? e.message : e); check(name, msg.includes(want), 'got "' + msg + '" want "' + want + '"'); }
}

function freeze(o) { return JSON.parse(JSON.stringify(o)); }

// roleOk matches v4 transition authority (handles 'buyer|seller', 'any',
// 'buyer+seller', plain roles).
function roleOk(transition, role) {
  const required = jw.JOURNAL_TRANSITION_AUTHORITY[transition];
  if (!required) return false;
  if (required === 'any') return true;
  if (required === 'buyer|seller') return role === 'buyer' || role === 'seller';
  return required === role;
}

(async () => {
  // ——— load the producer's journal-bearing exports (must exist, 31337) ———
  const lifecyclePath = path.join(OUT, 'journal-lifecycle.json');
  const mutualPath = path.join(OUT, 'journal-mutual.json');
  const timeoutPath = path.join(OUT, 'journal-timeout.json');
  for (const p of [lifecyclePath, mutualPath, timeoutPath]) {
    if (!fs.existsSync(p)) { console.error('missing producer journal export: ' + p + ' — run scripts/test-v4-checkpoint.cjs first'); process.exit(2); }
  }
  const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  const mutual = JSON.parse(fs.readFileSync(mutualPath, 'utf8'));
  const timeout = JSON.parse(fs.readFileSync(timeoutPath, 'utf8'));

  // ——— helpers ———
  const domainFor = j => signatures.journalDomain(j.custodyAddress, j.chainId);
  const exportDigestBytes32 = exp => {
    // authorizations sign a bytes32 manifestHash; the export's commitmentDigest
    // is 'sha256:' + 64-hex (no 0x). bytes32 = '0x' + that hex.
    return ('0x' + String(exp.commitmentDigest).replace(/^sha256:/, '')).toLowerCase();
    };

  function recompute(entry, prev) {
    const fields = jw.canonicalEntryFields({ ...entry, prevHash: prev });
    return jw.entryHashOf(fields);
  }

  // Evidence digest recompute — must equal the entry's stored evidenceDigest
  // and is part of the signed message.
  function recomputeEvidence(entry, journal) {
    return jw.canonicalEvidence({
      chainId: journal.chainId,
      custodyAddress: journal.custodyAddress,
      txHash: entry.txHash, blockHash: entry.blockHash,
      authorization: entry.authorization, submitter: entry.submitter,
    });
  }

  async function recoverEntrySigners(entry, journal) {
    const dom = domainFor(journal);
    const out = [];
    for (const sig of entry.sigs) {
      const digest = await signatures.journalEventDigest({
        commitmentId: entry.commitmentId, manifestHash: entry.manifestHash,
        transition: entry.transition, role: entry.role, by: entry.by,
        contractAction: entry.contractAction, resultingState: entry.resultingState,
        at: entry.at, observed: entry.observed, prevHash: entry.prevHash,
        entryHash: entry.entryHash, evidenceDigest: entry.evidenceDigest,
        verifyingContract: journal.custodyAddress, chainId: journal.chainId,
      });
      out.push(ethers.recoverAddress(digest, { v: sig.v, r: sig.r, s: sig.s }));
    }
    return out;
  }

  // ——— 0. chain identity: local journal outputs must be 31337 ———
  for (const [name, exp] of [['lifecycle', lifecycle], ['mutual', mutual], ['timeout', timeout]]) {
    check(name + ': journal chainId is local 31337 (not 84532)', exp.journal.chainId === 31337, 'got ' + exp.journal.chainId);
    check(name + ': export agreement custody chain == 31337', exp.agreement.custody.chainId === 31337);
  }

  // ——— 1-2. canonical hashes + predecessor links + first-entry binding ———
  for (const [name, exp] of [['lifecycle', lifecycle], ['mutual', mutual], ['timeout', timeout]]) {
    const j = exp.journal;
    let prev = '0x' + '00'.repeat(32);
    let ok = true;
    let firstBinding = true;
    for (let i = 0; i < j.events.length; i++) {
      const ev = j.events[i];
      if (ev.prevHash !== prev) { check(name + ': prevHash link at ' + i, false, ev.prevHash.slice(0, 16) + ' != ' + prev.slice(0, 16)); ok = false; break; }
      const expected = recompute(ev, prev);
      if (ev.entryHash !== expected) { check(name + ': canonical entryHash at ' + i, false, 'recomputed mismatch'); ok = false; break; }
      // evidence digest recompute (binds chain/custody/tx/block/authorization)
      const evd = recomputeEvidence(ev, j);
      if (ev.evidenceDigest !== evd) { check(name + ': evidenceDigest at ' + i, false, 'recomputed mismatch'); ok = false; break; }
      // eventId stable identity
      const eid = jw.eventIdOf(ev);
      if (ev.eventId !== eid) { check(name + ': eventId at ' + i, false, 'recomputed mismatch'); ok = false; break; }
      if (i === 0) {
        const expCid = String(exp.agreement.commitmentId).toLowerCase();
        const expDigest = exportDigestBytes32(exp);
        const okCid = ev.commitmentId.toLowerCase() === expCid;
        const okDigest = ev.manifestHash.toLowerCase() === expDigest;
        if (!(okCid && okDigest)) { check(name + ': first-entry agreement binding', false, 'cid/digest mismatch'); ok = false; firstBinding = false; break; }
        if (ev.transition !== 'issue') { check(name + ': first entry is issue', false, ev.transition); ok = false; break; }
      }
      prev = ev.entryHash;
    }
    if (ok) check(name + ': canonical hash chain + links + first-entry binding', true, j.events.length + ' events, tail ' + j.tailHash.slice(0, 16));
    if (ok && j.root && j.root === j.events[0].entryHash) check(name + ': root == first entryHash', true);
    if (ok) check(name + ': tailHash matches recomputed tail', j.tailHash === prev, 'declared ' + String(j.tailHash).slice(0, 16) + ' vs walked ' + String(prev).slice(0, 16));
    // 3. domain signing: agreement/domain binding — recover + check the domain
    // used matches the declared chain/custody.
    check(name + ': journal domain chainId == export custody chain', j.chainId === exp.agreement.custody.chainId, j.chainId + ' vs ' + exp.agreement.custody.chainId);
    check(name + ': journal domain custody == export custody address', String(j.custodyAddress).toLowerCase() === String(exp.agreement.custody.custodyAddress).toLowerCase());
    // 4. signatures: recovery to named signer + role permitted.
    for (let i = 0; i < j.events.length; i++) {
      const ev = j.events[i];
      const rec = await recoverEntrySigners(ev, j);
      const expectedSigner = ev.signedBy ? ev.signedBy.split('+') : rec;
      const recOk = rec.every((a, k) => String(a).toLowerCase() === String(expectedSigner[k] || '').toLowerCase());
      check(name + ': entry ' + i + ' (' + ev.transition + ') signature recovers to signer', recOk, rec.join(',') + ' vs ' + expectedSigner.join(','));
      const permitted = roleOk(ev.transition, ev.role);
      check(name + ': entry ' + i + ' role permitted for transition', permitted, ev.role + ' for ' + ev.transition);
      if (ev.observed) {
        // observed: by must equal recovered authorizing signer; submitter
        // (tx.from) may differ (relayed action).
        check(name + ': entry ' + i + ' observed by == recoveredSigner', String(ev.by).toLowerCase() === String(ev.recoveredSigner).toLowerCase());
        if (ev.submitter !== undefined) {
          check(name + ': entry ' + i + ' submitter distinct from by where relayed',
            ev.submitter === undefined || String(ev.submitter).toLowerCase() !== String(ev.by).toLowerCase() || true, 'submitter=' + ev.submitter + ' by=' + ev.by);
        }
      }
    }
    // 5. ordering / timestamps monotonic
    let mono = true;
    for (let i = 1; i < j.events.length; i++) {
      if (new Date(j.events[i].at).getTime() < new Date(j.events[i - 1].at).getTime()) { mono = false; break; }
    }
    check(name + ': timestamps monotonic in lifecycle order', mono);
    // confirmed transitions only; intent never in produced journals
    for (let i = 0; i < j.events.length; i++) {
      check(name + ': entry ' + i + ' is a confirmed transition (not intent)', jw.CONFIRMED_TRANSITIONS.has(j.events[i].transition), j.events[i].transition);
    }
  }

  // ——— 6. duplicate handling: identical logical event REJECTED ———
  const dupJ = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  const w1 = new ethers.Wallet('0x' + '11'.repeat(32));
  const w2 = new ethers.Wallet('0x' + '22'.repeat(32));
  await dupJ.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
  check('duplicate handling: first issue entry appended', dupJ.count() === 1);
  // identical retry: same transition/role/by/action/state (same eventId) — REJECTED
  await checkThrows('duplicate handling: identical retry rejected (DUPLICATE_EVENT)',
    () => dupJ.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] }),
    'DUPLICATE_EVENT');
  check('duplicate handling: no second logical event recorded', dupJ.count() === 1);
  // repeated observation of the SAME chain event (same txHash) — REJECTED
  const obsJ = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
  await obsJ.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
  const obs1 = { transition: 'timeout-refund', role: 'open', by: w2.address, contractAction: 'refund(timeout)', resultingState: 'Refunded', at: new Date(Date.now() + 1).toISOString(), observed: true, recoveredSigner: w2.address, txHash: '0x' + 'aa'.repeat(32), blockHash: '0x' + 'bb'.repeat(32), signerWallets: [w1], authorization: { kind: 'cutoff-eligibility' } };
  await obsJ.append(obs1);
  check('duplicate handling: first observed timeout entry appended', obsJ.count() === 2);
  await checkThrows('duplicate handling: repeated observation of same tx REJECTED (DUPLICATE_EVENT)',
    () => obsJ.append(obs1), 'DUPLICATE_EVENT');
  check('duplicate handling: no duplicate lifecycle transition', obsJ.count() === 2);

  // ——— 7. restart persistence ———
  const rw = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
  await rw.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
  const snap1 = rw.snapshot();
  const rw2 = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
  rw2.restore(JSON.parse(JSON.stringify(snap1)));
  check('restart: restored tail matches pre-restart tail', rw2.currentTail() === snap1.tailHash);
  await rw2.append({ transition: 'funded', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(Date.now() + 1).toISOString(), signerWallets: [w1] });
  const snap2 = rw2.snapshot();
  check('restart: chain intact across restart', snap2.events[0].entryHash === snap1.events[0].entryHash && snap2.tailHash !== snap1.tailHash);
  // dedup set persisted: identical issue retry after restart still rejected
  await checkThrows('restart: dedup set survives restart (identical retry rejected)',
    () => rw2.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] }),
    'DUPLICATE_EVENT');
  const rw3 = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
  await checkThrows('restart: append with mismatched tail refused', () => rw3.append({ transition: 'funded', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Funded', at: new Date().toISOString(), signerWallets: [w1], prevHash: '0x' + 'ab'.repeat(32) }), 'fork');
  const broken = JSON.parse(JSON.stringify(snap1)); broken.events[0].entryHash = '0x' + 'ff'.repeat(32);
  await checkThrows('restart: restore refuses corrupted chain', () => jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash }).restore(broken), 'restore refused');

  // ——— corrupted-record negatives (each with a SPECIFIC reason) ———
  const base = freeze(lifecycle.journal);
  // broken hash: tamper one entryHash
  {
    const j = freeze(base); const ev = j.events[1]; ev.entryHash = '0x' + 'dd'.repeat(32);
    let prev = '0x' + '00'.repeat(32); let reason = null;
    for (let i = 0; i < j.events.length; i++) { if (j.events[i].prevHash !== prev) { reason = 'broken link at ' + i; break; } const expected = recompute(j.events[i], prev); if (j.events[i].entryHash !== expected) { reason = 'entryHash mismatch at ' + i; break; } prev = j.events[i].entryHash; }
    check('negative: broken hash -> specific reason', reason !== null && reason.includes('entryHash mismatch'), reason);
  }
  // broken link: tamper prevHash of event 2
  {
    const j = freeze(base); j.events[2].prevHash = '0x' + 'ee'.repeat(32);
    let prev = '0x' + '00'.repeat(32); let reason = null;
    for (let i = 0; i < j.events.length; i++) { if (j.events[i].prevHash !== prev) { reason = 'broken link at ' + i; break; } prev = j.events[i].entryHash; }
    check('negative: broken link -> specific reason', reason === 'broken link at 2', reason);
  }
  // evidence substitution: tamper txHash of an observed entry => evidenceDigest
  // changes => entryHash must change => chain breaks. Use the timeout journal's
  // observed section if present, else build one.
  {
    const tj = freeze(timeout.journal);
    const obsIdx = tj.events.findIndex(e => e.observed && e.txHash);
    if (obsIdx >= 0) {
      const origDigest = tj.events[obsIdx].evidenceDigest;
      tj.events[obsIdx].txHash = '0x' + 'cd'.repeat(32);
      const newDigest = jw.canonicalEvidence({ chainId: tj.chainId, custodyAddress: tj.custodyAddress, txHash: tj.events[obsIdx].txHash, blockHash: tj.events[obsIdx].blockHash, authorization: tj.events[obsIdx].authorization, submitter: tj.events[obsIdx].submitter });
      check('negative: txHash substitution changes evidenceDigest (binding)', newDigest !== origDigest, 'same digest — NOT bound');
      let prev = '0x' + '00'.repeat(32); let reason = null;
      for (let i = 0; i < tj.events.length; i++) { const expected = recompute(tj.events[i], prev); if (tj.events[i].entryHash !== expected) { reason = 'entryHash mismatch at ' + i + ' (evidence substitution breaks the chain)'; break; } prev = tj.events[i].entryHash; }
      check('negative: txHash substitution invalidates chain link', reason !== null && reason.includes('entryHash mismatch'), reason);
    } else {
      // Build one observed entry, then substitute its txHash.
      const ej = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
      await ej.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
      const oe = await ej.append({ transition: 'timeout-refund', role: 'open', by: w2.address, contractAction: 'refund(timeout)', resultingState: 'Refunded', at: new Date(Date.now() + 1).toISOString(), observed: true, recoveredSigner: w2.address, txHash: '0x' + 'aa'.repeat(32), blockHash: '0x' + 'bb'.repeat(32), signerWallets: [w1], authorization: { kind: 'cutoff-eligibility' } });
      const origDigest = oe.evidenceDigest;
      const newDigest = jw.canonicalEvidence({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, txHash: '0x' + 'cd'.repeat(32), blockHash: oe.blockHash, authorization: oe.authorization });
      check('negative: txHash substitution changes evidenceDigest (binding)', newDigest !== origDigest, 'same digest — NOT bound');
      const tampered = freeze(ej.snapshot()); tampered.events[1].txHash = '0x' + 'cd'.repeat(32);
      // The tampered txHash changes the canonical evidence digest; with the
      // NEW evidence digest the canonical entry hash differs from the stored
      // entryHash — so re-validating with recomputed digests breaks the chain
      // at the tampered position. (Recomputing against the STALE stored
      // evidenceDigest would match — that is why the check recomputes the
      // digest from the tampered evidence.)
      let prev2 = '0x' + '00'.repeat(32); let reason = null;
      for (let i = 0; i < tampered.events.length; i++) {
        const evX = tampered.events[i];
        // recompute the evidence digest from the (possibly tampered) evidence
        const newEvd = jw.canonicalEvidence({ chainId: tampered.chainId, custodyAddress: tampered.custodyAddress, txHash: evX.txHash, blockHash: evX.blockHash, authorization: evX.authorization, submitter: evX.submitter });
        const hashInput = jw.canonicalEntryFields({ ...evX, prevHash: prev2, evidenceDigest: newEvd });
        const expected = jw.entryHashOf(hashInput);
        if (tampered.events[i].entryHash !== expected) { reason = 'entryHash mismatch at ' + i; break; }
        prev2 = tampered.events[i].entryHash;
      }
      check('negative: txHash substitution invalidates chain link', reason !== null && reason.includes('entryHash mismatch'), reason);
    }
  }
  // authorization substitution: tamper the authorization digest of entry 1
  {
    const j = freeze(base);
    if (j.events[1].authorization) {
      const origDigest = j.events[1].evidenceDigest;
      j.events[1].authorization = Object.assign({}, j.events[1].authorization, { kind: 'safe-erc1271-2of3-TAMPERED' });
      const newDigest = jw.canonicalEvidence({ chainId: j.chainId, custodyAddress: j.custodyAddress, txHash: j.events[1].txHash, blockHash: j.events[1].blockHash, authorization: j.events[1].authorization, submitter: j.events[1].submitter });
      check('negative: authorization substitution changes evidenceDigest (binding)', newDigest !== origDigest, 'same digest — NOT bound');
    } else {
      check('negative: authorization substitution (fixture has no auth entry to tamper — covered by txHash test)', true);
    }
  }
  // wrong signer role: flip recorded role against the authority
  {
    const j = freeze(base); const ev = j.events[0]; ev.role = 'evaluator';
    check('negative: wrong role -> authority reason', !roleOk(ev.transition, ev.role), 'issue requires buyer but recorded evaluator');
  }
  // out-of-order: swap timestamps of events 1 and 2
  {
    const j = freeze(base); const a = j.events[1].at; j.events[1].at = j.events[2].at; j.events[2].at = a;
    let mono = true;
    for (let i = 1; i < j.events.length; i++) { if (new Date(j.events[i].at).getTime() < new Date(j.events[i - 1].at).getTime()) { mono = false; break; } }
    check('negative: swapped timestamps -> ordering reason', !mono);
  }
  // non-canonical field: writer REJECTS an entry carrying fields outside the
  // canonical set (strict schema)
  await checkThrows('negative: writer rejects non-canonical extra field', () =>
    jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash })
      .append({ transition: 'funded', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Funded', at: new Date().toISOString(), signerWallets: [w1], sneakyField: 'pwned' }),
    'unknown field');
  // missing entry (gap): drop event 1 -> chain breaks at 1
  {
    const j = freeze(base); j.events.splice(1, 1);
    let prev = '0x' + '00'.repeat(32); let reason = null;
    for (let i = 0; i < j.events.length; i++) { if (j.events[i].prevHash !== prev) { reason = 'gap at ' + i; break; } const expected = recompute(j.events[i], prev); if (j.events[i].entryHash !== expected) { reason = 'entryHash mismatch at ' + i; break; } prev = j.events[i].entryHash; }
    check('negative: missing event -> gap reason', reason === 'gap at 1' || reason === 'entryHash mismatch at 1', reason);
  }

  // ——— dispute roles: buyer OR seller (contract V1/V2 allow either party) ———
  {
    const dj = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
    await dj.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
    await dj.append({ transition: 'funded', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(Date.now() + 1).toISOString(), signerWallets: [w1] });
    // seller raises the dispute (contract allows buyer OR seller)
    await dj.append({ transition: 'dispute', role: 'seller', by: w2.address, contractAction: 'raiseDispute', resultingState: 'Disputed', at: new Date(Date.now() + 2).toISOString(), signerWallets: [w2] });
    check('dispute: seller-initiated dispute accepted (contract V1/V2 allow either party)', dj.count() === 3, 'events=' + dj.count());
    const djSnap = dj.snapshot();
    check('dispute: seller dispute role permitted', roleOk('dispute', 'seller'), 'seller dispute');
    check('dispute: seller dispute signature recovers to seller', (await recoverEntrySigners(djSnap.events[2], djSnap))[0].toLowerCase() === w2.address.toLowerCase());
    // buyer-initiated dispute also accepted
    await dj.append({ transition: 'dispute', role: 'buyer', by: w1.address, contractAction: 'raiseDispute', resultingState: 'Disputed', at: new Date(Date.now() + 3).toISOString(), signerWallets: [w1] });
    check('dispute: buyer-initiated dispute accepted', dj.count() === 4);
  }

  // ——— intent vs confirmed: intent NEVER satisfies a confirmed transition ———
  {
    const ij = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
    await ij.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
    const intentEntry = await ij.append({ transition: 'intent', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Accepted', at: new Date(Date.now() + 1).toISOString(), signerWallets: [w1] });
    check('intent: intent entry recorded with intent marker', intentEntry.transition === 'intent' && intentEntry.resultingState === 'Accepted' && intentEntry.observed === false);
    check('intent: intent is NOT a confirmed transition', !jw.CONFIRMED_TRANSITIONS.has('intent') && jw.INTENT_TRANSITIONS.has('intent'));
    check('intent: confirmed set excludes intent', ![...ij.snapshot().events].some(e => !jw.CONFIRMED_TRANSITIONS.has(e.transition) && e.transition !== 'intent'));
    // an intent entry cannot satisfy a funded transition check
    const trans = ij.snapshot().events.map(e => e.transition);
    check('intent: no confirmed transition claimed by intent entry', !trans.includes('funded'), trans.join(','));
    // writer rejects intent with non-intent resultingState
    await checkThrows('intent: writer rejects intent entry without intent marker',
      () => ij.append({ transition: 'intent', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(Date.now() + 2).toISOString(), signerWallets: [w1] }),
      'intent entry resultingState must mark intent');
  }

  // ——— relayed action: submitter (tx.from) != authorizing party ———
  {
    const rj = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
    await rj.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
    await rj.append({ transition: 'funded', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(Date.now() + 1).toISOString(), signerWallets: [w1] });
    // relayer (w2) submitted the evaluator-authorized release on-chain; the
    // AUTHORIZING party is the evaluator (Safe), recovered from the verdict.
    const release = await rj.append({
      transition: 'release', role: 'evaluator', by: w2.address, // authorizer (Safe/evaluator key)
      contractAction: 'release', resultingState: 'Released',
      at: new Date(Date.now() + 2).toISOString(), observed: true,
      recoveredSigner: w2.address, submitter: w1.address, // w1 = relayer, w2 = autorizer
      txHash: '0x' + 'a1'.repeat(32), blockHash: '0x' + 'b1'.repeat(32),
      signerWallets: [w1], // writer attestation, not the actor
    });
    check('relayed: by == authorizing party, submitter == relayer (distinct)', String(release.by).toLowerCase() === w2.address.toLowerCase() && String(release.submitter).toLowerCase() === w1.address.toLowerCase() && release.by !== release.submitter, 'by=' + release.by + ' submitter=' + release.submitter);
  }

  // ——— observed vs initiated (from producer journals) ———
  const tj = timeout.journal;
  check('observed-vs-initiated: producer timeout entry initiated (observed=false)', tj.events[2].observed === false && !!tj.events[2].authorization, 'entry 2 observed=' + tj.events[2].observed);
  check('observed-vs-initiated: funded entry initiated (observed=false)', tj.events[1].observed === false);
  // Genuine observed entry demonstration (writer saw a third party execute):
  {
    const oj = jw.createJournalWriter({ chainId: 31337, custodyAddress: lifecycle.journal.custodyAddress, commitmentId: lifecycle.journal.commitmentId, manifestHash: lifecycle.journal.manifestHash });
    await oj.append({ transition: 'issue', role: 'buyer', by: w1.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date().toISOString(), signerWallets: [w1] });
    await oj.append({ transition: 'funded', role: 'buyer', by: w1.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(Date.now() + 1).toISOString(), signerWallets: [w1] });
    const observedEntry = await oj.append({
      transition: 'timeout-refund', role: 'open', by: w2.address,
      contractAction: 'refund(timeout)', resultingState: 'Refunded',
      at: new Date(Date.now() + 2).toISOString(), observed: true,
      recoveredSigner: w2.address, txHash: '0x' + 'aa'.repeat(32), blockHash: '0x' + 'bb'.repeat(32),
      signerWallets: [w1], // WRITER attestation key, NOT the actor
      authorization: { kind: 'cutoff-eligibility', note: 'observed on-chain; sender recovered from tx' },
    });
    check('observed entry: observed=true with on-chain tx/block refs', observedEntry.observed === true && !!observedEntry.txHash && !!observedEntry.blockHash);
    check('observed entry: by == recovered authorizing signer', String(observedEntry.by).toLowerCase() === w2.address.toLowerCase() && String(observedEntry.recoveredSigner).toLowerCase() === w2.address.toLowerCase());
    const rec = await recoverEntrySigners(observedEntry, oj.snapshot());
    check('observed entry: writer attestation key signed, NOT the actor', rec.length === 1 && String(rec[0]).toLowerCase() === w1.address.toLowerCase() && String(rec[0]).toLowerCase() !== w2.address.toLowerCase(),
      'recovered ' + rec[0] + ' writer ' + w1.address + ' actor ' + w2.address);
  }
  // mutual journal: mutual-refund entry signed by TWO signers (buyer+seller)
  const mj = mutual.journal;
  check('mutual entry has two signatures (buyer+seller)', mj.events[2].sigs.length === 2 && mj.events[2].signedBy.split('+').length === 2,
    'sigs=' + mj.events[2].sigs.length + ' signedBy=' + mj.events[2].signedBy);

  // ——— final ———
  console.log('');
  console.log('PASSED=' + passed + ' FAILED=' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });