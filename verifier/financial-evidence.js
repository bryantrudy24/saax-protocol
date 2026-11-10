'use strict';
// Pure checks for the bounded financial self-test evidence profile. No DB/RPC.
const crypto = require('node:crypto');
const { verifyTypedData, keccak256, toUtf8Bytes } = require('ethers');
const EVIDENCE_TYPES = { FulfillmentEvidence: [
  { name: 'commitmentId', type: 'bytes32' },
  { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'evidenceDigest', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint256' },
] };
const VERDICT_TYPES = { EscrowVerdict: [
  { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' },
] };
const sha = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const eqAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
}
function verifyFulfillment(exp, agreement, commitmentId, commitmentDigest, action, blockTimestamp) {
  const checks = [];
  const check = (code, ok, detail) => checks.push({ code, status: ok ? 'PASS' : 'FAIL', detail });
  const evidence = exp.fulfillmentEvidence;
  const policy = exp.proposal.terms.policies.evidencePolicy || {};
  if (!evidence || !evidence.payload || !evidence.signature) {
    check('E_FULFILLMENT_PRESENT', false, 'A URI or export declaration is not signed fulfillment evidence.');
    return checks;
  }
  const p = evidence.payload;
  const expectedType = action === 'release' ? 'sha256-self-test-result' : 'sha256-self-test-nonfulfillment';
  check('E_FULFILLMENT_POLICY', Array.isArray(policy.requiredEvidenceTypes) &&
    policy.requiredEvidenceTypes.includes(expectedType) && policy.minimumCountPerType === 1 &&
    Array.isArray(policy.acceptedIssuers) && policy.acceptedIssuers.some(a => eqAddress(a, agreement.seller)),
    'The buyer-authorized evidence policy permits this exact evidence type and issuer.');
  check('E_FULFILLMENT_BINDINGS', p.schemaVersion === 'saax-financial-evidence-v1' &&
    p.type === expectedType && p.commitmentId === commitmentId && p.commitmentDigest === commitmentDigest &&
    p.requestDigest === exp.proposal.requestDigest && eqAddress(p.issuer, agreement.seller) &&
    p.domain === 'saax:financial-evidence:v1', 'Evidence identifies the exact request, commitment and authorized issuer.');
  const spec = agreement.fulfillment;
  const expectedOutput = spec && typeof spec.inputUtf8 === 'string' ? sha(spec.inputUtf8) : null;
  check('E_FULFILLMENT_CRITERION', spec && spec.algorithm === 'sha256' && spec.encoding === 'utf8' &&
    spec.expectedSha256 === expectedOutput &&
    (action === 'release' ? (p.result === 'fulfilled' && p.outputSha256 === expectedOutput) :
      (p.result === 'not-fulfilled' && p.outputSha256 === null && p.reason === 'authorized-test-nonfulfillment')),
    'Deterministic self-test only: release recomputes real output; refund is an authenticated nonfulfillment declaration, not external monitoring.');
  const digest = '0x' + sha(jcs(p));
  const domain = { name: 'SAAX Financial Evidence', version: '1', chainId: 84532, verifyingContract: agreement.custody.address };
  const issuedAt = BigInt(p.issuedAt || 0);
  check('E_FULFILLMENT_TIME', issuedAt <= blockTimestamp && blockTimestamp - issuedAt <= BigInt(policy.maxEvidenceAgeSeconds || 0),
    'Evidence existed within the signed maximum age at the execution block.');
  try {
    const signer = verifyTypedData(domain, EVIDENCE_TYPES,
      { commitmentId, commitmentDigest, evidenceDigest: digest, issuedAt }, evidence.signature);
    check('E_FULFILLMENT_SIGNATURE', eqAddress(signer, agreement.seller), 'Cryptographic issuer: ' + signer);
  } catch (error) { check('E_FULFILLMENT_SIGNATURE', false, error.message); }
  const terminal = action === 'release' ? exp.release : exp.refund;
  const attestation = terminal && terminal.evaluation;
  const EVALUATION_TYPES = { FinancialEvaluation: [
    { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'evidenceDigest', type: 'bytes32' }, { name: 'verdictDigest', type: 'bytes32' },
  ] };
  const verdict = terminal && terminal.verdict;
  const { TypedDataEncoder } = require('ethers');
  try {
    const verdictDigest = TypedDataEncoder.hash(verdict.domain, VERDICT_TYPES, {
      commitmentId, commitmentDigest, action, nonce: verdict.nonce, issuedAt: verdict.issuedAt });
    const signer = verifyTypedData({ name: 'SAAX Financial Evaluation', version: '1', chainId: 84532,
      verifyingContract: agreement.custody.address }, EVALUATION_TYPES,
      { commitmentId, commitmentDigest, evidenceDigest: digest, verdictDigest }, attestation.signature);
    check('E_EVALUATOR_EVIDENCE_BINDING', attestation.evidenceDigest === digest &&
      attestation.verdictDigest === verdictDigest && eqAddress(signer, agreement.evaluator.address),
      'A separate evaluator signature binds this exact evidence digest to the on-chain verdict. V1 verdict itself has no evidence field.');
  } catch (error) { check('E_EVALUATOR_EVIDENCE_BINDING', false, error.message); }
  return checks;
}
function verifyVerdictAuthorization({ verdict, evaluator, permittedDecisions, action, commitmentId, commitmentDigest, blockTimestamp, custody }) {
  const errors = [];
  const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: 84532, verifyingContract: custody };
  if (!permittedDecisions.includes(action) || verdict.action !== action) errors.push('VERDICT_FORBIDDEN_ACTION');
  if (jcs(verdict.domain) !== jcs(domain) || verdict.primaryType !== 'EscrowVerdict' || jcs(verdict.types) !== jcs(VERDICT_TYPES)) errors.push('VERDICT_DOMAIN_STRUCT');
  if (verdict.commitmentId !== commitmentId || verdict.commitmentDigest !== commitmentDigest) errors.push('VERDICT_BINDING');
  try {
    const issued = BigInt(verdict.issuedAt), ts = BigInt(blockTimestamp);
    if (issued > ts + 120n || ts > issued + 300n) errors.push('VERDICT_EXECUTION_TIME');
    const signer = verifyTypedData(domain, VERDICT_TYPES, { commitmentId, commitmentDigest, action,
      nonce: BigInt(verdict.nonce), issuedAt: issued }, { v: verdict.v, r: verdict.r, s: verdict.s });
    if (!eqAddress(signer, evaluator)) errors.push('VERDICT_UNAUTHORIZED_SIGNER');
  } catch (_) { errors.push('VERDICT_INVALID_SIGNATURE'); }
  return errors;
}
module.exports = { EVIDENCE_TYPES, VERDICT_TYPES, verifyFulfillment, verifyVerdictAuthorization, jcs, sha };
