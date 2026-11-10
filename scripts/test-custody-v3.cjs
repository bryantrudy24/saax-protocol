// SAAX Phase F3A — Restricted Objective-Digital Custody V3 test battery (EOA evaluator).
// LOCAL ONLY. In-process Hardhat EVM, chainId 31337 (distinct local identity per
// chain-identity resolution; never 84532). Synthetic keys (hardhat dev accounts),
// MockUSDC (6-decimal), no Safe mock here — the REAL Safe battery is
// scripts/test-custody-v3-realsafe.cjs. This battery focuses on the approved
// V3 rules with an EOA evaluator:
//   1. Pre-settlement-head commitment (head inside evaluator/mutual payload;
//      timeout needs NONE; checkpoint substitution invalidates).
//   2. Exact execution boundaries (fund/release/refund/resolve/mutual/timeout
//      through every time boundary — immediately before, at, and after).
//   3. Authorization validity (issuedAt future-skew + 300s expiry at execution).
//   4. Escrow-scoped nonces (replay across escrows impossible; class separation).
//   5. Preserved safeguards (wrong role/party/escrow/chain/custody/version,
//      caps, funding-disable with exits available, failed transfers, donations,
//      no double payout, terminal exclusivity).
// Asserts receipts, events, balances, and custody state — not tx hashes alone.
//
// Time discipline: every boundary block computes its OWN relative deadlines
// from the CURRENT block time (tN = now at block start), because earlier
// blocks advance the EVM clock with evm_increaseTime. Accounting discipline:
// a liability tracker (funded/settled maps) drives every totalHeld assertion,
// so aggregate-cap pressure from earlier unresolved escrows never falsifies a
// check; caps themselves are tested on a DEDICATED small-cap instance.
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const v3sig = require('./v3-signing.cjs');

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
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; fs.writeSync(1, 'PASS  ' + name + '\n'); }
  else { failed++; failures.push(name + (detail ? ' - ' + detail : '')); fs.writeSync(1, 'FAIL  ' + name + (detail ? ' - ' + detail : '') + '\n'); }
}
const KNOWN = {
  '0xca31867a': 'UnauthorizedSigner', '0x59fa4a93': 'ThresholdNotMet', '0x8baa579f': 'InvalidSignature',
  '0x49e27cff': 'InvalidOwner', '0xba50f911': 'NotSorted', '0xd5ef09ba': 'NotFunded',
  '0x9c996edc': 'WrongDigest', '0xde4168ba': 'WrongState', '0xb5a78004': 'Replay',
  '0xb82f398a': 'ExpiredVerdict', '0xf966db3a': 'AfterCutoff', '0x2eb35430': 'DeadlineNotPassed',
  '0x3fb4e43f': 'NotYetValid', '0xc8ee2d1d': 'NotParty', '0xa4875a49': 'CapExceeded',
  '0xab271ef4': 'PolicyNotAdmitted', '0x978a151c': 'FundingDisabled', '0xd06b96b1': 'InvalidPolicy',
  '0xc05e8c8c': 'InvalidAgreementRef', '0x4d9ecd91': 'SelfTransfer', '0x5cd5d233': 'BadSignature',
  '0x4c49f2f3': 'AfterResolutionDeadline', '0x2f7bf65c': 'HeadRequired', '0x90b8ec18': 'TransferFailed',
  '0x25e9714f': 'UnsupportedAction',
};
async function setNext(provider, ts) { await provider.send('evm_setNextBlockTimestamp', [ts]); }
const GAS = { gasLimit: 300000 };
async function checkThrows(name, fn, wantMsg) {
  try { await fn(); check(name, false, 'expected revert' + (wantMsg ? ' (' + wantMsg + ')' : '')); }
  catch (e) {
    let msg = String(e && e.reason ? e.reason : (e && e.message ? e.message : e));
    const data = e && e.data ? String(e.data) : (e && e.info && e.info.error && e.info.error.data ? String(e.info.error.data) : '');
    if (e && e.error && e.error.data) { const d = String(e.error.data); if (d.length >= 10) { /* pass through below */ } }
    let raw = '';
    if (e && e.data) raw = String(e.data);
    else if (e && e.error && e.error.data) raw = String(e.error.data);
    else if (e && e.info && e.info.error && e.info.error.data) raw = String(e.info.error.data);
    let selector = '';
    raw = raw.replace(/^"|"$/g, '');
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

(async () => {
  const CHAIN = 31337;
  const { ethers, provider, hre, accounts } = await startEvm(CHAIN);
  const [deployer, buyer, seller, evaluator, attester, donor, stranger, buyer2, seller2] = accounts;

  const usdcArt = compileContract('MockUSDC', 'contracts/mocks/MockUSDC.sol');
  const usdc = await new ethers.ContractFactory(usdcArt.abi, usdcArt.bytecode, deployer).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  // Fund synthetic accounts (local test double).
  await (await usdc.mint(buyer.address, ethers.parseUnits('1000000', 6))).wait();
  await (await usdc.mint(seller.address, ethers.parseUnits('1000000', 6))).wait();
  await (await usdc.mint(donor.address, ethers.parseUnits('1000000', 6))).wait();

  const v3Art = compileContract('SAAXEscrowCustodyV3', 'contracts/SAAXEscrowCustodyV3.sol');
  // Main behavioral instance: generous aggregate cap (per-position 1000 still enforced) so
  // earlier unresolved escrows never collide with the aggregate ceiling.
  const perPosCap = ethers.parseUnits('1000', 6);
  const aggCapBig = ethers.parseUnits('1000000', 6);
  const policyId = 1n;
  const policyDigest = '0x' + 'ab'.repeat(32);
  const agreementRef = '0x' + 'cd'.repeat(32);
  const custody = await new ethers.ContractFactory(v3Art.abi, v3Art.bytecode, deployer).deploy(perPosCap, aggCapBig, true, policyId, policyDigest);
  await custody.waitForDeployment();
  const custodyAddr = await custody.getAddress();
  const small = ethers.parseUnits('500', 6);

  // liability tracker
  const fundedAmt = new Map();   // commitmentId -> amount
  const settled = new Set();     // commitmentId
  const expectedLiability = () => { let s = 0n; for (const [k, v] of fundedAmt) if (!settled.has(k)) s += v; return s; };
  const markFunded = (id, amt) => fundedAmt.set(id, amt);
  const markSettled = (id) => settled.add(id);

  async function mkFund(id, over) {
    const o = over || {};
    const amount = o.amount || small;
    const args = {
      token: usdcAddr, buyer: buyer.address, seller: seller.address, evaluator: evaluator.address,
      amount, resolutionDeadline: RDL_DEFAULT, finalCutoff: CUT_DEFAULT, minReleaseTime: 0,
      policyId, policyDigest, agreementRef,
    };
    Object.assign(args, o);
    await (await usdc.connect(buyer).approve(custodyAddr, amount, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(Number(BigInt(id))), args.token, args.buyer, args.seller, args.evaluator, amount, args.resolutionDeadline, args.finalCutoff, args.minReleaseTime, args.policyId, args.policyDigest, args.agreementRef)).wait();
    markFunded(id, amount);
  }
  async function signVerdict(id, action, nonce, issuedAt, head, signer) {
    return v3sig.v3SignVerdict(ethers, signer || evaluator, custodyAddr, CHAIN, id, digest2(Number(BigInt(id))), action, nonce, issuedAt, head);
  }
  async function signMutual(id, action, nonce, issuedAt, head, bSigner, sSigner) {
    const b = await v3sig.v3SignMutual(ethers, bSigner || buyer, custodyAddr, CHAIN, id, digest2(Number(BigInt(id))), action, nonce, issuedAt, head);
    const s = await v3sig.v3SignMutual(ethers, sSigner || seller, custodyAddr, CHAIN, id, digest2(Number(BigInt(id))), action, nonce, issuedAt, head);
    return { b, s };
  }

  // Domain identity checks
  check('V3-A domain name/version distinct from V2', (await custody.DOMAIN_NAME()) === 'SAAX Escrow Custody V3' && (await custody.DOMAIN_VERSION()) === '3');
  check('V3-A2 custody version constant = 3', (await custody.CUSTODY_VERSION()) === 3n);
  check('V3-A3 candidate labeled pre-audit', (await custody.CANDIDATE_LABEL()) === 'pre-audit-candidate');
  check('V3-A4 chainId bound to 31337', Number(await custody.chainId()) === CHAIN);
  check('V3-A5 verdict typehash = 6-field with head', (await custody.VERDICT_TYPEHASH()) === v3sig.v3Typehash('EscrowVerdict', v3sig.VERDICT_TYPES.EscrowVerdict));
  check('V3-A6 mutual typehash = 6-field with head', (await custody.MUTUAL_TYPEHASH()) === v3sig.v3Typehash('MutualResolution', v3sig.MUTUAL_TYPES.MutualResolution));

  // Fresh relative default deadlines per top-level section:
  let RDL_DEFAULT = 0, CUT_DEFAULT = 0;

  // ===== 1. PRE-SETTLEMENT-HEAD COMMITMENT =====
  {
    let tN = await now(provider);
    RDL_DEFAULT = tN + 20000; CUT_DEFAULT = tN + 30000;
    const id = cid(101);
    await mkFund(id, { minReleaseTime: 0 });
    const ia = await now(provider);
    const head = HEAD(0xaa);
    const sig = await signVerdict(id, 'release', 101, ia, head);
    const before = await usdc.balanceOf(seller.address);
    const tx = await (await custody.connect(stranger).release(id, digest2(101), head, 101, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id);
    const esc = await custody.getEscrow(id);
    check('V3-1 evaluator release commits head on-chain', esc.committedHead === head && Number(esc.headCommittedAt) > 0);
    check('V3-1b seller paid exactly once', (await usdc.balanceOf(seller.address)) - before === small);
    const rel = tx.logs.filter((l) => l.topics[0] === ethers.id('Released(bytes32,address,uint256,bytes32,bytes32)'));
    const hc = tx.logs.filter((l) => l.topics[0] === ethers.id('HeadCommitted(bytes32,bytes32,uint256)'));
    check('V3-1c Released event carries head', rel.length === 1 && rel[0].data.includes(head.slice(2)));
    check('V3-1d HeadCommitted event emitted', hc.length === 1);
  }
  {
    const id = cid(102);
    await mkFund(id, { minReleaseTime: 0 });
    const ia = await now(provider);
    const head = HEAD(0xbb);
    const sig = await signVerdict(id, 'refund', 102, ia, head);
    const before = await usdc.balanceOf(buyer.address);
    const tx = await (await custody.connect(stranger).refundVerdict(id, digest2(102), head, 102, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id);
    const esc = await custody.getEscrow(id);
    check('V3-2 evaluator refund commits head on-chain', esc.committedHead === head && Number(esc.headCommittedAt) > 0);
    check('V3-2b buyer refunded exactly once', (await usdc.balanceOf(buyer.address)) - before === small);
    const rf = tx.logs.filter((l) => l.topics[0] === ethers.id('Refunded(bytes32,address,uint256,bytes32,bytes32)'));
    check('V3-2c Refunded event carries head', rf.length === 1 && rf[0].data.includes(head.slice(2)));
  }
  {
    const id = cid(103);
    await mkFund(id, { minReleaseTime: 0 });
    const ia = await now(provider);
    const head = HEAD(0xcc);
    const sig = await signVerdict(id, 'refund', 103, ia, head);
    // signer authorized head 0xcc; caller passes a DIFFERENT head 0xdd -> the
    // submitted (head, signature) pair must be rejected.
    await checkThrows('V3-3 checkpoint substitution invalidates authorization (different head)', () => custody.connect(stranger).refundVerdict(id, digest2(103), HEAD(0xdd), 103, ia, sig.v, sig.r, sig.s, '0x'), 'UnauthorizedSigner');
    await checkThrows('V3-3b zero head rejected (HeadRequired)', () => custody.connect(stranger).refundVerdict(id, digest2(103), '0x' + '00'.repeat(32), 103, ia, sig.v, sig.r, sig.s, '0x'), 'HeadRequired');
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundVerdict(id, digest2(103), head, 103, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id);
    check('V3-3c genuine head accepted after substitution attempts', (await usdc.balanceOf(buyer.address)) - before === small);
  }
  {
    const id = cid(104);
    await mkFund(id, { minReleaseTime: 0 });
    const ia = await now(provider);
    const head = HEAD(0xee);
    const m = await signMutual(id, 'refund', 104, ia, head);
    await (await custody.connect(stranger).mutualRefund(id, digest2(104), head, 104, ia, m.b.v, m.b.r, m.b.s, m.s.v, m.s.r, m.s.s)).wait();
    markSettled(id);
    const esc = await custody.getEscrow(id);
    check('V3-4 mutual refund commits the jointly-authorized head', esc.committedHead === head);
    const id2 = cid(105);
    await mkFund(id2, { minReleaseTime: 0 });
    const headB = HEAD(0x11);
    const bSig = await v3sig.v3SignMutual(ethers, buyer, custodyAddr, CHAIN, id2, digest2(105), 'refund', 105, ia, headB);
    const sSigOther = await v3sig.v3SignMutual(ethers, seller, custodyAddr, CHAIN, id2, digest2(105), 'refund', 105, ia, HEAD(0x22));
    await checkThrows('V3-4b mutual with different heads rejected', () => custody.connect(stranger).mutualRefund(id2, digest2(105), HEAD(0x11), 105, ia, bSig.v, bSig.r, bSig.s, sSigOther.v, sSigOther.r, sSigOther.s), 'UnauthorizedSigner');
    // settle id2 properly so liability tracking stays exact
    const m2 = await signMutual(id2, 'refund', 1051, await now(provider), headB);
    await (await custody.connect(stranger).mutualRefund(id2, digest2(105), headB, 1051, m2.ia || (await now(provider)), m2.b.v, m2.b.r, m2.b.s, m2.s.v, m2.s.r, m2.s.s)).wait();
    markSettled(id2);
  }
  {
    const tN = await now(provider);
    const id = cid(106);
    await mkFund(id, { minReleaseTime: 0, resolutionDeadline: tN + 5000, finalCutoff: tN + 5000 }); // equality allowed
    await bumpTime(provider, tN + 5000 - (await now(provider)) + 1);
    const before = await usdc.balanceOf(buyer.address);
    const tx = await (await custody.connect(stranger).refundTimeout(id, digest2(106))).wait();
    markSettled(id);
    const esc = await custody.getEscrow(id);
    check('V3-5 timeout refund needs NO checkpoint/signature/operator', (await usdc.balanceOf(buyer.address)) - before === small);
    check('V3-5b timeout records NO head (committedHead zero)', esc.committedHead === '0x' + '00'.repeat(32) && Number(esc.headCommittedAt) === 0);
    const rf = tx.logs.filter((l) => l.topics[0] === ethers.id('Refunded(bytes32,address,uint256,bytes32,bytes32)'));
    check('V3-5c timeout Refunded event carries zero head', rf.length === 1 && rf[0].data.indexOf('00'.repeat(32)) >= 0);
  }
  check('V3-A7 accounting: liability == sum of funded-settled', (await custody.totalHeld()) === expectedLiability());

  // ===== 2. EXACT EXECUTION BOUNDARIES =====
  {
    // 2a: funding before resolutionDeadline OK (even after minReleaseTime)
    const tN = await now(provider);
    const id = cid(201);
    await mkFund(id, { minReleaseTime: 0, resolutionDeadline: tN + 1000, finalCutoff: tN + 2000 });
    let esc = await custody.getEscrow(id);
    check('V3-6 funding before resolutionDeadline accepted', Number(esc.state) === 1);
    // funding at/after resolutionDeadline rejected
    const id2 = cid(202);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await checkThrows('V3-6b funding at resolutionDeadline rejected', () => custody.connect(buyer).fund(id2, digest2(202), usdcAddr, buyer.address, seller.address, evaluator.address, small, tN - 1, tN + 1000, 0, policyId, policyDigest, agreementRef), 'AfterResolutionDeadline');
    const id3 = cid(203);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await bumpTime(provider, 5);
    const nowA = await now(provider);
    await checkThrows('V3-6c funding after resolutionDeadline rejected', () => custody.connect(buyer).fund(id3, digest2(203), usdcAddr, buyer.address, seller.address, evaluator.address, small, nowA - 10, nowA + 1000, 0, policyId, policyDigest, agreementRef), 'AfterResolutionDeadline');
  }
  {
    // release boundary: before minReleaseTime rejected; exactly at minReleaseTime accepted.
    const tN = await now(provider);
    const id = cid(204);
    // next block will be tN+1 (automine); use it as the reference so the
    // "exactly at" case is precise.
    const tNext = tN + 1;
    const MRT = tNext + 100, RDL = tNext + 5000, CUT = tNext + 8000;
    await mkFund(id, { minReleaseTime: MRT, resolutionDeadline: RDL, finalCutoff: CUT });
    let ia = await now(provider);
    let sig = await signVerdict(id, 'release', 204, ia, HEAD(0x204));
    // move to MRT-1 exactly
    await setNext(provider, MRT - 1);
    await checkThrows('V3-7 release BEFORE minReleaseTime rejected', () => custody.connect(stranger).release(id, digest2(204), HEAD(0x204), 204, ia, sig.v, sig.r, sig.s, '0x'), 'NotYetValid');
    await setNext(provider, MRT);
    ia = await now(provider);
    sig = await signVerdict(id, 'release', 2041, ia, HEAD(0x2041));
    const before = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(204), HEAD(0x2041), 2041, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id);
    check('V3-7b release exactly AT minReleaseTime accepted', (await usdc.balanceOf(seller.address)) - before === small);
  }
  {
    // release boundary at resolutionDeadline
    const tN = await now(provider);
    const id = cid(205);
    const tNext = tN + 1;
    const RDL = tNext + 60, CUT = tNext + 1000;
    await mkFund(id, { minReleaseTime: 0, resolutionDeadline: RDL, finalCutoff: CUT });
    await setNext(provider, RDL - 1);
    let ia = await now(provider);
    let sig = await signVerdict(id, 'release', 205, ia, HEAD(0x205));
    const before = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(205), HEAD(0x205), 205, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id);
    check('V3-8 release immediately BEFORE resolutionDeadline accepted', (await usdc.balanceOf(seller.address)) - before === small);

    const id2 = cid(206);
    const tN2 = await now(provider);
    const RDL2 = tN2 + 60, CUT2 = tN2 + 1000;
    await mkFund(id2, { minReleaseTime: 0, resolutionDeadline: RDL2, finalCutoff: CUT2 });
    await setNext(provider, RDL2);
    ia = await now(provider);
    sig = await signVerdict(id2, 'release', 206, ia, HEAD(0x206));
    await checkThrows('V3-8b release exactly AT resolutionDeadline rejected', () => custody.connect(stranger).release(id2, digest2(206), HEAD(0x206), 206, ia, sig.v, sig.r, sig.s, '0x'), 'AfterResolutionDeadline');

    // intentional gap [RDL, CUT): no ordinary resolution; timeout not yet eligible
    const id3 = cid(207);
    const tN3 = await now(provider);
    const RDL3 = tN3 + 60, CUT3 = tN3 + 1000;
    await mkFund(id3, { minReleaseTime: 0, resolutionDeadline: RDL3, finalCutoff: CUT3 });
    await setNext(provider, RDL3 + 10);
    ia = await now(provider);
    sig = await signVerdict(id3, 'release', 207, ia, HEAD(0x207));
    await checkThrows('V3-8c release in the intentional gap [RDL,CUT) rejected', () => custody.connect(stranger).release(id3, digest2(207), HEAD(0x207), 207, ia, sig.v, sig.r, sig.s, '0x'), 'AfterResolutionDeadline');
    await checkThrows('V3-8d timeout NOT yet eligible in the intentional gap', () => custody.connect(stranger).refundTimeout(id3, digest2(207)), 'DeadlineNotPassed');
  }
  {
    // refund before minReleaseTime permitted when otherwise authorized
    const tN = await now(provider);
    const id = cid(208);
    const MRT = tN + 30000, RDL = tN + 50000, CUT = tN + 80000;
    await mkFund(id, { minReleaseTime: MRT, resolutionDeadline: RDL, finalCutoff: CUT });
    const ia = await now(provider);
    const sig = await signVerdict(id, 'refund', 208, ia, HEAD(0x208));
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundVerdict(id, digest2(208), HEAD(0x208), 208, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id);
    check('V3-9 evaluator refund BEFORE minReleaseTime permitted', (await usdc.balanceOf(buyer.address)) - before === small);
  }
  {
    // mutual: refund before minReleaseTime OK; release requires it
    const tN = await now(provider);
    const MRT = tN + 30000, RDL = tN + 50000, CUT = tN + 80000;
    const id = cid(209);
    await mkFund(id, { minReleaseTime: MRT, resolutionDeadline: RDL, finalCutoff: CUT });
    const ia = await now(provider);
    const m = await signMutual(id, 'refund', 209, ia, HEAD(0x209));
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).mutualRefund(id, digest2(209), HEAD(0x209), 209, ia, m.b.v, m.b.r, m.b.s, m.s.v, m.s.r, m.s.s)).wait();
    markSettled(id);
    check('V3-9b mutual refund BEFORE minReleaseTime permitted', (await usdc.balanceOf(buyer.address)) - before === small);

    const id2 = cid(210);
    await mkFund(id2, { minReleaseTime: MRT, resolutionDeadline: RDL, finalCutoff: CUT });
    const m2 = await signMutual(id2, 'release', 210, ia, HEAD(0x210));
    await checkThrows('V3-9c mutual release BEFORE minReleaseTime rejected', () => custody.connect(stranger).mutualRelease(id2, digest2(210), HEAD(0x210), 210, ia, m2.b.v, m2.b.r, m2.b.s, m2.s.v, m2.s.r, m2.s.s), 'NotYetValid');
  }
  {
    // resolve: release requires minReleaseTime; refund does not
    const tN = await now(provider);
    const MRT = tN + 60, RDL = tN + 5000, CUT = tN + 8000;
    const id = cid(211);
    await mkFund(id, { minReleaseTime: MRT, resolutionDeadline: RDL, finalCutoff: CUT });
    await (await custody.connect(buyer).raiseDispute(id, digest2(211), 'ipfs://dispute-reason')).wait();
    const ia = await now(provider);
    const sigRef = await signVerdict(id, 'resolve:refund', 211, ia, HEAD(0x211));
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).resolve(id, digest2(211), 'refund', HEAD(0x211), 211, ia, sigRef.v, sigRef.r, sigRef.s, '0x')).wait();
    markSettled(id);
    check('V3-10 disputed refund BEFORE minReleaseTime permitted (resolve:refund)', (await usdc.balanceOf(buyer.address)) - before === small);

    const id2 = cid(212);
    await mkFund(id2, { minReleaseTime: MRT, resolutionDeadline: RDL, finalCutoff: CUT });
    await (await custody.connect(seller).raiseDispute(id2, digest2(212), 'ipfs://dispute-reason-2')).wait();
    const s2 = await signVerdict(id2, 'resolve:release', 212, ia, HEAD(0x212));
    await checkThrows('V3-10b disputed release BEFORE minReleaseTime rejected', () => custody.connect(stranger).resolve(id2, digest2(212), 'release', HEAD(0x212), 212, ia, s2.v, s2.r, s2.s, '0x'), 'NotYetValid');
    await setNext(provider, MRT + 1);
    const ia2 = await now(provider);
    const s3 = await signVerdict(id2, 'resolve:release', 2121, ia2, HEAD(0x2121));
    const b3 = await usdc.balanceOf(seller.address);
    const r3 = await (await custody.connect(stranger).resolve(id2, digest2(212), 'release', HEAD(0x2121), 2121, ia2, s3.v, s3.r, s3.s, '0x')).wait();
    markSettled(id2);
    check('V3-10c disputed release after minReleaseTime accepted', (await usdc.balanceOf(seller.address)) - b3 === small);
    // wrong resolution action
    const id3 = cid(2125);
    await mkFund(id3, { minReleaseTime: 0 });
    await (await custody.connect(buyer).raiseDispute(id3, digest2(2125), 'ipfs://dispute-2125')).wait();
    const iaBad = await now(provider);
    const sBad = await signVerdict(id3, 'resolve:bogus', 2125, iaBad, HEAD(0x2125));
    await checkThrows('V3-10d unknown resolution action rejected', () => custody.connect(stranger).resolve(id3, digest2(2125), 'bogus', HEAD(0x2125), 2125, iaBad, sBad.v, sBad.r, sBad.s, '0x'), 'UnsupportedAction');
  }
  {
    // timeout at/after finalCutoff; RDL==CUT equality
    const tN = await now(provider);
    const RDL = tN + 60;
    const id = cid(213);
    await mkFund(id, { minReleaseTime: 0, resolutionDeadline: RDL, finalCutoff: RDL });
    await setNext(provider, RDL - 1);
    await checkThrows('V3-11 timeout exactly at finalCutoff-1 rejected', () => custody.connect(stranger).refundTimeout(id, digest2(213), GAS), 'DeadlineNotPassed');
    await setNext(provider, RDL + 1);
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundTimeout(id, digest2(213), GAS)).wait();
    markSettled(id);
    check('V3-11b timeout at/after finalCutoff accepted (RDL==CUT)', (await usdc.balanceOf(buyer.address)) - before === small);

    const id2 = cid(214);
    const tN2 = await now(provider);
    const RDL2 = tN2 + 60;
    await mkFund(id2, { minReleaseTime: 0, resolutionDeadline: RDL2, finalCutoff: RDL2 });
    const nowC = await now(provider);
    const sig = await signVerdict(id2, 'refund', 214, nowC, HEAD(0x214));
    await setNext(provider, RDL2 + 1);
    await checkThrows('V3-11c no evaluator action after equality deadline', () => custody.connect(stranger).refundVerdict(id2, digest2(214), HEAD(0x214), 214, nowC, sig.v, sig.r, sig.s, '0x', GAS), 'AfterResolutionDeadline');
  }
  {
    // parameter validation at fund
    const tN = await now(provider);
    const RDL = tN + 5000, CUT = tN + 8000;
    const id = cid(215);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await checkThrows('V3-12 minReleaseTime >= resolutionDeadline rejected at fund', () => custody.connect(buyer).fund(id, digest2(215), usdcAddr, buyer.address, seller.address, evaluator.address, small, RDL, CUT, RDL, policyId, policyDigest, agreementRef), 'InvalidPolicy');
    const id2 = cid(216);
    const RDL2 = tN + 7000;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await checkThrows('V3-12b resolutionDeadline > finalCutoff rejected at fund', () => custody.connect(buyer).fund(id2, digest2(216), usdcAddr, buyer.address, seller.address, evaluator.address, small, RDL2, RDL2 - 100, 0, policyId, policyDigest, agreementRef), 'InvalidPolicy');
    const id3 = cid(217);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await checkThrows('V3-12c equality minReleaseTime==RDL rejected (strict < required)', () => custody.connect(buyer).fund(id3, digest2(217), usdcAddr, buyer.address, seller.address, evaluator.address, small, tN + 1000, tN + 1000, tN + 1000, policyId, policyDigest, agreementRef), 'InvalidPolicy');
    // RDL==CUT equality IS allowed: fund succeeds
    const id4 = cid(218);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id4, digest2(218), usdcAddr, buyer.address, seller.address, evaluator.address, small, tN + 1000, tN + 1000, 0, policyId, policyDigest, agreementRef)).wait();
    markFunded(id4, small);
    check('V3-12d equality RDL==CUT allowed at fund', true);
  }
  check('V3-A8 accounting: liability == sum of funded-settled (after boundaries)', (await custody.totalHeld()) === expectedLiability());

  // ===== 3. AUTHORIZATION VALIDITY (at execution) =====
  {
    const tN = await now(provider);
    RDL_DEFAULT = tN + 60000; CUT_DEFAULT = tN + 90000;
    const id = cid(301);
    await mkFund(id, { minReleaseTime: 0 });
    let ia = await now(provider);
    let sig = await signVerdict(id, 'refund', 301, ia + 500, HEAD(0x301)); // issuedAt > now+120
    await checkThrows('V3-13 future-dated verdict (issuedAt > now+120) rejected', () => custody.connect(stranger).refundVerdict(id, digest2(301), HEAD(0x301), 301, ia + 500, sig.v, sig.r, sig.s, '0x'), 'NotYetValid');
    const id2 = cid(302);
    await mkFund(id2, { minReleaseTime: 0 });
    ia = await now(provider);
    sig = await signVerdict(id2, 'refund', 302, ia, HEAD(0x302));
    await bumpTime(provider, 301);
    await checkThrows('V3-13b expired verdict (exec > issuedAt+300) rejected', () => custody.connect(stranger).refundVerdict(id2, digest2(302), HEAD(0x302), 302, ia, sig.v, sig.r, sig.s, '0x'), 'ExpiredVerdict');
    const id3 = cid(303);
    await mkFund(id3, { minReleaseTime: 0 });
    ia = await now(provider);
    sig = await signVerdict(id3, 'refund', 303, ia, HEAD(0x303));
    await setNext(provider, ia + 300);
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundVerdict(id3, digest2(303), HEAD(0x303), 303, ia, sig.v, sig.r, sig.s, '0x', GAS)).wait();
    markSettled(id3);
    check('V3-13c verdict executed exactly AT expiry boundary accepted', (await usdc.balanceOf(buyer.address)) - before === small);
    const id4 = cid(304);
    await mkFund(id4, { minReleaseTime: 0 });
    ia = await now(provider);
    const m = await signMutual(id4, 'refund', 304, ia + 200, HEAD(0x304));
    await checkThrows('V3-13d future-dated mutual rejected', () => custody.connect(stranger).mutualRefund(id4, digest2(304), HEAD(0x304), 304, ia + 200, m.b.v, m.b.r, m.b.s, m.s.v, m.s.r, m.s.s), 'NotYetValid');
  }

  // ===== 4. NONCES: escrow-scoped, class-separated =====
  {
    const tN = await now(provider);
    RDL_DEFAULT = tN + 60000; CUT_DEFAULT = tN + 90000;
    const ia = await now(provider);
    const head = HEAD(0x401);
    const id = cid(401);
    await mkFund(id, { minReleaseTime: 0 });
    let sig = await signVerdict(id, 'refund', 777, ia, head);
    await (await custody.connect(stranger).refundVerdict(id, digest2(401), head, 777, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id);
    const id2 = cid(402);
    await mkFund(id2, { minReleaseTime: 0 });
    sig = await signVerdict(id2, 'refund', 777, ia, head);
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundVerdict(id2, digest2(402), head, 777, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id2);
    check('V3-14 same verdict nonce reusable across DIFFERENT escrows (escrow-scoped)', (await usdc.balanceOf(buyer.address)) - before === small);
    const used = await custody.usedVerdictNonce(id, 777);
    check('V3-14b nonce recorded in escrow-scoped map', used === true);
    // class separation: verdict nonce vs mutual nonce independent
    const id4 = cid(404);
    await mkFund(id4, { minReleaseTime: 0 });
    sig = await signVerdict(id4, 'refund', 999, ia, head);
    await (await custody.connect(stranger).refundVerdict(id4, digest2(404), head, 999, ia, sig.v, sig.r, sig.s, '0x')).wait();
    markSettled(id4);
    const id5 = cid(405);
    await mkFund(id5, { minReleaseTime: 0 });
    const m5 = await signMutual(id5, 'refund', 999, ia, head);
    const b4 = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).mutualRefund(id5, digest2(405), head, 999, ia, m5.b.v, m5.b.r, m5.b.s, m5.s.v, m5.s.r, m5.s.s)).wait();
    markSettled(id5);
    check('V3-14c verdict and mutual nonce classes are independent', (await usdc.balanceOf(buyer.address)) - b4 === small);
    // cross-escrow mutual independence + same-escrow replay guard
    const id6 = cid(406);
    await mkFund(id6, { minReleaseTime: 0 });
    const id7 = cid(407);
    await mkFund(id7, { minReleaseTime: 0 });
    const m6 = await signMutual(id6, 'refund', 555, ia, head);
    const m7 = await signMutual(id7, 'refund', 555, ia, head);
    await (await custody.connect(stranger).mutualRefund(id6, digest2(406), head, 555, ia, m6.b.v, m6.b.r, m6.b.s, m6.s.v, m6.s.r, m6.s.s)).wait();
    markSettled(id6);
    const b6 = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).mutualRefund(id7, digest2(407), head, 555, ia, m7.b.v, m7.b.r, m7.b.s, m7.s.v, m7.s.r, m7.s.s)).wait();
    markSettled(id7);
    check('V3-14d same mutual nonce reusable across different escrows', (await usdc.balanceOf(buyer.address)) - b6 === small);
    const usedM = await custody.usedMutualNonce(id6, 555);
    check('V3-14e mutual nonce recorded in escrow-scoped mutual map', usedM === true);
  }

  // ===== 5. WRONG ROLE / PARTY / ESCROW / CHAIN / CUSTODY / VERSION =====
  {
    const tN = await now(provider);
    RDL_DEFAULT = tN + 60000; CUT_DEFAULT = tN + 90000;
    const ia = await now(provider);
    const head = HEAD(0x501);
    const id = cid(501);
    await mkFund(id, { minReleaseTime: 0 });
    const sigS = await signVerdict(id, 'refund', 501, ia, head, stranger);
    await checkThrows('V3-15 wrong role (stranger as evaluator) rejected', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 501, ia, sigS.v, sigS.r, sigS.s, '0x'), 'UnauthorizedSigner');
    const sigB = await signVerdict(id, 'refund', 501, ia, head, buyer);
    await checkThrows('V3-15b wrong party (buyer as evaluator) rejected', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 501, ia, sigB.v, sigB.r, sigB.s, '0x'), 'UnauthorizedSigner');
    const sigOther = await signVerdict(cid(999), 'refund', 502, ia, head);
    await checkThrows('V3-15c verdict signed for a different escrow (commitmentId) rejected', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 502, ia, sigOther.v, sigOther.r, sigOther.s, '0x'), 'UnauthorizedSigner');
    const sigDig = await v3sig.v3SignVerdict(ethers, evaluator, custodyAddr, CHAIN, id, digest2(777), 'refund', 503, ia, head);
    await checkThrows('V3-15d verdict with wrong commitmentDigest rejected', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 503, ia, sigDig.v, sigDig.r, sigDig.s, '0x'), 'UnauthorizedSigner');
    const sigChain = await v3sig.v3SignVerdict(ethers, evaluator, custodyAddr, 84532, id, digest2(501), 'refund', 504, ia, head);
    await checkThrows('V3-15e verdict signed for a different chain rejected', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 504, ia, sigChain.v, sigChain.r, sigChain.s, '0x'), 'UnauthorizedSigner');
    const sigCust = await v3sig.v3SignVerdict(ethers, evaluator, ethers.Wallet.createRandom().address, CHAIN, id, digest2(501), 'refund', 505, ia, head);
    await checkThrows('V3-15f verdict signed for a different custody deployment rejected', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 505, ia, sigCust.v, sigCust.r, sigCust.s, '0x'), 'UnauthorizedSigner');
    const v2Sig = ethers.Signature.from(await evaluator.signTypedData(
      { name: 'SAAX Escrow Custody V2', version: '2', chainId: CHAIN, verifyingContract: custodyAddr },
      { EscrowVerdict: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
      { commitmentId: id, commitmentDigest: digest2(501), action: 'refund', nonce: 506, issuedAt: ia }
    ));
    await checkThrows('V3-15g V2-era 5-field verdict rejected on V3 (version separation)', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 506, ia, v2Sig.v, v2Sig.r, v2Sig.s, '0x'), 'UnauthorizedSigner');
    const sigRel = await signVerdict(id, 'release', 507, ia, head);
    await checkThrows('V3-15h wrong action (release verdict on refund) rejected', () => custody.connect(stranger).refundVerdict(id, digest2(501), head, 507, ia, sigRel.v, sigRel.r, sigRel.s, '0x'), 'UnauthorizedSigner');
    // mutual wrong party
    const id2 = cid(502);
    await mkFund(id2, { minReleaseTime: 0 });
    const mWrong = await v3sig.v3SignMutual(ethers, buyer2, custodyAddr, CHAIN, id2, digest2(502), 'refund', 508, ia, head);
    const mS = await v3sig.v3SignMutual(ethers, seller, custodyAddr, CHAIN, id2, digest2(502), 'refund', 508, ia, head);
    await checkThrows('V3-16 substituted mutual party rejected (wrong buyer)', () => custody.connect(stranger).mutualRefund(id2, digest2(502), head, 508, ia, mWrong.v, mWrong.r, mWrong.s, mS.v, mS.r, mS.s), 'UnauthorizedSigner');
    const id3 = cid(503);
    await mkFund(id3, { minReleaseTime: 0 });
    const mWrongId = await signMutual(cid(999), 'refund', 509, ia, head);
    await checkThrows('V3-16b mutual signed for different escrow rejected', () => custody.connect(stranger).mutualRefund(id3, digest2(503), head, 509, ia, mWrongId.b.v, mWrongId.b.r, mWrongId.b.s, mWrongId.s.v, mWrongId.s.r, mWrongId.s.s), 'UnauthorizedSigner');
    const mChain = {
      b: ethers.Signature.from(await buyer.signTypedData({ name: 'SAAX Escrow Custody V3', version: '3', chainId: 84532, verifyingContract: custodyAddr }, v3sig.MUTUAL_TYPES, { commitmentId: id3, commitmentDigest: digest2(503), action: 'refund', nonce: 510, issuedAt: ia, preSettlementHead: head })),
      s: ethers.Signature.from(await seller.signTypedData({ name: 'SAAX Escrow Custody V3', version: '3', chainId: 84532, verifyingContract: custodyAddr }, v3sig.MUTUAL_TYPES, { commitmentId: id3, commitmentDigest: digest2(503), action: 'refund', nonce: 510, issuedAt: ia, preSettlementHead: head })),
    };
    await checkThrows('V3-16c mutual signed for different chain rejected', () => custody.connect(stranger).mutualRefund(id3, digest2(503), head, 510, ia, mChain.b.v, mChain.b.r, mChain.b.s, mChain.s.v, mChain.s.r, mChain.s.s), 'UnauthorizedSigner');
  }

  // ===== 6. PRESERVED SAFEGUARDS (dedicated cap instance) =====
  {
    const capInst = await new ethers.ContractFactory(v3Art.abi, v3Art.bytecode, deployer).deploy(perPosCap, ethers.parseUnits('2500', 6), true, policyId, policyDigest);
    await capInst.waitForDeployment();
    const capAddr = await capInst.getAddress();
    const ci = { capInst, capAddr };
    async function capFund(n, amt) {
      const id = cid(n);
      await (await usdc.connect(buyer).approve(capAddr, amt, { gasLimit: 300000 })).wait();
      const tCap = await now(provider);
      await (await capInst.connect(buyer).fund(id, digest2(n), usdcAddr, buyer.address, seller.address, evaluator.address, amt, tCap + 50000, tCap + 80000, 0, policyId, policyDigest, agreementRef)).wait();
    }
    const tCap0 = await now(provider);
    await checkThrows('V3-17 per-position cap enforced', () => capInst.connect(buyer).fund(cid(601), digest2(601), usdcAddr, buyer.address, seller.address, evaluator.address, ethers.parseUnits('1001', 6), tCap0 + 50000, tCap0 + 80000, 0, policyId, policyDigest, agreementRef), 'CapExceeded');
    for (const n of [602, 603, 604, 605]) await capFund(n, small);
    check('V3-17b aggregate liability exact (4x500=2000)', (await capInst.totalHeld()) === ethers.parseUnits('2000', 6));
    // 5th 500 makes it exactly 2500 (== aggregate cap, allowed)
    await capFund(606, small);
    check('V3-17bb aggregate at exactly cap accepted (2500==2500)', (await capInst.totalHeld()) === ethers.parseUnits('2500', 6));
    await (await usdc.connect(buyer).approve(capAddr, small, { gasLimit: 300000 })).wait();
    const tCap1 = await now(provider);
    await checkThrows('V3-17c aggregate cap enforced (6th 500 > 2500)', () => capInst.connect(buyer).fund(cid(608), digest2(608), usdcAddr, buyer.address, seller.address, evaluator.address, small, tCap1 + 50000, tCap1 + 80000, 0, policyId, policyDigest, agreementRef), 'CapExceeded');
    // capacity freed by settlement on cap instance
    const iaCap = await now(provider);
    const m = {
      b: ethers.Signature.from(await buyer.signTypedData({ name: 'SAAX Escrow Custody V3', version: '3', chainId: CHAIN, verifyingContract: capAddr }, v3sig.MUTUAL_TYPES, { commitmentId: cid(602), commitmentDigest: digest2(602), action: 'refund', nonce: 602, issuedAt: iaCap, preSettlementHead: HEAD(0x602) })),
      s: ethers.Signature.from(await seller.signTypedData({ name: 'SAAX Escrow Custody V3', version: '3', chainId: CHAIN, verifyingContract: capAddr }, v3sig.MUTUAL_TYPES, { commitmentId: cid(602), commitmentDigest: digest2(602), action: 'refund', nonce: 602, issuedAt: iaCap, preSettlementHead: HEAD(0x602) })),
    };
    await (await capInst.connect(stranger).mutualRefund(cid(602), digest2(602), HEAD(0x602), 602, iaCap, m.b.v, m.b.r, m.b.s, m.s.v, m.s.r, m.s.s, GAS)).wait();
    check('V3-17d liability decremented after settlement on cap instance', (await capInst.totalHeld()) === ethers.parseUnits('2000', 6));
    await (await usdc.connect(buyer).approve(capAddr, small, { gasLimit: 300000 })).wait();
    const nowD = await now(provider);
    await (await capInst.connect(buyer).fund(cid(607), digest2(607), usdcAddr, buyer.address, seller.address, evaluator.address, small, nowD + 50000, nowD + 80000, 0, policyId, policyDigest, agreementRef)).wait();
    check('V3-17e capacity freed by settlement allows new fund (2500 again)', (await capInst.totalHeld()) === ethers.parseUnits('2500', 6));
  }
  {
    // funding disabled blocks intake; exits still work (structural + behavioral)
    const disInst = await new ethers.ContractFactory(v3Art.abi, v3Art.bytecode, deployer).deploy(perPosCap, aggCapBig, false, policyId, policyDigest);
    await disInst.waitForDeployment();
    const disAddr = await disInst.getAddress();
    await (await usdc.connect(buyer).approve(disAddr, small, { gasLimit: 300000 })).wait();
    const nowE = await now(provider);
    await checkThrows('V3-18 funding disabled blocks intake', () => disInst.connect(buyer).fund(cid(608), digest2(608), usdcAddr, buyer.address, seller.address, evaluator.address, small, nowE + 50000, nowE + 80000, 0, policyId, policyDigest, agreementRef), 'FundingDisabled');
    // exits available on main instance regardless: timeout pays buyer
    const tN = await now(provider);
    const id = cid(607);
    await mkFund(id, { minReleaseTime: 0, resolutionDeadline: tN + 3000, finalCutoff: tN + 3000 });
    await setNext(provider, tN + 3001);
    const before = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundTimeout(id, digest2(607))).wait();
    markSettled(id);
    check('V3-18b exits remain available (timeout paid after deadline)', (await usdc.balanceOf(buyer.address)) - before === small);
    // failed token transfer (no approval)
    const id9 = cid(609);
    const nowF = await now(provider);
    await checkThrows('V3-19 fund without approval reverts (no escrow recorded)', () => custody.connect(donor).fund(id9, digest2(609), usdcAddr, donor.address, seller.address, evaluator.address, small, nowF + 50000, nowF + 80000, 0, policyId, policyDigest, agreementRef), 'TransferFailed');
    const esc9 = await custody.getEscrow(id9);
    check('V3-19b failed fund records NO escrow', Number(esc9.state) === 0);
    check('V3-19c liability unchanged after failed fund', (await custody.totalHeld()) === expectedLiability());
    // unsolicited donation
    await (await usdc.mint(donor.address, small)).wait();
    await (await usdc.connect(donor).transfer(custodyAddr, small)).wait();
    const donated = await custody.balanceHeld(usdcAddr);
    check('V3-20 donation does not inflate liability (balanceHeld > totalHeld)', donated > (await custody.totalHeld()));
    // no double payout + terminal exclusivity
    const id10 = cid(610);
    await mkFund(id10, { minReleaseTime: 0 });
    const ia = await now(provider);
    const m10 = await signMutual(id10, 'refund', 610, ia, HEAD(0x610));
    await (await custody.connect(stranger).mutualRefund(id10, digest2(610), HEAD(0x610), 610, ia, m10.b.v, m10.b.r, m10.b.s, m10.s.v, m10.s.r, m10.s.s)).wait();
    markSettled(id10);
    const bal10 = await usdc.balanceOf(buyer.address);
    await checkThrows('V3-20b second terminal attempt rejected (WrongState)', () => custody.connect(stranger).refundTimeout(id10, digest2(610)), 'WrongState');
    check('V3-20c no double payout (buyer balance unchanged)', (await usdc.balanceOf(buyer.address)) === bal10);
    // disputed escrow timeout refunds to buyer
    const id11 = cid(611);
    const tN2 = await now(provider);
    await mkFund(id11, { minReleaseTime: 0, resolutionDeadline: tN2 + 3000, finalCutoff: tN2 + 3000 });
    await (await custody.connect(seller).raiseDispute(id11, digest2(611), 'ipfs://dispute-611')).wait();
    await setNext(provider, tN2 + 3001);
    await (await custody.connect(stranger).refundTimeout(id11, digest2(611))).wait();
    markSettled(id11);
    const esc11 = await custody.getEscrow(id11);
    check('V3-21 disputed escrow timeout refunds to buyer', Number(esc11.state) === 4 && esc11.refundedAt > 0n);
    check('V3-21b timeout on disputed escrow records no head', esc11.committedHead === '0x' + '00'.repeat(32));
  }
  check('V3-A9 final accounting: liability == sum of funded-settled', (await custody.totalHeld()) === expectedLiability());

  fs.writeSync(1, 'v3_eoa_passed=' + passed + ' failed=' + failed + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  fs.writeSync(2, 'FATAL: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(2);
});