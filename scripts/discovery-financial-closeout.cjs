#!/usr/bin/env node
'use strict';
// Bounded Base Sepolia closeout producer. Default is read-only/local prepare.
// --execute is explicit; each transaction is signed, journaled BEFORE broadcast,
// then reconciled by hash. Re-running never regenerates or duplicates a flow.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ethers } = require('ethers');
const dotenv = require('dotenv');
const preflight = require('../endpoint/preflight-core');
const acceptanceCore = require('../endpoint/acceptance-core');
const acceptCrypto = require('../endpoint/acceptance-crypto');
const discCrypto = require('../endpoint/discovery-crypto');
const handoff = require('../endpoint/financial-handoff');
const { ProposalStore } = require('../endpoint/proposal-store');
const { AcceptanceStore } = require('../endpoint/acceptance-store');
const { EVIDENCE_TYPES, VERDICT_TYPES, jcs, sha } = require('../verifier/financial-evidence');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence', 'discovery-phase6');
const RPC = 'https://sepolia.base.org';
const PIN = '0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473';
const CUSTODY = handoff.CUSTODY, TOKEN = handoff.USDC, NETWORK = handoff.NETWORK;
const ASSET = NETWORK + '/erc20:' + TOKEN;
const ABI = require('../data/escrow-custody-build.json').abi;
const ERC20 = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function decimals() view returns(uint8)'];
const EVALUATION_TYPES = { FinancialEvaluation: [
  { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'evidenceDigest', type: 'bytes32' }, { name: 'verdictDigest', type: 'bytes32' },
] };
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const iso = () => new Date().toISOString();
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp'; const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
async function signed(payload, privateJwk, keyId) {
  const result = await discCrypto.signProfileCanonical({ payload, privateJwk, keyId });
  return { ...payload, signature: { scheme: 'jws', alg: 'EdDSA', keyId, jws: result.jws, canonicalization: 'rfc8785' } };
}
async function readIdentity(provider) {
  assert(Number((await provider.getNetwork()).chainId) === 84532, 'RPC must be actual Base Sepolia84532');
  const code = await provider.getCode(CUSTODY);
  assert(ethers.keccak256(code) === PIN, 'custody code pin differs; no financial submit');
  const identityFile = path.join(OUT, 'custody-identity.json');
  assert(fs.existsSync(identityFile), 'run exact custody identity checker and preserve report before preparing');
  const identity = json(identityFile);
  assert(identity.comparisons.onchain_vs_artifact.full && identity.comparisons.artifact_vs_recompiled_default.full &&
    identity.comparisons.deploymentInputEqualsArtifactCreation, 'reproducible source/artifact/deployment identity gate not established');
  assert(Number(await new ethers.Contract(TOKEN, ERC20, provider).decimals()) === 6, 'test USDC decimals must be six');
}
async function prepare(kind, roles, keys, provider) {
  const file = path.join(OUT, 'closeout-' + kind + '-export.json');
  if (fs.existsSync(file)) return json(file);
  const { calculateJwkThumbprint } = await import('jose');
  const providerKeyId = 'live-2026-11', buyerKeyId = 'real-buyer-2026-11';
  const ppub = json(path.join(keys, 'operator-public.jwk.json'));
  const bpub = json(path.join(keys, 'buyer-public.jwk.json'));
  const ppriv = json(path.join(keys, 'operator-private.jwk.json'));
  const bpriv = json(path.join(keys, 'buyer-private.jwk.json'));
  assert(ppriv.x === ppub.x && bpriv.x === bpub.x, 'private/public JWK identity mismatch');
  const liveProfile = json(path.join(ROOT, 'spec/examples/discovery/profile-live-signed.json'));
  assert(ppub.x === liveProfile.signingKeys[0].jwk.x, 'operator key differs from preserved production identity');
  const schemaBytes = execFileSync('git', ['show', '8e763985:spec/commitment-schema.md'], { cwd: ROOT });
  const schemaDigest = 'sha256:' + crypto.createHash('sha256').update(schemaBytes).digest('hex');
  const schema = { id: 'urn:saax:commitment-manifest:v1', version: '1', digest: schemaDigest };
  const profile = { profileVersion: '1.0.0', providerId: 'https://saax-protocol.com/',
    providerName: 'SAAX Protocol — isolated Base Sepolia deterministic self-test', origin: 'https://saax-protocol.com',
    signingKeys: [{ id: providerKeyId, type: 'jwk', jwk: ppub, controller: 'https://saax-protocol.com',
      validFrom: '2026-11-06T00:00:00.000Z', validUntil: '2027-11-06T00:00:00.000Z', status: 'active' }],
    capabilities: [{ id: 'sha256-financial-self-test', name: 'Deterministic SHA-256 self-test',
      description: 'Operator-controlled local SHA-256 computation with real testnet custody. Not a security scan or external customer service.',
      schemas: [{ ...schema, purpose: 'commitment-manifest' }], input: { units: { amount: '1000', unit: 'micro-units of settlement asset' },
        constraints: { maxAmount: '1000', minDuration: 0, maxDuration: 86400 } },
      evidencePolicy: { requiredEvidenceTypes: [kind === 'release' ? 'sha256-self-test-result' : 'sha256-self-test-nonfulfillment'],
        minimumCountPerType: 1, maxEvidenceAgeSeconds: 3600, acceptedIssuers: [roles.seller] },
      evaluatorRequirements: { verificationSchemes: ['eip712'] }, maturity: 'beta',
      networkAvailability: { networks: [NETWORK], testnetOnly: true } }],
    financialCompatibility: { networks: [NETWORK], assets: [ASSET], rails: ['x402'], paymentModes: ['escrow'],
      settlementModes: ['escrow'], defaultUnit: 'micro-units of settlement asset', supportedCombinations: [{ network: NETWORK,
        asset: ASSET, rail: 'x402', mode: 'escrow', settlementCurrency: 'USDC', settlementDecimals: 6,
        financialTerms: 'financial', maturity: 'beta' }] },
    interfaces: { discovery: { profile: true, prepareCommitment: true, commitment: true } },
    conformance: { claims: [{ standard: 'SAAX Discovery Profile', version: '1.0.0', mode: 'self-declared' }], demonstrated: [] },
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
    endpoints: { discovery: 'urn:saax:isolated:base-sepolia:profile', prepareCommitment: 'urn:saax:isolated:prepare',
      acceptCommitment: 'urn:saax:isolated:accept', allowCrossOrigin: [], schemaAllowlist: [] },
    cacheControl: { maxAgeSeconds: 3600, staleWhileRevalidate: false }, expires: '2027-11-06T00:00:00.000Z' };
  const providerProfile = await signed(profile, ppriv, providerKeyId);
  const inputUtf8 = 'SAAX Discovery financial closeout ' + kind + ' ' + crypto.randomBytes(8).toString('hex');
  const fa = { schemaVersion: 'saax-financial-agreement-v1', chainId: 84532, network: NETWORK, asset: ASSET,
    custody: { address: CUSTODY, runtimeKeccak: PIN }, token: { address: TOKEN, symbol: 'USDC', decimals: 6 },
    buyer: roles.buyer, seller: roles.seller, evaluator: { address: roles.evaluator, permittedDecisions: ['release', 'refund'] },
    minReleaseTime: '0', recovery: { signedRefund: true, timeoutRefund: true, refundBeneficiary: 'buyer' },
    fulfillment: { algorithm: 'sha256', encoding: 'utf8', inputUtf8, expectedSha256: sha(inputUtf8) } };
  const providerRef = { providerId: profile.providerId, name: profile.providerName, origin: profile.origin,
    signingKeyId: providerKeyId, privateJwk: ppriv, jwkPublic: ppub, manifestDigest: schemaDigest,
    evaluatorRef: fa.evaluator, permittedDecisions: fa.evaluator.permittedDecisions, financialAgreement: fa };
  const request = { profileVersion: '1.0.0', capability: { id: 'sha256-financial-self-test' }, schema,
    units: { amount: '1000', unit: 'micro-units of settlement asset' },
    financialProfile: { network: NETWORK, asset: ASSET, rail: 'x402', mode: 'escrow' },
    constraints: { deadline: new Date(Date.now() + 6 * 3600_000).toISOString() },
    intendedParties: { buyer: roles.buyer, seller: roles.seller },
    clientNonce: 'closeout-' + kind + '-' + crypto.randomBytes(8).toString('hex'), issuedAt: iso() };
  const props = new ProposalStore(path.join(ROOT, '.output', 'closeout-' + kind + '-proposals'));
  const p = await preflight.prepareCommitment({ profile: providerProfile, providerRef, request, store: props });
  assert(p.status === 'ok', 'preflight failed: ' + JSON.stringify(p));
  const proposal = p.proposal;
  // Separately signed profile must remain byte-identical after preflight.
  const unsignedProfile = { ...providerProfile }; delete unsignedProfile.signature;
  const pv = await discCrypto.verifySignature({ jws: providerProfile.signature.jws, publicJwk: ppub,
    expectedKeyId: providerKeyId, expectedPayload: unsignedProfile });
  assert(pv.ok, 'preflight mutated signed profile');
  const a = await acceptCrypto.signAcceptance({ buyerPrivateJwk: bpriv, keyId: buyerKeyId, acceptance: {
    schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1',
    acceptanceId: 'acc_' + crypto.randomBytes(8).toString('hex'), nonce: 'acc-' + crypto.randomBytes(12).toString('hex'),
    buyer: roles.buyer, provider: { providerId: profile.providerId, signingKeyId: providerKeyId },
    proposal: { proposalId: proposal.proposalId, proposalDigest: acceptanceCore.proposalDigestOf(proposal) },
    termsDigest: 'sha256:' + sha(jcs(proposal.terms)), audience: profile.origin,
    notBefore: iso(), notAfter: new Date(Date.now() + 20 * 60000).toISOString(),
    versions: { profileVersion: proposal.profileVersion, manifestVersion: proposal.manifest.commitmentManifestVersion, schema: proposal.manifest.schema },
  } });
  const scope = { buyer: roles.buyer, buyerPublicJwk: bpub, buyerKeyId, scopeMaxAmount: '1000',
    scopeCurrency: 'USDC', scopeCapability: 'sha256-financial-self-test' };
  const store = new AcceptanceStore(path.join(ROOT, '.output', 'closeout-' + kind + '-acceptances'));
  const thumb = await calculateJwkThumbprint(ppub);
  let result;
  try { result = await acceptanceCore.acceptCommitment({ profile: providerProfile, trustedThumbprints: [thumb], proposal,
    buyerScope: scope, acceptance: a, providerRef, store, idempotencyKey: request.clientNonce }); }
  finally { store.releaseLock(); }
  assert(result.status === 'ok' && result.commitment.manifest, 'commitment issuance failed');
  const context = { providerId: profile.providerId, origin: profile.origin, providerKeyId, profile: providerProfile,
    trustedThumbprints: [thumb], buyerScope: scope, proposal, acceptance: a };
  const fund = await handoff.buildEscrowFunding(result.commitment, context);
  assert(fund.ok, 'strict handoff rejected: ' + JSON.stringify(fund));
  const trust = { trustModel: 'configured-key', onboarding: 'Operator-controlled self-test: public provider key pinned from existing authorized local operator configuration, buyer key from existing local buyer registry. Third parties must authenticate these pins independently.',
    provider: { providerId: profile.providerId, origin: profile.origin, keyId: providerKeyId, publicJwk: ppub, thumbprint: thumb },
    buyer: { address: roles.buyer, keyId: buyerKeyId, publicJwk: bpub } };
  save(path.join(OUT, 'trust.json'), trust);
  const exp = { formatVersion: 'discovery-financial-v2', kind: 'real-sepolia-' + kind,
    generatedAt: iso(), chainId: 84532, network: NETWORK, asset: ASSET, custody: CUSTODY,
    custodyPin: PIN, custodyRuntimeKeccak: PIN, providerProfile, normalizedRequest: preflight.normalizeRequest(request).normalized,
    proposal, acceptance: a, commitment: result.commitment, operation: result.operation,
    funding: { ...fund.funding, chainId: 84532, network: NETWORK, asset: ASSET },
    roleControlDisclosure: 'Provider, buyer, seller and evaluator are operator-controlled test roles. No independent evaluation, external adoption or audit is claimed.',
    assuranceScope: 'Deterministic local SHA-256 service/evidence plus actual Base Sepolia USDC custody. No public financial endpoint, mainnet escrow, external-service quality, L1 finality or guaranteed recovery claim.' };
  save(file, exp);
  save(path.join(OUT, 'testnet-' + kind + '-profile.json'), providerProfile);
  console.log('PREPARED ' + kind + ' commitment=' + exp.commitment.commitmentId + ' amount=1000 raw test USDC');
  return exp;
}
async function execute(kind, exp, buyer, seller, evaluator, provider) {
  const file = path.join(OUT, 'closeout-' + kind + '-export.json');
  const journalFile = path.join(OUT, 'closeout-' + kind + '-transactions.json');
  const journal = fs.existsSync(journalFile) ? json(journalFile) : {};
  const custody = new ethers.Contract(CUSTODY, ABI, buyer);
  const token = new ethers.Contract(TOKEN, ERC20, buyer);
  const f = exp.funding;
  const persist = () => { save(file, exp); save(journalFile, journal); };
  async function submit(label, transaction) {
    await handoff.resolveAndEnforceChain(provider, exp.proposal.terms.network);
    let entry = journal[label];
    if (!entry) {
      const populated = await buyer.populateTransaction(transaction);
      assert(Number(populated.chainId) === 84532, 'unsigned tx chain mismatch');
      const raw = await buyer.signTransaction(populated);
      entry = { hash: ethers.keccak256(raw), signedTransaction: raw, nonce: populated.nonce,
        chainId: 84532, preparedAt: iso(), status: 'signed-not-confirmed' };
      journal[label] = entry; persist(); // no private key, only intended signed test tx
    }
    let receipt = await provider.getTransactionReceipt(entry.hash);
    if (!receipt) {
      const exists = await provider.getTransaction(entry.hash);
      if (!exists) {
        try { await provider.broadcastTransaction(entry.signedTransaction); }
        catch (error) {
          // A dropped HTTP response can follow acceptance. Check by exact hash;
          // never re-sign or consume a second nonce on uncertain broadcast.
          if (!(await provider.getTransaction(entry.hash))) throw error;
        }
      }
      entry.status = 'broadcast'; persist();
      receipt = await provider.waitForTransaction(entry.hash, 1, 120000);
    }
    assert(receipt && receipt.status === 1, label + ' missing/success receipt');
    entry.status = 'confirmed'; entry.block = receipt.blockNumber; entry.blockHash = receipt.blockHash;
    entry.confirmedAt = iso(); persist();
    console.log('CONFIRMED ' + label + ' ' + entry.hash + ' block=' + entry.block);
    return receipt;
  }
  const held = await custody.getEscrow(f.commitmentId);
  assert(Number(held[9]) === 0 || journal.fund, 'existing escrow without journal; reconcile manually instead of fund');
  assert(await token.balanceOf(buyer.address) >= BigInt(f.amount) || journal.fund, 'insufficient authorized test USDC');
  assert(await provider.getBalance(buyer.address) > ethers.parseEther('0.00005'), 'insufficient test ETH for bounded gas');
  if (!journal.fund) {
    const allowance = await token.allowance(buyer.address, CUSTODY);
    if (allowance < BigInt(f.amount)) await submit('approve', await token.approve.populateTransaction(CUSTODY, f.amount));
  }
  const fundedReceipt = await submit('fund', await custody.fund.populateTransaction(f.commitmentId, f.commitmentDigest,
    f.token, f.buyer, f.seller, f.evaluator, f.amount, f.deadline, f.minReleaseTime));
  f.fundTx = fundedReceipt.hash; f.fundBlock = fundedReceipt.blockNumber; f.fundBlockHash = fundedReceipt.blockHash;
  if (journal.approve) f.approveTx = journal.approve.hash;
  persist();
  if (journal[kind]) {
    // Reconcile an already signed/submitted terminal transaction first, before
    // making any new evidence or verdict (which would change its nonce/signature).
    const receipt = await submit(kind, {});
    exp[kind].tx = receipt.hash; exp[kind].block = receipt.blockNumber;
    exp[kind].blockHash = receipt.blockHash; exp[kind].status = 'success';
    exp.completedAt = exp.completedAt || iso(); persist(); return;
  }
  if (!exp.fulfillmentEvidence) {
    const payload = { schemaVersion: 'saax-financial-evidence-v1', domain: 'saax:financial-evidence:v1',
      type: kind === 'release' ? 'sha256-self-test-result' : 'sha256-self-test-nonfulfillment',
      commitmentId: f.commitmentId, commitmentDigest: f.commitmentDigest, requestDigest: exp.proposal.requestDigest,
      issuer: seller.address.toLowerCase(), issuedAt: String(Math.floor(Date.now() / 1000)),
      result: kind === 'release' ? 'fulfilled' : 'not-fulfilled',
      outputSha256: kind === 'release' ? sha(exp.proposal.terms.policies.financialAgreement.fulfillment.inputUtf8) : null,
      reason: kind === 'release' ? 'deterministic-sha256-computed' : 'authorized-test-nonfulfillment' };
    const evidenceDigest = '0x' + sha(jcs(payload));
    const signature = await seller.signTypedData({ name: 'SAAX Financial Evidence', version: '1', chainId: 84532,
      verifyingContract: CUSTODY }, EVIDENCE_TYPES, { commitmentId: f.commitmentId,
      commitmentDigest: f.commitmentDigest, evidenceDigest, issuedAt: payload.issuedAt });
    exp.fulfillmentEvidence = { payload, signature, evidenceDigest }; persist();
  }
  const nonce = String(BigInt(Date.now()) * 1000n + BigInt(kind === 'release' ? 1 : 2));
  assert(!(await custody.usedVerdictNonce(nonce)), 'verdict nonce unexpectedly used; no submit');
  const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: 84532, verifyingContract: CUSTODY };
  const message = { commitmentId: f.commitmentId, commitmentDigest: f.commitmentDigest, action: kind,
    nonce, issuedAt: String(Math.floor(Date.now() / 1000)) };
  const signature = ethers.Signature.from(await evaluator.signTypedData(domain, VERDICT_TYPES, message));
  const verdict = { ...message, domain, primaryType: 'EscrowVerdict', types: VERDICT_TYPES,
    v: signature.v, r: signature.r, s: signature.s };
  const evidenceDigest = exp.fulfillmentEvidence.evidenceDigest;
  const verdictDigest = ethers.TypedDataEncoder.hash(domain, VERDICT_TYPES, message);
  const evaluation = { evidenceDigest, verdictDigest,
    signature: await evaluator.signTypedData({ name: 'SAAX Financial Evaluation', version: '1', chainId: 84532,
      verifyingContract: CUSTODY }, EVALUATION_TYPES,
      { commitmentId: f.commitmentId, commitmentDigest: f.commitmentDigest, evidenceDigest, verdictDigest }) };
  exp[kind] = { chainId: 84532, network: NETWORK, asset: ASSET, verdict, evaluation, status: 'signed-not-submitted' };
  persist();
  const receipt = await submit(kind, await custody[kind].populateTransaction(f.commitmentId, f.commitmentDigest,
    nonce, message.issuedAt, signature.v, signature.r, signature.s));
  exp[kind].tx = receipt.hash; exp[kind].block = receipt.blockNumber; exp[kind].blockHash = receipt.blockHash;
  exp[kind].status = 'success'; exp.completedAt = iso(); persist();
}
async function main() {
  const args = process.argv.slice(2);
  const configArg = args.find(a => a.startsWith('--config-root='));
  assert(configArg, 'explicit existing authorized SAAX --config-root required');
  const configRoot = path.resolve(configArg.slice('--config-root='.length));
  // Read ONLY the needed EVM role keys from the authorized SAAX dotenv. Never
  // install mainnet defaults, DB credentials or other config into process.env.
  const config = dotenv.parse(fs.readFileSync(path.join(configRoot, '.env')));
  const provider = new ethers.JsonRpcProvider(RPC);
  const buyer = new ethers.Wallet(config.SAAX_TEST_BUYER_KEY, provider);
  const seller = new ethers.Wallet(config.SAAX_SELLER_PRIVATE_KEY);
  const evaluator = new ethers.Wallet(config.SAAX_EVALUATOR_PRIVATE_KEY);
  const roles = { buyer: buyer.address.toLowerCase(), seller: seller.address.toLowerCase(), evaluator: evaluator.address.toLowerCase() };
  console.log('AUTHORIZED TEST ROLES ' + JSON.stringify(roles));
  await readIdentity(provider);
  const token = new ethers.Contract(TOKEN, ERC20, provider);
  console.log('TEST BALANCES buyer rawUSDC=' + (await token.balanceOf(buyer.address)) + ' weiETH=' + (await provider.getBalance(buyer.address)));
  const kindArg = args.find(a => a.startsWith('--kind='));
  const kinds = kindArg ? [kindArg.split('=')[1]] : ['release', 'refund'];
  for (const kind of kinds) {
    assert(['release', 'refund'].includes(kind), 'kind must be release/refund');
    const exp = await prepare(kind, roles, path.join(configRoot, '.output', '.live-operator'), provider);
    if (args.includes('--execute')) await execute(kind, exp, buyer, seller, evaluator, provider);
  }
  provider.destroy();
}
if (require.main === module) main().catch(error => { console.error('CLOSEOUT STOPPED: ' + error.message); process.exitCode = 1; });
module.exports = { prepare, execute };
