/**
 * SAAX Phase 1 — synthetic admission fixtures (valid + invalid).
 * All fixtures are synthetic; none reference real funded positions.
 */

'use strict';

const POLICY = 'saax-custody-policy-v1';
const POLICY_DIGEST = '0x' + 'ab'.repeat(32);
const PROFILES_DOC = 'saax-transaction-profiles-v1';

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const EVALUATOR = '0x3333333333333333333333333333333333333333';
const CUSTODY = '0x4444444444444444444444444444444444444444';
const ASSET = '0x5555555555555555555555555555555555555555';
const REP = '0x6666666666666666666666666666666666666666';

const PRINCIPAL = '1000000'; // 1e6 base units (e.g. 1 USDC w/ 6 decimals)
const FEE = '10000';
const RESERVE = '50000';

// ————— shared valid base —————
function baseAgreement(profile) {
  const a = {
    policyVersion: POLICY,
    policyDigest: POLICY_DIGEST,
    profilesDocVersion: PROFILES_DOC,
    profile,
    chainId: 84532,
    custodyAddress: CUSTODY,
    asset: ASSET,
    principal: PRINCIPAL,
    parties: { buyer: BUYER, seller: SELLER },
  };
  if (profile === 'OBJECTIVE_DIGITAL') {
    a.deliverable = {
      description: 'Deliver a signed temperature report covering the transit window',
      objectiveAcceptanceCriteria: ['report.validity == full-transit', 'report.signed == true'],
    };
    a.evidenceSources = {
      issuers: ['0x7777777777777777777777777777777777777777'],
      submissionMechanism: 'api',
      minimumEvidenceCount: 1,
      maxEvidenceAge: 3600,
    };
    a.deliveryDeadline = '2026-11-01T00:00:00Z';
    a.resolutionDeadline = '2026-11-03T00:00:00Z';
    a.finalCutoff = '2026-11-05T00:00:00Z';
    a.buyerRefundTimeoutConsent = {
      acceptedBySeller: true,
      cutoff: a.finalCutoff,
      effect: 'refund to original buyer at/after cutoff',
    };
    a.evaluator = {
      address: EVALUATOR,
      authorityRef: 'eval-authority-001',
      permittedOutcomes: ['release', 'refund'],
      nonce: '1',
      expiry: '2026-11-06T00:00:00Z',
    };
    a.cutoffExtensionRule = 'none';
    a.partialAwards = false;
  }
  return a;
}

function physicalAgreement() {
  const a = baseAgreement('PHYSICAL_DELIVERY');
  Object.assign(a, {
    goodsSpecification: { description: '10 units of sensor S-1042', quantity: '10', unit: 'unit', identityOrSerials: ['SN-0001'] },
    milestones: {
      shipment: { deadline: '2026-11-01T00:00:00Z', evidence: 'carrier-label' },
      inspection: { deadline: '2026-11-06T00:00:00Z', evidence: 'inspection-report' },
      acceptance: { deadline: '2026-11-08T00:00:00Z', evidence: 'acceptance-note' },
      retention: { deadline: '2026-11-15T00:00:00Z', evidence: 'retention-proof' },
    },
    carrierEvidence: { requiredTypes: ['carrier-tracking'], acceptedIssuers: ['0x7777777777777777777777777777777777777777'] },
    conformityEvidence: { requiredTypes: ['inspection-report'], acceptedIssuers: ['0x8888888888888888888888888888888888888888'] },
    transitRiskAllocation: { riskBearer: 'seller', insuranceResponsible: 'seller', ownershipTransferPoint: 'delivery' },
    incoterm: { code: 'DAP', version: '2020', namedPlace: 'Rotterdam' },
    inspectionAndRejection: { inspectionWindow: '48h', rejectionProcedure: 'notice + evidence', evidenceForRejection: 'photo + report' },
    partialDelivery: { permitted: true, accountingRule: 'pro-rata release of accepted units' },
    returnTerms: { returnCostBearer: 'buyer', returnEvidence: 'return-tracking', salvageTreatment: 'buyer-keeps-with-credit' },
    noRetainGoodsAndFullPayment: { rule: 'buyer may not retain goods and full payment; refund is conditional on return or agreed disposition' },
    adjudication: { mechanism: 'named-expert', appointmentRule: 'mutual selection', replacementRule: 'prearranged list', conflictsRule: 'disclose + disqualify' },
    longstopDisposition: { at: '2026-12-01T00:00:00Z', allocation: 'refund to buyer net of accepted-work value', executor: '0x9999999999999999999999999999999999999999' },
    evaluator: { address: EVALUATOR, authorityRef: 'eval-authority-002', permittedOutcomes: ['release', 'refund'], nonce: '1', expiry: '2026-11-20T00:00:00Z' },
  });
  return a;
}

function subjectiveAgreement() {
  const a = baseAgreement('SUBJECTIVE_SERVICE');
  Object.assign(a, {
    brief: { description: 'Design a landing page', references: ['ref-a'], deliverables: ['figma', 'html'], formats: ['figma', 'html'] },
    evaluationRubric: { criteria: [{ name: 'matches brief', weight: '60', pass: true }], weights: '100', passingThreshold: '70' },
    objectiveRequirements: { list: ['deliverables exist', 'formats correct'] },
    subjectiveJudgment: { rubric: 'quality per rubric', judgeRef: 'named-expert-1' },
    revisionLimits: { maxRevisions: '2', cureWindow: '72h' },
    clientDependencies: { neededInputs: ['brand assets'], feedbackWindows: '48h', delaysAttributableToClient: 'clock stop' },
    changeOrders: { procedure: 'written + mutual', budgetImpactRule: 'agreed delta' },
    earnedMilestones: { milestones: [{ id: 'm1', amount: '400000' }, { id: 'm2', amount: '600000' }], acceptanceDependentAmounts: ['m2'], cancellationCompensation: 'completed-work-value' },
    intellectualProperty: { usageTerms: 'license on full payment', paymentRelationship: 'IP transfers on final release' },
    namedExpert: { identity: '0x9999999999999999999999999999999999999999', appointmentMechanism: 'mutual selection', replacementMechanism: 'prearranged list' },
    noAIModelFinalAdjudicator: { rule: 'no unconstrained AI model as final adjudicator for the initial profile' },
    adjudication: { mechanism: 'named-expert', appointmentRule: 'mutual', replacementRule: 'prearranged', conflictsRule: 'disclose' },
    longstopDisposition: { at: '2026-12-01T00:00:00Z', allocation: 'refund to buyer net of earned milestones', executor: '0x9999999999999999999999999999999999999999' },
    evaluator: { address: EVALUATOR, authorityRef: 'eval-authority-003', permittedOutcomes: ['release', 'refund'], nonce: '1', expiry: '2026-11-20T00:00:00Z' },
  });
  return a;
}

function hvaLayer() {
  return {
    layer: 'HIGH_VALUE_ASSURANCE',
    baseProfile: null, // set by caller
    classificationRationale: { reasons: ['irreversibility-high', 'loss-exposure-major'], maxExposure: '1000000' },
    representations: undefined,
    representatives: { buyerRep: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sellerRep: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    milestones: { independentlyAcceptedMilestones: ['m1', 'm2'], retentionRules: '10% retained to acceptance' },
    independentSpecialist: { mechanism: 'independent-specialist', conflictsRule: 'disclose', replacementAppointment: 'prearranged list' },
    disputeCostReserve: { fundedReserve: RESERVE, escalationBudget: '20000' },
    legalInstrumentReference: 'instrument-ref-hva-001',
    activationGate: { rule: 'no activation merely because a nominal value threshold passes' },
    maxExposure: '1000000',
  };
}

module.exports = {
  POLICY, POLICY_DIGEST, PROFILES_DOC,
  BUYER, SELLER, EVALUATOR, CUSTODY, ASSET, REP,
  PRINCIPAL, FEE, RESERVE,
  baseAgreement, physicalAgreement, subjectiveAgreement, hvaLayer,
};