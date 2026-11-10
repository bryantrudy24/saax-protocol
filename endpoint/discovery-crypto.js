// SAAX Protocol — Discovery Phase 2: signing and cryptography
//
// Real Ed25519 JWS (RFC 7515/8032) signing and verification for SAAX Discovery
// profiles and proposals, using the maintained `jose` library (v6). The payload
// is the RFC 8785 (JCS) canonical bytes of the document content so signatures
// are deterministic across parse/serialize boundaries and a tampered field or
// a re-order that changes canonical bytes fails verification.
//
// Design rules obeyed:
//   - `alg` is pinned to "EdDSA" (Ed25519). Signers refuse any other alg;
//     verifiers reject any unsupported algorithm (DSC_UNSUPPORTED_ALGORITHM).
//   - The signing key is handed in by the caller (a SignerProfile). This module
//     never generates or stores private keys, never writes key material to disk,
//     and never echoes it back. Private keys live in process memory only.
//   - A self-declared key establishes signature consistency only; trust is
//     established by the resolver's trust configuration, not by this module.

'use strict';

// jose v6+ is ESM-only: a top-level require() breaks on Vercel's Node runtime
// (ERR_REQUIRE_ESM). Load it lazily via dynamic import() so this CJS module
// works everywhere (local tests + serverless). The ONLY sync jose dependency
// (base64url.decode) is replaced with a local implementation.
let _josePromise = null;
function jose() {
  if (!_josePromise) _josePromise = import('jose');
  return _josePromise;
}

function base64urlDecode(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64');
}

const SCHEME = 'jws';
const ALG = 'EdDSA'; // RFC 8032 Ed25519 via jose (alg "EdDSA")
const CRV = 'Ed25519';
const KTY = 'OKP';
const CANONICALIZATION = 'rfc8785'; // the payload is RFC 8785 canonical bytes

// --- RFC 8785 (JCS) canonical serializer ----------------------------------------
// Must stay byte-identical with endpoint/discovery.js:jcs(). Sorted keys, no
// insignificant whitespace, I-JSON strings.
function jcs(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
}

function publicJwkFromX(x) {
  if (!x || typeof x !== 'string' || x.length === 0) throw new Error('publicJwkFromX: x required');
  return { kty: KTY, crv: CRV, x };
}

// --- Sign ------------------------------------------------------------------------
// input: { payload: object, privateJwk: object (OKP Ed25519 private JWK incl. d),
//          keyId: string }
// output: { jws: string (compact), protected: string (base64url header),
//           payloadB64: string (base64url of canonical bytes),
//           canonicalBytes: Buffer }
// Signs the RFC 8785 canonical bytes of `payload` with FlattenedSign so the JWS
// payload is exactly the canonical document (no JWT claims wrapper and no
// inserted iat). compact form: protected.payload.signature.
async function signProfileCanonical(input) {
  const { payload, privateJwk, keyId } = input || {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('signProfileCanonical: payload object required');
  if (!privateJwk || !privateJwk.d) throw new Error('signProfileCanonical: private JWK (with d) required');
  if (!keyId || typeof keyId !== 'string') throw new Error('signProfileCanonical: keyId required');

  const canonicalBuf = Buffer.from(jcs(payload), 'utf8');
  const protectedHeader = { alg: ALG, kid: keyId };
  const j = await jose();
  const cryptoKey = await j.importJWK(privateJwk, ALG);
  const signer = await new j.FlattenedSign(canonicalBuf)
    .setProtectedHeader(protectedHeader)
    .sign(cryptoKey);

  // signer: { protected, payload, signature } each base64url strings.
  const jws = [signer.protected, signer.payload, signer.signature].join('.');
  return {
    jws,
    protectedHeaderB64: signer.protected,
    payloadB64: signer.payload,
    canonicalBytes: canonicalBuf,
  };
}

// Convenience: build the compact JWS for a profile/proposal document and return
// the canonical bytes too, so callers can persist the digest and the payload.
async function signDocument(input) {
  return signProfileCanonical(input);
}

// --- Verify -----------------------------------------------------------------------
// input: { jws: string (compact), publicJwk: object (public OKP JWK),
//          expectedKeyId?: string, expectedPayload?: object,
//          expectedCanonical?: string }
// On success returns { ok: true, payload: string (the decoded canonical JSON
// text), payloadBytes: Buffer, alg, kid }.
// On failure returns { ok: false, errorCode, reason } — never throws for a bad
// signature. `expectedPayload` (when supplied) is canonicalized and compared
// byte-for-byte with the signed payload, so a caller can prove the signed
// bytes correspond to a specific reconstructed document.
async function verifySignature(input) {
  const { jws, publicJwk, expectedKeyId, expectedPayload } = input || {};
  if (!jws || typeof jws !== 'string') return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'jws required' };
  if (!publicJwk || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || !publicJwk.x) {
    return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'publicJWK must be an Ed25519 public JWK' };
  }
  let parts;
  try {
    parts = jws.split('.');
    if (parts.length !== 3) throw new Error('not compact');
    // Reject any alg other than the pinned EdDSA before trying to verify.
    const hdr = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
    if (hdr.alg !== ALG) return { ok: false, errorCode: 'DSC_UNSUPPORTED_ALGORITHM', reason: 'alg ' + hdr.alg + ' unsupported; pinned ' + ALG };
    if (expectedKeyId && hdr.kid && hdr.kid !== expectedKeyId) {
      return { ok: false, errorCode: 'DSC_KEY_ID_MISMATCH', reason: 'kid ' + hdr.kid + ' != expected ' + expectedKeyId };
    }
  } catch (_) {
    return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'malformed JWS header' };
  }

  let key;
  try { key = await (await jose()).importJWK(publicJwk, ALG); } catch (_) {
    return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'unusable public key' };
  }

  let verified;
  try {
    verified = await (await jose()).flattenedVerify({ protected: parts[0], payload: parts[1], signature: parts[2] }, key);
  } catch (e) {
    return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'signature verification failed: ' + (e && e.message || '') };
  }

  const payloadBytes = Buffer.from(verified.payload);
  if (expectedPayload) {
    const want = Buffer.from(jcs(expectedPayload), 'utf8');
    if (!want.equals(payloadBytes)) {
      return { ok: false, errorCode: 'DSC_PAYLOAD_MISMATCH', reason: 'signed payload does not match expected document (tampered or reconstructed differently)' };
    }
  }
  return {
    ok: true,
    payload: payloadBytes.toString('utf8'),
    payloadBytes,
    alg: ALG,
    kid: parts[0] ? (JSON.parse(base64urlDecode(parts[0]).toString('utf8')).kid || null) : null,
  };
}

module.exports = {
  SCHEME,
  ALG,
  CRV,
  KTY,
  CANONICALIZATION,
  jcs,
  publicJwkFromX,
  signProfileCanonical,
  signDocument,
  verifySignature,
};