// SAAX Protocol — Day 5: Test harness (all five required outputs + live-branch proof)
//
// Run:  node endpoint/test-day5.js
// Exits non-zero on any failed assertion. Prints PASS/FAIL per test.
// (async IIFE: ethers v6 signMessage is async)
const crypto = require('crypto');
const { Wallet } = require('ethers');
const x402 = require('./x402.js');
const router = require('./router.js');
const settle = require('./settle.js');

(async () => {

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
}

const registrations = router.loadRegistrations();

// ---- TEST 1: security scan routes x402 for SYBIL + Apex Leviathan, mock receipt
console.log('\n== TEST 1: security scan -> x402 for SYBIL + Apex Leviathan with mock receipt ==');
const secCands = [
  { agent_id: 84667, name: 'SYBIL', match: 0.5, score: 12, payTo: '0xea8a3a831c1c0a96c4c26698dfed6397d1885cc4' },
  { agent_id: 85380, name: 'Apex Leviathan', match: 0.5, score: 12, payTo: '0x87ef068dee858b0fb6894aa6978174c54b3a05d4' },
  { agent_id: 51085, name: 'Surf AI', match: 0, score: 91, payTo: '0x820c5091B047b652888F6aA7E1eE615d99f7c8CD' },
  { agent_id: 1380, name: 'Captain Dackie', match: 0, score: 91, payTo: '0xF9D1D63F362bBF1EE08aB9AcB36fe74aFC48d5f1' },
  { agent_id: 2290, name: 'Agent 2290', match: 0, score: 91, payTo: '0x715Dc035fFb97dD7bB4095C6670138BA05BB4E6d' },
];
const r1 = router.routeMatches(secCands, 'security scan', registrations);
const sybil = r1.routed.find(x => x.agent_id === 84667);
const apex = r1.routed.find(x => x.agent_id === 85380);
check('SYBIL routed to x402', sybil && sybil.selectedRail === 'x402', sybil && sybil.selectedRail);
check('Apex Leviathan routed to x402', apex && apex.selectedRail === 'x402', apex && apex.selectedRail);
check('SYBIL rail = exact (fixed-price)', sybil && sybil.railDetail.scheme === 'exact', sybil && sybil.railDetail.scheme);
check('Apex rail = upto (usage-based)', apex && apex.railDetail.scheme === 'upto', apex && apex.railDetail.scheme);

const s1 = settle.runPayments(r1.routed, r1.excluded, 'security scan');
const receiptSybil = s1.settlements.find(x => x.agentId === 84667);
const receiptApex = s1.settlements.find(x => x.agentId === 85380);
check('SYBIL receipt status settled', receiptSybil && receiptSybil.status === 'settled', receiptSybil && receiptSybil.status);
check('SYBIL receipt rail x402', receiptSybil && receiptSybil.rail === 'x402');
check('SYBIL receipt txHash mock_<uuid>', receiptSybil && /^mock_[0-9a-f-]{36}$/.test(receiptSybil.txHash), receiptSybil && receiptSybil.txHash);
check('SYBIL receipt scheme exact', receiptSybil && receiptSybil.scheme === 'exact');
check('Apex receipt scheme upto (settled amount <= authorized max)',
  receiptApex && receiptApex.scheme === 'upto' && Number(receiptApex.amount) <= Number(receiptApex ? x402.rawUnits(0.05) : 0),
  receiptApex && receiptApex.amount + ' <= ' + x402.rawUnits(0.05));

// ---- TEST 2: MPP-only supplier selects MPP, stubbed, no x402 attempted
console.log('\n== TEST 2: MPP-only supplier routes MPP and stubs (no x402 attempt) ==');
const mppCands = [
  { agent_id: 51085, name: 'Surf AI', match: 0.5, score: 91, payTo: '0x820c5091B047b652888F6aA7E1eE615d99f7c8CD' },
];
const r2 = router.routeMatches(mppCands, 'savings routing', registrations);
const surf = r2.routed.find(x => x.agent_id === 51085);
check('Surf AI routed to MPP', surf && surf.selectedRail === 'mpp', surf && surf.selectedRail);
check('Surf AI has no x402 detail', !(surf && surf.railDetail), surf && JSON.stringify(surf.railDetail));
const s2 = settle.runPayments(r2.routed, r2.excluded, 'savings routing');
const stub = s2.settlements.find(x => x.agentId === 51085);
check('MPP settlement stubbed', stub && stub.status === 'stubbed', stub && stub.status);
check('MPP stub reason = Sprint 1 mock mode', stub && stub.reason === 'Sprint 1 mock mode', stub && stub.reason);
check('MPP settlement carries rail mpp', stub && stub.rail === 'mpp');

// ---- TEST 3: no-rail supplier excluded with reason unsupported
console.log('\n== TEST 3: no-rail supplier excluded (unsupported) ==');
const noRailCands = [
  { agent_id: 1380, name: 'Captain Dackie', match: 0.5, score: 91, payTo: '0xF9D1D63F362bBF1EE08aB9AcB36fe74aFC48d5f1' },
  { agent_id: 2290, name: 'Agent 2290', match: 0.5, score: 91, payTo: '0x715Dc035fFb97dD7bB4095C6670138BA05BB4E6d' },
];
const r3 = router.routeMatches(noRailCands, 'general errand', registrations);
check('no-rail supplier excluded', r3.excluded.length === 2, 'excluded=' + r3.excluded.length);
check('routed list empty for no-rail suppliers', r3.routed.length === 0, 'routed=' + r3.routed.length);
const exclReason = r3.excluded[0] && r3.excluded[0].excludedReason;
check('excluded reason = unsupported', /neither x402 nor MPP/.test(exclReason || ''), exclReason);
const log3 = r3.decisionLog.find(x => x.agentId === 1380);
check('decision log: selectedRail unsupported', log3 && log3.selectedRail === 'unsupported', log3 && log3.selectedRail);

// ---- TEST 4: mock branch accepts, live branch rejects the same payload
console.log('\n== TEST 4: SAAX_X402_VERIFY_MODE mock accepts; live branch rejects the same payload ==');
const req4 = {
  scheme: 'exact',
  amount: x402.rawUnits(0.05),
  asset: x402.USDC_ADDRESS.base,
  networkName: 'base',
  network: x402.NETWORK_CAIP2.base,
  payTo: '0xea8a3a831c1c0a96c4c26698dfed6397d1885cc4',
  maxTimeoutSeconds: 60,
};
const mockPayload = x402.signMockPayload(req4);
x402.setVerifyMode('mock'); // simulate SAAX_X402_VERIFY_MODE=mock
const vMock = x402.verifyPaymentPayload(mockPayload, req4);
check('mock branch accepts mock signature', vMock.verified === true, JSON.stringify(vMock));
x402.setVerifyMode('live'); // force live branch (SAAX_X402_VERIFY_MODE=live)
process.env.SAAX_X402_PRIVATE_KEY = '0x' + '11'.repeat(32); // a THROWAWAY test key, never a real wallet
const vLiveMock = x402.verifyPaymentPayload(mockPayload, req4);
check('live branch REJECTS the mock (zero) signature', vLiveMock.verified === false,
  vLiveMock.reason ? vLiveMock.reason.slice(0, 80) : 'no reason');

// live branch accepts a GENUINE signature (proves the branch is real crypto, not a stub)
const wallet = new Wallet(process.env.SAAX_X402_PRIVATE_KEY);
const liveReq = { ...req4, payTo: wallet.address }; // ensure canonical signer == from
const livePayload = await x402.signLivePayload(liveReq);
const vLiveReal = await x402.verifyPaymentPayload(livePayload, liveReq);
check('live branch verifies a genuine ECDSA signature', vLiveReal.verified === true, JSON.stringify(vLiveReal));
process.env.SAAX_X402_PRIVATE_KEY = ''; // clean up
x402.setVerifyMode(null); // back to env default

// ---- TEST 5: mock receipt matches documented live receipt structure field-for-field
console.log('\n== TEST 5: mock receipt structure === documented live receipt structure ==');
const LIVE_RECEIPT_FIELDS = ['rail', 'scheme', 'amount', 'asset', 'network', 'payTo', 'txHash', 'status'];
const mockReceipt = x402.settleX402Mock(mockPayload);
const missingLive = LIVE_RECEIPT_FIELDS.filter(f => !(f in mockReceipt));
check('mock receipt carries every documented live receipt field', missingLive.length === 0, 'missing: ' + missingLive.join(','));
check('receipt rail = x402', mockReceipt.rail === 'x402');
check('receipt status = settled', mockReceipt.status === 'settled');
check('receipt amount is raw units string', typeof mockReceipt.amount === 'string' && /^\d+$/.test(mockReceipt.amount), mockReceipt.amount);
check('receipt txHash mock_<uuid> format', /^mock_[0-9a-f-]{36}$/.test(mockReceipt.txHash), mockReceipt.txHash);

// ---- Extra: decision log shape for every supplier in every test
console.log('\n== DECISION LOG (all routed suppliers) ==');
for (const d of [...r1.decisionLog, ...r2.decisionLog, ...r3.decisionLog]) {
  console.log('  ' + JSON.stringify(d));
}

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST HARNESS CRASHED: ' + e); process.exit(2); });