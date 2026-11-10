// Generate a throwaway Ed25519 keypair (JWK) for DISCOVERY EXAMPLES ONLY.
// The private key written here is a PUBLIC test fixture — it is NOT a real
// secret and must never be used for a live provider. It exists so the example
// signed profile can be verified reproducibly.
const fs = require('fs');
const path = require('path');
const jose = require('jose');

(async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair('EdDSA', { extractable: true });
  const priv = await jose.exportJWK(privateKey);
  const pub = await jose.exportJWK(publicKey);
  const dir = path.join(__dirname, '..', 'spec', 'examples', 'discovery');
  fs.writeFileSync(path.join(dir, 'keys', 'example-private.jwk.json'), JSON.stringify(priv, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'keys', 'example-public.jwk.json'), JSON.stringify(pub, null, 2) + '\n');
  const thumbprint = await jose.calculateJwkThumbprint(pub);
  console.log('private: spec/examples/discovery/keys/example-private.jwk.json');
  console.log('public : spec/examples/discovery/keys/example-public.jwk.json');
  console.log('thumb  : ' + thumbprint);
})().catch((e) => { console.error('THREW ' + (e.message || e)); process.exit(1); });