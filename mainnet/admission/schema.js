/**
 * SAAX Phase 1 — admission schema: policy/profile agreement structure.
 *
 * INTERNAL + ISOLATED: this module is NOT wired into any production route.
 * It validates the structural policy/profile requirements defined in
 * mainnet/policies/*. It does NOT enable mainnet funding for any profile.
 *
 * Conventions follow the repository's conformance-vector style:
 * - monetary amounts are exact integer strings in the token's base units
 *   (never floating point);
 * - addresses are 0x-hex, 40 hex chars;
 * - sight-unseen numbers are rejected (no implicit floats);
 * - everything here is synthetic/schema-level; no chain access.
 */

'use strict';

// ————— supported policy versions —————
const SUPPORTED_POLICY = 'saax-custody-policy-v1';
const SUPPORTED_PROFILES_DOC = 'saax-transaction-profiles-v1';

// ————— profile ids —————
const PROFILES = Object.freeze({
  OBJECTIVE_DIGITAL: 'OBJECTIVE_DIGITAL',
  PHYSICAL_DELIVERY: 'PHYSICAL_DELIVERY',
  SUBJECTIVE_SERVICE: 'SUBJECTIVE_SERVICE',
});

// ————— high-value assurance layer (composable, not standalone) —————
const LAYERS = Object.freeze({
  HIGH_VALUE_ASSURANCE: 'HIGH_VALUE_ASSURANCE',
});

const BASE_PROFILE_IDS = Object.freeze(Object.values(PROFILES));

// ————— address / amount / deadline helpers (pure, schema level) —————
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_DIGEST_RE = /^0x[0-9a-fA-F]{64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isAddress(v) {
  return typeof v === 'string' && HEX_ADDRESS_RE.test(v);
}

function isAsset(v) {
  // CAIP-19 or a plain 0x address; both are exact-string identifiers.
  return typeof v === 'string' && (HEX_ADDRESS_RE.test(v) || /^[a-z0-9-]+:[^/]+\/0x[0-9a-fA-F]{40}$/.test(v));
}

function isExactIntegerString(v) {
  return typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) && !/^0\d+$/.test(v);
}

function isIsoUtc(v) {
  return typeof v === 'string' && ISO_UTC_RE.test(v);
}

// Sum of exact integer strings (no float; returns null on non-integer).
function sumExactInts(strings) {
  const total = strings.reduce((acc, s) => {
    if (!isExactIntegerString(s)) return null;
    const n = BigInt(s);
    return acc === null ? n : acc + n;
  }, null);
  return total;
}

// Compare two exact integer strings (returns 0 / -1 / 1; null if invalid).
function cmpExactInts(a, b) {
  if (!isExactIntegerString(a) || !isExactIntegerString(b)) return null;
  const x = BigInt(a); const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = {
  SUPPORTED_POLICY,
  SUPPORTED_PROFILES_DOC,
  PROFILES,
  LAYERS,
  BASE_PROFILE_IDS,
  isAddress,
  isAsset,
  isExactIntegerString,
  isIsoUtc,
  sumExactInts,
  cmpExactInts,
  HEX_ADDRESS_RE,
  HEX_DIGEST_RE,
  ISO_UTC_RE,
};