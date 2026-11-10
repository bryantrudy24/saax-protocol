/**
 * SAAX Phase 2 — isolated v4 agreement-spec support (canonicalization + digests).
 *
 * INTERNAL + ISOLATED: NOT wired into production routes, NOT used by the
 * existing verifier, and the v4 manifest format is PROPOSED (the verifier
 * supports formatVersion 1-3 only — v4 requires a Phase 3 extension).
 *
 * Conventions follow the repo's established manifest pattern:
 *   - MANIFEST_FIELDS_V4 (canonical field order) extends MANIFEST_FIELDS_V3
 *     with the Phase 1 policy/profile/consent/custody/deadline/fallback terms;
 *   - the digest is sha256 over the canonical JSON (deep-sorted, field order,
 *     no whitespace) wrapped in the COSE_Sign1-style envelope — the same
 *     mechanics as endpoint/commitment.js, so v1/v2/v3 digest behavior is
 *     untouched (the v4 field list is additive);
 *   - monetary amounts are exact integer strings; addresses 0x-hex 40;
 *     deadlines ISO-8601 UTC. Floats and malformed values are rejected.
 *
 * All fixtures/vectors here are synthetic. Nothing funds or deploys anything.
 */

'use strict';

const crypto = require('crypto');

// ————— version identifiers —————
const MANIFEST_VERSION = 4;
const FORMAT_VERSION = 4;
const SCHEMA_VERSION = 'saax-commitment-v4';
const HASHING_VERSION = 'sha256-cose-v4';
const SIGNATURE_DOMAIN_VERSION = 'saax-commitment-auth-v4';

// ————— canonical field list (digest order) —————
// v1 base (8) + v2 (manifestVersion, terms) + v3 (evaluator, evaluatorPermittedDecisions)
// + v4 additions (policy, profile, custody, consents, evidenceRequirements, deadlines, fallbackDisposition).
const MANIFEST_FIELDS_V4 = [
  // v1
  'commitmentId',
  'buyerAgentId',
  'sellerAgentId',
  'capability',
  'price',
  'acceptanceCriteria',
  'deadline',
  'cancelCondition',
  // v2
  'manifestVersion',
  'terms',
  // v3
  'evaluator',
  'evaluatorPermittedDecisions',
  // v4
  'policy',
  'profile',
  'custody',
  'consents',
  'evidenceRequirements',
  'deadlines',
  'fallbackDisposition',
];

// ————— primitives (schema-level, mirror mainnet/admission/schema.js) —————
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_DIGEST_RE = /^0x[0-9a-fA-F]{64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EXACT_INT_RE = /^(0|[1-9]\d*)$/;

function isAddress(v) { return typeof v === 'string' && HEX_ADDRESS_RE.test(v); }
function isExactIntegerString(v) { return typeof v === 'string' && EXACT_INT_RE.test(v) && !/^0\d+$/.test(v); }
function isIsoUtc(v) { return typeof v === 'string' && ISO_UTC_RE.test(v); }

// ————— deep key sort (stable; arrays keep order) —————
function deepSortKeys(v) {
  if (Array.isArray(v)) return v.map(deepSortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => {
      acc[k] = deepSortKeys(v[k]);
      return acc;
    }, {});
  }
  return v;
}

// ————— canonical manifest bytes —————
function canonicalManifestV4(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('v4 manifest must be an object');
  }
  const pick = {};
  for (const f of MANIFEST_FIELDS_V4) {
    if (m[f] === undefined || m[f] === null) continue;
    pick[f] = m[f];
  }
  return JSON.stringify(deepSortKeys(pick)); // no whitespace
}

