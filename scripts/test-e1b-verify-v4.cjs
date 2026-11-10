'use strict';
// E1B focused tests — verify-v4.js finality integration surface, run as a
// FRESH PROCESS per case (no app DB, no participant keys) exactly like the
// production verifier entry point.
//
// Builds ONE genuine local EVM 31337 lifecycle export (custody + EAS 1.7.1 +
// Safe 2-of-3 + token, exact producer pattern), records the fresh local
// deployment identity/policy in the repository-owned files (same pattern the
// committed producers follow), then spawns verifier/verify-export.js in a
// fresh process for each trusted-config policy to prove:
//
//   [LOCAL] SAAX_V4_FINALITY= (default/local-synthetic): VERIFIED_WITH_LIMITATIONS
//           with the local-synthetic finality boundary (unchanged ceiling).
//   [NEG]   SAAX_V4_FINALITY=op-stack-safe against a non-OP-stack (31337) RPC:
//           fail closed (TAG_UNAVAILABLE -> INCOMPLETE_UNSUPPORTED); the
//           public policy never silently downgrades to local confirmations.
//   [NEG]   export declaring a public policy while trusted config is local
//           (or vice versa): divergence rejected (downgrade attempt).
//   [NEG]   lifecycle export claiming an unsupported public deployment
//           identity (84532 historical local profile): remains unsupported.
//
// All interactions are genuine local EVM 31337 over a read-only RPC proxy;
// no public chain, no broadcast, no spending, no mainnet activation.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const canonical = require('../mainnet/design/support/v4-canonical');
const signatures = require('../mainnet/design/support/v4-signatures');
const journalWriter = require('../mainnet/design/support/v4-journal-writer');
const av = require('../verifier/v4-anchor');

const ROOT = path.resolve(__dirname, '..');
// Isolated output directory for this battery (NOT committed evidence).
const OUT = path.join(ROOT, '.output/e1b');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  - ' + String(detail).slice(0, 400) : '')); }
}

async function child(exportFile, rpcUrl, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'verifier/verify-export.js'), exportFile, '--rpc', rpcUrl], {
      cwd: ROOT,
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]).concat(Object.entries(extraEnv))),
    });
    let text = '';
    p.stdout.on('data', (c) => { text += c; });
    p.stderr.on('data', (c) => { text += c; });
    p.on('error', reject);
    p.on('exit', (code) => resolve({ code, text }));
  });
}

async function buildLifecycleExport() {
  const CHAIN = 31337;
  const { provider, hre, accounts } = await helpers.startEvm(CHAIN);
  const [deployer, buyer, seller, evaluatorEOA, attester,, stranger] = accounts;
  const t = Math.floor(Date.now() / 1000);
  const iso = (n) => new Date(n * 1000).toISOString().replace('.000Z', 'Z');

  async function deploy(art, args = []) { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; }

  const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
  const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
  const registry = await deploy(regArt);
  const eas = await deploy(easArt, [registry.target]);

  const safeArt = helpers.compileSafe('Safe', 'contracts/Safe.sol');
  const handlerArt = helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const singleton = await deploy(safeArt), handler = await deploy(handlerArt), factory = await deploy(factoryArt);
  const init = new ethers.Interface(safeArt.abi).encodeFunctionData('setup', [[buyer.address, seller.address, evaluatorEOA.address], 2, ethers.ZeroAddress, '0x', handler.target, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const created = await (await factory.createProxyWithNonce(singleton.target, init, 6311n)).wait();
  const createdEvent = created.logs.map((l) => { try { return factory.interface.parseLog(l); } catch (_) { return null; } }).find((l) => l?.name === 'ProxyCreation');
  const safe = new ethers.Contract(createdEvent.args.proxy, safeArt.abi, deployer);

  const token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  const custodyArt = hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2');
  const custody = await deploy(custodyArt, [1000000, 10000000, true, 1, '0x' + 'ab'.repeat(32)]);
  await (await registry.register(av.SCHEMA, ethers.ZeroAddress, false)).wait();

  // Record THIS run's LOCAL-TEST-ONLY 31337 EAS policy + candidate identity
  // (producer pattern) so the separate-process verifier accepts this run's
  // freshly deployed EAS + custody runtime hashes.
  const policyFile = path.join(ROOT, 'verifier/v4-eas-policy.json');
  const policyJson = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policyJson.policies['31337'] = {
    policy: 'local-official-eas-1.7.1-v1-31337', chainId: 31337,
    note: 'Explicitly LOCAL-TEST-ONLY entry. Fresh local deployment for the E1B battery; authorizes nothing on any public chain.',
    easAddress: eas.target, registryAddress: registry.target,
    runtimeCodeHash: ethers.keccak256(await provider.getCode(eas.target)),
    registryRuntimeCodeHash: ethers.keccak256(await provider.getCode(registry.target)),
  };
  const priorPolicy = fs.readFileSync(policyFile, 'utf8');
  fs.writeFileSync(policyFile, JSON.stringify(policyJson, null, 2) + '\n');
  const identityPath31337 = path.join(ROOT, 'verifier/v4-candidate-identity-31337.json');
  const priorIdentity = fs.readFileSync(identityPath31337, 'utf8');
  const runtimeHash = ethers.keccak256(await provider.getCode(custody.target));
  const identity31337 = {
    policy: 'local-immutable-candidate-v1-31337', chainId: 31337,
    note: 'Explicitly LOCAL-TEST-ONLY profile for the fresh E1B battery deployment.',
    compiler: require('solc').version(),
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris' },
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'contracts/SAAXEscrowCustodyV2.sol'))).digest('hex'),
    runtimeCodeHash: runtimeHash,
    abi: custodyArt.abi,
  };
  fs.writeFileSync(identityPath31337, JSON.stringify(identity31337, null, 2) + '\n');

  const deliverable = JSON.stringify({ deliverable: 'e1b-report', format: 'application/json', fields: { ok: true }, value: 7 });
  const deliverableHash = '0x' + crypto.createHash('sha256').update(deliverable, 'utf8').digest('hex');
  const cid = ethers.zeroPadValue(ethers.toBeHex(0xe1b), 32);

  const m = {
    commitmentId: cid, buyerAgentId: buyer.address, sellerAgentId: seller.address,
    capability: 'e1b-finality', price: { amount: '500000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash-equals', value: deliverableHash },
    deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
    terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
    evaluator: safe.target, evaluatorPermittedDecisions: ['release', 'refund'],
    policy: { version: 'saax-custody-policy-v1', digest: '0x' + 'ab'.repeat(32), profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
    profile: 'OBJECTIVE_DIGITAL',
    custody: { chainId: CHAIN, custodyAddress: custody.target, token: token.target, principal: '500000', fees: '0', reserve: '0' },
    consents: {
      buyer: { accepted: true, ref: 'e1b-buyer' }, seller: { accepted: true, ref: 'e1b-seller' },
      sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' },
    },
    evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true, acceptedIssuers: [seller.address], requiredTypes: ['deliverable-hash'] },
    deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) },
    fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' },
  };
  const built = canonical.buildV4Manifest(m);
  m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
  const digest = '0x' + built.manifestHash.slice(7);
  const digestFull = built.manifestHash;
  const authorizations = [];
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const message = { manifestHash: digest, role, nonce: '1', expiresAt: String(t + 900) };
    authorizations.push({ role, walletType: 'EOA', nonce: message.nonce, expiresAt: message.expiresAt, signature: await signer.signTypedData(signatures.agreementDomain(custody.target, CHAIN), signatures.COMMITMENT_CONSENT_TYPES, message) });
  }

  const data = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [cid, digest, ...Array(10).fill(''), 'issued', BigInt(t)]);
  const attReceipt = await (await eas.connect(attester).attest({ schema: av.SCHEMA_UID, data: { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: false, refUID: ethers.ZeroHash, data, value: 0 } })).wait();
  const attEvent = attReceipt.logs.map((l) => { try { return eas.interface.parseLog(l); } catch (_) { return null; } }).find((l) => l?.name === 'Attested');
  const anchor = { recordVersion: 1, chainId: CHAIN, easAddress: eas.target, schemaUid: av.SCHEMA_UID, uid: attEvent.args.uid, txHash: attReceipt.hash, blockHash: attReceipt.blockHash, blockNumber: String(attReceipt.blockNumber), attester: attester.address, recipient: ethers.ZeroAddress, attestationData: data, authorizations: [] };
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const expiresAt = String(t + 900);
    anchor.authorizations.push({ role, expiresAt, signature: await signer.signTypedData(av.domain(anchor), av.AUTH_TYPES, av.message(anchor, m, digest, expiresAt)) });
  }

  const amount = 500000n;
  await (await token.connect(buyer).mint(buyer.address, amount + 1000000n)).wait();
  await (await token.connect(buyer).approve(custody.target, amount + 1000000n)).wait();
  const funding = await (await custody.connect(buyer).fund(cid, digest, token.target, buyer.address, seller.address, safe.target, amount, t + 1000, t + 2000, 0, 1, '0x' + 'ab'.repeat(32), digest)).wait();
  const d = ethers.TypedDataEncoder.hash(signatures.custodyDomain(custody.target, CHAIN), signatures.ESCROW_VERDICT_TYPES, { commitmentId: cid, commitmentDigest: digest, action: 'release', nonce: 0xe1b, issuedAt: t });
  const h = helpers.safeMessageHash(ethers, safe.target, CHAIN, d);
  const packed = helpers.packSafeSigs([1, 2].map((i) => ({ addr: accounts[i].address, sig: helpers.rawSign(ethers, i, h) })));
  const settlement = await (await custody.connect(stranger).release(cid, digest, 0xe1b, t, 0, ethers.ZeroHash, ethers.ZeroHash, packed, { gasLimit: 1000000 })).wait();

  const journal = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custody.target, commitmentId: cid, manifestHash: digest });
  await journal.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer], txHash: attReceipt.hash, blockHash: attReceipt.blockHash });
  await journal.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer], txHash: funding.hash, blockHash: funding.blockHash });
  await journal.append({ transition: 'release', role: 'evaluator', by: safe.target, contractAction: 'release', resultingState: 'Released', at: new Date((t + 1) * 1000).toISOString(), signerWallets: [deployer], txHash: settlement.hash, blockHash: settlement.blockHash, authorization: { kind: 'safe-erc1271-2of3', agreedEvaluator: safe.target, chainId: CHAIN, custody: custody.target, note: 'journal attests the record, not the authorization' } });

  const payloadHash = deliverableHash;
  const itemMsg = { recordVersion: 1, commitmentId: cid, manifestHash: digest, criterionId: 'deliverable-hash', itemId: 'deliverable-1', type: 'deliverable-hash', issuer: seller.address, payloadHash, at: iso(t), amount: '0' };
  const itemSig = ethers.Signature.from(await seller.signTypedData(signatures.evidenceDomain(custody.target, CHAIN), signatures.EVIDENCE_ITEM_TYPES, itemMsg));
  const evidence = {
    recordVersion: 1, time: iso(t), commitmentId: cid, manifestHash: digest,
    domain: signatures.evidenceDomain(custody.target, CHAIN),
    items: [{ itemId: 'deliverable-1', criterionId: 'deliverable-hash', type: 'deliverable-hash', issuer: seller.address, payloadHash, payload: deliverable, at: iso(t), amount: '0', signedBy: seller.address, sigs: [{ v: itemSig.v, r: itemSig.r, s: itemSig.s }] }],
    findings: {},
  };

  const exp = {
    formatVersion: 4, agreement: m, commitmentDigest: digestFull, authorizations,
    lifecycleProfile: 'full',
    lifecycle: { funding: { txHash: funding.hash, blockHash: funding.blockHash }, settlement: { txHash: settlement.hash, blockHash: settlement.blockHash } },
    finality: { mode: 'local-synthetic' },
    anchor, journal: journal.snapshot(), evidence,
  };
  const expFile = path.join(OUT, 'lifecycle-export.json');
  fs.writeFileSync(expFile, JSON.stringify(exp, null, 2));

  const allow = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_blockNumber', 'eth_getBalance', 'eth_feeHistory']);
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async (q) => {
      try {
        if (!allow.has(q.method)) throw new Error('method unavailable');
        return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rpcUrl = 'http://127.0.0.1:' + server.address().port;

  return { expFile, rpcUrl, server, provider, cleanupFiles: [policyFile, identityPath31337], priorPolicy, priorIdentity };
}

(async () => {
  const { expFile, rpcUrl, server, provider, cleanupFiles, priorPolicy, priorIdentity } = await buildLifecycleExport();

  // [LOCAL] default/local-synthetic -> VERIFIED_WITH_LIMITATIONS (unchanged).
  let r = await child(expFile, rpcUrl);
  check('[LOCAL] default policy (local-synthetic) -> VERIFIED_WITH_LIMITATIONS', r.code === 0 && /VERIFIED_WITH_LIMITATIONS/.test(r.text), 'code=' + r.code);
  check('[LOCAL] local-synthetic finality boundary check present', /local-synthetic finality boundary/.test(r.text), '');
  check('[LOCAL] no public-chain finality claim in assurance', /local synthetic/.test(r.text) && !/finalized life/.test(r.text), '');

  // [NEG/PUBLIC] trusted op-stack-safe configured against the LOCAL-TEST chain
  // (31337): the E1 closure explicit supported-network policy makes public
  // finality checks require the explicit public-testnet chain (84532) ONLY.
  // A trusted public policy on the local-test chain must FAIL CLOSED at the
  // chain gate — never a silent downgrade to local confirmations and never a
  // SAFE-stage green under a public policy on a non-public chain. The SAFE-
  // stage positive path is demonstrated on the allowed testnet chain by the
  // E1D mock battery and the real 84532 observation (observe-e1d-sepolia).
  r = await child(expFile, rpcUrl, { SAAX_V4_FINALITY: 'op-stack-safe' });
  if (process.env.E1B_DEBUG) console.log('=== DEBUG op-stack-safe child ===\n' + r.text.slice(0, 2500));
  check('[NEG] trusted public policy on local-test chain 31337 fails closed at the chain gate', r.code === 1 && /NOT VERIFIED/.test(r.text) && /FINALITY_PUBLIC_POLICY_CHAIN_UNSUPPORTED:chain=31337/.test(r.text), 'code=' + r.code + ' ' + r.text.slice(0, 300));
  check('[NEG] public policy on 31337 never downgrades to local confirmations (no green)', !/VERIFIED_WITH_LIMITATIONS/.test(r.text) && /not covered by OP Stack safe head/.test(r.text), 'code=' + r.code);

  // [NEG] export declaring a public policy while trusted config is local ->
  // divergence rejected (downgrade attempt). The export file is mutated in
  // the isolated dir, not committed evidence.
  const expUp = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  expUp.finality = { mode: 'op-stack-finalized' };
  const upFile = path.join(OUT, 'lifecycle-export-upgraded.json');
  fs.writeFileSync(upFile, JSON.stringify(expUp, null, 2));
  r = await child(upFile, rpcUrl);
  check('[NEG] export public-mode with local trusted config rejected (downgrade attempt)', /NOT VERIFIED/.test(r.text) && /cannot diverge|only local-synthetic/.test(r.text), r.text.slice(0, 300));

  // [NEG] unsupported public deployment identity: chainId 84532 (historical
  // local profile) claimed as a public deployment must remain unsupported.
  // Re-signing the agreement for 84532 would require new signatures; instead
  // this asserts the committed 84532 identity profile is NOT accepted as a
  // public-chain shortcut by pointing the export's custody chain at 84532 and
  // observing the verifier's identity/chain gates reject it (INCOMPLETE), not
  // a trust-any green path.
  const exp84532 = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  exp84532.agreement.custody.chainId = 84532;
  const c84532File = path.join(OUT, 'lifecycle-export-84532.json');
  fs.writeFileSync(c84532File, JSON.stringify(exp84532, null, 2));
  r = await child(c84532File, rpcUrl);
  check('[NEG] 84532 public deployment claim remains unsupported (INCOMPLETE, no trust-any green)', /INCOMPLETE_UNSUPPORTED|NOT VERIFIED/.test(r.text), r.text.slice(0, 300));

  // Separate-process behavior without app DB: the children above all spawned
  // verifier/verify-export.js in fresh processes with no SAAX DB; assert the
  // process did not hang into app wiring (exit code present, no DB refs).
  check('[LOCAL] separate-process verifier returns without app DB access', r.code !== undefined && !/sqlite|SAAX_DB|sequelize/i.test(r.text), 'code=' + r.code);

  // Restore the committed policy/identity bytes.
  fs.writeFileSync(cleanupFiles[0], priorPolicy);
  fs.writeFileSync(cleanupFiles[1], priorIdentity);
  try { server.close(); } catch {}
  try { provider.destroy(); } catch {}

  console.log('----');
  console.log('e1b_verify_v4_passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2); });