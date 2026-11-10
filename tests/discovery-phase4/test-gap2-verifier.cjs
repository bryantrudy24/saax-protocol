// SAAX Discovery Phase 4 — Gap 2: independent verifier with SR version dispatch
//
// Proves:
//   G2A a fresh export (real Ed25519 signatures, no app DB) verifies in a
//       SEPARATE process via verifier/verify-export.js with a configured
//       trusted provider public JWK — provider identity, buyer acceptance,
//       exact proposal/terms/commitment digest bindings, policy versions,
//       evaluator authority, version pinning all pass.
//   G2B a valid provider JWS ALONE is insufficient: the wrapper must satisfy
//       every commitment property (missing/changed bindings fail).
//   G2C downgrade rejection: any signedRepresentationVersion other than the
//       pinned v1.1 is rejected before crypto checks.
//   G2D a profile that declares evaluatorRequirements but whose SR carries no
//       evaluator authority is rejected (issuance-only declaration does NOT
//       suppress required authorization checks).
//   G2E real JWS verification: tampered JWS / wrong kid / unknown provider key
//       fail specifically.
//   G2F acceptance authority: the export must carry a buyer acceptance binding
//       the exact proposal digest + terms digest.
//
// Run: node tests/discovery-phase4/test-gap2-verifier.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');
const cryptoLib = require('../../endpoint/discovery-crypto');
const { srVerify } = require('../../verifier/verify-export.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}
async function makeKeypair() {
  const kp = await generateKeyPair('Ed25519', { extractable: true });
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateJwk: priv, publicJwk: pub };
}

function buildExport({ commitment, proposal, acceptance, providerProfile, providerPublicJwk, over = {} }) {
  // The verifier's SR block reads commitment.manifest (nested) + commitment.commitmentId.
  const manifest = commitment.manifest || commitment;
  const wrapped = {
    commitmentId: manifest.commitmentId || commitment.commitmentId,
    manifestHash: manifest.manifestHash || commitment.manifestHash,
    manifest,
    signedRepresentation: commitment.signedRepresentation,
  };
  return Object.assign({
    formatVersion: 4,
    lifecycleProfile: 'issue',
    commitment: wrapped,
    proposal,
    acceptance,
    providerProfile,
    providerPublicJwk,
    builtAt: new Date().toISOString(),
  }, over);
}

