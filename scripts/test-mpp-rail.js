// SAAX Protocol — Day 12 (MPP sprint), Item 5: MPP rail test harness
//
// Proves the rail-agnostic commitment lifecycle end-to-end:
//   1. Issues a commitment (manifest) + exactly one settlement requirement R
//   2. Simulates an MPP client: pays the challenge, retries with
//      Authorization: Payment credential
//   3. Confirms the MPP rail validates the credential against R
//   4. Confirms settlement produces a valid railReference
//   5. Confirms the Spend Receipt binds the commitment to the MPP reference
//   6. Runs the SAME flow with x402 and confirms both rails produce valid
//      receipts for the SAME commitment — the architectural proof of
//      rail-agnosticism.
//
// Runs entirely in-process (no live chain): the custom settler honors
// SAAX_GATEWAY_DRY_RUN, and the x402 rail runs its mock branch. Set
// SAAX_GATEWAY_DRY_RUN=0 only when you have a funded Base Sepolia wallet and
// intend a real broadcast — this harness is designed to prove the lifecycle
// without spending funds.
//
// Usage: node scripts/test-mpp-rail.js

'use strict';

process.env.SAAX_GATEWAY_DRY_RUN = process.env.SAAX_GATEWAY_DRY_RUN || '1';

const crypto = require('crypto');
const { getAddress, keccak256, stringToHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const gateway = require('../endpoint/gateway.js');
const rails = require('../endpoint/rails/index.js');
const railsMpp = require('../endpoint/rails/mpp.js');
const railsX402 = require('../endpoint/rails/x402.js');
const receiptMod = require('../endpoint/receipt.js');

// ---- deterministic test identities (NEVER used on any network) --------------
const BUYER_KEY = '0x' + crypto.createHash('sha256').update('saax-protocol-day12-test-buyer').digest('hex').slice(0, 64);
const SELLER_KEY = '0x' + crypto.createHash('sha256').update('saax-protocol-day12-test-seller').digest('hex').slice(0, 64);
const buyerAccount = privateKeyToAccount(BUYER_KEY);
const sellerAccount = privateKeyToAccount(SELLER_KEY);

// Register both rails (idempotent).
if (!rails.resolve('mpp')) rails.register('mpp', railsMpp);
if (!rails.resolve('x402')) rails.register('x402', railsX402);

// Route-fee: 50000 raw units USDC = $0.05 (matches the Day 9 gateway fee).
const FEE_RAW = '50000';

// ---- tiny test framework ------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---- helpers ----------------------------------------------------------------
function challengeHashOf(c) { return keccak256(stringToHex(JSON.stringify([c.id, c.realm]))); }

async function signMppCredential(challenge, buyerKey, sellerAddr) {
  // Simulate an MPP CLIENT: sign an EIP-3009 TransferWithAuthorization for the
  // challenge (nonce = challenge hash, per the Payment-auth EVM flow).
  const account = privateKeyToAccount(buyerKey);
  const req = challenge.request;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = challengeHashOf(challenge);
  const signature = await account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: req.methodDetails && req.methodDetails.chainId || 84532, verifyingContract: getAddress(req.currency) },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(account.address),
      to: getAddress(req.recipient),
      value: BigInt(req.amount),
      validAfter: now - 60n,
      validBefore: now + 3600n,
      nonce,
    },
  });
  return {
    challenge,
    payload: {
      type: 'authorization',
      from: getAddress(account.address),
      to: getAddress(req.recipient),
      value: String(req.amount),
      validAfter: String(now - 60n),
      validBefore: String(now + 3600n),
      nonce,
      signature,
    },
  };
}

function wireMppCredential(cred) {
  // Authorization: Payment <base64url JSON credential>
  return 'Payment ' + Buffer.from(JSON.stringify(cred)).toString('base64url');
}

async function issueCommitment(capability) {
  // Issue commitment + R from a demand payload (same API the gateway uses).
  const ctx = gateway.commitmentFlow.issueFromPayload({
    buyer: getAddress(buyerAccount.address),
    seller: getAddress(sellerAccount.address),
    capability,
    deadline: new Date(Date.now() + 3600000).toISOString(),
    amountRaw: FEE_RAW,
    currency: 'USDC',
  });
  return ctx; // { manifest, requirement }
}

async function runMppFlow(ctx) {
  // ---- MPP client flow ------------------------------------------------------
  section('MPP flow — commitment ' + ctx.manifest.commitmentId.slice(0, 10) + '…');
  const R = ctx.requirement;

  // 1. realise(R): the challenge (server would emit via WWW-Authenticate).
  const challenge = await railsMpp.realise(R);
  check('MPP realise(R) emits a challenge', challenge && challenge.id && challenge.method === 'evm' && challenge.intent === 'charge', JSON.stringify(challenge && { id: challenge.id, method: challenge.method, intent: challenge.intent }));
  check('MPP challenge amount matches R.amt (50000 raw)', String(challenge.request.amount) === FEE_RAW, 'got ' + challenge.request.amount);
  check('MPP challenge recipient == R.payee', getAddress(challenge.request.recipient) === getAddress(R.payee), challenge.request.recipient + ' vs ' + R.payee);

  // 2. Simulate the client: pay the challenge -> credential -> header.
  const cred = await signMppCredential(challenge, BUYER_KEY, R.payee);
  const header = wireMppCredential(cred);
  check('MPP credential serializes to Authorization: Payment header', /^Payment \S+$/.test(header));

  // 3. Validate the credential against R (server side).
  const valid = await railsMpp.validate(cred, R);
  check('MPP rail validate(credential, R) === true', valid === true);

  // 4. Settle: produces a railReference (dry-run: synthetic marker).
  const railRef = await railsMpp.settle(cred);
  check('MPP settle() returns a railReference', typeof railRef === 'string' && railRef.length > 10, String(railRef).slice(0, 30));

  // 5. Spend Receipt binds commitment to the MPP reference (credential-free).
  const receipt = gateway.commitmentFlow.buildSpendReceipt({
    manifest: ctx.manifest,
    R,
    txRef: { payer: getAddress(buyerAccount.address), payee: R.payee, amount: FEE_RAW, currency: 'USDC', rail: 'mpp', railReference: railRef },
  });
  check('Spend Receipt binds commitmentId', receipt.commitmentId === ctx.manifest.commitmentId);
  check('Spend Receipt carries MPP rail + railReference', receipt.rail === 'mpp' && receipt.railReference === railRef);
  const leak = receiptMod.assertNoCredentialLeakage(receipt);
  check('Spend Receipt has NO credential leakage', leak && leak.ok === true, String(leak && leak.note));
  check('Spend Receipt noManifest=false', receipt.noManifest === false);
  return { challenge, cred, railRef, receipt };
}

async function runX402Flow(ctx) {
  // ---- x402 flow (same commitment, different rail) ---------------------------
  section('x402 flow — SAME commitment ' + ctx.manifest.commitmentId.slice(0, 10) + '…');
  const R = ctx.requirement;
  const cred = railsX402.realise(R);
  check('x402 realise(R) produces a credential', !!cred && !!cred.payload);
  const ok = await railsX402.validate(cred, R);
  check('x402 rail validate(credential, R) === true', ok === true);
  // settle() returns the registry contract's TransactionReference. x402's
  // implementation returns { railReference, status, ... } — normalize to the
  // public reference string for the receipt binding (same as the gateway does).
  const settleResult = await railsX402.settle(cred);
  const railRef = typeof settleResult === 'string' ? settleResult : (settleResult && settleResult.railReference);
  check('x402 settle() returns a railReference', typeof railRef === 'string' && railRef.length > 10, String(settleResult).slice(0, 40));
  const receipt = gateway.commitmentFlow.buildSpendReceipt({
    manifest: ctx.manifest,
    R,
    txRef: { payer: getAddress(buyerAccount.address), payee: R.payee, amount: FEE_RAW, currency: 'USDC', rail: 'x402', railReference: railRef },
  });
  check('x402 Spend Receipt binds the SAME commitmentId', receipt.commitmentId === ctx.manifest.commitmentId);
  check('x402 Spend Receipt rail=x402 railReference set', receipt.rail === 'x402' && receipt.railReference === railRef);
  const leak = receiptMod.assertNoCredentialLeakage(receipt);
  check('x402 Spend Receipt has NO credential leakage', leak && leak.ok === true, String(leak && leak.note));
  return { cred, railRef, receipt };
}

