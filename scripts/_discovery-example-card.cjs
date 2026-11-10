// Generate a signed A2A Agent Card example (SAAX extension + JWS signature).
const fs = require('fs');
const path = require('path');
const jose = require('jose');
const cryptoLib = require('../endpoint/discovery-crypto');

(async () => {
  const dir = path.join(__dirname, '..', 'spec', 'examples', 'discovery');
  const priv = JSON.parse(fs.readFileSync(path.join(dir, 'keys', 'example-private.jwk.json'), 'utf8'));

  const card = {
    name: 'Example SAAX Provider (illustrative)',
    description: 'Illustrative A2A Agent Card for the SAAX Discovery Profile v1.0.0 extension.',
    supportedInterfaces: [
      { url: 'https://example-provider.test/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    provider: { organization: 'Example SAAX Provider (illustrative)', url: 'https://example-provider.test' },
    version: '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: 'https://saax-protocol.com/extensions/saax-discovery/v1',
          description: 'SAAX Discovery Profile v1: provider capability and financial-compatibility declaration, plus free nonbinding prepare_commitment preflight.',
          required: false,
        },
      ],
      extendedAgentCard: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [{ id: 'security-scan', name: 'Security scan', description: 'Runs a credentialed vulnerability scan against a buyer-supplied endpoint.', tags: ['security', 'scan'] }],
  };

  // A2A v1.0 requires the signature over the RFC 8785 canonicalized card
  // (excluding the signatures field). Use the same Ed25519 key as the profile.
  const { signatures: _omit, ...payload } = card;
  const canonical = cryptoLib.jcs(payload);
  const protectedHeader = { alg: 'EdDSA', kid: 'key-2026-01' };
  const { publicKey, privateKey } = await jose.generateKeyPair('EdDSA', { extractable: true });
  const priv2 = await jose.exportJWK(privateKey);
  // Sign with the example key (the private JWK from keys/).
  const signer = await new jose.FlattenedSign(Buffer.from(canonical, 'utf8'))
    .setProtectedHeader(protectedHeader)
    .sign(await jose.importJWK(priv, 'EdDSA'));
  card.signatures = [{ protected: signer.protected, signature: signer.signature }];

  fs.writeFileSync(path.join(dir, 'agent-card-valid-001.json'), JSON.stringify(card, null, 2) + '\n');
  console.log('wrote spec/examples/discovery/agent-card-valid-001.json');

  // Verify the card signature independently.
  const v = await cryptoLib.verifySignature({
    jws: signer.protected + '.' + signer.payload + '.' + signer.signature,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: priv.x },
    expectedPayload: payload,
  });
  console.log('card signature verifies:', v.ok, v.errorCode || '');
  process.exit(v.ok ? 0 : 1);
})().catch((e) => { console.error('THREW ' + (e.message || e)); process.exit(1); });