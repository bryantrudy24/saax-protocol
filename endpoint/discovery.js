// SAAX Protocol — Discovery Profile Phase 1: contract-level validation
//
// NOT an HTTP endpoint and NO financial execution. This module implements the
// SAAX Discovery Profile v1.0.0 validation rules at the contract/schema level:
//   - profile structural validation + application-level checks that JSON Schema
//     format keywords cannot enforce (https only, origin binding, version pin,
//     key status, maturity honesty)
//   - preflight request contract validation
//   - proposal contract validation (expiry under a controlled clock, audience,
//     schema/digest binding, signature-profile presence)
//   - retrieval-policy checks (https, private-network/loopback block, redirect
//     limit, size/time bounds) — policy-level only; actual DNS/network defense
//     is implemented by clients/transport later
//   - replay/idempotency semantics (duplicate vs nonce conflict) as pure rules
//
// Security posture: remote manifests, descriptions, and schemas are UNTRUSTED
// data; nothing here evaluates or executes them. A self-declared key never
// authenticates a provider (trust.authenticated must come from an anchor).
//
// The module is dependency-free (no ajv) so it runs anywhere the node runtime
// runs; the conformance runner drives it through the same vector contract as
// the other categories. Real endpoint handling, DNS rebinding defense, and
// durable storage are Phase 2+.

'use strict';

const PROFILE_VERSION = '1.0.0';
const SUPPORTED_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const HTTPS_RE = /^https:\/\//i;
// CAIP-2: namespace:reference (namespace [-a-z0-9]{3,8}, reference [-_a-zA-Z0-9]{1,32})
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
// CAIP-19: <caip2>/<asset_namespace>:<asset_reference>
const CAIP19_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const AMOUNT_RE = /^[0-9]+$/;
// RFC 8785 JCS - JavaScript canonicalization in this module uses a tiny JCS
// serializer (no external dep) so digests are deterministic across runtimes.
// The canonical bytes for signing are produced by jcs() below.

// --- RFC 8785 JCS serializer (I-JSON subset) --------------------------------
function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
}

// --- Controlled clock --------------------------------------------------------
// now() is injectable so expiry vectors are deterministic. Defaults to real
// time when not overridden (matches the conformance runner's resolvePlaceholders).
let _now = null;
function setNow(iso) { _now = iso ? new Date(iso).getTime() : null; }
function nowMs() { return _now !== null ? _now : Date.now(); }
function nowIso() { return new Date(nowMs()).toISOString(); }

// --- Small validators --------------------------------------------------------
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isNonEmptyStr(v) { return typeof v === 'string' && v.length > 0; }
function isIso(v) { return typeof v === 'string' && !Number.isNaN(Date.parse(v)); }
function isHttpsUrl(v) {
  if (typeof v !== 'string') return false;
  if (!HTTPS_RE.test(v)) return false;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (u.hash) return false;
    if (u.port && u.port !== '443') return false;
    return true;
  } catch (_) { return false; }
}
function originOf(v) {
  try { const u = new URL(v); return u.protocol + '//' + u.host; } catch (_) { return null; }
}
// Private-network / loopback detection (policy-level; clients enforce the DNS
// rebinding re-validation at fetch time, Phase 2 transport).
const PRIVATE_HOST_RE = /(^|\.)(localhost|local|internal|test)$/i;
function isPrivateHost(host) {
  if (!host) return true;
  if (PRIVATE_HOST_RE.test(host)) return true;
  // IPv4 private ranges (pure-policy heuristic; real resolution is client-side)
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    return false;
  }
  if (host.includes(':')) { // IPv6 literal — loopback/ULA/link-local
    if (host === '::1' || host.startsWith('::ffff:127.')) return true;
    if (/^fc|^fd/i.test(host)) return true;
    if (/^fe80/i.test(host)) return true;
    return false;
  }
  return false;
}