// ---- main -------------------------------------------------------------------
(async () => {
  section('Setup');
  check('MPP rail registered', rails.resolve('mpp') === railsMpp);
  check('x402 rail registered', rails.resolve('x402') === railsX402);
  process.env.SAAX_SELLER_ADDRESS = getAddress(sellerAccount.address);
  console.log('  buyer:  ' + getAddress(buyerAccount.address));
  console.log('  seller: ' + getAddress(sellerAccount.address));
  console.log('  fee:    ' + FEE_RAW + ' raw USDC ($0.05)');
  console.log('  mode:   ' + (process.env.SAAX_GATEWAY_DRY_RUN === '1' ? 'DRY RUN (no real broadcast)' : 'LIVE BROADCAST'));

  // Commitments: one commitment per rail flow, SAME parameters (the critical
  // rail-agnosticism test uses one shared commitment for both rails).
  section('Commitment + R issuance');
  const sharedCtx = await issueCommitment('security-scan');
  check('manifest issued with manifestHash', /^sha256:/.test(sharedCtx.manifest.manifestHash), sharedCtx.manifest.manifestHash);
  check('exactly one R issued per commitment', !!sharedCtx.requirement.eta && !!sharedCtx.requirement.amt);
  check('R matches manifest amount+currency', sharedCtx.requirement.amt === sharedCtx.manifest.price.amount && sharedCtx.requirement.cur === sharedCtx.manifest.price.currency);

  // MPP flow on the shared commitment.
  const mppResult = await runMppFlow(sharedCtx);

  // x402 flow on the SAME commitment (the architectural proof).
  const x402Result = await runX402Flow(sharedCtx);

  section('Rail-agnosticism — same commitment via both rails');
  check('MPP receipt commitmentId == x402 receipt commitmentId', mppResult.receipt.commitmentId === x402Result.receipt.commitmentId);
  check('Both receipts bound to the SAME manifestHash', mppResult.receipt.manifestHash === x402Result.receipt.manifestHash && mppResult.receipt.manifestHash === sharedCtx.manifest.manifestHash);
  check('Rail references are rail-specific (mpp != x402)', mppResult.receipt.railReference !== x402Result.receipt.railReference);

  // R nonce single-use: consuming once must reject a second consume.
  section('Requirement nonce single-use');
  const c1 = gateway.commitmentFlow.consumeRequirement(sharedCtx.requirement);
  check('first consume ok', c1.ok === true, String(c1 && c1.reason));
  const c2 = gateway.commitmentFlow.consumeRequirement(sharedCtx.requirement);
  check('second consume rejected (replay)', c2.ok === false, String(c2 && c2.reason));

  // ---- summary --------------------------------------------------------------
  console.log('\n=== RESULT ===');
  console.log('passed: ' + passed + ' | failed: ' + failed);
  if (failures.length) { console.log('failures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('RAIL-AGNOSTIC COMMITMENT LIFECYCLE: MPP + x402 both settle the same commitment. ALL PASS.');
  process.exit(0);
})().catch(e => {
  console.log('\nFATAL: ' + (e && e.stack || e));
  process.exit(1);
});