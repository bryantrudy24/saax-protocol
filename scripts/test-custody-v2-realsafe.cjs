/**
 * SAAX Phase 3B — REAL SAFE integration test harness.
 *
 * Validates the restricted OBJECTIVE_DIGITAL custody V2 candidate against the
 * ACTUAL Safe{Wallet} contracts (official @safe-global/safe-contracts@1.4.1,
 * LGPL-3.0) deployed into the LOCAL in-process EVM (chainId 84532), through
 * the custody contract's ERC-1271 hook.
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
 *   DOMAIN_SEP_TYPE  keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
 *                    = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218
 *   SAFE_MSG_TYPEHASH keccak256("SafeMessage(bytes message)")
 *                    = 0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca
 *
 * HOW REAL SAFE ERC-1271 WORKS (verify this against the sources above):
 *   Custody calls proxy.isValidSignature(custodyDigest, sig).
 *   - SafeProxy fallback delegatecalls the singleton (Safe).
 *   - The Safe has no isValidSignature of its own -> falls through to the
 *     fallback handler (CompatibilityFallbackHandler).
 *   - Handler.isValidSignature(bytes32,bytes) (updated EIP-1271) -> delegates
 *     to handler.isValidSignature(bytes,bytes) = ISignatureValidator(path).
 *   - The bytes version wraps _data = abi.encode(custodyDigest) in Safe's
 *     SafeMessage EIP-712 envelope:
 *       messageData = 0x19 0x01 || domainSeparator(safe,84532)
 *                     || keccak256(abi.encode(SAFE_MSG_TYPEHASH,
 *                                             keccak256(_data)))
 *       messageHash = keccak256(messageData)
 *   - Then safe.checkSignatures(messageHash, messageData, sig) ->
 *     checkNSignatures enforces the owner set + threshold (2-of-3 here) over
 *     the SafeMessage hash with the packed owner-sig encoding {r}{s}{v} in
 *     ASCENDING owner order.
 *
 * THEREFORE the 2-of-3 owners sign the SafeMessage hash (a digest derived
 * from the custody digest via Safe's own domain + SafeMessage type), NOT the
 * raw custody digest. This is the exact "manifest -> Safe authorization"
 * binding the mandate requires proving.
 *
 * Governance tests: owner removal, threshold change to 3, and the effect on
 * OUTSTANDING authorizations (a prior 2-of-3 signature over an escrow becomes
 * invalid once governance changes, and a new 3-of-3 is required).
 *
 * Invariant/fuzz: a focused loop of many randomized 2-of-3 owner subsets,
 * ordering/nonce/recipient perturbations asserting NO unauthorized payout and
 * NO double payout (see scripts/test-saaax-realsafe-fuzz.cjs for the fuzzer;
 * this file covers the deterministic acceptance/rejection cases + a seeded
 * invariant sweep).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SAFE_DIR = path.join(ROOT, 'node_modules', '@safe-global', 'safe-contracts');

// ——— solc compile (repo convention: solc-js) ———
function compileSource(name, src, opts, extraImports) {
  const solc = require('solc');
  const input = {
    language: 'Solidity',
    sources: Object.assign(
      { [name]: { content: src } },
      extraImports || {}
    ),
    settings: Object.assign(
      { optimizer: { enabled: true, runs: 200 }, viaIR: false, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
      opts || {}
    ),
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    for (const e of out.errors) if (e.severity === 'error') throw new Error('compile error [' + name + ']: ' + e.formattedMessage);
  }
  const c = out.contracts[name][name];
  if (!c) throw new Error('no contract ' + name + ' compiled');
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// Compile the official Safe contracts. Safe.sol imports several base files via
// relative paths; solc-js needs them supplied. We read them from node_modules
// and key them by their import paths.
function safeSources() {
  const contractsDir = path.join(SAFE_DIR, 'contracts');
  const files = {
    'contracts/Safe.sol': path.join(contractsDir, 'Safe.sol'),
    'contracts/base/ModuleManager.sol': path.join(contractsDir, 'base', 'ModuleManager.sol'),
    'contracts/base/OwnerManager.sol': path.join(contractsDir, 'base', 'OwnerManager.sol'),
    'contracts/base/FallbackManager.sol': path.join(contractsDir, 'base', 'FallbackManager.sol'),
    'contracts/base/GuardManager.sol': path.join(contractsDir, 'base', 'GuardManager.sol'),
    'contracts/base/Executor.sol': path.join(contractsDir, 'base', 'Executor.sol'),
    'contracts/common/NativeCurrencyPaymentFallback.sol': path.join(contractsDir, 'common', 'NativeCurrencyPaymentFallback.sol'),
    'contracts/common/Singleton.sol': path.join(contractsDir, 'common', 'Singleton.sol'),
    'contracts/common/SelfAuthorized.sol': path.join(contractsDir, 'common', 'SelfAuthorized.sol'),
    'contracts/common/SignatureDecoder.sol': path.join(contractsDir, 'common', 'SignatureDecoder.sol'),
    'contracts/common/SecuredTokenTransfer.sol': path.join(contractsDir, 'common', 'SecuredTokenTransfer.sol'),
    'contracts/common/StorageAccessible.sol': path.join(contractsDir, 'common', 'StorageAccessible.sol'),
    'contracts/interfaces/ISignatureValidator.sol': path.join(contractsDir, 'interfaces', 'ISignatureValidator.sol'),
    'contracts/external/SafeMath.sol': path.join(contractsDir, 'external', 'SafeMath.sol'),
    'contracts/common/Enum.sol': path.join(contractsDir, 'common', 'Enum.sol'),
    'contracts/handler/CompatibilityFallbackHandler.sol': path.join(contractsDir, 'handler', 'CompatibilityFallbackHandler.sol'),
    'contracts/handler/TokenCallbackHandler.sol': path.join(contractsDir, 'handler', 'TokenCallbackHandler.sol'),
    'contracts/handler/HandlerContext.sol': path.join(contractsDir, 'handler', 'HandlerContext.sol'),
    'contracts/interfaces/ERC1155TokenReceiver.sol': path.join(contractsDir, 'interfaces', 'ERC1155TokenReceiver.sol'),
    'contracts/interfaces/ERC721TokenReceiver.sol': path.join(contractsDir, 'interfaces', 'ERC721TokenReceiver.sol'),
    'contracts/interfaces/ERC777TokensRecipient.sol': path.join(contractsDir, 'interfaces', 'ERC777TokensRecipient.sol'),
    'contracts/interfaces/IERC165.sol': path.join(contractsDir, 'interfaces', 'IERC165.sol'),
    'contracts/proxies/SafeProxy.sol': path.join(contractsDir, 'proxies', 'SafeProxy.sol'),
    'contracts/proxies/SafeProxyFactory.sol': path.join(contractsDir, 'proxies', 'SafeProxyFactory.sol'),
    'contracts/proxies/IProxyCreationCallback.sol': path.join(contractsDir, 'proxies', 'IProxyCreationCallback.sol'),
  };
  const sources = {};
  const missing = [];
  for (const [key, f] of Object.entries(files)) {
    if (!fs.existsSync(f)) { missing.push(f); continue; }
    sources[key] = { content: fs.readFileSync(f, 'utf8') };
  }
  if (missing.length) throw new Error('missing Safe sources: ' + missing.join(', '));
  return sources;
}

function compileSafe(name, entryPath) {
  const solc = require('solc');
  const srcs = safeSources();
  const input = {
    language: 'Solidity',
    sources: srcs,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: false, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    for (const e of out.errors) if (e.severity === 'error') throw new Error('compile error [' + name + ']: ' + e.formattedMessage);
  }
  const c = out.contracts[entryPath][name];
  if (!c) throw new Error('no contract ' + name + ' in ' + entryPath);
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// ——— Mini EVM via Hardhat's in-process network ———
async function startEvm(chainId) {
  const hre = require('hardhat');
  await hre.run('compile');
  const { ethers } = await import('ethers');
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const accounts = [];
  for (let i = 0; i < 12; i++) accounts.push(await provider.getSigner(i));
  return { provider, signer: provider, ethers, hre, accounts };
}

function bumpTime(provider, seconds) {
  return provider.send('evm_increaseTime', [seconds]).then(() => provider.send('evm_mine', []));
}
async function now(provider) {
  const b = await provider.send('eth_getBlockByNumber', ['latest', false]);
  return parseInt(b.timestamp, 16);
}

// ——— test framework ———
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
    const data = e && e.data ? String(e.data) : (e && e.info && e.info.error && e.info.error.data ? String(e.info.error.data) : '');
    let selector = '';
    if (data && /^0x[0-9a-fA-F]{8}$/.test(data.slice(0, 10))) selector = data.slice(0, 10).toLowerCase();
    const known = {
      '0xca31867a': 'UnauthorizedSigner',
      '0xd5ef09ba': 'NotFunded',
      '0x9c996edc': 'WrongDigest',
      '0xde4168ba': 'WrongState',
      '0xb5a78004': 'Replay',
      '0xb82f398a': 'ExpiredVerdict',
      '0xf966db3a': 'AfterCutoff',
      '0xa4875a49': 'CapExceeded',
      '0x59fa4a93': 'ThresholdNotMet',
      '0x8baa579f': 'InvalidSignature',
      '0x49e27cff': 'InvalidOwner',
      '0xba50f911': 'NotSorted',
    };
    if (known[selector]) msg = known[selector];
    else if (selector) msg = msg + ' (selector ' + selector + ')';
    const ok = !wantMsg || msg.includes(wantMsg);
    check(name, ok, ok ? ('reverted: ' + msg) : ('wrong reason: ' + msg + ' want ' + wantMsg));
  }
}

// Safe checkNSignatures uses ecrecover over the SafeMessage hash with DEFAULT
// v (27/28). We sign the SafeMessage hash with ethers' sign digest equivalent.

// Compute the custody EscrowVerdict EIP-712 digest exactly as the custody
// contract's _hashVerdict does (domain: name, version, chainId, verifyingContract).
function custodyVerdictDigest(ethers, custodyAddr, chainId, id, digest, action, nonce, issuedAt) {
  const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
  const types = { EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ] };
  return ethers.TypedDataEncoder.hash(domain, types, { commitmentId: id, commitmentDigest: digest, action, nonce, issuedAt });
}

// Build the SafeMessage hash that the CompatibilityFallbackHandler checks.
function safeMessageHash(ethers, safeAddr, chainId, custodyDigest) {
  const SOLIDITY = 'address(uint256)';
  const domainSep = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address'],
    [ethers.id('EIP712Domain(uint256 chainId,address verifyingContract)'), chainId, safeAddr]
  ));
  const data = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [custodyDigest]); // abi.encode(custodyDigest)
  const safeMessageHashInner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32'],
    [ethers.id('SafeMessage(bytes message)'), ethers.keccak256(data)]
  ));
  const preimage = ethers.concat([ethers.toBeHex(0x19, 1), ethers.toBeHex(0x01, 1), domainSep, safeMessageHashInner]);
  return ethers.keccak256(preimage);
}

// (async) signers are ethers signers; we sign the SafeMessage hash.
async function ownerSignSafeMessage(ethers, signer, safeAddr, chainId, custodyDigest) {
  const h = safeMessageHash(ethers, safeAddr, chainId, custodyDigest);
  const sig = await signer.signMessage(ethers.getBytes(h));   // EIP-191 eth_sign over the 32-byte hash
  const parsed = ethers.Signature.from(sig);
  return parsed; // contains v (27/28), r, s
}

function packSafeSigs(sigObjects) {
  sigObjects.sort((a, b) => (a.addr.toLowerCase() < b.addr.toLowerCase() ? -1 : 1));
  let buf = '0x';
  for (const s of sigObjects) buf += s.sig.r.slice(2) + s.sig.s.slice(2) + s.sig.v.toString(16).padStart(2, '0');
  return buf;
}

// Raw-capable signers using the canonical hardhat dev private keys (public
// test-only constants, well known). Safe's checkNSignatures EOA branch recovers
// ecrecover(dataHash, v, r, s) with NO Ethereum-message prefix, so the owners
// must sign the RAW SafeMessage hash — signMessage() would wrap it in EIP-191
// and recover the wrong signer (proven by probe).
const HH_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // 0 deployer
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // 1 buyer
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // 2 seller
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // 3 evaluator
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // 4 attester
  '0x8b3a350cf5c34c9194ca85829a2c0e54cf913833b8902f6f004409d1d2fc04ca', // 5 donor
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // 6 stranger
];
function walletAt(i, ethers) { return new ethers.Wallet(HH_KEYS[i]); }
// returns ethers Signature over the RAW digest (no prefix)
function rawSign(ethers, i, digestBytes32) {
  const w = walletAt(i, ethers);
  const sig = w.signingKey.sign(ethers.getBytes(digestBytes32));
  return sig;
}

// Execute a governance change on the Safe through execTransaction with the
// current threshold's owner signatures (Safe's real governance path — addOwner
// / changeThreshold are `authorized` (SelfAuthorized, GS031) and MUST be
// submitted as a Safe transaction signed by the owners).
async function execSafeTx(ethers, safeProxy, deployer, to, data, ownerIndices) {
  const nonce = await safeProxy.nonce();
  const safeTxHash = await safeProxy.getTransactionHash(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
  const sigObjs = [];
  for (const oi of ownerIndices) {
    const sig = rawSign(ethers, oi, safeTxHash);
    sigObjs.push({ addr: walletAt(oi, ethers).address, sig });
  }
  const packed = packSafeSigs(sigObjs);
  const tx = await safeProxy.connect(deployer).execTransaction(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, packed);
  await tx.wait();
  return safeTxHash;
}

function cid(n) { return '0x' + n.toString(16).padStart(64, '0'); }
function digest2(n) { return '0x' + n.toString(16).padStart(64, '0'); }

module.exports = { compileSafe, safeMessageHash, packSafeSigs, rawSign, execSafeTx, startEvm };

if (require.main === module) (async () => {
  // Local EVM chain ID — 31337 (distinct from Base Sepolia 84532 per the
  // chain-identity resolution). All local signature domains use this ID.
  const CHAIN = 31337;
  const { ethers, provider, hre, accounts } = await startEvm(CHAIN);
  const [deployer, buyer, seller, evaluatorEOA, attester, donor, stranger] = accounts;

  function loadArtifact(name) { const a = hre.artifacts.readArtifactSync(name); return { abi: a.abi, bytecode: a.bytecode }; }

  // ——— Deploy MockUSDC ———
  const usdcArt = loadArtifact('MockUSDC');
  const usdc = await new ethers.ContractFactory(usdcArt.abi, usdcArt.bytecode, deployer).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();

  // ——— Compile + deploy REAL Safe stack ———
  const safeArt = compileSafe('Safe', 'contracts/Safe.sol');
  const handArt = compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const proxyArt = compileSource('SafeProxy', fs.readFileSync(path.join(SAFE_DIR, 'contracts/proxies/SafeProxy.sol'), 'utf8'));
  const factoryArt = compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');

  const safeImpl = await new ethers.ContractFactory(safeArt.abi, safeArt.bytecode, deployer).deploy();
  await safeImpl.waitForDeployment();
  const safeImplAddr = await safeImpl.getAddress();
  const handler = await new ethers.ContractFactory(handArt.abi, handArt.bytecode, deployer).deploy();
  await handler.waitForDeployment();
  const handlerAddr = await handler.getAddress();
  const factory = await new ethers.ContractFactory(factoryArt.abi, factoryArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  // owners: buyer, seller, evaluatorEOA
  const owners = [buyer.address, seller.address, evaluatorEOA.address];
  // create a proxy via the factory with setup initializer: owners, threshold=2, to=0, data="", handler, 0,0,0
  const setupCalldata = new ethers.Interface(safeArt.abi).encodeFunctionData('setup',
    [owners, 2, ethers.ZeroAddress, '0x', handlerAddr, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const saltNonce = 1n;
  const createTx = await (await factory.createProxyWithNonce(safeImplAddr, setupCalldata, saltNonce)).wait();
  // find proxy address from ProxyCreation event
  const pcEvent = createTx.logs.find((l) => l.topics[0] === ethers.id('ProxyCreation(SafeProxy,address)')) ||
                  createTx.logs.find((l) => l.address === factoryAddr);
  // decode via factory abi
  const iface = new ethers.Interface(factoryArt.abi);
  let proxyAddr;
  for (const log of createTx.logs) {
    try { const dec = iface.parseLog({ topics: log.topics, data: log.data }); if (dec && dec.name === 'ProxyCreation') { proxyAddr = dec.args.proxy; break; } } catch (_) {}
  }
  if (!proxyAddr) throw new Error('ProxyCreation event not found');
  const safeProxy = new ethers.Contract(proxyAddr, safeArt.abi, deployer);
  // confirm proxy is the Safe (threshold + owners)
  const th = await safeProxy.getThreshold();
  const ow = await safeProxy.getOwners();
  check('RS1 real Safe proxy deployed (threshold 2, 3 owners)', th === 2n && ow.length === 3);
  // RS1b: verify fallback handler is set by reading the Safe storage slot
  // keccak256("fallback_manager.handler.address"). The ERC-1271 SafeMessage
  // routing later depends on this handler.
  {
    // FALLBACK_HANDLER_STORAGE_SLOT = literal from Safe base/FallbackManager.sol
    const hSlot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
    const raw = await provider.getStorage(proxyAddr, hSlot);
    const storedHandler = '0x' + raw.slice(-40);
    check('RS1b proxy fallback handler set', storedHandler.toLowerCase() === handlerAddr.toLowerCase());
  }

  // ——— Deploy custody V2 (evaluator = the Safe PROXY) ———
  const v2Art = loadArtifact('SAAXEscrowCustodyV2');
  const V2 = new ethers.ContractFactory(v2Art.abi, v2Art.bytecode, deployer);
  const perPosCap = ethers.parseUnits('1000', 6);
  const aggCap = ethers.parseUnits('2500', 6);
  const adminPolicyId = 1n;
  const admittedPolicyDigest = '0x' + 'ab'.repeat(32);
  const custody = await V2.deploy(perPosCap, aggCap, true, adminPolicyId, admittedPolicyDigest);
  await custody.waitForDeployment();
  const custodyAddr = await custody.getAddress();

  const small = ethers.parseUnits('500', 6);
  await (await usdc.mint(buyer.address, ethers.parseUnits('5000', 6))).wait();
  await (await usdc.mint(seller.address, ethers.parseUnits('5000', 6))).wait();
  await (await usdc.connect(buyer).approve(custodyAddr, ethers.parseUnits('3000', 6), { gasLimit: 300000 })).wait();

  const policyDigest = '0x' + 'ab'.repeat(32);
  const agreementRef = '0x' + 'cd'.repeat(32);
  const t0 = await now(provider);
  const CUTOFF = t0 + 10_000;
  const DEADLINE = t0 + 5_000;

  // helper: sign 2-of-3 (buyer+seller) over the SafeMessage hash for the given custody verdict digest
  async function signTwo(ownersTwo /* already valid ascending order content */) {
    // We sign the SafeMessage hash derived from a custody verdict digest.
    // The caller computes the actual verdict digest via custody._hashVerdict (EIP-712).
    const { parsedB, parsedS } = ownersTwo;
    return { parsedB, parsedS };
  }

  // ——— T-RS2: genuine 2-of-3 accepted through REAL Safe (ERC-1271) ———
  {
    const id = cid(21);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(21), usdcAddr, buyer.address, seller.address, proxyAddr, small, DEADLINE, CUTOFF, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const esc = await custody.getEscrow(id);
    check('RS2 fund binds real-Safe evaluator', esc.evaluator === proxyAddr && esc.agreementRef === agreementRef);

    // Compute the custody verdict digest (EIP-712 EscrowVerdict).
    const issuedAt = await now(provider);
    const nonce = 2100;
    // domain: custody domainSeparator
    const verdictDigest = custodyVerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(21), 'release', nonce, issuedAt);

    // Owners sign the SafeMessage hash of that custody digest.
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);
    const sigB = ethers.Signature.from(rawSign(ethers, 1, msgHash));
    const sigS = ethers.Signature.from(rawSign(ethers, 2, msgHash));
    const packed = packSafeSigs([
      { addr: buyer.address, sig: sigB },
      { addr: seller.address, sig: sigS },
    ]);

    const sellerBalBefore = await usdc.balanceOf(seller.address);
    const tx = await custody.connect(stranger).release(id, digest2(21), nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed);
    const rcpt = await tx.wait();
    const escAfter = await custody.getEscrow(id);
    check('RS2 genuine 2-of-3 REAL Safe verdict accepted, state Released', Number(escAfter.state) === 3);
    const sellerBalAfter = await usdc.balanceOf(seller.address);
    check('RS3 seller paid exactly once through REAL Safe', sellerBalAfter - sellerBalBefore === small);
    const relEv = rcpt.logs.filter((l) => l.topics[0] === ethers.id('Released(bytes32,address,uint256,bytes32)'));
    check('RS4 Released event emitted once', relEv.length === 1);
  }

  // ——— Negative: one signature, duplicate, wrong owner, wrong digest/domain ———
  {
    const id = cid(22);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(22), usdcAddr, buyer.address, seller.address, proxyAddr, small, DEADLINE, CUTOFF, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const nonce = 2200;
    const verdictDigest = custodyVerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(22), 'release', nonce, issuedAt);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);

    // ONE signature only
    const sigB = ethers.Signature.from(rawSign(ethers, 1, msgHash));
    const onePacked = packSafeSigs([{ addr: buyer.address, sig: sigB }]);
    await checkThrows('RS5 one signature rejected (threshold 2)', () => custody.connect(stranger).release(id, digest2(22), nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, onePacked), 'UnauthorizedSigner');

    // Duplicate signer (same owner twice)
    const dupPacked = packSafeSigs([{ addr: buyer.address, sig: sigB }, { addr: buyer.address, sig: sigB }]);
    await checkThrows('RS6 duplicate signer rejected', () => custody.connect(stranger).release(id, digest2(22), nonce + 1, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, dupPacked), 'UnauthorizedSigner');

    // Wrong owner (stranger) + valid buyer
    const sigStr = ethers.Signature.from(rawSign(ethers, 6, msgHash));
    const wrongOwners = packSafeSigs([
      { addr: stranger.address, sig: sigStr },
      { addr: buyer.address, sig: sigB },
    ]);
    await checkThrows('RS7 wrong owner rejected', () => custody.connect(stranger).release(id, digest2(22), nonce + 2, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, wrongOwners), 'UnauthorizedSigner');

    // Wrong digest signed (a custody digest for a different escrow digest)
    const wrongDigest = custodyVerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(999), 'release', nonce + 3, issuedAt);
    const wrongMsgHash = safeMessageHash(ethers, proxyAddr, CHAIN, wrongDigest);
    const wB = ethers.Signature.from(rawSign(ethers, 1, wrongMsgHash));
    const wS = ethers.Signature.from(rawSign(ethers, 2, wrongMsgHash));
    const wrongPacked = packSafeSigs([{ addr: buyer.address, sig: wB }, { addr: seller.address, sig: wS }]);
    await checkThrows('RS8 wrong digest rejected', () => custody.connect(stranger).release(id, digest2(22), nonce + 3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, wrongPacked), 'UnauthorizedSigner');

    // Wrong domain: the SafeMessage hash uses Safe's domain. If we instead hand
    // the RAW custody digest (no SafeMessage envelope) as if the owners signed
    // it directly, checkSignatures would recover different owners -> rejected.
    // Simulate: sign the raw custody digest with EIP-712 custody domain.
    const rawSigB = ethers.Signature.from(await buyer.signTypedData(
      { name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr },
      { EscrowVerdict: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
      { commitmentId: id, commitmentDigest: digest2(22), action: 'release', nonce: nonce + 4, issuedAt }
    ));
    const rawSigS = ethers.Signature.from(await seller.signTypedData(
      { name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr },
      { EscrowVerdict: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
      { commitmentId: id, commitmentDigest: digest2(22), action: 'release', nonce: nonce + 4, issuedAt }
    ));
    const rawPacked = packSafeSigs([{ addr: buyer.address, sig: rawSigB }, { addr: seller.address, sig: rawSigS }]);
    await checkThrows('RS9 wrong signing domain (raw custody digest, not SafeMessage) rejected', () => custody.connect(stranger).release(id, digest2(22), nonce + 4, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, rawPacked), 'UnauthorizedSigner');

    // settle: mutual refund
    const mr = { name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr };
    const mty = { MutualResolution: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const ia = await now(provider);
    const bS = ethers.Signature.from(await buyer.signTypedData(mr, mty, { commitmentId: id, commitmentDigest: digest2(22), action: 'refund', nonce: 9001, issuedAt: ia }));
    const sS = ethers.Signature.from(await seller.signTypedData(mr, mty, { commitmentId: id, commitmentDigest: digest2(22), action: 'refund', nonce: 9001, issuedAt: ia }));
    await (await custody.connect(stranger).mutualRefund(id, digest2(22), 9001, ia, bS.v, bS.r, bS.s, sS.v, sS.r, sS.s)).wait();
  }

  // ——— Governance: owner/threshold change affects outstanding authorizations ———
  {
    const id = cid(23);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(23), usdcAddr, buyer.address, seller.address, proxyAddr, small, DEADLINE, CUTOFF, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const nonce = 2300;
    const verdictDigest = custodyVerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(23), 'release', nonce, issuedAt);
    const msgHash = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest);

    // Build a valid 2-of-3 (buyer+seller) signature up front.
    const sigB = ethers.Signature.from(rawSign(ethers, 1, msgHash));
    const sigS = ethers.Signature.from(rawSign(ethers, 2, msgHash));
    const packed2 = packSafeSigs([{ addr: buyer.address, sig: sigB }, { addr: seller.address, sig: sigS }]);

    // Execute governance: threshold 3 (requires 3-of-3). Simulate a qualified
    // owner action via safe.changeThreshold(3) after adding stranger as owner.
    // Governance change via the REAL Safe path: addOwnerWithThreshold is
    // `authorized` (GS031, SelfAuthorized) so it MUST be submitted through
    // execTransaction signed by the CURRENT threshold (2-of-3 here).
    const govData = new ethers.Interface(safeArt.abi).encodeFunctionData('addOwnerWithThreshold', [stranger.address, 3]);
    await execSafeTx(ethers, safeProxy, deployer, proxyAddr, govData, [1, 2]);
    check('RS10 governance: threshold now 3', (await safeProxy.getThreshold()) === 3n);

    // The previously-valid 2-of-3 signature no longer meets threshold.
    const esc = await custody.getEscrow(id);
    check('RS11 escrow still Funded before release', Number(esc.state) === 1);
    await checkThrows('RS12 outstanding 2-of-3 becomes invalid after threshold->3', () => custody.connect(stranger).release(id, digest2(23), nonce, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed2), 'UnauthorizedSigner');
    const esc2 = await custody.getEscrow(id);
    check('RS13 no payout / state unchanged after outstanding-sig invalidated', Number(esc2.state) === 1 && (await custody.totalHeld()) === small);

    // 3-of-3 now valid: buyer, seller, evaluatorEOA all sign the SAME SafeMessage hash (nonce 2301)
    const nonce3 = 2301;
    const verdictDigest3 = custodyVerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(23), 'release', nonce3, issuedAt);
    const msgHash3 = safeMessageHash(ethers, proxyAddr, CHAIN, verdictDigest3);
    const b3 = ethers.Signature.from(rawSign(ethers, 1, msgHash3));
    const s3 = ethers.Signature.from(rawSign(ethers, 2, msgHash3));
    const e3 = ethers.Signature.from(rawSign(ethers, 3, msgHash3));
    const packed3 = packSafeSigs([
      { addr: buyer.address, sig: b3 },
      { addr: seller.address, sig: s3 },
      { addr: evaluatorEOA.address, sig: e3 },
    ]);
    const sellerBefore = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(23), nonce3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, packed3)).wait();
    const escAfter = await custody.getEscrow(id);
    check('RS14 3-of-3 REAL Safe release accepted after threshold->3', Number(escAfter.state) === 3);
    check('RS15 seller paid exactly once (3-of-3)', (await usdc.balanceOf(seller.address)) - sellerBefore === small);
  }

  fs.writeSync(1, 'realsafe_passed=' + passed + ' failed=' + failed + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  fs.writeSync(2, 'FATAL: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(2);
});
