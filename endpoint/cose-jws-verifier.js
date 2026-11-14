// SAAX Protocol — Phase 5B: Pluggable COSE/JWS cryptographic verifier.
//
// Turns the Phase 4 "structural-only" cose/jws posture into REAL cryptographic
// verification for explicitly approved profiles, while preserving the existing
// eip712 path (viem verifyTypedData in endpoint/evidence.js).
//
// Design decisions (Phase 5B):
//  * JWS  -> jose (maintained library, already vendored) — flattened/compact,
//            ES256/EdDSA only (algorithm allowlist).
//  * COSE -> cbor codec (maintained) + node:crypto verify — COSE_Sign1
//            (RFC 9052/9053), ES256/EdDSA allowed; no hand-rolled primitives.
//  * Algorithm allowlist is CANONICAL in code; the untrusted input never picks
//    the algorithm. Ambiguous/missing alg headers fail closed.
//  * Key resolution: issuer -> trusted public key via a pluggable resolver
//    (injected) OR a configured static JWK store. verificationMaterial is
//    accepted ONLY as a key identifier/lookup hint, never as raw key material
//    chosen by the caller (key-substitution defense).
//  * Every verifier returns { ok, reason }. Unsupported scheme/profile or any
//    verification failure is { ok:false } — NEVER a "verified" verdict.
//  * Payload signing: JWS signs the JWS Payload; COSE_Sign1 signs the Sig_structure
//    (RFC 9053 §4.4) over protected header + payload — enforced here.
'use strict';

const crypto = require('crypto');
const { compactVerify, flattenedVerify } = require('jose');
const cbor = require('cbor');

const VERIFIER_POLICY_VERSION = 'saax-cose-jws-v1';

// ---------------------------------------------------------------------------
// Canonical algorithm allowlist (nothing else is accepted for cose/jws).
// ES256 = P-256 + SHA-256 (JOSE alg "ES256" / COSE alg -7)
// EdDSA = Ed25519 (JOSE alg "EdDSA" / COSE alg -8)
// Only these two profiles are approved for SAAX cose/jws evidence today.
// ---------------------------------------------------------------------------
const ALLOWED_JWS_ALGS = new Set(['ES256', 'EdDSA']);
const ALLOWED_COSE_ALGS = new Set([-7, -8]); // ES256, EdDSA (RFC 9053 §5.1)

/**
 * Load the static trusted-key store. Keys are expected as JWKs (SPKI/JWK)
 * keyed by issuer (lowercased address or DID-URL string). The store is a
 * plain object passed in (a resolver function may be supplied instead for
 * dynamic/key-rotation-aware resolution).
 *
 * env: SAAX_COSE_JWS_TRUSTED_KEYS_B64 = base64 JSON of { [issuer]: JWK }
 */
function defaultKeyResolver() {
  if (!process.env.SAAX_COSE_JWS_TRUSTED_KEYS_B64) return async () => null;
  let store;
  try {
    store = JSON.parse(Buffer.from(process.env.SAAX_COSE_JWS_TRUSTED_KEYS_B64, 'base64').toString('utf8'));
  } catch (e) {
    // Never fail open: an unparseable store means nothing is trusted.
    return async () => null;
  }
  return async (issuer) => store[String(issuer).toLowerCase()] || null;
}

/**
 * verifyJws(evidence, { resolver }) — real JWS verification via jose.
 * evidence.signature = "JWS_<flattened-or-compact-JWS-encoded>"
 *   (the structural tag "JWS_" is stripped before verification).
 * Accepted if: alg on allowlist, key resolution succeeds, payload decodes to
 * an object whose payloadHash/metadata is bound by the caller, signature valid.
 */
async function verifyJws(evidence, opts = {}) {
  const raw = String(evidence.signature || '');
  const tag = 'JWS_';
  if (!raw.startsWith(tag)) return { ok: false, reason: 'missing JWS_ envelope tag' };
  const token = raw.slice(tag.length);
  if (!token || token.length < 16) return { ok: false, reason: 'JWS token is empty or truncated' };

  const resolve = (opts.resolver || defaultKeyResolver());
  const issuer = String(evidence.issuer || '').toLowerCase();
  const key = await resolve(issuer);
  if (!key) return { ok: false, reason: 'no trusted key resolvable for issuer ' + issuer };

  let failReason = null;
  // Try compact then flattened. jose compactVerify/flattenedVerify validate
  // the alg against the key type; we additionally enforce the allowlist on the
  // parsed protected header up front (fail closed on unknown algs).
  try {
    const isCompact = String(token).split('.').length === 3;
    const res = isCompact
      ? await _verifyJwsOne(compactVerify, token, key)
      : await _verifyJwsOne(flattenedVerify, token, key);
    if (!opts.skipEvidenceBinding) _assertPayloadBound(res.payload, evidence);
    return { ok: true, reason: null, protectedHeader: res.protectedHeader };
  } catch (e) {
    failReason = 'JWS verification failed: ' + String(e && e.message ? e.message : e).slice(0, 240);
    return { ok: false, reason: failReason };
  }
}

