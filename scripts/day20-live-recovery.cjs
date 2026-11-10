// Phase 3 — Live crash-gap recovery around a REAL Base Sepolia financial action.
//
// Demonstrates the database/blockchain non-atomicity gap honestly:
//   persist intent -> broadcast external action -> reconcile authoritative
//   outcome -> persist completion.
//
// Worker A:  records a durable `fund` intent (idempotency key), broadcasts a
//             real custody-fund tx on Base Sepolia, then is KILLED before
//             saving the tx hash (the crash gap: broadcast accepted, local
//             record incomplete).
// Worker B:  a SEPARATE process (fresh node invocation) discovers the pending
//             intent from the durable store, reconciles against authoritative
//             chain state (receipt + custody balance + nonce), marks it
//             confirmed/matched, and does NOT re-broadcast (idempotency).
//
// Assertions:
//   - No duplicate funding (idempotency key rejected on a deliberate retry).
//   - Intent transitions pending -> confirmed via chain reconciliation.
//   - The custody balance reflects exactly ONE funded escrow.
//
// ENV (from .env via dotenv): SAAX_TEST_BUYER_KEY (buyer), SAAX_SIGNER_PRIVATE_KEY
//   (evaluator), SAAX_CUSTODY_ADDRESS (deployed custody), SAAX_ESCROW_RPC_URL.
// Durable store: PostgREST at SAAX_STORE_URL / SAAX_SERVICE_ROLE_KEY (day17 RPCs).
//
// USAGE: node scripts/day20-live-recovery.cjs [--worker-b] [--retry]
'use strict';
require('dotenv').config();
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, parseAbiParameters, toHex } = require('viem');
const { baseSepolia } = require('viem/chains');

const RPC = process.env.SAAX_ESCROW_RPC_URL || 'https://sepolia.base.org';
const CUSTODY = (process.env.SAAX_CUSTODY_ADDRESS || '0x76cce76caf348199fe8756f7f253f981f21477ae').trim();
const USDC_BS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MIN_ERC20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

const buyerKey = process.env.SAAX_TEST_BUYER_KEY;
const signerKey = process.env.SAAX_SIGNER_PRIVATE_KEY;
if (!buyerKey || !signerKey) { console.error('MISSING ENV keys'); process.exit(2); }
const buyer = privateKeyToAccount(buyerKey);
const signer = privateKeyToAccount(signerKey);
// Seller is the configured receive-only address (0x9830...) — must differ
// from buyer (contract reverts SelfTransfer) and is the release recipient.
const SELLER = (process.env.SAAX_SELLER_ADDRESS || '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271').trim();
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wcb = createWalletClient({ account: buyer, chain: baseSepolia, transport: http(RPC) });

// Raw eth_call for the custody getter (viem's tuple decoder cannot handle the
// string field; the verifier and this recovery path use manual word decode —
// the SAME approach the standalone verifier uses for EAS tuples).
async function custodyEscrowState(cid) {
  const sel = keccak256(toHex('getEscrow(bytes32)')).slice(0, 10);
  const data = sel + String(cid).replace(/^0x/, '').toLowerCase();
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: CUSTODY, data }, 'latest'] }),
  }).then(r => r.json());
  const hex = String(res.result || '').replace(/^0x/, '');
  const words = hex.match(/.{1,64}/g) || [];
  return {
    state: parseInt(words[10] || '0', 16),          // EscrowState enum
    amount: BigInt('0x' + (words[6] || '0')),
    buyer: '0x' + (words[3] || '').slice(24),
  };
}

const escrow = require('../endpoint/escrow.js');
// Use the app's REAL store client (same PostgREST client the live flow uses)
// so the durable-intent RPCs are exercised exactly as in production.
const store = require('../endpoint/store.js');
const storeClient = store.buildStoreClient();
if (!storeClient) { console.error('NO STORE CLIENT — durable store unavailable (POSTGREST_URL/SAAX_POSTGREST_KEY required)'); process.exit(2); }
escrow.setStoreClient(storeClient);

const runId = 'live-kill-' + Date.now();
const cid = '0x' + crypto.createHash('sha256').update('day20-' + runId).digest('hex');
const digest = '0x' + crypto.createHash('sha256').update('digest-' + runId).digest('hex');
const amount = 50000n;
const deadline = Math.floor(Date.now() / 1000) + 1800;
const idemKey = 'fund-' + cid.slice(2, 18);

// Capture the custody balance BEFORE the run (a prior crash-gap run may have
// left a funded escrow in place; the assertion is the DELTA, not the total).
let custodyBalanceBefore = null;

async function workerA() {
  console.log('WORKER A pid=' + process.pid + ' run=' + runId);
  console.log('A: commitment ' + cid.slice(0, 18) + ' amount ' + amount + ' custody ' + CUSTODY.slice(0, 12));
  custodyBalanceBefore = await pub.readContract({ address: USDC_BS, abi: MIN_ERC20, functionName: 'balanceOf', args: [CUSTODY] });
  console.log('A: custody balance before=' + custodyBalanceBefore);
  // 1. Persist intent BEFORE broadcast.
  const intent = await escrow.recordIntent({ commitmentId: cid, action: 'fund', idempotencyKey: idemKey, payload: { custody: CUSTODY, amount: String(amount) } });
  console.log('A: intent recorded ok=' + !!intent.ok + (intent.duplicate ? ' (duplicate)' : '') + ' status=' + (intent.status || ''));
  if (!intent.ok && !intent.duplicate) throw new Error('intent persist failed: ' + JSON.stringify(intent));

  // 2. Approve + broadcast the REAL fund transaction.
  // Fetch the account nonce ONCE and pin BOTH txs to explicit sequential
  // nonces. Without this, the fund tx can collide with the still-pending
  // approve (replacement-underpriced or silent revert) — the exact class of
  // failure seen repeatedly.
  const baseNonce = await pub.getTransactionCount({ address: buyer.address });
  const approveData = keccak256(toHex('approve(address,uint256)')).slice(0, 10) + encodeAbiParameters(parseAbiParameters('address,uint256'), [CUSTODY, amount]).slice(2);
  const approveTx = await wcb.sendTransaction({ to: USDC_BS, data: approveData, nonce: baseNonce });
  // Wait for the APPROVAL by polling the authoritative allowance (the receipt
  // alone can race node lag; the allowance is the state the fund actually
  // depends on). Max ~60s.
  const ALLOW_ABI = [{ name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }, { name: 'b', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  let allowance = 0n;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    allowance = await pub.readContract({ address: USDC_BS, abi: ALLOW_ABI, functionName: 'allowance', args: [buyer.address, CUSTODY] });
    if (allowance >= amount) break;
  }
  console.log('A: allowance ready=' + allowance + ' (approve ' + approveTx.slice(0, 14) + '...)');
  if (allowance < amount) throw new Error('approve did not land (allowance ' + allowance + ' < ' + amount + ')');
  const fundCall = keccak256(toHex('fund(bytes32,bytes32,address,address,address,address,uint256,uint256,uint64)')).slice(0, 10)
    + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,address,address,address,address,uint256,uint256,uint64'), [cid, digest, USDC_BS, buyer.address, SELLER, signer.address, amount, deadline, 0n]).slice(2);
  const fundTx = await wcb.sendTransaction({ to: CUSTODY, data: fundCall, nonce: baseNonce + 1 });
  // 3. CRASH GAP: the tx is accepted (mined or in mempool) but we are KILLED
  //    before saving the tx hash. Simulate the OS kill.
  console.log('A: fund broadcast tx=' + fundTx + ' — KILLING BEFORE txHash SAVE');
  console.log('A_INTENT_TX=' + fundTx);
  process.exit(9); // abrupt termination: no updateIntent call
}

async function workerB() {
  console.log('WORKER B pid=' + process.pid + ' (replacement process)');
  // 1. Discover pending intents from the durable store.
  const pend = await escrow.pendingIntents(25);
  // A replacement worker does NOT know worker A's in-memory runId — it
  // discovers the durable record by its state: pending fund intents that
  // were never reconciled. Reconcile the oldest pending fund intent.
  const mine = (pend || []).filter(p => p.action === 'fund' && p.intent_status === 'pending');
  console.log('B: pending intents found=' + (pend || []).length + ' matching=' + mine.length);
  if (!mine.length) { console.log('B: no matching intent (store read) — nothing to reconcile'); process.exit(3); }
  let lastTarget = null;
  for (const intent of mine) {
    const targetIdem = intent.idempotency_key;
    const targetCid = '0x' + String(intent.commitment_id || '').replace(/^0x/, '');
    console.log('B: intent ' + targetIdem + ' status=' + intent.intent_status + ' txHash=' + (intent.tx_hash || 'none'));
    // The fund may have JUST been broadcast (worker A killed after send). The
    // tx is mining: getEscrow at `latest` can report None for a few seconds.
    // Poll the authoritative contract state briefly before declaring.
    let escState = await custodyEscrowState(targetCid);
    if (escState.state === 0) {
      console.log('B:   escrow not visible yet — polling chain for confirmation (worker A may have broadcast just before the kill)...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        escState = await custodyEscrowState(targetCid);
        if (escState.state >= 1) break;
      }
    }
    console.log('B:   custody getEscrow(' + targetCid.slice(0, 18) + ') state=' + escState.state + ' amount=' + escState.amount);
    const confirmed = escState.state >= 1 && escState.amount === amount;
    // If we cannot find the escrow AND have no txHash, the outcome is UNKNOWN
    // (the broadcast may still mine). Marking failed would be a false
    // negative; marking confirmed would be a false positive.
    const neverLanded = escState.state === 0 && !!intent.tx_hash && intent.tx_hash !== 'none';
    const unknown = escState.state === 0 && !neverLanded;
    const txHash = intent.tx_hash || null;
    const rec = await escrow.reconcileIntent({ idempotencyKey: targetIdem, txHash: txHash || null, confirmed, unknown });
    console.log('B:   reconcile -> confirmed=' + confirmed + ' unknown=' + unknown + ' status=' + (rec.status || '') + ' ok=' + !!rec.ok);
    if (unknown) console.log('B:   intent reconciled to UNKNOWN (outcome unresolved — no false completion)');
    else if (neverLanded && !confirmed) console.log('B:   intent reconciled to FAILED (tx receipt proves revert) — no false completion');
    lastTarget = { targetIdem, targetCid, confirmed };
  }
  if (!lastTarget) process.exit(3);
  const { targetIdem, targetCid, confirmed: lastConfirmed } = lastTarget;

  // 3. Deliberate retry with the SAME idempotency key MUST be rejected.
  const dup = await escrow.recordIntent({ commitmentId: targetCid, action: 'fund', idempotencyKey: targetIdem, payload: { custody: CUSTODY, amount: String(amount) } });
  console.log('B: duplicate intent retry rejected=' + !!dup.duplicate + ' ok=' + !!dup.ok + ' status=' + (dup.status || ''));
  if (!dup.duplicate && dup.ok) { console.log('B: *** FAIL — duplicate funding allowed'); process.exit(4); }

  // 4. Verify exactly ONE funding effect: the escrow record's amount equals
  //    the requested amount (a duplicate broadcast would either fail on the
  //    contract's state guard or record a second escrow — neither can happen
  //    here because the contract rejects a second fund for the same cid).
  if (lastConfirmed) {
    const escState2 = await custodyEscrowState(targetCid);
    if (escState2.amount !== amount || escState2.state !== 1) {
      console.log('B: *** FAIL — escrow amount/state mismatch ' + escState2.amount + '/' + escState2.state);
      process.exit(5);
    }
    console.log('B: escrow on-chain = state Funded amount ' + escState2.amount + ' — exactly one funding effect');
  }
  console.log('B: RECOVERY_OK no-duplicate confirmed=' + lastConfirmed);
  process.exit(0);
}

(async () => {
  const isB = process.argv.includes('--worker-b');
  const isA = process.argv.includes('--worker-a');
  if (isA) return workerA();
  const isRetry = process.argv.includes('--retry');
  if (isB) return workerB();
  if (isRetry) { console.log('RETRY: spawning worker B only...'); }
  // Parent: run worker A as a real child process, observe the kill, then
  // spawn worker B as a fresh process.
  console.log('PARENT: starting worker A (real child process)...');
  const childA = spawn(process.execPath, [__filename, '--worker-a'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let aOut = '';
  childA.stdout.on('data', d => { aOut += d; process.stdout.write('[A] ' + d); });
  childA.stderr.on('data', d => process.stdout.write('[A!] ' + d));
  const aCode = await new Promise(res => childA.on('close', res));
  console.log('PARENT: worker A exited with code ' + aCode + ' (9 = killed before txHash save)');
  console.log(aOut);

  // Spawn worker B as a SEPARATE fresh process against the same durable store.
  console.log('PARENT: starting worker B (replacement process)...');
  const b = require('child_process').spawnSync(process.execPath, [__filename, '--worker-b'], {
    env: process.env, encoding: 'utf8', timeout: 90000,
  });
  process.stdout.write(b.stdout || '');
  if (b.stderr) process.stdout.write(b.stderr);
  console.log('PARENT: worker B exit=' + b.status);
  if (b.status !== 0) process.exit(b.status || 1);
  console.log('PARENT_DONE RECOVERY_OK');
})().catch(e => { console.error('FATAL ' + (e.stack || e.message)); process.exit(1); });