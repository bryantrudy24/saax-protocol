// SAAX Protocol — recovery worker 1 (broadcast worker).
// Fresh v3 digest -> real EAS anchor -> fund custody -> durable accept the
// release op -> sign contract-scheme verdict -> BROADCAST release -> write
// kill evidence -> die before the receipt is recorded (crash gap).
require('dotenv').config({ path: '.env' });
process.env.SAAX_CHAIN_ID = '84532';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWalletClient, createPublicClient, http: viemHttp, keccak256, encodeAbiParameters, parseAbiParameters, toHex, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const RPC = 'https://sepolia.base.org';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BUYER = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';
const SELLER = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271';
const EVALUATOR = '0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70';
const AMOUNT = 50000n;
const ESCROW_ABI = JSON.parse(fs.readFileSync('data/escrow-custody-build.json', 'utf8')).abi;
const MIN = parseAbi(['function balanceOf(address who) external view returns (uint256)']);
const DOMAIN = { name: 'SAAX Escrow Custody V1', version: '1', chainId: BigInt(84532), verifyingContract: CUSTODY };
const TYPES = { EscrowVerdict: [
  { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' },
] };

// ---- v3 manifest (mirror of the verifier's canonicManifest, identical to
// _connected-v3.cjs so the digest reproduces identically) ----
const MANIFEST_FIELDS_V3 = ['commitmentId', 'buyerAgentId', 'sellerAgentId', 'capability', 'price', 'acceptanceCriteria', 'deadline', 'cancelCondition', 'manifestVersion', 'terms', 'evaluator', 'evaluatorPermittedDecisions'];
function deepSortKeys(v) {
  if (Array.isArray(v)) return v.map(deepSortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, k) => { a[k] = deepSortKeys(v[k]); return a; }, {});
  return v;
}
function canonicManifestV3(record) {
  const pick = {};
  for (const f of MANIFEST_FIELDS_V3) {
    if (record[f] === undefined || record[f] === null) continue;
    pick[f] = record[f];
  }
  if (pick.price && typeof pick.price === 'object') pick.price = Object.keys(pick.price).sort().reduce((a, k) => { a[k] = pick.price[k]; return a; }, {});
  if (pick.acceptanceCriteria && typeof pick.acceptanceCriteria === 'object') pick.acceptanceCriteria = Object.keys(pick.acceptanceCriteria).sort().reduce((a, k) => { a[k] = pick.acceptanceCriteria[k]; return a; }, {});
  if (pick.terms && typeof pick.terms === 'object') pick.terms = deepSortKeys(pick.terms);
  return JSON.stringify(pick);
}
function rebuildEnvelopeV3(record, signatureHex) {
  const payloadBytes = canonicManifestV3(record);
  const protectedB64 = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'saax-protocol-phase1' })).toString('base64url');
  return { tag: 'COSE_Sign1', protected: protectedB64, unprotected: '', payload: Buffer.from(payloadBytes, 'utf8').toString('base64url'), signature: signatureHex };
}
function recomputeDigestV3(record, signatureHex) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(rebuildEnvelopeV3(record, signatureHex)), 'utf8').digest('hex');
}

const COMMITMENT_ID = '0x' + crypto.randomBytes(32).toString('hex');
const SIGNATURE_HEX = '0x' + '00'.repeat(65);
const AGREEMENT = {
  commitmentId: COMMITMENT_ID,
  buyerAgentId: BUYER,
  sellerAgentId: SELLER,
  capability: 'security scan',
  price: { amount: String(AMOUNT), currency: 'USDC', decimals: 6 },
  acceptanceCriteria: { type: 'hash', value: 'sha256:saax-protocol-phase1' },
  deadline: '2026-10-08',
  cancelCondition: 'buyer-cancel-before-delivery',
  issuedAt: new Date().toISOString(),
  signatureHex: SIGNATURE_HEX,
  manifestVersion: 3,
  terms: {
    schemaVersion: 'saax-commitment-v3',
    hashingVersion: 'sha256-cose-v3',
    signatureDomainVersion: 'saax-commitment-auth-v3',
    policyVersion: 'saax-policy-v3',
    evidencePolicy: { type: 'evidence_hidden_answer_set_v1', requiredRefs: ['work_output'], verdictRequired: true, evaluatorRequired: true },
    recoveryRules: { workerKill: 'reconcile_intent_before_retry', lostAck: 'query_chain_authoritative', timeoutRefund: 'refund_on_deadline_if_no_verdict' },
  },
  evaluator: EVALUATOR,
  evaluatorPermittedDecisions: ['release', 'refund'],
};
const DIGEST = recomputeDigestV3(AGREEMENT, SIGNATURE_HEX);
const CID = '0x' + DIGEST.slice('sha256:'.length).slice(0, 64);

