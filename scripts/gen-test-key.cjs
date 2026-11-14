'use strict';
// Deterministic recovery of the test-only Ed25519 private fixture matching
// spec/examples/discovery/profile-phase3-unsigned.json's pinned public key.
//
// The profile pins public key x = "BybNiscLdz_-yZiVwN-NxzKXcIB7wjluqEXK4Xq1TrE"
// (Ed25519). For an Ed25519 keypair, the public half is derived from the seed;
// given the pinned public x and an Ed25519 private JWK (d = raw seed), only ONE
// seed produces that public key — so the private fixture is deterministic.
//
// This script generates a fresh Ed25519 keypair and reports whether its public
// x matches the pinned value. In practice the pinned key was generated ONCE
// during Phase 4 fixture creation and its private half was intentionally NOT
// committed (test secret). The deterministic recovery is impossible without the
// seed; therefore the correct fix is:
//   1. Generate a NEW test keypair.
//   2. Write BOTH halves to gitignored local paths (never committed).
//   3. Update the pinned profile x to the new public x.
// This keeps the test hermetic and removes the undocumented private-key
// dependency from the clean checkout.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto').webcrypto;

(async () => {
  const ROOT = path.join(__dirname, '..', '..');
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const outDir = path.join(ROOT, 'spec', 'examples', 'discovery', 'keys');
  fs.mkdirSync(outDir, { recursive: true });
  const privPath = path.join(outDir, 'example-private.jwk.json');
  fs.writeFileSync(privPath, JSON.stringify(priv, null, 2) + '\n', 'utf8');
  console.log('wrote ' + privPath);
  console.log('public x = ' + pub.x);
  console.log('pinned x = BybNiscLdz_-yZiVwN-NxzKXcIB7wjluqEXK4Xq1TrE');
  console.log('MATCH = ' + (pub.x === 'BybNiscLdz_-yZiVwN-NxzKXcIB7wjluqEXK4Xq1TrE'));
})();