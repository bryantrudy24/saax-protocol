/**
 * SAAX Phase 2 — focused v4 agreement-spec tests.
 * Uses ONLY synthetic fixtures and the isolated spec-support module.
 * Structural-only tests are labeled; no production routes, no chain access.
 *
 * Run: node mainnet/design/tests/test-v4-spec.js
 */

'use strict';

const assert = require('assert');
const {
  MANIFEST_VERSION, FORMAT_VERSION,
  canonicalManifestV4, validateV4Manifest, buildV4Manifest,
  digestOfCanonicalBytes, MANIFEST_FIELDS_V4,
} = require('../support/v4-canonical');
const { deepSortKeys } = require('../support/v4-canonical');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('  ok  ' + name + '\n');
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    process.stdout.write('FAIL  ' + name + '\n      ' + e.message + '\n');
  }
}

// ————— synthetic valid v4 fixture —————
function validV4() {
  return {
    commitmentId: '0x' + '11'.repeat(32),
    buyerAgentId: '0x1111111111111111111111111111111111111111',
    sellerAgentId: '0x2222222222222222222222222222222222222222',
    capability: 'data-annotation-v1',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'evidence_hidden_answer_set_v1', value: 'all_annotations_match_hidden_set' },
    deadline: '2026-11-05T00:00:00Z',
    cancelCondition: 'buyer_cancels_before_funding',
    manifestVersion: 4,
    terms: {
      schemaVersion: 'saax-commitment-v4',
      hashingVersion: 'sha256-cose-v4',
      signatureDomainVersion: 'saax-commitment-auth-v4',
      policyVersion: 'saax-custody-policy-v1',
    },
    evaluator: '0x3333333333333333333333333333333333333333',
    evaluatorPermittedDecisions: ['release', 'refund'],
    policy: {
      version: 'saax-custody-policy-v1',
      digest: '0x' + 'ab'.repeat(32),
      profilesDocVersion: 'saax-transaction-profiles-v1',
      profilesDocDigest: '0x' + 'cd'.repeat(32),
    },
    profile: 'OBJECTIVE_DIGITAL',
    custody: {
      chainId: 84532,
      custodyAddress: '0x4444444444444444444444444444444444444444',
      token: '0x5555555555555555555555555555555555555555',
      principal: '50000',
      fees: '0',
      reserve: '0',
    },
    consents: {
      buyer: { accepted: true, ref: 'buyer-consent-1' },
      seller: { accepted: true, ref: 'seller-consent-1' },
      sellerTimeoutConsent: { acceptedBySeller: true, cutoff: '2026-11-05T00:00:00Z', effect: 'refund to original buyer at/after cutoff' },
    },
    evidenceRequirements: {
      sources: ['0x7777777777777777777777777777777777777777'],
      submissionMechanism: 'api',
      minimumCount: 1,
      maxAge: 3600,
      verdictRequired: true,
    },
    deadlines: {
      delivery: '2026-11-01T00:00:00Z',
      resolution: '2026-11-03T00:00:00Z',
      finalCutoff: '2026-11-05T00:00:00Z',
    },
  };
}

// ————— 1. deterministic digests —————
check('valid v4 fixture is structurally valid', () => {
  const v = validateV4Manifest(validV4());
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

check('identical manifests produce identical canonical bytes', () => {
  const a = canonicalManifestV4(validV4());
  const b = canonicalManifestV4(validV4());
  assert.strictEqual(a, b);
});

check('key-order permutation produces identical canonical bytes', () => {
  const a = validV4();
  const b = validV4();
  // shuffle nested key insertion order (deepSortKeys makes it irrelevant)
  const swap = { ...a.price };
  a.price = { currency: swap.currency, amount: swap.amount, decimals: swap.decimals };
  b.price = { amounts: undefined }; // placeholder; rebuilt below
  b.price = { decimals: swap.decimals, currency: swap.currency, amount: swap.amount };
  assert.strictEqual(canonicalManifestV4(a), canonicalManifestV4(b));
});

check('field order in the manifest does not change the digest', () => {
  const a = validV4();
  const b = {};
  // rebuild b with fields in reverse insertion order; canonical form is identical
  const keys = Object.keys(a).reverse();
  for (const k of keys) b[k] = a[k];
  assert.strictEqual(canonicalManifestV4(a), canonicalManifestV4(b));
});

check('manifestHash is stable (sha256 prefix, 64 hex)', () => {
  const m = buildV4Manifest(validV4());
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(m.manifestHash), m.manifestHash);
  const m2 = buildV4Manifest(validV4());
  assert.strictEqual(m.manifestHash, m2.manifestHash);
});

// ————— 2. policy/term tampering —————
check('tampering with policy version changes the digest', () => {
  const a = validV4(); const b = validV4();
  b.policy.version = 'saax-custody-policy-v2';
  assert.notStrictEqual(canonicalManifestV4(a), canonicalManifestV4(b));
  // tamper-proof: the canonical-bytes digest differs (buildV4Manifest validates,
  // so use the canonical digest for an invalid-but-real tamper comparison).
  assert.notStrictEqual(
    digestOfCanonicalBytes(canonicalManifestV4(a)),
    digestOfCanonicalBytes(canonicalManifestV4(b))
  );
});

check('tampering with custody address changes the digest', () => {
  const a = validV4(); const b = validV4();
  b.custody.custodyAddress = '0x9999999999999999999999999999999999999999';
  assert.notStrictEqual(buildV4Manifest(a).manifestHash, buildV4Manifest(b).manifestHash);
});

check('tampering with evaluator changes the digest', () => {
  const a = validV4(); const b = validV4();
  b.evaluator = '0x9999999999999999999999999999999999999999';
  assert.notStrictEqual(buildV4Manifest(a).manifestHash, buildV4Manifest(b).manifestHash);
});

check('tampering with principal changes the digest', () => {
  const a = validV4(); const b = validV4();
  b.custody.principal = '51000';
  assert.notStrictEqual(buildV4Manifest(a).manifestHash, buildV4Manifest(b).manifestHash);
});

check('tampering with permitted decisions changes the digest', () => {
  const a = validV4(); const b = validV4();
  b.evaluatorPermittedDecisions = ['release'];
  assert.notStrictEqual(buildV4Manifest(a).manifestHash, buildV4Manifest(b).manifestHash);
});

// ————— 3. version/domain separation —————
check('v3 manifest (manifestVersion 3) canonicalizes differently from v4', () => {
  const v4 = validV4();
  const v3 = validV4();
  v3.manifestVersion = 3;
  // v3 does not have the v4 fields; but the canonical field list for v4 includes
  // the v4-only fields, so a v3-shaped record yields different bytes.
  delete v3.policy; delete v3.profile; delete v3.custody; delete v3.consents;
  delete v3.evidenceRequirements; delete v3.deadlines; delete v3.fallbackDisposition;
  assert.notStrictEqual(canonicalManifestV4(v3), canonicalManifestV4(v4));
});

check('manifestVersion 4 is required; 3 is rejected', () => {
  const a = validV4();
  a.manifestVersion = 3;
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('manifestVersion')));
});

check('signature domain version is distinct and digest-covered', () => {
  const a = validV4(); const b = validV4();
  b.terms.signatureDomainVersion = 'saax-commitment-auth-v3';
  assert.notStrictEqual(buildV4Manifest(a).manifestHash, buildV4Manifest(b).manifestHash);
});

// ————— 4. missing consent —————
check('missing sellerTimeoutConsent rejected for OBJECTIVE_DIGITAL', () => {
  const a = validV4();
  delete a.consents.sellerTimeoutConsent;
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('sellerTimeoutConsent')));
});

check('sellerTimeoutConsent acceptedBySeller=false rejected', () => {
  const a = validV4();
  a.consents.sellerTimeoutConsent.acceptedBySeller = false;
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

check('missing buyer consent rejected', () => {
  const a = validV4();
  delete a.consents.buyer;
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('consents.buyer')));
});

check('missing seller consent rejected', () => {
  const a = validV4();
  delete a.consents.seller;
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

// ————— 5. invalid amount/deadline relationships —————
check('float principal rejected', () => {
  const a = validV4();
  a.custody.principal = '1.5';
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('principal')));
});

check('float price amount rejected', () => {
  const a = validV4();
  a.price.amount = '0.5';
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

check('non-ISO deadline rejected', () => {
  const a = validV4();
  a.deadlines.delivery = '11/01/2026';
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

check('deadline ordering violation (delivery > resolution) rejected', () => {
  const a = validV4();
  a.deadlines.delivery = '2026-11-10T00:00:00Z';
  a.deadlines.resolution = '2026-11-03T00:00:00Z';
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

check('deadline ordering violation (resolution > cutoff) rejected', () => {
  const a = validV4();
  a.deadlines.resolution = '2026-11-10T00:00:00Z';
  a.deadlines.finalCutoff = '2026-11-05T00:00:00Z';
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

check('invalid address (evaluator) rejected', () => {
  const a = validV4();
  a.evaluator = 'not-an-address';
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

check('advanced profile missing fallbackDisposition rejected', () => {
  const a = validV4();
  a.profile = 'PHYSICAL_DELIVERY';
  delete a.fallbackDisposition;
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('fallbackDisposition')));
});

check('invalid chainId rejected', () => {
  const a = validV4();
  a.custody.chainId = 1;
  const v = validateV4Manifest(a);
  assert.strictEqual(v.ok, false);
});

// ————— 6. structural vs real signature (labeled) —————
check('[STRUCTURAL-ONLY] synthetic signature is 65-byte hex; not a real ECDSA', () => {
  const m = buildV4Manifest(validV4());
  assert.ok(/^COSE_Sign1:0x[0-9a-f]{130}$/.test(m.signature), m.signature);
  // the default hook is all-zero bytes — structural placeholder, NOT a real signature
  assert.strictEqual(m.signature, 'COSE_Sign1:0x' + '00'.repeat(65));
});

check('[STRUCTURAL-ONLY] formatVersion derived from the digest envelope', () => {
  const m = buildV4Manifest(validV4());
  assert.strictEqual(m.formatVersion, FORMAT_VERSION);
  assert.strictEqual(m.manifestVersion, MANIFEST_VERSION);
});

// ————— summary —————
process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) {
  process.stdout.write('\nFailures:\n');
  for (const f of failures) process.stdout.write('  - ' + f.name + ': ' + f.error + '\n');
  process.exit(1);
}
process.exit(0);