// SAAX Protocol — Discovery Phase 4: buyer acceptance signing profile
//
// Buyer acceptance is a REAL Ed25519 JWS (same Phase-2 profile: EdDSA, RFC
// 8785 canonical payload, kid bound), over a domain-separated acceptance
// contract. The buyer signs the EXACT proposal digest + normalized agreement/
// terms digest — so the buyer authorizes the same content the provider
// proposed. A caller-supplied identity or expected signer is NOT proof of
// authorization; only a signature that recovers to the buyer's registered key
// (configured in the buyer registry / trust config) is.
//
// Acceptance contract (versioned, ACCEPTANCE_SCHEMA_VERSION = acceptance-v1):
// {
//   schemaVersion: 'acceptance-v1',
//   action: 'accept_commitment',
//   domain: 'saax:acceptance:v1',
//   acceptanceId: 'acc_<hex>',
//   nonce: '<caller-chosen, >= 8 chars, distinct from proposal clientNonce>',
//   buyer: '0x...',
//   provider: { providerId, signingKeyId },
//   proposal: { proposalId, proposalDigest },          // digest of the complete signed proposal (minus signature)
//   termsDigest: 'sha256:<hex>',                        // RFC 8785 canonical proposal terms
//   audience: '<provider origin>',
//   notBefore: '<ISO>',
//   notAfter: '<ISO>',
//   versions: { profileVersion, manifestVersion, schema: { id, version, digest } },
//   signature: { scheme:'jws', alg:'EdDSA', keyId, jws, canonicalization:'rfc8785' }
// }
//
// Domain separation: the acceptance domain ('saax:acceptance:v1') + action
// distinguish this from payment authorizations, evaluator release verdicts,
// and access nonces — a buyer acceptance is NOT a payment authorization or an
// evaluator release verdict (spec §7.1).

'use strict';

const crypto = require('node:crypto');
// jose is NOT used directly here (all signing/verification delegates to
// discovery-crypto, which lazy-imports jose for ESM compatibility on Vercel).
const cryptoLib = require('./discovery-crypto');

const ACCEPTANCE_SCHEMA_VERSION = 'acceptance-v1';
const ACCEPTANCE_DOMAIN = 'saax:acceptance:v1';
const ACCEPTANCE_ACTION = 'accept_commitment';

function jcs(v) { return cryptoLib.jcs(v); } // byte-identical RFC 8785

// Build the canonical acceptance payload (what gets signed). `acceptance` is
// the contract WITHOUT the signature envelope.
function canonicalAcceptancePayload(acceptance) {
  const clean = JSON.parse(JSON.stringify(acceptance));
  delete clean.signature;
  return clean;
}

// Sign a buyer acceptance contract (Phase-4 profile). Returns the signed
// acceptance object with the `signature` envelope attached.
async function signAcceptance({ acceptance, buyerPrivateJwk, keyId }) {
  if (!acceptance || typeof acceptance !== 'object') throw new Error('signAcceptance: acceptance object required');
  if (!buyerPrivateJwk || !buyerPrivateJwk.d) throw new Error('signAcceptance: buyer private JWK required');
  if (!keyId) throw new Error('signAcceptance: keyId required');
  const payload = canonicalAcceptancePayload(acceptance);
  const { jws } = await cryptoLib.signProfileCanonical({
    payload,
    privateJwk: buyerPrivateJwk,
    keyId,
  });
  const signed = JSON.parse(JSON.stringify(acceptance));
  signed.signature = { scheme: 'jws', alg: 'EdDSA', keyId, jws, canonicalization: 'rfc8785' };
  return signed;
}

// Verify a buyer acceptance signature (throws nothing; returns { ok } or
// { ok:false, errorCode, reason } matching cryptoLib.verifySignature).
async function verifyAcceptance({ jws, publicJwk, expectedKeyId, expectedPayload }) {
  return cryptoLib.verifySignature({ jws, publicJwk, expectedKeyId, expectedPayload });
}

// Convenience: compute the acceptance digest (canonical payload sha256).
function acceptanceDigest(acceptance) {
  const payload = canonicalAcceptancePayload(acceptance);
  const canon = jcs(payload);
  return 'sha256:' + crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

module.exports = {
  ACCEPTANCE_SCHEMA_VERSION,
  ACCEPTANCE_DOMAIN,
  ACCEPTANCE_ACTION,
  jcs,
  canonicalAcceptancePayload,
  signAcceptance,
  verifyAcceptance,
  acceptanceDigest,
};