// Verify via one jose entry point and enforce the algorithm allowlist on the
// protected header BEFORE accepting anything.
async function _verifyJwsOne(verifyFn, token, key) {
  const { payload, protectedHeader } = await verifyFn(token, key);
  if (!ALLOWED_JWS_ALGS.has(String(protectedHeader.alg))) {
    throw new Error('algorithm not on the approved allowlist: ' + protectedHeader.alg);
  }
  return { payload, protectedHeader };
}

/**
 * verifyCose(evidence, opts) — real COSE_Sign1 verification (RFC 9053 §4.2).
 * evidence.signature = "COSE_Sign1_<base64url-of-CBOR-Sign1-array>"
 * The Sig_structure (RFC 9053 §4.4) is rebuilt from the protected header +
 * external_aad (empty) + payload; the signature is verified with node:crypto.
 * Allowed: { -7: ES256 (P-256), -8: EdDSA }.
 */
async function verifyCose(evidence, opts = {}) {
  const raw = String(evidence.signature || '');
  const tag = 'COSE_Sign1_';
  if (!raw.startsWith(tag)) return { ok: false, reason: 'missing COSE_Sign1_ envelope tag' };
  const b64 = raw.slice(tag.length);
  if (!b64 || b64.length < 8) return { ok: false, reason: 'COSE signature payload is empty or truncated' };

  let bytes;
  try {
    bytes = Buffer.from(b64, 'base64url');
  } catch (e) {
    return { ok: false, reason: 'COSE signature is not valid base64url' };
  }
  let sign1;
  try {
    sign1 = await cbor.decodeFirst(bytes);
  } catch (e) {
    return { ok: false, reason: 'COSE_Sign1 CBOR decode failed: ' + String(e.message || e).slice(0, 120) };
  }
  // Sign1 = [ protectedHeader( bstr ), unprotected( {}|map ), payload( bstr/null ), signature( bstr ) ]
  if (!Array.isArray(sign1) || sign1.length !== 4) {
    return { ok: false, reason: 'COSE_Sign1 array must have 4 elements' };
  }
  const [protectedBstr, , payloadBstr, sigBstr] = sign1;
  if (!Buffer.isBuffer(protectedBstr) || !Buffer.isBuffer(payloadBstr) || !Buffer.isBuffer(sigBstr)) {
    return { ok: false, reason: 'COSE_Sign1 components must be byte strings' };
  }
  let protectedMap;
  try {
    protectedMap = await cbor.decodeFirst(protectedBstr);
  } catch (e) {
    return { ok: false, reason: 'COSE protected header CBOR decode failed' };
  }
  // cbor.decodeFirst returns a NATIVE Map for a map-typed header (tested
  // against cbor v10). Labels: 1 = alg, 4 = kid (RFC 9052 §3.1). Only the
  // protected header is used. Accept native Map, cbor.Map, or plain object
  // (object keys may be numeric or stringified).
  let algId = null;
  if (protectedMap instanceof Map) {
    algId = protectedMap.get(1);
  } else if (protectedMap instanceof cbor.Map) {
    algId = protectedMap.get(1);
  } else if (protectedMap && typeof protectedMap === 'object') {
    algId = protectedMap[1] != null ? protectedMap[1] : protectedMap['1'];
  }
  if (algId == null) return { ok: false, reason: 'COSE protected header carries no alg' };
  if (!ALLOWED_COSE_ALGS.has(algId)) {
    return { ok: false, reason: 'COSE alg not on the approved allowlist: ' + String(algId) };
  }

  const resolve = (opts.resolver || defaultKeyResolver());
  const issuer = String(evidence.issuer || '').toLowerCase();
  const key = await resolve(issuer);
  if (!key) return { ok: false, reason: 'no trusted key resolvable for issuer ' + issuer };

  // Sig_structure = [ "Signature1", protectedHeader(bstr), externalAad(bstr=empty), payload(bstr) ]
  const sigStructure = await cbor.encodeAsync(['Signature1', protectedBstr, Buffer.alloc(0), payloadBstr]);

  try {
    const ok = verifyCoseSig(algId, sigBstr, sigStructure, key);
    if (!ok) return { ok: false, reason: 'COSE signature does not validate against the trusted key' };
  } catch (e) {
    return { ok: false, reason: 'COSE signature verification error: ' + String(e.message || e).slice(0, 160) };
  }
  // Payload binding: the signed payload must carry the evidence reference set.
  let payload;
  try {
    payload = await cbor.decodeFirst(payloadBstr);
    if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      payload = Object.fromEntries(payload instanceof Map ? payload.entries() : Object.entries(payload));
    }
  } catch (e) {
    return { ok: false, reason: 'COSE payload CBOR decode failed' };
  }
  if (!opts.skipEvidenceBinding) {
    try {
      _assertPayloadBound(payload, evidence);
    } catch (e) {
      return { ok: false, reason: 'COSE payload binding failed: ' + String(e.message || e).slice(0, 160) };
    }
  }
  const kidVal = protectedMap instanceof Map || protectedMap instanceof cbor.Map
    ? protectedMap.get(4)
    : (protectedMap ? (protectedMap[4] != null ? protectedMap[4] : protectedMap['4']) : null);
  if (kidVal) {
    // kid present: verify it matches the evidence verificationMaterial hint when provided.
    const kid = String(kidVal);
    const hint = String(evidence.verificationMaterial || '').replace(/^(kid:|did:key:)/, '') .toLowerCase();
    if (hint && String(kid).toLowerCase() !== hint) {
      return { ok: false, reason: 'COSE kid does not match verificationMaterial hint' };
    }
  }
  return { ok: true, reason: null, protectedHeader: { alg: algId } };
}

