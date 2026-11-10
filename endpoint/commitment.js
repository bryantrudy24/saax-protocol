// SAAX Protocol — Day 11, Item 1: Commitment Schema + Trade Manifest (governed commitment)
//
// Reference: Cedulon Trade Manifest (draft-dogru-cedulon-core). The manifest is
// the GOVERENED COMMITMENT of the lifecycle:
//
//   governed commitment -> verified outcome -> recovery -> audit
//
// The manifest binds the TERMS the buyer and seller agree to — capability,
// price (amount + currency + decimals), acceptance criteria, deadline, cancel
// condition — BEFORE any value moves ("The manifest is issued before value
// moves").
//
// CRITICAL RULES (from the spec):
//   1. manifestHash is SHA-256 of the SIGNED COSE bytes
//      (per Cedulon: the hash commits to the exact signed artifact).
//   2. A spend bound to a manifest MUST be denied if the requested amount or
//      currency differs from the manifest (enforced by checkSpendBinding()).
//   3. The manifest is issued before value moves. It carries no rail, no
//      credential, and no settlement reference — settlement is resolved at
//      execution time (R/S separation, IETF draft-king-yew-choo-agentic-payments).
//
// COSE_Sign1 (RFC 9052): this module EMULATES the COSE_Sign1 envelope
//   [protected, unprotected, payload, signature]
// structurally — a tagged array with base64url protected headers (alg + kid
// placeholders) and a 65-byte hex signature. No COSE library or key material
// is installed, so real cryptographic signing is OUT OF SCOPE for Phase 1;
// the builder accepts an optional signingHook(payloadBytes) -> signatureHex
// so a later phase can plug in a real COSE signer without changing the API.
// cosine: never treat the emulated envelope as a real signature.
const crypto = require('crypto');

// ---- Schema ----------------------------------------------------------------
// The manifest field set per the Phase 1 brief. The canonic encoding feeds
// manifestHash and receipt binding so any two builders produce identical bytes.
const MANIFEST_FIELDS = [
  'commitmentId',
  'buyerAgentId',
  'sellerAgentId',
  'capability',
  'price',            // { amount, currency, decimals }
  'acceptanceCriteria', // { type, value }
  'deadline',
  'cancelCondition',
];

// ---- Canonic encoding --------------------------------------------------------
// Deterministic JSON-LD-ish serialization: fields in schema order, price and
// acceptanceCriteria objects with sorted keys, no whitespace. Used for the
// pre-signature payload hash AND the manifest binding hash.
function canonicManifest(manifest) {
  const pick = {};
  for (const f of MANIFEST_FIELDS) {
    if (manifest[f] === undefined || manifest[f] === null) continue;
    pick[f] = manifest[f];
  }
  if (pick.price && typeof pick.price === 'object') {
    pick.price = Object.keys(pick.price).sort().reduce((a, k) => { a[k] = pick.price[k]; return a; }, {});
  }
  if (pick.acceptanceCriteria && typeof pick.acceptanceCriteria === 'object') {
    pick.acceptanceCriteria = Object.keys(pick.acceptanceCriteria).sort().reduce((a, k) => { a[k] = pick.acceptanceCriteria[k]; return a; }, {});
  }
  return JSON.stringify(pick);
}

// ---- Structural validation ----------------------------------------------------
// Price: amount must be a non-negative decimal string (never a float), currency
// a symbol string, decimals an integer. acceptanceCriteria: type + value strings.
// deadline: ISO 8601 parseable. commitmentId/buyer/seller: string ids
// (0x-prefixed addresses or agent ids). Returns { ok, reason }.
function validateManifest(m) {
  if (!m || typeof m !== 'object') return { ok: false, reason: 'manifest must be an object' };
  if (!m.commitmentId || typeof m.commitmentId !== 'string') return { ok: false, reason: 'commitmentId must be a string' };
  if (!m.buyerAgentId || !m.sellerAgentId) return { ok: false, reason: 'buyerAgentId and sellerAgentId are required' };
  if (!m.capability || typeof m.capability !== 'string') return { ok: false, reason: 'capability must be a string' };
  const p = m.price;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'price is required' };
  if (!/^\d+(\.\d+)?$/.test(String(p.amount))) return { ok: false, reason: 'price.amount must be a non-negative decimal string' };
  if (!p.currency || typeof p.currency !== 'string' || !/^[A-Za-z0-9]{2,12}$/.test(p.currency)) return { ok: false, reason: 'price.currency must be a symbol string (e.g. USDC)' };
  if (p.decimals === undefined || p.decimals === null || !Number.isInteger(Number(p.decimals)) || Number(p.decimals) < 0) {
    return { ok: false, reason: 'price.decimals must be a non-negative integer' };
  }
  const a = m.acceptanceCriteria;
  if (!a || typeof a !== 'object') return { ok: false, reason: 'acceptanceCriteria is required' };
  if (!a.type || typeof a.type !== 'string' || !a.value || typeof a.value !== 'string') return { ok: false, reason: 'acceptanceCriteria.type and .value are required strings' };
  if (!m.deadline || isNaN(Date.parse(m.deadline))) return { ok: false, reason: 'deadline must be a parseable ISO 8601 timestamp' };
  if (m.cancelCondition && typeof m.cancelCondition !== 'string') return { ok: false, reason: 'cancelCondition must be a string' };
  return { ok: true, reason: null };
}

// ---- Manifest hash computation ------------------------------------------------
// manifestHash = SHA-256 of the SIGNED COSE bytes (hex, sha256: prefix for
// human-readable tagging).
function coseSign1Envelope(payloadBytes, signatureHex, extras) {
  const protectedB64 = Buffer.from(JSON.stringify({
    alg: 'ES256', // COSE algorithm placeholder (real signer may change)
    kid: (extras && extras.kid) || 'saax-protocol-phase1',
  })).toString('base64url');
  const unprotectedB64 = (extras && extras.unprotected) ? Buffer.from(JSON.stringify(extras.unprotected)).toString('base64url') : '';
  return {
    tag: 'COSE_Sign1',
    protected: protectedB64,
    unprotected: unprotectedB64,
    payload: Buffer.from(payloadBytes, 'utf8').toString('base64url'),
    signature: signatureHex, // hex string (65 bytes -> 130 hex chars)
  };
}

function defaultSigningHook(payloadBytes) {
  // Phase 1: deterministic placeholder signature (65 zero bytes hex). Real COSE
  // signing is a later-phase wiring; the envelope STRUCTURE is complete.
  return '0x' + '00'.repeat(65);
}

// Full manifest build:
//   1. validate fields
//   2. canonic encode (pre-signature bytes for the hook)
//   3. COSE_Sign1 envelope over the payload bytes with the signing hook
//   4. manifestHash = sha256(JSON of the signed envelope bytes)
//   5. return the signed manifest (envelope + manifestHash + signature tag)
function buildManifest(input, opts = {}) {
  const v = validateManifest(input);
  if (!v.ok) throw new Error('manifest validation failed: ' + v.reason);
  const hook = opts.signingHook || defaultSigningHook;
  const payloadBytes = canonicManifest(input);
  const signatureHex = hook(payloadBytes);
  if (typeof signatureHex !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) {
    throw new Error('signing hook must return a 65-byte hex signature (0x + 130 hex chars)');
  }
  const envelope = coseSign1Envelope(payloadBytes, signatureHex, opts);
  const signedBytes = JSON.stringify(envelope); // the SIGNED COSE artifact
  const manifestHash = 'sha256:' + crypto.createHash('sha256').update(signedBytes, 'utf8').digest('hex');
  return { ...input, manifestHash, signature: 'COSE_Sign1:' + signatureHex };
}

// ---- Spend binding check (critical rule 2) ------------------------------------
// A spend bound to a manifest MUST be denied when the requested amount or
// currency differs from the manifest. Returns { ok, reason }.
function checkSpendBinding(manifest, spend) {
  if (!manifest || !spend) return { ok: false, reason: 'manifest and spend are required' };
  const p = manifest.price || {};
  const reqAmount = String(spend.amount);
  const reqCurrency = String(spend.currency).toUpperCase();
  const manAmount = String(p.amount);
  const manCurrency = String(p.currency).toUpperCase();
  if (reqAmount !== manAmount) {
    return { ok: false, reason: 'spend amount ' + reqAmount + ' differs from manifest amount ' + manAmount };
  }
  if (reqCurrency !== manCurrency) {
    return { ok: false, reason: 'spend currency ' + reqCurrency + ' differs from manifest currency ' + manCurrency };
  }
  return { ok: true, reason: null };
}

// ---- Helpers ------------------------------------------------------------------
function newCommitmentId() {
  return '0x' + crypto.randomBytes(32).toString('hex');
}

module.exports = {
  MANIFEST_FIELDS,
  canonicManifest,
  validateManifest,
  coseSign1Envelope,
  defaultSigningHook,
  buildManifest,
  checkSpendBinding,
  newCommitmentId,
};