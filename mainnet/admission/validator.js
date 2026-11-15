/**
 * SAAX Phase 1 — admission validator (isolated).
 *
 * Distinguishes four result categories:
 *   - structural validity (the agreement shape is internally consistent);
 *   - missing activation inputs (structurally valid but NOT activatable);
 *   - unsupported custody capabilities (the deployed custody cannot
 *     support what the agreement requires);
 *   - final admission decision (all profiles DISABLED for mainnet funding
 *     in this phase — a valid structure still fails the activation gate).
 *
 * NOT wired into production routes. No chain access. Strict and synthetic.
 */

'use strict';

const S = require('./schema');

// ————— result shaping —————
function result({ structural = false, missingActivation = [], unsupportedCapabilities = [], finalAdmission = false, errors = [], warnings = [] }) {
  return {
    structural,
    missingActivation,
    unsupportedCapabilities,
    finalAdmission,
    errors,
    warnings,
  };
}

// ————— collective helpers —————
function collectError(errors, code, message, field) {
  errors.push({ code, message, field: field || null });
}

function has(obj, key) {
  return obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function requireObj(errors, obj, field, code) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    collectError(errors, code, `expected object at ${field}`, field);
    return false;
  }
  return true;
}

function requireStr(errors, obj, field, code) {
  if (typeof obj !== 'string' || obj.length === 0) {
    collectError(errors, code, `expected non-empty string at ${field}`, field);
    return false;
  }
  return true;
}

function requireBool(errors, obj, field, code) {
  if (typeof obj !== 'boolean') {
    collectError(errors, code, `expected boolean at ${field}`, field);
    return false;
  }
  return true;
}

// ————— base profile validation —————
function validateObjectiveDigital(errors, p) {
  requireObj(errors, p.deliverable, 'deliverable', 'obj.missing_deliverable');
  if (p.deliverable) {
    requireStr(errors, p.deliverable.description, 'deliverable.description', 'obj.missing_description');
    if (!Array.isArray(p.deliverable.objectiveAcceptanceCriteria) || p.deliverable.objectiveAcceptanceCriteria.length === 0) {
      collectError(errors, 'obj.missing_acceptance_criteria', 'objectiveAcceptanceCriteria must be a non-empty array', 'deliverable.objectiveAcceptanceCriteria');
    }
  }
  requireObj(errors, p.evidenceSources, 'evidenceSources', 'obj.missing_evidence_sources');
  if (p.evidenceSources) {
    if (!Array.isArray(p.evidenceSources.issuers) || p.evidenceSources.issuers.length === 0) {
      collectError(errors, 'obj.missing_issuers', 'evidenceSources.issuers must be a non-empty array', 'evidenceSources.issuers');
    }
    requireStr(errors, p.evidenceSources.submissionMechanism, 'evidenceSources.submissionMechanism', 'obj.missing_submission_mechanism');
  }
  requireStr(errors, p.deliveryDeadline, 'deliveryDeadline', 'obj.missing_delivery_deadline');
  requireStr(errors, p.resolutionDeadline, 'resolutionDeadline', 'obj.missing_resolution_deadline');
  requireStr(errors, p.finalCutoff, 'finalCutoff', 'obj.missing_final_cutoff');
  // deadline ordering: delivery <= resolution <= finalCutoff (ISO UTC)
  if (isIsoAll(p.deliveryDeadline, p.resolutionDeadline, p.finalCutoff)) {
    if (p.deliveryDeadline > p.resolutionDeadline) {
      collectError(errors, 'obj.deadline_order_delivery_resolution', 'deliveryDeadline must be <= resolutionDeadline', 'deliveryDeadline');
    }
    if (p.resolutionDeadline > p.finalCutoff) {
      collectError(errors, 'obj.deadline_order_resolution_cutoff', 'resolutionDeadline must be <= finalCutoff', 'resolutionDeadline');
    }
  }
  requireObj(errors, p.buyerRefundTimeoutConsent, 'buyerRefundTimeoutConsent', 'obj.missing_buyer_refund_timeout_consent');
  if (p.buyerRefundTimeoutConsent) {
    if (p.buyerRefundTimeoutConsent.acceptedBySeller !== true) {
      collectError(errors, 'obj.missing_seller_timeout_consent', 'buyerRefundTimeoutConsent.acceptedBySeller must be exactly true (express seller acceptance)', 'buyerRefundTimeoutConsent.acceptedBySeller');
    }
    }
      // limited profile: the cutoff must not be extendable by retries/resubmission/dispute toggling
    if (p.cutoffExtensionRule !== 'none') {
    collectError(errors, 'obj.cutoff_extension_rule', 'cutoffExtensionRule must be "none" (retries/re-submissions/dispute toggling must not extend the cutoff)', 'cutoffExtensionRule');
  }
  // limited profile: partial awards and arbitrary recipient changes are outside v1
  if (p.partialAwards !== false) {
    collectError(errors, 'obj.partial_awards', 'partialAwards must be false (partial awards and arbitrary recipient changes are outside this profile)', 'partialAwards');
  }
  requireObj(errors, p.evaluator, 'evaluator', 'obj.missing_evaluator');
  if (p.evaluator) {
    requireAddress(errors, p.evaluator.address, 'evaluator.address', 'obj.invalid_evaluator_address');
    requireStr(errors, p.evaluator.authorityRef, 'evaluator.authorityRef', 'obj.missing_evaluator_authority_ref');
    if (!Array.isArray(p.evaluator.permittedOutcomes) || p.evaluator.permittedOutcomes.length === 0) {
      collectError(errors, 'obj.missing_permitted_outcomes', 'evaluator.permittedOutcomes must be a non-empty array', 'evaluator.permittedOutcomes');
    }
  }
}

function validatePhysicalDelivery(errors, p) {
  requireObj(errors, p.goodsSpecification, 'goodsSpecification', 'phy.missing_goods_spec');
  if (p.goodsSpecification) {
    requireStr(errors, p.goodsSpecification.description, 'goodsSpecification.description', 'phy.missing_goods_spec_description');
    requireStr(errors, p.goodsSpecification.quantity, 'goodsSpecification.quantity', 'phy.missing_quantity');
  }
  requireObj(errors, p.milestones, 'milestones', 'phy.missing_milestones');
  for (const k of ['shipment', 'inspection', 'acceptance', 'retention']) {
    if (!p.milestones || typeof p.milestones[k] !== 'object' || p.milestones[k] === null) {
      collectError(errors, 'phy.missing_milestone', `milestones.${k} required`, `milestones.${k}`);
    } else {
      requireStr(errors, p.milestones[k].deadline, `milestones.${k}.deadline`, 'phy.missing_milestone_deadline');
    }
  }
  requireObj(errors, p.carrierEvidence, 'carrierEvidence', 'phy.missing_carrier_evidence');
  requireObj(errors, p.conformityEvidence, 'conformityEvidence', 'phy.missing_conformity_evidence');
  requireObj(errors, p.transitRiskAllocation, 'transitRiskAllocation', 'phy.missing_transit_risk_allocation');
  requireObj(errors, p.inspectionAndRejection, 'inspectionAndRejection', 'phy.missing_inspection_rejection');
  if (p.inspectionAndRejection) {
    requireStr(errors, p.inspectionAndRejection.inspectionWindow, 'inspectionAndRejection.inspectionWindow', 'phy.missing_inspection_window');
  }
  requireObj(errors, p.partialDelivery, 'partialDelivery', 'phy.missing_partial_delivery');
  if (p.partialDelivery) {
    requireBool(errors, p.partialDelivery.permitted, 'partialDelivery.permitted', 'phy.missing_partial_permitted');
  }
  requireObj(errors, p.returnTerms, 'returnTerms', 'phy.missing_return_terms');
  if (p.returnTerms) {
    requireStr(errors, p.returnTerms.returnCostBearer, 'returnTerms.returnCostBearer', 'phy.missing_return_cost_bearer');
    requireStr(errors, p.returnTerms.returnEvidence, 'returnTerms.returnEvidence', 'phy.missing_return_evidence');
    requireStr(errors, p.returnTerms.salvageTreatment, 'returnTerms.salvageTreatment', 'phy.missing_salvage_treatment');
  }
  requireObj(errors, p.noRetainGoodsAndFullPayment, 'noRetainGoodsAndFullPayment', 'phy.missing_no_retain_rule');
  if (p.noRetainGoodsAndFullPayment) {
    requireStr(errors, p.noRetainGoodsAndFullPayment.rule, 'noRetainGoodsAndFullPayment.rule', 'phy.missing_no_retain_rule_text');
  }
  validateAdjudicationAndLongstop(errors, p);
}

function validateSubjectiveService(errors, p) {
  requireObj(errors, p.brief, 'brief', 'subj.missing_brief');
  if (p.brief) {
    requireStr(errors, p.brief.description, 'brief.description', 'subj.missing_brief_description');
    if (!Array.isArray(p.brief.deliverables) || p.brief.deliverables.length === 0) {
      collectError(errors, 'subj.missing_deliverables', 'brief.deliverables must be a non-empty array', 'brief.deliverables');
    }
  }
  requireObj(errors, p.evaluationRubric, 'evaluationRubric', 'subj.missing_rubric');
  requireObj(errors, p.objectiveRequirements, 'objectiveRequirements', 'subj.missing_objective_requirements');
  requireObj(errors, p.revisionLimits, 'revisionLimits', 'subj.missing_revision_limits');
  if (p.revisionLimits) {
    requireStr(errors, p.revisionLimits.maxRevisions, 'revisionLimits.maxRevisions', 'subj.missing_max_revisions');
  }
  requireObj(errors, p.clientDependencies, 'clientDependencies', 'subj.missing_client_dependencies');
  requireObj(errors, p.changeOrders, 'changeOrders', 'subj.missing_change_orders');
  requireObj(errors, p.earnedMilestones, 'earnedMilestones', 'subj.missing_earned_milestones');
  requireObj(errors, p.intellectualProperty, 'intellectualProperty', 'subj.missing_ip');
  requireObj(errors, p.namedExpert, 'namedExpert', 'subj.missing_named_expert');
  if (p.namedExpert) {
    requireStr(errors, p.namedExpert.identity, 'namedExpert.identity', 'subj.missing_expert_identity');
    requireStr(errors, p.namedExpert.replacementMechanism, 'namedExpert.replacementMechanism', 'subj.missing_expert_replacement');
  }
  if (!p.noAIModelFinalAdjudicator || p.noAIModelFinalAdjudicator.rule !== 'no unconstrained AI model as final adjudicator for the initial profile') {
    collectError(errors, 'subj.missing_no_ai_adjudicator', 'noAIModelFinalAdjudicator.rule must be the exact agreed rule', 'noAIModelFinalAdjudicator');
  }
  validateAdjudicationAndLongstop(errors, p);
}

function validateAdjudicationAndLongstop(errors, p) {
  requireObj(errors, p.adjudication, 'adjudication', 'adv.missing_adjudication');
  if (p.adjudication) {
    requireStr(errors, p.adjudication.mechanism, 'adjudication.mechanism', 'adv.missing_mechanism');
    requireStr(errors, p.adjudication.appointmentRule, 'adjudication.appointmentRule', 'adv.missing_appointment_rule');
    requireStr(errors, p.adjudication.replacementRule, 'adjudication.replacementRule', 'adv.missing_replacement_rule');
    requireStr(errors, p.adjudication.conflictsRule, 'adjudication.conflictsRule', 'adv.missing_conflicts_rule');
  }
  requireObj(errors, p.longstopDisposition, 'longstopDisposition', 'adv.missing_longstop');
  if (p.longstopDisposition) {
    requireStr(errors, p.longstopDisposition.at, 'longstopDisposition.at', 'adv.missing_longstop_at');
    requireStr(errors, p.longstopDisposition.allocation, 'longstopDisposition.allocation', 'adv.missing_longstop_allocation');
    if (!p.longstopDisposition.executor || !S.isAddress(p.longstopDisposition.executor)) {
      collectError(errors, 'adv.longstop_executor_not_address', 'longstopDisposition.executor must be an address', 'longstopDisposition.executor');
    }
  }
}

// ————— high-value assurance layer —————
function validateHighValueLayer(errors, layer) {
  requireStr(errors, layer.layer, 'layer.layer', 'hva.layer_id');
  requireObj(errors, layer.classificationRationale, 'layer.classificationRationale', 'hva.missing_classification');
  if (layer.classificationRationale) {
    if (!Array.isArray(layer.classificationRationale.reasons) || layer.classificationRationale.reasons.length === 0) {
      collectError(errors, 'hva.missing_reasons', 'classificationRationale.reasons must be non-empty', 'layer.classificationRationale.reasons');
    }
    requireExactInt(errors, layer.classificationRationale.maxExposure, 'layer.classificationRationale.maxExposure', 'hva.invalid_max_exposure');
  }
  requireObj(errors, layer.representatives, 'layer.representatives', 'hva.missing_representatives');
  if (layer.representatives) {
    requireAddress(errors, layer.representatives.buyerRep, 'layer.representatives.buyerRep', 'hva.invalid_buyer_rep');
    requireAddress(errors, layer.representatives.sellerRep, 'layer.representatives.sellerRep', 'hva.invalid_seller_rep');
  }
  requireObj(errors, layer.milestones, 'layer.milestones', 'hva.missing_milestones');
  if (layer.milestones && (!Array.isArray(layer.milestones.independentlyAcceptedMilestones) || layer.milestones.independentlyAcceptedMilestones.length === 0)) {
    collectError(errors, 'hva.missing_independent_milestones', 'milestones.independentlyAcceptedMilestones must be non-empty', 'layer.milestones');
  }
  requireObj(errors, layer.independentSpecialist, 'layer.independentSpecialist', 'hva.missing_specialist');
  if (layer.independentSpecialist) {
    requireStr(errors, layer.independentSpecialist.mechanism, 'layer.independentSpecialist.mechanism', 'hva.missing_specialist_mechanism');
    requireStr(errors, layer.independentSpecialist.replacementAppointment, 'layer.independentSpecialist.replacementAppointment', 'hva.missing_specialist_replacement');
  }
  requireObj(errors, layer.disputeCostReserve, 'layer.disputeCostReserve', 'hva.missing_dispute_reserve');
  if (layer.disputeCostReserve) {
    requireExactInt(errors, layer.disputeCostReserve.fundedReserve, 'layer.disputeCostReserve.fundedReserve', 'hva.invalid_funded_reserve');
    requireExactInt(errors, layer.disputeCostReserve.escalationBudget, 'layer.disputeCostReserve.escalationBudget', 'hva.invalid_escalation_budget');
  }
  requireStr(errors, layer.legalInstrumentReference, 'layer.legalInstrumentReference', 'hva.missing_legal_instrument');
  if (layer.activationGate && layer.activationGate.rule !== 'no activation merely because a nominal value threshold passes') {
    collectError(errors, 'hva.missing_activation_gate', 'activationGate.rule must be the exact agreed rule', 'layer.activationGate');
  }
  if (!layer.activationGate) {
    collectError(errors, 'hva.missing_activation_gate', 'activationGate required', 'layer.activationGate');
  }
}

// ————— shared primitive checks —————
function requireAddress(errors, v, field, code) {
  if (!S.isAddress(v)) collectError(errors, code, `invalid address at ${field}`, field);
}

function requireExactInt(errors, v, field, code) {
  if (!S.isExactIntegerString(v)) collectError(errors, code, `expected exact integer string at ${field}`, field);
}

function isIsoAll(...vals) {
  return vals.every((v) => typeof v === 'string' && S.ISO_UTC_RE.test(v));
}

// ————— accounting checks (principal / milestones / reserves / fees) —————
function validateAccounting(errors, p, principalAmount, asset) {
  if (!S.isExactIntegerString(principalAmount)) {
    collectError(errors, 'acc.invalid_principal', 'principal must be an exact integer string', 'principal');
    return;
  }
  const milestones = Array.isArray(p.milestones) ? p.milestones : (p.earnedMilestones && Array.isArray(p.earnedMilestones.milestones) ? p.earnedMilestones.milestones : null);
  if (milestones) {
    const amounts = milestones.map((m) => (m && typeof m === 'object' ? m.amount : undefined));
    const sum = S.sumExactInts(amounts);
    if (sum === null) {
      collectError(errors, 'acc.invalid_milestone_amount', 'milestone amounts must be exact integer strings', 'milestones');
    } else if (sum !== BigInt(principalAmount)) {
      collectError(errors, 'acc.milestone_total_mismatch', `milestone allocations ${sum} != principal ${principalAmount}`, 'milestones');
    }
  }
  // reserves and fees are separate from principal; if present they must be valid exact integers.
  if (has(p, 'fees') && !S.isExactIntegerString(p.fees)) {
    collectError(errors, 'acc.invalid_fees', 'fees must be an exact integer string', 'fees');
  }
  if (has(p, 'reserve') && !S.isExactIntegerString(p.reserve)) {
    collectError(errors, 'acc.invalid_reserve', 'reserve must be an exact integer string', 'reserve');
  }
  if (has(p, 'disputeCostReserve') && !S.isExactIntegerString(p.disputeCostReserve)) {
    collectError(errors, 'acc.invalid_dispute_reserve', 'disputeCostReserve must be an exact integer string', 'disputeCostReserve');
  }
  if (!S.isAsset(asset)) {
    collectError(errors, 'acc.invalid_asset', `asset must be an address or CAIP-19, got ${typeof asset}`, 'asset');
  }
}

// ————— capability classification —————
function classifyUnsupportedCapabilities(p, profile) {
  const unsupported = [];

  // 2-of-3 evaluator signing is a POLICY target (C.1); it is not supported by the
  // deployed custody contract (ecrecover-based). This is an unsupported capability
  // until the mechanism is reviewed/implemented in Phase 2+.
  if (p.evaluator && p.evaluator.signingMechanism && p.evaluator.signingMechanism === '2of3-multisig') {
    unsupported.push('custody.ecrecover.cannot-verify-contract-wallet-signatures');
  }

  // Advanced profiles with longstop defined ONLY by provider name (not executable).
  if ((profile === 'PHYSICAL_DELIVERY' || profile === 'SUBJECTIVE_SERVICE') && p.longstopDisposition) {
    const alloc = p.longstopDisposition.allocation || '';
    if (/provider|vendor|company|service/i.test(alloc) && !/execut|contract|script|address/i.test(alloc)) {
      unsupported.push('custody.longstop.provider-name-only-not-executable');
    }
  }
  return unsupported;
}

/**
 * Validate an admission request against the Phase 1 schema.
 * @param {object} req - { agreement: {...}, principal, ... }
 * @returns admission result
 */
function validateAdmission(req) {
  if (!req || typeof req !== 'object') {
    return result({ errors: [{ code: 'req.missing', message: 'request body required', field: null }] });
  }
  const errors = [];
  const warnings = [];

  const a = req.agreement;
  if (!requireObj(errors, a, 'agreement', 'req.missing_agreement')) {
    return result({ errors });
  }

  // policy version gating
  if (!has(a, 'policyVersion') || a.policyVersion !== S.SUPPORTED_POLICY) {
    collectError(errors, 'policy.unsupported_version', `unsupported policyVersion ${JSON.stringify(a.policyVersion)}; expected ${S.SUPPORTED_POLICY}`, 'policyVersion');
  }
  if (!has(a, 'policyDigest') || !S.HEX_DIGEST_RE.test(a.policyDigest || '')) {
    collectError(errors, 'policy.invalid_digest', 'policyDigest must be a 32-byte hex digest', 'policyDigest');
  }
  if (has(a, 'profilesDocVersion') && a.profilesDocVersion !== S.SUPPORTED_PROFILES_DOC) {
    collectError(errors, 'policy.unsupported_profiles_doc', `unsupported profilesDocVersion`, 'profilesDocVersion');
  }

  // profile identification
  const profile = a.profile;
  if (!Object.values(S.PROFILES).includes(profile)) {
    collectError(errors, 'profile.unknown', `unknown profile ${JSON.stringify(profile)}`, 'profile');
    return result({ errors });
  }

  // chain + custody
  if (typeof a.chainId !== 'number' || ![8453, 84532].includes(a.chainId)) {
    collectError(errors, 'chain.invalid_chain_id', `chainId must be 8453 or 84532, got ${JSON.stringify(a.chainId)}`, 'chainId');
  }
  if (typeof a.custodyAddress !== 'string' || !S.isAddress(a.custodyAddress)) {
    collectError(errors, 'custody.invalid_address', 'custodyAddress must be a valid address', 'custodyAddress');
  }

  // principal/asset basics
  const principal = a.principal !== undefined ? a.principal : (a.amount !== undefined ? a.amount : undefined);
  const asset = a.asset !== undefined ? a.asset : (a.paymentTerms && a.paymentTerms.asset);
  if (principal === undefined) {
    collectError(errors, 'acc.missing_principal', 'principal required', 'principal');
  }
  if (asset === undefined) {
    collectError(errors, 'acc.missing_asset', 'asset required', 'asset');
  }

  // parties (only syntactic here; identity mapping is out of schema scope)
  if (a.parties) {
    if (!S.isAddress(a.parties.buyer)) collectError(errors, 'party.invalid_buyer', 'parties.buyer must be a valid address', 'parties.buyer');
    if (!S.isAddress(a.parties.seller)) collectError(errors, 'party.invalid_seller', 'parties.seller must be a valid address', 'parties.seller');
  } else {
    collectError(errors, 'party.missing_parties', 'parties object required', 'parties');
  }

  // profile-specific
  switch (profile) {
    case 'OBJECTIVE_DIGITAL':
      validateObjectiveDigital(errors, a);
      validateAccounting(errors, a, principal, asset);
      break;
    case 'PHYSICAL_DELIVERY':
      validatePhysicalDelivery(errors, a);
      validateAccounting(errors, a, principal, asset);
      break;
    case 'SUBJECTIVE_SERVICE':
      validateSubjectiveService(errors, a);
      validateAccounting(errors, a, principal, asset);
      break;
    default:
      collectError(errors, 'profile.unknown', `unknown profile`, 'profile');
  }

  // high-value assurance layer (composable)
  const layer = a.highValueAssurance;
  if (layer !== undefined) {
    if (layer === null) {
      collectError(errors, 'hva.invalid_layer', 'highValueAssurance cannot be null; omit or provide the layer', 'highValueAssurance');
    } else {
      requireObj(errors, layer, 'highValueAssurance', 'hva.invalid_layer');
      if (layer && typeof layer === 'object') {
        if (layer.layer !== S.LAYERS.HIGH_VALUE_ASSURANCE) {
          collectError(errors, 'hva.layer_id', `highValueAssurance.layer must be ${S.LAYERS.HIGH_VALUE_ASSURANCE}`, 'layer.layer');
        }
        validateHighValueLayer(errors, layer);
      }
    }
  }

  // ————— categories —————
  const structural = errors.length === 0;

  // activation inputs: required for real funding, NOT decided in this phase
  const missingActivation = [];
  if (structural) {
    // mainnet deployment not authorized/deployed
    if (a.chainId === 8453) {
      missingActivation.push('activation.mainnet-custody-deployment');
      missingActivation.push('activation.mainnet-usdc-address');
    }
    // exposure limits are an owner decision (policy F.2 / readiness D.8)
    if (has(a, 'exposureLimits')) {
      if (!a.exposureLimits || typeof a.exposureLimits !== 'object' || !Array.isArray(a.exposureLimits.perPosition) || !Array.isArray(a.exposureLimits.aggregate)) {
        missingActivation.push('activation.exposure-limits-unresolved');
      }
    } else {
      missingActivation.push('activation.exposure-limits-unresolved');
    }
    // 2-of-3 evaluator mechanism not implemented (policy C.4-C.7)
    missingActivation.push('activation.2of3-evaluator-mechanism');
    // advanced profiles need legal instrument + executable longstop executor
    if (profile !== 'OBJECTIVE_DIGITAL') {
      missingActivation.push('activation.legal-instrument-review');
      missingActivation.push('activation.longstop-executor-identity');
    }
    if (layer && typeof layer === 'object') {
      if (!layer.disputeCostReserve || !S.isExactIntegerString(layer.disputeCostReserve.fundedReserve) || layer.disputeCostReserve.fundedReserve === '0') {
        missingActivation.push('activation.dispute-cost-reserve-funding');
      }
    }
  }

  // unsupported custody capabilities (deployed custody may not support what the agreement requires)
  const unsupportedCapabilities = classifyUnsupportedCapabilities(a, profile);

  // ————— final admission decision —————
  // ALL profiles disabled for mainnet funding in this phase.
  let finalAdmission = false;
  if (structural && missingActivation.length === 0 && unsupportedCapabilities.length === 0 && a.chainId === 84532) {
    // Even a complete, activation-complete fixture is denied mainnet admission
    // this phase. The gate is authority-scoped: no mainnet funding.
  }
  // The activation gate: no mainnet funding in this phase, full stop.
  finalAdmission = false;

  return result({
    structural,
    missingActivation,
    unsupportedCapabilities,
    finalAdmission,
    errors,
    warnings,
  });
}

module.exports = { validateAdmission, result };