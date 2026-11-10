// SAAX Discovery Phase 2 — controlled HTTPS test server
//
// Serves a real signed discovery profile over TLS on 127.0.0.1 (test-only; the
// resolver's allowLocalhost hook is enabled ONLY in tests). The runner passes a
// `profiles` object: { valid, tampered } — both signed by the SAME key, where
// `tampered` has altered content. Routes:
//   /             -> valid signed profile
//   /expired      -> profile with an expired signed `expires`
//   /tampered     -> a DIFFERENT (re-signed) payload than the one the client
//                    expects — proves byte-precision payload binding
//   /unsupported-version -> profileVersion 2.0.0
//   /wrong-origin -> profile whose origin != the server origin
//   /redirect-one -> 302 -> /
//   /redirect-loop -> 302 -> /redirect-loop (infinite)
//   /redirect-http -> 302 -> http://127.0.0.1/
//   /big          -> > 256 KiB body (application/json)
//   /timeout      -> accepts connection, never responds
//   /wrong-ctype  -> 200 text/plain
//   /notfound     -> 404
// Agent Card routes:
//   /agent-card.json            -> card WITH the SAAX extension
//   /agent-card-no-ext.json     -> card WITHOUT the extension
//   /agent-card-mismatch.json   -> card whose provider.url != profile origin
//   /agent-card-tampered.json   -> card with an invalid signature
//   /agent-card-no-json         -> 200 text/html
// TLS: self-signed cert from test-tls.cjs; the resolver pins it as `ca` so
// certificate verification stays ON (never rejectUnauthorized=false).

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const tlsHelper = require('./test-tls.cjs');

function startTestServer(profiles) {
  const { key, cert } = tlsHelper.ensureTestCert();
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  const valid = profiles.valid;
  const tampered = profiles.tampered;
  const rotated = profiles.rotated || null;
  const signer = profiles.resigner; // async (payload) => jws string for the SAME key

  const routes = {
    '/': () => ({ status: 200, type: 'application/json', body: JSON.stringify(valid) }),
    '/rotated': () => (rotated ? { status: 200, type: 'application/json', body: JSON.stringify(rotated) } : { status: 404 }),
    '/expired': () => {
      // Re-sign a body whose ONLY change is an expired `expires`, so the
      // signature is valid yet the profile is expired.
      const p = JSON.parse(JSON.stringify(valid));
      p.expires = '2020-01-01T00:00:00Z';
      delete p.signature;
      return signer(p).then((jws) => {
        p.signature = { scheme: 'jws', alg: 'EdDSA', keyId: 'key-test-1', jws, canonicalization: 'rfc8785' };
        return { status: 200, type: 'application/json', body: JSON.stringify(p) };
      });
    },
    '/tampered': () => {
      // On-the-wire tampering: same body, CORRUPTED signature bytes. The
      // signature no longer verifies -> DSC_INVALID_SIGNATURE.
      const p = JSON.parse(JSON.stringify(tampered));
      // Mutate a MIDDLE character: the final base64url char of an Ed25519
      // signature carries only padding bits, so flipping it can be a no-op.
      const jws = p.signature.jws;
      const at = Math.floor(jws.length / 2);
      const ch = jws[at];
      p.signature.jws = jws.slice(0, at) + (ch === 'A' ? 'B' : 'A') + jws.slice(at + 1);
      return { status: 200, type: 'application/json', body: JSON.stringify(p) };
    },
    '/unsupported-version': () => {
      const p = JSON.parse(JSON.stringify(valid));
      p.profileVersion = '2.0.0';
      return { status: 200, type: 'application/json', body: JSON.stringify(p) };
    },
    '/wrong-origin': () => {
      const p = JSON.parse(JSON.stringify(valid));
      p.origin = 'https://not-the-server.example';
      p.providerId = p.providerId.replace('127.0.0.1', 'not-the-server.example');
      return { status: 200, type: 'application/json', body: JSON.stringify(p) };
    },
    '/redirect-one': () => ({ status: 302, headers: { location: '/' } }),
    '/redirect-loop': () => ({ status: 302, headers: { location: '/redirect-loop' } }),
    '/redirect-http': () => ({ status: 302, headers: { location: 'http://127.0.0.1/' } }),
    '/big': () => ({ status: 200, type: 'application/json', body: '{"padding":"' + 'a'.repeat(300 * 1024) + '"}' }),
    '/timeout': () => new Promise(() => { /* never respond */ }),
    '/wrong-ctype': () => ({ status: 200, type: 'text/plain', body: 'not json' }),
    '/notfound': () => ({ status: 404 }),
  };

  const cardRoutes = {
    '/agent-card.json': () => ({
      status: 200, type: 'application/json',
      body: JSON.stringify({
        name: 'SAAX Test Provider',
        description: 'Controlled test agent card for discovery phase 2.',
        supportedInterfaces: [{ url: 'https://127.0.0.1/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        version: '1.0.0',
        capabilities: {
          streaming: false,
          pushNotifications: false,
          extensions: [{ uri: 'https://saax-protocol.com/extensions/saax-discovery/v1', description: 'SAAX Discovery v1', required: false }],
          extendedAgentCard: false,
        },
        provider: { organization: 'SAAX Test Provider', url: 'https://127.0.0.1' },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }),
    }),
    '/agent-card-no-ext.json': () => ({
      status: 200, type: 'application/json',
      body: JSON.stringify({
        name: 'Non-SAAX Test Agent',
        description: 'Card without the SAAX extension.',
        supportedInterfaces: [{ url: 'https://127.0.0.1/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        version: '1.0.0',
        capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
        provider: { organization: 'Non-SAAX', url: 'https://127.0.0.1' },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }),
    }),
    '/agent-card-mismatch.json': () => ({
      status: 200, type: 'application/json',
      body: JSON.stringify({
        name: 'Mismatch Agent',
        description: 'Card whose provider.url disagrees with the profile origin.',
        supportedInterfaces: [{ url: 'https://127.0.0.1/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        version: '1.0.0',
        capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: 'https://saax-protocol.com/extensions/saax-discovery/v1', required: false }], extendedAgentCard: false },
        provider: { organization: 'Mismatch Agent', url: 'https://elsewhere.example' },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }),
    }),
    '/agent-card-tampered.json': () => ({
      status: 200, type: 'application/json',
      body: JSON.stringify({
        name: 'Tampered Agent',
        description: 'Card with an invalid signature.',
        supportedInterfaces: [{ url: 'https://127.0.0.1/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        version: '1.0.0',
        capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: 'https://saax-protocol.com/extensions/saax-discovery/v1', required: false }], extendedAgentCard: false },
        provider: { organization: 'Tampered Agent', url: 'https://127.0.0.1' },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
        signatures: [{ protected: 'e30', signature: 'c2ln' }],
      }),
    }),
    '/agent-card-no-json': () => ({ status: 200, type: 'text/html', body: '<html>not a card</html>' }),
  };

  server.on('request', async (req, res) => {
    req.on('aborted', () => { res.socket && res.socket.destroy(); });
    const urlPath = (req.url || '/').split('?')[0];
    const handler = routes[urlPath] || cardRoutes[urlPath] || (() => ({ status: 404 }));
    let result;
    try {
      result = handler();
    } catch (e) {
      result = { status: 500, type: 'application/json', body: JSON.stringify({ error: e.message }) };
    }
    if (result && typeof result.then === 'function') {
      if (urlPath === '/timeout') return; // timeout route: leave the socket open forever
      try { result = await result; } catch (e) {
        result = { status: 500, type: 'application/json', body: JSON.stringify({ error: e.message }) };
      }
    }
    if (!result) { res.statusCode = 404; res.end(); return; }
    res.statusCode = result.status || 200;
    if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    if (result.type) res.setHeader('Content-Type', result.type);
    res.end(result.body !== undefined ? result.body : '');
    // If the client aborts (e.g. size-limit rejection), destroy the socket so
    // server.close() can complete.
    res.on('close', () => { res.socket && res.socket.destroy(); });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, baseUrl: 'https://127.0.0.1:' + port, certPem: tlsHelper.certPem() });
    });
  });
}

module.exports = { startTestServer };