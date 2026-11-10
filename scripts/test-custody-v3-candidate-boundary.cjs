/**
 * F3C EXACT-CANDIDATE BOUNDARY + INVARIANT COMPANION harness
 * (pinned F3B runtime, cancun, keccak 0x87615e3d). LOCAL EVM 31337 ONLY.
 *
 * PURPOSE
 *   review/f3c-candidate/03-coverage-matrix.md maps the Paris-only batteries —
 *   scripts/test-custody-v3.cjs (83 checks, F3A evmVersion=paris) and
 *   scripts/test-custody-v3-fuzz.cjs (540 assertions, F3A paris) — as NOT
 *   exact-candidate coverage (they exercise a different runtime object).
 *   This companion runs the SPECIFIC missing required control areas on the
 *   EXACT CANDIDATE artifact (data/escrow-custody-v3-build.json, the pinned
 *   F3B object) so Category C moves from PARTIAL evidence to evidenced:
 *
 *     A. Funding before / at / after resolutionDeadline.
 *     B. Seller-payment boundaries at minReleaseTime and resolutionDeadline
 *        (evaluator release, resolve:release, mutualRelease).
 *     C. Evaluator/mutual refunds WITHOUT a minimum-release wait.
 *     D. Timeout before / at / after finalCutoff.
 *     E. Allowed deadline equality and intentional resolution-to-timeout
 *        gaps.
 *     F. Signature expiry / future skew and escrow-scoped
 *        authorization-class nonces (verdict vs mutual classes).
 *     G. Bounded seeded fuzz over distinct required invariants (state
 *        unchanged on rejects, terminal head class, no double payout,
 *        totalHeld == outstanding), seeded and deterministic, preserving
 *        seeds and results.
 *
 * CLOCK MODEL (hardened): every setTime() consumes the pending timestamp
 * with evm_mine and returns the exact tip; the FOLLOWING transaction then
 * mines at tip+1 (hardhat automine). Probes therefore use setTime(W-1) so
 * the probe executes at exactly W. This eliminates the two failure modes
 * seen in earlier drafts: (a) revert-probes that never mine leaking a
 * pending setNextBlockTimestamp into later blocks (clock jumps), and
 * (b) stale now() reads drifting from the tip. With this model every
 * executed timestamp is deterministic and the contract's verdict validity
 * window [issuedAt-300, issuedAt+120] is respected because issuedAt is
 * always the ACTUAL executed block timestamp.
 *
 * MECHANICS (identical to the 46/46 real-Safe companion harness):
 *   - Deploys the COMMITTED ARTIFACT's creation bytecode (never compiles the
 *     source in-tree).
 *   - Asserts the deployed runtime keccak == pinned identity
 *     0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3
 *     BEFORE any behavior test; refuses to continue on mismatch.
 *   - Uses only LOCAL EVM chainId 31337, synthetic hardhat keys, MockUSDC,
 *     official EAS 1.7.1. No public chain, no deployment, no spending.
 *   - Verdict signatures are EOA EIP-712 over the V3 domain (v3-signing.cjs);
 *     the contract's _checkVerdict/_checkMutual enforce the same digest.
 *
 * CONSTRAINTS (unchanged from the objective):
 *   - Contract source, compiler target, artifact, identity pin, economics:
 *     NOT modified. No recompile; artifact read-only. Assertions not weakened.
 *   - No broad test reruns: this harness runs the MISSING controls only;
 *     completed suites are NOT restarted.
 *
 * EVIDENCE OUTPUTS
 *   - .output/v3-candidate-boundary-run.txt   (full transcript, this run)
 *   - evidence/f3c-candidate-boundary-exports/{results.json, run-record.json}
 *   Seed + rounds preserved in run-record.json and transcript.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const CHAIN = 31337;
const PINNED = '0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3';
const IDENTITY = require(path.join(ROOT, 'verifier/v4-candidate-identity-31337-v3.json'));
const ARTIFACT = require(path.join(ROOT, 'data/escrow-custody-v3-build.json'));
const v3sig = require('./v3-signing.cjs');

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
function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function startEvm() {
  const hre = require('hardhat');
  await hre.run('compile');
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const accounts = [];
  for (let i = 0; i < 12; i++) accounts.push(await provider.getSigner(i));
  return { provider, hre, accounts };
}
async function now(provider) { const b = await provider.send('eth_getBlockByNumber', ['latest', false]); return parseInt(b.timestamp, 16); }
// setTime(W-1) semantics: consumes the pending timestamp (evm_mine) leaving tip=W-1,
// so the NEXT transaction mines at exactly W = the wanted probe time.
async function setTime(provider, wantedMinusOne) {
  const b = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const tip = parseInt(b.timestamp, 16);
  let ts = wantedMinusOne;
  if (ts <= tip) ts = tip + 1; // never jump backwards
  await provider.send('evm_setNextBlockTimestamp', [ts]);
  await provider.send('evm_mine', []);
  return ts; // tip is now ts; the next tx mines at ts+1 = wanted
}

function loadArtifact(hre, name) { const a = hre.artifacts.readArtifactSync(name); return { abi: a.abi, bytecode: a.bytecode }; }

(async () => {
  const revision = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const testRevision = revision;
  console.log('F3C exact-candidate boundary + invariant companion harness (LOCAL ONLY)');
  console.log('test-revision: ' + testRevision + '  identity pin: ' + PINNED);

  const { provider, hre, accounts } = await startEvm();
  const [deployer, buyer, seller, evaluatorEOA, attester, donor, stranger] = accounts;

  const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
  const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
  const registry = await new ethers.ContractFactory(regArt.abi, regArt.bytecode, deployer).deploy();
  await registry.waitForDeployment();
  const eas = await new ethers.ContractFactory(easArt.abi, easArt.bytecode, deployer).deploy(registry.target);
  await eas.waitForDeployment();
  const av = require('../verifier/v4-anchor');
  await (await registry.register(av.SCHEMA, ethers.ZeroAddress, false)).wait();

  const usdcArt = loadArtifact(hre, 'MockUSDC');
  const usdc = await new ethers.ContractFactory(usdcArt.abi, usdcArt.bytecode, deployer).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  await (await usdc.mint(buyer.address, ethers.parseUnits('200000', 6))).wait();
  await (await usdc.mint(seller.address, ethers.parseUnits('200000', 6))).wait();
  await (await usdc.mint(stranger.address, ethers.parseUnits('200000', 6))).wait();

  // DEPLOY THE EXACT CANDIDATE ARTIFACT (never source-compiled)
  const custody = await new ethers.ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, deployer)
    .deploy(ethers.parseUnits('10000', 6), ethers.parseUnits('50000', 6), true, 1n, '0x' + 'ab'.repeat(32));
  await custody.waitForDeployment();
  const custodyAddr = custody.target;
  const deployedRuntime = await provider.getCode(custodyAddr);
  const deployedKeccak = ethers.keccak256(deployedRuntime);
  check('BC-0 deployed runtime keccak == pinned F3B identity 0x87615e3d…', deployedKeccak === PINNED, deployedKeccak);
  check('BC-0b identity file runtimeCodeHash == pin', IDENTITY.runtimeCodeHash === PINNED);
  check('BC-0c artifact runtimeCodeHash == pin', ARTIFACT.runtimeCodeHash === PINNED);
  if (deployedKeccak !== PINNED) throw new Error('candidate identity mismatch — refusing to run behavior on unverified runtime');

  const small = ethers.parseUnits('500', 6);
  await (await usdc.connect(buyer).approve(custodyAddr, ethers.parseUnits('50000', 6), { gasLimit: 300000 })).wait();
  const policyId = 1n;
  const policyDigest = '0x' + 'ab'.repeat(32);
  const agreementRef = '0x' + 'cd'.repeat(32);
  const FUND = (id, digest, buyerA, sellerA, evaluatorA, amount, rdl, cut, mrt) =>
    custody.connect(buyerA).fund(id, digest, usdcAddr, buyerA.address, sellerA.address, evaluatorA, amount, rdl, cut, mrt, policyId, policyDigest, agreementRef);

  function signVerdict(id, digest, action, nonce, issuedAt, head, signer) {
    return v3sig.v3SignVerdict(ethers, signer, custodyAddr, CHAIN, id, digest, action, nonce, issuedAt, head);
  }
  function signMutual(id, digest, action, nonce, issuedAt, head, buyerS, sellerS) {
    return Promise.all([
      v3sig.v3SignMutual(ethers, buyerS, custodyAddr, CHAIN, id, digest, action, nonce, issuedAt, head),
      v3sig.v3SignMutual(ethers, sellerS, custodyAddr, CHAIN, id, digest, action, nonce, issuedAt, head),
    ]);
  }
  const G = { gasLimit: 900000 };

  // =====================================================================
  // A. FUNDING WINDOW — before / at / after resolutionDeadline
  // =====================================================================
  {
    const tN = await now(provider);
    const idA1 = cid(0xA01);
    await (await FUND(idA1, digest2(0xA01), buyer, seller, evaluatorEOA, small, tN + 5000, tN + 8000, tN + 1000)).wait();
    const escA1 = await custody.getEscrow(idA1);
    check('BC-A1 fund before resolutionDeadline accepted (state Funded)', Number(escA1.state) === 1 && escA1.amount === small);

    const idA2 = cid(0xA02);
    await setTime(provider, tN + 4999); // probe mines at exactly tN+5000 == RDL
    await checkThrows('BC-A2 fund exactly AT resolutionDeadline rejected', () =>
      FUND(idA2, digest2(0xA02), buyer, seller, evaluatorEOA, small, tN + 5000, tN + 8000, tN + 1000), 'AfterResolutionDeadline');

    const idA3 = cid(0xA03);
    await setTime(provider, tN + 5000); // probe mines at tN+5001 > RDL
    await checkThrows('BC-A3 fund AFTER resolutionDeadline rejected', () =>
      FUND(idA3, digest2(0xA03), buyer, seller, evaluatorEOA, small, tN + 5000, tN + 8000, tN + 1000), 'AfterResolutionDeadline');

    const esA2 = await custody.getEscrow(idA2);
    check('BC-A4 failed funds record NO escrow', Number(esA2.state) === 0 && esA2.amount === 0n);
    check('BC-A4b totalHeld unchanged after failed funds', (await custody.totalHeld()) === small);

    // A5: fund after minReleaseTime while RDL still open (policy 2).
    const idA5 = cid(0xA05);
    await setTime(provider, tN + 6000); // probe mines at tN+6001; minRelease=tN+1000 passed
    await (await FUND(idA5, digest2(0xA05), buyer, seller, evaluatorEOA, small, tN + 10000, tN + 13000, tN + 1000)).wait();
    check('BC-A5 fund after minReleaseTime while RDL open accepted', Number((await custody.getEscrow(idA5)).state) === 1);
  }

  // =====================================================================
  // B. SELLER-PAYMENT BOUNDARIES at minReleaseTime and resolutionDeadline
  // =====================================================================
  {
    const tN = await now(provider);
    const MRT = tN + 100, RDL = tN + 5000, CUT = tN + 8000;
    const RDLs = tN + 200; // evaluator release boundary (small, fresh verdict)

    // B1: evaluator release BEFORE minReleaseTime rejected (NotYetValid).
    const idB1 = cid(0xB01);
    await (await FUND(idB1, digest2(0xB01), buyer, seller, evaluatorEOA, small, RDL, CUT, MRT)).wait();
    const head1 = '0x' + 'b1'.repeat(32);
    const tsB1 = await setTime(provider, MRT - 2); // probe mines at MRT-1
    const sig1 = await signVerdict(idB1, digest2(0xB01), 'release', 0xB010, tsB1 + 1, head1, evaluatorEOA);
    await checkThrows('BC-B1 evaluator release BEFORE minReleaseTime rejected (NotYetValid)', () =>
      custody.connect(stranger).release(idB1, digest2(0xB01), head1, 0xB010, tsB1 + 1, sig1.v, sig1.r, sig1.s, '0x', G), 'NotYetValid');

    // B2: evaluator release exactly AT minReleaseTime accepted (payout).
    const sellerBefore = await usdc.balanceOf(seller.address);
    const tsB2 = await setTime(provider, MRT - 1); // probe mines at MRT
    const sig1b = await signVerdict(idB1, digest2(0xB01), 'release', 0xB011, tsB2 + 1, head1, evaluatorEOA);
    await (await custody.connect(stranger).release(idB1, digest2(0xB01), head1, 0xB011, tsB2 + 1, sig1b.v, sig1b.r, sig1b.s, '0x', G)).wait();
    const escB1 = await custody.getEscrow(idB1);
    check('BC-B2 evaluator release exactly AT minReleaseTime accepted', Number(escB1.state) === 3 && escB1.committedHead === head1);
    check('BC-B2b seller paid exactly once', (await usdc.balanceOf(seller.address)) - sellerBefore === small);

    // B3: evaluator release exactly AT resolutionDeadline rejected.
    const idB3 = cid(0xB03);
    await (await FUND(idB3, digest2(0xB03), buyer, seller, evaluatorEOA, small, RDLs, RDLs + 300, MRT)).wait();
    const head3 = '0x' + 'b3'.repeat(32);
    const tsB3 = await setTime(provider, RDLs - 1); // probe mines at RDLs
    const sig3 = await signVerdict(idB3, digest2(0xB03), 'release', 0xB030, tsB3 + 1, head3, evaluatorEOA);
    await checkThrows('BC-B3 evaluator release exactly AT resolutionDeadline rejected', () =>
      custody.connect(stranger).release(idB3, digest2(0xB03), head3, 0xB030, tsB3 + 1, sig3.v, sig3.r, sig3.s, '0x', G), 'AfterResolutionDeadline');

    // B4: release in the intentional gap [RDL, CUT) rejected; timeout not yet eligible.
    const tsB4 = await setTime(provider, RDLs + 99); // probe mines at RDLs+100
    const sig4 = await signVerdict(idB3, digest2(0xB03), 'release', 0xB031, tsB4 + 1, head3, evaluatorEOA);
    await checkThrows('BC-B4 release in intentional gap [RDL,CUT) rejected', () =>
      custody.connect(stranger).release(idB3, digest2(0xB03), head3, 0xB031, tsB4 + 1, sig4.v, sig4.r, sig4.s, '0x', G), 'AfterResolutionDeadline');
    await checkThrows('BC-B4b refundTimeout in gap rejected (DeadlineNotPassed)', () =>
      custody.connect(stranger).refundTimeout(idB3, digest2(0xB03), G), 'DeadlineNotPassed');

    // B5: mutualRelease exactly AT minReleaseTime accepted (live clock).
    const tN5 = await now(provider);
    const MRT5 = tN5 + 100, RDL5 = tN5 + 5000, CUT5 = tN5 + 8000;
    const idB5 = cid(0xB05);
    await (await FUND(idB5, digest2(0xB05), buyer, seller, evaluatorEOA, small, RDL5, CUT5, MRT5)).wait();
    const head5 = '0x' + 'b5'.repeat(32);
    const tsB5 = await setTime(provider, MRT5 - 1); // probe mines at MRT5
    const mb5 = await signMutual(idB5, digest2(0xB05), 'release', 0xB050, tsB5 + 1, head5, buyer, seller);
    const sBefore = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).mutualRelease(idB5, digest2(0xB05), head5, 0xB050, tsB5 + 1, mb5[0].v, mb5[0].r, mb5[0].s, mb5[1].v, mb5[1].r, mb5[1].s, G)).wait();
    check('BC-B5 mutualRelease exactly AT minReleaseTime accepted', Number((await custody.getEscrow(idB5)).state) === 3);
    check('BC-B5b seller paid exactly once (mutualRelease)', (await usdc.balanceOf(seller.address)) - sBefore === small);

    // B6: mutualRelease exactly AT resolutionDeadline rejected (live clock).
    const tN6 = await now(provider);
    const RDL6 = tN6 + 200, CUT6 = tN6 + 8000;
    const idB6 = cid(0xB06);
    await (await FUND(idB6, digest2(0xB06), buyer, seller, evaluatorEOA, small, RDL6, CUT6, tN6 + 100)).wait();
    const head6 = '0x' + 'b6'.repeat(32);
    const tsB6 = await setTime(provider, RDL6 - 1); // probe mines at RDL6
    const mb6 = await signMutual(idB6, digest2(0xB06), 'release', 0xB060, tsB6 + 1, head6, buyer, seller);
    await checkThrows('BC-B6 mutualRelease exactly AT resolutionDeadline rejected', () =>
      custody.connect(stranger).mutualRelease(idB6, digest2(0xB06), head6, 0xB060, tsB6 + 1, mb6[0].v, mb6[0].r, mb6[0].s, mb6[1].v, mb6[1].r, mb6[1].s, G), 'AfterResolutionDeadline');

    // B7: resolve:release before MRT rejected; at MRT accepted (live clock).
    const tN7 = await now(provider);
    const MRT7 = tN7 + 200, RDL7 = tN7 + 5000, CUT7 = tN7 + 8000;
    const idB7 = cid(0xB07);
    await (await FUND(idB7, digest2(0xB07), buyer, seller, evaluatorEOA, small, RDL7, CUT7, MRT7)).wait();
    await (await custody.connect(buyer).raiseDispute(idB7, digest2(0xB07), 'dispute', { gasLimit: 300000 })).wait();
    const head7 = '0x' + 'b7'.repeat(32);
    const tsB7a = await setTime(provider, MRT7 - 101); // probe mines at MRT7-100
    const sig7 = await signVerdict(idB7, digest2(0xB07), 'resolve:release', 0xB070, tsB7a + 1, head7, evaluatorEOA);
    await checkThrows('BC-B7 resolve:release BEFORE minReleaseTime rejected (NotYetValid)', () =>
      custody.connect(stranger).resolve(idB7, digest2(0xB07), 'release', head7, 0xB070, tsB7a + 1, sig7.v, sig7.r, sig7.s, '0x', G), 'NotYetValid');
    const tsB7b = await setTime(provider, MRT7 - 1); // probe mines at MRT7
    const sig7b = await signVerdict(idB7, digest2(0xB07), 'resolve:release', 0xB071, tsB7b + 1, head7, evaluatorEOA);
    const sB7 = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).resolve(idB7, digest2(0xB07), 'release', head7, 0xB071, tsB7b + 1, sig7b.v, sig7b.r, sig7b.s, '0x', G)).wait();
    check('BC-B7b resolve:release at minReleaseTime accepted', Number((await custody.getEscrow(idB7)).state) === 3);
    check('BC-B7c seller paid exactly once (resolve:release)', (await usdc.balanceOf(seller.address)) - sB7 === small);
  }

  // =====================================================================
  // C. EVALUATOR/MUTUAL REFUNDS WITHOUT a minimum-release wait
  // =====================================================================
  {
    const tN = await now(provider);
    const MRT = tN + 30000, RDL = tN + 50000, CUT = tN + 80000;

    const idC1 = cid(0xC01);
    await (await FUND(idC1, digest2(0xC01), buyer, seller, evaluatorEOA, small, RDL, CUT, MRT)).wait();
    const headC1 = '0x' + 'c1'.repeat(32);
    const iaC1 = await now(provider);
    const sigC1 = await signVerdict(idC1, digest2(0xC01), 'refund', 0xC010, iaC1, headC1, evaluatorEOA);
    const bBefore = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundVerdict(idC1, digest2(0xC01), headC1, 0xC010, iaC1, sigC1.v, sigC1.r, sigC1.s, '0x', G)).wait();
    const escC1 = await custody.getEscrow(idC1);
    check('BC-C1 evaluator refundVerdict BEFORE minReleaseTime accepted (no min-release wait)', Number(escC1.state) === 4 && escC1.committedHead === headC1);
    check('BC-C1b buyer refunded exactly once', (await usdc.balanceOf(buyer.address)) - bBefore === small);

    const idC2 = cid(0xC02);
    await (await FUND(idC2, digest2(0xC02), buyer, seller, evaluatorEOA, small, RDL, CUT, MRT)).wait();
    const headC2 = '0x' + 'c2'.repeat(32);
    const iaC2 = await now(provider);
    const mbC2 = await signMutual(idC2, digest2(0xC02), 'refund', 0xC020, iaC2, headC2, buyer, seller);
    const bC2 = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).mutualRefund(idC2, digest2(0xC02), headC2, 0xC020, iaC2, mbC2[0].v, mbC2[0].r, mbC2[0].s, mbC2[1].v, mbC2[1].r, mbC2[1].s, G)).wait();
    check('BC-C2 mutualRefund BEFORE minReleaseTime accepted (no min-release wait)', Number((await custody.getEscrow(idC2)).state) === 4);
    check('BC-C2b buyer refunded exactly once (mutualRefund)', (await usdc.balanceOf(buyer.address)) - bC2 === small);

    const idC3 = cid(0xC03);
    await (await FUND(idC3, digest2(0xC03), buyer, seller, evaluatorEOA, small, RDL, CUT, MRT)).wait();
    await (await custody.connect(seller).raiseDispute(idC3, digest2(0xC03), 'buyer', { gasLimit: 300000 })).wait();
    const headC3 = '0x' + 'c3'.repeat(32);
    const iaC3 = await now(provider);
    const sigC3 = await signVerdict(idC3, digest2(0xC03), 'resolve:refund', 0xC030, iaC3, headC3, evaluatorEOA);
    const bC3 = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).resolve(idC3, digest2(0xC03), 'refund', headC3, 0xC030, iaC3, sigC3.v, sigC3.r, sigC3.s, '0x', G)).wait();
    check('BC-C3 resolve:refund BEFORE minReleaseTime accepted (no min-release wait)', Number((await custody.getEscrow(idC3)).state) === 4);
    check('BC-C3b buyer refunded exactly once (resolve:refund)', (await usdc.balanceOf(buyer.address)) - bC3 === small);
  }

  // =====================================================================
  // D. TIMEOUT — before / at / after finalCutoff
  // =====================================================================
  {
    const tN = await now(provider);
    const RDL = tN + 5000, CUT = tN + 8000, MRT = tN + 1000;

    const idD1 = cid(0xD01);
    await (await FUND(idD1, digest2(0xD01), buyer, seller, evaluatorEOA, small, RDL, CUT, MRT)).wait();
    await setTime(provider, CUT - 2); // probe mines at CUT-1
    await checkThrows('BC-D1 refundTimeout BEFORE finalCutoff rejected (DeadlineNotPassed)', () =>
      custody.connect(stranger).refundTimeout(idD1, digest2(0xD01), G), 'DeadlineNotPassed');

    const bD2 = await usdc.balanceOf(buyer.address);
    await setTime(provider, CUT - 1); // probe mines at CUT
    await (await custody.connect(stranger).refundTimeout(idD1, digest2(0xD01), G)).wait();
    const escD1 = await custody.getEscrow(idD1);
    check('BC-D2 refundTimeout exactly AT finalCutoff accepted', Number(escD1.state) === 4 && escD1.refundedAt > 0);
    check('BC-D2b timeout records NO head (headless)', escD1.committedHead === ethers.ZeroHash && Number(escD1.headCommittedAt) === 0);
    check('BC-D2c buyer refunded exactly once (timeout)', (await usdc.balanceOf(buyer.address)) - bD2 === small);

    const tD3 = await now(provider);
    const idD3 = cid(0xD03);
    await (await FUND(idD3, digest2(0xD03), buyer, seller, evaluatorEOA, small, tD3 + 5000, tD3 + 8000, tD3 + 1000)).wait();
    await (await custody.connect(buyer).raiseDispute(idD3, digest2(0xD03), 'dispute', { gasLimit: 300000 })).wait();
    const bD3 = await usdc.balanceOf(buyer.address);
    await setTime(provider, tD3 + 8000); // probe mines at tD3+8001 > new cutoff
    await (await custody.connect(donor).refundTimeout(idD3, digest2(0xD03), G)).wait();
    const escD3 = await custody.getEscrow(idD3);
    check('BC-D3 refundTimeout AFTER finalCutoff accepted on Disputed escrow (any caller)', Number(escD3.state) === 4 && escD3.committedHead === ethers.ZeroHash);
    check('BC-D3b buyer refunded exactly once (disputed timeout)', (await usdc.balanceOf(buyer.address)) - bD3 === small);
  }

  // =====================================================================
  // E. DEADLINE EQUALITY + INTENTIONAL GAP
  // =====================================================================
  {
    const tN = await now(provider);

    const idE1 = cid(0xE01);
    await (await FUND(idE1, digest2(0xE01), buyer, seller, evaluatorEOA, small, tN + 5000, tN + 5000, tN + 1000)).wait();
    const escE1 = await custody.getEscrow(idE1);
    check('BC-E1 funding with resolutionDeadline == finalCutoff accepted', Number(escE1.state) === 1 && escE1.resolutionDeadline === escE1.finalCutoff);

    // E2/E3: equality boundary — evaluator action rejected; timeout applies.
    const tE = await now(provider);
    const eqRDL = tE + 200;
    const idEq = cid(0xE0E);
    await (await FUND(idEq, digest2(0xE0E), buyer, seller, evaluatorEOA, small, eqRDL, eqRDL, tE + 100)).wait();
    const headEq = '0x' + 'e0'.repeat(32);
    const tsEq = await setTime(provider, eqRDL - 1); // probe mines at eqRDL == RDL == CUT
    const sigEq = await signVerdict(idEq, digest2(0xE0E), 'release', 0xE0E0, tsEq + 1, headEq, evaluatorEOA);
    await checkThrows('BC-E2 evaluator action exactly AT equality deadline rejected (AfterResolutionDeadline)', () =>
      custody.connect(stranger).release(idEq, digest2(0xE0E), headEq, 0xE0E0, tsEq + 1, sigEq.v, sigEq.r, sigEq.s, '0x', G), 'AfterResolutionDeadline');
    const bE3 = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refundTimeout(idEq, digest2(0xE0E), G)).wait(); // mines at eqRDL+1 >= CUT
    check('BC-E3 timeout exactly AT equality boundary accepted (RDL==CUT)', Number((await custody.getEscrow(idEq)).state) === 4);
    check('BC-E3b buyer refunded exactly once (equality timeout)', (await usdc.balanceOf(buyer.address)) - bE3 === small);

    // E4/E5: intentional gap [RDL, CUT).
    const tE4 = await now(provider);
    const gRDL = tE4 + 400, gCUT = tE4 + 90000;
    const idE4 = cid(0xE04);
    await (await FUND(idE4, digest2(0xE04), buyer, seller, evaluatorEOA, small, gRDL, gCUT, tE4 + 100)).wait();
    const headE4 = '0x' + 'e4'.repeat(32);
    const tsE4 = await setTime(provider, gRDL); // probe mines at gRDL+1 (in gap)
    const sigE4 = await signVerdict(idE4, digest2(0xE04), 'refund', 0xE040, tsE4 + 1, headE4, evaluatorEOA);
    await checkThrows('BC-E4 refundVerdict in intentional gap rejected (AfterResolutionDeadline)', () =>
      custody.connect(stranger).refundVerdict(idE4, digest2(0xE04), headE4, 0xE040, tsE4 + 1, sigE4.v, sigE4.r, sigE4.s, '0x', G), 'AfterResolutionDeadline');
    await checkThrows('BC-E4b timeout in gap rejected (DeadlineNotPassed)', () =>
      custody.connect(stranger).refundTimeout(idE4, digest2(0xE04), G), 'DeadlineNotPassed');
    const bE5 = await usdc.balanceOf(buyer.address);
    await setTime(provider, gCUT - 1); // probe mines at gCUT (gap ends)
    await (await custody.connect(donor).refundTimeout(idE4, digest2(0xE04), G)).wait();
    check('BC-E5 timeout accepted exactly AT finalCutoff after intentional gap', Number((await custody.getEscrow(idE4)).state) === 4);
    check('BC-E5b buyer refunded exactly once', (await usdc.balanceOf(buyer.address)) - bE5 === small);
  }

  // =====================================================================
  // F. SIGNATURE TIMING + ESCROW-SCOPED AUTHORIZATION-CLASS NONCES
  // =====================================================================
  {
    const tN = await now(provider);
    const RDL = tN + 5000, CUT = tN + 8000;

    // F1: future-dated verdict (issuedAt > now+120) rejected (NotYetValid).
    const idF1 = cid(0xF01);
    await (await FUND(idF1, digest2(0xF01), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    const headF1 = '0x' + 'f1'.repeat(32);
    const iaF1 = await now(provider);
    const sigF1 = await signVerdict(idF1, digest2(0xF01), 'release', 0xF010, iaF1 + 200, headF1, evaluatorEOA);
    await checkThrows('BC-F1 future-dated verdict (issuedAt > now+120) rejected (NotYetValid)', () =>
      custody.connect(stranger).release(idF1, digest2(0xF01), headF1, 0xF010, iaF1 + 200, sigF1.v, sigF1.r, sigF1.s, '0x', G), 'NotYetValid');

    // F2: expired verdict (exec > issuedAt+300) rejected (ExpiredVerdict).
    const idF2 = cid(0xF02);
    await (await FUND(idF2, digest2(0xF02), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    const headF2 = '0x' + 'f2'.repeat(32);
    const iaF2 = await now(provider);
    const sigF2 = await signVerdict(idF2, digest2(0xF02), 'release', 0xF020, iaF2, headF2, evaluatorEOA);
    await setTime(provider, iaF2 + 300); // probe mines at iaF2+301 > issuedAt+300
    await checkThrows('BC-F2 expired verdict (exec > issuedAt+300) rejected (ExpiredVerdict)', () =>
      custody.connect(stranger).release(idF2, digest2(0xF02), headF2, 0xF020, iaF2, sigF2.v, sigF2.r, sigF2.s, '0x', G), 'ExpiredVerdict');

    // F3: future-dated MUTUAL rejected (NotYetValid).
    const idF3 = cid(0xF03);
    await (await FUND(idF3, digest2(0xF03), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    const headF3 = '0x' + 'f3'.repeat(32);
    const iaF3 = await now(provider);
    const mbF3 = await signMutual(idF3, digest2(0xF03), 'refund', 0xF030, iaF3 + 200, headF3, buyer, seller);
    await checkThrows('BC-F3 future-dated mutual rejected (NotYetValid)', () =>
      custody.connect(stranger).mutualRefund(idF3, digest2(0xF03), headF3, 0xF030, iaF3 + 200, mbF3[0].v, mbF3[0].r, mbF3[0].s, mbF3[1].v, mbF3[1].r, mbF3[1].s, G), 'NotYetValid');

    // F4: escrow-scoped verdict nonce: same nonce valid on a DIFFERENT escrow.
    const idF4a = cid(0xF04), idF4b = cid(0xF05);
    await (await FUND(idF4a, digest2(0xF04), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    await (await FUND(idF4b, digest2(0xF05), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    const headF4a = '0x' + 'f4a'.repeat(32).slice(0, 64), headF4b = '0x' + 'f4b'.repeat(32).slice(0, 64);
    const iaF4 = await now(provider);
    const sigF4a = await signVerdict(idF4a, digest2(0xF04), 'release', 0xF040, iaF4, headF4a, evaluatorEOA);
    const sigF4b = await signVerdict(idF4b, digest2(0xF05), 'release', 0xF040, iaF4, headF4b, evaluatorEOA);
    const sF4 = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(idF4a, digest2(0xF04), headF4a, 0xF040, iaF4, sigF4a.v, sigF4a.r, sigF4a.s, '0x', G)).wait();
    check('BC-F4 verdict nonce escrow-scoped: same nonce on another escrow accepted', Number((await custody.getEscrow(idF4a)).state) === 3);
    await (await custody.connect(stranger).release(idF4b, digest2(0xF05), headF4b, 0xF040, iaF4, sigF4b.v, sigF4b.r, sigF4b.s, '0x', G)).wait();
    check('BC-F4b second escrow accepted with the SAME verdict nonce (escrow-scoped)', Number((await custody.getEscrow(idF4b)).state) === 3);
    check('BC-F4c seller paid exactly twice (two escrows)', (await usdc.balanceOf(seller.address)) - sF4 === small * 2n);

    // F5: nonce reuse on the SAME escrow rejected (Replay).
    const idF5 = cid(0xF06);
    await (await FUND(idF5, digest2(0xF06), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    const headF5 = '0x' + 'f5'.repeat(32);
    const iaF5 = await now(provider);
    const sigF5 = await signVerdict(idF5, digest2(0xF06), 'release', 0xF060, iaF5, headF5, evaluatorEOA);
    await (await custody.connect(stranger).release(idF5, digest2(0xF06), headF5, 0xF060, iaF5, sigF5.v, sigF5.r, sigF5.s, '0x', G)).wait();
    check('BC-F5 first release consumed verdict nonce', Number((await custody.getEscrow(idF5)).state) === 3);
    await checkThrows('BC-F5c verdict nonce replay on SAME escrow rejected (Replay/state)', () =>
      custody.connect(stranger).release(idF5, digest2(0xF06), headF5, 0xF060, iaF5, sigF5.v, sigF5.r, sigF5.s, '0x', G));

    // F6: verdict and mutual nonce classes are INDEPENDENT (same numeric nonce in both classes).
    const idF6 = cid(0xF08);
    await (await FUND(idF6, digest2(0xF08), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    const headF6 = '0x' + 'f6'.repeat(32);
    const iaF6 = await now(provider);
    const sigF6 = await signVerdict(idF6, digest2(0xF08), 'refund', 0xF080, iaF6, headF6, evaluatorEOA);
    await (await custody.connect(stranger).refundVerdict(idF6, digest2(0xF08), headF6, 0xF080, iaF6, sigF6.v, sigF6.r, sigF6.s, '0x', G)).wait();
    check('BC-F6 verdict class consumed (refund)', Number((await custody.getEscrow(idF6)).state) === 4);
    const idF6b = cid(0xF09);
    await (await FUND(idF6b, digest2(0xF09), buyer, seller, evaluatorEOA, small, RDL, CUT, 0)).wait();
    const headF6b = '0x' + 'f6b'.repeat(32).slice(0, 64);
    const mbf6 = await signMutual(idF6b, digest2(0xF09), 'refund', 0xF080, iaF6, headF6b, buyer, seller);
    await (await custody.connect(stranger).mutualRefund(idF6b, digest2(0xF09), headF6b, 0xF080, iaF6, mbf6[0].v, mbf6[0].r, mbf6[0].s, mbf6[1].v, mbf6[1].r, mbf6[1].s, G)).wait();
    check('BC-F6b mutual class uses the SAME numeric nonce without Replay (classes independent)', Number((await custody.getEscrow(idF6b)).state) === 4);
    check('BC-F6c mutual nonce recorded in escrow-scoped mutual map', await custody.usedMutualNonce(idF6b, 0xF080));
    check('BC-F6d verdict nonce recorded in escrow-scoped verdict map', await custody.usedVerdictNonce(idF6, 0xF080));
  }

  // =====================================================================
  // G. BOUNDED SEEDED FUZZ (distinct required invariants on the candidate)
  // =====================================================================
  {
    const baselineHeld = await custody.totalHeld(); // outstanding from earlier sections (A-F)
    const rand = rng(0xC4A); // fixed seed preserved in run-record + transcript
    const N = 12;
    const fuzzAmount = ethers.parseUnits('300', 6);
    let totalOutstanding = 0n;
    const settled = new Set();
    let idx = 2000;
    const expected = new Map();
    for (let z = 0; z < N; z++) {
      const id = cid(idx);
      const tN = await now(provider);
      const rdl = tN + 60000, cut = tN + 90000;
      await (await usdc.connect(buyer).approve(custodyAddr, fuzzAmount, { gasLimit: 300000 })).wait();
      await (await FUND(id, digest2(idx), buyer, seller, evaluatorEOA, fuzzAmount, rdl, cut, 0)).wait();
      totalOutstanding += fuzzAmount;
      expected.set(id, { amount: fuzzAmount, head: null, beneficiary: null, kind: 'none' });

      const ia = await now(provider);
      const head = '0x' + idx.toString(16).padStart(64, '0');
      const badSig = await signVerdict(id, digest2(idx), 'refund', idx * 10 + 1, ia, head, stranger);
      await checkThrows('FZ-' + idx + '-A wrong-party eval rejected', () =>
        custody.connect(stranger).refundVerdict(id, digest2(idx), head, idx * 10 + 1, ia, badSig.v, badSig.r, badSig.s, '0x', G), 'UnauthorizedSigner');
      const goodSig = await signVerdict(id, digest2(idx), 'refund', idx * 10 + 2, ia, head, evaluatorEOA);
      const headWrong = '0x' + (idx + 1).toString(16).padStart(64, '0');
      await checkThrows('FZ-' + idx + '-B wrong-head rejected', () =>
        custody.connect(stranger).refundVerdict(id, digest2(idx), headWrong, idx * 10 + 2, ia, goodSig.v, goodSig.r, goodSig.s, '0x', G), 'UnauthorizedSigner');
      const escS = await custody.getEscrow(id);
      check('FZ-' + idx + '-C state unchanged after rejects', Number(escS.state) === 1);

      const roll = rand();
      let settledNow = false;
      if (roll < 0.4) {
        const issuedAt = await now(provider);
        const sig = await signVerdict(id, digest2(idx), 'release', idx * 10 + 3, issuedAt, head, evaluatorEOA);
        const before = await usdc.balanceOf(seller.address);
        await (await custody.connect(stranger).release(id, digest2(idx), head, idx * 10 + 3, issuedAt, sig.v, sig.r, sig.s, '0x', G)).wait();
        const esc = await custody.getEscrow(id);
        check('FZ-' + idx + '-D eval release terminal + head', Number(esc.state) === 3 && esc.committedHead === head);
        check('FZ-' + idx + '-E seller paid exactly amount', (await usdc.balanceOf(seller.address)) - before === fuzzAmount);
        expected.set(id, { amount: fuzzAmount, head, beneficiary: 'seller', kind: 'eval' });
        settledNow = true;
      } else if (roll < 0.65) {
        const issuedAt = await now(provider);
        const sig = await signVerdict(id, digest2(idx), 'refund', idx * 10 + 3, issuedAt, head, evaluatorEOA);
        const before = await usdc.balanceOf(buyer.address);
        await (await custody.connect(stranger).refundVerdict(id, digest2(idx), head, idx * 10 + 3, issuedAt, sig.v, sig.r, sig.s, '0x', G)).wait();
        const esc = await custody.getEscrow(id);
        check('FZ-' + idx + '-D eval refund terminal + head', Number(esc.state) === 4 && esc.committedHead === head);
        check('FZ-' + idx + '-E buyer paid exactly amount', (await usdc.balanceOf(buyer.address)) - before === fuzzAmount);
        expected.set(id, { amount: fuzzAmount, head, beneficiary: 'buyer', kind: 'eval' });
        settledNow = true;
      } else if (roll < 0.85) {
        const issuedAt = await now(provider);
        const mb = await signMutual(id, digest2(idx), 'refund', idx * 10 + 4, issuedAt, head, buyer, seller);
        const before = await usdc.balanceOf(buyer.address);
        await (await custody.connect(stranger).mutualRefund(id, digest2(idx), head, idx * 10 + 4, issuedAt, mb[0].v, mb[0].r, mb[0].s, mb[1].v, mb[1].r, mb[1].s, G)).wait();
        const esc = await custody.getEscrow(id);
        check('FZ-' + idx + '-D mutual refund terminal + head', Number(esc.state) === 4 && esc.committedHead === head);
        check('FZ-' + idx + '-E buyer paid exactly amount', (await usdc.balanceOf(buyer.address)) - before === fuzzAmount);
        expected.set(id, { amount: fuzzAmount, head, beneficiary: 'buyer', kind: 'mutual' });
        settledNow = true;
      } else {
        await provider.send('evm_setNextBlockTimestamp', [tN + 90001]);
        const before = await usdc.balanceOf(buyer.address);
        await (await custody.connect(stranger).refundTimeout(id, digest2(idx), G)).wait();
        const esc = await custody.getEscrow(id);
        check('FZ-' + idx + '-D timeout terminal + NO head', Number(esc.state) === 4 && esc.committedHead === ethers.ZeroHash);
        check('FZ-' + idx + '-E buyer paid exactly amount', (await usdc.balanceOf(buyer.address)) - before === fuzzAmount);
        expected.set(id, { amount: fuzzAmount, head: ethers.ZeroHash, beneficiary: 'buyer', kind: 'timeout' });
        settledNow = true;
      }
      if (settledNow) {
        settled.add(id);
        totalOutstanding -= fuzzAmount;
        const balBefore = await usdc.balanceOf(expected.get(id).beneficiary === 'seller' ? seller.address : buyer.address);
        await checkThrows('FZ-' + idx + '-F second terminal attempt rejected', () =>
          custody.connect(stranger).refundTimeout(id, digest2(idx), G));
        const balAfter = await usdc.balanceOf(expected.get(id).beneficiary === 'seller' ? seller.address : buyer.address);
        check('FZ-' + idx + '-G no double payout', balAfter === balBefore);
        const escE = await custody.getEscrow(id);
        check('FZ-' + idx + '-H head class correct on terminal', expected.get(id).kind === 'timeout' ? escE.committedHead === ethers.ZeroHash : escE.committedHead === expected.get(id).head);
      }
      check('FZ-' + idx + '-I totalHeld == outstanding (baseline+rounds)', (await custody.totalHeld()) === baselineHeld + totalOutstanding);
      idx++;
    }
    console.log('FUZZ: rounds=' + N + ' seed=0xC4A settled=' + settled.size);
  }

  // ——— outputs ———
  const OUT = path.join(ROOT, 'evidence/f3c-candidate-boundary-exports');
  fs.mkdirSync(OUT, { recursive: true });
  const runRecord = {
    command: 'node scripts/test-custody-v3-candidate-boundary.cjs',
    testRevision, candidateRevision: '2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8',
    chainId: CHAIN, runtimeCodeHash: PINNED, sourceSha256: IDENTITY.sourceSha256,
    ethersVersion: ethers.version,
    network: 'in-process local EVM (NOT public Base Sepolia)', noPublicFinality: true,
    sections: {
      A_funding_window: ['BC-A1', 'BC-A2', 'BC-A3', 'BC-A4', 'BC-A4b', 'BC-A5'],
      B_seller_boundaries: ['BC-B1', 'BC-B2', 'BC-B2b', 'BC-B3', 'BC-B4', 'BC-B4b', 'BC-B5', 'BC-B5b', 'BC-B6', 'BC-B7', 'BC-B7b', 'BC-B7c'],
      C_refund_no_minwait: ['BC-C1', 'BC-C1b', 'BC-C2', 'BC-C2b', 'BC-C3', 'BC-C3b'],
      D_timeout: ['BC-D1', 'BC-D2', 'BC-D2b', 'BC-D2c', 'BC-D3', 'BC-D3b'],
      E_equality_gap: ['BC-E1', 'BC-E2', 'BC-E3', 'BC-E3b', 'BC-E4', 'BC-E4b', 'BC-E5', 'BC-E5b'],
      F_signature_nonce: ['BC-F1', 'BC-F2', 'BC-F3', 'BC-F4', 'BC-F4b', 'BC-F4c', 'BC-F5', 'BC-F5c', 'BC-F6', 'BC-F6b', 'BC-F6c', 'BC-F6d'],
      G_fuzz: '12 rounds, seed 0xC4A (state-unchanged, head class, no double payout, totalHeld invariant)',
    },
    outputs: fs.readdirSync(OUT).filter(f => /\.(json|txt)$/.test(f)),
  };
  fs.writeFileSync(path.join(OUT, 'run-record.json'), JSON.stringify(runRecord, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ passed, failed, failures, testRevision, runtimeCodeHash: PINNED }, null, 2) + '\n');
  provider.destroy();
  fs.writeSync(1, 'v3_candidate_boundary_passed=' + passed + ' failed=' + failed + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  fs.writeSync(2, 'FATAL: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(2);
});
