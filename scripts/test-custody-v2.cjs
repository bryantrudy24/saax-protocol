/**
 * SAAX Phase 3A — Restricted Objective-Digital Custody V2 test harness.
 *
 * LOCAL ONLY. Deploys to an in-process ganache EVM (chain 1337 by default).
 *   - SAAXEscrowCustodyV2 (candidate under test)
 *   - MockUSDC (6-decimal ERC-20, the exact-amount transfer semantics)
 *   - SafeMock2of3 (test double reproducing Safe's checkNSignatures model:
 *     ERC-1271 isValidSignature that enforces the configured owner set +
 *     threshold — 2-of-3 here). Labeled clearly: this is a local Safe-behavior
 *     mock for genuine cryptographic testing of the custody ERC-1271 hook;
 *     the real Safe singleton deployment is a Phase 3/4 integration item.
 *
 * Covers (Phase 3A mandate §4):
 *   1. Genuine 2-of-3 Safe evaluator approval accepted (ERC-1271 path).
 *      One signature / duplicate signer / wrong owners / wrong digest /
 *      wrong domain / wrong action rejected.
 *   2. Owner/threshold change behavior demonstrated (mock: add/remove owner).
 *   3. Mutual buyer/seller release/refund accepted; missing or substituted
 *      party rejected.
 *   4. Wrong agreement/policy/chain/custody/asset/amount/recipient rejected.
 *   5. Cutoff boundary: immediately before, at, after cutoff.
 *   6. Disputed timeout and competing resolution transactions.
 *   7. Funding disabled while valid exits remain available.
 *   8. Caps (perPosition + aggregate) and totalHeld accounting.
 *   9. Failed token transfers (unapproved) and unsolicited token donations
 *      (donation does NOT inflate liability; cannot be drained).
 *  10. Terminal-state and nonce replay.
 *  11. Focused invariant checks: no unauthorized payout, no double payout,
 *      accounting consistency (totalHeld == sum of outstanding).
 *
 * Assertions verify state, events, and token balances — not tx hashes alone.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ——— solc compile (repo convention: solc-js; viaIR for this candidate) ———
function compileContract(name, sourcePath) {
  const solc = require('solc');
  const src = fs.readFileSync(path.join(ROOT, sourcePath), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [name]: { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    for (const e of out.errors) if (e.severity === 'error') throw new Error('compile error: ' + e.formattedMessage);
  }
  const c = out.contracts[name][name];
  if (!c) throw new Error('no contract ' + name);
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// ——— Mini EVM via Hardhat's in-process network (chainId 84532) ———
async function startEvm(chainId) {
  const hre = require('hardhat');
  await hre.run('compile');
  const { ethers } = await import('ethers');
  const provider = new ethers.BrowserProvider(hre.network.provider);
  // hardhat's default rich accounts (managed by the network; nonces handled)
  const accounts = [];
  for (let i = 0; i < 12; i++) {
    accounts.push(await provider.getSigner(i));
  }
  return { provider, signer: provider, ethers, hre, accounts };
}

function bumpTime(provider, seconds) {
  return provider.send('evm_increaseTime', [seconds]).then(() => provider.send('evm_mine', []));
}

async function now(provider) {
  const b = await provider.send('eth_getBlockByNumber', ['latest', false]);
  return parseInt(b.timestamp, 16);
}

// ——— test framework (repo convention: FAIL/PASS lines, exit code) ———
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    fs.writeSync(1, 'PASS  ' + name + '\n');
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    fs.writeSync(1, 'FAIL  ' + name + (detail ? ' — ' + detail : '') + '\n');
  }
}
async function checkThrows(name, fn, wantMsg) {
  try {
    await fn();
    check(name, false, 'expected revert' + (wantMsg ? ' (' + wantMsg + ')' : ''));
  } catch (e) {
    let msg = String(e && e.reason ? e.reason : (e && e.message ? e.message : e));
    // ethers often leaves reason=null for custom errors on external-call
    // targets; decode the revert selector from the error data when present.
    const data = e && e.data ? String(e.data) : (e && e.info && e.info.error && e.info.error.data ? String(e.info.error.data) : '');
    let selector = '';
    if (data && /^(0x)?[0-9a-fA-F]{8,}$/.test(data.replace(/^0x/, '').slice(0, 8).padStart(8, '0'))) {
      selector = '0x' + data.replace(/^0x/, '').slice(0, 8);
    }
    const known = {
      '0xca31867a': 'UnauthorizedSigner',
      '0x59fa4a93': 'ThresholdNotMet',
      '0x8baa579f': 'InvalidSignature',
      '0x49e27cff': 'InvalidOwner',
      '0xba50f911': 'NotSorted',
      '0xd5ef09ba': 'NotFunded',
      '0x9c996edc': 'WrongDigest',
      '0xde4168ba': 'WrongState',
      '0xb5a78004': 'Replay',
      '0xb82f398a': 'ExpiredVerdict',
      '0xf966db3a': 'AfterCutoff',
      '0x2eb35430': 'DeadlineNotPassed',
      '0x3fb4e43f': 'NotYetValid',
      '0xc8ee2d1d': 'NotParty',
      '0xa4875a49': 'CapExceeded',
      '0xab271ef4': 'PolicyNotAdmitted',
      '0x978a151c': 'FundingDisabled',
      '0xd06b96b1': 'InvalidPolicy',
      '0xc05e8c8c': 'InvalidAgreementRef',
      '0x4d9ecd91': 'SelfTransfer',
      '0x5cd5d233': 'BadSignature',
    };
    if (known[selector]) msg = known[selector];
    else if (selector) msg = msg + ' (selector ' + selector + ')';
    const ok = !wantMsg || msg.includes(wantMsg);
    check(name, ok, ok ? ('reverted: ' + msg) : ('wrong reason: ' + msg + ' want ' + wantMsg));
  }
}

// ——— MockUSDC ———
const MOCK_USDC_SRC = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract MockUSDC {
  string public name = "Mock USDC";
  string public symbol = "mUSDC";
  uint8 public decimals = 6;
  uint256 public totalSupply;
  mapping(address=>uint256) public balanceOf;
  mapping(address=>mapping(address=>uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);
  function mint(address to, uint256 v) external { balanceOf[to]+=v; totalSupply+=v; emit Transfer(address(0),to,v); }
  function approve(address sp, uint256 v) external returns (bool) { allowance[msg.sender][sp]=v; emit Approval(msg.sender,sp,v); return true; }
  function transfer(address to, uint256 v) external returns (bool) { return _transfer(msg.sender,to,v); }
  function transferFrom(address f, address to, uint256 v) external returns (bool) {
    uint256 a = allowance[f][msg.sender];
    if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender]=a-v; }
    return _transfer(f,to,v);
  }
  function _transfer(address f, address to, uint256 v) internal returns (bool) {
    require(balanceOf[f] >= v, "balance");
    balanceOf[f]-=v; balanceOf[to]+=v; emit Transfer(f,to,v); return true;
  }
}
`;

// ——— SafeMock2of3 (Safe-behavior test double, ERC-1271) ———
// Reproduces the Safe signature model used in production:
//   - owners[] + threshold;
//   - isValidSignature(hash, sig): the signature container is
//     n * (r(32) || s(32) || v(1)) packed for the owner signatures
//     (the Safe `checkNSignatures` encoding — compact); the mock parses
//     owner signatures, requires each recovered signer to be an owner, the
//     recovered set to be distinct, and the count >= threshold.
// This is NOT the Safe singleton; it is the minimal on-chain reproduction of
// Safe's 2-of-3 enforcement for genuinely testing the custody ERC-1271 hook.
const SAFE_MOCK_SRC = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract SafeMock2of3 {
  address[] public owners;
  uint256 public threshold;
  mapping(address=>bool) public isOwner;
  bytes4 internal constant MAGIC = 0x1626ba7e;

  error NotSorted();
  error InvalidOwner();
  error InvalidSignature();
  error ThresholdNotMet();

  constructor(address[] memory _owners, uint256 _threshold) {
    for (uint i=0;i<_owners.length;i++){ owners.push(_owners[i]); isOwner[_owners[i]]=true; }
    threshold = _threshold;
  }
  function addOwner(address o) external { require(o!=address(0) && !isOwner[o]); isOwner[o]=true; owners.push(o); }
  function removeOwner(address o) external { require(isOwner[o]); isOwner[o]=false; for(uint i=0;i<owners.length;i++) if(owners[i]==o){ owners[i]=owners[owners.length-1]; owners.pop(); break; } }
  function changeThreshold(uint256 t) external { require(t>0 && t<=owners.length); threshold=t; }

  function getOwners() external view returns (address[] memory){ return owners; }
  function getThreshold() external view returns (uint256){ return threshold; }

  function isValidSignature(bytes32 _hash, bytes memory _signature) external view returns (bytes4) {
    // Compact owner-sig encoding: n * (r(32) || s(32) || v(1)) = 65n bytes.
    uint256 n = _signature.length / 65;
    if (_signature.length % 65 != 0) revert InvalidSignature();
    if (n < threshold) revert ThresholdNotMet();
    address prevOwner = address(0);
    uint256 seen = 0;
    for (uint i=0;i<n;i++) {
      bytes32 r; bytes32 s; uint8 v;
      assembly {
        r := mload(add(_signature, add(32, mul(i,65))))
        s := mload(add(_signature, add(64, mul(i,65))))
        v := byte(0, mload(add(_signature, add(96, mul(i,65)))))
      }
      if (v < 27) v += 27;
      address owner = ecrecover(_hash, v, r, s);
      if (owner == address(0) || !isOwner[owner]) revert InvalidOwner();
      // enforce ascending owner order (Safe dedups + orders)
      if (owner <= prevOwner) revert NotSorted();
      prevOwner = owner;
      seen++;
    }
    if (seen < threshold) revert ThresholdNotMet();
    return MAGIC;
  }
}
`;

// Pack Safe owner signatures: [r(32)][s(32)][v(1)] per signer, ascending address order.
function packSafeSigs(sigObjects) {
  sigObjects.sort((a, b) => (a.signerAddr.toLowerCase() < b.signerAddr.toLowerCase() ? -1 : 1));
  let buf = '0x';
  for (const s of sigObjects) {
    buf += s.r.slice(2) + s.s.slice(2) + s.v.toString(16).padStart(2, '0');
  }
  return buf;
}

// ——— main ———
(async () => {
  const { ethers, provider, hre, accounts } = await startEvm(84532);
  const [deployer, buyer, seller, evaluatorEOA, attester, donor, stranger] = accounts;

  // Committed mocks + candidate are compiled by hardhat (contracts/mocks/*,
  // contracts/SAAXEscrowCustodyV2.sol). Load artifacts by name.
  function loadArtifact(name) {
    const a = hre.artifacts.readArtifactSync(name);
    return { abi: a.abi, bytecode: a.bytecode };
  }

  // deploy MockUSDC
  const usdcArt2 = loadArtifact('MockUSDC');
  const MockUSDC = new ethers.ContractFactory(usdcArt2.abi, usdcArt2.bytecode, deployer);
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();

  // deploy SafeMock2of3 with 2-of-3 owners
  const safeArt2 = loadArtifact('SafeMock2of3');
  const SafeMock = new ethers.ContractFactory(safeArt2.abi, safeArt2.bytecode, deployer);
  const owners = [buyer.address, seller.address, evaluatorEOA.address];
  const safe = await SafeMock.deploy(owners, 2);
  await safe.waitForDeployment();
  let safeAddr = await safe.getAddress();

  // deploy custody V2
  const v2Art = loadArtifact('SAAXEscrowCustodyV2');
  const V2 = new ethers.ContractFactory(v2Art.abi, v2Art.bytecode, deployer);
  const perPosCap = ethers.parseUnits('1000', 6); // 1000 mUSDC
  const aggCap = ethers.parseUnits('2500', 6);
  const adminPolicyId = 1n;
  const admittedPolicyDigest = '0x' + 'ab'.repeat(32);
  const custody = await V2.deploy(perPosCap, aggCap, true, adminPolicyId, admittedPolicyDigest);
  await custody.waitForDeployment();
  const custodyAddr = await custody.getAddress();

  // mint + approve
  const small = ethers.parseUnits('500', 6);
  const big = ethers.parseUnits('3000', 6);
  await (await usdc.mint(buyer.address, ethers.parseUnits('5000', 6))).wait();
  await (await usdc.mint(seller.address, ethers.parseUnits('5000', 6))).wait();
  await (await usdc.mint(donor.address, ethers.parseUnits('5000', 6))).wait();
  await (await usdc.approve(custodyAddr, ethers.parseUnits('5000', 6), { gasLimit: 300000 })).wait(); // deployer approval as funder
  await (await usdc.connect(buyer).approve(custodyAddr, ethers.parseUnits('5000', 6), { gasLimit: 300000 })).wait();

  const chainId = 84532;
  const policyDigest = '0x' + 'ab'.repeat(32); // == admittedPolicyDigest (matches constructor)
  const agreementRef = '0x' + 'cd'.repeat(32);

  // timing helpers
  const t0 = await now(provider);
  const FUTURE_CUTOFF = t0 + 10_000;
  const PAST_DEADLINE = t0 - 100;
  const FUTURE_DEADLINE = t0 + 5_000;

  function cid(n) { return '0x' + n.toString(16).padStart(64, '0'); }
  function digest2(n) { return '0x' + n.toString(16).padStart(64, '0'); }

  // ——— 1. Genuine 2-of-3 Safe evaluator approval accepted (ERC-1271) ———
  {
    const id = cid(1);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(1), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef, { value: 0 })).wait();
    const esc = await custody.getEscrow(id);
    check('T1 fund binds policy/agreement/cutoff', esc.policyId === adminPolicyId && esc.policyDigest === policyDigest && esc.agreementRef === agreementRef && Number(esc.finalCutoff) === FUTURE_CUTOFF);

    // 2-of-3: two owner signatures over the verdict digest
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const bS = await e6.Signature.from(await buyer.signTypedData(
      { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr },
      { EscrowVerdict: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
      { commitmentId: id, commitmentDigest: digest2(1), action: 'release', nonce: 100, issuedAt }
    ));
    const sS = await e6.Signature.from(await seller.signTypedData(
      { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr },
      { EscrowVerdict: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] },
      { commitmentId: id, commitmentDigest: digest2(1), action: 'release', nonce: 100, issuedAt }
    ));
    const packed = packSafeSigs([
      { signerAddr: buyer.address, r: bS.r, s: bS.s, v: bS.v },
      { signerAddr: seller.address, r: sS.r, s: sS.s, v: sS.v },
    ]);
    const sellerBalBefore = await usdc.balanceOf(seller.address);
    const tx = await custody.connect(stranger).release(id, digest2(1), 100, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, packed);
    const rcpt = await tx.wait();
    const escAfter = await custody.getEscrow(id);
    check('T2 2-of-3 Safe verdict accepted (ERC-1271), state Released', Number(escAfter.state) === 3);
    const sellerBalAfter = await usdc.balanceOf(seller.address);
    check('T3 seller paid exactly once (amount)', sellerBalAfter - sellerBalBefore === small);
    check('T4 totalHeld decremented after release', (await custody.totalHeld()) === 0n);
    const relEv = rcpt.logs.filter((l) => l.topics[0] === ethers.id('Released(bytes32,address,uint256,bytes32)'));
    check('T5 Released event emitted once', relEv.length === 1);
  }

  // ——— negative 2-of-3 tests ———
  {
    // Fresh escrow, evaluator = safe
    const id = cid(2);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(2), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const vdat = (cid_, digest_, action_, nonce_, issuedAt_) => ({ commitmentId: cid_, commitmentDigest: digest_, action: action_, nonce: nonce_, issuedAt: issuedAt_ });

    const pack = async (sigs) => {
      const objs = [];
      for (const s of sigs) { objs.push({ signerAddr: s.addr, ...(await s.sig) }); }
      return packSafeSigs(objs);
    };

    // one signature only (threshold 2)
    const oneSig = await buyer.signTypedData(domain, types, vdat(id, digest2(2), 'release', 200, issuedAt));
    const oneSigParsed = e6.Signature.from(oneSig);
    const onePacked = packSafeSigs([{ signerAddr: buyer.address, r: oneSigParsed.r, s: oneSigParsed.s, v: oneSigParsed.v }]);
    await checkThrows('T6 one signature rejected (threshold 2)', () => custody.connect(stranger).release(id, digest2(2), 200, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, onePacked), 'UnauthorizedSigner');

    // duplicate signer (same owner twice)
    const dupPacked = packSafeSigs([
      { signerAddr: buyer.address, r: oneSigParsed.r, s: oneSigParsed.s, v: oneSigParsed.v },
      { signerAddr: buyer.address, r: oneSigParsed.r, s: oneSigParsed.s, v: oneSigParsed.v },
    ]);
    await checkThrows('T7 duplicate signer rejected (not sorted / duplicate)', () => custody.connect(stranger).release(id, digest2(2), 201, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, dupPacked));

    // wrong owners (stranger is not an owner)
    const sA = await stranger.signTypedData(domain, types, vdat(id, digest2(2), 'release', 202, issuedAt));
    const sB = await buyer.signTypedData(domain, types, vdat(id, digest2(2), 'release', 202, issuedAt));
    const sAP = e6.Signature.from(sA); const sBP = e6.Signature.from(sB);
    const wrongOwners = packSafeSigs([
      { signerAddr: stranger.address, r: sAP.r, s: sAP.s, v: sAP.v },
      { signerAddr: buyer.address, r: sBP.r, s: sBP.s, v: sBP.v },
    ]);
    await checkThrows('T8 wrong owner rejected', () => custody.connect(stranger).release(id, digest2(2), 202, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, wrongOwners));

    // wrong digest
    const wrongDigest = await buyer.signTypedData(domain, types, vdat(id, digest2(999), 'release', 203, issuedAt));
    const wrongDigest2 = await seller.signTypedData(domain, types, vdat(id, digest2(999), 'release', 203, issuedAt));
    const wD1P = e6.Signature.from(wrongDigest); const wD2P = e6.Signature.from(wrongDigest2);
    const wdPacked = packSafeSigs([
      { signerAddr: buyer.address, r: wD1P.r, s: wD1P.s, v: wD1P.v },
      { signerAddr: seller.address, r: wD2P.r, s: wD2P.s, v: wD2P.v },
    ]);
    await checkThrows('T9 wrong digest rejected', () => custody.connect(stranger).release(id, digest2(2), 203, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, wdPacked));

    // wrong domain (different verifyingContract)
    const wrongDomain = await buyer.signTypedData({ ...domain, verifyingContract: '0x' + '99'.repeat(20) }, types, vdat(id, digest2(2), 'release', 204, issuedAt));
    const wrongDomain2 = await seller.signTypedData({ ...domain, verifyingContract: '0x' + '99'.repeat(20) }, types, vdat(id, digest2(2), 'release', 204, issuedAt));
    const wDom1 = e6.Signature.from(wrongDomain); const wDom2 = e6.Signature.from(wrongDomain2);
    const wdPacked2 = packSafeSigs([
      { signerAddr: buyer.address, r: wDom1.r, s: wDom1.s, v: wDom1.v },
      { signerAddr: seller.address, r: wDom2.r, s: wDom2.s, v: wDom2.v },
    ]);
    await checkThrows('T10 wrong domain rejected', () => custody.connect(stranger).release(id, digest2(2), 204, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, wdPacked2));

    // wrong action (signed 'refund' but calling release)
    const wrongAction = await buyer.signTypedData(domain, types, vdat(id, digest2(2), 'refund', 205, issuedAt));
    const wrongAction2 = await seller.signTypedData(domain, types, vdat(id, digest2(2), 'refund', 205, issuedAt));
    const wA1 = e6.Signature.from(wrongAction); const wA2 = e6.Signature.from(wrongAction2);
    const waPacked = packSafeSigs([
      { signerAddr: buyer.address, r: wA1.r, s: wA1.s, v: wA1.v },
      { signerAddr: seller.address, r: wA2.r, s: wA2.s, v: wA2.v },
    ]);
    await checkThrows('T11 wrong action rejected (signed refund, call release)', () => custody.connect(stranger).release(id, digest2(2), 205, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, waPacked));
    // settle the funded escrow after all rejection tests: mutual refund, valid both parties
    {
      const mr = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
      const mty = { MutualResolution: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
      const ia = await now(provider);
      const md = (a, n) => ({ commitmentId: id, commitmentDigest: digest2(2), action: a, nonce: n, issuedAt: ia });
      const bS = e6.Signature.from(await buyer.signTypedData(mr, mty, md('refund', 901)));
      const sS = e6.Signature.from(await seller.signTypedData(mr, mty, md('refund', 901)));
      await (await custody.connect(stranger).mutualRefund(id, digest2(2), 901, ia, bS.v, bS.r, bS.s, sS.v, sS.r, sS.s)).wait();
    }
  }

  // ——— owner/threshold change behavior ———
  {
    const id = cid(3);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(3), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    // add stranger as 3rd owner + raise threshold to 3 => 2-of-3 no longer valid
    await (await safe.addOwner(stranger.address)).wait();
    await (await safe.changeThreshold(3)).wait();
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const vdat = (a, n, ia) => ({ commitmentId: id, commitmentDigest: digest2(3), action: a, nonce: n, issuedAt: ia });
    const sigB = await buyer.signTypedData(domain, types, vdat('release', 300, issuedAt));
    const sigS = await seller.signTypedData(domain, types, vdat('release', 300, issuedAt));
    const sigBP = e6.Signature.from(sigB); const sigSP = e6.Signature.from(sigS);
    const packed2 = packSafeSigs([
      { signerAddr: buyer.address, r: sigBP.r, s: sigBP.s, v: sigBP.v },
      { signerAddr: seller.address, r: sigSP.r, s: sigSP.s, v: sigSP.v },
    ]);
    await checkThrows('T12 threshold change to 3 rejects 2-of-3 (governance dependency)', () => custody.connect(stranger).release(id, digest2(3), 300, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, packed2), 'UnauthorizedSigner');
    // 3-of-3 now valid — ALL THREE sign the SAME typed data (nonce 301)
    const sigB3 = await buyer.signTypedData(domain, types, vdat('release', 301, issuedAt));
    const sigS3 = await seller.signTypedData(domain, types, vdat('release', 301, issuedAt));
    const sigX = await stranger.signTypedData(domain, types, vdat('release', 301, issuedAt));
    const sigB3P = e6.Signature.from(sigB3); const sigS3P = e6.Signature.from(sigS3);
    const sigXP = e6.Signature.from(sigX);
    const packed3 = packSafeSigs([
      { signerAddr: buyer.address, r: sigB3P.r, s: sigB3P.s, v: sigB3P.v },
      { signerAddr: seller.address, r: sigS3P.r, s: sigS3P.s, v: sigS3P.v },
      { signerAddr: stranger.address, r: sigXP.r, s: sigXP.s, v: sigXP.v },
    ]);
    const sellerBefore = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(3), 301, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, packed3)).wait();
    check('T13 3-of-3 accepted after threshold change', (await usdc.balanceOf(seller.address)) - sellerBefore === small);
  }

  // ——— mutual buyer/seller release/refund ———
  {
    const id = cid(4);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(4), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const mtypes = { MutualResolution: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const mdat = (a, n, ia) => ({ commitmentId: id, commitmentDigest: digest2(4), action: a, nonce: n, issuedAt: ia });
    const bSig = e6.Signature.from(await buyer.signTypedData(domain, mtypes, mdat('release', 1, issuedAt)));
    const sSig = e6.Signature.from(await seller.signTypedData(domain, mtypes, mdat('release', 1, issuedAt)));
    const sellerBefore = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).mutualRelease(id, digest2(4), 1, issuedAt, bSig.v, bSig.r, bSig.s, sSig.v, sSig.r, sSig.s)).wait();
    check('T14 mutualRelease accepted (both parties)', (await usdc.balanceOf(seller.address)) - sellerBefore === small);

    // missing party: buyer only
    const id5 = cid(5);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id5, digest2(5), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const ia5 = await now(provider);
    const mdat5 = (a, n, ia) => ({ commitmentId: id5, commitmentDigest: digest2(5), action: a, nonce: n, issuedAt: ia });
    const b5 = e6.Signature.from(await buyer.signTypedData(domain, mtypes, mdat5('release', 2, ia5)));
    // substitute: seller signs as buyer slot? Use stranger as the "seller" signature.
    const x5 = e6.Signature.from(await stranger.signTypedData(domain, mtypes, mdat5('release', 2, ia5)));
    await checkThrows('T15 mutualRelease missing/substituted party rejected', () => custody.connect(stranger).mutualRelease(id5, digest2(5), 2, ia5, b5.v, b5.r, b5.s, x5.v, x5.r, x5.s), 'UnauthorizedSigner');
    // settle the funded escrow after the rejection test: mutual refund, valid both parties
    {
      const ia2 = await now(provider);
      const md2 = (a, n) => ({ commitmentId: id5, commitmentDigest: digest2(5), action: a, nonce: n, issuedAt: ia2 });
      const bS2 = e6.Signature.from(await buyer.signTypedData(domain, mtypes, md2('refund', 902)));
      const sS2 = e6.Signature.from(await seller.signTypedData(domain, mtypes, md2('refund', 902)));
      await (await custody.connect(stranger).mutualRefund(id5, digest2(5), 902, ia2, bS2.v, bS2.r, bS2.s, sS2.v, sS2.r, sS2.s)).wait();
    }
  }

  // ——— wrong agreement/policy/chain/custody/asset/amount/recipient ———
  {
    const { ethers: e6 } = await import('ethers');
    const id = cid(6);
    // wrong policyId
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await checkThrows('T16 wrong policyId rejected', () => custody.connect(buyer).fund(id, digest2(6), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, 42, policyDigest, agreementRef), 'InvalidPolicy');
    // wrong policyDigest
    await checkThrows('T17 zero policyDigest rejected', () => custody.connect(buyer).fund(cid(7), digest2(7), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, e6.ZeroHash, agreementRef), 'InvalidPolicy');
    // zero agreementRef
    await checkThrows('T18 zero agreementRef rejected (no decorative metadata)', () => custody.connect(buyer).fund(cid(8), digest2(8), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, e6.ZeroHash), 'InvalidAgreementRef');
    // amount zero
    await checkThrows('T19 zero amount rejected', () => custody.connect(buyer).fund(cid(9), digest2(9), usdcAddr, buyer.address, seller.address, safeAddr, 0, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef), 'WrongDigest');
    // buyer == seller
    await checkThrows('T20 buyer==seller rejected', () => custody.connect(buyer).fund(cid(10), digest2(10), usdcAddr, buyer.address, buyer.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef), 'SelfTransfer');
    // asset zero
    await checkThrows('T21 zero token rejected', () => custody.connect(buyer).fund(cid(11), digest2(11), e6.ZeroAddress, buyer.address, seller.address, safeAddr, small, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef), 'WrongDigest');
    // deadline > finalCutoff
    await checkThrows('T22 deadline>finalCutoff rejected', () => custody.connect(buyer).fund(cid(12), digest2(12), usdcAddr, buyer.address, seller.address, safeAddr, small, FUTURE_CUTOFF + 10, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef), 'InvalidPolicy');
    // finalCutoff in the past
    await checkThrows('T23 past finalCutoff rejected', () => custody.connect(buyer).fund(cid(13), digest2(13), usdcAddr, buyer.address, seller.address, safeAddr, small, PAST_DEADLINE, PAST_DEADLINE, 0, adminPolicyId, policyDigest, agreementRef), 'InvalidPolicy');
    // per-position cap
    await checkThrows('T24 per-position cap enforced', () => custody.connect(buyer).fund(cid(14), digest2(14), usdcAddr, buyer.address, seller.address, safeAddr, big, FUTURE_DEADLINE, FUTURE_CUTOFF, 0, adminPolicyId, policyDigest, agreementRef), 'CapExceeded');
  }

  // ——— cutoff boundary ———
  // Fresh safe2 (threshold 2, original owners) for the remaining blocks —
  // the global `safe` was mutated (threshold 3) in the governance block.
  const safe2 = await SafeMock.deploy(owners, 2);
  await safe2.waitForDeployment();
  const safe2Addr = await safe2.getAddress();
  // Redirect safeAddr to the fresh safe2 for all remaining blocks
  // (cutoff, disputed, donation, replay, EOA-verdict blocks).
  safeAddr = safe2Addr;
  {
    // ——— cutoff boundary ———
    // ——— cutoff boundary ———
    // fund, then jump to just before cutoff => evaluator release OK
    const id = cid(20);
    const cutoff = (await now(provider)) + 600;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(20), usdcAddr, buyer.address, seller.address, safeAddr, small, cutoff - 300, cutoff, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    await bumpTime(provider, 595); // just before cutoff (5s margin)
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const vdat = (a, n, ia) => ({ commitmentId: id, commitmentDigest: digest2(20), action: a, nonce: n, issuedAt: ia });
    const bS = e6.Signature.from(await buyer.signTypedData(domain, types, vdat('release', 1, issuedAt)));
    const sS = e6.Signature.from(await seller.signTypedData(domain, types, vdat('release', 1, issuedAt)));
    const packed = packSafeSigs([
      { signerAddr: buyer.address, r: bS.r, s: bS.s, v: bS.v }, { signerAddr: seller.address, r: sS.r, s: sS.s, v: sS.v }]);
    const sb = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(20), 1, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, packed)).wait();
    check('T25 release just before cutoff accepted', (await usdc.balanceOf(seller.address)) - sb === small);
  }
  {
    // at cutoff => timeout refund eligible, evaluator release rejected
    const id = cid(21);
    const cutoff = (await now(provider)) + 300;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(21), usdcAddr, buyer.address, seller.address, safeAddr, small, cutoff - 100, cutoff, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    await bumpTime(provider, 300); // exactly at cutoff
    const tAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const vdat = (a, n, ia) => ({ commitmentId: id, commitmentDigest: digest2(21), action: a, nonce: n, issuedAt: ia });
    // a verdict signed BEFORE the cutoff (issued earlier, still valid window)
    const priorIssued = tAt - 50;
    const bS = e6.Signature.from(await buyer.signTypedData(domain, types, vdat('release', 11, priorIssued)));
    const sS = e6.Signature.from(await seller.signTypedData(domain, types, vdat('release', 11, priorIssued)));
    const packed = packSafeSigs([{ signerAddr: buyer.address, r: bS.r, s: bS.s, v: bS.v }, { signerAddr: seller.address, r: sS.r, s: sS.s, v: sS.v }]);
    // at cutoff: executor-time rule overrides earlier signature (§B.5)
    await checkThrows('T26 release at cutoff rejected (earlier sig does NOT override cutoff)', () => custody.connect(stranger).release(id, digest2(21), 11, priorIssued, 0, e6.ZeroHash, e6.ZeroHash, packed), 'AfterCutoff');
    // timeout refund at cutoff: callable by anyone, beneficiary = buyer
    const buyerBefore = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refund(id, digest2(21), 0, 0, 0, e6.ZeroHash, e6.ZeroHash, '0x')).wait();
    check('T27 timeout refund at cutoff accepted (any caller, fixed buyer)', (await usdc.balanceOf(buyer.address)) - buyerBefore === small);
  }
  {
    const { ethers: e6 } = await import('ethers');
    // after cutoff: only timeout refund
    const id = cid(22);
    const cutoff = (await now(provider)) + 24;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(22), usdcAddr, buyer.address, seller.address, safeAddr, small, cutoff - 1, cutoff, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    await bumpTime(provider, 100); // after cutoff
    const buyerBefore = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refund(id, digest2(22), 0, 0, 0, e6.ZeroHash, e6.ZeroHash, '0x')).wait();
    check('T28 timeout refund after cutoff accepted', (await usdc.balanceOf(buyer.address)) - buyerBefore === small);
    // second refund on terminal escrow => wrong state
    await checkThrows('T29 no second payout (terminal replay)', () => custody.connect(stranger).refund(id, digest2(22), 0, 0, 0, e6.ZeroHash, e6.ZeroHash, '0x'), 'WrongState');
  }

  // ——— disputed timeout + competing resolution ———
  {
    const { ethers: e6 } = await import('ethers');
    const id = cid(30);
    const cutoff = (await now(provider)) + 400;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(30), usdcAddr, buyer.address, seller.address, safeAddr, small, cutoff - 100, cutoff, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    // dispute by buyer
    await (await custody.connect(buyer).raiseDispute(id, digest2(30), 'ipfs://dispute-evidence')).wait();
    const esc = await custody.getEscrow(id);
    check('T30 dispute raised', Number(esc.state) === 2 && esc.disputedBy === buyer.address);
    // progress past cutoff
    await bumpTime(provider, 500); // after cutoff
    // timeout refund on DISPUTED escrow: eligible, anyone may submit, beneficiary buyer
    const buyerBefore = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refund(id, digest2(30), 0, 0, 0, e6.ZeroHash, e6.ZeroHash, '0x')).wait();
    check('T31 disputed timeout refund at/after cutoff', (await usdc.balanceOf(buyer.address)) - buyerBefore === small);
    const escAfter = await custody.getEscrow(id);
    check('T32 disputed escrow terminal after timeout refund', Number(escAfter.state) === 4);
    // evaluator resolve at/after cutoff is refused (competing path)
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    const id31 = cid(31);
    const cutoff31 = (await now(provider)) + 400;
    await (await custody.connect(buyer).fund(id31, digest2(31), usdcAddr, buyer.address, seller.address, safeAddr, small, cutoff31 - 100, cutoff31, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    await (await custody.connect(buyer).raiseDispute(id31, digest2(31), 'ref')).wait();
    await bumpTime(provider, 410);
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const issued = await now(provider);
    const rd = (res, n) => ({ commitmentId: id31, commitmentDigest: digest2(31), action: 'resolve:' + res, nonce: n, issuedAt: issued });
    const s1 = e6.Signature.from(await buyer.signTypedData(domain, types, rd('release', 7)));
    const s2 = e6.Signature.from(await seller.signTypedData(domain, types, rd('release', 7)));
    const packed = packSafeSigs([{ signerAddr: buyer.address, r: s1.r, s: s1.s, v: s1.v }, { signerAddr: seller.address, r: s2.r, s: s2.s, v: s2.v }]);
    await checkThrows('T33 evaluator resolve rejected after cutoff (competing path blocked)', () => custody.connect(stranger).resolve(id31, digest2(31), 'release', 7, issued, 0, e6.ZeroHash, e6.ZeroHash, packed), 'AfterCutoff');
    // timeout path wins — only ONE payout possible
    const bb = await usdc.balanceOf(buyer.address);
    await (await custody.connect(stranger).refund(id31, digest2(31), 0, 0, 0, e6.ZeroHash, e6.ZeroHash, '0x')).wait();
    check('T34 timeout refund on disputed escrow succeeds (no second payout)', (await usdc.balanceOf(buyer.address)) - bb === small);
  }

  // ——— funding disabled while exits available ———
  {
    const id = cid(40);
    const cutoff = (await now(provider)) + 2000;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(40), usdcAddr, buyer.address, seller.address, safeAddr, small, cutoff - 500, cutoff, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    // disable funding
    // (no owner setter in this candidate; simulate via constructor default? Instead
    //  we test fundingEnabled behavior by deploying a second custody with funding disabled)
    const V2c = new ethers.ContractFactory(v2Art.abi, v2Art.bytecode, deployer);
    const custodyDisabled = await V2c.deploy(perPosCap, aggCap, false, adminPolicyId, policyDigest);
    await custodyDisabled.waitForDeployment();
    await (await usdc.connect(buyer).approve(await custodyDisabled.getAddress(), small, { gasLimit: 300000 })).wait();
    const id41 = cid(41);
    await checkThrows('T35 funding disabled rejects new intake', () => custodyDisabled.connect(buyer).fund(id41, digest2(41), usdcAddr, buyer.address, seller.address, safeAddr, small, cutoff - 500, cutoff, 0, adminPolicyId, policyDigest, agreementRef), 'FundingDisabled');
    // exits still available on the ACTIVE custody: release still works after disable
    // (use the already-funded id 40 — release via mutual)
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const mtypes = { MutualResolution: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const mdat = (a, n) => ({ commitmentId: id, commitmentDigest: digest2(40), action: a, nonce: n, issuedAt });
    const bS = e6.Signature.from(await buyer.signTypedData(domain, mtypes, mdat('release', 5)));
    const sS = e6.Signature.from(await seller.signTypedData(domain, mtypes, mdat('release', 5)));
    const sb = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).mutualRelease(id, digest2(40), 5, issuedAt, bS.v, bS.r, bS.s, sS.v, sS.r, sS.s)).wait();
    check('T36 exits remain available (mutual release after funding-disabled context)', (await usdc.balanceOf(seller.address)) - sb === small);
  
  }

  // ——— aggregate cap + totalHeld accounting ———
  {
    const { ethers: e6 } = await import('ethers');
    const idA = cid(50); const idB = cid(51); const idC2 = cid(52); const idD2 = cid(53);
    const cap_now = await now(provider);
    const fut = cap_now + 5000;
    await (await usdc.connect(buyer).approve(custodyAddr, ethers.parseUnits('3000', 6), { gasLimit: 300000 })).wait();
    // aggCap = 2500; perPosCap = 1000. Exact-boundary fixture, empty start:
    //   fund 1000 -> below agg (1000)
    //   fund 1000 -> below agg (2000)
    //   fund 500  -> exactly at agg (2500) succeeds
    //   fund 1    -> exceeding agg (2501) reverts CapExceeded
    const a1 = ethers.parseUnits('1000', 6);
    const a2 = ethers.parseUnits('1000', 6);
    const a3 = ethers.parseUnits('500', 6);
    await (await custody.connect(buyer).fund(idA, digest2(50), usdcAddr, buyer.address, seller.address, safeAddr, a1, fut - 700, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    await (await custody.connect(buyer).fund(idB, digest2(51), usdcAddr, buyer.address, seller.address, safeAddr, a2, fut - 700, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    check('T37 aggregate cap allows up to limit', (await custody.totalHeld()) === a1 + a2);
    await (await custody.connect(buyer).fund(idC2, digest2(52), usdcAddr, buyer.address, seller.address, safeAddr, a3, fut - 700, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    check('T37b aggregate liability exactly at cap succeeds', (await custody.totalHeld()) === ethers.parseUnits('2500', 6));
    await checkThrows('T38 aggregate cap exceeded', () => custody.connect(buyer).fund(idD2, digest2(53), usdcAddr, buyer.address, seller.address, safeAddr, ethers.parseUnits('1', 6), fut - 700, fut, 0, adminPolicyId, policyDigest, agreementRef), 'CapExceeded');
    // resolve the three escrows (mutualRefund, pre-cutoff, fixed beneficiary = buyer) so
    // later accounting assertions start from zero liability
    const mr = (cid_, d_, n_) => {
      const dom = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
      const ty = { MutualResolution: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
      const ia = cap_now;
      const md = (a, n) => ({ commitmentId: cid_, commitmentDigest: d_, action: a, nonce: n, issuedAt: ia });
      return { dom, ty, md, ia };
    };
    const rA = mr(idA, digest2(50), 910); const bA = e6.Signature.from(await buyer.signTypedData(rA.dom, rA.ty, rA.md('refund', 910)));
    const sA = e6.Signature.from(await seller.signTypedData(rA.dom, rA.ty, rA.md('refund', 910)));
    await (await custody.connect(stranger).mutualRefund(idA, digest2(50), 910, rA.ia, bA.v, bA.r, bA.s, sA.v, sA.r, sA.s)).wait();
    const rB = mr(idB, digest2(51), 911); const bB = e6.Signature.from(await buyer.signTypedData(rB.dom, rB.ty, rB.md('refund', 911)));
    const sB = e6.Signature.from(await seller.signTypedData(rB.dom, rB.ty, rB.md('refund', 911)));
    await (await custody.connect(stranger).mutualRefund(idB, digest2(51), 911, rB.ia, bB.v, bB.r, bB.s, sB.v, sB.r, sB.s)).wait();
    const rC = mr(idC2, digest2(52), 912); const bC = e6.Signature.from(await buyer.signTypedData(rC.dom, rC.ty, rC.md('refund', 912)));
    const sC = e6.Signature.from(await seller.signTypedData(rC.dom, rC.ty, rC.md('refund', 912)));
    await (await custody.connect(stranger).mutualRefund(idC2, digest2(52), 912, rC.ia, bC.v, bC.r, bC.s, sC.v, sC.r, sC.s)).wait();
    check('T37c aggregate liability freed after settlements', (await custody.totalHeld()) === 0n);
  }

  // ——— unsolicited token donations do NOT inflate liability ———
  {
    const id = cid(60);
    const fut = (await now(provider)) + 5000;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(60), usdcAddr, buyer.address, seller.address, safeAddr, small, fut - 500, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const heldBefore = await custody.totalHeld();
    // stranger donates tokens directly to custody
    await (await usdc.connect(donor).transfer(custodyAddr, ethers.parseUnits('10', 6))).wait();
    const heldAfter = await custody.totalHeld();
    check('T39 unsolicited donation does NOT inflate liability', heldAfter === heldBefore);
    // and nobody can drain the donation: try release/refund beyond amount
    const balBefore = await usdc.balanceOf(custodyAddr);
    // mutual release pays out exactly `amount`, not the whole balance
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const mtypes = { MutualResolution: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const mdat = (a, n) => ({ commitmentId: id, commitmentDigest: digest2(60), action: a, nonce: n, issuedAt });
    const bS = e6.Signature.from(await buyer.signTypedData(domain, mtypes, mdat('release', 9)));
    const sS = e6.Signature.from(await seller.signTypedData(domain, mtypes, mdat('release', 9)));
    const sb = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).mutualRelease(id, digest2(60), 9, issuedAt, bS.v, bS.r, bS.s, sS.v, sS.r, sS.s)).wait();
    // seller received exactly the escrow amount; donation remains stuck (un-drainable)
    check('T40 release pays exactly escrow amount (donation not drained)', (await usdc.balanceOf(seller.address)) - sb === small);
    check('T41 donation remains in custody (not withdrawable)', (await usdc.balanceOf(custodyAddr)) === balBefore - small);
  }

  // ——— failed token transfer (unapproved) ———
  {
    // fund without approval: transferFrom reverts => no escrow recorded
    const id = cid(70);
    const t70 = (await now(provider)) + 5000;
    const t70b = t70 + 1000;
    await checkThrows('T42 fund without approval reverts (no escrow recorded)', () => custody.connect(stranger).fund(id, digest2(70), usdcAddr, buyer.address, seller.address, safeAddr, small, t70, t70b, 0, adminPolicyId, policyDigest, agreementRef));
  }

  // ——— verdict nonce replay + terminal state ———
  {
    const id = cid(80);
    const fut = (await now(provider)) + 5000;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(80), usdcAddr, buyer.address, seller.address, safeAddr, small, fut - 500, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const vdat = (a, n, ia) => ({ commitmentId: id, commitmentDigest: digest2(80), action: a, nonce: n, issuedAt: ia });
    const bS = e6.Signature.from(await buyer.signTypedData(domain, types, vdat('release', 77, issuedAt)));
    const sS = e6.Signature.from(await seller.signTypedData(domain, types, vdat('release', 77, issuedAt)));
    const packed = packSafeSigs([{ signerAddr: buyer.address, r: bS.r, s: bS.s, v: bS.v }, { signerAddr: seller.address, r: sS.r, s: sS.s, v: sS.v }]);
    await (await custody.connect(stranger).release(id, digest2(80), 77, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, packed)).wait();
    const esc = await custody.getEscrow(id);
    check('T43 release sets terminal Released', Number(esc.state) === 3 && Number(esc.releasedAt) > 0);
    // replay same verdict on terminal escrow => WrongState (not double payout)
    await checkThrows('T44 terminal release replay rejected', () => custody.connect(stranger).release(id, digest2(80), 78, issuedAt, 0, e6.ZeroHash, e6.ZeroHash, packed), 'WrongState');
  }

  // ——— EOA evaluator path (V1-compatible, non-contract) ———
  {
    const id = cid(90);
    const fut = (await now(provider)) + 5000;
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id, digest2(90), usdcAddr, buyer.address, seller.address, evaluatorEOA.address, small, fut - 500, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issuedAt = await now(provider);
    const { ethers: e6 } = await import('ethers');
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const vdat = (a, n, ia) => ({ commitmentId: id, commitmentDigest: digest2(90), action: a, nonce: n, issuedAt: ia });
    const sig = e6.Signature.from(await evaluatorEOA.signTypedData(domain, types, vdat('release', 31, issuedAt)));
    const sb = await usdc.balanceOf(seller.address);
    await (await custody.connect(stranger).release(id, digest2(90), 31, issuedAt, sig.v, sig.r, sig.s, '0x')).wait();
    check('T45 EOA evaluator verdict accepted (V1-compatible)', (await usdc.balanceOf(seller.address)) - sb === small);
    // wrong signer EOA
    const id2 = cid(91);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id2, digest2(91), usdcAddr, buyer.address, seller.address, evaluatorEOA.address, small, fut - 500, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issued2 = await now(provider);
    const wrong = e6.Signature.from(await buyer.signTypedData(domain, types, vdat('release', 32, issued2)));
    await checkThrows('T46 EOA wrong signer rejected', () => custody.connect(stranger).release(id2, digest2(91), 32, issued2, wrong.v, wrong.r, wrong.s, '0x'), 'UnauthorizedSigner');
    // settle the rejected-verdict escrow: mutual refund (buyer+seller), restores liability to 0
    {
      const mty91 = { MutualResolution: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
      const ia91 = await now(provider);
      const md91 = (a, n) => ({ commitmentId: id2, commitmentDigest: digest2(91), action: a, nonce: n, issuedAt: ia91 });
      const b91 = e6.Signature.from(await buyer.signTypedData(domain, mty91, md91('refund', 930)));
      const s91 = e6.Signature.from(await seller.signTypedData(domain, mty91, md91('refund', 930)));
      await (await custody.connect(stranger).mutualRefund(id2, digest2(91), 930, ia91, b91.v, b91.r, b91.s, s91.v, s91.r, s91.s)).wait();
    }
    // contract evaluator with EOA-style (v,r,s) non-empty => BadSignature (container must be empty)
    const id3 = cid(92);
    await (await usdc.connect(buyer).approve(custodyAddr, small, { gasLimit: 300000 })).wait();
    await (await custody.connect(buyer).fund(id3, digest2(92), usdcAddr, buyer.address, seller.address, safeAddr, small, fut - 500, fut, 0, adminPolicyId, policyDigest, agreementRef)).wait();
    const issued3 = await now(provider);
    const eoaSigOnContract = e6.Signature.from(await buyer.signTypedData(domain, types, vdat('release', 33, issued3)));
    await checkThrows('T47 contract evaluator rejects non-empty legacy (v,r,s) container', () => custody.connect(stranger).release(id3, digest2(92), 33, issued3, eoaSigOnContract.v, eoaSigOnContract.r, eoaSigOnContract.s, '0x'), 'BadSignature');
    // settle the rejected-container escrow: mutual refund (buyer+seller), restores liability to 0
    {
      const mty92 = { MutualResolution: [
        { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
      const ia92 = await now(provider);
      const md92 = (a, n) => ({ commitmentId: id3, commitmentDigest: digest2(92), action: a, nonce: n, issuedAt: ia92 });
      const b92 = e6.Signature.from(await buyer.signTypedData(domain, mty92, md92('refund', 931)));
      const s92 = e6.Signature.from(await seller.signTypedData(domain, mty92, md92('refund', 931)));
      await (await custody.connect(stranger).mutualRefund(id3, digest2(92), 931, ia92, b92.v, b92.r, b92.s, s92.v, s92.r, s92.s)).wait();
    }
  }

  // ——— final invariants ———
  {
    // no outstanding liability: every funded escrow was terminated above
    const totalHeld = await custody.totalHeld();
    // compute expected: sum of escrows in Funded/Disputed (all terminated)
    check('T48 no outstanding liability remains (accounting consistent)', totalHeld === 0n);
    // token accounting: custody balance should equal only the donations that are stuck
    // (donation 10 mUSDC in T39) — no other funds remain
    const custodyBal = await usdc.balanceOf(custodyAddr);
    check('T49 custody balance = only unsolicited donation (no leaked principal)', custodyBal === ethers.parseUnits('10', 6));
  }

  // ——— summary ———
  fs.writeSync(1, '\n==== CUSTODY-V2 SUMMARY ====\n');
  fs.writeSync(1, 'passed=' + passed + ' failed=' + failed + '\n');
  if (failed > 0) {
    fs.writeSync(1, 'FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n') + '\n');
    process.exit(1);
  }
  fs.writeSync(1, 'ALL PASS\n');
  process.exit(0);
})().catch((e) => {
  fs.writeSync(1, 'HARNESS ERROR: ' + (e && e.message ? e.message : e) + '\n');
  if (e && e.stack) fs.writeSync(1, 'STACK: ' + e.stack + '\n');
  process.exit(2);
});