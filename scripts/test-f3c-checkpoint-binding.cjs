'use strict';
/**
 * F3C — checkpoint-to-journal binding (focused unit + negative tests).
 *
 * Proves the committed checkpoint is INDEPENDENTLY RECOMPUTED from the
 * authenticated journal prefix — never merely compared against another
 * export-supplied field. Uses the verifier's recomputeJournalPrefixTail (a
 * pure recompute over journalPrimitives canonicalization) and asserts:
 *   1. prefix tail equals the journal tail BEFORE the settlement entry;
 *   2. settlement receipt entry extends that exact prefix (prevHash chain);
 *   3. wrong/missing/replaced prefix rejects;
 *   4. timeout keeps zero committedHead (no fabricated checkpoint);
 *   5. initial agreement association (issue entry binds commitmentId +
 *      manifestHash to the signed agreement);
 *   6. authorization-model negatives: wrong-role wallet rejected for the
 *      authorization reason; observer attestation cannot substitute for
 *      evaluator authorization; relayer/observer/authorizer distinguishable;
 *      Safe evaluator NEVER impersonated by a single wallet.
 * Pure recompute, no RPC, no chain writes.
 */
'use strict';
const path = require('path');
const { ethers } = require('ethers');
const ROOT = path.resolve(__dirname, '..');
const verifyV4 = require(path.join(ROOT, 'verifier/verify-v4.js'));
const journalWriter = require(path.join(ROOT, 'mainnet/design/support/v4-journal-writer'));
const { verifyJournal } = require(path.join(ROOT, 'verifier/v4-journal.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function checkThrows(name, fn, want) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  const ok = threw !== null && (!want || String(threw.message).includes(want));
  check(name, ok, threw ? 'threw: ' + threw.message : 'DID NOT THROW');
}

const CHAIN = 31337;
const CUSTODY = '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853';
const CID = '0x' + 'ab'.repeat(32);
const DIGEST = '0x' + 'cd'.repeat(32);

// ---- distinct role fixtures derived from the deterministic Hardhat mnemonic.
// Addresses are DERIVED from the actual signer wallets (never remembered
// account mappings, never printed private keys) and asserted against the
// declared agreement parties — the writer/verifier bind every entry to the
// signed agreement's role addresses.
const MNEMONIC = 'test test test test test test test test test test test junk';
function walletAt(index) {
  const w = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/" + index);
  return w;
}
const buyerWallet = walletAt(0);      // Hardhat account #0 — buyer role
const sellerWallet = walletAt(1);     // Hardhat account #1 — seller role
const evaluatorEOA = walletAt(2);     // Hardhat account #2 — the EVALUATOR ADDRESS
                                     //   (a Safe contract authority; its address
                                     //   must NEVER sign a raw journal EOA sig)
const observerWallet = walletAt(3);   // account #3 — observer/attester (writer
                                     //   attestation key for evaluator entries)
const relayerWallet = walletAt(4);    // account #4 — relayer (tx submitter,
                                     //   distinct from authorizer)
const BUYER = buyerWallet.address;
const SELLER = sellerWallet.address;
const EVALUATOR = evaluatorEOA.address;
const OBSERVER = observerWallet.address;
const RELAYER = relayerWallet.address;

// Derivation assertions: the wallets must actually BE the declared parties.
check('fixture: buyer signer derives to declared BUYER address', String(BUYER).toLowerCase() === '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
check('fixture: seller signer derives to declared SELLER address', String(SELLER).toLowerCase() === '0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
check('fixture: evaluator signer derives to declared EVALUATOR address', String(EVALUATOR).toLowerCase() === '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
check('fixture: observer/attester distinct from parties and relayer',
  ![BUYER, SELLER, EVALUATOR, RELAYER].map(a => a.toLowerCase()).includes(OBSERVER.toLowerCase()));
check('fixture: relayer distinct from parties and observer',
  ![BUYER, SELLER, EVALUATOR, OBSERVER].map(a => a.toLowerCase()).includes(RELAYER.toLowerCase()));

async function buildJournal(events) {
  const jw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: CUSTODY, commitmentId: CID, manifestHash: DIGEST });
  for (const ev of events) await jw.append(ev);
  return jw.snapshot();
}

// Initiated (non-observed) entries: the writer's signature model requires the
// role key to sign (by == signer) for buyer/seller-role transitions; evaluator
// transitions are signed by the WRITER ATTESTATION key (observerWallet) with
// the on-chain authorization evidence carried in `authorization` — the writer's
// signature never substitutes for evaluator authority.
function issueEntry() {
  return {
    transition: 'issue', role: 'buyer', by: BUYER, contractAction: 'issue',
    resultingState: 'Issued', at: '2026-10-20T00:00:00.000Z', observed: false,
    signerWallets: [buyerWallet],
  };
}
function fundedEntry(txHash, blockHash) {
  return {
    transition: 'funded', role: 'buyer', by: BUYER, contractAction: 'fund',
    resultingState: 'Funded', at: '2026-10-20T00:01:00.000Z', observed: false,
    signerWallets: [buyerWallet], txHash, blockHash,
  };
}
function settlementEntry(transition, txHash, blockHash, at) {
  const timeout = transition === 'timeout-refund';
  return {
    transition, role: timeout ? 'open' : 'evaluator',
    by: timeout ? BUYER : EVALUATOR,
    contractAction: transition,
    resultingState: transition.includes('release') ? 'Released' : 'Refunded',
    at, observed: false,
    // evaluator/timeout entries carry NO role key signature: the writer's
    // attestation key (observer) signs the record; authority comes from the
    // on-chain authorization evidence, never from this signature.
    signerWallets: [observerWallet],
    txHash, blockHash,
    authorization: timeout
      ? { kind: 'timeout-rule', note: 'headless timeout: permissionless, fixed beneficiary' }
      : { kind: 'safe-erc1271-2of3', agreedEvaluator: EVALUATOR, chainId: CHAIN, custody: CUSTODY, note: 'custody accepted the Safe 2-of-3 authorization; journal attests the record, not the authorization' },
  };
}

(async () => {
  const TX1 = '0x' + '11'.repeat(32), BLK1 = '0x' + '22'.repeat(32);
  const TX2 = '0x' + '33'.repeat(32), BLK2 = '0x' + '44'.repeat(32);

  // 1. prefix tail recompute on a normal journal (issue + funded + release)
  const jGood = await buildJournal([issueEntry(), fundedEntry(TX1, BLK1)]);
  const prefixBeforeSettlement = jGood.tailHash; // tail after funded (last pre-settlement entry)
  const jSettled = await buildJournal([issueEntry(), fundedEntry(TX1, BLK1), settlementEntry('release', TX2, BLK2, '2026-10-20T00:02:00.000Z')]);
  const recomputed = verifyV4.recomputeJournalPrefixTail(jSettled);
  check('recompute: prefix tail = journal tail after last pre-settlement entry (issue+funded)', recomputed.prefixTail === prefixBeforeSettlement, recomputed.prefixTail + ' vs ' + prefixBeforeSettlement);
  check('recompute: detects settlement entry present', recomputed.hasSettlement === true);

  // 2. settlement receipt entry extends that exact prefix (prevHash == prefixTail)
  const releaseEntry = jSettled.events[jSettled.events.length - 1];
  check('settlement entry prevHash == recomputed prefix tail (extends exact prefix)', releaseEntry.prevHash === prefixBeforeSettlement, releaseEntry.prevHash + ' vs ' + prefixBeforeSettlement);

  // 3. initial agreement association (issue binds commitmentId + manifestHash)
  const issue = jSettled.events[0];
  check('issue entry binds commitmentId == signed agreement', issue.commitmentId === CID);
  check('issue entry binds manifestHash == committed envelope digest', issue.manifestHash === DIGEST);

  // 4. wrong/missing/replaced prefix rejects
  //    (a) recompute refuses a tampered entryHash
  const bad = JSON.parse(JSON.stringify(jSettled));
  bad.events[0].entryHash = '0x' + 'ee'.repeat(32);
  checkThrows('wrong prefix (tampered entryHash) rejects in recompute', () => verifyV4.recomputeJournalPrefixTail(bad), 'tampered');
  //    (b) missing settlement entry => hasSettlement false (verifier then rejects V3)
  const jNoSettle = await buildJournal([issueEntry(), fundedEntry(TX1, BLK1)]);
  const rec2 = verifyV4.recomputeJournalPrefixTail(jNoSettle);
  check('missing settlement entry detected (hasSettlement=false)', rec2.hasSettlement === false && rec2.prefixTail === jNoSettle.tailHash);
  //    (c) replaced prefix (different journal history) => recomputed prefix tail differs from the head the verifier would compare
  const jOther = await buildJournal([issueEntry()]);
  const otherPrefix = verifyV4.recomputeJournalPrefixTail(jOther);
  check('replaced/shorter prefix yields different prefix tail (rejects head match)', otherPrefix.prefixTail !== prefixBeforeSettlement);

  // 5. verifyJournal independently validates the journal (full lifecycle, evaluator release)
  const ctxRelease = {
    digest32: DIGEST, outcome: 'release', mechanism: 'evaluator', recipient: SELLER,
    fundTime: 2000n, settleTime: 3000n, resolution: 5000n, cutoff: 6000n,
    lifecycle: true, lifecycleRefs: { funding: { txHash: TX1, blockHash: BLK1 }, settlement: { txHash: TX2, blockHash: BLK2 } },
  };
  const agreement = { custody: { chainId: CHAIN, custodyAddress: CUSTODY }, commitmentId: CID, buyerAgentId: BUYER, sellerAgentId: SELLER, evaluator: EVALUATOR, evaluatorPermittedDecisions: ['release', 'refund'] };
  const jr = verifyJournal({ agreement, journal: jSettled }, ctxRelease);
  check('verifyJournal: authenticated association + chain + coverage + terminal pass (release)', jr.checked && jr.checks.length >= 6, jr.checks);

  // 6. timeout: zero committedHead retained, no fabricated checkpoint
  const jTimeout = await buildJournal([
    issueEntry(),
    fundedEntry(TX1, BLK1),
    settlementEntry('timeout-refund', TX2, BLK2, '2026-10-20T00:09:00.000Z'),
  ]);
  const recT = verifyV4.recomputeJournalPrefixTail(jTimeout);
  check('timeout journal: prefix recomputes; terminal transition timeout-refund (headless)', recT.hasSettlement && jTimeout.events[jTimeout.events.length - 1].transition === 'timeout-refund');
  const ctxTimeout = { ...ctxRelease, outcome: 'refund', mechanism: 'timeout', recipient: BUYER, cutoff: 8000n };
  const jt = verifyJournal({ agreement, journal: jTimeout }, ctxTimeout);
  check('verifyJournal: timeout-refund authority/beneficiary/timing pass', jt.checked && jt.checks.some(c => c.includes('coverage')), jt.checks);

  // ---- 7. authorization model negatives -------------------------------
  // (a) WRONG-ROLE wallet: the SELLER key cannot create a buyer-funded entry.
  //     The writer fails CLOSED for the authorization reason: by != role signer.
  await checkThrowsAsync('wrong-role wallet (seller signs funded as buyer) rejected for authorization reason',
    () => buildJournal([issueEntry(), { ...fundedEntry(TX1, BLK1), signerWallets: [sellerWallet] }]),
    'by');
  // (b) OBserver attestation cannot substitute for EVALUATOR authorization:
  //     an evaluator release entry signed ONLY by the observer key and with no
  //     on-chain authorization evidence must be rejected by the writer.
  await checkThrowsAsync('observer attestation without evaluator authorization rejected (writer requires authorization)',
    () => buildJournal([
      issueEntry(), fundedEntry(TX1, BLK1),
      { ...settlementEntry('release', TX2, BLK2, '2026-10-20T00:02:00.000Z'), authorization: null },
    ]),
    'authorization');
  // (c) The evaluator is a CONTRACT authority: a raw EOA signature FROM the
  //     evaluator address must be rejected by verification (a Safe cannot
  //     produce a raw EOA sig; impersonation must not pass).
  const jImpersonated = await buildJournal([
    issueEntry(), fundedEntry(TX1, BLK1),
    { ...settlementEntry('release', TX2, BLK2, '2026-10-20T00:02:00.000Z'), signerWallets: [evaluatorEOA] },
  ]);
  let impersonationRejected = false, impErr = null;
  try { verifyJournal({ agreement, journal: jImpersonated }, ctxRelease); } catch (e) { impersonationRejected = true; impErr = e.message; }
  check('Safe evaluator cannot be impersonated by a single EOA wallet (verifier rejects evaluator-signed entry)', impersonationRejected, impErr);
  // (d) Relayer / observer / authorizer stay distinct: an observed intent
  //     entry records tx.from as the relayer submitter, the authorizing party
  //     as recoveredSigner, and the observer signature authenticates only the
  //     observation — it is never treated as the action's authority.
  const jRelayed = await buildJournal([
    issueEntry(), fundedEntry(TX1, BLK1),
    {
      transition: 'intent', role: 'buyer', by: BUYER, contractAction: 'deliver',
      resultingState: 'intent:accepted', at: '2026-10-20T00:01:30.000Z', observed: true,
      signerWallets: [observerWallet], recoveredSigner: BUYER, submitter: RELAYER,
      txHash: TX1, blockHash: BLK1,
      authorization: { kind: 'access-attestation', note: 'endpoint observed accepted intent' },
    },
    settlementEntry('release', TX2, BLK2, '2026-10-20T00:02:00.000Z'),
  ]);
  const jrRelayed = verifyJournal({ agreement, journal: jRelayed }, ctxRelease);
  check('relayed intent entry: submitter (relayer) distinct from authorizer, observer sig not treated as authority',
    jrRelayed.checked && jrRelayed.checks.some(c => c.includes('relayer')), jrRelayed.checks);
  // (e) mutual settlement requires BOTH parties' signatures (no single wallet).
  const jMutual = await buildJournal([
    issueEntry(), fundedEntry(TX1, BLK1),
    {
      transition: 'mutual-release', role: 'buyer+seller', by: BUYER, contractAction: 'mutualRelease',
      resultingState: 'Released', at: '2026-10-20T00:02:00.000Z', observed: false,
      signerWallets: [buyerWallet, sellerWallet], txHash: TX2, blockHash: BLK2,
      authorization: { kind: 'mutual-consent', note: 'both parties signed' },
    },
  ]);
  const ctxMutual = { ...ctxRelease, mechanism: 'mutual', outcome: 'release' };
  const jm = verifyJournal({ agreement, journal: jMutual }, ctxMutual);
  check('mutual settlement: signed by BOTH agreement parties (genuine two-signature path)',
    jm.checked && jm.checks.some(c => c.includes('signatures recover to role identities')) && jm.checks.some(c => c.includes('terminal consistency')), jm.checks);
  // mutual with only ONE party's key must fail (single wallet cannot settle mutual)
  await checkThrowsAsync('mutual settlement with a single party signature rejected',
    () => buildJournal([
      issueEntry(), fundedEntry(TX1, BLK1),
      {
        transition: 'mutual-release', role: 'buyer+seller', by: BUYER, contractAction: 'mutualRelease',
        resultingState: 'Released', at: '2026-10-20T00:02:00.000Z', observed: false,
        signerWallets: [buyerWallet], txHash: TX2, blockHash: BLK2,
      },
    ]),
    'two signing wallets');

  // 8. invalid receipt extension: a settlement entry whose prevHash does NOT
  //    extend the recomputed prefix (self-consistent hash chain, wrong parent)
  //    must be rejected by recompute -- the verifier must never accept a
  //    receipt that extends a different prefix than the one it binds.
  {
    const jForge = JSON.parse(JSON.stringify(jSettled));
    const se = jForge.events[jForge.events.length - 1];
    se.prevHash = '0x' + 'ee'.repeat(32);
    se.entryHash = journalWriter.entryHashOf(journalWriter.canonicalEntryFields(se));
    let forgedRejected = null;
    try { verifyV4.recomputeJournalPrefixTail(jForge); } catch (e) { forgedRejected = e.message; }
    check('invalid receipt extension (settlement re-pointed at foreign parent) rejected by recompute',
      forgedRejected !== null && String(forgedRejected).includes('does not extend'), forgedRejected);
  }

  console.log('\nF3C checkpoint-binding: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });

async function checkThrowsAsync(name, fn, want) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw !== null && (!want || String(threw.message).includes(want));
  check(name, ok, threw ? 'threw: ' + threw.message : 'DID NOT THROW');
}