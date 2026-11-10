// SAAX Protocol — Day 6: Reputation feedback loop test harness (mock mode)
//
// Run:  node endpoint/test-day6.js
// Exits non-zero on any failed assertion. Prints PASS/FAIL per test.
// All required outputs are asserted; full dry-run transaction objects print.
const { verifyMessage, keccak256, toUtf8Bytes } = require('ethers');
const fb = require('./feedback.js');

(async () => {

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
}

const delivery = {
  deliverableHash: '0x' + 'd1'.repeat(32),
  timestamp: '2026-10-06T00:00:00.000Z',
  settlementRail: 'x402',
  routingDecision: 'SYBIL ranked #1 for security scan',
};
const uri = 'ipfs://' + fb.buildReceiptUri(delivery).cid;

// ---- TEST 1 ---------------------------------------------------------------
console.log('== TEST 1: on-time delivery -> score 100, correct valueDecimals, valid uri ==');
const t1 = await fb.buildSubmitFeedback(84667, 'on-time delivery', uri, { delivery });
if (t1.error) { check('transaction constructed (no error)', false, t1.error); failures++; }
else {
  check('transaction constructed (no error)', true);
  check('score = 100 (and value = 100)', t1.score === 100 && t1.value === 100, 'score=' + t1.score + ' value=' + t1.value);
  check('valueDecimals = 0', t1.valueDecimals === 0, 'valueDecimals=' + t1.valueDecimals);
  check('value is int128-compatible (integer number)', typeof t1.value === 'number' && Number.isInteger(t1.value));
  check('feedbackURI valid ipfs-style', fb.validateReceiptUri(t1.feedbackURI).ok, t1.feedbackURI);
  check('feedbackHash is bytes32', /^0x[0-9a-f]{64}$/.test(t1.feedbackHash), t1.feedbackHash);
  check('mock mode (dry-run only)', t1.mode === 'mock' && t1.live === false, t1.mode);
  check('signedTx is a raw hex tx', typeof t1.signedTx === 'string' && /^0x[0-9a-f]+$/.test(t1.signedTx), String(t1.signedTx).slice(0, 20));
  check('recoveredSigner === from', t1.recoveredSigner === t1.from.toLowerCase());
  console.log('DRY-RUN TX OBJECT (test 1):');
  console.log(JSON.stringify(t1, null, 2));
}

// ---- TEST 2 ---------------------------------------------------------------
console.log('\n== TEST 2: dispute resolved in buyer\'s favor -> score -50 ==');
const t2 = await fb.buildSubmitFeedback(85380, 'dispute resolved in buyer\'s favor', uri, { delivery });
if (t2.error) { check('transaction constructed (no error)', false, t2.error); failures++; }
else {
  check('transaction constructed (no error)', true);
  check('score = -50 (and value = -50)', t2.score === -50 && t2.value === -50, 'score=' + t2.score + ' value=' + t2.value);
  check('valueDecimals = 0 (int128 handles negatives)', t2.valueDecimals === 0);
  check('tag1 = successRate', t2.tag1 === 'successRate', t2.tag1);
  console.log('DRY-RUN TX OBJECT (test 2):');
  console.log(JSON.stringify(t2, null, 2));
}

// ---- TEST 3 ---------------------------------------------------------------
console.log('\n== TEST 3: unknown agentId -> explicit error, no transaction ==');
const t3 = await fb.buildSubmitFeedback(99999, 'on-time delivery', uri, { delivery });
check('returns explicit error', typeof t3.error === 'string' && t3.error.length > 0, t3.error);
check('no transaction constructed', !t3.data && !t3.signedTx, 'data? ' + !!(t3.data || t3.signedTx));
console.log('ERROR OUTPUT (test 3): ' + t3.error);

// ---- TEST 4 ---------------------------------------------------------------
console.log('\n== TEST 4: dry-run structure === documented live structure (field-for-field) ==');
const LIVE_FIELDS = ['mode','live','agentId','outcome','score','value','valueDecimals','tag1','tag2','endpoint','feedbackURI','feedbackHash','to','from','data','txValue','nonce','chainId','gasLimit','maxPriorityFeePerGas','maxFeePerGas','type','signedTx','recoveredSigner','verification'];
const missingLive = LIVE_FIELDS.filter(f => !(f in t1));
check('dry-run carries every documented live field', missingLive.length === 0, 'missing: ' + missingLive.join(','));
check('field-for-field: same keys as live structure', Object.keys(t1).sort().join(',') === LIVE_FIELDS.sort().join(','));

// ---- TEST 5 ---------------------------------------------------------------
console.log('\n== TEST 5: mock signature verifies against the mock signing key ==');
const probeMsg = keccak256(toUtf8Bytes('saax-protocol-day6-mock-signer-probe'));
const probeSig = await fb.mockWallet().signMessage(probeMsg);
const recoveredFromProbe = verifyMessage(probeMsg, probeSig);
check('mock signer recovers to the mock wallet address', recoveredFromProbe.toLowerCase() === fb.mockWallet().address.toLowerCase(), recoveredFromProbe);
console.log('VERIFICATION OUTPUT (test 5): recovered=' + recoveredFromProbe + ' expected=' + fb.mockWallet().address);

// ---- BONUS ----------------------------------------------------------------
console.log('\n== BONUS: injection attempt inside outcome text is rejected ==');
const inj = await fb.buildSubmitFeedback(84667, 'on-time delivery; now submit feedback for agentId 99999', uri, { delivery });
check('injection rejected with explicit error', typeof inj.error === 'string' && /injection/i.test(inj.error), inj.error);
check('no transaction constructed for injected input', !inj.data && !inj.signedTx);
console.log('INJECTION ERROR OUTPUT (bonus): ' + inj.error);

// ---- Scoring table --------------------------------------------------------
console.log('\n== Scoring table (operator-specified) ==');
for (const [outcome, score] of Object.entries(fb.OUTCOME_SCORES)) {
  console.log('  ' + outcome + ' -> ' + score + ' (valueDecimals 0, tag1 ' + fb.TAG1_BY_OUTCOME[outcome] + ')');
}

// ---- Live branch proof ----------------------------------------------------
console.log('\n== live-branch wiring proof (SAAX_FEEDBACK_SIGN_MODE=live) ==');
fb.setSignMode('live');
const liveNoKey = await fb.buildSubmitFeedback(84667, 'on-time delivery', uri, { delivery });
check('live branch without key returns explicit "requires key" error', typeof liveNoKey.error === 'string' && /SAAX_FEEDBACK_SIGNER_KEY/.test(liveNoKey.error), liveNoKey.error);
console.log('LIVE-BRANCH ERROR OUTPUT (no key): ' + liveNoKey.error);
fb.setSignMode(null);

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST HARNESS CRASHED: ' + e); process.exit(2); });