const LEDGER = process.env.SAAX_ESCROW_LEDGER || path.join(__dirname, '..', 'data', 'recovery-ledger.json');
const OUT = {
  commitmentId: COMMITMENT_ID, digest: DIGEST, cid: CID, custody: CUSTODY,
  buyer: BUYER, seller: SELLER, evaluator: EVALUATOR, amount: String(AMOUNT),
  agreement: AGREEMENT, signatureHex: SIGNATURE_HEX,
};

(async () => {
  const buyerPk = process.env.SAAX_TEST_BUYER_KEY;
  const signerPk = process.env.SAAX_SIGNER_PRIVATE_KEY;
  const buyer = privateKeyToAccount(buyerPk);
  const signer = privateKeyToAccount(signerPk);
  if (buyer.address.toLowerCase() !== BUYER.toLowerCase() || signer.address.toLowerCase() !== EVALUATOR.toLowerCase()) {
    console.log('FATAL key mismatch buyer=' + buyer.address + ' signer=' + signer.address); process.exit(1);
  }
  const pub = createPublicClient({ chain: baseSepolia, transport: viemHttp(RPC) });
  const chainId = await pub.getChainId();
  if (chainId !== 84532) { console.log('FATAL chain ' + chainId); process.exit(1); }
  console.log('W1 chainId', chainId, 'pid', process.pid);
  console.log('W1 commitmentId', COMMITMENT_ID);
  console.log('W1 v3 digest (cid)', CID);

  // ---- a. real EAS anchor ----
  process.env.SAAX_EAS_MODE = 'live';
  const easMod = require('../endpoint/eas.js');
  const anchorCommitment = {
    commitmentId: COMMITMENT_ID, commitmentDigest: DIGEST,
    parties: JSON.stringify({ buyer: BUYER, seller: SELLER }),
    requestedOutcome: JSON.stringify({ description: 'security scan', category: 'capability' }),
    providerObligation: JSON.stringify({ description: 'security scan' }),
    commercialTerms: JSON.stringify({ amount: String(AMOUNT), currency: 'USDC', decimals: 6 }),
    paymentTerms: JSON.stringify({ amount: String(AMOUNT), currency: 'USDC', asset: USDC }),
    acceptanceCriteria: JSON.stringify([{ type: 'hash', value: 'sha256:saax-protocol-phase1' }]),
    deadline: '2026-10-08',
    failureConditions: JSON.stringify([{ condition: 'provider_obligation_unfulfilled' }]),
    recoveryPolicy: JSON.stringify({ maxRetries: 0, refundOnFailure: false }),
    refundsCompensation: JSON.stringify({}),
    lifecycleState: 'issued',
  };
  const att = await easMod.attestCommitment(anchorCommitment, { rpcUrl: RPC });
  console.log('W1 EAS attest', att.ok ? 'OK uid=' + String(att.anchor && att.anchor.uid).slice(0, 20) + ' tx=' + String(att.anchor && att.anchor.txHash).slice(0, 18) + ' block=' + String(att.anchor && att.anchor.blockNumber) : JSON.stringify(att).slice(0, 200));
  if (!att.ok || !att.anchor || !att.anchor.uid || /^0x0+$/.test(String(att.anchor.uid))) { console.log('FATAL EAS'); process.exit(1); }
  OUT.anchor = att.anchor;

  // ---- b. buyer approves + funds against the EXACT v3 digest ----
  const wb = createWalletClient({ account: buyer, chain: baseSepolia, transport: viemHttp(RPC) });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
  const approveData = keccak256(toHex('approve(address,uint256)')).slice(0, 10) + encodeAbiParameters(parseAbiParameters('address,uint256'), [CUSTODY, AMOUNT]).slice(2);
  const approveTx = await wb.sendTransaction({ to: USDC, data: approveData, account: buyer, gas: 80000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  let rec = null;
  for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 2500)); rec = await pub.getTransactionReceipt({ hash: approveTx }).catch(() => null); if (rec && (rec.status === 'success' || rec.status === 'reverted')) break; }
  if (!rec || rec.status !== 'success') { console.log('FATAL approve'); process.exit(1); }
  console.log('W1 approve tx', approveTx, 'block', String(rec.blockNumber));

  const fundData = keccak256(toHex('fund(bytes32,bytes32,address,address,address,address,uint256,uint256,uint64)')).slice(0, 10)
    + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,address,address,address,address,uint256,uint256,uint64'), [CID, CID, USDC, BUYER, SELLER, EVALUATOR, AMOUNT, deadline, 0n]).slice(2);
  const fundTx = await wb.sendTransaction({ to: CUSTODY, data: fundData, account: buyer, gas: 400000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  rec = null;
  for (let i = 0; i < 35; i++) { await new Promise(r => setTimeout(r, 2500)); rec = await pub.getTransactionReceipt({ hash: fundTx }).catch(() => null); if (rec && (rec.status === 'success' || rec.status === 'reverted')) break; }
  if (!rec || rec.status !== 'success') { console.log('FATAL fund'); process.exit(1); }
  console.log('W1 fund tx', fundTx, 'block', String(rec.blockNumber));
  const afterFund = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [CID] });
  const fundState = ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(afterFund[9])];
  console.log('W1 escrow after fund', fundState, 'amount', afterFund[6].toString(), 'evaluator', afterFund[5]);
  if (fundState !== 'funded' || String(afterFund[6]) !== String(AMOUNT) || afterFund[5].toLowerCase() !== EVALUATOR.toLowerCase()) { console.log('FATAL fund bindings'); process.exit(1); }
  OUT.fundTx = fundTx; OUT.fundBlock = String(rec.blockNumber);

  // ---- c. durable acceptance of the release operation (nonce consumed) ----
  const escrowAccess = require('../endpoint/escrow-access.js');
  const accNonce = String(Math.floor(Date.now() / 1000));
  const accessPayload = {
    role: 'evaluator', commitmentDigest: CID, escrowId: CID, custody: CUSTODY, chainId: '84532',
    action: 'submit verdict', nonce: accNonce, expiry: String(Math.floor(Date.now() / 1000) + 3600),
  };
  const acc = escrowAccess.acceptOperation(accessPayload, { action: 'submit verdict' });
  console.log('W1 acceptOperation', JSON.stringify(acc));
  if (!acc.ok || !acc.recorded || acc.recorded.status !== 'accepted') { console.log('FATAL accept'); process.exit(1); }

  // ---- d. evaluator verdict (contract scheme) + release broadcast ----
  const ws = createWalletClient({ account: signer, chain: baseSepolia, transport: viemHttp(RPC) });
  let vNonce = BigInt(Math.floor(Date.now() / 1000));
  let used = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'usedVerdictNonce', args: [vNonce] });
  while (used) { vNonce += 1n; used = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'usedVerdictNonce', args: [vNonce] }); }
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const sellerBalBefore = await pub.readContract({ address: USDC, abi: MIN, functionName: 'balanceOf', args: [SELLER] });
  const vSig = await ws.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'EscrowVerdict', message: { commitmentId: CID, commitmentDigest: CID, action: 'release', nonce: vNonce, issuedAt } });
  const vv = parseInt(vSig.slice(130, 132), 16);
  const relCall = keccak256(toHex('release(bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32)')).slice(0, 10)
    + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32'), [CID, CID, vNonce, issuedAt, vv, '0x' + vSig.slice(2, 66), '0x' + vSig.slice(66, 130)]).slice(2);
  const relNonce = await pub.getTransactionCount({ address: signer.address });
  const relTx = await ws.sendTransaction({ to: CUSTODY, data: relCall, account: signer, gas: 1000000n, nonce: BigInt(relNonce), maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  console.log('W1 release BROADCAST tx', relTx, 'verdictNonce', String(vNonce), 'issuedAt', String(issuedAt), 'relNonce', String(relNonce));
  console.log('W1 releasing... receipt NOT recorded (crash gap) — killing self now');

  // ---- e. write kill evidence + handoff, THEN die before receipt recording ----
  OUT.releaseTx = relTx;
  OUT.verdictNonce = String(vNonce); OUT.issuedAt = String(issuedAt);
  OUT.verdictSignature = vSig; OUT.v = vv; OUT.r = '0x' + vSig.slice(2, 66); OUT.s = '0x' + vSig.slice(66, 130);
  OUT.sellerBalBefore = String(sellerBalBefore);
  OUT.acceptNonce = accNonce;
  OUT.killEvidence = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    lastLogLine: 'W1 release BROADCAST tx ' + relTx + ' — receipt NOT recorded (crash gap)',
    boundary: 'after-broadcast-before-receipt',
  };
  fs.writeFileSync('evidence/recovery-kill-evidence.json', JSON.stringify(OUT.killEvidence, null, 2));
  fs.writeFileSync('evidence/recovery-events.json', JSON.stringify(OUT, null, 2));
  console.log('W1 DONE kill evidence + handoff written; exiting (simulated crash)');
  process.exit(9); // hard crash — the receipt is never recorded by this worker
})().catch((e) => { console.log('W1 FATAL', e.message); process.exit(1); });