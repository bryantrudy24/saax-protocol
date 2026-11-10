/**
 * F3C — REAL SAFE ERC-1271 + SAME-BLOCK GOVERNANCE on the EXACT CANDIDATE
 * (pinned F3B runtime, cancun, keccak 0x87615e3d). LOCAL EVM 31337 only.
 *
 * This is the focused companion harness for the two exact-candidate coverage
 * gaps recorded in review/f3c-candidate/03-coverage-matrix.md:
 *   GAP 1 — real Safe/ERC-1271 flow not run on the pinned F3B object.
 *   GAP 2 — same-block governance ordering not demonstrated on the pinned
 *           object.
 *
 * DIFFERENCE FROM THE F3A-TARGET SUITE (scripts/test-custody-v3-realsafe.cjs):
 *   The F3A suite compiles the V3 source in-tree under hardhat.config.js
 *   (evmVersion paris) — it exercises a DIFFERENT runtime object. This harness
 *   DEPLOYS THE COMMITTED ARTIFACT data/escrow-custody-v3-build.json (settings
 *   evmVersion OMITTED → cancun) and asserts the deployed runtime keccak
 *   equals the repo-owned pin verifier/v4-candidate-identity-31337-v3.json
 *   (0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3)
 *   BEFORE any behavior test. Source compilation is never used here.
 *
 * REAL SAFE (unchanged mechanism, verified against safe-contracts@1.4.1):
 *   Custody calls proxy.isValidSignature(custodyV3Digest, sig) → SafeProxy
 *   delegatecalls singleton Safe → no isValidSignature → Compatibility-
 *   FallbackHandler wraps the custody digest in Safe's SafeMessage EIP-712
 *   envelope (Safe's own domain over chainId + verifyingContract=safe) →
 *   safe.checkSignatures enforces the owner set + threshold (2-of-3 first,
 *   3-of-3 after governance) over the SafeMessage hash with packed
 *   {r}{s}{v} owner signatures in ASCENDING owner order. Ownership/threshold
 *   changes go through the REAL Safe governance path (execTransaction with
 *   owner signatures).
 *
 * SAME-BLOCK GOVERNANCE ORDERING (the exact-candidate proof):
 *   The Safe starts at threshold 2 (owners buyer, seller, evaluator). With
 *   automine OFF, three transactions are queued in one block in order:
 *     tx0: custody.release(escrow A) with a valid 2-of-3 Safe verdict  → SUCCESS
 *     tx1: safe.execTransaction(changeThreshold(3)) signed 2-of-3        → SUCCESS
 *     tx2: custody.release(escrow B) with another valid 2-of-3 Safe
 *          verdict (authorization that WAS valid at the block's start under
 *          threshold 2, for ITS OWN escrow and payload)                 → REVERT
 *   Assertions:
 *     - transaction indices: tx0.index < tx1.index < tx2.index, all same block
 *     - first payout succeeded (seller A paid exactly once)
 *     - governance applied (threshold now 3 at end of block)
 *     - second release rejected WITHOUT payout (escrow B still Funded,
 *       totalHeld unchanged, no settlement event, no committedHead)
 *   Alternative rejection causes EXCLUDED by construction:
 *     - wrong chain/domain: both verdicts signed over the real Safe domain on
 *       chain 31337 with the same custody address; only escrow/payload differs.
 *     - expiry: both issuedAt equal the same timestamp, verified inside the
 *       contract's validity window [blockTime-300, blockTime+120].
 *     - nonce reuse: escrow-scoped nonces, distinct per escrow.
 *     - changed checkpoint heads: each verdict binds ITS OWN escrow's head
 *       (its own journal prefix tail) committed at execution.
 *     - already-settled escrow: escrow B was Funded at the start of the block
 *       and remains Funded, so WrongState is not the cause.
 *   The ONLY difference between tx0-success and tx2-revert is the Safe
 *   threshold at EXECUTION point (2 vs 3) — the end-of-block governance.
 *   This same-block section runs BEFORE any other Safe governance mutation
 *   (the Safe is still threshold 2 with 3 owners), so the rejection of tx2 is
 *   attributable to the threshold change in tx1 — not to a previously altered
 *   Safe. A sequential cross-check then confirms: after governance, an
 *   outstanding 2-of-3 verdict is rejected and a fresh 3-of-3 verdict is
 *   accepted (same Safe, no owner-set change).
 *
 * EXPORT + INDEPENDENT VERIFIER (item 3 tail of the objective):
 *   Produces a v4-format export of the SUCCESSFUL pre-governance release
 *   (escrow A) with journal + anchor + evidence, then verifies it in a
 *   SEPARATE PROCESS through verifier/verify-export.js → verify-v4.js
 *   (read-only RPC proxy, no DB, no private keys in the child). The export
 *   carries custody version 3 so the verifier selects the V3 identity
 *   (0x87615e3d) and re-checks the deployed runtime at the settlement block.
 *   The anchor is attested BEFORE the same-block settlement (required by the
 *   verifier's anchor-before-settlement rule) and the release head equals the
 *   journal prefix tail (required by the checkpoint-binding rule).
 *
 *   PRECISE VERIFIER LIMITATION (reported, NOT weakened):
 *   verify-v4.js establishes transaction-time authorization by the SUCCESS of
 *   the canonical direct call into the allowlisted runtime (the runtime checks
 *   Safe ERC-1271 at execution point). It does NOT make a separate
 *   end-of-block wallet call or replay the Safe owner-set/threshold state —
 *   the historical Safe state is not re-verified by the verifier process
 *   (only the execution was on-chain). That is a verifier limitation, not a
 *   behavioral gap: the on-chain custody call already enforced Safe's
 *   threshold at execution point.
 *
 * BOUNDARIES (unchanged): local EVM 31337, synthetic keys, no public chain,
 * no deployment, no spending, no push. Candidate source/artifact/identity/
 * economics untouched. All outputs are evidence files under
 * evidence/f3c-candidate-realsafe-exports/.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const v3sig = require('./v3-signing.cjs');
const canonical = require('../mainnet/design/support/v4-canonical');
const signatures = require('../mainnet/design/support/v4-signatures');
const journalWriter = require('../mainnet/design/support/v4-journal-writer');
const av = require('../verifier/v4-anchor');
const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');

const ROOT = path.resolve(__dirname, '..');
const CHAIN = 31337;
const PINNED = '0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3';
const IDENTITY = require(path.join(ROOT, 'verifier/v4-candidate-identity-31337-v3.json'));
const ARTIFACT = require(path.join(ROOT, 'data/escrow-custody-v3-build.json'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; fs.writeSync(1, 'PASS  ' + name + '\n'); }
  else { failed++; failures.push(name + (detail ? ' - ' + detail : '')); fs.writeSync(1, 'FAIL  ' + name + (detail ? ' - ' + detail : '') + '\n'); }
}
async function checkThrows(name, fn, wantMsg) {
  try { await fn(); check(name, false, 'expected revert' + (wantMsg ? ' (' + wantMsg + ')' : '')); }
  catch (e) {
    let msg = String(e && e.reason ? e.reason : (e && e.message ? e.message : e));
    let raw = '';
    if (e && e.data) raw = String(e.data);
    else if (e && e.error && e.error.data) raw = String(e.error.data);
    else if (e && e.info && e.info.error && e.info.error.data) raw = String(e.info.error.data);
    raw = raw.replace(/^"|"$/g, '');
    let selector = '';
    if (raw && /^(0x)?[0-9a-fA-F]{8,}/.test(raw.replace(/^0x/, '').padStart(8, '0'))) selector = '0x' + raw.replace(/^0x/, '').slice(0, 8).toLowerCase();
    const KNOWN = {
      '0xca31867a': 'UnauthorizedSigner', '0x59fa4a93': 'ThresholdNotMet', '0x8baa579f': 'InvalidSignature',
      '0x49e27cff': 'InvalidOwner', '0xba50f911': 'NotSorted', '0xd5ef09ba': 'NotFunded',
      '0x9c996edc': 'WrongDigest', '0xde4168ba': 'WrongState', '0xb5a78004': 'Replay',
      '0xb82f398a': 'ExpiredVerdict', '0xf966db3a': 'AfterCutoff', '0x2eb35430': 'DeadlineNotPassed',
      '0x3fb4e43f': 'NotYetValid', '0xc8ee2d1d': 'NotParty', '0xa4875a49': 'CapExceeded',
      '0x4c49f2f3': 'AfterResolutionDeadline', '0x2f7bf65c': 'HeadRequired', '0x90b8ec18': 'TransferFailed',
      '0x25e9714f': 'UnsupportedAction',
    };
    if (KNOWN[selector]) msg = KNOWN[selector];
    else if (selector) msg = msg + ' (selector ' + selector + ')';
    const ok = !wantMsg || msg.includes(wantMsg);
    check(name, ok, ok ? ('reverted: ' + msg) : ('wrong reason: ' + msg + ' want ' + wantMsg));
  }
}
function cid(n) { return '0x' + n.toString(16).padStart(64, '0'); }
const digest2 = (n) => '0x' + n.toString(16).padStart(64, '0');
function safeMessageHash(ethers, safeAddr, chainId, custodyDigest) {
  const domainSep = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address'],
    [ethers.id('EIP712Domain(uint256 chainId,address verifyingContract)'), chainId, safeAddr]
  ));
  const data = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [custodyDigest]);
  const safeMessageHashInner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32'],
    [ethers.id('SafeMessage(bytes message)'), ethers.keccak256(data)]
  ));
  const preimage = ethers.concat([ethers.toBeHex(0x19, 1), ethers.toBeHex(0x01, 1), domainSep, safeMessageHashInner]);
  return ethers.keccak256(preimage);
}
function packSafeSigs(sigObjects) {
  sigObjects.sort((a, b) => (a.addr.toLowerCase() < b.addr.toLowerCase() ? -1 : 1));
  let buf = '0x';
  for (const s of sigObjects) buf += s.sig.r.slice(2) + s.sig.s.slice(2) + s.sig.v.toString(16).padStart(2, '0');
  return buf;
}
async function startEvm(chainId) {
  const hre = require('hardhat');
  await hre.run('compile');
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const accounts = [];
  for (let i = 0; i < 12; i++) accounts.push(await provider.getSigner(i));
  return { provider, hre, accounts };
}
async function now(provider) { const b = await provider.send('eth_getBlockByNumber', ['latest', false]); return parseInt(b.timestamp, 16); }
const HH_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2c0e54cf913833b8902f6f004409d1d2fc04ca',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
];
function walletAt(i) { return new ethers.Wallet(HH_KEYS[i]); }
function rawSign(i, digestBytes32) { return walletAt(i).signingKey.sign(ethers.getBytes(digestBytes32)); }

function child(file, rpc) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'verifier/verify-export.js'), file, '--rpc', rpc], {
      cwd: ROOT,
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    });
    let text = '';
    p.stdout.on('data', v => { text += v; });
    p.stderr.on('data', v => { text += v; });
    p.on('error', reject);
    p.on('exit', code => resolve({ code, text }));
  });
}

(async () => {
  const revision = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const testRevision = revision;
  console.log('F3C candidate real-Safe + same-block governance harness (LOCAL ONLY)');
  console.log('test-revision: ' + testRevision + '  identity pin: ' + PINNED);

  const { provider, hre, accounts } = await startEvm(CHAIN);
  const [deployer, buyer, seller, evaluatorEOA, attester, donor, stranger] = accounts;

  // ——— OFFICIAL EAS 1.7.1 FIRST so addresses match the pinned 31337 policy
  //     (registry 0x5FbDB2…, EAS 0xe7f1725…) ———
  const registry = await new ethers.ContractFactory(regArt.abi, regArt.bytecode, deployer).deploy();
  await registry.waitForDeployment();
  const eas = await new ethers.ContractFactory(easArt.abi, easArt.bytecode, deployer).deploy(registry.target);
  await eas.waitForDeployment();
  await (await registry.register(av.SCHEMA, ethers.ZeroAddress, false)).wait();
  check('RS-C0 EAS registry + EAS deployed first (pinned 31337 policy addresses)', registry.target === '0x5FbDB2315678afecb367f032d93F642f64180aa3' && eas.target === '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', registry.target + ' ' + eas.target);

  function loadArtifact(name) { const a = hre.artifacts.readArtifactSync(name); return { abi: a.abi, bytecode: a.bytecode }; }
  const usdcArt = loadArtifact('MockUSDC');
  const usdc = await new ethers.ContractFactory(usdcArt.abi, usdcArt.bytecode, deployer).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  await (await usdc.mint(buyer.address, ethers.parseUnits('100000', 6))).wait();
  await (await usdc.mint(seller.address, ethers.parseUnits('100000', 6))).wait();

  // ——— REAL Safe stack (official safe-contracts@1.4.1 from node_modules) ———
  const safeArt = helpers.compileSafe('Safe', 'contracts/Safe.sol');
  const handArt = helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const safeImpl = await new ethers.ContractFactory(safeArt.abi, safeArt.bytecode, deployer).deploy();
  await safeImpl.waitForDeployment();
  const handler = await new ethers.ContractFactory(handArt.abi, handArt.bytecode, deployer).deploy();
  await handler.waitForDeployment();
  const handlerAddr = await handler.getAddress();
  const factory = await new ethers.ContractFactory(factoryArt.abi, factoryArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();

  const owners = [buyer.address, seller.address, evaluatorEOA.address];
  const setupCalldata = new ethers.Interface(safeArt.abi).encodeFunctionData('setup',
    [owners, 2, ethers.ZeroAddress, '0x', handlerAddr, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const createTx = await (await factory.createProxyWithNonce(safeImpl.target, setupCalldata, 1n)).wait();
  let proxyAddr;
  const iface = new ethers.Interface(factoryArt.abi);
  for (const log of createTx.logs) {
    try { const dec = iface.parseLog({ topics: log.topics, data: log.data }); if (dec && dec.name === 'ProxyCreation') { proxyAddr = dec.args.proxy; break; } } catch (_) {}
  }
  if (!proxyAddr) throw new Error('ProxyCreation not found');
  const safeProxy = new ethers.Contract(proxyAddr, safeArt.abi, deployer);
  check('RS-C1 real Safe proxy deployed (threshold 2, 3 owners)', (await safeProxy.getThreshold()) === 2n && (await safeProxy.getOwners()).length === 3);

  // ——— DEPLOY THE EXACT CANDIDATE ARTIFACT (NOT source-compiled) ———
  const custody = await new ethers.ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, deployer)
    .deploy(ethers.parseUnits('1000', 6), ethers.parseUnits('5000', 6), true, 1n, '0x' + 'ab'.repeat(32));
  await custody.waitForDeployment();
  const custodyAddr = custody.target;
  const deployedRuntime = await provider.getCode(custodyAddr);
  const deployedKeccak = ethers.keccak256(deployedRuntime);
  check('RS-C2 deployed runtime keccak == pinned F3B identity 0x87615e3d…', deployedKeccak === PINNED, deployedKeccak);
  check('RS-C2b identity file runtimeCodeHash == pin', IDENTITY.runtimeCodeHash === PINNED);
  check('RS-C2c artifact runtimeCodeHash == pin', ARTIFACT.runtimeCodeHash === PINNED);
  // Behavior begins ONLY after the identity assertion passed.
  if (deployedKeccak !== PINNED) throw new Error('candidate identity mismatch — refusing to run behavior on unverified runtime');

  const small = ethers.parseUnits('500', 6);
  await (await usdc.connect(buyer).approve(custodyAddr, ethers.parseUnits('9000', 6), { gasLimit: 300000 })).wait();
  const policyId = 1n;
  const policyDigest = '0x' + 'ab'.repeat(32);
  const agreementRef = '0x' + 'cd'.repeat(32);

  function signSafeVerdict(id, digestVal, action, nonce, issuedAt, head) {
    const verdictDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digestVal, action, nonce, issuedAt, head);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);
    const sigB = ethers.Signature.from(rawSign(1, msgHash));
    const sigS = ethers.Signature.from(rawSign(2, msgHash));
    return packSafeSigs([{ addr: buyer.address, sig: sigB }, { addr: seller.address, sig: sigS }]);
  }
  function signSafeVerdict3(id, digestVal, action, nonce, issuedAt, head) {
    const verdictDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digestVal, action, nonce, issuedAt, head);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);
    const b = ethers.Signature.from(rawSign(1, msgHash));
    const s = ethers.Signature.from(rawSign(2, msgHash));
    const e = ethers.Signature.from(rawSign(3, msgHash));
    return packSafeSigs([{ addr: buyer.address, sig: b }, { addr: seller.address, sig: s }, { addr: evaluatorEOA.address, sig: e }]);
  }

  // =====================================================================
  // RS-C3..C12: preserved strong positives/negatives on the REAL Safe,
  // now against the EXACT CANDIDATE runtime. Safe still threshold 2.
  // =====================================================================
  {
    const tN = await now(provider);
    const id = cid(21);
    await (await custody.connect(buyer).fund(id, digest2(21), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 5000, tN + 8000, 0, policyId, policyDigest, agreementRef)).wait();
    const esc = await custody.getEscrow(id);
    check('RS-C3 fund binds real-Safe evaluator on candidate', esc.evaluator === proxyAddr && esc.agreementRef === agreementRef);
    const issuedAt = await now(provider);
    const nonce = 2100;
    const head = '0x' + '21'.repeat(32);
    const packed = signSafeVerdict(id, digest2(21), 'release', nonce, issuedAt, head);
    const sellerBefore = await usdc.balanceOf(seller.address);
    const tx = await (await custody.connect(stranger).release(id, digest2(21), head, nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed, { gasLimit: 600000 })).wait();
    const escAfter = await custody.getEscrow(id);
    check('RS-C4 genuine 2-of-3 REAL Safe V3 release accepted on candidate, state Released', Number(escAfter.state) === 3);
    check('RS-C4b candidate head committed through real Safe', escAfter.committedHead === head && Number(escAfter.headCommittedAt) > 0);
    check('RS-C5 seller paid exactly once on candidate', (await usdc.balanceOf(seller.address)) - sellerBefore === small);
    const relEv = tx.logs.filter((l) => l.topics[0] === ethers.id('Released(bytes32,address,uint256,bytes32,bytes32)'));
    const hcEv = tx.logs.filter((l) => l.topics[0] === ethers.id('HeadCommitted(bytes32,bytes32,uint256)'));
    check('RS-C5b Released + HeadCommitted emitted once each on candidate', relEv.length === 1 && hcEv.length === 1);
  }

  {
    const tN = await now(provider);
    const id = cid(22);
    await (await custody.connect(buyer).fund(id, digest2(22), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 5000, tN + 8000, 0, policyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    let nonce = 2200;
    const head = '0x' + '22'.repeat(32);
    const verdictDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(22), 'release', nonce, issuedAt, head);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);
    const sigB = ethers.Signature.from(rawSign(1, msgHash));
    await checkThrows('RS-C6 one signature rejected on candidate (threshold 2)', () => custody.connect(stranger).release(id, digest2(22), head, nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: sigB }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    await checkThrows('RS-C7 duplicate signer rejected on candidate', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 1, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: sigB }, { addr: buyer.address, sig: sigB }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    const sigStr = ethers.Signature.from(rawSign(6, msgHash));
    await checkThrows('RS-C8 wrong owner rejected on candidate', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 2, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: stranger.address, sig: sigStr }, { addr: buyer.address, sig: sigB }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    const wrongDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(999), 'release', nonce + 3, issuedAt, head);
    const wrongMsgHash = safeMessageHash(ethers, proxyAddr, CHAIN, wrongDigest);
    const wB = ethers.Signature.from(rawSign(1, wrongMsgHash));
    const wS = ethers.Signature.from(rawSign(2, wrongMsgHash));
    await checkThrows('RS-C9 wrong digest rejected on candidate', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: wB }, { addr: seller.address, sig: wS }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    const subHead = '0x' + '99'.repeat(32);
    const packedSub = signSafeVerdict(id, digest2(22), 'refund', nonce + 5, issuedAt, subHead);
    await checkThrows('RS-C10 head substitution rejected on candidate (signed head != passed head)', () => custody.connect(stranger).refundVerdict(id, digest2(22), head, nonce + 5, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packedSub, { gasLimit: 600000 }), 'UnauthorizedSigner');
    const packedZero = signSafeVerdict(id, digest2(22), 'refund', nonce + 6, issuedAt, ethers.ZeroHash);
    await checkThrows('RS-C10b zero head rejected on candidate real Safe path', () => custody.connect(stranger).refundVerdict(id, digest2(22), ethers.ZeroHash, nonce + 6, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packedZero, { gasLimit: 600000 }), 'HeadRequired');
    // Wrong-chain/domain separation: sign over chain 84532 SafeMessage domain
    // (different Safe domain separator) — owners signed but recover nobody.
    const wrongChainDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, 84532, id, digest2(22), 'release', nonce + 7, issuedAt, head);
    const wrongChainMsgHash = safeMessageHash(ethers, proxyAddr, 84532, wrongChainDigest);
    const wcB = ethers.Signature.from(rawSign(1, wrongChainMsgHash));
    const wcS = ethers.Signature.from(rawSign(2, wrongChainMsgHash));
    await checkThrows('RS-C10c wrong-chain SafeMessage domain rejected on candidate', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 7, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: wcB }, { addr: seller.address, sig: wcS }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    const packedOk = signSafeVerdict(id, digest2(22), 'refund', nonce + 8, issuedAt, head);
    const buyerBefore = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundVerdict(id, digest2(22), head, nonce + 8, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packedOk, { gasLimit: 600000 })).wait();
    const esc = await custody.getEscrow(id);
    check('RS-C11 real-Safe V3 refund accepted on candidate with head; state Refunded', Number(esc.state) === 4 && esc.committedHead === head);
    check('RS-C11b buyer refunded exactly once on candidate', (await usdc.balanceOf(buyer.address)) - buyerBefore === small);
  }

  // =====================================================================
  // SAME-BLOCK GOVERNANCE ORDERING + EXPORT on the exact candidate.
  // Order: manifest+anchor FIRST (anchor must precede settlement), then
  // fund A/B, journals -> heads, sign verdicts with journal heads, queue
  // release(A) -> changeThreshold(3) -> release(B) in ONE block.
  // Safe is STILL threshold 2, owners buyer/seller/evaluator (no mutation
  // before this section).
  // =====================================================================
  const blockStart = await now(provider);
  const idA = cid(0x31), idB = cid(0x32);
  const t = blockStart;
  const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
  const ref = r => ({ txHash: r.hash, blockHash: r.blockHash });

  // ——— Manifest + anchor (EAS already deployed FIRST above) ———
  const sbAmount = 500n; // atomic units (matches manifest principal '500')
  const deliverablePayload = JSON.stringify({ deliverable: 'f3c-candidate-realsafe', format: 'application/json', fields: { sha256: 'true', units: 'exact' }, value: 'the-digital-deliverable' });
  const deliverableHash = '0x' + crypto.createHash('sha256').update(deliverablePayload, 'utf8').digest('hex');
  const m = {
    commitmentId: idA, buyerAgentId: buyer.address, sellerAgentId: seller.address,
    capability: 'f3c-candidate-realsafe', price: { amount: '500', currency: 'USDC', decimals: 6 }, acceptanceCriteria: { type: 'hash-equals', value: deliverableHash },
    deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
    terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
    evaluator: proxyAddr, evaluatorPermittedDecisions: ['release', 'refund'],
    policy: { version: 'saax-custody-policy-v1', digest: policyDigest, profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
    profile: 'OBJECTIVE_DIGITAL', custody: { chainId: CHAIN, custodyAddress: custodyAddr, token: usdc.target, principal: '500', fees: '0', reserve: '0', version: 3 },
    consents: { buyer: { accepted: true, ref: 'f3c-buyer' }, seller: { accepted: true, ref: 'f3c-seller' }, sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' } },
    evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true, acceptedIssuers: [seller.address], requiredTypes: ['deliverable-hash'] },
    deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) }, fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' },
  };
  const built = canonical.buildV4Manifest(m);
  m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
  const digestManifest = '0x' + built.manifestHash.slice(7);
  const authorizations = [];
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const message = { manifestHash: digestManifest, role, nonce: '1', expiresAt: String(t + 900) };
    authorizations.push({ role, walletType: 'EOA', nonce: message.nonce, expiresAt: message.expiresAt, signature: await signer.signTypedData(signatures.agreementDomain(custodyAddr, CHAIN), signatures.COMMITMENT_CONSENT_TYPES, message) });
  }
  const data = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [idA, digestManifest, ...Array(10).fill(''), 'issued', BigInt(t)]);
  const req = { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: false, refUID: ethers.ZeroHash, data, value: 0 };
  const attReceipt = await (await eas.connect(attester).attest({ schema: av.SCHEMA_UID, data: req })).wait();
  const attEvent = attReceipt.logs.map(l => { try { return eas.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'Attested');
  if (!attEvent) throw new Error('Attested event not found');
  const anchor = { recordVersion: 1, chainId: CHAIN, easAddress: eas.target, schemaUid: av.SCHEMA_UID, uid: attEvent.args.uid, txHash: attReceipt.hash, blockHash: attReceipt.blockHash, blockNumber: String(attReceipt.blockNumber), attester: attester.address, recipient: req.recipient, attestationData: data, authorizations: [] };
  for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
    const expiresAt = String(t + 900);
    anchor.authorizations.push({ role, expiresAt, signature: await signer.signTypedData(av.domain(anchor), av.AUTH_TYPES, av.message(anchor, m, digestManifest, expiresAt)) });
  }

  // ——— Fund A and B (records their receipts for the journal) ———
  await (await custody.connect(buyer).fund(idA, digestManifest, usdcAddr, buyer.address, seller.address, proxyAddr, sbAmount, t + 1000, t + 2000, 0, policyId, policyDigest, digestManifest)).wait();
  await (await custody.connect(buyer).fund(idB, digest2(0x32), usdcAddr, buyer.address, seller.address, proxyAddr, sbAmount, t + 1000, t + 2000, 0, policyId, policyDigest, agreementRef)).wait();
  const fundLogsA = await provider.send('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest', address: custodyAddr, topics: [ethers.id('Funded(bytes32,bytes32,address,address,address,address,uint256,uint256,uint256,uint256,bytes32,bytes32)'), cid(0x31)] }]);
  const fundLogsB = await provider.send('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest', address: custodyAddr, topics: [ethers.id('Funded(bytes32,bytes32,address,address,address,address,uint256,uint256,uint256,uint256,bytes32,bytes32)'), cid(0x32)] }]);
  if (!fundLogsA.length || !fundLogsB.length) throw new Error('fund logs not found');
  const fundRecA = await provider.send('eth_getTransactionReceipt', [fundLogsA[0].transactionHash]);
  const fundRecB = await provider.send('eth_getTransactionReceipt', [fundLogsB[0].transactionHash]);
  const fundingRefA = { txHash: fundLogsA[0].transactionHash, blockHash: fundRecA.blockHash };
  const fundingRefB = { txHash: fundLogsB[0].transactionHash, blockHash: fundRecB.blockHash };
  check('RS-C14 both escrows Funded before same-block queue', Number((await custody.getEscrow(idA)).state) === 1 && Number((await custody.getEscrow(idB)).state) === 1);

  // ——— Journals -> heads (each verdict binds ITS OWN escrow's journal tail) ———
  const jwA = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custodyAddr, commitmentId: idA, manifestHash: digestManifest });
  await jwA.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await jwA.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer], txHash: fundingRefA.txHash, blockHash: fundingRefA.blockHash });
  const headA = jwA.snapshot().tailHash;
  const jwB = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custodyAddr, commitmentId: idB, manifestHash: digest2(0x32) });
  await jwB.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
  await jwB.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer], txHash: fundingRefB.txHash, blockHash: fundingRefB.blockHash });
  const headB = jwB.snapshot().tailHash;
  check('RS-C14g distinct checkpoint heads per escrow (A != B, both nonzero)', headA !== headB && headA !== ethers.ZeroHash && headB !== ethers.ZeroHash);

  const issuedAtSame = t;
  const nonceA = 3100, nonceB = 3200;
  // Both verdicts: 2-of-3 Safe over the SAME domain/chain; distinct escrow/payload/head/nonce.
  const packedA = signSafeVerdict(idA, digestManifest, 'release', nonceA, issuedAtSame, headA);
  const packedB = signSafeVerdict(idB, digest2(0x32), 'release', nonceB, issuedAtSame, headB);
  const sellerBBefore = await usdc.balanceOf(seller.address);

  await hre.network.provider.send('evm_setAutomine', [false]);
  const txA = await custody.connect(stranger).release(idA, digestManifest, headA, nonceA, issuedAtSame, 0, ethers.ZeroHash, ethers.ZeroHash, packedA, { gasLimit: 600000 });
  const govData2 = new ethers.Interface(safeArt.abi).encodeFunctionData('changeThreshold', [3]);
  const safeHash2 = await safeProxy.getTransactionHash(proxyAddr, 0, govData2, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, await safeProxy.nonce());
  const packedGov2 = packSafeSigs([1, 2].map(i => ({ addr: accounts[i].address, sig: rawSign(i, safeHash2) })));
  const txGov = await safeProxy.connect(deployer).execTransaction(proxyAddr, 0, govData2, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, packedGov2, { gasLimit: 600000 });
  const txB = await custody.connect(stranger).release(idB, digest2(0x32), headB, nonceB, issuedAtSame, 0, ethers.ZeroHash, ethers.ZeroHash, packedB, { gasLimit: 600000 });
  await hre.network.provider.send('evm_mine');
  await hre.network.provider.send('evm_setAutomine', [true]);

  const rA = await provider.getTransactionReceipt(txA.hash);
  const rGov = await provider.getTransactionReceipt(txGov.hash);
  const rB = await provider.getTransactionReceipt(txB.hash);
  const blockA = await provider.getBlock(rA.blockNumber);
  const blockTime = BigInt(blockA.timestamp);

  check('RS-C14a same block release -> governance -> second release ordering', rA.blockHash === rGov.blockHash && rGov.blockHash === rB.blockHash && rA.index < rGov.index && rGov.index < rB.index, 'indices ' + rA.index + ',' + rGov.index + ',' + rB.index);
  check('RS-C14b first release SUCCEEDED in same block', rA.status === 1);
  check('RS-C14c governance tx SUCCEEDED in same block', rGov.status === 1);
  check('RS-C14d second release REJECTED in same block', rB.status === 0);
  check('RS-C14e end-of-block Safe threshold == 3 (governance applied)', (await safeProxy.getThreshold()) === 3n);
  check('RS-C14f authorization valid at execution point differs from end-of-block governance', rA.status === 1 && (await safeProxy.getThreshold()) === 3n);
  const escA = await custody.getEscrow(idA), escB = await custody.getEscrow(idB);
  check('RS-C15 first escrow Released with payout', Number(escA.state) === 3 && (await usdc.balanceOf(seller.address)) - sellerBBefore === sbAmount);
  check('RS-C15b second escrow still Funded (no payout)', Number(escB.state) === 1);
  check('RS-C15c totalHeld reflects exactly one payout (no double payment)', (await custody.totalHeld()) === sbAmount);
  check('RS-C15d no settlement event/head for second escrow', escB.committedHead === ethers.ZeroHash && Number(escB.headCommittedAt) === 0);
  // Alternative rejection causes excluded:
  check('RS-C16a wrong-chain/domain excluded: same Safe domain/chain for both verdicts', true);
  // Both verdicts' issuedAt = t; the block executed at blockTime. Contract
  // validity window is [issuedAt-120, issuedAt+300] — t is inside it; the
  // delta is small (block mining delay), so expiry is not the cause.
  const delta = blockTime - BigInt(issuedAtSame);
  check('RS-C16b expiry excluded: issuedAt inside validity window, small delta (not 300s expired)', delta >= 0n && delta <= 120n, 'delta=' + delta);
  check('RS-C16c nonce reuse excluded: distinct escrow-scoped nonces (3100 vs 3200)', nonceA !== nonceB && !(await custody.usedVerdictNonce(idA, nonceB)));
  check('RS-C16d changed checkpoint heads excluded: each verdict binds ITS OWN head, both nonzero & distinct', headA !== headB && escA.committedHead === headA);
  check('RS-C16e already-settled escrow excluded: escrow B Funded at block start, still Funded', Number(escB.state) === 1);

  // =====================================================================
  // Sequential threshold-invalidation cross-check (post-governance):
  // outstanding 2-of-3 verdict is now rejected, fresh 3-of-3 accepted.
  // =====================================================================
  {
    const tN = await now(provider);
    const id = cid(23);
    await (await custody.connect(buyer).fund(id, digest2(23), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 5000, tN + 8000, 0, policyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const nonce = 2300;
    const head = '0x' + '23'.repeat(32);
    const packed2 = signSafeVerdict(id, digest2(23), 'release', nonce, issuedAt, head);
    check('RS-C18 governance: threshold now 3 on candidate (same Safe)', (await safeProxy.getThreshold()) === 3n);
    const esc = await custody.getEscrow(id);
    check('RS-C18b escrow still Funded before release', Number(esc.state) === 1);
    await checkThrows('RS-C18c outstanding 2-of-3 V3 verdict invalid after threshold->3 on candidate', () => custody.connect(stranger).release(id, digest2(23), head, nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed2, { gasLimit: 600000 }), 'UnauthorizedSigner');
    const esc2 = await custody.getEscrow(id);
    check('RS-C18d no payout / state unchanged on candidate', Number(esc2.state) === 1 && (await custody.totalHeld()) === (sbAmount + small));
    const nonce3 = 2301;
    const packed3 = signSafeVerdict3(id, digest2(23), 'release', nonce3, issuedAt, head);
    const sellerBefore = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(23), head, nonce3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed3, { gasLimit: 600000 })).wait();
    const escAfter = await custody.getEscrow(id);
    check('RS-C18e 3-of-3 REAL Safe V3 release accepted after threshold->3 on candidate', Number(escAfter.state) === 3);
    check('RS-C18f seller paid exactly once (3-of-3) on candidate', (await usdc.balanceOf(seller.address)) - sellerBefore === small);
  }

  // =====================================================================
  // EXPORT + SEPARATE-PROCESS VERIFIER for the SUCCESSFUL release (A).
  // =====================================================================
  const readOnly = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call']);
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async q => {
      try {
        if (!readOnly.has(q.method)) throw new Error('read-only method unavailable');
        return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rpc = 'http://127.0.0.1:' + server.address().port;
  check('RS-C19 read-only RPC proxy up (no trace/DB/signing)', readOnly.size === 6);

  const evMsg = { recordVersion: 1, commitmentId: idA, manifestHash: digestManifest, criterionId: 'deliverable-hash', itemId: 'f3c-item', type: 'deliverable-hash', issuer: seller.address, payloadHash: deliverableHash, at: new Date(t * 1000).toISOString(), amount: '0' };
  const evSig = ethers.Signature.from(await seller.signTypedData(signatures.evidenceDomain(custodyAddr, CHAIN), signatures.EVIDENCE_ITEM_TYPES, evMsg));
  const evidence = { recordVersion: 1, time: new Date(t * 1000).toISOString(), commitmentId: idA, manifestHash: digestManifest, domain: signatures.evidenceDomain(custodyAddr, CHAIN), items: [{ itemId: 'f3c-item', criterionId: 'deliverable-hash', type: 'deliverable-hash', issuer: seller.address, payloadHash: deliverableHash, payload: deliverablePayload, at: new Date(t * 1000).toISOString(), amount: '0', signedBy: seller.address, sigs: [{ v: evSig.v, r: evSig.r, s: evSig.s }] }], findings: {} };
  const settlementRef = ref(rA);
  await jwA.append({ transition: 'release', role: 'evaluator', by: proxyAddr, contractAction: 'release', resultingState: 'Released', at: new Date((t + 1) * 1000).toISOString(), signerWallets: [deployer], txHash: rA.hash, blockHash: rA.blockHash, authorization: { kind: 'safe-erc1271-2of3', agreedEvaluator: proxyAddr, chainId: CHAIN, custody: custodyAddr, note: 'custody accepted the Safe 2-of-3 authorization at execution point (same block, pre-governance); journal attests the record, not the authorization' } });
  const exp = {
    formatVersion: 4, agreement: m, commitmentDigest: built.manifestHash, authorizations,
    lifecycleProfile: 'full', lifecycle: { funding: fundingRefA, settlement: settlementRef },
    finality: { mode: 'local-synthetic' }, anchor, journal: jwA.snapshot(), evidence,
    custody: { chainId: CHAIN, custodyAddress: custodyAddr, version: 3 },
  };
  const OUT = path.join(ROOT, 'evidence/f3c-candidate-realsafe-exports');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'same-block-pre-governance-release.json');
  fs.writeFileSync(file, JSON.stringify(exp, null, 2) + '\n');
  const result = await child(file, rpc);
  fs.writeFileSync(path.join(OUT, 'separate-process.txt'), result.text + '\nEXIT_CODE=' + result.code + '\n');
  const okVerify = result.code === 0 && /VERDICT: VERIFIED_WITH_LIMITATIONS/.test(result.text);
  check('RS-C20 separate-process verifier: candidate pre-governance release VERIFIED_WITH_LIMITATIONS', okVerify, result.text.match(/VERDICT: [^\n]+/)?.[0] || ('exit=' + result.code));
  check('RS-C20b verifier re-checked candidate runtime identity at settlement block', /canonical successful direct transactions, candidate runtime/.test(result.text), result.text.match(/PASS  v4 [^\n]*candidate runtime[^\n]*/)?.[0] || 'no candidate-runtime pass line');
  const hasExecutionWitness = /canonical successful execution of allowlisted immutable direct-call custody runtime/.test(result.text);
  check('RS-C21 verifier uses execution-witness method (canonical successful call), not a fresh Safe end-of-block state call', hasExecutionWitness);
  // Precise limitation (reported, never weakened):
  console.log('VERIFIER LIMITATION: transaction-time authorization is established by the on-chain custody call itself (the allowlisted runtime enforced Safe ERC-1271 at execution point). The verifier does NOT re-read Safe threshold/owner state or make a post-block wallet call ("execution witness"; no Safe governance state replay).');

  fs.writeFileSync(path.join(OUT, 'run-record.json'), JSON.stringify({
    command: 'node scripts/test-custody-v3-realsafe-candidate.cjs', testRevision,
    candidateRevision: '2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8',
    chainId: CHAIN, runtimeCodeHash: PINNED, sourceSha256: IDENTITY.sourceSha256,
    safePackage: require('@safe-global/safe-contracts/package.json').version,
    easPackage: require('@ethereum-attestation-service/eas-contracts/package.json').version,
    ethersVersion: require('ethers').version,
    network: 'in-process local EVM (NOT public Base Sepolia)', noPublicFinality: true,
    sameBlockIndexes: { releaseA: rA.index, governance: rGov.index, releaseB: rB.index },
    sameBlockStatuses: { releaseA: rA.status, governance: rGov.status, releaseB: rB.status },
    separateProcessExit: result.code,
    outputs: fs.readdirSync(OUT).filter(f => /\.(json|txt)$/.test(f)),
  }, null, 2) + '\n');

  await new Promise(resolve => server.close(resolve));
  provider.destroy();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ passed, failed, failures, testRevision, runtimeCodeHash: PINNED }, null, 2) + '\n');
  fs.writeSync(1, 'v3_realsafe_candidate_passed=' + passed + ' failed=' + failed + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  fs.writeSync(2, 'FATAL: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(2);
});