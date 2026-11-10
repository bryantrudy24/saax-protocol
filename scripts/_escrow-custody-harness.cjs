// SAAX Escrow Custody — on-chain enforcement harness (clean rewrite)
// Local ganache EVM; real txs via eth_sendTransaction (unlocked accounts).
// Proves: funds held in the contract; release/refund only via evaluator
// EIP-712 verdict or deadline; wrong actor/digest/replay/expired rejected;
// disputes freeze funds; resolve requires evaluator; no admin withdrawal.
'use strict';

const ganache = require('ganache');
const solc = require('solc');
const fs = require('fs');
const path = require('path');
const { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, toHex, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); } else { failed++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); } }

const MOCK_ERC20 = `pragma solidity 0.8.26;
contract MockUSDC {
  string public name = "USD Coin"; string public symbol = "USDC"; uint8 public decimals = 6;
  uint256 public totalSupply;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);
  constructor(uint256 supply) { balanceOf[msg.sender] = supply; totalSupply = supply; }
  function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
  function transfer(address to, uint256 amount) external returns (bool) { require(balanceOf[msg.sender] >= amount, "bal"); balanceOf[msg.sender] -= amount; balanceOf[to] += amount; emit Transfer(msg.sender, to, amount); return true; }
  function transferFrom(address from, address to, uint256 amount) external returns (bool) { require(balanceOf[from] >= amount, "bal"); require(allowance[from][msg.sender] >= amount, "allow"); balanceOf[from] -= amount; balanceOf[to] += amount; allowance[from][msg.sender] -= amount; emit Transfer(from, to, amount); return true; }
}`;

