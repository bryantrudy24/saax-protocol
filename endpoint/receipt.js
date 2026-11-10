// SAAX Protocol — Day 11, Item 5: Spend Receipt Builder
//
// Reference: Cedulon Spend Receipt (draft-dogru-cedulon-core). The Spend
// Receipt binds a SETTLEMENT to its COMMITMENT via the railReference field.
//
//   governed commitment -> verified outcome -> recovery -> audit
//                          ^ this receipt is the audit binding
//
// CRITICAL RULES (from the spec):
//   1. Rail credentials MUST NOT appear in the receipt, logs, or tool results.
//      The receipt carries ONLY the railReference (public transaction
//      identifier) — never the signature, credential, or authorization.
//   2. A spend NOT bound to a verified manifest MUST be marked noManifest:true.
//   3. The signature is COSE_Sign1 (emulated structurally, same as the
//      manifest — a later phase plugs in a real signer).
const crypto = require('crypto');

// ---- Build a spend receipt ----------------------------------------------------
// Fields per the Phase 1 brief. The signature hook defaults to the same
// structural COSE_Sign1 placeholder as the manifest builder.
function buildReceipt({
  commitmentId,
  manifestHash,
  payer,
  payee,
  amount,
  currency,
  rail,
  railReference,
  settledAt,
  noManifest,
  signingHook,
}, opts = {}) {
  // noManifest: explicitly supplied, or DERIVED — a spend not bound to a
  // verified manifest (no manifestHash + no commitmentId) is marked true.
  const noManifestFinal = noManifest !== undefined ? !!noManifest : !(String(commitmentId || '') && String(manifestHash || ''));
  const receipt = {
    receiptId: opts.receiptId || ('0x' + crypto.randomBytes(32).toString('hex')),
    commitmentId: String(commitmentId || ''),
    manifestHash: manifestHash || null,
    payer: String(payer || ''),
    payee: String(payee || ''),
    amount: String(amount || ''),
    currency: String(currency || '').toUpperCase(),
    rail: String(rail || ''),
    railReference: String(railReference || ''),
    settledAt: settledAt || new Date().toISOString(),
    noManifest: noManifestFinal, // spend not bound to a verified manifest -> true
  };
  const hook = signingHook || (() => '0x' + '00'.repeat(65));
  const payloadBytes = Buffer.from(JSON.stringify({
    receiptId: receipt.receiptId,
    commitmentId: receipt.commitmentId,
    manifestHash: receipt.manifestHash,
    payer: receipt.payer,
    payee: receipt.payee,
    amount: receipt.amount,
    currency: receipt.currency,
    rail: receipt.rail,
    railReference: receipt.railReference,
    settledAt: receipt.settledAt,
    noManifest: receipt.noManifest,
  })).toString('utf8');
  return { ...receipt, signature: 'COSE_Sign1:' + hook(payloadBytes) };
}

// ---- Credential non-leakage guard ----------------------------------------------
// The ONLY fields that may ever appear in a receipt (or flow to logs/results)
// are the public binding fields. Anything resembling a signature, credential,
// secret, or authorization field is rejected by construction — and this guard
// re-asserts it: if a caller passes legacy credential fields they are
// STRIPPED, not carried.
const LEAK_FIELD_PATTERN = /signature|credential|secret|authorization|private|token\b|payload\b/i;
function stripCredentials(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (LEAK_FIELD_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Assert the receipt carries NO RAIL CREDENTIAL material (test helper).
// What must never appear are the x402 credential STRUCTURES: the nested
// accepted/payload/authorization objects, the base64 wire payload, or the
// buyer's authorization fields. The receipt's OWN 'signature' field (the
// COSE_Sign1 tag) is legitimate and allowed.
function assertNoCredentialLeakage(receipt) {
  const problems = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      if (k === 'authorization' || k === 'accepted' || k === 'x402Version') {
        problems.push('credential structure "' + k + '" present' + (path ? ' at ' + path : ''));
      } else if (k === 'payload' && typeof node[k] === 'object') {
        problems.push('x402 wire payload present' + (path ? ' at ' + path : ''));
      } else {
        walk(node[k], path ? path + '.' + k : k);
      }
    }
  };
  walk(receipt, '');
  return { ok: problems.length === 0, note: problems.length ? problems.join('; ') : 'no credential material detected' };
}

module.exports = { buildReceipt, stripCredentials, assertNoCredentialLeakage };