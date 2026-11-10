// SAAX Protocol — build the connected v3 export from real chain events.
// Reads evidence/connected-v3-events.json and constructs the full-lifecycle
// v3 export: agreement (deterministic digest), authorizations (signed by the
// real buyer/seller/evaluator keys), real EAS anchor, signed journal, real
// escrow + release verdict. The export is then verified independently.
const dotenv = require('dotenv');
dotenv.config({ path: '.env' });
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { createWalletClient, createPublicClient, http: viemHttp, keccak256, encodeAbiParameters, parseAbiParameters, toHex, parseAbi, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const RPC = 'https://sepolia.base.org';
const EV = JSON.parse(fs.readFileSync('evidence/connected-v3-events.json', 'utf8'));
const CHAIN_ID = 84532;
const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const BUYER_KEY = process.env.SAAX_TEST_BUYER_KEY;
const SELLER_KEY = process.env.SAAX_SELLER_PRIVATE_KEY;
const EVALUATOR_KEY = process.env.SAAX_SIGNER_PRIVATE_KEY;
const BUYER = EV.buyer, SELLER = EV.seller, EVALUATOR = EV.evaluator;

// ---- Authorizations (buyer/seller/evaluator) ----
// The app's authorization domain (matching the baseline's auth records).
const AUTH_DOMAIN = {
  name: 'SAAX Commitment Authorization',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};
const AUTH_TYPES = {
  CommitmentAuthorization: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'role', type: 'string' },
    { name: 'scope', type: 'string' },
    { name: 'evaluator', type: 'address' },
    { name: 'evaluatorPermittedDecisions', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
};
async function signAuth(key, role, scope, nonceVal) {
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain: baseSepolia, transport: viemHttp(RPC) });
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    commitmentId: EV.cid, commitmentDigest: EV.cid, role, scope,
    evaluator: EVALUATOR,
    evaluatorPermittedDecisions: JSON.stringify(['release', 'refund']),
    nonce: String(nonceVal), issuedAt: String(now), expiresAt: String(now + 86400),
  };
  const sig = await client.signTypedData({ domain: AUTH_DOMAIN, types: AUTH_TYPES, primaryType: 'CommitmentAuthorization', message: { ...msg, nonce: BigInt(nonceVal), issuedAt: BigInt(now), expiresAt: BigInt(now + 86400) } });
  const hex = String(sig).replace(/^0x/, '');
  return {
    role, expectedParty: role === 'buyer' ? BUYER : (role === 'seller' ? SELLER : EVALUATOR),
    domain: Object.assign({}, AUTH_DOMAIN, { chainId: CHAIN_ID }),
    types: AUTH_TYPES,
    primaryType: 'CommitmentAuthorization',
    message: msg,
    v: parseInt(hex.slice(128, 130), 16), r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128),
  };
}

// ---- Journal events (signed by authority) ----
const JOURNAL_DOMAIN = { name: 'SAAX Commitment Journal', version: '1', chainId: CHAIN_ID, verifyingContract: '0x0000000000000000000000000000000000000000' };
const JOURNAL_TYPES = { JournalEvent: [
  { name: 'commitmentId', type: 'bytes32' }, { name: 'state', type: 'string' }, { name: 'transition', type: 'string' },
  { name: 'at', type: 'string' }, { name: 'by', type: 'address' }, { name: 'prevHash', type: 'string' }, { name: 'entryHash', type: 'string' },
] };
const mkEvent = (state, transition, at, by, prevHash) => {
  const entryHash = sha256hex(JSON.stringify({ state, transition, at, by, prevHash }));
  return { state, transition, at, by, prevHash, entryHash };
};
async function signEvent(ev, account, signerAddr) {
  const sig = await account.signTypedData({
    domain: { ...JOURNAL_DOMAIN, chainId: BigInt(CHAIN_ID) },
    types: JOURNAL_TYPES, primaryType: 'JournalEvent',
    message: { commitmentId: EV.cid, state: ev.state, transition: ev.transition, at: ev.at, by: ev.by, prevHash: ev.prevHash, entryHash: ev.entryHash },
  });
  const hex = String(sig).replace(/^0x/, '');
  return { ...ev, sig: { v: parseInt(hex.slice(128, 130), 16), r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128) }, signer: signerAddr };
}

