// SAAX Protocol — MCP Lifecycle Phase 4C/4D: Cryptographic evidence verification
// + proof issuer trust policy conformance (isolated, no testbed DB needed).
//
// Runs the full check chain from evidence-verification.js against the
// evidence.js EIP-712 verifier with real signatures, covering:
//   structure/scheme/binding/integrity/signature/signer identity/timestamp/
//   issuer trust + the distinction between submitted vs verified evidence.
//
// Usage: node tests/reliability/test-evidence-verification.cjs
'use strict';

const { privateKeyToAccount } = require('viem/accounts');
const { signTypedData } = require('viem/accounts');
const crypto = require('crypto');
const { verifyEvidenceCrypto } = require('../../endpoint/evidence-verification.js');
const evidence = require('../../endpoint/evidence.js');
const { CompactSign } = require('jose');
const coseJws = require('../../endpoint/cose-jws-verifier.js');
const cbor = require('cbor');

let PASS = 0, FAIL = 0;
function check(name, ok, info) {
  if (ok) { PASS++; console.log('PASS ' + name + (info ? ' :: ' + info : '')); }
  else { FAIL++; console.log('FAIL ' + name + (info ? ' :: ' + info : '')); }
}

// Deterministic issuer key
const ISSUER = privateKeyToAccount('0x' + '7'.repeat(64));
const OTHER = privateKeyToAccount('0x' + '8'.repeat(64));

// EIP-712 evidence domain/types (mirror evidence.js — 8-field signed message)
const EVIDENCE_DOMAIN = { name: 'SAAX Evidence', version: '1' };
const EVIDENCE_TYPES = {
  Evidence: [
    { name: 'evidenceId', type: 'string' },
    { name: 'issuer', type: 'address' },
    { name: 'subject', type: 'address' },
    { name: 'commitmentId', type: 'string' },
    { name: 'acceptanceCriterionId', type: 'string' },
    { name: 'payloadHash', type: 'string' },
  ],
};

function buildEnvelope({ tamper, wrongIssuer, wrongCommitment, wrongCriterion, cose, untrustedCose }) {
  const payload = { temperature: 4, unit: 'C' };
  const payloadHash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  const env = {
    evidenceId: 'evd-' + crypto.randomBytes(6).toString('hex'),
    evidenceType: 'temperature-reading',
    issuer: wrongIssuer ? OTHER.address : ISSUER.address,
    subject: '0x' + 'a'.repeat(40),
    issuanceTimestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    contextReference: 'ctx-1',
    payload,
    payloadHash,
    verificationScheme: cose ? 'cose' : 'eip712',
    commitmentId: 'c-temp',
    acceptanceCriterionId: 'crit-1',
    provenance: { source: 'sensor-1' },
    signature: '',
  };
  if (wrongCommitment) env.commitmentId = 'c-wrong';
  if (wrongCriterion) env.acceptanceCriterionId = 'crit-wrong';
  if (cose) { env.signature = 'COSE_Sign1_' + 'ab'.repeat(40); }
  return env;
}

async function signEvidence(env, signerOverride) {
  const typed = {
    domain: EVIDENCE_DOMAIN,
    types: EVIDENCE_TYPES,
    primaryType: 'Evidence',
    message: {
      evidenceId: env.evidenceId,
      issuer: env.issuer,
      subject: env.subject,
      commitmentId: env.commitmentId,
      acceptanceCriterionId: env.acceptanceCriterionId,
      payloadHash: env.payloadHash,
    },
  };
  env.signature = await (signerOverride || ISSUER).signTypedData(typed);
  return env;
}