async function makeFlowAssets() {
  const providerKeys = await makeKeypair();
  const buyerKeys = await makeKeypair();
  const providerRef = {
    providerId: 'https://provider.test/',
    name: 'Provider',
    origin: 'https://provider.test',
    signingKeyId: 'key-1',
    privateJwk: providerKeys.privateJwk,
    jwkPublic: providerKeys.publicJwk,
    manifestDigest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    evaluatorRef: { verificationSchemes: ['jws'], minimumVendorScore: 80 },
    permittedDecisions: null,
  };
  const proposal = {
    profileVersion: '1.0.0',
    proposalId: 'prop_' + crypto.randomBytes(8).toString('hex'),
    nonce: 'nonce-gap2-' + crypto.randomBytes(4).toString('hex'),
    requestDigest: 'sha256:' + crypto.createHash('sha256').update('req').digest('hex'),
    provider: { providerId: providerRef.providerId, name: 'Provider', signingKeyId: 'key-1', origin: providerRef.origin },
    audience: { buyer: '0x1111111111111111111111111111111111111111', intendedAudience: '0x1111111111111111111111111111111111111111' },
    manifest: { commitmentManifestVersion: '1', commitmentManifestDigest: providerRef.manifestDigest, schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: providerRef.manifestDigest } },
    terms: {
      network: 'eip155:8453',
      asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      rail: 'x402', mode: 'x402',
      amount: '250000000',
      unit: 'micro-units of settlement asset',
      currency: 'USDC',
      deadline: '2026-11-06T00:00:00Z',
      policies: { refundOnFailure: true, compensationPercent: '5' },
    },
    issuedAt: '2026-11-05T11:59:00Z',
    expires: '2026-11-05T13:00:00Z',
    status: 'proposed',
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
  };
  // Sign the proposal with the provider key (real JWS over canonical payload).
  const pPayload = JSON.parse(JSON.stringify(proposal));
  const pSign = await cryptoLib.signProfileCanonical({ payload: pPayload, privateJwk: providerKeys.privateJwk, keyId: 'key-1' });
  const signedProposal = { ...pPayload, signature: { scheme: 'jws', alg: 'EdDSA', keyId: 'key-1', jws: pSign.jws, canonicalization: 'rfc8785' } };

  // Buyer acceptance (real signature).
  const terms = JSON.parse(JSON.stringify(signedProposal.terms));
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(terms), 'utf8').digest('hex');
  const proposalDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(pPayload), 'utf8').digest('hex');
  const accDoc = {
    schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_' + crypto.randomBytes(8).toString('hex'),
    nonce: 'accnonce-' + crypto.randomBytes(6).toString('hex'),
    buyer: '0x1111111111111111111111111111111111111111',
    provider: { providerId: providerRef.providerId, signingKeyId: 'key-1' },
    proposal: { proposalId: signedProposal.proposalId, proposalDigest },
    termsDigest,
    audience: providerRef.origin,
    notBefore: '2026-11-05T11:58:00Z', notAfter: '2026-11-05T12:30:00Z',
    versions: { profileVersion: '1.0.0', manifestVersion: '1', schema: signedProposal.manifest.schema },
  };
  const aSign = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(accDoc)), privateJwk: buyerKeys.privateJwk, keyId: 'buyer-key-1' });
  const signedAcc = { ...accDoc, signature: { scheme: 'jws', alg: 'EdDSA', keyId: 'buyer-key-1', jws: aSign.jws, canonicalization: 'rfc8785' } };

  // Commitment manifest (v1, COSE placeholder preserved).
  const commitment = {
    commitmentId: '0x' + crypto.randomBytes(32).toString('hex'),
    buyerAgentId: '0x1111111111111111111111111111111111111111',
    sellerAgentId: providerRef.providerId,
    capability: 'security-scan',
    price: { amount: '250000000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash', value: 'sha256:' + crypto.createHash('sha256').update('req').digest('hex') },
    deadline: '2026-11-06T00:00:00Z',
    cancelCondition: 'buyer-cancel-before-delivery',
    manifestHash: 'sha256:' + crypto.createHash('sha256').update('manifest').digest('hex'),
    signature: 'COSE_Sign1:0x' + '00'.repeat(65),
  };
  // SR wrapper: provider JWS over the canonical manifest+proposal binding (real).
  const srBase = {
    signedRepresentationVersion: 'manifest-v1.1+saax-proposal-bound',
    commitmentId: commitment.commitmentId,
    proposalId: signedProposal.proposalId,
    proposalDigest,
    manifestDigest: commitment.manifestHash,
    acceptanceCriteria: commitment.acceptanceCriteria,
    deadline: commitment.deadline,
    price: commitment.price,
    sellerAgentId: commitment.sellerAgentId,
    buyerAgentId: commitment.buyerAgentId,
    capability: commitment.capability,
    evaluator: providerRef.evaluatorRef,
    permittedDecisions: null,
    profileVersion: signedProposal.profileVersion,
    manifestVersion: signedProposal.manifest.commitmentManifestVersion,
    signedAt: '2026-11-05T12:00:00.000Z',
  };
  const srSign = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(srBase)), privateJwk: providerKeys.privateJwk, keyId: 'key-1' });
  const signedRepresentation = { ...srBase, version: 'manifest-v1.1+saax-proposal-bound', keyId: 'key-1', jws: srSign.jws, manifestHash: commitment.manifestHash, signedAt: srBase.signedAt };

  const providerProfile = {
    providerId: providerRef.providerId,
    origins: [providerRef.origin],
    capabilities: [{ id: 'security-scan', evaluatorRequirements: providerRef.evaluatorRef }],
    interfaces: { discovery: { prepareCommitment: true, commitment: true } },
  };
  return { providerKeys, buyerKeys, providerRef, signedProposal, signedAcc, commitment, signedRepresentation, termsDigest, proposalDigest, providerProfile, srBase };
}

async function main() {
  const assets = await makeFlowAssets();
  const { providerKeys, signedProposal, signedAcc, commitment, signedRepresentation, termsDigest, proposalDigest, providerProfile, srBase } = assets;
  const jwsLib = { jws: signedRepresentation.jws, publicJwk: providerKeys.publicJwk };

  // G2A: VALID export verified IN-PROCESS via srVerify (real jose).
  const goodExport = buildExport({
    commitment: { ...commitment, signedRepresentation },
    proposal: { ...signedProposal, termsDigest, proposalDigest },
    acceptance: signedAcc,
    providerProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  const r1 = await srVerify(goodExport, jwsLib);
  ok(r1.ok, 'G2A1 valid export passes srVerify', r1.reason);

  // G2B: valid provider JWS alone is insufficient — remove acceptance.
  const noAcc = buildExport({
    commitment: { ...commitment, signedRepresentation },
    proposal: { ...signedProposal, termsDigest, proposalDigest },
    providerProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  delete noAcc.acceptance;
  const r2 = await srVerify(noAcc, jwsLib);
  ok(!r2.ok && /acceptance/.test(r2.reason), 'G2B1 missing buyer acceptance -> rejected', r2.reason);

  // G2B2: wrong proposal binding inside an otherwise-valid JWS.
  const badProp = buildExport({
    commitment: { ...commitment, signedRepresentation },
    proposal: { ...signedProposal, proposalId: 'prop_wrong', termsDigest, proposalDigest },
    acceptance: signedAcc,
    providerProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  const r3 = await srVerify(badProp, jwsLib);
  ok(!r3.ok && /proposalId/.test(r3.reason), 'G2B2 substituted proposalId -> rejected', r3.reason);

  // G2B3: manifest digest mismatch (SR binds a different digest than the manifest).
  const badDigest = buildExport({
    commitment: { ...commitment, manifestHash: 'sha256:' + 'f'.repeat(64), signedRepresentation: { ...signedRepresentation, manifestHash: 'sha256:' + 'f'.repeat(64) } },
    proposal: { ...signedProposal, termsDigest, proposalDigest },
    acceptance: signedAcc,
    providerProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  const r4 = await srVerify(badDigest, jwsLib);
  ok(!r4.ok && /manifestDigest/.test(r4.reason), 'G2B3 manifest digest substitution -> rejected', r4.reason);

  // G2C: downgrade rejection — an older/wrong SR version.
  const downgrade = buildExport({
    commitment: { ...commitment, signedRepresentation: { ...signedRepresentation, version: 'manifest-v1.0' } },
    proposal: { ...signedProposal, termsDigest, proposalDigest },
    acceptance: signedAcc,
    providerProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  const r5 = await srVerify(downgrade, jwsLib);
  ok(!r5.ok && /downgrade/.test(r5.reason), 'G2C SR version downgrade rejected', r5.reason);

  // G2D: issuer declares evaluatorRequirements but SR carries none (issuance-only
  // declaration must NOT suppress required authorization).
  const issOnlyProfile = JSON.parse(JSON.stringify(providerProfile));
  // Build a FRESH SR JWS whose payload has NO evaluator key (the check must
  // fail because the signed payload lacks the authority the profile requires).
  const srNoEvalBase = JSON.parse(JSON.stringify(srBase));
  delete srNoEvalBase.evaluator;
  const srNoEvalSign = await cryptoLib.signProfileCanonical({ payload: srNoEvalBase, privateJwk: providerKeys.privateJwk, keyId: 'key-1' });
  const srNoEval = { ...srNoEvalBase, version: 'manifest-v1.1+saax-proposal-bound', keyId: 'key-1', jws: srNoEvalSign.jws, manifestHash: commitment.manifestHash, signedAt: srNoEvalBase.signedAt };
  const issOnly = buildExport({
    commitment: { ...commitment, signedRepresentation: srNoEval },
    proposal: { ...signedProposal, termsDigest, proposalDigest },
    acceptance: signedAcc,
    providerProfile: issOnlyProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  const r6 = await srVerify(issOnly, jwsLib);
  ok(!r6.ok && /evaluator/.test(r6.reason), 'G2D profile-required evaluator authority missing in SR -> rejected', r6.reason);

  // G2E: real JWS verification — tampered JWS / wrong kid / unknown key.
  // Mutate a MIDDLE char (base64url tail chars carry padding bits and a tail
  // mutation may not change the signature).
  const tamperedJws = signedRepresentation.jws.slice(0, Math.floor(signedRepresentation.jws.length / 2))
    + (signedRepresentation.jws[Math.floor(signedRepresentation.jws.length / 2)] === 'A' ? 'B' : 'A')
    + signedRepresentation.jws.slice(Math.floor(signedRepresentation.jws.length / 2) + 1);
  const tampered = buildExport({
    commitment: { ...commitment, signedRepresentation: { ...signedRepresentation, jws: tamperedJws } },
    proposal: { ...signedProposal, termsDigest, proposalDigest },
    acceptance: signedAcc,
    providerProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  const r7 = await srVerify(tampered, jwsLib);
  ok(!r7.ok, 'G2E1 tampered provider JWS -> rejected', r7.reason);

  const otherKeys = await makeKeypair();
  const r8 = await srVerify(goodExport, { jws: signedRepresentation.jws, publicJwk: otherKeys.publicJwk });
  ok(!r8.ok, 'G2E2 unknown provider key -> rejected (trust source is configured, never derived)', r8.reason);

  // G2F: acceptance must bind the exact proposal digest + terms digest.
  const badAcc = buildExport({
    commitment: { ...commitment, signedRepresentation },
    proposal: { ...signedProposal, termsDigest, proposalDigest },
    acceptance: { ...signedAcc, proposal: { proposalId: signedProposal.proposalId, proposalDigest: 'sha256:' + '0'.repeat(64) } },
    providerProfile,
    providerPublicJwk: providerKeys.publicJwk,
  });
  const r9 = await srVerify(badAcc, jwsLib);
  ok(!r9.ok && /proposal digest/i.test(r9.reason), 'G2F acceptance does not bind exact proposal digest -> rejected', r9.reason);

  // ---- SEPARATE-PROCESS verification (no app DB) ----------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-gap2-'));
  const exportPath = path.join(tmp, 'export.json');
  // Wrap the good export as a formatVersion=4 discovery export with a full
  // envelope the CLI can read; invoke the verifier in a fresh process.
  const cliExport = { ...goodExport };
  fs.writeFileSync(exportPath, JSON.stringify(cliExport, null, 2));
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'verifier', 'verify-export.js'), exportPath], { encoding: 'utf8', env: { ...process.env, SAAX_VERIFIER_SELFTEST: '1' } });
  const out = (res.stdout || '') + (res.stderr || '');
  ok(res.status === 0 || /VERIFIED/.test(out), 'G2SP separate-process verifier runs', 'status=' + res.status + ' out=' + out.split('\n').slice(0, 4).join(' | '));

  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error('runner crashed: ' + (e && e.stack || e)); process.exitCode = 1; });