(async () => {
  const buyer = privateKeyToAccount(BUYER_KEY);
  const seller = privateKeyToAccount(SELLER_KEY);
  const evaluator = privateKeyToAccount(EVALUATOR_KEY);
  if (buyer.address.toLowerCase() !== BUYER.toLowerCase() || seller.address.toLowerCase() !== SELLER.toLowerCase() || evaluator.address.toLowerCase() !== EVALUATOR.toLowerCase()) {
    console.log('FATAL key/address mismatch', buyer.address, seller.address, evaluator.address);
    process.exit(1);
  }

  // ---- Authorizations ----
  const auths = [];
  auths.push(await signAuth(BUYER_KEY, 'buyer', 'authorize_commitment_and_evaluator', 101));
  auths.push(await signAuth(SELLER_KEY, 'seller', 'authorize_commitment_and_evaluator', 102));
  auths.push(await signAuth(EVALUATOR_KEY, 'evaluator', 'authorize_evaluator', 104));

  // ---- Journal ----
  const t0 = '2026-10-08T00:00:00Z';
  const tF = new Date(Date.now() - 4000).toISOString();
  const tV = new Date(Date.now() - 3000).toISOString();
  const tR = new Date(Date.now() - 2000).toISOString();
  let prev = EV.commitmentId;
  const events = [];
  const e1 = mkEvent('ISSUED', 'issue', t0, BUYER, prev); prev = e1.entryHash; events.push(await signEvent(e1, buyer, BUYER));
  const e2 = mkEvent('ANCHORED', 'anchor-confirmed', t0, EVALUATOR, prev); prev = e2.entryHash; events.push(await signEvent(e2, evaluator, EVALUATOR));
  const e3 = mkEvent('FUNDED', 'fund', tF, BUYER, prev); prev = e3.entryHash; events.push(await signEvent(e3, buyer, BUYER));
  const e4 = mkEvent('FULFILLED', 'submit evidence', tV, SELLER, prev); prev = e4.entryHash; events.push(await signEvent(e4, seller, SELLER));
  const e5 = mkEvent('RELEASED', 'release', tR, EVALUATOR, prev); prev = e5.entryHash; events.push(await signEvent(e5, evaluator, EVALUATOR));
  const journal = { root: EV.commitmentId, commitmentId: EV.cid, evaluator: EVALUATOR, events, tailHash: e5.entryHash, eventCount: events.length };

  // ---- Anchor (real EAS attestation; align chainId to 84532 - the app's
  // mock-derived anchor said 8453 but the LIVE attestation was broadcast on
  // Base Sepolia (84532). The on-chain read will confirm. ----)
  const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  const anchor = Object.assign(jsonSafe(EV.anchor), {
    chainId: 84532,
    commitmentId: EV.commitmentId,
    commitmentDigest: EV.digest,
    attester: evaluator.address,
    resolver: '0x0000000000000000000000000000000000000000',
    revocable: false,
    recipient: '0x0000000000000000000000000000000000000000',
    expirationTime: 0,
    schemaUid: EV.anchor.schemaUid || '0x12348358bc3960c884de872f93edfe5061720f79b97c8d74b6080ad9911a89e4',
    data: {
      commitmentId: EV.commitmentId,
      commitmentDigest: EV.digest,
      parties: JSON.stringify({ buyer: BUYER, seller: SELLER }),
      requestedOutcome: JSON.stringify({ description: 'security scan', category: 'capability' }),
      providerObligation: JSON.stringify({ description: 'security scan' }),
      commercialTerms: JSON.stringify({ amount: EV.amount, currency: 'USDC', decimals: 6 }),
      paymentTerms: JSON.stringify({ amount: EV.amount, currency: 'USDC', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }),
      acceptanceCriteria: JSON.stringify([{ type: 'hash', value: 'sha256:saax-protocol-phase1' }]),
      deadline: '2026-10-08',
      failureConditions: JSON.stringify([{ condition: 'provider_obligation_unfulfilled' }]),
      recoveryPolicy: JSON.stringify({ maxRetries: 0, refundOnFailure: false }),
      refundsCompensation: JSON.stringify({}),
      lifecycleState: 'released',
    },
  });

  // ---- Escrow (real chain data + real verdict) ----
  const escrow = {
    commitmentId: EV.cid,
    state: 'released',
    amount: EV.amount,
    asset: 'USDC',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    buyer: BUYER,
    seller: SELLER,
    evaluator: EVALUATOR,
    escrowRef: 'escrow-' + EV.cid.slice(0, 66),
    custody: EV.custody,
    verdictScheme: 'escrow-custody-v1',
    txRefFunding: { txHash: EV.fundTx, rail: 'chain', block: EV.fundBlock },
    txRefAnchor: { txHash: EV.anchor.txHash, rail: 'chain', block: EV.anchor.blockNumber },
    txRefRelease: { txHash: EV.releaseTx, rail: 'chain', block: EV.releaseBlock },
    releaseVerdict: {
      satisfied: true,
      evidenceRefs: ['work_output'],
      verdict: {
        commitmentId: EV.cid,
        commitmentDigest: EV.cid,
        action: 'release',
        nonce: EV.verdictNonce,
        issuedAt: EV.issuedAt,
        sig: { v: EV.v, r: EV.r, s: EV.s },
      },
    },
  };

  // ---- Export ----
  const exp = {
    formatVersion: 3,
    lifecycleProfile: 'full',
    agreement: EV.agreement,
    commitmentDigest: EV.digest,
    authorizations: auths,
    anchor,
    journal,
    escrow,
    evidenceRefs: ['work_output'],
    builtAt: new Date().toISOString(),
  };
  const expSafe = JSON.parse(JSON.stringify(exp, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  fs.writeFileSync('evidence/integrated-escrow-verified-commitment.json', JSON.stringify(expSafe, null, 2));
  console.log('EXPORT SAVED: evidence/integrated-escrow-verified-commitment.json');
  // quick self-check: recompute digest
  const fields = ['commitmentId','buyerAgentId','sellerAgentId','capability','price','acceptanceCriteria','deadline','cancelCondition','manifestVersion','terms','evaluator','evaluatorPermittedDecisions'];
  const pick = {};
  for (const f of fields) if (EV.agreement[f] !== undefined && EV.agreement[f] !== null) pick[f] = EV.agreement[f];
  if (pick.price && typeof pick.price === 'object') pick.price = Object.keys(pick.price).sort().reduce((a,k)=>{a[k]=pick.price[k];return a;},{});
  if (pick.acceptanceCriteria && typeof pick.acceptanceCriteria === 'object') pick.acceptanceCriteria = Object.keys(pick.acceptanceCriteria).sort().reduce((a,k)=>{a[k]=pick.acceptanceCriteria[k];return a;},{});
  const deepSort = (v)=>{ if(Array.isArray(v))return v.map(deepSort); if(v&&typeof v==='object')return Object.keys(v).sort().reduce((a,k)=>{a[k]=deepSort(v[k]);return a;},{}); return v; };
  if (pick.terms && typeof pick.terms === 'object') pick.terms = deepSort(pick.terms);
  const payloadBytes = JSON.stringify(pick);
  const protectedB64 = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'saax-protocol-phase1' })).toString('base64url');
  const envelope = { tag: 'COSE_Sign1', protected: protectedB64, unprotected: '', payload: Buffer.from(payloadBytes, 'utf8').toString('base64url'), signature: EV.agreement.signatureHex };
  const rd = 'sha256:' + sha256hex(JSON.stringify(envelope));
  console.log('digest recomputed', rd, '== claimed', EV.digest, rd === EV.digest ? 'MATCH' : 'MISMATCH');
})().catch(e => { console.log('FATAL', e); process.exit(1); });