// node:crypto signature verification for COSE algs, from a JWK key.
function verifyCoseSig(algId, sigBstr, sigStructure, key) {
  if (algId === -8) {
    // EdDSA (Ed25519)
    if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || !key.x) throw new Error('EdDSA JWK must be OKP/Ed25519');
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    return crypto.verify(null, sigStructure, pub, sigBstr);
  }
  if (algId === -7) {
    // ES256 (P-256), Deterministic ECDSA (RFC 9053 §8.1: ECDSA 256 -> 64-byte r||s)
    if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.x || !key.y) throw new Error('ES256 JWK must be EC/P-256');
    if (sigBstr.length !== 64) throw new Error('ES256 signature must be 64 bytes (r||s)');
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
    // COSE ECDSA is raw r||s; node crypto.verify expects DER for ECDSA. Convert.
    const der = rawEcdsaToDer(sigBstr);
    return crypto.verify('SHA256', sigStructure, pub, der);
  }
  throw new Error('unsupported COSE alg ' + algId);
}

// Convert raw r||s (64 bytes for P-256) to DER ECDSA-Sig-Value.
function rawEcdsaToDer(sig) {
  const half = sig.length / 2;
  const r = sig.subarray(0, half);
  const s = sig.subarray(half);
  const encInt = (buf) => {
    let b = buf;
    while (b.length > 1 && b[0] === 0) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return b;
  };
  const rEnc = encInt(r);
  const sEnc = encInt(s);
  return Buffer.concat([
    Buffer.from([0x30, 2 + rEnc.length + 2 + sEnc.length, 0x02, rEnc.length]),
    rEnc,
    Buffer.from([0x02, sEnc.length]),
    sEnc,
  ]);
}

// Assert the signed payload carries the evidence's committed references
// (evidenceId + payloadHash at minimum); a Payload that does not commit to the
// same evidence is not accepted (payload-binding / substitution defense).
function _assertPayloadBound(payload, evidence) {
  // jose returns the JWS payload as a Uint8Array; decode to JSON first.
  if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
    const json = Buffer.from(payload).toString('utf8');
    try {
      payload = JSON.parse(json);
    } catch (e) {
      throw new Error('signed payload must be JSON-encoded');
    }
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('signed payload must be a JSON/object payload');
  }
  const norm = (s) => (s == null ? '' : String(s));
  const p = payload.payloadHash != null ? payload : (payload.data || payload);
  const pid = norm(p && p.evidenceId != null ? p.evidenceId : payload.evidenceId);
  const phash = norm(p && p.payloadHash != null ? p.payloadHash : payload.payloadHash);
  if (pid) {
    if (norm(evidence.evidenceId) && pid !== norm(evidence.evidenceId)) {
      throw new Error('signed payload evidenceId does not match the evidence record');
    }
  } else if (!phash) {
    throw new Error('signed payload must commit (evidenceId or payloadHash)');
  }
  if (phash) {
    if (norm(evidence.payloadHash) && phash.toLowerCase() !== norm(evidence.payloadHash).toLowerCase()) {
      throw new Error('signed payload payloadHash does not match the evidence record');
    }
  }
  return true;
}

/**
 * verifyCoseJws(evidence, opts) — scheme dispatch.
 * Returns { ok, reason, scheme, policyVersion } — ok:false for ANY failure
 * including unsupported schemes. Never marks unsupported as verified.
 */
async function verifyCoseJws(evidence, opts = {}) {
  const scheme = String(evidence.verificationScheme || '').toLowerCase();
  if (scheme === 'jws') {
    const r = await verifyJws(evidence, opts);
    return Object.assign(r, { scheme: 'jws', policyVersion: VERIFIER_POLICY_VERSION });
  }
  if (scheme === 'cose') {
    const r = await verifyCose(evidence, opts);
    return Object.assign(r, { scheme: 'cose', policyVersion: VERIFIER_POLICY_VERSION });
  }
  return { ok: false, reason: 'verifyCoseJws only supports cose|jws (got ' + scheme + ')', scheme, policyVersion: VERIFIER_POLICY_VERSION };
}

module.exports = {
  verifyCoseJws,
  verifyJws,
  verifyCose,
  defaultKeyResolver,
  ALLOWED_JWS_ALGS,
  ALLOWED_COSE_ALGS,
  VERIFIER_POLICY_VERSION,
  _assertPayloadBound,
  _rawEcdsaToDer: rawEcdsaToDer,
  _verifyCoseSig: verifyCoseSig,
};