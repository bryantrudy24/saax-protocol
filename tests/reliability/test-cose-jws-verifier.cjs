// SAAX Protocol — MCP Lifecycle Phase 5B: COSE/JWS cryptographic verifier
// conformance (isolated). Real jose (JWS) + cbor/node:crypto (COSE_Sign1)
// verification with the canonical algorithm allowlist, key resolution, and
// fail-closed rejection of untrusted/unsupported/structural-only input.
//
// Usage: node tests/reliability/test-cose-jws-verifier.cjs
'use strict';

const crypto = require('crypto');
const jose = require('jose');
const cbor = require('cbor');
const v = require('../../endpoint/cose-jws-verifier.js');

let PASS = 0, FAIL = 0;
function check(name, ok, info) {
  if (ok) { PASS++; console.log('PASS ' + name); }
  else { FAIL++; console.log('FAIL ' + name + ' :: ' + (info || '')); }
}

(async () => {
  // ---- shared fixtures ----
  const { publicKey: edPub, privateKey: edPriv } = crypto.generateKeyPairSync('ed25519');
  const edJwk = edPub.export({ format: 'jwk' });
  const { publicKey: edPub2 } = crypto.generateKeyPairSync('ed25519');
  const edJwk2 = edPub2.export({ format: 'jwk' });
  const comm = (p) => ({ evidenceId: p.evidenceId || 'ev-1', payloadHash: p.payloadHash || 'sha256:' + 'a'.repeat(64) });
  const payload = comm({});

  // ---- JWS ----
  // 1. valid EdDSA
  {
    const tok = await new jose.CompactSign(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'EdDSA' }).sign(edPriv);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'jws', signature: 'JWS_' + tok };
    const r = await v.verifyJws(ev, { resolver: async () => edJwk });
    check('J1-jws-valid', r.ok === true, r.reason || '');
  }
  // 2. tampered payload hash rejected
  {
    const tok = await new jose.CompactSign(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'EdDSA' }).sign(edPriv);
    const ev = { evidenceId: 'ev-1', payloadHash: 'sha256:' + 'b'.repeat(64), issuer: '0x' + 'a'.repeat(40), verificationScheme: 'jws', signature: 'JWS_' + tok };
    const r = await v.verifyJws(ev, { resolver: async () => edJwk });
    check('J2-jws-tampered-rejected', r.ok === false, r.reason || '');
  }
  // 3. wrong key rejected
  {
    const tok = await new jose.CompactSign(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'EdDSA' }).sign(edPriv);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'jws', signature: 'JWS_' + tok };
    const r = await v.verifyJws(ev, { resolver: async () => edJwk2 });
    check('J3-jws-wrong-key-rejected', r.ok === false, r.reason || '');
  }
  // 4. unsupported alg (RS256) rejected
  {
    const { publicKey: rsPub, privateKey: rsPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsJwk = rsPub.export({ format: 'jwk' });
    const tok = await new jose.CompactSign(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'RS256' }).sign(rsPriv);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'jws', signature: 'JWS_' + tok };
    const r = await v.verifyJws(ev, { resolver: async () => rsJwk });
    check('J4-jws-unsupported-alg-rejected', r.ok === false, r.reason || '');
  }
  // 5. no trusted key rejected
  {
    const tok = await new jose.CompactSign(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'EdDSA' }).sign(edPriv);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'jws', signature: 'JWS_' + tok };
    const r = await v.verifyJws(ev, { resolver: async () => null });
    check('J5-jws-no-key-rejected', r.ok === false, r.reason || '');
  }
  // 6. malformed token rejected (missing tag)
  {
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'jws', signature: 'notatoken' };
    const r = await v.verifyJws(ev, { resolver: async () => edJwk });
    check('J6-jws-missing-tag-rejected', r.ok === false, r.reason || '');
  }

  // ---- COSE ----
  async function buildSign1(priv, payloadBstr, { alg = -8, kid = null } = {}) {
    const h = new Map(); h.set(1, alg); if (kid) h.set(4, kid);
    const prot = await cbor.encodeAsync(h);
    const struct = await cbor.encodeAsync(['Signature1', prot, Buffer.alloc(0), payloadBstr]);
    const sig = crypto.sign(null, struct, priv);
    return [prot, new Map(), payloadBstr, sig];
  }
  // 7. valid COSE
  {
    const cbPayload = await cbor.encodeAsync(payload);
    const arr = await buildSign1(edPriv, cbPayload, { alg: -8, kid: 'key1' });
    const buf = await cbor.encodeAsync(arr);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationMaterial: 'kid:key1', verificationScheme: 'cose', signature: 'COSE_Sign1_' + buf.toString('base64url') };
    const r = await v.verifyCose(ev, { resolver: async () => edJwk });
    check('C1-cose-valid', r.ok === true, r.reason || '');
  }
  // 8. tampered hash rejected
  {
    const cbPayload = await cbor.encodeAsync(payload);
    const arr = await buildSign1(edPriv, cbPayload, { alg: -8 });
    const buf = await cbor.encodeAsync(arr);
    const ev = { evidenceId: 'ev-1', payloadHash: 'sha256:' + 'b'.repeat(64), issuer: '0x' + 'a'.repeat(40), verificationScheme: 'cose', signature: 'COSE_Sign1_' + buf.toString('base64url') };
    const r = await v.verifyCose(ev, { resolver: async () => edJwk });
    check('C2-cose-tampered-rejected', r.ok === false, r.reason || '');
  }
  // 9. wrong key rejected
  {
    const cbPayload = await cbor.encodeAsync(payload);
    const arr = await buildSign1(edPriv, cbPayload, { alg: -8 });
    const buf = await cbor.encodeAsync(arr);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'cose', signature: 'COSE_Sign1_' + buf.toString('base64url') };
    const r = await v.verifyCose(ev, { resolver: async () => edJwk2 });
    check('C3-cose-wrong-key-rejected', r.ok === false, r.reason || '');
  }
  // 10. unknown alg rejected
  {
    const cbPayload = await cbor.encodeAsync(payload);
    const arr = await buildSign1(edPriv, cbPayload, { alg: -65535 });
    const buf = await cbor.encodeAsync(arr);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'cose', signature: 'COSE_Sign1_' + buf.toString('base64url') };
    const r = await v.verifyCose(ev, { resolver: async () => edJwk });
    check('C4-cose-unknown-alg-rejected', r.ok === false, r.reason || '');
  }
  // 11. kid mismatch rejected
  {
    const cbPayload = await cbor.encodeAsync(payload);
    const arr = await buildSign1(edPriv, cbPayload, { alg: -8, kid: 'keyX' });
    const buf = await cbor.encodeAsync(arr);
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationMaterial: 'kid:key1', verificationScheme: 'cose', signature: 'COSE_Sign1_' + buf.toString('base64url') };
    const r = await v.verifyCose(ev, { resolver: async () => edJwk });
    check('C5-cose-kid-mismatch-rejected', r.ok === false, r.reason || '');
  }
  // 12. structural-only (garbage) cose rejected
  {
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'cose', signature: 'COSE_Sign1_' + 'ab'.repeat(40) };
    const r = await v.verifyCose(ev, { resolver: async () => edJwk });
    check('C6-cose-structural-only-rejected', r.ok === false, r.reason || '');
  }
  // 13. ugly: empty/truncated token rejected
  {
    const ev = { evidenceId: 'ev-1', payloadHash: payload.payloadHash, issuer: '0x' + 'a'.repeat(40), verificationScheme: 'cose', signature: 'COSE_Sign1_' };
    const r = await v.verifyCose(ev, { resolver: async () => edJwk });
    check('C7-cose-empty-rejected', r.ok === false, r.reason || '');
  }
  // 14. dispatch gate: unsupported scheme -> { ok:false }, never verified
  {
    const r = await v.verifyCoseJws({ verificationScheme: 'eip712', issuer: '0x' + 'a'.repeat(40) });
    check('G1-dispatch-rejects-eip712', r.ok === false && r.scheme === 'eip712', r.reason || '');
  }

  console.log('\n==== PHASE 5B COSE/JWS VERIFIER: ' + PASS + '/' + (PASS + FAIL) + ' PASS ====');
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
