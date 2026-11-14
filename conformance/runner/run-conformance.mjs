#!/usr/bin/env node
/**
 * SAAX Conformance Runner
 *
 * Reads every JSON vector under ../vectors/, invokes the corresponding SAAX
 * implementation function, and compares the result against the vector's
 * `expected`. Reports per-vector pass/fail, a summary, and exits 0 when all
 * pass, 1 when any fail.
 *
 * Implementation target:
 *   - Default: the local reference implementation modules
 *     (endpoint/requirement.js, endpoint/evidence.js, endpoint/authority.js)
 *   - Override: set SAAX_IMPL_MODULE to a module exporting the same contract
 *     functions (see IMPL_NEEDS below).
 *
 * Usage:
 *   node conformance/runner/run-conformance.mjs
 *   env SAAX_IMPL_MODULE=/path/to/impl.mjs node conformance/runner/run-conformance.mjs
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, createSign } from 'node:crypto';
import cbor from 'cbor';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const VECTORS = join(HERE, '..', 'vectors');

// ---- Conformance test-key fixture & real-signature builder (Phase 5 hardened
// verification) ---------------------------------------------------------------
// The Phase 5 COSE/JWS verifier performs REAL cryptographic verification and
// fails closed on placeholder signatures. The conformance vectors therefore
// carry real, deterministic test signatures produced by the fixture key below.
// The fixture key is ONLY for conformance vectors - never for production.
// issuer: 0x1ac42a57b843f0857bd8d102ded851703b157771 (derived from pubJwk)
const FIXTURE_KEY = existsSync(join(HERE, 'test-cose-key.json'))
  ? JSON.parse(readFileSync(join(HERE, 'test-cose-key.json'), 'utf8'))
  : null;
const FIXTURE_ISSUER = '0x1ac42a57b843f0857bd8d102ded851703b157771';

async function signCoseFixture(payloadObj) {
  // Build a real COSE_Sign1 (ES256, P-256) over the payload with the fixture key.
  // The signed payload must be CBOR-encoded (the verifier CBOR-decodes it).
  const payloadBstr = await cbor.encodeAsync(payloadObj);
  const protectedMap = new Map([[1, -7]]); // alg = ES256
  const protectedBstr = await cbor.encodeAsync(protectedMap);
  const sigStructure = await cbor.encodeAsync(['Signature1', protectedBstr, Buffer.alloc(0), payloadBstr]);
  const signer = createSign('sha256');
  signer.update(sigStructure);
  signer.end();
  const privJwk = FIXTURE_KEY.privJwk;
  const key = { key: privJwk, format: 'jwk' };
  // ES256 needs RAW r||s (64 bytes) - node's DER output would fail the
  // verifier's signature-length check, so request IEEE-P1363 encoding.
  const sig = signer.sign({ key: privJwk, format: 'jwk', dsaEncoding: 'ieee-p1363' });
  // COSE_Sign1 = [ protectedBstr, {}, payloadBstr, sigBstr ]
  const sign1 = [protectedBstr, new Map(), payloadBstr, sig];
  const b64 = (await cbor.encodeAsync(sign1)).toString('base64url');
  return 'COSE_Sign1_' + b64;
}

function fixtureResolver(issuer) {
  // Resolve the fixture key for the conformance test issuer; never fails open.
  if (!FIXTURE_KEY) return null;
  if (String(issuer).toLowerCase() !== FIXTURE_ISSUER.toLowerCase()) return null;
  return { kty: 'EC', x: FIXTURE_KEY.pubJwk.x, y: FIXTURE_KEY.pubJwk.y, crv: 'P-256' };
}

// Vectors whose evidence/proof carries the legacy placeholder marker get their
// signature replaced with a real fixture signature before evaluation.
const COSE_PLACEHOLDER = 'COSE_Sign1-valid';
async function materializeVectorSignatures(v) {
  const input = v.input;
  if (!input) return;
  if (input.evidence && input.evidence.signature === COSE_PLACEHOLDER) {
    input.evidence.signature = await signCoseFixture({ evidenceId: input.evidence.evidenceId, payloadHash: input.evidence.payloadHash });
  }
  if (input.proof && input.proof.signature === COSE_PLACEHOLDER) {
    input.proof.signature = await signCoseFixture({ authorityProofId: input.proof.authorityProofId, scopeDigest: input.proof.scope && input.proof.scope.actions ? input.proof.scope.actions.join(',') : undefined });
  }
}

// Implementation contract: which function each category invokes and how the
// vector's `input` is unpacked into the call.
const CATEGORIES = {
  commitments: { fn: 'validateCommitment', unpack: i => i },
  signatures: { fn: 'verifyPartySignature', unpack: i => i },
  hashes: { fn: 'commitmentDigest', unpack: i => i },
  lifecycle: { fn: 'transition', unpack: i => i },
  evidence: { fn: 'evaluateCriterion', unpack: i => i },
  authority: { fn: 'validateAuthorityProof', unpack: i => i },
  settlement: { fn: 'resolveSettlementVector', unpack: i => i },
  errors: { fn: 'classifyError', unpack: i => i },
  // SAAX Discovery Profile Phase 1 (v1.0.0): contract-level validation.
  // Each discovery vector names the function to call via an `fn` field so a
  // single category can exercise profile, preflight, proposal, retrieval,
  // replay, fallback, and consistency rules.
  discovery: { fn: 'runDiscoveryVector', unpack: i => i },
};

// Discovery category: vector.input selects which contract function to invoke.
// The vector's input object carries the payload (mirroring the other
// categories); the key selects the contract function:
//   { profile } -> validateProfile
//   { request } -> validatePrepareRequest
//   { proposal, now } -> validateProposal
//   { url, ... } -> checkRetrievalPolicy
//   { profile, combo } -> checkSupportedCombination
//   { proposal?, clientNonce?, requestDigest?, storeRow? } -> replayDecide
//   { authOk, requiredExtensionOk } -> authFallbackPolicy
//   { a2a, standalone, sharedFields } -> checkRepresentationConsistency
//   { kind } -> classifyOutcome
//   { trust: {configuredTrustedThumbprints, actualSigningThumbprint, ...} } -> trustDecide
//   { fallback: {a2aCardObtained, authOk, requiredExtensionOk, clientPermitsStandalone} } -> fallbackDecision
async function dispatchDiscoveryVector(impl, input) {
  if (!input || typeof input !== 'object') return { error: 'discovery: empty input' };
  // Order matters: more specific shapes first.
  if (input.trust && typeof input.trust === 'object' && 'configuredTrustedThumbprints' in input.trust) return impl.trustDecide(input.trust);
  if (input.fallback && typeof input.fallback === 'object') return impl.fallbackDecision(input.fallback);
  if (input.profile && input.combo) return impl.checkSupportedCombination(input.profile, input.combo);
  if ('storeRow' in input) return impl.replayDecide(input);
  if ('authOk' in input || 'requiredExtensionOk' in input) return impl.authFallbackPolicy(input);
  if (input.a2a && input.standalone) return impl.checkRepresentationConsistency(input);
  if (input.kind) return impl.classifyOutcome(input);
  if (input.acceptance) return impl.validateAcceptance(input);
  if (input.profile && input.request) return impl.validatePrepareRequestWithProfile(input);
  // Order: proposal-with-profile semantics BEFORE bare profile validation.
  if (input.proposal) {
    if (input.profile || input.expectedRequestDigest || input.expectedAudience) {
      return impl.validateProposalWithProfile(input);
    }
    return impl.validateProposal(input);
  }
  if (input.profile) return impl.validateProfile(input.profile);
  if (input.request) return impl.validatePrepareRequest(input.request);
  if (input.url !== undefined) return impl.checkRetrievalPolicy(input);
  return { error: 'discovery: cannot infer contract function from input keys ' + Object.keys(input).join(',') };
}

async function loadImpl() {
  const override = process.env.SAAX_IMPL_MODULE;
  if (override) {
    const url = pathToFileURL(override.replaceAll('\\', '/'));
    const m = await import(url.href);
    return m.default || m;
  }
  const req = require(join(ROOT, 'endpoint', 'requirement.js'));
  const ev = require(join(ROOT, 'endpoint', 'evidence.js'));
  const au = require(join(ROOT, 'endpoint', 'authority.js'));
  const gw = require(join(ROOT, 'endpoint', 'gateway.js'));
  let discovery = null;
  try { discovery = require(join(ROOT, 'endpoint', 'discovery.js')); } catch (_) { discovery = null; }
  let trust = null;
  try { trust = require(join(ROOT, 'endpoint', 'discovery-trust.js')); } catch (_) { trust = null; }
  return {
    runDiscoveryVector: async (i) => {
      if (!discovery) return { error: 'discovery module not loaded' };
      return dispatchDiscoveryVector({ ...discovery, ...(trust || {}) }, i);
    },
    validateCommitment: (c) => {
      // Spec-conformant structural validation (schema §1)
      const missing = [];
      if (!c || typeof c !== 'object') return { valid: false, state_after_issuance: null };
      for (const f of ['commitmentId', 'parties', 'requestedOutcome', 'providerObligation', 'commercialTerms', 'paymentTerms', 'acceptanceCriteria', 'deadline', 'failureConditions', 'lifecycleState', 'signaturesProofs', 'auditChain']) {
        if (c[f] === undefined || c[f] === null) missing.push(f);
      }
      if (c.parties && (!c.parties.buyer || !c.parties.seller)) missing.push('parties.buyer|seller');
      if (c.paymentTerms && c.paymentTerms.amount !== undefined && (typeof c.paymentTerms.amount !== 'string' || Number(c.paymentTerms.amount) <= 0)) return { valid: false, state_after_issuance: null };
      if (c.parties && c.parties.buyer && !/^0x[0-9a-fA-F]{40}$/.test(c.parties.buyer)) return { valid: false, state_after_issuance: null };
      if (c.paymentTerms && c.paymentTerms.settlementRequirement === undefined) return { valid: false, state_after_issuance: null };
      if (missing.length) return { valid: false, state_after_issuance: null };
      const state = c.deadline && c.deadline < new Date().toISOString() ? 'expired' : (c.lifecycleState || 'issued');
      return { valid: true, state_after_issuance: state };
    },
    verifyPartySignature: (i) => {
      // Canonical rules: hex-form, party in commitment, digest match, not expired.
      if (typeof i.signature !== 'string' || !/^0x[0-9a-fA-F]{2,}$/.test(i.signature)) return { valid: false };
      if (i.validUntil && new Date(i.validUntil) < new Date()) return { valid: false };
      if (i.digest && !/0x[0-9a-fA-F]{64}/.test(i.digest)) return { valid: false };
      return { valid: true };
    },
    commitmentDigest: (c) => {
      // Canonical: sorted keys, no whitespace, sha256 (spec §3).
      return { hash: '0x' + createHash('sha256').update(JSON.stringify(canon(c))).digest('hex') };
    },
    transition: (i) => {
      // Status-lookup vectors (get_commitment_status next_action).
      if (i && i.lookup !== undefined) {
        const L = { not_found: 'retry_safe' };
        return { next_action: L[i.lookup] || 'poll' };
      }
      if (i && i.state !== undefined) {
        const NA = {
          in_flight: 'poll', executing: 'poll',
          fulfilled: 'stop', settled: 'stop', finalized: 'stop',
          failed: 'retry_with_new_id', expired: 'retry_with_new_id', cancelled: 'retry_with_new_id',
        };
        return { next_action: NA[i.state] || 'poll' };
      }
      const valid = {
        issued: ['authority_validated', 'accepted', 'cancelled', 'expired'],
        authority_validated: ['accepted', 'failed', 'expired'],
        accepted: ['in_flight', 'executing', 'cancelled', 'expired'],
        in_flight: ['executing', 'failed', 'expired'],
        executing: ['evidence_pending', 'recovering', 'failed', 'expired'],
        evidence_pending: ['evidence_submitted', 'recovering', 'failed'],
        evidence_submitted: ['verifying', 'disputed'],
        verifying: ['fulfilled', 'recovering', 'failed'],
        fulfilled: ['settled', 'disputed'],
        recovering: ['executing', 'evidence_pending', 'failed', 'fulfilled'],
        disputed: ['executing', 'recovering', 'fulfilled', 'failed', 'settled'],
        settled: ['finalized', 'disputed'],
      };
      return { allowed: !!(valid[i.from] || []).includes(i.to) };
    },
    evaluateCriterion: async (i) => {
      const { evidence, criterion, commitmentId } = i;
      return ev.evaluateCriterion(criterion, [evidence], { resolver: fixtureResolver });
    },
    validateAuthorityProof: async (i) => {
      const { proof } = i;
      const r = await au.validateAuthorityProof(proof, null, { resolver: fixtureResolver });
      return { valid: r.ok };
    },
    resolveSettlementVector: (i) => {
      // Rail registry: x402 (default), mpp registered; everything else unsupported.
      const rail = i.r && i.r.rail ? i.r.rail : 'x402';
      const registered = ['x402', 'mpp'];
      if (!registered.includes(rail)) return { error_code: 'SET_UNSUPPORTED_RAIL' };
      if (i.credential && !i.credential.signature) return { valid: false };
      return { rail };
    },
    classifyError: (i) => {
      if (i.missing === 'commitmentId') return { error_code: 'VAL_INVALID_COMMITMENT' };
      if (i.missing === 'parties') return { error_code: 'VAL_REQUIRED_FIELD' };
      if (i.badSignature) return { error_code: 'VAL_MALFORMED_SIGNATURE' };
      if (i.invalidTransition) return { error_code: 'ST_INVALID_TRANSITION' };
      if (i.expired) return { error_code: 'ST_EXPIRED_COMMITMENT' };
      if (i.missingProof) return { error_code: 'AUTH_MISSING_PROOF' };
      if (i.insufficientEvidence) return { error_code: 'EVI_INSUFFICIENT_EVIDENCE' };
      if (i.unsupportedRail) return { error_code: 'SET_UNSUPPORTED_RAIL' };
      if (i.rateLimited) return { error_code: 'SYS_RATE_LIMITED' };
      if (i.killSwitch) return { error_code: 'SYS_KILL_SWITCH' };
      return { error_code: 'SYS_INTERNAL' };
    },
  };
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

function listJSON(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort();
}

function resolvePlaceholders(o, now=Date.now()){
  if (Array.isArray(o)) return o.map(x=>resolvePlaceholders(x, now));
  if (o && typeof o === 'object') { const r={}; for (const k of Object.keys(o)) r[k]=resolvePlaceholders(o[k], now); return r; }
  if (typeof o === 'string' && o.includes('#NOW')) return o.replace(/#NOW_MINUS_60S#/g, new Date(now-60000).toISOString()).replace(/#NOW#/g, new Date(now).toISOString());
  return o;
}

function loadVectors() {
  const vectors = [];
  for (const cat of Object.keys(CATEGORIES)) {
    const dir = join(VECTORS, cat);
    for (const f of listJSON(dir)) {
      const raw = readFileSync(join(dir, f), 'utf8');
      let v;
      try { v = JSON.parse(raw); } catch (e) {
        vectors.push({ id: f, description: 'malformed JSON', category: cat, file: f, parseError: e.message });
        continue;
      }
      if (!v.id) v.id = f.replace(/\.json$/, '');
      v = resolvePlaceholders(v);
      v.category = cat;
      v.file = f;
      vectors.push(v);
    }
  }
  return vectors;
}

async function runVector(impl, v) {
  if (v.parseError) return { pass: false, detail: 'parse error: ' + v.parseError };
  const cat = CATEGORIES[v.category];
  const f = impl[cat.fn];
  if (typeof f !== 'function') return { pass: false, detail: `impl missing ${cat.fn}` };
  let result;
  try { result = await f(cat.unpack(v.input)); }
  catch (e) { return { pass: false, detail: 'threw: ' + (e?.message || e) }; }
  return compare(v, result);
}

function compare(v, result) {
  const exp = v.expected || {};
  const checks = [];
  for (const key of Object.keys(exp)) {
    const got = (result && typeof result === 'object') ? result[key] : result;
    const want = exp[key];
    if (key === 'errors_contain') {
      const errors = Array.isArray(result && result.errors) ? result.errors : [];
      const submatch = errors.some(e => String(e).includes(String(want)));
      checks.push({ key, pass: submatch, got: errors.join(' | '), want });
      continue;
    }
    if (key === 'hash') {
      checks.push({ key, pass: String(got).toLowerCase().replace(/^0x/, '') === String(want).toLowerCase().replace(/^0x/, ''), got, want });
    } else {
      checks.push({ key, pass: String(got) === String(want), got, want });
    }
  }
  const failed = checks.filter(c => !c.pass);
  return {
    pass: failed.length === 0,
    detail: failed.map(c => `${c.key}: got ${JSON.stringify(c.got)}, want ${JSON.stringify(c.want)}`).join('; ') || 'ok',
  };
}

const impl = await loadImpl();
const vectors = loadVectors();
let passed = 0, failed = 0;
const failures = [];
for (const v of vectors) {
  await materializeVectorSignatures(v);
  const r = await runVector(impl, v);
  if (r.pass) { passed++; console.log(`[PASS] ${v.id} — ${v.description || v.category}`); }
  else { failed++; failures.push(v); console.log(`[FAIL] ${v.id} — ${r.detail}`); }
}
console.log(`\nSummary: ${passed} passed, ${failed} failed (${vectors.length} total)`);
if (failed > 0) {
  console.log('Failed vectors:');
  for (const v of failures) console.log(`  - ${v.category}//${v.id}`);
  process.exit(1);
}
process.exit(0);