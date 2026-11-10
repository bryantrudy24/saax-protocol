#!/usr/bin/env node
// SAAX Discovery Phase 2 — sign a discovery profile (and optionally an A2A
// Agent Card) with a real Ed25519 key, producing the standalone
// `/.well-known/saax.json` document.
//
// Usage:
//   node scripts/discovery-sign-profile.cjs --profile path/to/profile-unsigned.json \
//       --key path/to/private-jwk.json --keyId key-2026-01 [--out out/saax.json]
//
// The private key file must be a JWK JSON object ({"kty":"OKP","crv":"Ed25519",
// "x":"...","d":"..."}). The private JWK is read from the filesystem, used
// in-process, and NEVER written into the output or committed. Public x is
// copied from the private JWK into the profile's signingKeys[].jwk.
//
// Security notes:
//   - The signed payload is the profile WITHOUT the `signature` envelope,
//     RFC 8785 canonicalized — verifySignature() reconstructs the same bytes.
//   - The script refuses to sign when the profile's keyId/validity/status do
//     not match the key being used (prevents signing with the wrong key).
//   - The private key file path is never embedded in output.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cryptoLib = require('../endpoint/discovery-crypto');

function usage() {
  console.error(
    'usage: node scripts/discovery-sign-profile.cjs --profile <unsigned.json> --key <private-jwk.json> --keyId <id> [--out <out.json>]'
  );
  process.exit(2);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') a.profile = argv[++i];
    else if (argv[i] === '--key') a.key = argv[++i];
    else if (argv[i] === '--keyId') a.keyId = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--check-only') a.checkOnly = true;
  }
  if (!a.profile || !a.key || !a.keyId) usage();
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = JSON.parse(fs.readFileSync(args.profile, 'utf8'));
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    console.error('profile must be a JSON object');
    process.exit(1);
  }
  const privateJwk = JSON.parse(fs.readFileSync(args.key, 'utf8'));
  if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || !privateJwk.d || !privateJwk.x) {
    console.error('key file must be an Ed25519 private JWK (kty=OKP, crv=Ed25519, x, d)');
    process.exit(1);
  }

  // The signing key reference in the profile must match.
  const keyRef = (profile.signingKeys || []).find((k) => k.id === args.keyId);
  if (!keyRef) {
    console.error('profile.signingKeys[] has no entry with id ' + args.keyId);
    process.exit(1);
  }
  if (keyRef.type !== 'jwk' || !keyRef.jwk || keyRef.jwk.x !== privateJwk.x) {
    console.error('profile.signingKeys[].jwk.x does not match the private key x; refusing to sign');
    process.exit(1);
  }
  if (keyRef.status !== 'active') {
    console.error('profile.signingKeys[].status must be active to sign; refusing');
    process.exit(1);
  }

  // The signed payload is the profile WITHOUT any existing signature envelope.
  // Strip a stale/placeholder signature before signing so the canonical bytes
  // exactly match what a resolver reconstructs.
  const payload = JSON.parse(JSON.stringify(profile));
  delete payload.signature;

  const { jws } = await cryptoLib.signProfileCanonical({ payload, privateJwk, keyId: args.keyId });
  const signed = payload;
  signed.signature = { scheme: 'jws', alg: 'EdDSA', keyId: args.keyId, jws, canonicalization: 'rfc8785' };

  // Verify our own output before writing (the module trusts no one).
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  const checkPayload = JSON.parse(JSON.stringify(signed));
  delete checkPayload.signature;
  const v = await cryptoLib.verifySignature({ jws, publicJwk, expectedKeyId: args.keyId, expectedPayload: checkPayload });
  if (!v.ok) {
    console.error('self-check failed: ' + v.reason + ' (' + v.errorCode + ') — not writing output');
    process.exit(1);
  }

  const outPath = args.out || path.join(path.dirname(args.profile), 'saax.json');
  fs.writeFileSync(outPath, JSON.stringify(signed, null, 2) + '\n', 'utf8');
  console.log('signed profile written to ' + outPath);
  console.log('signature.alg=' + signed.signature.alg + ' canonicalization=' + signed.signature.canonicalization + ' keyId=' + signed.signature.keyId);
  if (args.checkOnly) {
    process.exit(0);
  }
}

main().catch((e) => { console.error('failed: ' + (e && e.stack || e)); process.exit(1); });