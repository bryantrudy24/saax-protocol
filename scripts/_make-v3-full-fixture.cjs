// v3 full-lifecycle fixture: extends the v3 issuance baseline with a
// released escrow + evaluator-signed verdict + journal fund/release events.
// Enables the verdict->escrow binding checks in the v3 battery.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { privateKeyToAccount } = require('viem/accounts');
const fs = require('fs');
const path = require('path');
const CHAIN_ID = 84532;
// The deployed custody contract's verdict scheme (SAAXEscrowCustodyV1).
const VERDICT_SCHEME = 'escrow-custody-v1';
const VERDICT_DOMAIN_NAME = 'SAAX Escrow Custody V1';
const VERDICT_DOMAIN_VERSION = '1';
const CUSTODY = (process.env.SAAX_CUSTODY_ADDRESS || '0x5a5472d751839cd4968cbf1b136baf862279ff5d').trim();
const VERDICT_DOMAIN = { name: VERDICT_DOMAIN_NAME, version: VERDICT_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: CUSTODY };
const VERDICT_TYPES = { EscrowVerdict: [
  { name: 'commitmentId', type: 'bytes32' },
  { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'action', type: 'string' },
  { name: 'nonce', type: 'uint256' },
  { name: 'issuedAt', type: 'uint256' },
] };

async function main() {
  const basePath = process.argv[2] || 'evidence/baseline-v3-verified-commitment.json';
  const outPath = process.argv[3] || 'evidence/v3-battery/fixture-full-lifecycle.json';
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const exp = JSON.parse(JSON.stringify(base));
  exp.lifecycleProfile = 'full';
  const evaluator = privateKeyToAccount(process.env.SAAX_EVALUATOR_PRIVATE_KEY);
  const buyer = privateKeyToAccount(process.env.SAAX_TEST_BUYER_KEY);
  const digest = exp.commitmentDigest;
  const digestBytes32 = ('0x' + digest.slice('sha256:'.length)).slice(0, 66);
  // Extend journal: fund (buyer) + release (evaluator) events.
  const j = exp.journal;
  const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s), 'utf8').digest('hex');
  const lastEntry = j.events[j.events.length - 1];
  const mkEvent = (state, transition, at, by, prevHash) => {
    const entryHash = sha256hex(JSON.stringify({ state, transition, at, by, prevHash }));
    return { state, transition, at, by, prevHash, entryHash };
  };
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
  const signEvent = async (ev, account, signerAddr) => {
    const sig = await account.signTypedData({
      domain: { ...JOURNAL_DOMAIN, chainId: BigInt(CHAIN_ID) },
      types: JOURNAL_TYPES,
      primaryType: 'JournalEvent',
      message: { commitmentId: digestBytes32, state: ev.state, transition: ev.transition, at: ev.at, by: ev.by, prevHash: ev.prevHash, entryHash: ev.entryHash },
    });
    const hex = String(sig).replace(/^0x/, '');
    return { ...ev, sig: { v: parseInt(hex.slice(128, 130), 16), r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128) }, signer: signerAddr };
  };
  const nowIso = new Date().toISOString();
  const evFund = mkEvent('FUNDED', 'fund', nowIso, buyer.address, lastEntry.entryHash);
  const evRelease = mkEvent('RELEASED', 'release', new Date(new Date().getTime() + 1000).toISOString(), evaluator.address, evFund.entryHash);
  const signedFund = await signEvent(evFund, buyer, buyer.address);
  const signedRelease = await signEvent(evRelease, evaluator, evaluator.address);
  j.events = j.events.concat([signedFund, signedRelease]);
  j.tailHash = signedRelease.entryHash;
  j.eventCount = j.events.length;

  const escrowRef = 'escrow-v3-' + exp.agreement.commitmentId;
  const nonce = String(Math.floor(Date.now() / 1000));
  exp.escrow = {
    commitmentId: exp.agreement.commitmentId,
    state: 'released',
    amount: '50000',
    asset: 'USDC',
    buyer: exp.agreement.buyerAgentId,
    seller: exp.agreement.sellerAgentId,
    evaluator: exp.agreement.evaluator,
    escrowRef,
    custody: CUSTODY,
    verdictScheme: VERDICT_SCHEME,
    txRefFunding: { txHash: exp.anchor.txHash, rail: 'chain' },
    txRefRelease: { txHash: exp.anchor.txHash, rail: 'chain' },
    releaseVerdict: { satisfied: true, evidenceRefs: ['work_output'], verdict: null },
  };
  const issuedAt = Math.floor(Date.now() / 1000);
  const verdict = { commitmentId: digestBytes32, commitmentDigest: digestBytes32, action: 'release', nonce, issuedAt: String(issuedAt) };
  const vsig = await evaluator.signTypedData({
    domain: { ...VERDICT_DOMAIN, chainId: BigInt(CHAIN_ID) },
    types: VERDICT_TYPES,
    primaryType: 'EscrowVerdict',
    message: { commitmentId: digestBytes32, commitmentDigest: digestBytes32, action: 'release', nonce: BigInt(nonce), issuedAt: BigInt(issuedAt) },
  });
  const vhex = String(vsig).replace(/^0x/, '');
  const verdictSig = { v: parseInt(vhex.slice(128, 130), 16), r: '0x' + vhex.slice(0, 64), s: '0x' + vhex.slice(64, 128) };
  exp.escrow.releaseVerdict.verdict = Object.assign({}, verdict, { sig: verdictSig });
  exp.evidenceRefs = ['work_output'];
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(exp, null, 2));
  console.log('full-lifecycle fixture written: ' + outPath);
  console.log('  escrow.state=' + exp.escrow.state + ' escrowRef=' + escrowRef);
  console.log('  escrow.custody=' + CUSTODY + ' verdictScheme=' + VERDICT_SCHEME + ' nonce=' + nonce);
  console.log('  agreement.evaluator=' + exp.agreement.evaluator);
  console.log('  verdict.action=' + exp.escrow.releaseVerdict.verdict.action);
}

main().catch(e => { console.error('FATAL ' + (e.stack || e.message)); process.exit(1); });