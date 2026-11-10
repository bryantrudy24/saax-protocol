/**
 * SAAX Phase F3A — REAL SAFE integration test harness for CUSTODY V3.
 *
 * Validates the restricted OBJECTIVE_DIGITAL custody V3 candidate against the
 * ACTUAL Safe{Wallet} contracts (official @safe-global/safe-contracts@1.4.1,
 * LGPL-3.0) deployed into the LOCAL in-process EVM (chainId 31337), through
 * the custody contract's ERC-1271 hook. This proves the real-Safe
 * compatibility requirement of F3A — NOT mocks.
 *
 * PROVENANCE (recorded for the manifest):
 *   package          @safe-global/safe-contracts
 *   version          1.4.1
 *   license          LGPL-3.0
 *   homepage         https://github.com/safe-global/safe-contracts/
 *   Solidity safe    contracts/Safe.sol
 *   fallback handler contracts/handler/CompatibilityFallbackHandler.sol
 *   proxy            contracts/proxies/SafeProxy.sol
 *   factory          contracts/proxies/SafeProxyFactory.sol
 *
 * HOW REAL SAFE ERC-1271 WORKS (verified against sources):
 *   CustodyV3 calls proxy.isValidSignature(custodyV3Digest, sig).
 *   - SafeProxy fallback delegatecalls the singleton (Safe).
 *   - No isValidSignature on Safe -> falls through to CompatibilityFallbackHandler.
 *   - handler.isValidSignature(bytes32,bytes) wraps _data = abi.encode(custodyDigest)
 *     in Safe's SafeMessage EIP-712 envelope (Safe's own domain over chainId +
 *     verifyingContract=safe), then safe.checkSignatures -> checkNSignatures
 *     enforces the owner set + threshold (2-of-3 here) over the SafeMessage
 *     hash with packed {r}{s}{v} owner signatures in ASCENDING owner order.
 *
 * So the 2-of-3 owners sign the SafeMessage hash derived from the V3 custody
 * digest, NOT the raw custody digest. Threshold and owner changes are
 * performed through the REAL Safe governance path (execTransaction with owner
 * signatures), proving governance sensitivity of outstanding V3
 * authorizations.
 *
 * V3-specific coverage on top of the real Safe:
 *   - V3 6-field EscrowVerdict (with preSettlementHead) through real Safe
 *     2-of-3 → accepted, head committed on-chain.
 *   - One signature / duplicate / wrong owner / wrong digest / wrong domain /
 *     V2-5-field-typed signature → rejected through the real Safe.
 *   - Threshold change 2->3 invalidates an outstanding 2-of-3 V3 verdict;
 *     3-of-3 re-authorized and paid exactly once.
 *   - V3 head substitution through real Safe rejected.
 *   - Timeout refund with real-Safe evaluator: no checkpoint, pays buyer.
 *   - Mutual resolution unaffected (EOA parties) with head commitment.
 *   - Accounting/terminal exclusivity asserted on receipts/events/balances.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SAFE_DIR = path.join(ROOT, 'node_modules', '@safe-global', 'safe-contracts');
const v3sig = require('./v3-signing.cjs');
const { compileSafe, compileSource } = require('./test-custody-v2-realsafe.cjs');

function compileContract(name, sourcePath) {
  const solc = require('solc');
  const src = fs.readFileSync(path.join(ROOT, sourcePath), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [name]: { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) for (const e of out.errors) if (e.severity === 'error') throw new Error('compile error: ' + e.formattedMessage);
  const c = out.contracts[name][name];
  if (!c) throw new Error('no contract ' + name);
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

async function startEvm(chainId) {
  const hre = require('hardhat');
  await hre.run('compile');
  const { ethers } = await import('ethers');
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const accounts = [];
  for (let i = 0; i < 12; i++) accounts.push(await provider.getSigner(i));
  return { provider, signer: provider, ethers, hre, accounts };
}
function bumpTime(provider, seconds) { return provider.send('evm_increaseTime', [seconds]).then(() => provider.send('evm_mine', [])); }
async function now(provider) { const b = await provider.send('eth_getBlockByNumber', ['latest', false]); return parseInt(b.timestamp, 16); }

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; fs.writeSync(1, 'PASS  ' + name + '\n'); }
  else { failed++; failures.push(name + (detail ? ' - ' + detail : '')); fs.writeSync(1, 'FAIL  ' + name + (detail ? ' - ' + detail : '') + '\n'); }
}
let failures = [];
const KNOWN = {
  '0xca31867a': 'UnauthorizedSigner', '0x59fa4a93': 'ThresholdNotMet', '0x8baa579f': 'InvalidSignature',
  '0x49e27cff': 'InvalidOwner', '0xba50f911': 'NotSorted', '0xd5ef09ba': 'NotFunded',
  '0x9c996edc': 'WrongDigest', '0xde4168ba': 'WrongState', '0xb5a78004': 'Replay',
  '0xb82f398a': 'ExpiredVerdict', '0xf966db3a': 'AfterCutoff', '0x2eb35430': 'DeadlineNotPassed',
  '0x3fb4e43f': 'NotYetValid', '0xc8ee2d1d': 'NotParty', '0xa4875a49': 'CapExceeded',
  '0x4c49f2f3': 'AfterResolutionDeadline', '0x2f7bf65c': 'HeadRequired', '0x90b8ec18': 'TransferFailed',
  '0x25e9714f': 'UnsupportedAction',
};
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
    if (KNOWN[selector]) msg = KNOWN[selector];
    else if (selector) msg = msg + ' (selector ' + selector + ')';
    const ok = !wantMsg || msg.includes(wantMsg);
    check(name, ok, ok ? ('reverted: ' + msg) : ('wrong reason: ' + msg + ' want ' + wantMsg));
  }
}
function cid(n) { return '0x' + n.toString(16).padStart(64, '0'); }
const digest2 = (n) => '0x' + n.toString(16).padStart(64, '0');
const HEAD = (n) => '0x' + n.toString(16).padStart(64, '0');

// ——— Safe message hash + owner sig helpers (REAL Safe model) ———
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
const HH_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // 0 deployer
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // 1 buyer
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // 2 seller
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // 3 evaluatorEOA
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // 4 attester
  '0x8b3a350cf5c34c9194ca85829a2c0e54cf913833b8902f6f004409d1d2fc04ca', // 5 donor
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // 6 stranger
];
function walletAt(i, ethers) { return new ethers.Wallet(HH_KEYS[i]); }
function rawSign(ethers, i, digestBytes32) { return walletAt(i, ethers).signingKey.sign(ethers.getBytes(digestBytes32)); }
async function execSafeTx(ethers, safeProxy, deployer, to, data, ownerIndices) {
  const nonce = await safeProxy.nonce();
  const safeTxHash = await safeProxy.getTransactionHash(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
  const sigObjs = [];
  for (const oi of ownerIndices) {
    const sig = rawSign(ethers, oi, safeTxHash);
    sigObjs.push({ addr: walletAt(oi, ethers).address, sig });
  }
  const packed = packSafeSigs(sigObjs);
  const tx = await safeProxy.connect(deployer).execTransaction(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, packed, { gasLimit: 500000 });
  await tx.wait();
  return safeTxHash;
}

(async () => {
  const CHAIN = 31337;
  const { ethers, provider, hre, accounts } = await startEvm(CHAIN);
  const [deployer, buyer, seller, evaluatorEOA, attester, donor, stranger] = accounts;

  function loadArtifact(name) { const a = hre.artifacts.readArtifactSync(name); return { abi: a.abi, bytecode: a.bytecode }; }
  const usdcArt = loadArtifact('MockUSDC');
  const usdc = await new ethers.ContractFactory(usdcArt.abi, usdcArt.bytecode, deployer).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  await (await usdc.mint(buyer.address, ethers.parseUnits('100000', 6))).wait();
  await (await usdc.mint(seller.address, ethers.parseUnits('100000', 6))).wait();

  // ——— Compile + deploy REAL Safe stack (version-pinned 1.4.1 from node_modules) ———
  const safeArt = compileSafe('Safe', 'contracts/Safe.sol');
  const handArt = compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const safeImpl = await new ethers.ContractFactory(safeArt.abi, safeArt.bytecode, deployer).deploy();
  await safeImpl.waitForDeployment();
  const safeImplAddr = await safeImpl.getAddress();
  const handler = await new ethers.ContractFactory(handArt.abi, handArt.bytecode, deployer).deploy();
  await handler.waitForDeployment();
  const handlerAddr = await handler.getAddress();
  const factory = await new ethers.ContractFactory(factoryArt.abi, factoryArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();

  const owners = [buyer.address, seller.address, evaluatorEOA.address];
  const setupCalldata = new ethers.Interface(safeArt.abi).encodeFunctionData('setup',
    [owners, 2, ethers.ZeroAddress, '0x', handlerAddr, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const createTx = await (await factory.createProxyWithNonce(safeImplAddr, setupCalldata, 1n)).wait();
  let proxyAddr;
  const iface = new ethers.Interface(factoryArt.abi);
  for (const log of createTx.logs) {
    try { const dec = iface.parseLog({ topics: log.topics, data: log.data }); if (dec && dec.name === 'ProxyCreation') { proxyAddr = dec.args.proxy; break; } } catch (_) {}
  }
  if (!proxyAddr) throw new Error('ProxyCreation not found');
  const safeProxy = new ethers.Contract(proxyAddr, safeArt.abi, deployer);
  check('RS1 real Safe proxy deployed (threshold 2, 3 owners)', (await safeProxy.getThreshold()) === 2n && (await safeProxy.getOwners()).length === 3);

  // ——— Deploy custody V3 (evaluator = Safe PROXY) ———
  const V3 = new ethers.ContractFactory(compileContract('SAAXEscrowCustodyV3', 'contracts/SAAXEscrowCustodyV3.sol').abi, compileContract('SAAXEscrowCustodyV3', 'contracts/SAAXEscrowCustodyV3.sol').bytecode, deployer);
  const perPosCap = ethers.parseUnits('1000', 6);
  const aggCap = ethers.parseUnits('5000', 6);
  const policyId = 1n;
  const policyDigest = '0x' + 'ab'.repeat(32);
  const agreementRef = '0x' + 'cd'.repeat(32);
  const custody = await V3.deploy(perPosCap, aggCap, true, policyId, policyDigest);
  await custody.waitForDeployment();
  const custodyAddr = await custody.getAddress();
  const small = ethers.parseUnits('500', 6);
  await (await usdc.connect(buyer).approve(custodyAddr, ethers.parseUnits('9000', 6), { gasLimit: 300000 })).wait();

  async function signSafeVerdict(id, action, nonce, issuedAt, head) {
    const verdictDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(Number(BigInt(id))), action, nonce, issuedAt, head);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);
    const sigB = ethers.Signature.from(rawSign(ethers, 1, msgHash));
    const sigS = ethers.Signature.from(rawSign(ethers, 2, msgHash));
    return packSafeSigs([{ addr: buyer.address, sig: sigB }, { addr: seller.address, sig: sigS }]);
  }
  async function signSafeVerdict3(id, action, nonce, issuedAt, head) {
    const verdictDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(Number(BigInt(id))), action, nonce, issuedAt, head);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);
    const b = ethers.Signature.from(rawSign(ethers, 1, msgHash));
    const s = ethers.Signature.from(rawSign(ethers, 2, msgHash));
    const e = ethers.Signature.from(rawSign(ethers, 3, msgHash));
    return packSafeSigs([{ addr: buyer.address, sig: b }, { addr: seller.address, sig: s }, { addr: evaluatorEOA.address, sig: e }]);
  }

  // ——— RS2: genuine 2-of-3 REAL Safe V3 verdict (with head) accepted ———
  {
    const tN = await now(provider);
    const id = cid(21);
    await (await custody.connect(buyer).fund(id, digest2(21), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 5000, tN + 8000, 0, policyId, policyDigest, agreementRef)).wait();
    const esc = await custody.getEscrow(id);
    check('RS2 fund binds real-Safe evaluator', esc.evaluator === proxyAddr && esc.agreementRef === agreementRef);
    const issuedAt = await now(provider);
    const nonce = 2100;
    const head = HEAD(0x21);
    const packed = await signSafeVerdict(id, 'release', nonce, issuedAt, head);
    const sellerBefore = await usdc.balanceOf(seller.address);
    const tx = await (await custody.connect(stranger).release(id, digest2(21), head, nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed, { gasLimit: 600000 })).wait();
    const escAfter = await custody.getEscrow(id);
    check('RS3 genuine 2-of-3 REAL Safe V3 release accepted, state Released', Number(escAfter.state) === 3);
    check('RS3b V3 head committed through real Safe', escAfter.committedHead === head && Number(escAfter.headCommittedAt) > 0);
    check('RS4 seller paid exactly once through REAL Safe', (await usdc.balanceOf(seller.address)) - sellerBefore === small);
    const relEv = tx.logs.filter((l) => l.topics[0] === ethers.id('Released(bytes32,address,uint256,bytes32,bytes32)'));
    const hcEv = tx.logs.filter((l) => l.topics[0] === ethers.id('HeadCommitted(bytes32,bytes32,uint256)'));
    check('RS5 Released + HeadCommitted emitted once each', relEv.length === 1 && hcEv.length === 1);
  }

  // ——— RS-strong negatives through the REAL Safe ———
  {
    const tN = await now(provider);
    const id = cid(22);
    await (await custody.connect(buyer).fund(id, digest2(22), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 5000, tN + 8000, 0, policyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    let nonce = 2200;
    const head = HEAD(0x22);
    const verdictDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(22), 'release', nonce, issuedAt, head);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);

    // ONE signature
    const sigB = ethers.Signature.from(rawSign(ethers, 1, msgHash));
    await checkThrows('RS6 one signature rejected (threshold 2)', () => custody.connect(stranger).release(id, digest2(22), head, nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: sigB }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    // Duplicate signer
    await checkThrows('RS7 duplicate signer rejected', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 1, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: sigB }, { addr: buyer.address, sig: sigB }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    // Wrong owner (stranger)
    const sigStr = ethers.Signature.from(rawSign(ethers, 6, msgHash));
    await checkThrows('RS8 wrong owner rejected', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 2, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: stranger.address, sig: sigStr }, { addr: buyer.address, sig: sigB }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    // Wrong digest signed
    const wrongDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(999), 'release', nonce + 3, issuedAt, head);
    const wrongMsgHash = safeMessageHash(ethers, proxyAddr, CHAIN, wrongDigest);
    const wB = ethers.Signature.from(rawSign(ethers, 1, wrongMsgHash));
    const wS = ethers.Signature.from(rawSign(ethers, 2, wrongMsgHash));
    await checkThrows('RS9 wrong digest rejected', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: wB }, { addr: seller.address, sig: wS }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    // V2 5-field type signed under V3 address — must NOT validate (version separation through real Safe)
    const v2SigB = ethers.Signature.from(await buyer.signTypedData(
      { name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr },
      { EscrowVerdict: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
      { commitmentId: id, commitmentDigest: digest2(22), action: 'release', nonce: nonce + 4, issuedAt }
    ));
    const v2SigS = ethers.Signature.from(await seller.signTypedData(
      { name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr },
      { EscrowVerdict: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
      { commitmentId: id, commitmentDigest: digest2(22), action: 'release', nonce: nonce + 4, issuedAt }
    ));
    // Hand those raw custody-domain signatures as the Safe container (they were
    // signed over the raw custody digest, not the SafeMessage hash) — the Safe
    // checkSignatures will recover different owners -> rejected.
    await checkThrows('RS10 V2-era/raw-domain signatures rejected on V3 real Safe', () => custody.connect(stranger).release(id, digest2(22), head, nonce + 4, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packSafeSigs([{ addr: buyer.address, sig: v2SigB }, { addr: seller.address, sig: v2SigS }]), { gasLimit: 600000 }), 'UnauthorizedSigner');
    // Head substitution: signatures over head 0x22, pass head 0x99
    const subHead = HEAD(0x99);
    const packedSub = await signSafeVerdict(id, 'refund', nonce + 5, issuedAt, subHead); // signed over 0x99
    await checkThrows('RS11 V3 head substitution rejected (signed head != passed head)', () => custody.connect(stranger).refundVerdict(id, digest2(22), HEAD(0x22), nonce + 5, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packedSub, { gasLimit: 600000 }), 'UnauthorizedSigner');
    // zero head
    const packedZero = await signSafeVerdict(id, 'refund', nonce + 6, issuedAt, ethers.ZeroHash);
    await checkThrows('RS11b zero head rejected on real Safe path', () => custody.connect(stranger).refundVerdict(id, digest2(22), ethers.ZeroHash, nonce + 6, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packedZero, { gasLimit: 600000 }), 'HeadRequired');
    // settle via valid refund (head 0x22, nonce 2207)
    const packedOk = await signSafeVerdict(id, 'refund', nonce + 7, issuedAt, head);
    const buyerBefore = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundVerdict(id, digest2(22), head, nonce + 7, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packedOk, { gasLimit: 600000 })).wait();
    const esc = await custody.getEscrow(id);
    check('RS12 real-Safe V3 refund accepted with head; state Refunded', Number(esc.state) === 4 && esc.committedHead === head);
    check('RS12b buyer refunded exactly once', (await usdc.balanceOf(buyer.address)) - buyerBefore === small);
  }

  // ——— Governance: threshold change invalidates outstanding V3 authorization ———
  {
    const tN = await now(provider);
    const id = cid(23);
    await (await custody.connect(buyer).fund(id, digest2(23), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 5000, tN + 8000, 0, policyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const nonce = 2300;
    const head = HEAD(0x23);
    const verdictDigest = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(23), 'release', nonce, issuedAt, head);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);
    const sigB = ethers.Signature.from(rawSign(ethers, 1, msgHash));
    const sigS = ethers.Signature.from(rawSign(ethers, 2, msgHash));
    const packed2 = packSafeSigs([{ addr: buyer.address, sig: sigB }, { addr: seller.address, sig: sigS }]);

    const govData = new ethers.Interface(safeArt.abi).encodeFunctionData('addOwnerWithThreshold', [stranger.address, 3]);
    await execSafeTx(ethers, safeProxy, deployer, proxyAddr, govData, [1, 2]);
    check('RS13 governance: threshold now 3 on real Safe', (await safeProxy.getThreshold()) === 3n);
    const esc = await custody.getEscrow(id);
    check('RS14 escrow still Funded before release', Number(esc.state) === 1);
    await checkThrows('RS15 outstanding 2-of-3 V3 verdict becomes invalid after threshold->3', () => custody.connect(stranger).release(id, digest2(23), head, nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed2, { gasLimit: 600000 }), 'UnauthorizedSigner');
    const esc2 = await custody.getEscrow(id);
    check('RS16 no payout / state unchanged', Number(esc2.state) === 1 && (await custody.totalHeld()) === small);

    const nonce3 = 2301;
    const packed3 = await signSafeVerdict3(id, 'release', nonce3, issuedAt, head);
    const sellerBefore = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(23), head, nonce3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed3, { gasLimit: 600000 })).wait();
    const escAfter = await custody.getEscrow(id);
    check('RS17 3-of-3 REAL Safe V3 release accepted after threshold->3', Number(escAfter.state) === 3);
    check('RS17b seller paid exactly once (3-of-3)', (await usdc.balanceOf(seller.address)) - sellerBefore === small);
  }

  // ——— Timeout with a real-Safe evaluator: no checkpoint, no operator ———
  {
    const tN = await now(provider);
    const id = cid(24);
    await (await custody.connect(buyer).fund(id, digest2(24), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 20, tN + 20, 0, policyId, policyDigest, agreementRef)).wait(); // RDL==CUT
    // signature signed but execution skipped — timeout still pays buyer
    await provider.send('evm_setNextBlockTimestamp', [tN + 21]);
    const before = await usdc.balanceOf(buyer.address);
    // avoid estimateGas clearing setNext: pass explicit gas
    const tx = await (await custody.connect(stranger).refundTimeout(id, digest2(24), { gasLimit: 600000 })).wait();
    const esc = await custody.getEscrow(id);
    check('RS18 timeout refund through real-Safe escrow: no checkpoint/signature', Number(esc.state) === 4 && (await usdc.balanceOf(buyer.address)) - before === small);
    check('RS18b timeout records NO head on real-Safe escrow', esc.committedHead === ethers.ZeroHash && Number(esc.headCommittedAt) === 0);
  }

  // ——— Mutual through real-Safe escrow (EOA parties) ———
  {
    const tN = await now(provider);
    const id = cid(25);
    await (await custody.connect(buyer).fund(id, digest2(25), usdcAddr, buyer.address, seller.address, proxyAddr, small, tN + 5000, tN + 8000, 0, policyId, policyDigest, agreementRef)).wait();
    const ia = await now(provider);
    const head = HEAD(0x25);
    const bSig = await v3sig.v3SignMutual(ethers, buyer, custodyAddr, CHAIN, id, digest2(25), 'refund', 2500, ia, head);
    const sSig = await v3sig.v3SignMutual(ethers, seller, custodyAddr, CHAIN, id, digest2(25), 'refund', 2500, ia, head);
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).mutualRefund(id, digest2(25), head, 2500, ia, bSig.v, bSig.r, bSig.s, sSig.v, sSig.r, sSig.s, { gasLimit: 600000 })).wait();
    const esc = await custody.getEscrow(id);
    check('RS19 mutual refund on real-Safe escrow commits head', Number(esc.state) === 4 && esc.committedHead === head);
    check('RS19b buyer refunded exactly once', (await usdc.balanceOf(buyer.address)) - before === small);
  }

  fs.writeSync(1, 'v3_realsafe_passed=' + passed + ' failed=' + failed + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  fs.writeSync(2, 'FATAL: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(2);
});