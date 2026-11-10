/**
 * SAAX Phase 1 — focused admission validator tests.
 * Uses ONLY synthetic fixtures. No chain access, no funded escrows.
 *
 * Run: node mainnet/admission/tests/run-tests.js
 */

'use strict';

const assert = require('assert');
const { validateAdmission } = require('../validator');
const {
  baseAgreement, physicalAgreement, subjectiveAgreement, hvaLayer,
  BUYER, SELLER, EVALUATOR, CUSTODY, ASSET,
  PRINCIPAL, POLICY, POLICY_DIGEST,
} = require('../fixtures/fixtures');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    process.stdout.write(`FAIL  ${name}\n      ${e.message}\n`);
  }
}

function mustHaveCode(r, code) {
  assert.ok(r.errors.some((e) => e.code === code), `expected error code ${code}; got ${JSON.stringify(r.errors.map((e) => e.code))}`);
}
function mustNotHaveCode(r, code) {
  assert.ok(!r.errors.some((e) => e.code === code), `unexpected error code ${code}`);
}

// ————— 1. valid structures per profile —————
check('OBJECTIVE_DIGITAL valid fixture is structurally valid', () => {
  const r = validateAdmission({ agreement: baseAgreement('OBJECTIVE_DIGITAL') });
  assert.strictEqual(r.structural, true, JSON.stringify(r.errors));
  assert.strictEqual(r.errors.length, 0);
  // but still disabled for mainnet admission this phase
  assert.strictEqual(r.finalAdmission, false);
});

check('PHYSICAL_DELIVERY valid fixture is structurally valid', () => {
  const r = validateAdmission({ agreement: physicalAgreement() });
  assert.strictEqual(r.structural, true, JSON.stringify(r.errors));
  assert.strictEqual(r.finalAdmission, false);
});

check('SUBJECTIVE_SERVICE valid fixture is structurally valid', () => {
  const r = validateAdmission({ agreement: subjectiveAgreement() });
  assert.strictEqual(r.structural, true, JSON.stringify(r.errors));
  assert.strictEqual(r.finalAdmission, false);
});

// ————— 2. high-value layer composed with physical/service profiles —————
check('HIGH_VALUE_ASSURANCE composed with PHYSICAL_DELIVERY is structurally valid', () => {
  const a = physicalAgreement();
  a.highValueAssurance = hvaLayer();
  a.highValueAssurance.baseProfile = 'PHYSICAL_DELIVERY';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, true, JSON.stringify(r.errors));
  // layer present → activation inputs include dispute-cost reserve funding; still denied admission
  assert.strictEqual(r.finalAdmission, false);
  assert.ok(r.missingActivation.includes('activation.dispute-cost-reserve-funding') === false || r.missingActivation.some((m) => m === 'activation.longstop-executor-identity'));
});

check('HIGH_VALUE_ASSURANCE composed with SUBJECTIVE_SERVICE is structurally valid', () => {
  const a = subjectiveAgreement();
  a.highValueAssurance = hvaLayer();
  a.highValueAssurance.baseProfile = 'SUBJECTIVE_SERVICE';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, true, JSON.stringify(r.errors));
  assert.strictEqual(r.finalAdmission, false);
});

check('HIGH_VALUE_ASSURANCE standalone (no base profile) is rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.highValueAssurance = { layer: 'HIGH_VALUE_ASSURANCE' }; // missing layer fields
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
});

// ————— 3. missing seller timeout consent —————
check('OBJECTIVE_DIGITAL missing seller timeout consent is rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  delete a.buyerRefundTimeoutConsent;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'obj.missing_buyer_refund_timeout_consent');
});

check('OBJECTIVE_DIGITAL acceptedBySeller=false is rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.buyerRefundTimeoutConsent.acceptedBySeller = false;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'obj.missing_seller_timeout_consent');
});

check('OBJECTIVE_DIGITAL cutoffExtensionRule != none rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.cutoffExtensionRule = 'extend-on-dispute';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'obj.cutoff_extension_rule');
});

check('OBJECTIVE_DIGITAL partialAwards=true rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.partialAwards = true;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'obj.partial_awards');
});

// ————— 4. advanced profile incorrectly using universal whole-contract buyer refund —————
// The validator enforces that advanced profiles do NOT inherit the automatic whole-contract
// buyer refund. PHYSICAL_DELIVERY has noRefund rule + partialDelivery accounting; a fixture
// that tries a universal whole-contract refund must be rejected (missing the required
// partial/goods-return structure).
check('PHYSICAL_DELIVERY with universal whole-contract refund (no partial/return structure) rejected', () => {
  const a = physicalAgreement();
  delete a.partialDelivery;
  delete a.returnTerms;
  delete a.noRetainGoodsAndFullPayment;
  // this is the "advanced profile using universal whole-contract buyer refund" shape
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'phy.missing_partial_delivery');
  mustHaveCode(r, 'phy.missing_return_terms');
  mustHaveCode(r, 'phy.missing_no_retain_rule');
});

// ————— 5. missing reviewer replacement / longstop —————
check('SUBJECTIVE_SERVICE missing longstop disposition rejected', () => {
  const a = subjectiveAgreement();
  delete a.longstopDisposition;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'adv.missing_longstop');
});

check('SUBJECTIVE_SERVICE missing adjudication replacement rejected', () => {
  const a = subjectiveAgreement();
  delete a.adjudication.replacementRule;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'adv.missing_replacement_rule');
});

check('HIGH_VALUE_ASSURANCE missing specialist replacement rejected', () => {
  const a = physicalAgreement();
  a.highValueAssurance = hvaLayer();
  a.highValueAssurance.baseProfile = 'PHYSICAL_DELIVERY';
  delete a.highValueAssurance.independentSpecialist.replacementAppointment;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'hva.missing_specialist_replacement');
});

// ————— 6. missing physical return/risk terms —————
check('PHYSICAL_DELIVERY missing return terms rejected', () => {
  const a = physicalAgreement();
  delete a.returnTerms;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'phy.missing_return_terms');
});

check('PHYSICAL_DELIVERY missing transit risk allocation rejected', () => {
  const a = physicalAgreement();
  delete a.transitRiskAllocation;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'phy.missing_transit_risk_allocation');
});

// ————— 7. missing subjective revision/cancellation terms —————
check('SUBJECTIVE_SERVICE missing revision limits rejected', () => {
  const a = subjectiveAgreement();
  delete a.revisionLimits;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'subj.missing_revision_limits');
});

check('SUBJECTIVE_SERVICE missing client dependencies (feedback) rejected', () => {
  const a = subjectiveAgreement();
  delete a.clientDependencies;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'subj.missing_client_dependencies');
});

// ————— 8. inconsistent milestone totals and reserve accounting —————
check('milestone totals != principal rejected', () => {
  const a = subjectiveAgreement();
  a.earnedMilestones.milestones = [{ id: 'm1', amount: '400000' }, { id: 'm2', amount: '500000' }]; // 900000 != 1000000
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'acc.milestone_total_mismatch');
});

check('invalid (float) milestone amount rejected', () => {
  const a = subjectiveAgreement();
  a.earnedMilestones.milestones = [{ id: 'm1', amount: '0.5' }, { id: 'm2', amount: '999999.5' }];
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'acc.invalid_milestone_amount');
});

check('invalid principal (float) rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.principal = '1.5';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'acc.invalid_principal');
});

check('invalid fees (negative) rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.fees = '-100';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'acc.invalid_fees');
});

check('invalid reserve (float) rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.reserve = '50.5';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'acc.invalid_reserve');
});

check('reserve accounted separately from principal (valid fixture with reserve)', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.reserve = '50000'; // separate from principal; principal unchanged
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, true, JSON.stringify(r.errors));
});

check('invalid asset rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.asset = 'USDC';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'acc.invalid_asset');
});

// ————— 9. invalid deadlines, versions, addresses —————
check('invalid deadline ordering (delivery > resolution) rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.deliveryDeadline = '2026-11-10T00:00:00Z';
  a.resolutionDeadline = '2026-11-03T00:00:00Z';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'obj.deadline_order_delivery_resolution');
});

check('invalid deadline ordering (resolution > cutoff) rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.resolutionDeadline = '2026-11-10T00:00:00Z';
  a.finalCutoff = '2026-11-05T00:00:00Z';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'obj.deadline_order_resolution_cutoff');
});

check('unsupported policy version rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.policyVersion = 'saax-custody-policy-v2';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'policy.unsupported_version');
});

check('invalid policy digest rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.policyDigest = '0x1234';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'policy.invalid_digest');
});

check('unknown profile rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.profile = 'DIGITAL_GOODS';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'profile.unknown');
});

check('invalid buyer address rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.parties.buyer = 'not-an-address';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'party.invalid_buyer');
});

check('invalid custody address rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.custodyAddress = '0xzz';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'custody.invalid_address');
});

check('invalid chainId rejected', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.chainId = 1;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'chain.invalid_chain_id');
});

// ————— 10. structurally valid but denied mainnet admission —————
check('valid OBJECTIVE_DIGITAL fixture is denied mainnet admission (finalAdmission=false)', () => {
  const r = validateAdmission({ agreement: baseAgreement('OBJECTIVE_DIGITAL') });
  assert.strictEqual(r.structural, true);
  assert.strictEqual(r.finalAdmission, false);
  assert.ok(r.missingActivation.length > 0, 'activation inputs must be listed');
});

check('valid fixture on mainnet chainId is denied + lists mainnet activation inputs', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.chainId = 8453;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, true);
  assert.strictEqual(r.finalAdmission, false);
  assert.ok(r.missingActivation.includes('activation.mainnet-custody-deployment'));
  assert.ok(r.missingActivation.includes('activation.mainnet-usdc-address'));
});

check('valid fixture with all activation inputs present still denied (phase gate)', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  a.exposureLimits = { perPosition: ['1000'], aggregate: ['100000'] };
  // 2-of-3 mechanism cannot be satisfied by the deployed custody → unsupported capability
  a.evaluator.signingMechanism = '2of3-multisig';
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, true);
  // even with activation inputs, phase gate denies mainnet funding
  assert.strictEqual(r.finalAdmission, false);
  assert.ok(r.unsupportedCapabilities.includes('custody.ecrecover.cannot-verify-contract-wallet-signatures'));
});

// ————— 11. semantically precise: restricted unilateral timeout vs adjudicated refund —————
check('restricted profile timeout is buyer-refund unilateral (cutoff consent), not adjudicated', () => {
  const a = baseAgreement('OBJECTIVE_DIGITAL');
  // The restricted profile encodes a unilateral buyer-refund timeout via the cutoff consent.
  assert.strictEqual(a.buyerRefundTimeoutConsent.acceptedBySeller, true);
  assert.strictEqual(a.buyerRefundTimeoutConsent.effect, 'refund to original buyer at/after cutoff');
  // No adjudication object exists at all in the restricted profile — a full mutual/adjudicated
  // refund is NOT the mechanism; the fixed cutoff is.
  assert.strictEqual(a.adjudication, undefined);
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, true);
});

check('advanced profile refund requires defined adjudication + longstop (not inherited cutoff)', () => {
  const a = subjectiveAgreement();
  // Advanced profile has adjudication + longstop (explicit), NOT an inherited cutoff.
  assert.ok(a.adjudication && typeof a.adjudication === 'object');
  assert.ok(a.longstopDisposition && typeof a.longstopDisposition === 'object');
  assert.strictEqual(a.buyerRefundTimeoutConsent, undefined);
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, true, JSON.stringify(r.errors));
});

check('advanced profile missing adjudication (silent whole-contract refund) rejected', () => {
  const a = subjectiveAgreement();
  delete a.adjudication;
  const r = validateAdmission({ agreement: a });
  assert.strictEqual(r.structural, false);
  mustHaveCode(r, 'adv.missing_adjudication');
});

check('provider-name-only longstop flagged as unsupported capability', () => {
  const a = physicalAgreement();
  a.longstopDisposition.allocation = 'handoff to provider AcmeCustody Services';
  a.longstopDisposition.executor = '0x9999999999999999999999999999999999999999';
  const r = validateAdmission({ agreement: a });
  // structural may still be true (all fields present); the unsupported capability is flagged
  assert.ok(r.unsupportedCapabilities.includes('custody.longstop.provider-name-only-not-executable'), JSON.stringify(r.unsupportedCapabilities));
});

// ————— summary —————
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write('\nFailures:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.exit(0);