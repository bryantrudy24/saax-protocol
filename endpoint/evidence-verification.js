// SAAX Protocol — MCP Lifecycle Phase 4C/4D: Cryptographic evidence verification
// + proof issuer trust policies (CJS).
//
// Connects the existing evidence.js verification engine to the Phase 3 durable
// evidence pipeline. Every evidence submission that reaches the 'verified'
// verdict passes the full check chain before the verdict is durably stored:
//
//   1. Envelope structure + schema/version validity
//   2. Commitment identifier binding
//   3. Acceptance-criteria binding
//   4. Evidence content hash / integrity reference
//   5. Signature validity (per verificationScheme)
//   6. Verified signer identity (EIP-712 recovery for eip712 scheme)
//   7. Signer authorization and permitted role (checked by the RPC)
//   8. Timestamp and validity constraints
//   9. Replay protection (idempotency binding)
//  10. Policy and evaluator requirements
//  11. Evidence immutability and durable attribution
//
// Trust policy (Phase 4D): issuer allowlists apply ONLY where the trust model
// requires an approved issuer (cose/jws third-party evidence). Self-signed
// wallet-ownership proofs (eip712) remain open — a valid signature is verified
// cryptographically but NEVER automatically means fulfillment success; the
// commitment's acceptance-criterion policy + evaluator authorization are the
// gating authorities.
'use strict';

const crypto = require('crypto');
const evidence = require('./evidence.js');

const POLICY_VERSION = 'saax-evidence-v1';
const ALLOWED_SCHEMES = new Set(['eip712', 'cose', 'jws']);
// Third-party schemes require an approved issuer; configured via env
// SAAX_EVIDENCE_ISSUER_ALLOWLIST (comma-separated addresses) or the
// per-criterion acceptedIssuers from the commitment's acceptance policy.
function issuerAllowlist() {
  const raw = process.env.SAAX_EVIDENCE_ISSUER_ALLOWLIST || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Run the full cryptographic + structural verification chain over an evidence
 * envelope against a commitment context. Returns the verdict and the policy
 * version used. Does NOT persist anything (caller stores the verdict).
 *
 * @param {object} envelope  the evidence envelope (as submitted)
 * @param {object} context   { commitmentId, criterionId, acceptanceCriteria, expectedIssuer? }
 */
async function verifyEvidenceCrypto(envelope, context = {}) {
  const checks = {};

  // 1. Structure + schema/version
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, stage: 'structure', reason: 'evidence envelope is required', checks: { structure: false } };
  }
  checks.structure = !!(
    envelope.evidenceId && envelope.evidenceType && envelope.issuer &&
    envelope.payload && envelope.payloadHash && envelope.verificationScheme
  );
  if (!checks.structure) {
    return { ok: false, stage: 'structure', reason: 'envelope missing required fields (evidenceId, evidenceType, issuer, payload, payloadHash, verificationScheme)', checks };
  }

  // Schemas: only recognized schemes.
  checks.scheme = ALLOWED_SCHEMES.has(envelope.verificationScheme);
  if (!checks.scheme) {
    return { ok: false, stage: 'scheme', reason: 'verificationScheme must be one of eip712|cose|jws', checks };
  }

  // 2. Commitment binding
  checks.commitmentBinding = !!context.commitmentId && envelope.commitmentId === context.commitmentId;
  if (!checks.commitmentBinding) {
    return { ok: false, stage: 'binding', reason: 'evidence commitmentId does not match the commitment', checks };
  }

  // 3. Acceptance-criteria binding
  checks.criterionBinding = !context.criterionId || envelope.acceptanceCriterionId === context.criterionId;
  if (!checks.criterionBinding) {
    return { ok: false, stage: 'binding', reason: 'evidence acceptanceCriterionId does not match the criterion', checks };
  }

  // 4. Content hash / integrity reference
  const payloadStr = JSON.stringify(envelope.payload || {});
  const computed = 'sha256:' + crypto.createHash('sha256').update(payloadStr, 'utf8').digest('hex');
  checks.hash = String(envelope.payloadHash || '') === computed ||
    String(envelope.payloadHash || '') === computed.replace('sha256:', '');
  if (!checks.hash) {
    return { ok: false, stage: 'integrity', reason: 'payloadHash does not match the computed payload hash', checks };
  }

  // 5. Signature validity per scheme (delegates to evidence.js)
  try {
    // Phase 5B: forward an optional trusted-key resolver for cose/jws. When
    // absent, the verifier uses the default env-backed store (SAAX_COSE_JWS_
    // TRUSTED_KEYS_B64) — which fails closed if unset.
    const sigOpts = { expectIssuer: context.expectedIssuer };
    if (typeof context.resolver === 'function') sigOpts.resolver = context.resolver;
    const sig = await evidence.verifyEvidenceSignature(envelope, sigOpts);
    checks.signature = !!(sig && sig.ok === true);
    if (!checks.signature) {
      return { ok: false, stage: 'signature', reason: (sig && sig.reason) || 'invalid signature', checks };
    }
  } catch (err) {
    return { ok: false, stage: 'signature', reason: 'signature verification threw: ' + String(err.message || err), checks };
  }

  // 6. Verified signer identity (eip712): verifyEvidenceSignature already
  //    recovers-to-issuer, so signer identity is established by the signature
  //    stage. Record it as satisfied for the audit trail.
  checks.signer = true; // recovery-to-issuer enforced in stage 'signature' above

  // 8. Timestamp / validity constraints (issuance must not be absurdly future)
  if (envelope.issuanceTimestamp) {
    const t = Date.parse(envelope.issuanceTimestamp);
    checks.timestamp = !Number.isNaN(t) && t <= Date.now() + 5 * 60 * 1000;
    if (!checks.timestamp) {
      return { ok: false, stage: 'timestamp', reason: 'issuanceTimestamp is invalid or in the future', checks };
    }
  } else {
    checks.timestamp = true;
  }

  // 7+11. Issuer trust policy (Phase 4D)
  // - eip712 (self-signed wallet proof): open — verified cryptographically above.
  // - cose/jws (third-party attestation): issuer must be on the configured
  //   allowlist OR match the commitment's acceptedIssuers for the criterion.
  if (envelope.verificationScheme === 'cose' || envelope.verificationScheme === 'jws') {
    const issuer = String(envelope.issuer || '').toLowerCase();
    const allow = issuerAllowlist();
    const criterionIssuers = (context.acceptanceCriteria && context.acceptanceCriteria.acceptedIssuers) || [];
    const accepted = allow.includes(issuer) || criterionIssuers.map((s) => String(s).toLowerCase()).includes(issuer);
    checks.issuerTrust = accepted;
    if (!checks.issuerTrust) {
      return { ok: false, stage: 'issuer', reason: 'issuer not on the approved allowlist for scheme ' + envelope.verificationScheme, checks };
    }
  } else {
    checks.issuerTrust = true;
  }

  return {
    ok: true,
    stage: 'ok',
    policyVersion: POLICY_VERSION,
    checks: Object.assign({}, checks, {
      signerAuthorization: 'enforced-by-rpc', // durable registry check inside the RPC transaction
      replayProtection: 'idempotency-fingerprint', // bound by submit_evidence
      evaluatorRequirement: 'evaluator-role-required', // verify_evidence enforces
    }),
  };
}

module.exports = { verifyEvidenceCrypto, POLICY_VERSION, issuerAllowlist };