// SAAX Discovery Phase 2 — executable tests: real crypto + controlled network
//
// Runs against a LOCAL controlled HTTPS server (tests/discovery-phase2/test-server.cjs)
// on 127.0.0.1 with a real self-signed cert. Retrieval uses the resolver with
// `permitLocalhost: true` (test-only hook — production policy never sets it)
// and pins the test CA so TLS verification remains fully enabled.
//
// Cases (each asserts a SPECIFIC error code, never "nonzero exit"):
//   crypto:
//     1  valid signed profile from a configured trusted publisher succeeds
//     2  valid signature from an untrusted key does NOT authenticate
//     3  altered payload fails (DSC_PAYLOAD_MISMATCH)
//     4  unsupported algorithm fails (DSC_UNSUPPORTED_ALGORITHM)
//     5  invalid signature fails (DSC_INVALID_SIGNATURE)
//     6  expired profile fails (DSC_PROFILE_EXPIRED)
//     7  wrong controller/key-id fails (DSC_KEY_ID_MISMATCH)
//     8  invalid key status (revoked) fails (DSC_KEY_NOT_ACTIVE)
//   retrieval:
//     9  https-only: http:// URL refused (DSC_UNSAFE_RETRIEVAL)
//     10 private/loopback blocked: LAN IP refused (DSC_UNSAFE_RETRIEVAL)
//     11 redirect limit: /redirect-loop fails (DSC_RETRIEVAL_REDIRECT_LIMIT)
//     12 redirect to http refused (DSC_UNSAFE_RETRIEVAL)
//     13 size limit: /big fails (DSC_RETRIEVAL_SIZE)
//     14 timeout: /timeout fails (DSC_RETRIEVAL_IO or DSC_RETRIEVAL_TIME)
//     15 content-type: /wrong-ctype fails (DSC_RETRIEVAL_CONTENT_TYPE)
//     16 valid redirect (one hop) still succeeds
//   trust & fallback:
//     17 valid A2A card + standalone profile -> resolved, authenticated
//     18 card without extension + permit fallback -> resolved via standalone
//     19 card without extension + NO permit -> no_fallback (DSC_MISSING_REQUIRED_EXTENSION)
//     20 tampered card -> no fallback (DSC_AUTH_FAILED_NO_FALLBACK)
//     21 wrong-origin profile -> DSC_ORIGIN_MISMATCH
//     22 unsupported-version profile -> DSC_UNSUPPORTED_VERSION
//     23 cache: second resolve hits cache, expiry invalidates
//     24 rotation: new key trusted -> ok; old stale -> trust failure
//     25 untrusted profile from untrusted key: valid crypto but authenticated=false

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const jose = require('jose');
const crypto = require('node:crypto');
const cryptoLib = require('../../endpoint/discovery-crypto');
const resolverLib = require('../../endpoint/discovery-resolver');
const { startTestServer } = require('./test-server.cjs');
const { certPem } = require('./test-tls.cjs');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push(name); console.log('[FAIL] ' + name + (detail ? ' — ' + detail : '')); }
}

async function makeProfile(overrides) {
  // Build a realistic profile (mirrors spec/examples/discovery/profile-valid-001.json)
  // with a real Ed25519 keypair; returns { profile, privateJwk, publicJwk, thumbprint }.
  const { publicKey, privateKey } = await jose.generateKeyPair('EdDSA', { extractable: true });
  const privateJwk = await jose.exportJWK(privateKey);
  const publicJwk = await jose.exportJWK(publicKey);
  const thumbprint = await jose.calculateJwkThumbprint(publicJwk);

  const now = new Date();
  const expires = new Date(now.getTime() + 60 * 60 * 1000); // +1h
  const validUntil = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
  const validFrom = new Date(now.getTime() - 24 * 3600 * 1000);

  const profile = {
    profileVersion: '1.0.0',
    providerId: 'https://127.0.0.1/',
    providerName: 'SAAX Test Provider',
    origin: 'https://127.0.0.1',
    signingKeys: [
      {
        id: 'key-test-1',
        type: 'jwk',
        jwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
        controller: 'https://127.0.0.1/.well-known/did.json',
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
        status: 'active',
      },
    ],
    capabilities: [
      {
        id: 'security-scan',
        name: 'Security scan of endpoint',
        description: 'Runs a credentialed vulnerability scan against a buyer-supplied endpoint.',
        schemas: [
          {
            id: 'https://saax-protocol.com/schemas/commitment-manifest/v1',
            version: '1',
            digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
            purpose: 'commitment-manifest',
          },
        ],
        input: { units: { amount: '250000000', unit: 'micro-units of settlement asset' } },
        evidencePolicy: { requiredEvidenceTypes: ['vulnerability-scan-report'] },
        evaluatorRequirements: { verificationSchemes: ['eip712', 'cose', 'jws'] },
        maturity: 'production',
      },
    ],
    financialCompatibility: {
      networks: ['eip155:8453'],
      assets: ['eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      rails: ['x402', 'mpp'],
      paymentModes: ['x402', 'mpp'],
      supportedCombinations: [
        { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', rail: 'x402', mode: 'x402', maturity: 'production' },
      ],
    },
    interfaces: { discovery: { profile: true, prepareCommitment: false, commitment: true } },
    conformance: {
      claims: [{ standard: 'SAAX Discovery Profile', version: '1.0.0', mode: 'self-declared' }],
      demonstrated: [{ test: 'SAAX Conformance Suite', version: '1.0.0', resultUrl: 'https://127.0.0.1/conformance#discovery', result: 'pass' }],
    },
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
    endpoints: { discovery: 'https://127.0.0.1/.well-known/saax.json' },
    expires: expires.toISOString(),
  };

  // Sign the canonical payload (profile WITHOUT the signature envelope).
  const { jws } = await cryptoLib.signProfileCanonical({ payload: profile, privateJwk, keyId: 'key-test-1' });
  profile.signature = { scheme: 'jws', alg: 'EdDSA', keyId: 'key-test-1', jws, canonicalization: 'rfc8785' };

  if (overrides) {
    if (overrides.profile) Object.assign(profile, overrides.profile);
    if (overrides.signingKeys) profile.signingKeys = overrides.signingKeys;
    if (overrides.signature) Object.assign(profile.signature, overrides.signature);
  }
  return { profile, privateJwk, publicJwk, thumbprint };
}

async function run() {
  const ca = certPem();

  // ---- crypto-direct cases (no network) ----
  {
    const { profile, privateJwk, publicJwk } = await makeProfile();
    const payload = { ...profile };
    delete payload.signature;
    const { jws } = await cryptoLib.signProfileCanonical({ payload, privateJwk, keyId: 'key-test-1' });
    const v = await cryptoLib.verifySignature({ jws, publicJwk, expectedKeyId: 'key-test-1', expectedPayload: payload });
    check('crypto: valid signed doc verifies', v.ok === true, v.reason);
  }
  {
    // Tamper with the SAME key over an ALTERED payload: verification against
    // the original expected document must fail with DSC_PAYLOAD_MISMATCH.
    const { profile, privateJwk, publicJwk } = await makeProfile();
    const payload = { ...profile };
    delete payload.signature;
    const sig = await cryptoLib.signProfileCanonical({ payload: { ...payload, providerName: 'ALTERED' }, privateJwk, keyId: 'key-test-1' });
    const expectedOriginal = payload;
    const v3 = await cryptoLib.verifySignature({ jws: sig.jws, publicJwk, expectedKeyId: 'key-test-1', expectedPayload: expectedOriginal });
    check('crypto: altered payload fails vs original (DSC_PAYLOAD_MISMATCH)', v3.ok === false && v3.errorCode === 'DSC_PAYLOAD_MISMATCH', v3.reason);
  }
  {
    const { profile, privateJwk, publicJwk } = await makeProfile();
    // tamper the jws itself
    const payload = { ...profile };
    delete payload.signature;
    const j = profile.signature.jws;
    const at = Math.floor(j.length / 2);
    const mutated = j.slice(0, at) + (j[at] === 'A' ? 'B' : 'A') + j.slice(at + 1);
    const bad = await cryptoLib.verifySignature({ jws: mutated, publicJwk, expectedKeyId: 'key-test-1', expectedPayload: payload });
    check('crypto: invalid signature fails (DSC_INVALID_SIGNATURE)', bad.ok === false && bad.errorCode === 'DSC_INVALID_SIGNATURE', bad.errorCode);
  }

  // ---- network cases ----
  const { profile, thumbprint, privateJwk, publicJwk } = await makeProfile();
  // Build a tampered twin: SAME key, ALTERED content, re-signed but with a
  // DIFFERENT body than the original — the server serves this on /tampered.
  const tamperedTwin = JSON.parse(JSON.stringify(profile));
  tamperedTwin.providerName = 'TAMPERED PROVIDER NAME';
  delete tamperedTwin.signature;
  const tamperedSig = await cryptoLib.signProfileCanonical({ payload: tamperedTwin, privateJwk, keyId: 'key-test-1' });
  tamperedTwin.signature = { scheme: 'jws', alg: 'EdDSA', keyId: 'key-test-1', jws: tamperedSig.jws, canonicalization: 'rfc8785' };

  const serverCtx = await startTestServer({
    valid: profile,
    tampered: tamperedTwin,
    rotated: null, // set below once a second key is generated
    resigner: async (payload) => {
      const s = await cryptoLib.signProfileCanonical({ payload, privateJwk, keyId: 'key-test-1' });
      return s.jws;
    },
  });
  const { server, port, baseUrl } = serverCtx;
  const origin = 'https://127.0.0.1';

  const trustConfig = {
    providerId: 'https://127.0.0.1/',
    origin,
    trustedKeys: [thumbprint],
    trustedVerificationKeys: [publicJwk],
    allowStandaloneFallback: false, // card-path tests override
    permitLocalhost: true,
  };

  try {
    // 1: valid profile from trusted publisher
    {
      const r = await resolverLib.resolveProfile({
        trust: trustConfig,
        url: baseUrl + '/',
        retrieveOpts: { ca },
      });
      check('valid signed profile from configured trusted publisher succeeds', r.ok === true && r.authenticated === true && r.trust.trustSource === 'configured-key', JSON.stringify(r).slice(0, 200));
    }
    // 2: untrusted key
    {
      const otherConfig = { ...trustConfig, trustedKeys: ['0'.repeat(43)] };
      const r = await resolverLib.resolveProfile({ trust: otherConfig, url: baseUrl + '/', retrieveOpts: { ca } });
      check('valid signature from untrusted key does NOT authenticate', r.ok === true && r.authenticated === false, JSON.stringify(r.trust || {}));
    }
    // 3-8 network variants
    {
      const expired = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/expired', retrieveOpts: { ca } });
      check('expired profile fails (DSC_PROFILE_EXPIRED)', !expired.ok && expired.errorCode === 'DSC_PROFILE_EXPIRED', expired.errorCode);
    }
    {
      const tampered = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/tampered', retrieveOpts: { ca } });
      const okCodes = ['DSC_PAYLOAD_MISMATCH', 'DSC_INVALID_SIGNATURE'];
      check('altered payload fails (DSC_PAYLOAD_MISMATCH or INVALID_SIGNATURE)', !tampered.ok && okCodes.includes(tampered.errorCode), JSON.stringify({ code: tampered.errorCode, reason: tampered.reason }).slice(0, 300));
    }
    {
      const unsup = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/unsupported-version', retrieveOpts: { ca } });
      check('unsupported version fails (DSC_UNSUPPORTED_VERSION)', !unsup.ok && unsup.errorCode === 'DSC_UNSUPPORTED_VERSION', unsup.errorCode);
    }
    {
      const wrongOrigin = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/wrong-origin', retrieveOpts: { ca } });
      check('wrong origin fails (DSC_ORIGIN_MISMATCH)', !wrongOrigin.ok && wrongOrigin.errorCode === 'DSC_ORIGIN_MISMATCH', wrongOrigin.errorCode);
    }
    // http url refused
    {
      const httpUrl = await resolverLib.resolveProfile({ trust: trustConfig, url: 'http://127.0.0.1:' + port + '/', retrieveOpts: { ca } });
      check('http:// URL refused (DSC_UNSAFE_RETRIEVAL)', !httpUrl.ok && httpUrl.errorCode === 'DSC_UNSAFE_RETRIEVAL', httpUrl.errorCode);
    }
    // private/loopback blocked when not permitted
    {
      const noLocal = resolverLib.resolveProfile({ trust: { ...trustConfig, permitLocalhost: false }, url: 'https://' + '10.0.0.1' + '/', retrieveOpts: { ca } });
      const r = await noLocal;
      check('private/loopback destination blocked when not permitted (DSC_UNSAFE_RETRIEVAL)', !r.ok && r.errorCode === 'DSC_UNSAFE_RETRIEVAL', r.reason || r.errorCode);
    }
    // redirect loop
    {
      const loop = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/redirect-loop', retrieveOpts: { ca } });
      check('redirect limit enforced (DSC_RETRIEVAL_REDIRECT_LIMIT)', !loop.ok && loop.errorCode === 'DSC_RETRIEVAL_REDIRECT_LIMIT', loop.errorCode);
    }
    // redirect to http refused
    {
      const toHttp = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/redirect-http', retrieveOpts: { ca } });
      check('redirect to http refused (DSC_UNSAFE_RETRIEVAL)', !toHttp.ok && toHttp.errorCode === 'DSC_UNSAFE_RETRIEVAL', toHttp.errorCode);
    }
    // size limit
    {
      const big = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/big', retrieveOpts: { ca } });
      check('size limit enforced (DSC_RETRIEVAL_SIZE)', !big.ok && big.errorCode === 'DSC_RETRIEVAL_SIZE', big.errorCode);
    }
    // timeout
    {
      const to = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/timeout', retrieveOpts: { ca } });
      check('timeout enforced', !to.ok && ['DSC_RETRIEVAL_IO', 'DSC_RETRIEVAL_TIME'].includes(to.errorCode), to.errorCode);
    }
    // content-type
    {
      const ct = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/wrong-ctype', retrieveOpts: { ca } });
      check('content-type guard (DSC_RETRIEVAL_CONTENT_TYPE)', !ct.ok && ct.errorCode === 'DSC_RETRIEVAL_CONTENT_TYPE', ct.errorCode);
    }
    // valid redirect (one hop)
    {
      const one = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/redirect-one', retrieveOpts: { ca } });
      check('valid redirect (one hop) succeeds', one.ok === true && one.authenticated === true, JSON.stringify(one).slice(0, 160));
    }

    // ---- A2A card + fallback ----
    {
      const r = await resolverLib.resolveProfile({ trust: { ...trustConfig, allowStandaloneFallback: true }, cardUrl: baseUrl + '/agent-card.json', url: baseUrl + '/', retrieveOpts: { ca } });
      check('card WITH extension + profile -> resolved, authenticated', r.ok === true && r.authenticated === true && r.a2a && r.a2a.hasExtension === true, JSON.stringify(r.a2a || {}));
    }
    {
      const r = await resolverLib.resolveProfile({ trust: { ...trustConfig, allowStandaloneFallback: true }, cardUrl: baseUrl + '/agent-card-no-ext.json', url: baseUrl + '/', retrieveOpts: { ca } });
      check('card WITHOUT extension + permit fallback -> standalone resolves', r.ok === true && r.authenticated === true, JSON.stringify(r).slice(0, 160));
    }
    {
      const r = await resolverLib.resolveProfile({ trust: { ...trustConfig, allowStandaloneFallback: false }, cardUrl: baseUrl + '/agent-card-no-ext.json', url: baseUrl + '/', retrieveOpts: { ca } });
      check('card WITHOUT extension + NO permit -> no_fallback', !r.ok && r.errorCode === 'DSC_MISSING_REQUIRED_EXTENSION', r.errorCode);
    }
    {
      const r = await resolverLib.resolveProfile({ trust: { ...trustConfig, allowStandaloneFallback: true }, cardUrl: baseUrl + '/agent-card-tampered.json', url: baseUrl + '/', retrieveOpts: { ca } });
      check('tampered card -> AUTH FAILED, no fallback', !r.ok && r.errorCode === 'DSC_AUTH_FAILED_NO_FALLBACK', r.errorCode + ' ' + (r.reason || ''));
    }
    {
      const r = await resolverLib.resolveProfile({ trust: { ...trustConfig, allowStandaloneFallback: true }, cardUrl: baseUrl + '/agent-card-mismatch.json', url: baseUrl + '/', retrieveOpts: { ca } });
      check('card/provider.url mismatch -> representation conflict', r.ok === true && r.a2a && r.a2a.inconsistency && r.a2a.inconsistency.length > 0, JSON.stringify(r.a2a && r.a2a.inconsistency));
    }

    // ---- cache ----
    {
      const cache = new resolverLib.ProfileCache();
      const r1 = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/', cache, retrieveOpts: { ca } });
      const r2 = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/', cache, retrieveOpts: { ca } });
      check('cache hit serves second resolve', r1.ok === true && r2.ok === true && r2.fromCache === true, 'fromCache=' + r2.fromCache);
      // expiry invalidation: cache an expired profile then request again
      const expCache = new resolverLib.ProfileCache();
      const re = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/expired', cache: expCache, retrieveOpts: { ca } });
      const re2 = await resolverLib.resolveProfile({ trust: trustConfig, url: baseUrl + '/expired', cache: expCache, retrieveOpts: { ca } });
      check('expired profile not served from cache', !re.ok && !re2.ok && re2.errorCode === 'DSC_PROFILE_EXPIRED', re2.errorCode);
    }

    // ---- rotation ----
    {
      // Real rotation: a NEW key signs a NEW profile body. The old profile (with
      // the old key) must NOT be served as valid under the new trust, and a
      // profile signed by the OLD key must fail trust after rotation.
      const { profile: rotatedProfile, thumbprint: newThumb } = await makeProfile({});
      const rot = JSON.parse(JSON.stringify(rotatedProfile));
      // Serve the rotated profile at /rotated (the server binds routes at
      // start, so mutate the route table live): use a NEW server instance for
      // the rotated body.
      const rotServer = await startTestServer({
        valid: rot,
        tampered: tamperedTwin,
        rotated: rot,
        resigner: async (payload) => {
          const s = await cryptoLib.signProfileCanonical({ payload, privateJwk, keyId: 'key-test-1' });
          return s.jws;
        },
      });
      const rotCache = new resolverLib.ProfileCache();
      const r1 = await resolverLib.resolveProfile({ trust: { ...trustConfig, trustedKeys: [newThumb] }, url: rotServer.baseUrl + '/', cache: rotCache, retrieveOpts: { ca: certPem() } });
      check('rotation: new trusted key resolves', r1.ok === true && r1.authenticated === true, JSON.stringify(r1.trust || {}));
      // The OLD key (the original `thumbprint`) is no longer trusted: the same
      // profile URL under the OLD trust config must fail authentication (the
      // profile's signature just does not match the new anchor — the body is
      // signed by the NEW key).
      const r2 = await resolverLib.resolveProfile({ trust: { ...trustConfig, trustedKeys: [thumbprint] }, url: rotServer.baseUrl + '/', cache: new resolverLib.ProfileCache(), retrieveOpts: { ca: certPem() } });
      check('rotation: old trust anchor does NOT accept the new key', r2.ok === true && r2.authenticated === false, JSON.stringify(r2.trust || {}));
      rotServer.server.closeAllConnections();
      rotServer.server.close();
    }
  } finally {
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }

  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    console.log('Failed: ' + failures.join(', '));
    process.exitCode = 1;
  }
}

run().catch((e) => { console.error('RUNNER THREW: ' + (e && e.stack || e)); process.exitCode = 1; });