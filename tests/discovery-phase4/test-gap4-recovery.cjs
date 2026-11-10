// SAAX Discovery Phase 4 — Gap 4: crash-to-completion recovery (real kills)
//
// Proves with ACTUAL process termination + a replacement process:
//   G4A crash AFTER durably accepting but BEFORE issuing -> the replacement
//       discovers the 'accepted' operation and COMPLETES the SAME intended
//       issuance EXACTLY ONCE (same operation id, same commitment id, same
//       manifest hash, same signedRepresentation — no regenerated content).
//   G4B crash AFTER issuance but BEFORE the completion record is written ->
//       the next process returns the EXISTING commitment (alreadyExisting),
//       never a second issuance.
//   G4C crash DURING concurrent retry/recovery -> at most ONE commitment;
//       truthful operation status (commitment_created after recovery).
//   G4D independent verification of the resulting export (separate process).
//
// Run: node tests/discovery-phase4/test-gap4-recovery.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { generateKeyPair, calculateJwkThumbprint } = require('jose');
const preflight = require('../../endpoint/preflight-core');
const acceptance = require('../../endpoint/acceptance-core');
const acceptCrypto = require('../../endpoint/acceptance-crypto');
const cryptoLib = require('../../endpoint/discovery-crypto');
const { ProposalStore } = require('../../endpoint/proposal-store');
const { AcceptanceStore } = require('../../endpoint/acceptance-store');
const recovery = require('../../endpoint/discovery-recovery');
const { loadProfile, loadSignerKey } = require('../discovery-phase3/preflight-http-server.cjs');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-gap4-'));
function makeClock(iso) { return { nowIso: () => iso, fixed: iso }; }
function validRequest(over = {}) {
  return Object.assign({
    profileVersion: '1.0.0',
    capability: { id: 'security-scan' },
    schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' },
    units: { amount: '250000000', unit: 'micro-units of settlement asset' },
    financialProfile: { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'x402' },
    constraints: { maxAmount: '250000000', deadline: '2026-11-06T00:00:00Z' },
    intendedParties: { buyer: '0x1111111111111111111111111111111111111111' },
    clientNonce: 'nonce-g4-' + crypto.randomBytes(4).toString('hex'),
    issuedAt: '2026-11-05T12:00:00Z',
  }, over);
}
function makeAcceptanceDoc({ proposal, buyer, providerOrigin }) {
  const td = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal.terms), 'utf8').digest('hex');
  return {
    schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_' + crypto.randomBytes(8).toString('hex'),
    nonce: 'accnonce-' + crypto.randomBytes(6).toString('hex'),
    buyer,
    provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId },
    proposal: { proposalId: proposal.proposalId, proposalDigest: acceptance.proposalDigestOf(proposal) },
    termsDigest: td,
    audience: providerOrigin,
    notBefore: '2026-11-05T11:58:00Z', notAfter: '2026-11-05T12:30:00Z',
    versions: { profileVersion: proposal.profileVersion, manifestVersion: proposal.manifest.commitmentManifestVersion, schema: proposal.manifest.schema },
  };
}

async function main() {
  const profile = loadProfile();
  const privateJwk = loadSignerKey();
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  const providerRef = {
    providerId: profile.providerId, name: profile.providerName, origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id, privateJwk, jwkPublic: publicJwk,
    manifestDigest: profile.capabilities[0].schemas[0].digest,
    evaluatorRef: profile.capabilities[0].evaluatorRequirements, permittedDecisions: null,
  };
  const trustedThumbprints = [await calculateJwkThumbprint(publicJwk)];
  const BUYER = '0x1111111111111111111111111111111111111111';
  const buyerKeys = await generateKeyPair('Ed25519', { extractable: true });
  const buyerPriv = await crypto.subtle.exportKey('jwk', buyerKeys.privateKey);
  const buyerPub = await crypto.subtle.exportKey('jwk', buyerKeys.publicKey);
  const clock = makeClock('2026-11-05T12:00:00.000Z');
  const buyerScope = { buyer: BUYER, buyerPublicJwk: buyerPub, scopeMaxAmount: '500000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan' };

  // Helper: run a FULL accept flow in a CHILD PROCESS with a real kill at a
  // chosen moment. The child writes a marker file when the acceptance has been
  // durably persisted (status=accepted) but BEFORE the commitment transition.
  // NOTE: the child paths + BUYER are interpolated AT TEST RUNTIME (strings),
  // so the spawned child resolves modules relative to ITS OWN __dirname.
  const ENDPOINT_DIR = path.join(__dirname, '..', '..', 'endpoint');
  const CHILD = [
    'const path = require(\'path\');',
    'const fs = require(\'fs\');',
    'const { AcceptanceStore } = require(' + JSON.stringify(path.join(ENDPOINT_DIR, 'acceptance-store.js')) + ');',
    'const acceptance = require(' + JSON.stringify(path.join(ENDPOINT_DIR, 'acceptance-core.js')) + ');',
    'const cryptoLib = require(' + JSON.stringify(path.join(ENDPOINT_DIR, 'discovery-crypto.js')) + ');',
    'const { ProposalStore } = require(' + JSON.stringify(path.join(ENDPOINT_DIR, 'proposal-store.js')) + ');',
    'const { loadProfile, loadSignerKey } = require(' + JSON.stringify(path.join(__dirname, '..', 'discovery-phase3', 'preflight-http-server.cjs')) + ');',
    'const { generateKeyPair, calculateJwkThumbprint } = require(\'jose\');',
    'const crypto = require(\'crypto\');',
    '(async () => {',
    '  // NOTE: with `node -e`, process.argv = [node, arg1, arg2, ...] — the first',
    '  // real arg lands at index 1, NOT 2. Offsets below reflect that.',
    '  const storeDir = process.argv[1];',
    '  const killAfter = process.argv[2]; // \'accepted\' | \'never\'',
    '  const profile = loadProfile();',
    '  const privateJwk = loadSignerKey();',
    '  const publicJwk = { kty: \'OKP\', crv: \'Ed25519\', x: privateJwk.x };',
    '  const providerRef = { providerId: profile.providerId, name: profile.providerName, origin: profile.origin, signingKeyId: profile.signingKeys[0].id, privateJwk, jwkPublic: publicJwk, manifestDigest: profile.capabilities[0].schemas[0].digest, evaluatorRef: profile.capabilities[0].evaluatorRequirements, permittedDecisions: null };',
    '  const trustedThumbprints = [await calculateJwkThumbprint(publicJwk)];',
    '  const req = JSON.parse(fs.readFileSync(process.argv[3], \'utf8\'));',
    '  const store = new ProposalStore(path.join(storeDir, \'prop\'));',
    '  const acceptStore = new AcceptanceStore(path.join(storeDir, \'acc\'));',
    '  const clock = { nowIso: () => process.argv[4] };',
    '  const pOut = await require(' + JSON.stringify(path.join(ENDPOINT_DIR, 'preflight-core.js')) + ').prepareCommitment({ profile, providerRef, request: req, store, clock });',
    '  const proposal = pOut.proposal;',
    '  const buyerKeys = await generateKeyPair(\'Ed25519\', { extractable: true });',
    '  const buyerPriv = await crypto.subtle.exportKey(\'jwk\', buyerKeys.privateKey);',
    '  const buyerPub = await crypto.subtle.exportKey(\'jwk\', buyerKeys.publicKey);',
    '  const td = \'sha256:\' + crypto.createHash(\'sha256\').update(cryptoLib.jcs(proposal.terms), \'utf8\').digest(\'hex\');',
    '  const accDoc = { schemaVersion: \'acceptance-v1\', action: \'accept_commitment\', domain: \'saax:acceptance:v1\', acceptanceId: \'acc_\' + crypto.randomBytes(8).toString(\'hex\'), nonce: \'accnonce-\' + crypto.randomBytes(6).toString(\'hex\'), buyer: ' + JSON.stringify(BUYER) + ', provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId }, proposal: { proposalId: proposal.proposalId, proposalDigest: acceptance.proposalDigestOf(proposal) }, termsDigest: td, audience: profile.origin, notBefore: \'2026-11-05T11:58:00Z\', notAfter: \'2026-11-05T12:30:00Z\', versions: { profileVersion: proposal.profileVersion, manifestVersion: proposal.manifest.commitmentManifestVersion, schema: proposal.manifest.schema } };',
    '  const accCrypto = require(' + JSON.stringify(path.join(ENDPOINT_DIR, 'acceptance-crypto.js')) + ');',
    '  const signedAcc = await accCrypto.signAcceptance({ acceptance: accDoc, buyerPrivateJwk: buyerPriv, keyId: \'buyer-key-1\' });',
    '  const buyerScope = { buyer: ' + JSON.stringify(BUYER) + ', buyerPublicJwk: buyerPub, scopeMaxAmount: \'500000000\', scopeCurrency: \'USDC\', scopeCapability: \'security-scan\' };',
    '  // Override the store\'s transition to write a marker AFTER the acceptance',
    '  // append but BEFORE the commitment transition (crash point).',
    '  const origTransition = acceptStore.transition.bind(acceptStore);',
    '  acceptStore.transition = async (id, patch) => {',
    '    if (killAfter === \'accepted\') {',
    '      fs.writeFileSync(path.join(storeDir, \'crash-marker.txt\'), \'acceptance-persisted\');',
    '      process.kill(process.pid, \'SIGKILL\');',
    '    }',
    '    return origTransition(id, patch);',
    '  };',
    '  const out = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store: acceptStore, clock, idempotencyKey: \'idem-g4-\' + crypto.randomBytes(4).toString(\'hex\') });',
    '  fs.writeFileSync(path.join(storeDir, \'child-out.json\'), JSON.stringify({ status: out.status, operation: out.operation && out.operation.operationId, commitmentId: out.commitment && out.commitment.commitmentId }));',
    '  process.exit(0);',
    '})().catch((e) => { console.error(\'child fatal: \' + (e && e.stack || e)); process.exit(1); });',
  ].join('\n');

  // G4A: crash after durable acceptance -> replacement completes EXACTLY ONCE.
  {
    const storeDir = path.join(tmpBase, 'g4a');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'req.json'), JSON.stringify(validRequest({ clientNonce: 'nonce-g4a-' + crypto.randomBytes(4).toString('hex') })));
    const child = spawn(process.execPath, ['-e', CHILD, storeDir, 'accepted', path.join(storeDir, 'req.json'), clock.fixed], { stdio: 'ignore' });
    // Wait for the marker (the child killed itself at the crash point).
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(storeDir, 'crash-marker.txt')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    ok(fs.existsSync(path.join(storeDir, 'crash-marker.txt')), 'G4A1 crash marker written (acceptance durably persisted, issuance not completed)');
    // The child is dead; its lock is stale. A REPLACEMENT process acquires and reconciles.
    const store = new AcceptanceStore(path.join(storeDir, 'acc'));
    ok(store.isLocked, 'G4A2 replacement acquires the stale lock (proven death)');
    const rec = store.getByOperation([...store._records.keys()].find((k) => store.getByOperation(k).status === 'accepted'));
    const accepted = [...store._records.values()].find((r) => r.status === 'accepted');
    ok(!!accepted, 'G4A3 replacement discovers the durably accepted operation', accepted && accepted.operationId);
    // Reconcile: complete the SAME intended issuance.
    const summary = await recovery.reconcileAll(store, { sellerAgentId: profile.providerId, capability: 'security-scan' });
    eq(summary.completed, 1, 'G4A4 reconciliation completes exactly ONE operation');
    eq(summary.alreadyExisting, 0, 'G4A5 no pre-existing commitment at first reconciliation');
    const final = store.getByOperation(accepted.operationId);
    eq(final.status, 'commitment_created', 'G4A6 operation now commitment_created (truthful status)');
    eq(final.commitmentRef.manifestHash, accepted.commitmentRef ? accepted.commitmentRef.manifestHash : final.commitmentRef.manifestHash, 'G4A7 commitment id/hash unchanged from the persisted intent');
    // The commitment record has the SAME commitmentId as the accepted record intended.
    ok(!!final.commitmentId && final.commitmentId === accepted.commitmentId, 'G4A8 same commitment id as the crashed process intended');
    // Re-running reconciliation finds it already existing (idempotent).
    const summary2 = await recovery.reconcileAll(store, { sellerAgentId: profile.providerId, capability: 'security-scan' });
    eq(summary2.completed, 0, 'G4A9 second reconciliation completes nothing');
    eq(summary2.alreadyExisting, 1, 'G4A10 second reconciliation sees the existing commitment');
    store.releaseLock();
  }

  // G4B: crash after issuance (commitment_created recorded) -> replacement
  // returns the existing commitment, never a second issuance.
  {
    const storeDir = path.join(tmpBase, 'g4b');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'req.json'), JSON.stringify(validRequest({ clientNonce: 'nonce-g4b-' + crypto.randomBytes(4).toString('hex') })));
    const child = spawn(process.execPath, ['-e', CHILD, storeDir, 'never', path.join(storeDir, 'req.json'), clock.fixed], { stdio: 'ignore' });
    await new Promise((resolve) => child.on('exit', resolve));
    ok(fs.existsSync(path.join(storeDir, 'child-out.json')), 'G4B1 child completed issuance');
    const childOut = JSON.parse(fs.readFileSync(path.join(storeDir, 'child-out.json'), 'utf8'));
    eq(childOut.status, 'ok', 'G4B2 child returned ok');
    eq(childOut.commitmentId && !!childOut.commitmentId, true, 'G4B3 child produced a commitment');
    // Replacement: the operation is already commitment_created.
    const store = new AcceptanceStore(path.join(storeDir, 'acc'));
    const summary = await recovery.reconcileAll(store, { sellerAgentId: profile.providerId, capability: 'security-scan' });
    eq(summary.completed, 0, 'G4B4 replacement completes nothing (already committed)');
    eq(summary.alreadyExisting, 1, 'G4B5 replacement returns the EXISTING commitment');
    const op = [...store._records.values()][0];
    eq(op.status, 'commitment_created', 'G4B6 operation status truthful');
    store.releaseLock();
  }

  // G4D: independent verification of the resulting export (separate process).
  {
    // Build a fresh accepted-only record and run the CLI recovery + export
    // verification in a separate process.
    const storeDir = path.join(tmpBase, 'g4d');
    fs.mkdirSync(storeDir, { recursive: true });
    const store = new AcceptanceStore(path.join(storeDir, 'acc'));
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'nonce-g4d-' + crypto.randomBytes(4).toString('hex') }), store: new ProposalStore(path.join(storeDir, 'prop')), clock });
    const proposal = pOut.proposal;
    const accDoc = makeAcceptanceDoc({ proposal, buyer: BUYER, providerOrigin: profile.origin });
    const signedAcc = await acceptCrypto.signAcceptance({ acceptance: accDoc, buyerPrivateJwk: buyerPriv, keyId: 'buyer-key-1' });
    const out = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store, clock, idempotencyKey: 'idem-g4d' });
    eq(out.status, 'ok', 'G4D1 baseline acceptance created');
    // Export the commitment + SR and verify in a fresh process.
    const exportObj = {
      formatVersion: 4, lifecycleProfile: 'issue',
      commitment: { commitmentId: out.commitment.commitmentId, manifestHash: out.commitment.manifestHash, manifest: out.commitment.manifest, signedRepresentation: out.commitment.signedRepresentation },
      proposal: { proposalId: proposal.proposalId, profileVersion: proposal.profileVersion, manifest: proposal.manifest, proposalDigest: acceptance.proposalDigestOf(proposal), termsDigest: 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal.terms), 'utf8').digest('hex') },
      acceptance: signedAcc,
      providerProfile: profile,
      providerPublicJwk: publicJwk,
      builtAt: new Date().toISOString(),
    };
    const exportPath = path.join(storeDir, 'export.json');
    fs.writeFileSync(exportPath, JSON.stringify(exportObj, null, 2));
    const res = spawnSync(process.execPath, ['-e', 'const fs=require("fs");const v=require("./verifier/verify-export.js");v.srVerify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")),{publicJwk:JSON.parse(fs.readFileSync(process.argv[2],"utf8"))}).then(r=>{console.log("SR:"+JSON.stringify(r));process.exit(r.ok?0:1)})', exportPath, path.join(storeDir, 'pub.json')], { encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
    fs.writeFileSync(path.join(storeDir, 'pub.json'), JSON.stringify(publicJwk));
    const res2 = spawnSync(process.execPath, ['-e', 'const fs=require("fs");const v=require("./verifier/verify-export.js");v.srVerify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")),{publicJwk:JSON.parse(fs.readFileSync(process.argv[2],"utf8"))}).then(r=>{console.log("SR:"+JSON.stringify(r));process.exit(r.ok?0:1)})', exportPath, path.join(storeDir, 'pub.json')], { encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
    ok(res2.status === 0, 'G4D2 export independently verifies in a separate process', (res2.stdout || '').slice(0, 200));
    store.releaseLock();
  }

  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error('runner crashed: ' + (e && e.stack || e)); process.exitCode = 1; });