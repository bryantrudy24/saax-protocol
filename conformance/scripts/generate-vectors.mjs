#!/usr/bin/env node
/**
 * Generates the SAAX conformance test vectors.
 * Produces canonical, self-consistent vector JSON under conformance/vectors/.
 * Run: node conformance/scripts/generate-vectors.mjs
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'conformance', 'vectors');

const CATS = ['commitments', 'signatures', 'hashes', 'lifecycle', 'evidence', 'authority', 'settlement', 'errors'];
for (const c of CATS) mkdirSync(join(OUT, c), { recursive: true });

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
function digest(obj) { return '0x' + createHash('sha256').update(JSON.stringify(canon(obj))).digest('hex'); }
function shortDigest(obj) { return digest(obj).slice(0, 18) + '...'; }

const buyer = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const signer = '0x3333333333333333333333333333333333333333';
const issuer = '0x5555555555555555555555555555555555555555';
const issuerBanned = '0x6666666666666666666666666666666666666666';
const authorityIssuer = '0x4444444444444444444444444444444444444444';

function baseCommitment(over = {}) {
  return {
    commitmentId: over.commitmentId || digest({ seed: 'commitment-basic' }),
    parties: over.parties || { buyer, seller, signer },
    requestedOutcome: over.requestedOutcome || { description: 'Deliver a cold-chain temperature report for shipment S-1042', category: 'data-delivery' },
    providerObligation: over.providerObligation || { description: 'Produce a signed temperature-reading report covering the full transit window', target: 'report.validity == full-transit' },
    commercialTerms: over.commercialTerms || { currency: 'USD', price: '50000', fee: '2500', feePayer: 'buyer' },
    paymentTerms: over.paymentTerms || { amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', settlementRequirement: { rail: null, amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: seller, chainId: 8453, deadline: '2026-10-07T00:00:00Z' } },
    acceptanceCriteria: over.acceptanceCriteria || [{ criterionId: 'c1', description: 'delivery temperature <= 5C', requiredEvidenceType: 'temperature-reading' }],
    verificationPolicy: over.verificationPolicy || { acceptedIssuers: [issuer], verificationScheme: 'cose', evaluationLogic: 'payload.maxTemperature <= 5', maxEvidenceAge: 3600, minimumEvidenceCount: 1 },
    evidenceRequirements: over.evidenceRequirements || { requiredTypes: ['temperature-reading'], minimumCountPerType: 1, maxAgeSeconds: 3600 },
    evidenceReferences: over.evidenceReferences || [],
    deadline: over.deadline || '2026-10-06T18:00:00Z',
    timeoutConditions: over.timeoutConditions || [{ condition: 'no_criterion_satisfied_by_deadline' }],
    failureConditions: over.failureConditions || [{ condition: 'provider_obligation_unfulfilled' }],
    recoveryPolicy: over.recoveryPolicy || { maxRetries: 2, retryIntervalSeconds: 300, refundOnFailure: true, compensationPercent: '5' },
    refundsCompensation: over.refundsCompensation || { refundOnTotalFailure: true, partialCreditPercent: '50' },
    disputeState: over.disputeState || { open: false },
    settlementReferences: over.settlementReferences || [],
    executionReceipts: over.executionReceipts || [],
    outcomeReceipt: over.outcomeReceipt ?? null,
    lifecycleState: over.lifecycleState || 'issued',
    signaturesProofs: over.signaturesProofs || { commitmentDigest: '0x' + 'a'.repeat(64), signatures: { buyer: '0x-sig', seller: '0x-sig' }, scheme: 'eip712', proofReferences: [] },
    auditChain: over.auditChain || [{ state: 'issued', transition: 'issue', at: '2026-10-06T09:00:00Z', by: buyer, prevHash: over.commitmentId || digest({ seed: 'commitment-basic' }), entryHash: '0x' + 'b'.repeat(64) }],
    finalResolution: over.finalResolution ?? null,
    ...over,
  };
}

let w = 0;
function save(cat, id, vec) {
  const p = join(OUT, cat, id + '.json');
  writeFileSync(p, JSON.stringify(vec, null, 2) + '\n');
  w++;
}

/* ============ COMMITMENTS (10) ============ */
const cBase = baseCommitment();
save('commitments', 'commitment-basic-001', { id: 'commitment-basic-001', description: 'A minimal valid commitment with required fields only', input: cBase, expected: { valid: true, state_after_issuance: 'issued' } });
const cSigned = baseCommitment();
cSigned.lifecycleState = 'accepted';
save('commitments', 'commitment-accepted-002', { id: 'commitment-accepted-002', description: 'A commitment all parties signed (accepted state)', input: cSigned, expected: { valid: true, state_after_issuance: 'accepted' } });
const cAuthority = baseCommitment();
cAuthority.authorityReference = 'urn:saax:proof:ap2-mandate:0x4444444444444444444444444444444444444444';
cAuthority.signaturesProofs.proofReferences = ['urn:saax:proof:ap2-mandate:0x4444444444444444444444444444444444444444'];
save('commitments', 'commitment-authority-ref-003', { id: 'commitment-authority-ref-003', description: 'A commitment referencing an external authority proof', input: cAuthority, expected: { valid: true, state_after_issuance: 'issued' } });
const cMissing = baseCommitment();
delete cMissing.commitmentId;
save('commitments', 'commitment-missing-id-004', { id: 'commitment-missing-id-004', description: 'Commitment missing the required commitmentId', input: cMissing, expected: { valid: false } });
const cMissingParty = baseCommitment();
delete cMissingParty.parties.seller;
save('commitments', 'commitment-missing-party-005', { id: 'commitment-missing-party-005', description: 'Commitment missing a required party', input: cMissingParty, expected: { valid: false } });
const cBadAmount = baseCommitment();
cBadAmount.paymentTerms.amount = '-50';
save('commitments', 'commitment-negative-amount-006', { id: 'commitment-negative-amount-006', description: 'Commitment with a negative amount', input: cBadAmount, expected: { valid: false } });
const cBadAddress = baseCommitment();
cBadAddress.parties.buyer = 'not-an-address';
save('commitments', 'commitment-invalid-address-007', { id: 'commitment-invalid-address-007', description: 'Commitment with an invalid party address', input: cBadAddress, expected: { valid: false } });
const cExpired = baseCommitment({ deadline: '2020-01-01T00:00:00Z' });
save('commitments', 'commitment-expired-deadline-008', { id: 'commitment-expired-deadline-008', description: 'Commitment with a deadline in the past', input: cExpired, expected: { valid: true, state_after_issuance: 'expired' } });
const cEmptyCriteria = baseCommitment({ acceptanceCriteria: [] });
save('commitments', 'commitment-empty-criteria-009', { id: 'commitment-empty-criteria-009', description: 'Commitment with no acceptance criteria (edge)', input: cEmptyCriteria, expected: { valid: true, state_after_issuance: 'issued' } });
const cNoSettle = baseCommitment();
delete cNoSettle.paymentTerms.settlementRequirement;
save('commitments', 'commitment-no-settlement-010', { id: 'commitment-no-settlement-010', description: 'Commitment without a settlement requirement (R unset)', input: cNoSettle, expected: { valid: false } });

