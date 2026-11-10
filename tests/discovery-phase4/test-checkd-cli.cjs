// Produce a COHERENT discovery export (one flow: proposal -> acceptance -> commitment)
// and verify it through the standalone CLI in a SEPARATE process (Release Check D).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { generateKeyPair } = require('jose');
const cryptoLib = require('../../endpoint/discovery-crypto');

function jcs(obj) { return cryptoLib.jcs(obj); }

async function main() {
  const kp = await generateKeyPair('Ed25519', { extractable: true });
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const buyerKp = await generateKeyPair('Ed25519', { extractable: true });
  const buyerPriv = await crypto.subtle.exportKey('jwk', buyerKp.privateKey);
  const buyerPub = await crypto.subtle.exportKey('jwk', buyerKp.publicKey);

  // ---- signed proposal (provider key) ----
  const proposal = {
    profileVersion: '1.0.0',
    proposalId: 'prop_livecheck_' + crypto.randomBytes(6).toString('hex'),
    nonce: 'n_' + crypto.randomBytes(6).toString('hex'),
    requestDigest: 'sha256:' + crypto.createHash('sha256').update('check-d-request').digest('hex'),
    provider: { providerId: 'https://saax-protocol.com/', name: 'SAAX Operator', signingKeyId: 'live-2026-11', origin: 'https://saax-protocol.com' },
    audience: { buyer: '0x1111111111111111111111111111111111111111', intendedAudience: '0x1111111111111111111111111111111111111111' },
    manifest: {
      commitmentManifestVersion: '1',
      commitmentManifestDigest: 'sha256:' + crypto.createHash('sha256').update('manifest-schema-v1').digest('hex'),
      schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:' + crypto.createHash('sha256').update('manifest-schema-v1').digest('hex') },
    },
    terms: {
      network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      rail: 'x402', mode: 'x402', amount: '1000000', unit: 'micro-units of settlement asset', currency: 'USDC',
      deadline: '2026-11-06T00:00:00Z', policies: { refundOnFailure: true, compensationPercent: '5' },
    },
    issuedAt: '2026-11-05T11:59:00Z', expires: '2026-11-05T13:00:00Z', status: 'proposed',
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
  };
  const pSign = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(proposal)), privateJwk: priv, keyId: 'live-2026-11' });
  const signedProposal = { ...proposal, signature: { scheme: 'jws', alg: 'EdDSA', keyId: 'live-2026-11', jws: pSign.jws, canonicalization: 'rfc8785' } };

  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(jcs(signedProposal.terms), 'utf8').digest('hex');
  const proposalDigest = 'sha256:' + crypto.createHash('sha256').update(jcs(proposal), 'utf8').digest('hex');

  // ---- buyer acceptance (buyer key) ----
  const accDoc = {
    schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_livecheck_' + crypto.randomBytes(6).toString('hex'),
    nonce: 'accn_' + crypto.randomBytes(6).toString('hex'),
    buyer: '0x1111111111111111111111111111111111111111',
    provider: { providerId: proposal.provider.providerId, signingKeyId: 'live-2026-11' },
    proposal: { proposalId: signedProposal.proposalId, proposalDigest },
    termsDigest,
    audience: proposal.provider.origin,
    notBefore: '2026-11-05T11:58:00Z', notAfter: '2026-11-05T12:30:00Z',
    versions: { profileVersion: '1.0.0', manifestVersion: '1', schema: signedProposal.manifest.schema },
  };
  const aSign = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(accDoc)), privateJwk: buyerPriv, keyId: 'buyer-key-1' });
  const signedAcc = { ...accDoc, signature: { scheme: 'jws', alg: 'EdDSA', keyId: 'buyer-key-1', jws: aSign.jws, canonicalization: 'rfc8785' } };

  // ---- commitment manifest (v1) + SR wrapper (provider key) ----
  const manifest = {
    commitmentId: '0x' + crypto.randomBytes(32).toString('hex'),
    manifestHash: 'sha256:' + crypto.createHash('sha256').update('canonical-manifest-bytes').digest('hex'),
    manifestVersion: '1',
    buyerAgentId: signedAcc.buyer,
    sellerAgentId: signedProposal.provider.providerId,
    capability: 'security-scan',
    price: { amount: '1000000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash', value: 'sha256:' + crypto.createHash('sha256').update('work-product').digest('hex') },
    deadline: '2026-11-06T00:00:00Z',
    cancelCondition: 'buyer-cancel-before-delivery',
    signature: 'COSE_Sign1:0x' + '00'.repeat(65),
  };
  const srBase = {
    signedRepresentationVersion: 'manifest-v1.1+saax-proposal-bound',
    commitmentId: manifest.commitmentId, proposalId: signedProposal.proposalId, proposalDigest,
    manifestDigest: manifest.manifestHash,
    acceptanceCriteria: manifest.acceptanceCriteria, deadline: manifest.deadline,
    price: manifest.price, sellerAgentId: manifest.sellerAgentId, buyerAgentId: manifest.buyerAgentId,
    capability: manifest.capability,
    evaluator: { verificationSchemes: ['jws'], minimumVendorScore: 80 }, permittedDecisions: ['release', 'refund'],
    profileVersion: signedProposal.profileVersion, manifestVersion: '1',
    signedAt: '2026-11-05T12:00:00.000Z',
  };
  const srSign = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(srBase)), privateJwk: priv, keyId: 'live-2026-11' });
  const signedRepresentation = { ...srBase, version: 'manifest-v1.1+saax-proposal-bound', keyId: 'live-2026-11', jws: srSign.jws, manifestHash: manifest.manifestHash, signedAt: srBase.signedAt };

  const providerProfile = {
    providerId: proposal.provider.providerId,
    origins: [proposal.provider.origin],
    capabilities: [{ id: 'security-scan', evaluatorRequirements: { verificationSchemes: ['jws'], minimumVendorScore: 80 } }],
    interfaces: { discovery: { prepareCommitment: true, commitment: true } },
  };

  const exportObj = {
    formatVersion: 4,
    lifecycleProfile: 'issue',
    commitment: { commitmentId: manifest.commitmentId, manifestHash: manifest.manifestHash, manifest, signedRepresentation },
    proposal: { ...signedProposal, proposalDigest },
    acceptance: signedAcc,
    providerProfile,
    providerPublicJwk: pub,
    builtAt: new Date().toISOString(),
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-checkd-'));
  const p = path.join(dir, 'export.json');
  fs.writeFileSync(p, JSON.stringify(exportObj, null, 2));

  // Separate-process CLI verification (no app DB access).
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'verifier', 'verify-export.js'), p], { encoding: 'utf8', env: { ...process.env, SAAX_VERIFIER_SELFTEST: '1' } });
  const out = (res.stdout || '') + (res.stderr || '');
  console.log('--- separate-process CLI output ---');
  console.log(out);
  console.log('--- exit=' + res.status + ' ---');
  const verified = res.status === 0 && /VERDICT: VERIFIED/.test(out);
  const srChecked = /discovery signed-representation/.test(out);
  const accChecked = /discovery buyer acceptance/.test(out);
  if (!verified || !srChecked || !accChecked) { console.error('CHECK D FAILED'); process.exit(1); }
  console.log('CHECK D PASS: CLI verified SR + acceptance in a separate process');

  // ---- Negative control: a tampered SR JWS must be rejected by the CLI ----
  const neg = JSON.parse(JSON.stringify(exportObj));
  const jws = neg.commitment.signedRepresentation.jws;
  const mid = Math.floor(jws.length / 2);
  const corrupted = jws.slice(0, mid) + (jws[mid] === 'A' ? 'B' : 'A') + jws.slice(mid + 1);
  neg.commitment.signedRepresentation = { ...neg.commitment.signedRepresentation, jws: corrupted };
  const negPath = path.join(dir, 'neg-export.json');
  fs.writeFileSync(negPath, JSON.stringify(neg, null, 2));
  const negRes = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'verifier', 'verify-export.js'), negPath], { encoding: 'utf8', env: { ...process.env } });
  const negOut = (negRes.stdout || '') + (negRes.stderr || '');
  if (negRes.status !== 1 || !/NOT VERIFIED/.test(negOut) || !/discovery signed-representation/.test(negOut)) {
    console.error('CHECK D NEGATIVE FAILED: status=' + negRes.status + ' out=' + negOut.split('\n').slice(0, 6).join(' | '));
    process.exit(1);
  }
  console.log('CHECK D NEGATIVE PASS: tampered SR JWS rejected by CLI (exit 1, NOT VERIFIED)');
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });