'use strict';
/**
 * SAAX Pilot Journal Phase A — endpoint journal hook smoke test (Phase A
 * corrections edition).
 *
 * Exercises endpoint/escrow-access.js acceptOperation + reconcile journal
 * hooks with SAAX_ESCROW_JOURNAL_DIR set:
 *   - acceptOperation appends an INTENT entry (transition 'intent',
 *     observed=false, resultingState 'Accepted') for a buyer fund action,
 *     keyed by commitment digest. An intent entry is NOT a confirmed
 *     lifecycle transition.
 *   - reconcile appends a CONFIRMED observed entry (observed=true) when the
 *     external effect occurred with a txHash; the authorizing party is not
 *     fabricated (without SAAX_JOURNAL_RPC the sender is not recoverable, so
 *     NO entry is written and journalGap reports the missing transition).
 *
 * Uses an ISOLATED temp journal dir + isolated ledger path; the real
 * data/escrow-access-ledger.json is not touched. Deletes the temp dir after.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-journal-hook-'));
process.env.SAAX_ESCROW_JOURNAL_DIR = tmp;
process.env.SAAX_ESCROW_LEDGER = path.join(tmp, 'ledger.json');
process.env.SAAX_JOURNAL_SIGNER_KEY = '0x' + '42'.repeat(32); // operator attestation key (test-only)

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

(async () => {
  const escrowAccess = require('../endpoint/escrow-access.js');
  const journal = require('../endpoint/escrow-journal.js');
  const writer = require('../mainnet/design/support/v4-journal-writer');

  // Local chain 31337 for the journal domain (phase A corrections; local EVM
  // is never 84532). The access-auth chain guard (84532 Base Sepolia only) is
  // a production path — this hook test targets the journal, so it uses 31337
  // for the journal domain only.
  const chainId = 31337;
  const custodyAddress = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
  const commitmentId = '0x' + 'ab'.repeat(32); // digest bytes32

  // accepts a buyer 'fund' action (records ACCEPTED INTENT)
  const acc = escrowAccess.acceptOperation(
    { nonce: '900001', role: 'buyer', action: 'fund', commitmentDigest: commitmentId, escrowId: commitmentId, custody: custodyAddress, chainId: String(chainId), expiry: String(Math.floor(Date.now() / 1000) + 600) },
    { recoveredSigner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', manifestCid: commitmentId, chainId, action: 'fund' }
  );
  check('buyer fund accepted durably (intent)', acc.ok === true, acc.reason || '');

  // Give the async fire-and-forget hook a beat, then check the journal file.
  await new Promise(r => setTimeout(r, 300));
  const jp = journal.journalPathFor(commitmentId);
  check('intent journal file created', fs.existsSync(jp), jp);
  let saved = null;
  if (fs.existsSync(jp)) {
    saved = JSON.parse(fs.readFileSync(jp, 'utf8'));
    check('journal has exactly one INTENT entry (transition=intent, observed=false)',
      saved.events && saved.events.length === 1 && saved.events[0].transition === 'intent' && saved.events[0].observed === false,
      (saved.events || []).map(e => e.transition + ':' + e.observed).join(','));
    check('journal intent entry resultingState marks Accepted (not Funded)',
      saved.events[0].resultingState === 'Accepted', saved.events[0].resultingState);
    check('journal entry chain + tail consistent', saved.tailHash === saved.events[0].entryHash);
    check('journal domain chainId == 31337 (local)', saved.domain.chainId === 31337 && saved.domain.name === 'SAAX Commitment Journal' && saved.domain.version === '4',
      JSON.stringify(saved.domain));
    check('journal attests by recovered signer field (not operator key as actor)', !!saved.events[0].authorization && saved.events[0].signedBy,
      'signedBy=' + saved.events[0].signedBy);
    check('intent entry has evidenceDigest bound into hash + signature', !!saved.events[0].evidenceDigest && saved.events[0].entryHash && saved.events[0].eventId);
    // intent cannot satisfy a confirmed transition (journalGap must treat the
    // accepted intent as NOT the confirmed 'funded' transition)
    const present = saved.events.map(e => e.transition);
    check('intent entry does NOT claim confirmed funded transition', !present.includes('funded') && !writer.CONFIRMED_TRANSITIONS.has('intent'), present.join(','));
  }

  // reconcile with occurred + txHash: WITHOUT SAAX_JOURNAL_RPC the observed
  // sender is not recoverable -> reports missing evidence, never fabricates.
  const rec = escrowAccess.reconcile('900001', { occurred: true, txHash: '0x' + 'cc'.repeat(32), state: 'Funded', block: '0x1' });
  check('reconcile completed', rec.ok === true && rec.recorded.status === 'complete');
  await new Promise(r => setTimeout(r, 300));
  if (fs.existsSync(jp)) {
    saved = JSON.parse(fs.readFileSync(jp, 'utf8'));
    // no RPC -> observed append must NOT have fabricated an entry without a sender
    check('no fabricated observed entry without recovered sender', saved.events.length === 1, 'events=' + saved.events.length);
    const gap = journal.journalGap(commitmentId, [Object.assign({}, rec.recorded, { action: 'fund' })]);
    check('journalGap reports the missing confirmed transition (intent does not satisfy it)', (gap.missing || []).includes('funded'), JSON.stringify(gap.missing));
  }

  // cleanup
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log('PASSED=' + passed + ' FAILED=' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} process.exit(2); });