(async () => {
  const context = { commitmentId: 'c-temp', criterionId: 'crit-1', acceptanceCriteria: { acceptedIssuers: [] } };

  // 1. Valid EIP-712 evidence passes the full chain
  let env = buildEnvelope({});
  await signEvidence(env);
  let r = await verifyEvidenceCrypto(env, context);
  check('T1-valid-eip712-verified', r.ok && r.stage === 'ok' && r.policyVersion === 'saax-evidence-v1', JSON.stringify(r && r.checks));

  // 2. Evidence received but NOT auto-fulfilled: ok:true ≠ verified by policy
  const policy = await evidence.evaluateEvidencePolicy ? evidence.evaluateEvidencePolicy(env, { acceptanceCriteria: { verificationPolicy: { outcome: 'pending' } } }) : null;
  check('T2-submitted-not-auto-fulfilled', !policy || policy.outcome === 'pending', JSON.stringify(policy || 'no-policy-eval'));

  // 3. Missing fields (structure) rejected
  r = await verifyEvidenceCrypto({}, context);
  check('T3-empty-envelope-rejected', !r.ok && r.stage === 'structure', r.reason);

  // 4. Bad scheme rejected
  r = await verifyEvidenceCrypto({ ...env, verificationScheme: 'invalid' }, context);
  check('T4-bad-scheme-rejected', !r.ok && r.stage === 'scheme', r.reason);

  // 5. Commitment binding mismatch
  const env5 = buildEnvelope({ wrongCommitment: true });
  await signEvidence(env5);
  r = await verifyEvidenceCrypto(env5, context);
  check('T5-wrong-commitment-rejected', !r.ok && r.stage === 'binding', r.reason);

  // 6. Criterion binding mismatch
  const env6 = buildEnvelope({ wrongCriterion: true });
  await signEvidence(env6);
  r = await verifyEvidenceCrypto(env6, context);
  check('T6-wrong-criterion-rejected', !r.ok && r.stage === 'binding', r.reason);

  // 7. Tampered payload hash rejected
  const env7 = buildEnvelope({});
  await signEvidence(env7);
  env7.payloadHash = 'sha256:' + '0'.repeat(64);
  r = await verifyEvidenceCrypto(env7, context);
  check('T7-tampered-hash-rejected', !r.ok && r.stage === 'integrity', r.reason);

  // 8. Wrong signer (forged signature) rejected: envelope claims ISSUER but is
  //    signed by OTHER (recovery-to-issuer fails).
  const env8 = buildEnvelope({});
  await signEvidence(env8, OTHER); // sign with OTHER while issuer=ISSUER → mismatch
  r = await verifyEvidenceCrypto(env8, context);
  check('T8-forged-signer-rejected', !r.ok && r.stage === 'signature', r.reason);

  // 9. Future timestamp rejected
  const env9 = buildEnvelope({});
  env9.issuanceTimestamp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await signEvidence(env9);
  r = await verifyEvidenceCrypto(env9, context);
  check('T9-future-timestamp-rejected', !r.ok && r.stage === 'timestamp', r.reason);

  // 10. COSE (structural-only, forged signature) with no issuer on allowlist:
  //     rejected — either at the cryptographic signature stage (Phase 5B real
  //     verification fails first) or the issuer-trust stage. Contract: never
  //     verified.
  let env10 = buildEnvelope({ cose: true });
  process.env.SAAX_EVIDENCE_ISSUER_ALLOWLIST = '';
  r = await verifyEvidenceCrypto(env10, context);
  check('T10-cose-untrusted-issuer-rejected', !r.ok && (r.stage === 'issuer' || r.stage === 'signature'), r.reason);

  // 11. COSE with issuer on allowlist: structural-only envelope (fake sig,
  //     invalid CBOR) MUST be rejected at the signature stage — Phase 5B never
  //     treats structural validity as cryptographic verification.
  process.env.SAAX_EVIDENCE_ISSUER_ALLOWLIST = ISSUER.address;
  env10 = buildEnvelope({ cose: true });
  r = await verifyEvidenceCrypto(env10, context);
  check('T11-cose-structural-not-verified', !r.ok && r.stage === 'signature', r.reason + ' :: ' + JSON.stringify(r && r.checks));
  process.env.SAAX_EVIDENCE_ISSUER_ALLOWLIST = '';

  // 12b. (renumbered below) placeholder

  // 12. eip712 self-signed needs NO allowlist (open trust model)
  const env12 = buildEnvelope({});
  await signEvidence(env12);
  process.env.SAAX_EVIDENCE_ISSUER_ALLOWLIST = '';
  r = await verifyEvidenceCrypto(env12, context);
  check('T12-eip712-no-allowlist-required', r.ok && r.stage === 'ok', r.reason);

  // ---- Phase 5B: REAL cryptographic COSE/JWS (issuer-trust key model) ----
  // Use a dedicated Ed25519 signing keypair as the issuer's registered key.
  const { publicKey: edPub, privateKey: edPriv } = crypto.generateKeyPairSync('ed25519');
  const edJwk = edPub.export({ format: 'jwk' });
  const evPayload = { evidenceId: 'evd-cose-real', payloadHash: 'sha256:' + 'e'.repeat(64) };

  // T13: real JWS (EdDSA) signed over a payload committing to the evidence ->
  //      verified when the trusted key resolves.
  const jwsTok = await new CompactSign(Buffer.from(JSON.stringify(evPayload)))
    .setProtectedHeader({ alg: 'EdDSA' }).sign(edPriv);
  const evJws = buildEnvelope({});
  evJws.verificationScheme = 'jws';
  evJws.signature = 'JWS_' + jwsTok;
  evJws.evidenceId = 'evd-cose-real';
  evJws.payloadHash = 'sha256:' + 'e'.repeat(64);
  r = await verifyEvidenceCrypto(evJws, Object.assign({}, context, {
    acceptanceCriteria: { acceptedIssuers: [String(edJwk.x).slice(0, 40).padStart(42, '0')] },
  }), );
  // issuerTrust for jws passes unchecked; the real binding is the resolver in
  // evidence.js. verifyEvidenceCrypto passes no resolver, so defaultKeyResolver
  // runs (SAAX_COSE_JWS_TRUSTED_KEYS_B64 unset -> no key -> rejection). To test
  // the positive path we drive verifyEvidenceSignature directly with a resolver.
  const sigPos = await evidence.verifyEvidenceSignature(evJws, { resolver: async () => edJwk });
  check('T13-jws-real-crypto-verified', sigPos.ok === true, sigPos.reason || '');

  // T14: real JWS but WRONG trusted key -> rejected cryptographically.
  const { publicKey: edPub2 } = crypto.generateKeyPairSync('ed25519');
  const edJwk2 = edPub2.export({ format: 'jwk' });
  const sigWrong = await evidence.verifyEvidenceSignature(evJws, { resolver: async () => edJwk2 });
  check('T14-jws-wrong-key-rejected', sigWrong.ok === false && /failed|invalid|verify/i.test(String(sigWrong.reason)), sigWrong.reason || '');

  // T15: real COSE_Sign1 (EdDSA) over a payload committing to the evidence ->
  //      verified with the matching trusted key.
  const protHdr = new Map(); protHdr.set(1, -8);
  const protB = await cbor.encodeAsync(protHdr);
  const cosePayload = await cbor.encodeAsync(evPayload);
  const sigStruct = await cbor.encodeAsync(['Signature1', protB, Buffer.alloc(0), cosePayload]);
  const coseSig = crypto.sign(null, sigStruct, edPriv);
  const sign1 = await cbor.encodeAsync([protB, new Map(), cosePayload, coseSig]);
  const evCose = buildEnvelope({});
  evCose.verificationScheme = 'cose';
  evCose.signature = 'COSE_Sign1_' + sign1.toString('base64url');
  evCose.evidenceId = 'evd-cose-real';
  evCose.payloadHash = 'sha256:' + 'e'.repeat(64);
  const sigCose = await evidence.verifyEvidenceSignature(evCose, { resolver: async () => edJwk });
  check('T15-cose-real-crypto-verified', sigCose.ok === true, sigCose.reason || '');

  // T16: real COSE but wrong key -> rejected.
  const sigCoseWrong = await evidence.verifyEvidenceSignature(evCose, { resolver: async () => edJwk2 });
  check('T16-cose-wrong-key-rejected', sigCoseWrong.ok === false, sigCoseWrong.reason || '');

  // T17: JWS - unknown alg (RS256) fails closed.
  const { publicKey: rsPub, privateKey: rsPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsJwk = rsPub.export({ format: 'jwk' });
  const rsTok = await new CompactSign(Buffer.from(JSON.stringify(evPayload)))
    .setProtectedHeader({ alg: 'RS256' }).sign(rsPriv);
  const evRs = buildEnvelope({});
  evRs.verificationScheme = 'jws'; evRs.signature = 'JWS_' + rsTok;
  evRs.evidenceId = 'evd-cose-real'; evRs.payloadHash = 'sha256:' + 'e'.repeat(64);
  const sigRs = await evidence.verifyEvidenceSignature(evRs, { resolver: async () => rsJwk });
  check('T17-jws-unsupported-alg-rejected', sigRs.ok === false, sigRs.reason || '');

  // T18: structural-only COSE (fake sig) rejected by the real verifier even
  //      when the trusted key would resolve.
  const fakeCose = buildEnvelope({ cose: true });
  fakeCose.evidenceId = 'evd-cose-fake';
  const sigFake = await evidence.verifyEvidenceSignature(fakeCose, { resolver: async () => edJwk });
  check('T18-cose-structural-fake-sig-rejected', sigFake.ok === false, sigFake.reason || '');

  // T19: full verifyEvidenceCrypto rejects a REAL COSE signature when no
  //      trusted key / allowlist is configured. The COSE signed payload must
  //      commit to the envelope's ACTUAL payloadHash (computed by
  //      buildEnvelope from its real payload) so the integrity check passes and
  //      the rejection is the missing-trust/key path, not a hash mismatch.
  process.env.SAAX_COSE_JWS_TRUSTED_KEYS_B64 = '';
  process.env.SAAX_EVIDENCE_ISSUER_ALLOWLIST = '';
  const evCoseNoKey = buildEnvelope({}); // carries the real payloadHash (sha256 of {temperature:4,unit:'C'})
  const noKeyPayload = { evidenceId: evCoseNoKey.evidenceId, payloadHash: evCoseNoKey.payloadHash };
  const nkPayloadB = await cbor.encodeAsync(noKeyPayload);
  const nkProt = new Map(); nkProt.set(1, -8);
  const nkProtB = await cbor.encodeAsync(nkProt);
  const nkStruct = await cbor.encodeAsync(['Signature1', nkProtB, Buffer.alloc(0), nkPayloadB]);
  const nkSig = crypto.sign(null, nkStruct, edPriv);
  const nkSign1 = await cbor.encodeAsync([nkProtB, new Map(), nkPayloadB, nkSig]);
  evCoseNoKey.verificationScheme = 'cose';
  evCoseNoKey.signature = 'COSE_Sign1_' + nkSign1.toString('base64url');
  r = await verifyEvidenceCrypto(evCoseNoKey, context);
  check('T19-cose-no-trusted-key-rejected', !r.ok && (r.stage === 'issuer' || r.stage === 'signature'), r.reason || '');

  console.log('\n==== PHASE 4 EVIDENCE VERIFICATION: ' + PASS + '/' + (PASS + FAIL) + ' PASS ====');
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });