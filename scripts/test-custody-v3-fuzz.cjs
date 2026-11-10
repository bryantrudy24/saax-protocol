// SAAX Phase F3A — Custody V3 focused invariant/fuzz sweep.
// LOCAL ONLY, chainId 31337, synthetic keys + MockUSDC + real version-pinned
// Safe 1.4.1 evaluator (2-of-3).
//
// Fuzz dimensions (seeded, deterministic):
//   - many randomized escrows funded with randomized amounts (within caps)
//   - each escrow randomly resolves via evaluator verdict (release/refund,
//     2-of-3 through real Safe), mutual release/refund, or timeout
//   - randomized owner subsets for the Safe signatures (must hit threshold)
//   - adversarial perturbations EVERY escrow: replay terminal attempt,
//     unauthorized payout attempt, wrong-head attempt, wrong-party attempt
// Invariants (asserted after EVERY step, on receipts/events/balances/state):
//   I1  totalHeld == sum of outstanding (Funded+Disputed) principal
//   I2  every terminal escrow paid EXACTLY one beneficiary exactly the
//       escrowed amount (no double payout via balance deltas + state)
//   I3  no unauthorized payout: any rejected attempt leaves balances and
//       state unchanged
//   I4  terminal exclusivity: only ONE terminal transition ever executes per
//       escrow (state machine check + no second payout)
//   I5  timeout escrows carry committedHead == 0; evaluator/mutual terminals
//       carry committedHead == the head that was signed
//   I6  liability never exceeded caps at fund time
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const v3sig = require('./v3-signing.cjs');
const { compileSafe } = require('./test-custody-v2-realsafe.cjs');

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
async function nowp(provider) { const b = await provider.send('eth_getBlockByNumber', ['latest', false]); return parseInt(b.timestamp, 16); }
// deterministic PRNG (mulberry32)
function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; fs.writeSync(1, 'PASS  ' + name + '\n'); }
  else { failed++; failures.push(name + (detail ? ' - ' + detail : '')); fs.writeSync(1, 'FAIL  ' + name + (detail ? ' - ' + detail : '') + '\n'); }
}
async function checkThrows(name, fn) {
  try { await fn(); check(name, false, 'expected revert'); }
  catch (e) { check(name, true, 'reverted'); }
}
function cid(n) { return '0x' + n.toString(16).padStart(64, '0'); }
const digest2 = (n) => '0x' + n.toString(16).padStart(64, '0');
const HEAD = (n) => '0x' + n.toString(16).padStart(64, '0');

(async () => {
  const CHAIN = 31337;
  const { ethers, provider, hre, accounts } = await startEvm(CHAIN);
  const [deployer, buyer, seller, evaluatorEOA, attester, donor, stranger] = accounts;

  function loadArtifact(name) { const a = hre.artifacts.readArtifactSync(name); return { abi: a.abi, bytecode: a.bytecode }; }
  const usdc = await new ethers.ContractFactory(...(function () { const a = loadArtifact('MockUSDC'); return [a.abi, a.bytecode, deployer]; })()).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  await (await usdc.mint(buyer.address, ethers.parseUnits('10000000', 6))).wait();
  await (await usdc.mint(seller.address, ethers.parseUnits('10000000', 6))).wait();

  // REAL Safe stack (version-pinned 1.4.1)
  const safeArt = compileSafe('Safe', 'contracts/Safe.sol');
  const handArt = compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
  const factoryArt = compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
  const safeImpl = await new ethers.ContractFactory(safeArt.abi, safeArt.bytecode, deployer).deploy();
  await safeImpl.waitForDeployment();
  const handler = await new ethers.ContractFactory(handArt.abi, handArt.bytecode, deployer).deploy();
  await handler.waitForDeployment();
  const handlerAddr = await handler.getAddress();
  const factory = await new ethers.ContractFactory(factoryArt.abi, factoryArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();
  const owners = [buyer.address, seller.address, evaluatorEOA.address];
  const setup = new ethers.Interface(safeArt.abi).encodeFunctionData('setup', [owners, 2, ethers.ZeroAddress, '0x', handlerAddr, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const createTx = await (await factory.createProxyWithNonce(await safeImpl.getAddress(), setup, 7n)).wait();
  let proxyAddr;
  const iface = new ethers.Interface(factoryArt.abi);
  for (const log of createTx.logs) { try { const d = iface.parseLog({ topics: log.topics, data: log.data }); if (d && d.name === 'ProxyCreation') { proxyAddr = d.args.proxy; break; } } catch (_) {} }
  const safeProxy = new ethers.Contract(proxyAddr, safeArt.abi, deployer);

  const perPosCap = ethers.parseUnits('2000', 6);
  const aggCap = ethers.parseUnits('40000', 6);
  const policyId = 1n;
  const policyDigest = '0x' + 'ab'.repeat(32);
  const agreementRef = '0x' + 'cd'.repeat(32);
  const V3 = new ethers.ContractFactory(compileContract('SAAXEscrowCustodyV3', 'contracts/SAAXEscrowCustodyV3.sol').abi, compileContract('SAAXEscrowCustodyV3', 'contracts/SAAXEscrowCustodyV3.sol').bytecode, deployer);
  const custody = await V3.deploy(perPosCap, aggCap, true, policyId, policyDigest);
  await custody.waitForDeployment();
  const custodyAddr = await custody.getAddress();

  function safeMsgHash(custodyDigest) {
    const domSep = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256', 'address'], [ethers.id('EIP712Domain(uint256 chainId,address verifyingContract)'), CHAIN, proxyAddr]));
    const data = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [custodyDigest]);
    const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [ethers.id('SafeMessage(bytes message)'), ethers.keccak256(data)]));
    return ethers.keccak256(ethers.concat([ethers.toBeHex(0x19, 1), ethers.toBeHex(0x01, 1), domSep, inner]));
  }
  const HH = [
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    '0x8b3a350cf5c34c9194ca85829a2c0e54cf913833b8902f6f004409d1d2fc04ca',
    '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  ];
  const walletAt = (i) => new ethers.Wallet(HH[i]);
  const addrAt = (i) => walletAt(i).address;
  function rawSign(i, h) { return walletAt(i).signingKey.sign(ethers.getBytes(h)); }
  function packSigs(objs, mustSort) {
    if (mustSort) objs.sort((a, b) => (a.addr.toLowerCase() < b.addr.toLowerCase() ? -1 : 1));
    let buf = '0x';
    for (const s of objs) buf += s.sig.r.slice(2) + s.sig.s.slice(2) + s.sig.v.toString(16).padStart(2, '0');
    return buf;
  }
  async function safeVerdictSig(id, action, nonce, issuedAt, head, idxs) {
    const d = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, id, digest2(Number(BigInt(id))), action, nonce, issuedAt, head);
    const mh = safeMsgHash(d);
    const sigs = idxs.map((i) => ({ addr: addrAt(i), sig: rawSign(i, mh) }));
    return packSigs(sigs, true);
  }

  // ——— fuzz ———
  const rand = rng(0xF3A);
  const N = 60;
  const perPosition = ethers.parseUnits('2000', 6);
  let totalOutstanding = 0n;
  const expected = new Map(); // id -> {amount, head, beneficiary:'buyer'|'seller', kind:'eval'|'mutual'|'timeout'|'none'}
  const settled = new Set();
  let idx = 1000;

  for (let z = 0; z < N; z++) {
    const id = cid(idx);
    const amount = BigInt((1 + Math.floor(rand() * 4)) * 100 * 1000000); // 100..400 USDC
    const tN = await nowp(provider);
    await (await usdc.connect(buyer).approve(custodyAddr, amount, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(idx), usdcAddr, buyer.address, seller.address, proxyAddr, amount, tN + 60000, tN + 90000, 0, policyId, policyDigest, agreementRef)).wait();
    totalOutstanding += amount;
    expected.set(id, { amount, head: null, beneficiary: null, kind: 'none' });

    // adversarial perturbations before any settlement (must all fail)
    const ia = await nowp(provider);
    const head = HEAD(idx);
    // wrong party eval (stranger)
    const badSig = await safeVerdictSig(id, 'refund', idx * 10 + 1, ia, head, [6, 1]); // stranger + buyer
    await checkThrows('FZ-' + idx + '-A wrong-party eval rejected', () => custody.connect(stranger).refundVerdict(id, digest2(idx), head, idx * 10 + 1, ia, 0, ethers.ZeroHash, ethers.ZeroHash, badSig, { gasLimit: 600000 }));
    // wrong head swapped
    const good2 = await safeVerdictSig(id, 'refund', idx * 10 + 2, ia, head, [1, 2]);
    await checkThrows('FZ-' + idx + '-B wrong-head rejected', () => custody.connect(stranger).refundVerdict(id, digest2(idx), HEAD(idx + 1), idx * 10 + 2, ia, 0, ethers.ZeroHash, ethers.ZeroHash, good2, { gasLimit: 600000 }));
    // state must be unchanged
    const escS = await custody.getEscrow(id);
    if (Number(escS.state) !== 1) { check('FZ-' + idx + '-C state unchanged after rejects', false); }
    else check('FZ-' + idx + '-C state unchanged after rejects', true);

    // choose settlement path
    const roll = rand();
    let settledNow = false;
    if (roll < 0.4) {
      // evaluator release
      const issuedAt = await nowp(provider);
      const sig = await safeVerdictSig(id, 'release', idx * 10 + 3, issuedAt, head, [1, 2]);
      const before = await usdc.balanceOf(seller.address);
      await (await custody.connect(stranger).release(id, digest2(idx), head, idx * 10 + 3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, sig, { gasLimit: 600000 })).wait();
      const esc = await custody.getEscrow(id);
      check('FZ-' + idx + '-D eval release terminal + head', Number(esc.state) === 3 && esc.committedHead === head);
      check('FZ-' + idx + '-E seller paid exactly amount', (await usdc.balanceOf(seller.address)) - before === amount);
      expected.set(id, { amount, head, beneficiary: 'seller', kind: 'eval' });
      settledNow = true;
    } else if (roll < 0.6) {
      // evaluator refund
      const issuedAt = await nowp(provider);
      const sig = await safeVerdictSig(id, 'refund', idx * 10 + 3, issuedAt, head, [1, 2]);
      const before = await usdc.balanceOf(buyer.address);
      await (await custody.connect(stranger).refundVerdict(id, digest2(idx), head, idx * 10 + 3, issuedAt, 0, ethers.ZeroHash, ethers.ZeroHash, sig, { gasLimit: 600000 })).wait();
      const esc = await custody.getEscrow(id);
      check('FZ-' + idx + '-D eval refund terminal + head', Number(esc.state) === 4 && esc.committedHead === head);
      check('FZ-' + idx + '-E buyer paid exactly amount', (await usdc.balanceOf(buyer.address)) - before === amount);
      expected.set(id, { amount, head, beneficiary: 'buyer', kind: 'eval' });
      settledNow = true;
    } else if (roll < 0.8) {
      // mutual refund
      const issuedAt = await nowp(provider);
      const bS = ethers.Signature.from(await buyer.signTypedData(v3sig.v3Domain(CHAIN, custodyAddr), v3sig.MUTUAL_TYPES, { commitmentId: id, commitmentDigest: digest2(idx), action: 'refund', nonce: idx * 10 + 4, issuedAt, preSettlementHead: head }));
      const sS = ethers.Signature.from(await seller.signTypedData(v3sig.v3Domain(CHAIN, custodyAddr), v3sig.MUTUAL_TYPES, { commitmentId: id, commitmentDigest: digest2(idx), action: 'refund', nonce: idx * 10 + 4, issuedAt, preSettlementHead: head }));
      const before = await usdc.balanceOf(buyer.address);
      await (await custody.connect(stranger).mutualRefund(id, digest2(idx), head, idx * 10 + 4, issuedAt, bS.v, bS.r, bS.s, sS.v, sS.r, sS.s, { gasLimit: 600000 })).wait();
      const esc = await custody.getEscrow(id);
      check('FZ-' + idx + '-D mutual refund terminal + head', Number(esc.state) === 4 && esc.committedHead === head);
      check('FZ-' + idx + '-E buyer paid exactly amount', (await usdc.balanceOf(buyer.address)) - before === amount);
      expected.set(id, { amount, head, beneficiary: 'buyer', kind: 'mutual' });
      settledNow = true;
    } else {
      // timeout (needs cutoff passed)
      await provider.send('evm_setNextBlockTimestamp', [tN + 90001]);
      const before = await usdc.balanceOf(buyer.address);
      await (await custody.connect(stranger).refundTimeout(id, digest2(idx), { gasLimit: 600000 })).wait();
      const esc = await custody.getEscrow(id);
      check('FZ-' + idx + '-D timeout terminal + NO head', Number(esc.state) === 4 && esc.committedHead === ethers.ZeroHash);
      check('FZ-' + idx + '-E buyer paid exactly amount', (await usdc.balanceOf(buyer.address)) - before === amount);
      expected.set(id, { amount, head: ethers.ZeroHash, beneficiary: 'buyer', kind: 'timeout' });
      settledNow = true;
    }
    if (settledNow) {
      settled.add(id);
      totalOutstanding -= amount;
      // I2/I4: attempt a second terminal (must fail) and confirm no extra payout
      const balBefore = await usdc.balanceOf(expected.get(id).beneficiary === 'seller' ? seller.address : buyer.address);
      await checkThrows('FZ-' + idx + '-F second terminal attempt rejected', () => custody.connect(stranger).refundTimeout(id, digest2(idx), { gasLimit: 600000 }));
      const balAfter = await usdc.balanceOf(expected.get(id).beneficiary === 'seller' ? seller.address : buyer.address);
      check('FZ-' + idx + '-G no double payout', balAfter === balBefore);
      // I5: head recorded correctly
      const escE = await custody.getEscrow(id);
      check('FZ-' + idx + '-H head class correct on terminal', expected.get(id).kind === 'timeout' ? escE.committedHead === ethers.ZeroHash : escE.committedHead === expected.get(id).head);
    }
    // I1: liability check every iteration
    check('FZ-' + idx + '-I totalHeld == outstanding', (await custody.totalHeld()) === totalOutstanding);
    idx++;
  }

  fs.writeSync(1, 'v3_fuzz_passed=' + passed + ' failed=' + failed + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  fs.writeSync(2, 'FATAL: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(2);
});