// ————— validation (structural; rejects float amounts, bad addresses, bad times) —————
function validateV4Manifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest must be an object'] };
  // version fields
  if (m.manifestVersion !== MANIFEST_VERSION) errs.push('manifestVersion must be ' + MANIFEST_VERSION);
  if (m.formatVersion !== undefined && m.formatVersion !== FORMAT_VERSION) errs.push('formatVersion must be ' + FORMAT_VERSION + ' (or omitted)');
  // v1 base
  for (const f of ['commitmentId', 'buyerAgentId', 'sellerAgentId', 'capability', 'deadline', 'cancelCondition']) {
    if (typeof m[f] !== 'string' || m[f].length === 0) errs.push(f + ' must be a non-empty string');
  }
  if (!isIsoUtc(m.deadline)) errs.push('deadline must be ISO-8601 UTC');
  // price
  const p = m.price;
  if (!p || typeof p !== 'object') errs.push('price required');
  else {
    if (!isExactIntegerString(String(p.amount))) errs.push('price.amount must be an exact integer string');
    if (typeof p.currency !== 'string' || !/^[A-Za-z0-9]{2,12}$/.test(p.currency)) errs.push('price.currency invalid');
    if (!Number.isInteger(p.decimals) || p.decimals < 0) errs.push('price.decimals must be a non-negative integer');
  }
  // acceptanceCriteria
  const ac = m.acceptanceCriteria;
  if (!ac || !ac.type || !ac.value) errs.push('acceptanceCriteria.type and .value required');
  // v3
  if (!isAddress(m.evaluator || '')) errs.push('evaluator must be a valid address');
  if (!Array.isArray(m.evaluatorPermittedDecisions) || m.evaluatorPermittedDecisions.length === 0) {
    errs.push('evaluatorPermittedDecisions must be a non-empty array');
  }
  // v4 policy
  const pol = m.policy;
  if (!pol || typeof pol !== 'object') errs.push('policy required');
  else {
    if (pol.version !== 'saax-custody-policy-v1') errs.push('policy.version must be saax-custody-policy-v1');
    if (!HEX_DIGEST_RE.test(pol.digest || '')) errs.push('policy.digest must be a 32-byte hex digest');
  }
  // v4 profile
  if (!['OBJECTIVE_DIGITAL', 'PHYSICAL_DELIVERY', 'SUBJECTIVE_SERVICE'].includes(m.profile)) {
    errs.push('profile must be OBJECTIVE_DIGITAL | PHYSICAL_DELIVERY | SUBJECTIVE_SERVICE');
  }
  // v4 custody: exact integers + valid addresses/chain
  const c = m.custody;
  if (!c || typeof c !== 'object') errs.push('custody required');
  else {
    // Local-test context (31337) is allowed for synthetic/local manifests;
    // public deployment policy (8453 mainnet, 84532 Base Sepolia) is
    // unchanged and enforced elsewhere (chain guard, admission gate). The two
    // 84532s (local EVM vs public Base Sepolia) never merge after the
    // chain-identity split (d1eb4c6d): local EVM presents 31337, so 84532 in
    // a manifest unambiguously means Base Sepolia.
    if (typeof c.chainId !== 'number' || ![8453, 84532, 31337].includes(c.chainId)) errs.push('custody.chainId must be 8453, 84532, or 31337 (31337 = local-test context only)');
    if (!isAddress(c.custodyAddress)) errs.push('custody.custodyAddress must be a valid address');
    if (!isAddress(c.token)) errs.push('custody.token must be a valid address');
    for (const k of ['principal', 'fees', 'reserve']) {
      if (c[k] !== undefined && !isExactIntegerString(String(c[k]))) errs.push('custody.' + k + ' must be an exact integer string');
    }
    if (!isExactIntegerString(String(c.principal))) errs.push('custody.principal required as exact integer string');
  }
  // v4 consents: both parties accepted:true + seller timeout consent for the restricted profile
  const cs = m.consents;
  if (!cs || typeof cs !== 'object') errs.push('consents required');
  else {
    if (!cs.buyer || cs.buyer.accepted !== true) errs.push('consents.buyer.accepted must be true');
    if (!cs.seller || cs.seller.accepted !== true) errs.push('consents.seller.accepted must be true');
    if (m.profile === 'OBJECTIVE_DIGITAL' && (!cs.sellerTimeoutConsent || cs.sellerTimeoutConsent.acceptedBySeller !== true)) {
      errs.push('consents.sellerTimeoutConsent.acceptedBySeller must be true for OBJECTIVE_DIGITAL');
    }
  }
  // v4 evidenceRequirements
  const ev = m.evidenceRequirements;
  if (!ev || typeof ev !== 'object') errs.push('evidenceRequirements required');
  else {
    if (!Array.isArray(ev.sources) || ev.sources.length === 0) errs.push('evidenceRequirements.sources must be non-empty');
    if (typeof ev.submissionMechanism !== 'string' || ev.submissionMechanism.length === 0) errs.push('evidenceRequirements.submissionMechanism required');
    if (typeof ev.verdictRequired !== 'boolean') errs.push('evidenceRequirements.verdictRequired must be boolean');
  }
  // v4 deadlines
  const d = m.deadlines;
  if (!d || typeof d !== 'object') errs.push('deadlines required');
  else {
    if (!isIsoUtc(d.delivery)) errs.push('deadlines.delivery must be ISO-8601 UTC');
    if (!isIsoUtc(d.resolution)) errs.push('deadlines.resolution must be ISO-8601 UTC');
    if (!isIsoUtc(d.finalCutoff)) errs.push('deadlines.finalCutoff must be ISO-8601 UTC');
    if (isIsoUtc(d.delivery) && isIsoUtc(d.resolution) && isIsoUtc(d.finalCutoff)) {
      if (d.delivery > d.resolution) errs.push('deadlines.delivery must be <= resolution');
      if (d.resolution > d.finalCutoff) errs.push('deadlines.resolution must be <= finalCutoff');
    }
  }
  // v4 fallbackDisposition (required for advanced profiles)
  const fb = m.fallbackDisposition;
  if (m.profile !== 'OBJECTIVE_DIGITAL' && (!fb || typeof fb !== 'object')) {
    errs.push('fallbackDisposition required for advanced profiles');
  }
  if (fb && typeof fb === 'object') {
    if (typeof fb.rule !== 'string' || fb.rule.length === 0) errs.push('fallbackDisposition.rule required');
    if (fb.executor !== undefined && !isAddress(fb.executor)) errs.push('fallbackDisposition.executor must be a valid address');
  }
  return { ok: errs.length === 0, errors: errs };
}

