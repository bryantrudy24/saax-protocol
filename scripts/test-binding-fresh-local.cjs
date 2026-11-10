'use strict';
/**
 * Focused module-level authorization binding test on a FRESH LOCAL fixture.
 *
 * Adapts the essential authorization cases from test-binding-mismatch.cjs to
 * a genuinely fresh local 31337 escrow (the Base Sepolia escrows referenced by
 * the committed test are resolved/refunded — stale; this test deliberately
 * does NOT declare those stale public-escrow cases passed).
 *
 * Proves against the module functions (endpoint/escrow-access.js):
 *   - verifyFundingBindings: valid control passes; buyer/asset/amount mismatch
 *     rejected with the exact binding reason; BEFORE durable acceptance.
 *   - verifyAccessAuthorization: recovered buyer signer == configured buyer;
 *     seller signer on a buyer action rejected; wrong role rejected.
 *   - roleAddrFor/assetAddressFor resolution used by the binding path.
 *
 * Uses synthetic local accounts + MockUSDC on the local EVM chain 31337.
 * No public RPC, no app DB, no secrets, no funded public escrows.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const access = require('../endpoint/escrow-access');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, detail) { if (cond) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); } }

(async () => {
  const CHAIN = 31337;
  const { provider, hre, accounts } = await helpers.startEvm(CHAIN);
  const [deployer, buyer, seller, evaluator] = accounts;

  async function deploy(art, args = []) { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; }
  const token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  const policy = '0x' + 'ab'.repeat(32);
  const custody = await deploy(hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2'), [1000000, 10000000, true, 1, policy]);
  const cid = ethers.zeroPadValue(ethers.toBeHex(7711), 32);
  const digest = ethers.keccak256('0x' + '22'.repeat(32));
  const now = Number(BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp));

  await (await token.mint(buyer.address, 1000000)).wait();
  await (await token.connect(buyer).approve(custody.target, 1000000)).wait();
  await (await custody.connect(buyer).fund(cid, digest, token.target, buyer.address, seller.address, evaluator.address, 1000, now + 1000, now + 2000, 0, 1, policy, digest)).wait();

  const funded = await custody.getEscrow(cid);
  check('fresh local escrow funded on 31337', funded[13] === 1n, 'state=' + funded[13]);

  // Build the expected binding set exactly as the endpoint does.
  const expected = {
    digest, buyer: buyer.address, seller: seller.address, evaluator: evaluator.address,
    amount: '1000', asset: token.target, custody: custody.target, chainId: String(CHAIN),
  };

  // ——— verifyFundingBindings: valid control ———
  const ok = access.verifyFundingBindings(funded, expected);
  check('valid control: full binding passes', ok.ok === true, ok.reason);

  // ——— verifyFundingBindings: buyer mismatch (the gap the fix closed) ———
  const buyerMismatch = access.verifyFundingBindings(funded, Object.assign({}, expected, { buyer: '0x1111111111111111111111111111111111111111' }));
  check('buyer mismatch rejected BEFORE durable acceptance', buyerMismatch.ok === false && /agreement buyer 0x11111111/.test(buyerMismatch.reason), buyerMismatch.reason);

  // ——— verifyFundingBindings: asset mismatch ———
  const assetMismatch = access.verifyFundingBindings(funded, Object.assign({}, expected, { asset: '0x2222222222222222222222222222222222222222' }));
  check('asset mismatch rejected with specific reason', assetMismatch.ok === false && /asset/i.test(assetMismatch.reason), assetMismatch.reason);

  // ——— verifyFundingBindings: amount mismatch ———
  const amountMismatch = access.verifyFundingBindings(funded, Object.assign({}, expected, { amount: '1001' }));
  check('amount mismatch rejected with specific reason', amountMismatch.ok === false && /amount/i.test(amountMismatch.reason), amountMismatch.reason);

  // ——— verifyFundingBindings: digest mismatch ———
  const digestMismatch = access.verifyFundingBindings(funded, Object.assign({}, expected, { digest: ethers.keccak256('0x' + '33'.repeat(32)) }));
  check('digest mismatch rejected with specific reason', digestMismatch.ok === false && /digest/i.test(digestMismatch.reason), digestMismatch.reason);

  // ——— verifyAccessAuthorization: recovered signer must equal configured buyer ———
  const domain = access.ACCESS_DOMAIN;
  const types = access.ACCESS_TYPES;
  const custodyAddr = custody.target;
  // NOTE: the access-auth guard (endpoint/escrow-access.js step 3) is
  // deliberately Base-Sepolia-bound: String(chainId) !== '84532' is rejected
  // (BAD_CHAIN) regardless of the local EVM. That is the PUBLIC-TESTED
  // control; the local EVM only supplies the custody/escrow fixture. So the
  // access-auth message signs chainId 84532 (the guard constant), NOT the
  // local chain — this asserts the guard accepts the correct domain and
  // rejects the wrong signer, without weakening the chain guard.
  const AUTH_CHAIN = '84532';
  const makeAuth = async (signer, role, action, nonce, over) => {
    const message = Object.assign({ role, commitmentDigest: digest, escrowId: cid, custody: custodyAddr, chainId: AUTH_CHAIN, action, nonce: String(nonce), expiry: String(now + 3600) }, over || {});
    const sig = await signer.signTypedData(domain, types, Object.assign({}, message, { chainId: BigInt(message.chainId), nonce: BigInt(message.nonce), expiry: BigInt(message.expiry) }));
    const parsed = ethers.Signature.from(sig);
    return { payload: message, signature: parsed };
  };
  // Point roleAddrFor at the fresh local buyer via the module's config surface.
  const origBuyer = process.env.SAAX_TEST_BUYER_ADDRESS;
  process.env.SAAX_TEST_BUYER_ADDRESS = buyer.address;
  try {
    const buyerAuth = await makeAuth(buyer, 'buyer', 'execute', 1);
    const buyerCheck = access.verifyAccessAuthorization(buyerAuth);
    check('buyer-scoped auth: recovered signer == configured buyer', buyerCheck.ok === true, buyerCheck.reason || '');
  } finally {
    if (origBuyer === undefined) delete process.env.SAAX_TEST_BUYER_ADDRESS; else process.env.SAAX_TEST_BUYER_ADDRESS = origBuyer;
  }

  // ——— seller signer on a buyer action rejected ———
  process.env.SAAX_TEST_BUYER_ADDRESS = buyer.address;
  try {
    const sellerAuth = await makeAuth(seller, 'buyer', 'execute', 2);
    const sellerAsBuyer = access.verifyAccessAuthorization(sellerAuth);
    check('seller key cannot authorize buyer action', sellerAsBuyer.ok === false && /signer/i.test(sellerAsBuyer.reason), sellerAsBuyer.reason);
  } finally {
    if (origBuyer === undefined) delete process.env.SAAX_TEST_BUYER_ADDRESS; else process.env.SAAX_TEST_BUYER_ADDRESS = origBuyer;
  }

  // ——— wrong role for action rejected ———
  process.env.SAAX_TEST_BUYER_ADDRESS = buyer.address;
  try {
    const badRoleAuth = await makeAuth(buyer, 'seller', 'execute', 3);
    const wrongRole = access.verifyAccessAuthorization(badRoleAuth);
    check('wrong role for action rejected', wrongRole.ok === false && /role/i.test(wrongRole.reason), wrongRole.reason);
  } finally {
    if (origBuyer === undefined) delete process.env.SAAX_TEST_BUYER_ADDRESS; else process.env.SAAX_TEST_BUYER_ADDRESS = origBuyer;
  }

  console.log('\nRESULT: ' + passed + '/' + (passed + failed) + ' PASS');
  provider.destroy();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });