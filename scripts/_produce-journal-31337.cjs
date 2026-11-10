'use strict';
/**
 * SAAX Pilot Journal Phase A — 31337 journal-bearing export producer.
 *
 * Produces the NEW Phase A journal evidence on the LOCAL EVM chain 31337
 * (per the chain-identity resolution: local EVM is 31337, never 84532;
 * historical 84532 synthetic fixtures stay byte-identical and are NOT
 * presented as current local-chain evidence). 31337 manifests, signature
 * domains, and receipts are all genuine — this script boots a fresh 31337 EVM,
 * deploys the custody candidate + Safe stack, and runs real fund/release/
 * mutual/timeout lifecycle transactions on it.
 *
 * Outputs (evidence/phase3b-v4/):
 *   journal-lifecycle.json  issue -> funded -> release (Safe evaluator)
 *   journal-mutual.json     issue -> funded -> mutual-refund (buyer+seller)
 *   journal-timeout.json    issue -> funded -> timeout-refund (open)
 *
 * Each export carries a journal field (hash chain only, association + tamper
 * evidence, NO completeness claim) with evidenceDigest-bound chain/custody/
 * tx/block/authorization references, signed under the v4 journal domain
 * (SAAX Commitment Journal / "4", chainId 31337, verifyingContract = the
 * deployed custody).
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const canonical = require('../mainnet/design/support/v4-canonical');
const signatures = require('../mainnet/design/support/v4-signatures');
const journalWriter = require('../mainnet/design/support/v4-journal-writer');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence/phase3b-v4');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

(async () => {
  const CHAIN = 31337;
  const { provider, hre, accounts } = await helpers.startEvm(CHAIN);
  const [deployer, buyer, seller, evaluator, , , stranger] = accounts;

  async function deploy(art, args = []) { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; }
  const safeArt = helpers.compileSafe('Safe', 'contracts/Safe.sol');
  const handlerArt = helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const singleton = await deploy(safeArt), handler = await deploy(handlerArt), factory = await deploy(factoryArt);
  const init = new ethers.Interface(safeArt.abi).encodeFunctionData('setup', [[buyer.address, seller.address, evaluator.address], 2, ethers.ZeroAddress, '0x', handler.target, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const created = await (await factory.createProxyWithNonce(singleton.target, init, 441n)).wait();
  const createdEvent = created.logs.map(l => { try { return factory.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'ProxyCreation');
  const safe = new ethers.Contract(createdEvent.args.proxy, safeArt.abi, deployer);
  const token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  const policy = '0x' + 'ab'.repeat(32);
  const custodyArt = hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2');
  const custody = await deploy(custodyArt, [1000000, 10000000, true, 1, policy]);

  check('31337 EVM running', (await provider.send('eth_chainId', [])).toString(16) === '31337' || await provider.getNetwork().then(n => Number(n.chainId) === 31337));
  await (await token.mint(buyer.address, 1000000)).wait();
  await (await token.connect(buyer).approve(custody.target, 1000000)).wait();

  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const t = Number(BigInt(block.timestamp));
  const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
  const ref = r => ({ txHash: r.hash, blockHash: r.blockHash });

  async function fixture(idNumber) {
    const m = {
      commitmentId: ethers.zeroPadValue(ethers.toBeHex(idNumber), 32), buyerAgentId: buyer.address, sellerAgentId: seller.address,
      capability: 'synthetic-local', price: { amount: '1000', currency: 'USDC', decimals: 6 }, acceptanceCriteria: { type: 'hash', value: 'synthetic-only' },
      deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
      terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
      evaluator: safe.target, evaluatorPermittedDecisions: ['release', 'refund'],
      policy: { version: 'saax-custody-policy-v1', digest: policy, profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
      profile: 'OBJECTIVE_DIGITAL', custody: { chainId: CHAIN, custodyAddress: custody.target, token: token.target, principal: '1000', fees: '0', reserve: '0' },
      consents: { buyer: { accepted: true, ref: 'synthetic-buyer' }, seller: { accepted: true, ref: 'synthetic-seller' }, sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' } },
      evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true },
      deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) }, fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' }
    };
    const built = canonical.buildV4Manifest(m);
    m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
    const digest = '0x' + built.manifestHash.slice(7);
    const authorizations = [];
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
      const message = { manifestHash: digest, role, nonce: '1', expiresAt: String(t + 900) };
      authorizations.push({ role, walletType: 'EOA', nonce: message.nonce, expiresAt: message.expiresAt, signature: await signer.signTypedData(signatures.agreementDomain(custody.target, CHAIN), signatures.COMMITMENT_CONSENT_TYPES, message) });
    }
    const funding = await (await custody.connect(buyer).fund(m.commitmentId, digest, token.target, buyer.address, seller.address, safe.target, 1000, t + 1000, t + 2000, 0, 1, policy, digest)).wait();
    const exp = { formatVersion: 4, agreement: m, commitmentDigest: built.manifestHash, authorizations, lifecycleProfile: 'full', lifecycle: { funding: ref(funding) }, finality: { mode: 'local-synthetic' } };
    return { exp, digest, id: m.commitmentId, funding };
  }

  function releaseArgs(f, nonce) {
    const digest = ethers.TypedDataEncoder.hash(signatures.custodyDomain(custody.target, CHAIN), signatures.ESCROW_VERDICT_TYPES, { commitmentId: f.id, commitmentDigest: f.digest, action: 'release', nonce, issuedAt: t });
    const h = helpers.safeMessageHash(ethers, safe.target, CHAIN, digest);
    const packed = helpers.packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: helpers.rawSign(ethers, i, h) })));
    return [f.id, f.digest, nonce, t, 0, ethers.ZeroHash, ethers.ZeroHash, packed];
  }

  const first = await fixture(5101);
  const releaseReceipt = await (await custody.connect(stranger).release(...releaseArgs(first, 5101), { gasLimit: 1000000 })).wait();
  first.exp.lifecycle.settlement = ref(releaseReceipt);
  const firstBlock = await provider.getBlock(releaseReceipt.blockHash);

  // lifecycle journal: issue -> funded -> release (Safe evaluator)
  const jw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custody.target, commitmentId: first.id, manifestHash: first.digest });
  await jw.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await jw.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer] });
  await jw.append({
    transition: 'release', role: 'evaluator', by: safe.target,
    contractAction: 'release', resultingState: 'Released',
    at: new Date((t + 1) * 1000).toISOString(),
    signerWallets: [deployer], // writer attestation key — never the Safe
    authorization: { kind: 'safe-erc1271-2of3', agreedEvaluator: safe.target, chainId: CHAIN, custody: custody.target, note: 'custody accepted the Safe 2-of-3 authorization; journal attests the record, not the authorization' },
  });
  const lifecycleExport = { ...JSON.parse(JSON.stringify(first.exp)), journal: jw.snapshot() };
  fs.writeFileSync(path.join(OUT, 'journal-lifecycle.json'), JSON.stringify(lifecycleExport, null, 2));
  check('journal-lifecycle.json written (31337, 3 entries)', fs.existsSync(path.join(OUT, 'journal-lifecycle.json')) && jw.count() === 3);

  // mutual journal: issue -> funded -> mutual-refund (buyer+seller)
  const mf = await fixture(5102);
  const mutualMessage = { commitmentId: mf.id, commitmentDigest: mf.digest, action: 'refund', nonce: 5102, issuedAt: t };
  const mutualSigs = [];
  for (const party of [buyer, seller]) mutualSigs.push(ethers.Signature.from(await party.signTypedData(signatures.custodyDomain(custody.target, CHAIN), signatures.MUTUAL_RESOLUTION_TYPES, mutualMessage)));
  const mutualReceipt = await (await custody.connect(stranger).mutualRefund(mf.id, mf.digest, 5102, t, mutualSigs[0].v, mutualSigs[0].r, mutualSigs[0].s, mutualSigs[1].v, mutualSigs[1].r, mutualSigs[1].s, { gasLimit: 1000000 })).wait();
  mf.exp.lifecycle.settlement = ref(mutualReceipt);
  const mjw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custody.target, commitmentId: mf.id, manifestHash: mf.digest });
  await mjw.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await mjw.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer] });
  await mjw.append({ transition: 'mutual-refund', role: 'buyer+seller', by: buyer.address, contractAction: 'mutualRefund', resultingState: 'Refunded', at: new Date((t + 1) * 1000).toISOString(), signerWallets: [buyer, seller] });
  const mutualExport = { ...JSON.parse(JSON.stringify(mf.exp)), journal: mjw.snapshot() };
  fs.writeFileSync(path.join(OUT, 'journal-mutual.json'), JSON.stringify(mutualExport, null, 2));
  check('journal-mutual.json written (31337, 3 entries)', fs.existsSync(path.join(OUT, 'journal-mutual.json')) && mjw.count() === 3);

  // timeout journal: issue -> funded -> timeout-refund (open; attester signs)
  const tf = await fixture(5103);
  await hre.network.provider.send('evm_setNextBlockTimestamp', [t + 2000]);
  const timeoutReceipt = await (await custody.connect(stranger).refund(tf.id, tf.digest, 0, 0, 0, ethers.ZeroHash, ethers.ZeroHash, '0x', { gasLimit: 1000000 })).wait();
  tf.exp.lifecycle.settlement = ref(timeoutReceipt);
  const tjw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custody.target, commitmentId: tf.id, manifestHash: tf.digest });
  await tjw.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await tjw.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer] });
  await tjw.append({ transition: 'timeout-refund', role: 'open', by: stranger.address, contractAction: 'refund(timeout)', resultingState: 'Refunded', at: new Date((t + 2000) * 1000).toISOString(), signerWallets: [deployer], authorization: { kind: 'cutoff-eligibility', finalCutoffAt: t + 2000, recipientFixed: buyer.address, note: 'open submission; recipient fixed by contract; writer attests the record only' } });
  const timeoutExport = { ...JSON.parse(JSON.stringify(tf.exp)), journal: tjw.snapshot() };
  fs.writeFileSync(path.join(OUT, 'journal-timeout.json'), JSON.stringify(timeoutExport, null, 2));
  check('journal-timeout.json written (31337, 3 entries)', fs.existsSync(path.join(OUT, 'journal-timeout.json')) && tjw.count() === 3);

  // all three journals: agreement custody chain is 31337
  for (const [name, exp] of [['lifecycle', lifecycleExport], ['mutual', mutualExport], ['timeout', timeoutExport]]) {
    check(name + ' export agreement custody chain == 31337', exp.agreement.custody.chainId === CHAIN, 'got ' + exp.agreement.custody.chainId);
    check(name + ' journal chainId == 31337', exp.journal.chainId === CHAIN, 'got ' + exp.journal.chainId);
  }

  console.log('');
  console.log('PASSED=' + passed + ' FAILED=' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });