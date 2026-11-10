// prepared-vault.js — authenticated-encryption envelope for signed transaction
// bytes at rest (Phase D4A).
//
// SECURITY MODEL
//   - Uses only node:crypto AES-256-GCM (an established authenticated-encryption
//     implementation). No custom cryptography.
//   - The envelope is versioned: { v, alg, kid, iv, tag, ct, aad }.
//     - v   : envelope format version (1)
//     - alg : 'AES-256-GCM'
//     - kid : key identifier (from SAAX_PREPARED_KEY_ID; selects the decryption key)
//     - iv  : fresh unique 96-bit nonce per seal (never reused)
//     - tag : 128-bit authentication tag
//     - ct  : AES-256-GCM ciphertext of the raw signed serialized bytes
//     - aad : authenticated context (see below) — bound so ciphertext cannot be
//             moved between operations/chains/senders/nonces/transactions
//   - The key NEVER appears in the envelope, the database, the repository, logs,
//     or exports. It is delivered via SAAX_PREPARED_KEY (hex, 64 chars = 32 bytes)
//     or a keyfile path in SAAX_PREPARED_KEY_FILE (exclusive). kid selects which
//     key version to use; a missing/wrong key REFUSES to open (fail closed).
//   - Decryption is only reachable through the restricted broadcast/recovery path
//     (see d2-worker.validatePrepared / broadcastPrepared).
//
// AUTHENTICATED CONTEXT (aad)
//   A canonical UTF-8 string binding the operation, chain, sender, account nonce,
//   and the INTENDED transaction. It is authenticated (GCM aad) so any
//   substitution — a different envelope, a different operation, a different
//   chain/sender/nonce, or a different intended transaction — fails the tag check.
//
// KEY ROTATION
//   - kid is opaque and carried in the envelope. Rotation = issue a new key with
//     a new kid; new seals use the current kid. Pending records sealed under an
//     older kid remain readable while the old key is still supplied.
//   - Decrypt with a key not matching the envelope kid => DENIED (fail closed),
//     state untouched (the stored envelope is not modified by a failed open).
//
// NOTE: encrypting the bytes changes WHAT is stored, not the canonical agreement/
//       journal hashes. tx_hash (the on-chain transaction hash) and the journal
//       intents are NOT re-hashed; the envelope protects the signing material only.

'use strict';

const crypto = require('node:crypto');

const ENVELOPE_VERSION = 1;
const ALG = 'AES-256-GCM';
const IV_BYTES = 12; // 96-bit nonce, required by GCM
const TAG_BYTES = 16;

/** Canonical AAD string. Arrays keep order; object keys are sorted. */
function canonicalContext(obj) {
  const canon = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return String(v);
  };
  return canon(obj);
}

/** Load the AES-256-GCM key. Returns { key, kid } or throws a precise error. */
function loadKey(opts = {}) {
  const keyHex = opts.keyHex !== undefined ? opts.keyHex : process.env.SAAX_PREPARED_KEY;
  const keyFile = opts.keyFile !== undefined ? opts.keyFile : process.env.SAAX_PREPARED_KEY_FILE;
  const kid = opts.kid !== undefined ? opts.kid : process.env.SAAX_PREPARED_KEY_ID;

  if (keyFile && keyHex) {
    throw new Error('PRECONDITION: SAAX_PREPARED_KEY and SAAX_PREPARED_KEY_FILE are mutually exclusive');
  }
  let raw = null;
  if (keyFile) {
    const fs = require('node:fs');
    if (!fs.existsSync(keyFile)) throw new Error('PRECONDITION: prepared key file not found: ' + keyFile);
    raw = fs.readFileSync(keyFile, 'utf8').trim();
  } else if (keyHex) {
    raw = keyHex.trim();
  } else {
    throw new Error('PRECONDITION: SAAX_PREPARED_KEY (or SAAX_PREPARED_KEY_FILE) is required');
  }
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('PRECONDITION: prepared key must be 32 bytes (64 hex chars)');
  }
  return { key: Buffer.from(hex, 'hex'), kid: kid || 'k1' };
}

/**
 * Seal raw signed serialized transaction bytes into a versioned envelope.
 * @param {string|Buffer} signedBytes 0x-prefixed hex or Buffer of the raw bytes
 * @param {object} context { op, chain, sender, accountNonce, intendedTx } (all required)
 * @param {object} [opts] { keyHex, keyFile, kid, iv } (iv only for deterministic tests)
 * @returns envelope object
 */
function sealPrepared(signedBytes, context, opts = {}) {
  const { key, kid } = loadKey(opts);
  const raw = Buffer.isBuffer(signedBytes)
    ? signedBytes
    : Buffer.from(String(signedBytes).replace(/^0x/, ''), 'hex');
  const aad = canonicalContext(context);
  const iv = opts.iv ? Buffer.from(opts.iv, 'hex') : crypto.randomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new Error('PRECONDITION: IV must be ' + IV_BYTES + ' bytes');
  const cipher = crypto.createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    alg: ALG,
    kid,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ct: ct.toString('hex'),
    aad,
  };
}

/**
 * Open a versioned envelope back into the raw signed bytes.
 * Validates envelope version/alg, recomputes the AAD from the EXPECTED context
 * (caller-supplied, durably recorded operation bindings), and authenticates.
 * The tag check fails on any ciphertext/IV/tag/context substitution.
 * @param {object} envelope
 * @param {object} expectedContext { op, chain, sender, accountNonce, intendedTx }
 * @param {object} [opts] { keyHex, keyFile }
 * @returns { ok: true, bytes: Buffer } | { ok: false, reason }
 */
function openPrepared(envelope, expectedContext, opts = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, reason: 'NOT_AN_ENVELOPE' };
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    return { ok: false, reason: 'UNSUPPORTED_ENVELOPE_VERSION', got: envelope.v };
  }
  if (envelope.alg !== ALG) {
    return { ok: false, reason: 'UNSUPPORTED_ALGORITHM', got: envelope.alg };
  }
  if (!/^[0-9a-f]{24}$/.test(envelope.iv) || !/^[0-9a-f]{32}$/.test(envelope.tag)) {
    return { ok: false, reason: 'MALFORMED_ENVELOPE' };
  }
  if (!/^[0-9a-f]*$/.test(envelope.ct || '')) {
    return { ok: false, reason: 'MALFORMED_CIPHERTEXT' };
  }
  // Fail closed on a missing/wrong key BEFORE touching any state.
  let loaded;
  try {
    loaded = loadKey({ ...opts, kid: envelope.kid });
  } catch (e) {
    return { ok: false, reason: 'KEY_UNAVAILABLE', detail: e.message };
  }
  if (envelope.kid && loaded.kid !== envelope.kid) {
    return { ok: false, reason: 'KEY_ID_MISMATCH', expected: envelope.kid, got: loaded.kid };
  }
  const aad = canonicalContext(expectedContext);
  try {
    const decipher = crypto.createDecipheriv(ALG, loaded.key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'hex')), decipher.final()]);
    return { ok: true, bytes: plain };
  } catch (e) {
    // Includes: wrong key, wrong IV, wrong tag (substitution), wrong AAD/context.
    return { ok: false, reason: 'AUTH_DECRYPT_FAILED', detail: e.message };
  }
}

/**
 * Bounded verification helper: recompute the transaction hash from decrypted
 * bytes and compare with the durably recorded expected hash (caller provides
 * the expected hash; the caller is the restricted broadcast/recovery path).
 */
function verifyTxHash(bytes, expectedTxHash) {
  const { keccak256 } = require('ethers');
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes).replace(/^0x/, ''), 'hex');
  const computed = keccak256(raw);
  return computed.toLowerCase() === String(expectedTxHash).toLowerCase();
}

module.exports = {
  ENVELOPE_VERSION,
  ALG,
  sealPrepared,
  openPrepared,
  canonicalContext,
  loadKey,
  verifyTxHash,
};