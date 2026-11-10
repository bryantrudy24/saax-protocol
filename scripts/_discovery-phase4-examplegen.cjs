// SAAX Discovery Phase 4 — buyer acceptance example generator (throwaway keys)
//
// Generates a REAL Ed25519 buyer keypair (throwaway fixture), writes the
// example signed acceptance contract for the Phase-3 signed proposal example,
// and writes an example buyer-registry config (public keys only). The private
// key is written to the gitignored path `spec/examples/discovery/keys/`.
//
// Run: node scripts/_discovery-phase4-examplegen.cjs

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateKeyPair } = require('jose');
const { signAcceptance } = require('../endpoint/acceptance-crypto');
const { proposalDigestOf } = require('../endpoint/acceptance-core');
const cryptoLib = require('../endpoint/discovery-crypto');

const ROOT = path.resolve(__dirname, '..');
const KEYS_DIR = path.join(ROOT, 'spec', 'examples', 'discovery', 'keys');

function canonicalTermsDigest(proposal) {
  return 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal.terms), 'utf8').digest('hex');
}

async function main() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });

  // Load the Phase-3 signed proposal example (the payload we bound).
  const proposal = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/examples/discovery/signed-proposal-valid-001.json'), 'utf8'));

  // Buyer keypair (throwaway; private key gitignored).
  const kp = await generateKeyPair('Ed25519', { extractable: true });
  const buyerPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const buyerPub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  fs.writeFileSync(path.join(KEYS_DIR, 'example-buyer-private.jwk.json'), JSON.stringify(buyerPriv, null, 2) + '\n');
  fs.writeFileSync(path.join(KEYS_DIR, 'example-buyer-public.jwk.json'), JSON.stringify(buyerPub, null, 2) + '\n');

  const acceptanceDoc = {
    schemaVersion: 'acceptance-v1',
    action: 'accept_commitment',
    domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_example00000000000001',
    nonce: 'accnonce-example-0001',
    buyer: proposal.audience ? proposal.audience.buyer : '0x1111111111111111111111111111111111111111',
    provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId },
    proposal: { proposalId: proposal.proposalId, proposalDigest: proposalDigestOf(proposal) },
    termsDigest: canonicalTermsDigest(proposal),
    audience: proposal.provider.providerId,
    notBefore: '2026-11-05T11:58:00Z',
    notAfter: '2026-11-05T12:30:00Z',
    versions: {
      profileVersion: proposal.profileVersion,
      manifestVersion: proposal.manifest.commitmentManifestVersion,
      schema: proposal.manifest.schema,
    },
  };

  const signed = await signAcceptance({ acceptance: acceptanceDoc, buyerPrivateJwk: buyerPriv, keyId: 'buyer-key-2026-01' });
  fs.writeFileSync(path.join(ROOT, 'spec/examples/discovery/acceptance-valid-001.json'), JSON.stringify(signed, null, 2) + '\n');

  // Example buyer registry (public keys only).
  const registry = {
    '0x1111111111111111111111111111111111111111': {
      publicJwk: buyerPub,
      scopeMaxAmount: '500000000',
      scopeCurrency: 'USDC',
      scopeCapability: 'security-scan',
    },
  };
  fs.writeFileSync(path.join(ROOT, 'spec/examples/discovery/buyer-registry-example.json'), JSON.stringify(registry, null, 2) + '\n');

  console.log('wrote: example-buyer-private.jwk.json (gitignored), example-buyer-public.jwk.json, acceptance-valid-001.json, buyer-registry-example.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