// --- Retrieval policy (policy-level checks for unsafe endpoints) -------------
// input: { url, profileVersion }  (+ optional redirects/size/time for tests)
function checkRetrievalPolicy(input) {
  const errors = [];
  const url = input && input.url || '';
  if (!isHttpsUrl(url)) errors.push('origin: not https');
  else {
    const origin = originOf(url);
    if (!origin) errors.push('origin: unparseable');
    else {
      const host = origin.replace(/^https:\/\//, '').replace(/:\d+$/, '');
      if (isPrivateHost(host)) errors.push('origin: private-network/loopback host blocked');
      if (input.profileVersion && input.profileVersion !== PROFILE_VERSION) errors.push('profileVersion: unsupported');
    }
  }
  // Redirect limit (policy constant)
  const redirects = Number(input && input.redirectCount || 0);
  if (redirects > 3) errors.push('redirects: exceeds limit 3');
  // Size/time bounds (policy constants)
  if (input && input.sizeBytes !== undefined && Number(input.sizeBytes) > 262144) errors.push('size: exceeds 256 KiB profile limit');
  if (input && input.elapsedMs !== undefined && Number(input.elapsedMs) > 10000) errors.push('time: exceeds 10s retrieval limit');
  return { valid: errors.length === 0, errors };
}

// --- Key/profile application-level checks -----------------------------------
function checkSigningKey(k) {
  const errors = [];
  if (!isObj(k)) return ['signingKeys[]: must be an object'];
  if (!isNonEmptyStr(k.id)) errors.push('signingKeys[].id: required');
  if (k.type === 'jwk') {
    if (!isObj(k.jwk) || k.jwk.kty !== 'OKP' || (k.jwk.crv && k.jwk.crv !== 'Ed25519') || !isNonEmptyStr(k.jwk.x)) {
      errors.push('signingKeys[].jwk: must be an Ed25519 public JWK');
    }
  } else if (k.type === 'did') {
    if (!isNonEmptyStr(k.did)) errors.push('signingKeys[].did: required for did type');
  } else {
    errors.push('signingKeys[].type: must be jwk|did');
  }
  if (!isNonEmptyStr(k.controller) || !isHttpsUrl(k.controller)) errors.push('signingKeys[].controller: https URL required');
  if (!isIso(k.validFrom) || !isIso(k.validUntil)) errors.push('signingKeys[].validFrom/validUntil: ISO-8601 required');
  else if (new Date(k.validUntil).getTime() < nowMs()) errors.push('signingKeys[].validUntil: expired');
  if (k.validUntil && k.validFrom && new Date(k.validUntil).getTime() < new Date(k.validFrom).getTime()) errors.push('signingKeys[].validUntil: before validFrom');
  if (!['active', 'revoked', 'expired'].includes(k.status)) errors.push('signingKeys[].status: must be active|revoked|expired');
  if (k.status === 'revoked' && !isIso(k.revokedAt)) errors.push('signingKeys[].revokedAt: required when revoked');
  return errors;
}

// --- Capability/financial application-level checks --------------------------
function checkCapability(c) {
  const errors = [];
  if (!isObj(c)) return ['capabilities[]: must be an object'];
  if (!isNonEmptyStr(c.id)) errors.push('capabilities[].id: required');
  if (!Array.isArray(c.schemas) || c.schemas.length === 0) errors.push('capabilities[].schemas: required array');
  else for (const s of c.schemas) {
    if (!isObj(s)) { errors.push('capabilities[].schemas[]: must be an object'); continue; }
    if (!isNonEmptyStr(s.id)) errors.push('capabilities[].schemas[].id: required');
    if (!isNonEmptyStr(s.version)) errors.push('capabilities[].schemas[].version: required');
    if (!DIGEST_RE.test(s.digest || '')) errors.push('capabilities[].schemas[].digest: sha256: hex digest required');
  }
  if (!isObj(c.input) || !isObj(c.input.units)) errors.push('capabilities[].input.units: required');
  else {
    if (!AMOUNT_RE.test(String(c.input.units.amount === undefined ? '' : c.input.units.amount))) errors.push('capabilities[].input.units.amount: integer-string required');
    if (!isNonEmptyStr(c.input.units.unit)) errors.push('capabilities[].input.units.unit: required');
  }
  if (!isObj(c.evidencePolicy) || !Array.isArray(c.evidencePolicy.requiredEvidenceTypes) || c.evidencePolicy.requiredEvidenceTypes.length === 0) {
    errors.push('capabilities[].evidencePolicy.requiredEvidenceTypes: required non-empty array');
  }
  if (!isObj(c.evaluatorRequirements) || !Array.isArray(c.evaluatorRequirements.verificationSchemes) || c.evaluatorRequirements.verificationSchemes.length === 0) {
    errors.push('capabilities[].evaluatorRequirements.verificationSchemes: required non-empty array');
  }
  if (!['experimental', 'beta', 'production'].includes(c.maturity)) errors.push('capabilities[].maturity: must be experimental|beta|production');
  return errors;
}

function checkFinancial(f) {
  const errors = [];
  if (!isObj(f)) return ['financialCompatibility: must be an object'];
  if (!Array.isArray(f.networks) || f.networks.length === 0 || !f.networks.every(n => CAIP2_RE.test(n))) errors.push('financialCompatibility.networks: CAIP-2 chain ids required');
  if (!Array.isArray(f.assets) || f.assets.length === 0 || !f.assets.every(a => CAIP19_RE.test(a))) errors.push('financialCompatibility.assets: CAIP-19 asset types required');
  if (!Array.isArray(f.rails) || f.rails.length === 0) errors.push('financialCompatibility.rails: required non-empty array');
  if (!Array.isArray(f.paymentModes) || f.paymentModes.length === 0) errors.push('financialCompatibility.paymentModes: required');
  if (!Array.isArray(f.supportedCombinations) || f.supportedCombinations.length === 0) errors.push('financialCompatibility.supportedCombinations: required');
  else for (const combo of f.supportedCombinations) {
    if (!CAIP2_RE.test(combo.network || '')) errors.push('supportedCombinations[].network: CAIP-2 required');
    if (!CAIP19_RE.test(combo.asset || '')) errors.push('supportedCombinations[].asset: CAIP-19 required');
    if (!isNonEmptyStr(combo.rail) || !isNonEmptyStr(combo.mode)) errors.push('supportedCombinations[].rail/mode: required');
    if (!['experimental', 'beta', 'production'].includes(combo.maturity)) errors.push('supportedCombinations[].maturity: enum required');
  }
  return errors;
}

// --- Profile validation ------------------------------------------------------
// A complete profile validation = schema validation (run by the conformance
// runner via ajv against profile.schema.json) + these app-level checks.
// This function implements the app-level contract; `schemaValidation` is
// provided by the runner when available.
function validateProfile(profile) {
  const errors = [];
  if (!isObj(profile)) return { valid: false, errors: ['profile: must be an object'] };
  if (profile.profileVersion !== PROFILE_VERSION) errors.push('profileVersion: must be ' + PROFILE_VERSION);
  if (!isNonEmptyStr(profile.providerId)) errors.push('providerId: required');
  if (!isHttpsUrl(profile.origin)) errors.push('origin: https origin required');
  else if (originOf(profile.providerId) && originOf(profile.providerId) !== originOf(profile.origin)) {
    errors.push('origin: providerId origin must match profile origin');
  }
  if (!Array.isArray(profile.signingKeys) || profile.signingKeys.length === 0) errors.push('signingKeys: required');
  else for (const k of profile.signingKeys) errors.push(...checkSigningKey(k));

  if (!Array.isArray(profile.capabilities) || profile.capabilities.length === 0) errors.push('capabilities: required');
  else for (const c of profile.capabilities) errors.push(...checkCapability(c));

  errors.push(...checkFinancial(profile.financialCompatibility || {}));

  if (!isObj(profile.interfaces) || !isObj(profile.interfaces.discovery)) errors.push('interfaces.discovery: required');
  else {
    const d = profile.interfaces.discovery;
    if (typeof d.profile !== 'boolean') errors.push('interfaces.discovery.profile: boolean required');
    if (typeof d.prepareCommitment !== 'boolean') errors.push('interfaces.discovery.prepareCommitment: boolean required');
    if (d.prepareCommitment === true && (!profile.endpoints || !isHttpsUrl(profile.endpoints.prepareCommitment))) {
      errors.push('interfaces.discovery.prepareCommitment: true requires endpoints.prepareCommitment https URL');
    }
    if (typeof d.commitment !== 'boolean') errors.push('interfaces.discovery.commitment: boolean required');
  }

  // Signed support claim vs. demonstrated conformance
  if (!isObj(profile.conformance) || !Array.isArray(profile.conformance.claims) || !Array.isArray(profile.conformance.demonstrated)) {
    errors.push('conformance: claims and demonstrated arrays required');
  }
  // Maturity honesty: a profile claiming production capability while
  // testnetOnly is a contradiction (Phase-1 guard).
  for (const c of (profile.capabilities || [])) {
    if (c.maturity === 'production' && c.networkAvailability && c.networkAvailability.testnetOnly === true) {
      errors.push('capabilities[' + c.id + '].maturity: production with testnetOnly=true is a contradiction');
    }
  }
  return { valid: errors.length === 0, errors };
}

// --- Preflight request validation -------------------------------------------
function validatePrepareRequest(req) {
  const errors = [];
  if (!isObj(req)) return { valid: false, errors: ['request: must be an object'] };
  if (req.profileVersion !== PROFILE_VERSION) errors.push('profileVersion: must be ' + PROFILE_VERSION);
  if (!isObj(req.capability) || !isNonEmptyStr(req.capability.id)) errors.push('capability.id: required');
  if (!isObj(req.schema) || !isNonEmptyStr(req.schema.id) || !isNonEmptyStr(req.schema.version) || !DIGEST_RE.test(req.schema.digest || '')) {
    errors.push('schema: id/version/digest(sha256:) required');
  }
  if (!isObj(req.units) || !AMOUNT_RE.test(String(req.units.amount === undefined ? '' : req.units.amount)) || !isNonEmptyStr(req.units.unit)) {
    errors.push('units: integer-string amount and unit required');
  }
  const fp = req.financialProfile;
  if (!isObj(fp) || !CAIP2_RE.test(fp.network || '') || !CAIP19_RE.test(fp.asset || '') || !isNonEmptyStr(fp.rail) || !isNonEmptyStr(fp.mode)) {
    errors.push('financialProfile: network(CAIP-2)/asset(CAIP-19)/rail/mode required');
  }
  if (!isNonEmptyStr(req.clientNonce) || req.clientNonce.length < 8) errors.push('clientNonce: min 8 chars');
  if (!isIso(req.issuedAt)) errors.push('issuedAt: ISO-8601 required');
  return { valid: errors.length === 0, errors };
}

// --- Proposal validation -----------------------------------------------------
// input: { proposal, profile, now? } — `now` overrides the controlled clock.
function validateProposal(input) {
  const errors = [];
  const proposal = input && input.proposal;
  if (!isObj(proposal)) return { valid: false, errors: ['proposal: must be an object'] };
  if (input && input.now) setNow(input.now);

  if (proposal.profileVersion !== PROFILE_VERSION) errors.push('profileVersion: version downgrade/unsupported');

  if (!isNonEmptyStr(proposal.proposalId) || !/^prop_[A-Za-z0-9_-]+$/.test(proposal.proposalId)) errors.push('proposalId: prop_<id> required');
  if (!isNonEmptyStr(proposal.nonce) || proposal.nonce.length < 8) errors.push('nonce: min 8 chars');
  if (!DIGEST_RE.test(proposal.requestDigest || '')) errors.push('requestDigest: sha256: hex digest required');

  if (!isObj(proposal.provider) || !isNonEmptyStr(proposal.provider.providerId) || !isNonEmptyStr(proposal.provider.signingKeyId) || !isHttpsUrl(proposal.provider.origin)) {
    errors.push('provider: providerId/signingKeyId/https origin required');
  }
  if (!isObj(proposal.audience) || !isNonEmptyStr(proposal.audience.intendedAudience) || (proposal.audience.buyer && !ADDRESS_RE.test(proposal.audience.buyer))) {
    errors.push('audience: intendedAudience required, buyer must be a 0x address');
  }
  if (!isObj(proposal.manifest) || !isNonEmptyStr(proposal.manifest.commitmentManifestVersion) || !DIGEST_RE.test(proposal.manifest.commitmentManifestDigest || '')) {
    errors.push('manifest: commitmentManifestVersion + digest required');
  }
  if (!isObj(proposal.manifest.schema) || !DIGEST_RE.test(proposal.manifest.schema.digest || '')) {
    errors.push('manifest.schema: digest required');
  }
  const t = proposal.terms;
  if (!isObj(t) || !CAIP2_RE.test(t.network || '') || !CAIP19_RE.test(t.asset || '') || !isNonEmptyStr(t.rail) || !isNonEmptyStr(t.mode)) {
    errors.push('terms: network/asset/rail/mode required (CAIP-2/CAIP-19)');
  }
  if (!AMOUNT_RE.test(String(t.amount === undefined ? '' : t.amount)) || !isNonEmptyStr(t.unit)) errors.push('terms.amount: integer-string + unit required');
  if (!isIso(t.deadline)) errors.push('terms.deadline: ISO-8601 required');

  if (!isIso(proposal.issuedAt)) errors.push('issuedAt: ISO-8601 required');
  if (!isIso(proposal.expires)) errors.push('expires: ISO-8601 required');
  else if (new Date(proposal.expires).getTime() < nowMs()) errors.push('expires: proposal expired under controlled clock');

  if (proposal.status !== 'proposed') errors.push('status: must be proposed');

  const sig = proposal.signature;
  if (!isObj(sig) || sig.scheme !== 'jws' || sig.alg !== 'EdDSA' || !isNonEmptyStr(sig.keyId) || !isNonEmptyStr(sig.jws) || sig.canonicalization !== 'rfc8785') {
    errors.push('signature: jws/EdDSA/keyId/jws/rfc8785 required');
  }

  // Self-declared key never authenticates: any claim of authenticated=true
  // without an anchor is a contract violation.
  if (proposal.trust && proposal.trust.authenticated === true && (!Array.isArray(proposal.trust.anchors) || proposal.trust.anchors.length === 0)) {
    errors.push('trust: authenticated requires at least one anchor');
  }

  return { valid: errors.length === 0, errors };
}

// --- Proposal semantic validation (vs. the provider's current profile) -------
// Structural validation plus the cross-record semantic checks the brief
// requires: tampered terms, wrong audience, schema/digest mismatch, and
// unsupported combinations all fail here. The `profile` here is used ONLY for
// the cross-record comparisons; it is not required to be a full standalone
// profile (the structural proposal check stands alone).
// input: { proposal, profile?, expectedRequestDigest?, expectedAudience?, now? }
// --- Buyer acceptance contract validation (Phase 4, acceptance-v1) ----------------
// Structural validation of the versioned buyer acceptance contract:
// domain/action separation, proposal + terms binding, validity window, and the
// Phase-2 signature profile envelope. Cryptographic verification of the buyer
// signature happens in endpoint/acceptance-core.js (configured buyer registry);
// this function validates the contract shape (the conformance vectors prove
// the domain-separation rules without requiring live keys).
function validateAcceptance(input) {
  const errors = [];
  const a = input && input.acceptance;
  if (!isObj(a)) return { valid: false, errors: ['acceptance: must be an object'] };
  if (a.schemaVersion !== 'acceptance-v1') errors.push('schemaVersion: must be acceptance-v1');
  if (a.action !== 'accept_commitment') errors.push('action: must be accept_commitment (a buyer acceptance is not a release verdict)');
  if (a.domain !== 'saax:acceptance:v1') errors.push('domain: must be saax:acceptance:v1 (domain separation from payment/evaluator domains)');
  if (!isNonEmptyStr(a.acceptanceId) || !/^acc_[A-Za-z0-9_-]+$/.test(a.acceptanceId)) errors.push('acceptanceId: acc_<id> required');
  if (!isNonEmptyStr(a.nonce) || a.nonce.length < 8) errors.push('nonce: min 8 chars');
  if (!ADDRESS_RE.test(a.buyer || '')) errors.push('buyer: 0x address required');
  if (!isObj(a.provider) || !isNonEmptyStr(a.provider.providerId) || !isNonEmptyStr(a.provider.signingKeyId)) errors.push('provider: providerId/signingKeyId required');
  if (!isObj(a.proposal) || !/^prop_[A-Za-z0-9_-]+$/.test(a.proposal.proposalId || '') || !DIGEST_RE.test(a.proposal.proposalDigest || '')) errors.push('proposal: proposalId + proposalDigest required');
  if (!DIGEST_RE.test(a.termsDigest || '')) errors.push('termsDigest: sha256: hex digest required');
  if (!isNonEmptyStr(a.audience)) errors.push('audience: required (provider origin)');
  if (!isIso(a.notBefore) || !isIso(a.notAfter)) errors.push('notBefore/notAfter: ISO-8601 required');
  if (a.notBefore && a.notAfter && Date.parse(a.notBefore) > Date.parse(a.notAfter)) errors.push('notBefore: must precede notAfter');
  if (!isObj(a.versions) || a.versions.profileVersion !== PROFILE_VERSION || !isNonEmptyStr(a.versions.manifestVersion) || !isObj(a.versions.schema)) errors.push('versions: profileVersion/manifestVersion/schema required');
  const sig = a.signature;
  if (!isObj(sig) || sig.scheme !== 'jws' || sig.alg !== 'EdDSA' || !isNonEmptyStr(sig.keyId) || !isNonEmptyStr(sig.jws) || sig.canonicalization !== 'rfc8785') errors.push('signature: jws/EdDSA/keyId/jws/rfc8785 required');
  return { valid: errors.length === 0, errors };
}

function validateProposalWithProfile(input) {

  const { proposal } = input || {};
  const base = validateProposal(input);
  if (!base.valid) return base;
  const errors = [];
  const profile = input && input.profile;

  // 1. Schema version/digest must match what the profile declares.
  const schema = proposal.manifest && proposal.manifest.schema;
  if (profile && Array.isArray(profile.capabilities)) {
    for (const c of profile.capabilities) {
      for (const declared of (c.schemas || [])) {
        if (declared.purpose === 'commitment-manifest' && schema) {
          if (declared.digest !== schema.digest) errors.push('manifest.schema.digest: mismatch vs profile declaration');
          if (declared.version !== schema.version) errors.push('manifest.schema.version: mismatch vs profile declaration');
        }
      }
    }
  }

  // 2. Request digest must match the accepted request (catch tampering).
  if (input.expectedRequestDigest && proposal.requestDigest !== input.expectedRequestDigest) {
    errors.push('requestDigest: does not match accepted request (tampered or counter-offer)');
  }

  // 3. Audience: the proposal must be intended for the validating buyer.
  if (input.expectedAudience && proposal.audience && proposal.audience.intendedAudience !== input.expectedAudience) {
    errors.push('audience.intendedAudience: proposal is for a different buyer');
  }

  // 4. Combination must still be supported by the current profile.
  if (profile && profile.financialCompatibility && proposal.terms) {
    const combo = {
      network: proposal.terms.network,
      asset: proposal.terms.asset,
      rail: proposal.terms.rail,
      mode: proposal.terms.mode,
    };
    const r = checkSupportedCombination(profile, combo);
    if (!r.valid) errors.push('terms: ' + r.errors.join('; '));
  }

  return { valid: errors.length === 0, errors };
}

// --- Preflight request semantic validation (vs. the provider's profile) -----
// Structural request validation plus cross-record checks: the requested schema
// version/digest and the financial combination must match the profile.
// input: { request, profile }
function validatePrepareRequestWithProfile(input) {
  const { request, profile } = input || {};
  const base = validatePrepareRequest(request);
  if (!base.valid) return base;
  const errors = [];

  // 1. Requested schema version/digest must be declared by the profile.
  if (request.schema && profile && Array.isArray(profile.capabilities)) {
    let found = false;
    for (const c of profile.capabilities) {
      for (const s of (c.schemas || [])) {
        if (s.id === request.schema.id && s.version === request.schema.version && s.digest === request.schema.digest) {
          found = true;
        }
      }
    }
    if (!found) errors.push('schema: version/digest not declared by provider profile (DSC_SCHEMA_MISMATCH)');
  }

  // 2. Requested financial combination must be supported.
  if (request.financialProfile && profile && profile.financialCompatibility) {
    const combo = {
      network: request.financialProfile.network,
      asset: request.financialProfile.asset,
      rail: request.financialProfile.rail,
      mode: request.financialProfile.mode,
    };
    const r = checkSupportedCombination(profile, combo);
    if (!r.valid) errors.push('financialProfile: ' + r.errors.join('; '));
  }

  return { valid: errors.length === 0, errors };
}

// --- Compatibility check: does a combination exist in the profile? -----------
function checkSupportedCombination(profile, combo) {
  if (!isObj(profile) || !Array.isArray(profile.financialCompatibility.supportedCombinations)) return { valid: false, errors: ['supportedCombinations: absent'] };
  const hit = profile.financialCompatibility.supportedCombinations.find(c =>
    c.network === combo.network && c.asset === combo.asset && c.rail === combo.rail && c.mode === combo.mode);
  if (!hit) return { valid: false, errors: ['DSC_INVALID_COMBINATION: no matching supported combination'] };
  return { valid: true, combination: hit };
}

// --- Proposal freshness + replay semantics (pure rules) ----------------------
// Returns accepted/duplicate/conflict based on the store row the caller holds.
// `storeRow`: { nonce, requestDigest } | null (what an atomic store would hold)
function replayDecide(input) {
  const { proposal, clientNonce, requestDigest, storeRow } = input || {};
  const normalizedNonce = clientNonce || (proposal && proposal.nonce) || '';
  const normalizedDigest = requestDigest || (proposal && proposal.requestDigest) || '';
  if (!storeRow) return { outcome: 'accepted', nonce: normalizedNonce, requestDigest: normalizedDigest };
  if (storeRow.nonce === normalizedNonce && storeRow.requestDigest === normalizedDigest) {
    return { outcome: 'duplicate', nonce: normalizedNonce, requestDigest: normalizedDigest };
  }
  if (storeRow.nonce === normalizedNonce && storeRow.requestDigest !== normalizedDigest) {
    return { outcome: 'conflict', nonce: normalizedNonce, requestDigest: normalizedDigest };
  }
  return { outcome: 'accepted', nonce: normalizedNonce, requestDigest: normalizedDigest };
}

// Distinguish invalid vs. unsupported vs. expired vs. unavailable vs. unresolved
function classifyOutcome(input) {
  const { errors, kind } = input || {};
  if (kind === 'unavailable') return { outcome: 'unavailable', errorCode: 'DSC_UNAVAILABLE' };
  if (kind === 'unresolved') return { outcome: 'unresolved', errorCode: 'DSC_UNRESOLVED' };
  if (Array.isArray(errors)) {
    if (errors.some(e => /expired/i.test(e))) return { outcome: 'expired', errorCode: 'DSC_EXPIRED_PROPOSAL' };
    if (errors.some(e => /version downgrade|unsupported/i.test(e))) return { outcome: 'unsupported', errorCode: 'DSC_UNSUPPORTED_VERSION' };
    if (errors.some(e => /combination/i.test(e))) return { outcome: 'unsupported', errorCode: 'DSC_INVALID_COMBINATION' };
    if (errors.some(e => /audience/i.test(e))) return { outcome: 'invalid', errorCode: 'DSC_INVALID_PROFILE' };
    return { outcome: 'invalid', errorCode: 'DSC_INVALID_PROFILE' };
  }
  return { outcome: 'invalid', errorCode: 'DSC_INVALID_PROFILE' };
}

// --- Auth-failure fallback policy --------------------------------------------
// A client MUST NOT fall back to an unsigned/weaker representation when
// authentication failed or a required extension is incompatible.
// input: { authOk: boolean, requiredExtensionOk: boolean }
// Returns { allowFallback: false, reason } when authOk is false or a required
// extension is incompatible; allowFallback: true ONLY when both hold and the
// client explicitly permits standalone fallback (checked by caller policy).
function authFallbackPolicy(input) {
  const authOk = input && input.authOk !== false;
  const requiredExtensionOk = input && input.requiredExtensionOk !== false;
  if (!authOk) {
    return { allowFallback: false, reason: 'authentication failed: unsigned profile fallback is forbidden (DSC_AUTH_FAILED_NO_FALLBACK)' };
  }
  if (!requiredExtensionOk) {
    return { allowFallback: false, reason: 'incompatible required extension: no weaker fallback (DSC_MISSING_REQUIRED_EXTENSION)' };
  }
  return { allowFallback: true, reason: null };
}

// --- Representation-consistency check ---------------------------------------
// When a provider publishes both an A2A Agent Card extension and a standalone
// profile, shared capability data MUST be identical (Section 3.3 of the spec).
// Compares the shared subset after RFC 8785 canonicalization.
// input: { a2a: object, standalone: object, sharedFields: string[] }
function checkRepresentationConsistency(input) {
  const { a2a, standalone, sharedFields } = input || {};
  if (!isObj(a2a) || !isObj(standalone)) return { valid: false, errors: ['representations: both required'] };
  const fields = Array.isArray(sharedFields) && sharedFields.length ? sharedFields : ['profileVersion', 'providerId', 'origin'];
  const diffs = [];
  for (const f of fields) {
    if (jcs(a2a[f]) !== jcs(standalone[f])) diffs.push(f);
  }
  return { valid: diffs.length === 0, errors: diffs.map(f => 'representation mismatch: ' + f) };
}

module.exports = {
  PROFILE_VERSION,
  SUPPORTED_SCHEMA_DIALECT,
  jcs,
  setNow,
  nowIso,
  nowMs,
  isHttpsUrl,
  isPrivateHost,
  checkRetrievalPolicy,
  validateProfile,
  validatePrepareRequest,
  validatePrepareRequestWithProfile,
  validateProposal,
  validateProposalWithProfile,
  validateAcceptance,
  checkSupportedCombination,
  replayDecide,
  classifyOutcome,
  authFallbackPolicy,
  checkRepresentationConsistency,
};