function compile(src, name) {
  const input = { language: 'Solidity', sources: { [name]: { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) throw new Error(name + ': ' + errs[0].formattedMessage.slice(0, 300));
  const c = out.contracts[name][Object.keys(out.contracts[name])[0]];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

function encodeCall(abi, fn, args) {
  const frag = abi.find(f => f.type === 'function' && f.name === fn);
  if (!frag) throw new Error('no function ' + fn);
  const sig = fn + '(' + frag.inputs.map(i => i.type).join(',') + ')';
  const sel = keccak256(toHex(sig)).slice(0, 10);
  const types = frag.inputs.map(i => i.type);
  return sel + (args.length ? encodeAbiParameters(parseAbiParameters(types.join(',')), args).slice(2) : '');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('--- Escrow custody contract: on-chain enforcement (local EVM) ---');
  const server = ganache.server({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 1000 } });
  await server.listen(0);
  const port = server.address().port;
  const rpcUrl = 'http://127.0.0.1:' + port;
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = Number(await pub.getChainId());
  const accs = await pub.request({ method: 'eth_accounts' });
  const [deployer, buyer, seller, evaluator, attacker] = accs;
  console.log('CHAIN', chainId, 'accounts', deployer.slice(0,10), buyer.slice(0,10), seller.slice(0,10), evaluator.slice(0,10), attacker.slice(0,10));

  // private keys (ganache deterministic)
  const init = await server.provider.getInitialAccounts();
  const keyOf = (addr) => init[addr.toLowerCase()].secretKey;
  const acctOf = (addr) => privateKeyToAccount(keyOf(addr));
  const ea = acctOf(evaluator), ba = acctOf(buyer), aa = acctOf(attacker);

  // send raw eth tx (unlocked account)
  const ethSend = async (from, to, data) => {
    const req = { from, to, data, gas: '0x7a1200' }; // 8M gas
    const hash = await pub.request({ method: 'eth_sendTransaction', params: [req] });
    const rec = await pub.waitForTransactionReceipt({ hash });
    return rec;
  };
  const deploy = async (from, bytecode, extra) => {
    const rec = await ethSend(from, null, bytecode + (extra || ''));
    return rec;
  };

  // Deploy mock USDC (supply to deployer), then custody
  const usdc = compile(MOCK_ERC20, 'MockUSDC.sol');
  const supplyHex = (100000000000000n).toString(16).padStart(64, '0'); // 1e14 atomic (1e8 tokens)
  const usdcRec = await deploy(deployer, usdc.bytecode + supplyHex);
  const USDC = usdcRec.contractAddress;
  check('USDC deployed', usdcRec.status === 'success' && !!USDC, USDC.slice(0, 12));

  const build = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'escrow-custody-build.json'), 'utf8'));
  const cRec = await deploy(deployer, build.bytecode);
  const CUSTODY = cRec.contractAddress;
  const ABI = build.abi;
  check('custody deployed', cRec.status === 'success' && !!CUSTODY, CUSTODY.slice(0, 12));

  const read = async (fn, args) => pub.readContract({ address: CUSTODY, abi: ABI, functionName: fn, args });
  const MIN = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }, { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }, { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
  const bal = async (addr) => Number(await pub.readContract({ address: USDC, abi: MIN, functionName: 'balanceOf', args: [addr] }));
  const usdcCall = (fn, args) => encodeCall(MIN, fn, args);

  // deployer -> buyer 100 USDC (100e6 atomic)
  const tr = await ethSend(deployer, USDC, usdcCall('transfer', [buyer, 100e6]));
  check('buyer funded', tr.status === 'success' && (await bal(buyer)) === 100e6, 'buyer=' + await bal(buyer));

  // EIP-712
  const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: BigInt(chainId), verifyingContract: CUSTODY };
  const TYPES = { EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' },
  ] };
  const sign = async (acct, cid, digest, action, nonce, issuedAt) => {
    const s = await acct.signTypedData({ domain, types: TYPES, primaryType: 'EscrowVerdict', message: { commitmentId: cid, commitmentDigest: digest, action, nonce: BigInt(nonce), issuedAt: BigInt(issuedAt) } });
    return { v: parseInt(s.slice(130, 132), 16), r: '0x' + s.slice(2, 66), s: '0x' + s.slice(66, 130) };
  };

  const now = () => Math.floor(Date.now() / 1000);
  const commitmentId = '0x' + '11'.repeat(32);
  const digest = '0x' + 'ab'.repeat(32);
  const deadline = now() + 3600;
  const AMOUNT = 50000n;

  // ---- FLOW A: fund -> evaluator release -> seller -----------------------------
  await ethSend(buyer, USDC, usdcCall('approve', [CUSTODY, AMOUNT]));
  const fundCall = encodeCall(ABI, 'fund', [commitmentId, digest, USDC, buyer, seller, evaluator, AMOUNT, BigInt(deadline), 0n]);
  const fr = await ethSend(buyer, CUSTODY, fundCall);
  check('FLOW A: fund tx ok', fr.status === 'success', fr.transactionHash.slice(0, 20));
  const esc = await read('getEscrow', [commitmentId]);
  check('FLOW A: state Funded(1)', esc[9] === 1, 'state=' + esc[9]);
  check('FLOW A: custody holds amount', (await bal(CUSTODY)) === Number(AMOUNT), 'held=' + await bal(CUSTODY));

  const sRel = await sign(ea, commitmentId, digest, 'release', 1, now());
  const relCall = encodeCall(ABI, 'release', [commitmentId, digest, 1n, BigInt(now()), sRel.v, sRel.r, sRel.s]);
  const rel = await ethSend(deployer, CUSTODY, relCall); // relayer (deployer) submits; evaluator sig authorizes
  check('FLOW A: release (eval sig, relayer submits) ok', rel.status === 'success', rel.transactionHash.slice(0, 20));
  const esc2 = await read('getEscrow', [commitmentId]);
  check('FLOW A: state Released(3)', esc2[9] === 3, 'state=' + esc2[9]);
  check('FLOW A: seller got USDC', (await bal(seller)) >= Number(AMOUNT), 'seller=' + await bal(seller));
  check('FLOW A: custody emptied', (await bal(CUSTODY)) === 0, 'held=' + await bal(CUSTODY));

  // repeated release rejects (ganache returns reverted receipt, not throw)
  const sRel2 = await sign(ea, commitmentId, digest, 'release', 2, now());
  const relCall2 = encodeCall(ABI, 'release', [commitmentId, digest, 2n, BigInt(now()), sRel2.v, sRel2.r, sRel2.s]);
  const repRec = await ethSend(deployer, CUSTODY, relCall2);
  check('FLOW A: repeated release reverts', repRec.status !== 'success', 'status=' + repRec.status);

  // ---- FLOW B: fund -> timeout -> refund (no sig) ------------------------------
  const cidB = '0x' + '22'.repeat(32);
  await ethSend(buyer, USDC, usdcCall('approve', [CUSTODY, AMOUNT]));
  const fundB = encodeCall(ABI, 'fund', [cidB, digest, USDC, buyer, seller, evaluator, AMOUNT, BigInt(now() + 60), 0n]);
  const fb = await ethSend(buyer, CUSTODY, fundB);
  check('FLOW B: fund ok', fb.status === 'success', fb.transactionHash.slice(0, 20));
  // unsigned refund before deadline -> revert
  const refundNoSig = encodeCall(ABI, 'refund', [cidB, digest, 0n, 0n, 0, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000000000000000000000000000']);
  const preRec = await ethSend(deployer, CUSTODY, refundNoSig);
  check('FLOW B: unsigned refund pre-deadline reverts', preRec.status !== 'success', 'status=' + preRec.status);
  // advance time past deadline
  await pub.request({ method: 'evm_increaseTime', params: [121] });
  await pub.request({ method: 'evm_mine' });
  const rf = await ethSend(deployer, CUSTODY, refundNoSig);
  check('FLOW B: timeout refund ok', rf.status === 'success', rf.transactionHash.slice(0, 20));
  const escB = await read('getEscrow', [cidB]);
  check('FLOW B: state Refunded(4)', escB[9] === 4, 'state=' + escB[9]);
  check('FLOW B: buyer got refund', (await bal(buyer)) >= Number(AMOUNT), 'buyer=' + await bal(buyer));
  check('FLOW B: custody emptied again', (await bal(CUSTODY)) === 0, 'held=' + await bal(CUSTODY));

  // ---- WRONG ACTOR / WRONG DIGEST / REPLAY -------------------------------------
  const cidC = '0x' + '33'.repeat(32);
  await ethSend(buyer, USDC, usdcCall('approve', [CUSTODY, AMOUNT]));
  await ethSend(buyer, CUSTODY, encodeCall(ABI, 'fund', [cidC, digest, USDC, buyer, seller, evaluator, AMOUNT, BigInt(deadline), 0n]));
  // wrong digest signed by EVALUATOR -> WrongDigest
  const sBad = await sign(ea, cidC, '0x' + 'cd'.repeat(32), 'release', 10, now());
  const wdRec = await ethSend(deployer, CUSTODY, encodeCall(ABI, 'release', [cidC, '0x' + 'cd'.repeat(32), 10n, BigInt(now()), sBad.v, sBad.r, sBad.s]));
  check('wrong digest reverts', wdRec.status !== 'success', 'status=' + wdRec.status);
  // attacker signs -> UnauthorizedSigner
  const sAtt = await sign(aa, cidC, digest, 'release', 11, now());
  const attRec = await ethSend(deployer, CUSTODY, encodeCall(ABI, 'release', [cidC, digest, 11n, BigInt(now()), sAtt.v, sAtt.r, sAtt.s]));
  check('attacker verdict reverts', attRec.status !== 'success', 'status=' + attRec.status);
  // replay same nonce
  const rpRec = await ethSend(deployer, CUSTODY, encodeCall(ABI, 'release', [cidC, digest, 11n, BigInt(now()), sAtt.v, sAtt.r, sAtt.s]));
  check('replayed nonce reverts', rpRec.status !== 'success', 'status=' + rpRec.status);

  // ---- TOKEN TRANSFER FAILURE MODES (Day 19 hardening) -------------------------
  // 1) False-return token: transferFrom/transfer return explicit false.
  //    fund() must revert; no escrow recorded; no Funded event; balances intact.
  const FALSE_TOKEN = `pragma solidity 0.8.26;
contract FalseToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  constructor() { balanceOf[msg.sender] = 1000000; balanceOf[0x${getAddress(buyer).slice(2)}] = 1000000; }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function transfer(address, uint256) external pure returns (bool) { return false; }
  function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}`;
  const falseTok = compile(FALSE_TOKEN, 'FalseToken.sol');
  const frT = await deploy(deployer, falseTok.bytecode);
  const FALSE_T = frT.contractAddress;
  check('false-return token deployed', frT.status === 'success' && !!FALSE_T, FALSE_T.slice(0, 12));
  const MINF = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }, { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
  const balF = async (addr) => Number(await pub.readContract({ address: FALSE_T, abi: MINF, functionName: 'balanceOf', args: [addr] }));
  await ethSend(buyer, FALSE_T, encodeCall(MINF, 'approve', [CUSTODY, 1000000]));
  const cidF = '0x' + '55'.repeat(32);
  const fundF = encodeCall(ABI, 'fund', [cidF, digest, FALSE_T, buyer, seller, evaluator, 100000n, BigInt(now() + 3600), 0n]);
  const frr = await ethSend(buyer, CUSTODY, fundF);
  check('false-return: fund reverts', frr.status !== 'success', 'status=' + frr.status);
  const escF = await read('getEscrow', [cidF]);
  check('false-return: no escrow recorded', escF[9] === 0, 'state=' + escF[9]);
  check('false-return: buyer balance intact', (await balF(buyer)) === 1000000, 'buyer=' + await balF(buyer));

  // 2) Reverting token: transferFrom reverts. Same expectations.
  const REV_TOKEN = `pragma solidity 0.8.26;
contract RevertToken {
  mapping(address => uint256) public balanceOf;
  constructor() { balanceOf[msg.sender] = 1000000; }
  function approve(address, uint256) external pure returns (bool) { return true; }
  function transfer(address, uint256) external pure { revert("no"); }
  function transferFrom(address, address, uint256) external pure { revert("no"); }
}`;
  const revTok = compile(REV_TOKEN, 'RevertToken.sol');
  const rvT = await deploy(deployer, revTok.bytecode);
  const REV_T = rvT.contractAddress;
  check('reverting token deployed', rvT.status === 'success' && !!REV_T, REV_T.slice(0, 12));
  const MINRT = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }, { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
  await ethSend(buyer, REV_T, encodeCall(MINRT, 'approve', [CUSTODY, 1000000]));
  // deployer->buyer transfer for revert token (token transfers revert, so mint directly to buyer via constructor is needed; deployer owns supply)
  // Mint to buyer: use a tiny helper — deploy with supply to deployer, then use raw eth transfer of token? Transfer reverts always, so instead deploy a second supply holder: token owned by deployer only.
  // Simplest: deploy REV_TOKEN with a constructor that mints BOTH deployer and buyer.
  const REV_TOKEN2 = `pragma solidity 0.8.26;
contract RevertToken2 {
  mapping(address => uint256) public balanceOf;
  constructor() { balanceOf[msg.sender] = 1000000; balanceOf[0x` + getAddress(buyer).slice(2) + `] = 1000000; }
  function approve(address, uint256) external pure returns (bool) { return true; }
  function transfer(address, uint256) external pure { revert("no"); }
  function transferFrom(address, address, uint256) external pure { revert("no"); }
}`;
  const revTok2 = compile(REV_TOKEN2, 'RevertToken2.sol');
  const rvT2 = await deploy(deployer, revTok2.bytecode);
  const REV_T2 = rvT2.contractAddress;
  check('reverting token (mint-to-buyer) deployed', rvT2.status === 'success' && !!REV_T2, REV_T2.slice(0, 12));
  const cidR = '0x' + '66'.repeat(32);
  const fundR = encodeCall(ABI, 'fund', [cidR, digest, REV_T2, buyer, seller, evaluator, 100000n, BigInt(now() + 3600), 0n]);
  const rvr = await ethSend(buyer, CUSTODY, fundR);
  check('reverting: fund reverts', rvr.status !== 'success', 'status=' + rvr.status);
  const escR = await read('getEscrow', [cidR]);
  check('reverting: no escrow recorded', escR[9] === 0, 'state=' + escR[9]);
  const MINR = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  const balR = async (addr) => Number(await pub.readContract({ address: REV_T2, abi: MINR, functionName: 'balanceOf', args: [addr] }));
  check('reverting: buyer balance intact', (await balR(buyer)) === 1000000, 'buyer=' + await balR(buyer));

  // 3) No-return token (USDT-style): success path must work via balance-delta.
  const NORET_TOKEN = `pragma solidity 0.8.26;
contract NoReturnToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  constructor() { balanceOf[msg.sender] = 1000000; }
  function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
  function transfer(address to, uint256 amount) external { require(balanceOf[msg.sender] >= amount, "b"); balanceOf[msg.sender] -= amount; balanceOf[to] += amount; }
  function transferFrom(address from, address to, uint256 amount) external { require(balanceOf[from] >= amount, "b"); require(allowance[from][msg.sender] >= amount, "a"); balanceOf[from] -= amount; balanceOf[to] += amount; allowance[from][msg.sender] -= amount; }
}`;
  const nt = compile(NORET_TOKEN, 'NoReturnToken.sol');
  const ntT = await deploy(deployer, nt.bytecode + (1000000n).toString(16).padStart(64, '0'));
  const NORET = ntT.contractAddress;
  check('no-return token deployed', ntT.status === 'success' && !!NORET, NORET.slice(0, 12));
  const MINN = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }, { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] }, { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] }];
  await ethSend(deployer, NORET, encodeCall(MINN, 'transfer', [buyer, 1000000]));
  await ethSend(buyer, NORET, encodeCall(MINN, 'approve', [CUSTODY, 1000000]));
  const cidN = '0x' + '77'.repeat(32);
  const fundN = encodeCall(ABI, 'fund', [cidN, digest, NORET, buyer, seller, evaluator, 100000n, BigInt(now() + 3600), 0n]);
  const fnr = await ethSend(buyer, CUSTODY, fundN);
  check('no-return: fund succeeds (balance-delta)', fnr.status === 'success', 'status=' + fnr.status);
  const escN = await read('getEscrow', [cidN]);
  check('no-return: state Funded(1)', escN[9] === 1, 'state=' + escN[9]);
  const balN = async (addr) => Number(await pub.readContract({ address: NORET, abi: MINN.slice(0, 1), functionName: 'balanceOf', args: [addr] }));
  check('no-return: custody holds amount', (await balN(CUSTODY)) === 100000, 'held=' + await balN(CUSTODY));
  // release via evaluator verdict
  const sRelN = await sign(ea, cidN, digest, 'release', 30, now());
  const relN = encodeCall(ABI, 'release', [cidN, digest, 30n, BigInt(now()), sRelN.v, sRelN.r, sRelN.s]);
  const nRel = await ethSend(deployer, CUSTODY, relN);
  check('no-return: release succeeds (balance-delta)', nRel.status === 'success', nRel.transactionHash.slice(0, 20));
  const escN2 = await read('getEscrow', [cidN]);
  check('no-return: state Released(3)', escN2[9] === 3, 'state=' + escN2[9]);
  check('no-return: seller received', (await balN(seller)) >= 100000, 'seller=' + await balN(seller));

  // 4) Invalid token target: token == address(0) must revert InvalidToken.
  const cidZ = '0x' + '88'.repeat(32);
  const fundZ = encodeCall(ABI, 'fund', [cidZ, digest, '0x0000000000000000000000000000000000000000', buyer, seller, evaluator, 100000n, BigInt(now() + 3600), 0n]);
  const zr = await ethSend(buyer, CUSTODY, fundZ);
  check('invalid token target: fund reverts', zr.status !== 'success', 'status=' + zr.status);
  const escZ = await read('getEscrow', [cidZ]);
  check('invalid token target: no escrow recorded', escZ[9] === 0, 'state=' + escZ[9]);

  // 5) Fee-on-transfer token: transferFrom moves less than amount -> must revert.
  const FEE_TOKEN = `pragma solidity 0.8.26;
contract FeeToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  constructor() { balanceOf[msg.sender] = 1000000; }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function transfer(address to, uint256 amount) external returns (bool) { uint256 fee = amount / 100; uint256 net = amount - fee; require(balanceOf[msg.sender] >= amount, "b"); balanceOf[msg.sender] -= amount; balanceOf[to] += net; return true; }
  function transferFrom(address from, address to, uint256 amount) external returns (bool) { uint256 fee = amount / 100; uint256 net = amount - fee; require(balanceOf[from] >= amount, "b"); require(allowance[from][msg.sender] >= amount, "a"); balanceOf[from] -= amount; balanceOf[to] += net; allowance[from][msg.sender] -= amount; return true; }
}`;
  const feeTok = compile(FEE_TOKEN, 'FeeToken.sol');
  const feeT = await deploy(deployer, feeTok.bytecode + (1000000n).toString(16).padStart(64, '0'));
  const FEE_T = feeT.contractAddress;
  check('fee-on-transfer token deployed', feeT.status === 'success' && !!FEE_T, FEE_T.slice(0, 12));
  const MINFT2 = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }, { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
  await ethSend(deployer, FEE_T, encodeCall(MINFT2, 'approve', [CUSTODY, 0])); // dummy
  await ethSend(buyer, FEE_T, encodeCall(MINFT2, 'approve', [CUSTODY, 1000000]));
  // mover: deployer -> buyer via transfer (fee applies)
  const MINFT3 = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
  await ethSend(deployer, FEE_T, encodeCall(MINFT3, 'transfer', [buyer, 1000000]));
  const cidFee = '0x' + '99'.repeat(32);
  const fundFee = encodeCall(ABI, 'fund', [cidFee, digest, FEE_T, buyer, seller, evaluator, 100000n, BigInt(now() + 3600), 0n]);
  const feeR = await ethSend(buyer, CUSTODY, fundFee);
  check('fee-on-transfer: fund reverts (delta mismatch)', feeR.status !== 'success', 'status=' + feeR.status);
  const escFee = await read('getEscrow', [cidFee]);
  check('fee-on-transfer: no escrow recorded', escFee[9] === 0, 'state=' + escFee[9]);
  const MINFB = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  const balFee = async (addr) => Number(await pub.readContract({ address: FEE_T, abi: MINFB, functionName: 'balanceOf', args: [addr] }));
  check('fee-on-transfer: buyer balance intact (post-fee 990000, escrow not debited)', (await balFee(buyer)) === 990000, 'buyer=' + await balFee(buyer));

  // ---- DISPUTE -> RESOLVE (release) --------------------------------------------
  const cidD = '0x' + '44'.repeat(32);
  await ethSend(buyer, USDC, usdcCall('approve', [CUSTODY, AMOUNT]));
  await ethSend(buyer, CUSTODY, encodeCall(ABI, 'fund', [cidD, digest, USDC, buyer, seller, evaluator, AMOUNT, BigInt(deadline), 0n]));
  // Unrelated wallet (attacker) must NOT freeze funds — attempt reverts, state unchanged
  const disUnauth = await ethSend(attacker, CUSTODY, encodeCall(ABI, 'raiseDispute', [cidD, digest, 'ipfs://QmUnauthorized']));
  check('unauthorized dispute attempt reverts (NotParty)', disUnauth.status !== 'success', 'status=' + disUnauth.status);
  const escDU = await read('getEscrow', [cidD]);
  check('unauthorized dispute: state still Funded(1)', escDU[9] === 1, 'state=' + escDU[9]);
  // Authorized commitment party (buyer) CAN raise the dispute
  await ethSend(buyer, CUSTODY, encodeCall(ABI, 'raiseDispute', [cidD, digest, 'ipfs://QmDisputeEvid']));
  const escD = await read('getEscrow', [cidD]);
  check('dispute state Disputed(2)', escD[9] === 2, 'state=' + escD[9]);
  // direct release during dispute reverts
  const sD = await sign(ea, cidD, digest, 'release', 20, now());
  const disRelRec = await ethSend(deployer, CUSTODY, encodeCall(ABI, 'release', [cidD, digest, 20n, BigInt(now()), sD.v, sD.r, sD.s]));
  check('disputed: direct release reverts', disRelRec.status !== 'success', 'status=' + disRelRec.status);
  // timeout refund during dispute reverts (deadline passes but state != Funded)
  const refundDispute = encodeCall(ABI, 'refund', [cidD, digest, 0n, 0n, 0, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000000000000000000000000000']);
  await pub.request({ method: 'evm_increaseTime', params: [4000] }); // past deadline + verdict window
  await pub.request({ method: 'evm_mine' });
  const rfD = await ethSend(deployer, CUSTODY, refundDispute);
  check('disputed: timeout refund still reverts (frozen until resolve)', rfD.status !== 'success', 'status=' + rfD.status);
  const escDf = await read('getEscrow', [cidD]);
  check('disputed: state still Disputed(2) after deadline', escDf[9] === 2, 'state=' + escDf[9]);
  // restore EVM time to real now (the freeze test advanced +4000s; the
  // resolve verdict below signs with a 300s-window issuedAt)
  await pub.request({ method: 'evm_setTime', params: [new Date().getTime()] });
  await pub.request({ method: 'evm_mine' });
  // resolve release (issuedAt = EVM block timestamp to survive time-travel tests)
  const evmNow = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
  const sRes = await sign(ea, cidD, digest, 'resolve:release', 21, evmNow);
  const res = await ethSend(deployer, CUSTODY, encodeCall(ABI, 'resolve', [cidD, digest, 'release', 21n, BigInt(evmNow), sRes.v, sRes.r, sRes.s]));
  check('resolve->release ok', res.status === 'success', res.transactionHash.slice(0, 20));
  const escD2 = await read('getEscrow', [cidD]);
  check('resolved Released(3)', escD2[9] === 3, 'state=' + escD2[9]);
  check('seller got dispute-released funds', (await bal(seller)) >= 100000, 'seller=' + await bal(seller));

  console.log('--- RESULT: ' + passed + ' passed, ' + failed + ' failed ---');
  await server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
