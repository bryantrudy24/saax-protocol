// SAAX Discovery Phase 4 — live operator profile generator
//
// Generates a FRESH Ed25519 operator keypair (never committed), writes the
// PRIVATE key to the gitignored ./.output/.live-operator/ directory, and signs
// a LIVE standalone discovery profile (https://saax-protocol.com) that
// declares the deployed prepare_commitment + accept_commitment endpoints.
//
// The PUBLIC key + key thumbprint are printed for trust onboarding; the signed
// live profile is written to spec/examples/discovery/profile-live-signed.json
// (public artifact; the private key NEVER leaves .output/).
//
// Usage: node scripts/_provision-live-operator.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPair, exportJWK, calculateJwkThumbprint } = require('jose');
const cryptoLib = require('../endpoint/discovery-crypto');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.output', '.live-operator');
const PROFILE_OUT = path.join(ROOT, 'spec', 'examples', 'discovery', 'profile-live-signed.json');

const LIVE_PROFILE = {
  profileVersion: '1.0.0',
  providerId: 'https://saax-protocol.com/',
  providerName: 'SAAX Protocol — Live Discovery Provider',
  origin: 'https://saax-protocol.com',
  capabilities: [
    {
      id: 'security-scan',
      name: 'Security scan of endpoint',
      description: 'Runs a credentialed vulnerability scan against a buyer-supplied endpoint.',
      schemas: [
        { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333', purpose: 'commitment-manifest' }
      ],
      input: { units: { amount: '250000000', unit: 'micro-units of settlement asset' }, constraints: { maxAmount: '250000000', minDuration: 60, maxDuration: 86400 } },
      evidencePolicy: { requiredEvidenceTypes: ['vulnerability-scan-report'], minimumCountPerType: 1, maxEvidenceAgeSeconds: 3600, acceptedIssuers: ['0x5555555555555555555555555555555555555555'] },
      evaluatorRequirements: { verificationSchemes: ['jws'], minimumVendorScore: 80 },
      maturity: 'production',
      networkAvailability: { networks: ['eip155:8453'], testnetOnly: false },
    },
  ],
  financialCompatibility: {
    networks: ['eip155:8453'],
    assets: ['eip155:8453/erc20:0x833589fcd6eDb6E08f4c7C32D4f71b54bdA02913'],
    rails: ['x402', 'mpp', 'ap2', 'acp'],
    paymentModes: ['x402', 'mpp', 'ap2', 'acp'],
    paymentMode: 'x402',
    settlementModes: ['escrow'],
    defaultUnit: 'micro-units of settlement asset',
    supportedCombinations: [
      { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'x402', settlementCurrency: 'USDC', settlementDecimals: 6, financialTerms: 'financial', maturity: 'production' },
    ],
  },
  interfaces: { discovery: { profile: true, prepareCommitment: true, commitment: true } },
  conformance: {
    claims: [{ standard: 'SAAX Discovery Profile', version: '1.0.0', mode: 'self-declared' }],
    demonstrated: [{ test: 'SAAX Conformance Suite', version: '1.0.0', resultUrl: 'https://saax-protocol.com/conformance#discovery', result: 'pass' }],
  },
  trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
  endpoints: {
    discovery: 'https://saax-protocol.com/.well-known/saax.json',
    prepareCommitment: 'https://saax-protocol.com/prepare-commitment',
    acceptCommitment: 'https://saax-protocol.com/accept-commitment',
    allowCrossOrigin: [],
    schemaAllowlist: ['https://saax-protocol.com/schemas/'],
  },
  cacheControl: { maxAgeSeconds: 3600, staleWhileRevalidate: true },
  expires: '2027-11-06T00:00:00Z',
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const kp = await generateKeyPair('Ed25519', { extractable: true });
  const privateJwk = await exportJWK(kp.privateKey);
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  const thumbprint = await calculateJwkThumbprint(publicJwk);
  const keyId = 'live-2026-11';

  // Sign the live profile (Phase-2 signature profile: EdDSA over RFC 8785).
  const profile = JSON.parse(JSON.stringify(LIVE_PROFILE));
  profile.signingKeys = [{
    id: keyId, type: 'jwk', jwk: publicJwk,
    controller: 'https://saax-protocol.com/.well-known/did.json',
    validFrom: '2026-11-06T00:00:00Z', validUntil: '2027-11-06T00:00:00Z', status: 'active',
  }];
  const signed = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(profile)), privateJwk, keyId });

  // Private material stays in .output/ (gitignored).
  fs.writeFileSync(path.join(OUT_DIR, 'operator-private.jwk.json'), JSON.stringify(privateJwk, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(OUT_DIR, 'operator-public.jwk.json'), JSON.stringify(publicJwk, null, 2));
  // Public signed profile -> spec/examples/discovery (committed artifact).
  profile.signature = { scheme: 'jws', alg: 'EdDSA', keyId, jws: signed.jws, canonicalization: 'rfc8785' };
  fs.writeFileSync(PROFILE_OUT, JSON.stringify(profile, null, 2));

  console.log('Operator keypair generated.');
  console.log('  private key : ' + path.join(OUT_DIR, 'operator-private.jwk.json') + '  (0o600, gitignored)');
  console.log('  public key  : ' + JSON.stringify(publicJwk));
  console.log('  thumbprint  : ' + thumbprint);
  console.log('  keyId       : ' + keyId);
  console.log('  live profile: ' + PROFILE_OUT);
  console.log('\nTRUST ONBOARDING: clients MUST install this public key (or its thumbprint)');
  console.log('as the configured trusted provider key BEFORE they will authenticate');
  console.log('the live profile. This is a configured-key trust path — it is NOT');
  console.log('permissionless identity verification.');
})().catch((e) => { console.error('provision failed: ' + (e && e.stack || e)); process.exit(1); });