/* ============ SIGNATURES (5) ============ */
save('signatures', 'signature-valid-001', { id: 'signature-valid-001', description: 'A valid buyer signature over the commitment digest', input: { commitmentId: cBase.commitmentId, party: 'buyer', signature: '0x-valid-buyer-sig', digest: cBase.signaturesProofs.commitmentDigest }, expected: { valid: true } });
save('signatures', 'signature-invalid-002', { id: 'signature-invalid-002', description: 'A malformed signature (wrong hex)', input: { commitmentId: cBase.commitmentId, party: 'buyer', signature: 'zzzz', digest: cBase.signaturesProofs.commitmentDigest }, expected: { valid: false } });
save('signatures', 'signature-wrong-signer-003', { id: 'signature-wrong-signer-003', description: 'Signature from a party not in the commitment', input: { commitmentId: cBase.commitmentId, party: 'seller', signature: '0x-valid-buyer-sig', digest: cBase.signaturesProofs.commitmentDigest }, expected: { valid: false } });
save('signatures', 'signature-expired-004', { id: 'signature-expired-004', description: 'A signature whose validity window has passed', input: { commitmentId: cBase.commitmentId, party: 'buyer', signature: '0x-expired-sig', digest: cBase.signaturesProofs.commitmentDigest, validUntil: '2020-01-01T00:00:00Z' }, expected: { valid: false } });
save('signatures', 'signature-wrong-digest-005', { id: 'signature-wrong-digest-005', description: 'Signature over the wrong digest', input: { commitmentId: cBase.commitmentId, party: 'buyer', signature: '0x-sig', digest: '0x' + 'f'.repeat(64) }, expected: { valid: false } });

