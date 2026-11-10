// Re-sign the release event of the full-lifecycle fixture with the BUYER key
// instead of the EVALUATOR key -> journal authority mismatch (case-62).
// Outputs a fixture for the v3 battery: the event signature no longer matches
// the authority required for a 'release' transition (evaluator).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { privateKeyToAccount } = require('viem/accounts');
const fs = require('fs');
const CHAIN_ID = 84532;

async function main() {
  const inPath = process.argv[2] || 'evidence/v3-battery/fixture-full-lifecycle.json';
  const outPath = process.argv[3] || 'evidence/v3-battery/fixture-eval-sub-journal.json';
  const exp = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const buyer = privateKeyToAccount(process.env.SAAX_TEST_BUYER_KEY);
  const digest = exp.commitmentDigest;
  const digestBytes32 = ('0x' + digest.slice('sha256:'.length)).slice(0, 66);
  const j = exp.journal;
  const JOURNAL_DOMAIN = { name: 'SAAX Commitment Journal', version: '1', chainId: CHAIN_ID, verifyingContract: '0x0000000000000000000000000000000000000000' };
  const JOURNAL_TYPES = { JournalEvent: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'state', type: 'string' },
    { name: 'transition', type: 'string' },
    { name: 'at', type: 'string' },
    { name: 'by', type: 'address' },
    { name: 'prevHash', type: 'string' },
    { name: 'entryHash', type: 'string' },
  ] };
  // Re-sign the LAST event (release) with the BUYER key.
  const idx = j.events.length - 1;
  const ev = j.events[idx];
  const sig = await buyer.signTypedData({
    domain: { ...JOURNAL_DOMAIN, chainId: BigInt(CHAIN_ID) },
    types: JOURNAL_TYPES,
    primaryType: 'JournalEvent',
    message: { commitmentId: digestBytes32, state: ev.state, transition: ev.transition, at: ev.at, by: ev.by, prevHash: ev.prevHash, entryHash: ev.entryHash },
  });
  const hex = String(sig).replace(/^0x/, '');
  j.events[idx].sig = { v: parseInt(hex.slice(128, 130), 16), r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128) };
  j.events[idx].signer = buyer.address;
  fs.writeFileSync(outPath, JSON.stringify(exp, null, 2));
  console.log('eval-sub-journal fixture written: ' + outPath);
  console.log('  release event now signed by: ' + buyer.address + ' (not the evaluator)');
}

main().catch(e => { console.error('FATAL ' + (e.stack || e.message)); process.exit(1); });