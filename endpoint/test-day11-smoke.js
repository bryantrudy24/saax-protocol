// Day 11 smoke — lifecycle drain pipe. Run: node endpoint/test-day11-smoke.js
process.env.SAAX_IDEMPOTENCY_STORE = 'memory';
const commitment = require('./commitment.js');
const requirement = require('./requirement.js');
const receipt = require('./receipt.js');
const recovery = require('./recovery.js');
const rails = require('./rails/index.js');
const railsX402 = require('./rails/x402.js');

let failures = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
};

// Item 1
const m = commitment.buildManifest({
  commitmentId: '0x' + 'ab'.repeat(32),
  buyerAgentId: '0x' + '01'.repeat(20),
  sellerAgentId: '0x' + '02'.repeat(20),
  capability: 'security-scan',
  price: { amount: '50000', currency: 'USDC', decimals: 6 },
  acceptanceCriteria: { type: 'hash', value: 'sha256:abc' },
  deadline: '2026-10-05T12:00:00Z',
  cancelCondition: 'buyer-cancel-before-delivery',
});
check('manifest hash is sha256: prefixed', /^sha256:[0-9a-f]{64}$/.test(m.manifestHash), m.manifestHash);
check('manifest signature is COSE_Sign1', m.signature.startsWith('COSE_Sign1:'), m.signature.slice(0, 20));
check('spend binding ok (same amount/currency)', commitment.checkSpendBinding(m, { amount: '50000', currency: 'USDC' }).ok);
check('spend binding denied (different amount)', !commitment.checkSpendBinding(m, { amount: '99999', currency: 'USDC' }).ok);
check('spend binding denied (different currency)', !commitment.checkSpendBinding(m, { amount: '50000', currency: 'ETH' }).ok);

// Item 2
const R = requirement.issueRequirement({ commitmentId: m.commitmentId, payee: '0x' + '02'.repeat(20), amt: '50000', cur: 'USDC' });
const R2 = requirement.issueRequirement({ commitmentId: m.commitmentId, payee: '0x' + '02'.repeat(20), amt: '50000', cur: 'USDC' });
check('R scheme is Payment', R.scheme === 'Payment', R.scheme);
check('R carries eta nonce', R.eta && R.eta.startsWith('eta_'), R.eta);
check('exactly one R per commitment', R2.fresh === false && R2.eta === R.eta);
const freshNonce2 = requirement.issueRequirement({ commitmentId: '0x' + 'cd'.repeat(32), payee: '0x' + '02'.repeat(20), amt: '100', cur: 'USDC' });
check('fresh R carries fresh nonce', freshNonce2.eta !== R.eta);
const c1 = requirement.consumeNonce(R.eta);
const c2 = requirement.consumeNonce(R.eta);
check('nonce consumed on first commit', c1.ok, JSON.stringify(c1));
check('replay of consumed nonce rejected', !c2.ok, c2.reason);

// Item 3
rails.register('x402', railsX402);
check('registry resolves x402', !!rails.resolve('x402'));
check('registry list has x402', rails.list().includes('x402'));
const cred = railsX402.realise(R);
check('x402 realise returns credential', cred && cred.rail === 'x402' && !!cred.payload);
check('x402 validate(cred, R) true', railsX402.validate(cred, R) === true);
const ref = railsX402.settle(cred);
check('x402 settle returns TransactionReference', ref && ref.railReference && ref.status === 'settled', ref && ref.railReference);

// Item 5
const rc = receipt.buildReceipt({
  commitmentId: m.commitmentId, manifestHash: m.manifestHash,
  payer: '0x' + '01'.repeat(20), payee: '0x' + '02'.repeat(20),
  amount: '50000', currency: 'USDC', rail: 'x402', railReference: ref.railReference,
});
check('receipt bound to manifest (noManifest=false)', rc.noManifest === false);
check('receipt signature is COSE_Sign1', rc.signature.startsWith('COSE_Sign1:'));
const leak = receipt.assertNoCredentialLeakage(rc);
check('receipt no credential leakage', leak.ok, leak.note);
const noManifestReceipt = receipt.buildReceipt({ commitmentId: '', manifestHash: null, payer: '0x' + '01'.repeat(20), payee: '0x' + '02'.repeat(20), amount: '50000', currency: 'USDC', rail: 'x402', railReference: '0xabc' });
check('spend without manifest marked noManifest', noManifestReceipt.noManifest === true);

// Item 6
let threw = false;
try { recovery.createEscrow(m, m); } catch (e) { threw = e.code === 'NOT_IMPLEMENTED'; }
check('recovery createEscrow throws NOT_IMPLEMENTED', threw);
threw = false;
try { recovery.raiseDispute('escrow-1', { type: 'hash', value: '0x123' }); } catch (e) { threw = e.code === 'NOT_IMPLEMENTED'; }
check('recovery raiseDispute throws NOT_IMPLEMENTED', threw);
check('recovery interface exported', ['createEscrow', 'proposeSettlement', 'acceptSettlement', 'raiseDispute'].every(f => typeof recovery[f] === 'function'));

console.log('\n' + (failures === 0 ? 'ALL DAY 11 SMOKE TESTS PASSED' : failures + ' DAY 11 SMOKE TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);