/* ============ HASHES (5) ============ */
const h1 = baseCommitment();
const h1Digest = digest(h1);
save('hashes', 'hash-canonical-001', { id: 'hash-canonical-001', description: 'Canonical digest of the basis commitment', input: h1, expected: { hash: h1Digest } });
const h2 = baseCommitment();
h2.commercialTerms.price = '60000';
const h2Digest = digest(h2);
save('hashes', 'hash-price-change-002', { id: 'hash-price-change-002', description: 'Digest changes when price changes (field ordering canonical)', input: h2, expected: { hash: h2Digest } });
const h3 = baseCommitment();
h3.acceptanceCriteria = [{ description: 'delivery temperature <= 5C', criterionId: 'c1', requiredEvidenceType: 'temperature-reading' }];
const h3Digest = digest(h3);
save('hashes', 'hash-key-order-003', { id: 'hash-key-order-003', description: 'Digest is invariant to object key order (sorted canonicalization)', input: h3, expected: { hash: h3Digest } });
const h4 = baseCommitment();
h4.deadline = '2026-10-07T00:00:00Z';
const h4Digest = digest(h4);
save('hashes', 'hash-deadline-change-004', { id: 'hash-deadline-change-004', description: 'Digest changes with deadline', input: h4, expected: { hash: h4Digest } });
save('hashes', 'hash-empty-object-005', { id: 'hash-empty-object-005', description: 'Canonical hash of the empty object (sha256 of "{}")', input: {}, expected: { hash: '0x44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' } });

/* ============ LIFECYCLE (10) ============ */
const L = (from, to, allowed, extra = {}) => ({ input: { from: (extra.from || from), to }, expected: { allowed } });
save('lifecycle', 'lifecycle-issued-accepted-001', { id: 'lifecycle-issued-accepted-001', description: 'issued -> accepted (no authority ref, all signed)', ...L('issued', 'accepted', true) });
save('lifecycle', 'lifecycle-issued-authority-002', { id: 'lifecycle-issued-authority-002', description: 'issued -> authority_validated (valid proof)', ...L('issued', 'authority_validated', true) });
save('lifecycle', 'lifecycle-accepted-executing-003', { id: 'lifecycle-accepted-executing-003', description: 'accepted -> executing (provider starts)', ...L('accepted', 'executing', true) });
save('lifecycle', 'lifecycle-executing-evidence-pending-004', { id: 'lifecycle-executing-evidence-pending-004', description: 'executing -> evidence_pending (obligation complete)', ...L('executing', 'evidence_pending', true) });
save('lifecycle', 'lifecycle-verifying-fulfilled-005', { id: 'lifecycle-verifying-fulfilled-005', description: 'verifying -> fulfilled (all criteria satisfied)', ...L('verifying', 'fulfilled', true) });
save('lifecycle', 'lifecycle-fulfilled-settled-006', { id: 'lifecycle-fulfilled-settled-006', description: 'fulfilled -> settled (settlement realised)', ...L('fulfilled', 'settled', true) });
save('lifecycle', 'lifecycle-settled-finalized-007', { id: 'lifecycle-settled-finalized-007', description: 'settled -> finalized (audit complete)', ...L('settled', 'finalized', true) });
save('lifecycle', 'lifecycle-invalid-issued-fulfilled-008', { id: 'lifecycle-invalid-issued-fulfilled-008', description: 'issued -> fulfilled is INVALID', ...L('issued', 'fulfilled', false) });
save('lifecycle', 'lifecycle-invalid-terminal-009', { id: 'lifecycle-invalid-terminal-009', description: 'finalized -> any state is INVALID (terminal)', ...L('finalized', 'executing', false) });
save('lifecycle', 'lifecycle-invalid-expired-010', { id: 'lifecycle-invalid-expired-010', description: 'expired -> accepted is INVALID (terminal by time)', ...L('expired', 'accepted', false) });

/* ============ EVIDENCE (5) ============ */
const evBase = (over = {}) => ({
  evidenceId: over.evidenceId || '0x' + 'e'.repeat(64),
  evidenceType: 'temperature-reading',
  issuer: over.issuer || issuer,
  subject: buyer,
  issuanceTimestamp: over.issuanceTimestamp || '2026-10-06T12:00:00Z',
  contextReference: '0x' + 'c'.repeat(64),
  payload: over.payload || { maxTemperature: 3.1, probe: 'sensor-17' },
  payloadHash: 'sha256:' + createHash('sha256').update(JSON.stringify(over.payload || { maxTemperature: 3.1, probe: 'sensor-17' })).digest('hex'),
  provenance: { source: 'iot-hub', transport: 'https', traceId: 'tr-1' },
  signature: 'COSE_Sign1-test-valid',
  verificationScheme: 'cose',
  verificationMaterial: issuer,
  commitmentId: cBase.commitmentId,
  acceptanceCriterionId: 'c1',
  ...over,
});
save('evidence', 'evidence-satisfied-001', { id: 'evidence-satisfied-001', description: 'Valid fresh evidence from an accepted issuer satisfies the criterion', input: { evidence: evBase(), criterion: cBase.verificationPolicy, commitmentId: cBase.commitmentId }, expected: { outcome: 'satisfied' } });
const evNot = evBase({ payload: { maxTemperature: 9.9, probe: 'sensor-17' } });
evNot.payloadHash = 'sha256:' + createHash('sha256').update(JSON.stringify(evNot.payload)).digest('hex');
save('evidence', 'evidence-not-satisfied-002', { id: 'evidence-not-satisfied-002', description: 'Evidence whose evaluated logic is false -> not_satisfied', input: { evidence: evNot, criterion: cBase.verificationPolicy, commitmentId: cBase.commitmentId }, expected: { outcome: 'not_satisfied' } });
const evInsufficient = evBase();
evInsufficient.payload = { maxTemperature: 3.1, probe: 'sensor-17' };
evInsufficient.payloadHash = 'sha256:' + createHash('sha256').update(JSON.stringify(evInsufficient.payload)).digest('hex');
const criterionMin2 = { ...cBase.verificationPolicy, minimumEvidenceCount: 2 };
save('evidence', 'evidence-insufficient-003', { id: 'evidence-insufficient-003', description: 'One valid evidence but policy requires 2 -> insufficient_evidence', input: { evidence: evInsufficient, criterion: criterionMin2, commitmentId: cBase.commitmentId }, expected: { outcome: 'insufficient_evidence' } });
const evTampered = evBase();
evTampered.payloadHash = 'sha256:' + createHash('sha256').update(JSON.stringify({ maxTemperature: 99 })).digest('hex');
save('evidence', 'evidence-tampered-004', { id: 'evidence-tampered-004', description: 'Payload hash mismatch -> invalid evidence', input: { evidence: evTampered, criterion: cBase.verificationPolicy, commitmentId: cBase.commitmentId }, expected: { outcome: 'insufficient_evidence' } });
const evStale = evBase({ issuanceTimestamp: '2020-01-01T00:00:00Z' });
save('evidence', 'evidence-stale-005', { id: 'evidence-stale-005', description: 'Evidence older than maxEvidenceAge -> stale', input: { evidence: evStale, criterion: cBase.verificationPolicy, commitmentId: cBase.commitmentId }, expected: { outcome: 'insufficient_evidence' } });

/* ============ AUTHORITY (5) ============ */
const proofBase = (over = {}) => ({
  authorityProofId: over.authorityProofId || '0x' + 'a'.repeat(64),
  proofType: 'ap2-mandate',
  issuer: authorityIssuer,
  subject: buyer,
  scope: { actions: ['request-commitment', 'settle'], capability: 'data-delivery', amountMax: '250000', currency: 'USD' },
  validFrom: over.validFrom || '2026-10-06T00:00:00Z',
  validUntil: over.validUntil || '2026-10-07T00:00:00Z',
  signature: 'COSE_Sign1-test-valid',
  verificationScheme: 'cose',
  verificationMaterial: authorityIssuer,
  ...over,
});
save('authority', 'authority-valid-001', { id: 'authority-valid-001', description: 'A valid in-scope authority proof passes validation', input: { proof: proofBase(), commitmentId: cBase.commitmentId, requestedAction: 'request-commitment', amount: '50000', currency: 'USD' }, expected: { valid: true } });
const pExpired = proofBase({ validUntil: '2020-01-01T00:00:00Z' });
save('authority', 'authority-expired-002', { id: 'authority-expired-002', description: 'An expired authority proof is rejected', input: { proof: pExpired, commitmentId: cBase.commitmentId, requestedAction: 'request-commitment', amount: '50000', currency: 'USD' }, expected: { valid: false } });
const pOutScope = proofBase({ scope: { actions: ['read-only'], capability: 'data-delivery', amountMax: '100', currency: 'USD' } });
save('authority', 'authority-outscope-003', { id: 'authority-outscope-003', description: 'A proof out of scope for the requested action/amount is rejected', input: { proof: pOutScope, commitmentId: cBase.commitmentId, requestedAction: 'settle', amount: '50000', currency: 'USD' }, expected: { valid: false } });
const pBadSig = proofBase({ signature: 'COSE_Sign1-TAMPERED' });
save('authority', 'authority-badsig-004', { id: 'authority-badsig-004', description: 'A proof with a bad signature is rejected', input: { proof: pBadSig, commitmentId: cBase.commitmentId, requestedAction: 'request-commitment', amount: '50000', currency: 'USD' }, expected: { valid: false } });
const pMalformed = proofBase();
delete pMalformed.scope;
save('authority', 'authority-malformed-005', { id: 'authority-malformed-005', description: 'A structurally malformed proof is rejected', input: { proof: pMalformed, commitmentId: cBase.commitmentId, requestedAction: 'request-commitment', amount: '50000', currency: 'USD' }, expected: { valid: false } });

/* ============ SETTLEMENT (5) ============ */
save('settlement', 'settlement-x402-001', { id: 'settlement-x402-001', description: 'x402 rail resolves for an R with rail null (default rail)', input: { r: { rail: null, amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: seller, chainId: 8453, deadline: '2026-10-07T00:00:00Z' } }, expected: { rail: 'x402' } });
save('settlement', 'settlement-mpp-002', { id: 'settlement-mpp-002', description: 'MPP rail resolves when explicitly requested', input: { r: { rail: 'mpp', amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: seller, chainId: 8453, deadline: '2026-10-07T00:00:00Z' } }, expected: { rail: 'mpp' } });
save('settlement', 'settlement-unsupported-003', { id: 'settlement-unsupported-003', description: 'An unsupported rail is rejected', input: { r: { rail: 'ach', amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: seller, chainId: 8453, deadline: '2026-10-07T00:00:00Z' } }, expected: { rail: 'ach' } });
save('settlement', 'settlement-invalid-credential-004', { id: 'settlement-invalid-credential-004', description: 'A credential without a signature fails validation against R', input: { credential: { amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: seller }, r: { rail: 'x402', amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: seller, chainId: 8453, deadline: '2026-10-07T00:00:00Z' } }, expected: { valid: false } });
save('settlement', 'settlement-realise-005', { id: 'settlement-realise-005', description: 'realise(R) produces a credential referencing the rail', input: { r: { rail: 'x402', amount: '50000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: seller, chainId: 8453, deadline: '2026-10-07T00:00:00Z' } }, expected: { rail: 'x402' } });

/* ============ ERRORS (10) ============ */
const errCases = [
  ['errors-invalid-commitment-001', 'VAL_INVALID_COMMITMENT', { missing: 'commitmentId' }],
  ['errors-required-field-002', 'VAL_REQUIRED_FIELD', { missing: 'parties' }],
  ['errors-malformed-signature-003', 'VAL_MALFORMED_SIGNATURE', { badSignature: true }],
  ['errors-invalid-transition-004', 'ST_INVALID_TRANSITION', { invalidTransition: true }],
  ['errors-expired-005', 'ST_EXPIRED_COMMITMENT', { expired: true }],
  ['errors-missing-proof-006', 'AUTH_MISSING_PROOF', { missingProof: true }],
  ['errors-insufficient-evidence-007', 'EVI_INSUFFICIENT_EVIDENCE', { insufficientEvidence: true }],
  ['errors-unsupported-rail-008', 'SET_UNSUPPORTED_RAIL', { unsupportedRail: true }],
  ['errors-rate-limited-009', 'SYS_RATE_LIMITED', { rateLimited: true }],
  ['errors-kill-switch-010', 'SYS_KILL_SWITCH', { killSwitch: true }],
];
for (const [id, code, input] of errCases) {
  save('errors', id, { id, description: `Input that must produce ${code}`, input, expected: { error_code: code } });
}

console.log(`Generated ${w} vectors under ${OUT}`);