// ————— COSE_Sign1 envelope + manifest hash (mirrors endpoint/commitment.js) —————
function coseSign1Envelope(payloadBytes, signatureHex, extras) {
  const protectedB64 = Buffer.from(JSON.stringify({
    alg: 'ES256',
    kid: (extras && extras.kid) || 'saax-commitment-v4',
  })).toString('base64url');
  const unprotectedB64 = (extras && extras.unprotected) ? Buffer.from(JSON.stringify(extras.unprotected)).toString('base64url') : '';
  return {
    tag: 'COSE_Sign1',
    protected: protectedB64,
    unprotected: unprotectedB64,
    payload: Buffer.from(payloadBytes, 'utf8').toString('base64url'),
    signature: signatureHex,
  };
}

function defaultSigningHook() {
  // deterministic synthetic signature (65 zero bytes) — structural only, NOT a real signature.
  return '0x' + '00'.repeat(65);
}

function buildV4Manifest(input, opts = {}) {
  const v = validateV4Manifest(input);
  if (!v.ok) throw new Error('v4 manifest validation failed: ' + v.errors.join('; '));
  const payloadBytes = canonicalManifestV4(input);
  const hook = opts.signingHook || defaultSigningHook;
  const signatureHex = hook(payloadBytes);
  if (typeof signatureHex !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) {
    throw new Error('signing hook must return a 65-byte hex signature');
  }
  const envelope = coseSign1Envelope(payloadBytes, signatureHex, opts);
  const signedBytes = JSON.stringify(envelope);
  const manifestHash = 'sha256:' + crypto.createHash('sha256').update(signedBytes, 'utf8').digest('hex');
  return { ...input, manifestHash, signature: 'COSE_Sign1:' + signatureHex, formatVersion: FORMAT_VERSION };
}

// ————— digest helpers (for tests/vectors) —————
function digestOfCanonicalBytes(bytes) {
  return 'sha256:' + crypto.createHash('sha256').update(bytes, 'utf8').digest('hex');
}

module.exports = {
  MANIFEST_VERSION,
  FORMAT_VERSION,
  SCHEMA_VERSION,
  HASHING_VERSION,
  SIGNATURE_DOMAIN_VERSION,
  MANIFEST_FIELDS_V4,
  deepSortKeys,
  canonicalManifestV4,
  validateV4Manifest,
  coseSign1Envelope,
  buildV4Manifest,
  digestOfCanonicalBytes,
  isAddress,
  isExactIntegerString,
  isIsoUtc,
};