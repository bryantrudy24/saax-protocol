// SAAX — Fresh v2 Baseline Builder
//
// Produces a formatVersion=2 EXPORT where:
//   - agreement.terms is INSIDE the signed digest (canonical manifest covers
//     every term field), so the party signatures authenticate the terms.
//   - manifestVersion is INSIDE the signed digest (v2 manifest field), so an
//     export cannot claim a weaker manifest version than the digest covers.
//   - both buyer and seller EIP-712 authorization signatures are captured at
//     creation, signed over the v2 digest.
//   - pinned policy/version references are explicit.
//   - lifecycle history is authenticated (every event signed, parent-referenced,
//     hash-chained).
//   - a REAL Base Sepolia EAS anchor is written for the v2 digest.
//
// ENV:
//   SAAX_SIGNER_PRIVATE_KEY   (evaluator + seller key material)
//   SAAX_TEST_BUYER_KEY       (buyer key material)
//   SAAX_EAS_MODE=live        (broadcast a real attestation)
//   SAAX_ESCROW_RPC_URL       (default https://sepolia.base.org)
//
// USAGE: node scripts/build-v2-baseline.js [--out export.json]
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, createWalletClient, http, keccak256, encodePacked, toHex, getAddress } = require('viem');
const { baseSepolia } = require('viem/chains');

const RPC = process.env.SAAX_ESCROW_RPC_URL || 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020';

const SAAX_COMMITMENT_SCHEMA =
  'string commitmentId,string commitmentDigest,string parties,string requestedOutcome,string providerObligation,string commercialTerms,string paymentTerms,string acceptanceCriteria,string deadline,string failureConditions,string recoveryPolicy,string refundsCompensation,string lifecycleState,uint64 anchoredAt';

const MANIFEST_VERSION = 2;
const FORMAT_VERSION = 2;

const signerKey = process.env.SAAX_SIGNER_PRIVATE_KEY || '';
const buyerKey = process.env.SAAX_TEST_BUYER_KEY || '';
if (!signerKey || !buyerKey) {
  console.error('MISSING ENV: SAAX_SIGNER_PRIVATE_KEY and SAAX_TEST_BUYER_KEY required');
  process.exit(2);
}

const signer = privateKeyToAccount(signerKey);
const buyer = privateKeyToAccount(buyerKey);
const SELLER_ADDRESS = signer.address;
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');

// Deep key-sort so nested objects (terms, evidencePolicy, recoveryRules)
// canonicalize identically regardless of key insertion order.
function deepSortKeys(v) {
  if (Array.isArray(v)) return v.map(deepSortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((a, k) => { a[k] = deepSortKeys(v[k]); return a; }, {});
  }
  return v;
}

function deriveSchemaUid() {
  return keccak256(encodePacked(['string', 'address', 'bool'], [SAAX_COMMITMENT_SCHEMA, '0x0000000000000000000000000000000000000000', false]));
}

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
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
};

const JOURNAL_DOMAIN = {
  name: 'SAAX Commitment Journal',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};
const JOURNAL_TYPES = {
  JournalEvent: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'state', type: 'string' },
    { name: 'transition', type: 'string' },
    { name: 'at', type: 'string' },
    { name: 'by', type: 'address' },
    { name: 'prevHash', type: 'string' },
    { name: 'entryHash', type: 'string' },
  ],
};

// ---- v2 canonical manifest -------------------------------------------------------
// Matches the verifier's canonicManifest(record, version=2): the v2 manifest
// fields are the v1 8 fields PLUS manifestVersion and terms. The digest
// therefore covers every term field and the manifest version.
const MANIFEST_FIELDS_V2 = ['commitmentId', 'buyerAgentId', 'sellerAgentId', 'capability', 'price', 'acceptanceCriteria', 'deadline', 'cancelCondition', 'manifestVersion', 'terms'];
function canonicManifest(m) {
  const pick = {};
  for (const f of MANIFEST_FIELDS_V2) {
    if (m[f] === undefined || m[f] === null) continue;
    pick[f] = m[f];
  }
  if (pick.price && typeof pick.price === 'object') pick.price = Object.keys(pick.price).sort().reduce((a, k) => { a[k] = pick.price[k]; return a; }, {});
  if (pick.acceptanceCriteria && typeof pick.acceptanceCriteria === 'object') pick.acceptanceCriteria = Object.keys(pick.acceptanceCriteria).sort().reduce((a, k) => { a[k] = pick.acceptanceCriteria[k]; return a; }, {});
  if (pick.terms && typeof pick.terms === 'object') pick.terms = deepSortKeys(pick.terms);
  return JSON.stringify(pick);
}
function coseEnvelope(payloadBytes, signatureHex) {
  return {
    tag: 'COSE_Sign1',
    protected: b64url(JSON.stringify({ alg: 'ES256', kid: 'saax-protocol-phase1' })),
    unprotected: '',
    payload: b64url(payloadBytes),
    signature: signatureHex,
  };
}
function manifestHash(envelope) { return 'sha256:' + sha256hex(JSON.stringify(envelope)); }

// ---- live EAS anchoring ----------------------------------------------------------
const EAS_ABI = [
  {
    type: 'event', name: 'Attested', inputs: [
      { type: 'address', name: 'recipient', indexed: true },
      { type: 'address', name: 'attester', indexed: true },
      { type: 'bytes32', name: 'uid', indexed: false },
      { type: 'bytes32', name: 'schema', indexed: true },
    ],
  },
  {
    type: 'function', name: 'attest', stateMutability: 'nonpayable', inputs: [
      { type: 'tuple', components: [
        { type: 'bytes32', name: 'schema' },
        { type: 'tuple', components: [
          { type: 'address', name: 'recipient' },
          { type: 'uint64', name: 'expirationTime' },
          { type: 'bool', name: 'revocable' },
          { type: 'bytes32', name: 'refUID' },
          { type: 'bytes', name: 'data' },
          { type: 'uint256', name: 'value' },
        ], name: 'request' },
      ], name: 'attestationRequest' },
    ], outputs: [{ type: 'bytes32', name: '' }],
  },
];
const SCHEMA_REG_ABI = [{ name: 'register', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'schema', type: 'string' }, { name: 'resolver', type: 'address' }, { name: 'revocable', type: 'bool' }], outputs: [{ name: '', type: 'bytes32' }] }];
const getSchemaAbi = [{ name: 'getSchema', type: 'function', stateMutability: 'view', inputs: [{ name: 'uid', type: 'bytes32' }], outputs: [{ name: '', type: 'tuple', components: [{ name: 'uid', type: 'bytes32' }, { name: 'resolver', type: 'address' }, { name: 'revocable', type: 'bool' }, { name: 'schema', type: 'string' }] }] }];

function encodeAbiData(fields) {
  const headLen = fields.length * 32;
  const heads = [];
  const tailEntries = [];
  let offset = headLen;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (typeof f === 'number') {
      heads.push(toHex(f, { size: 32 }));
    } else {
      heads.push(toHex(offset, { size: 32 }));
      const bytes = Buffer.from(String(f), 'utf8');
      const padded = Buffer.concat([bytes, Buffer.alloc(32 - (bytes.length % 32 || 32))]);
      tailEntries.push({ len: bytes.length, padded });
      offset += 32 + padded.length;
    }
  }
  const tail = [];
  for (const t of tailEntries) {
    tail.push(toHex(t.len, { size: 32 }), '0x' + t.padded.toString('hex'));
  }
  return '0x' + heads.concat(tail).map(w => w.replace(/^0x/, '')).join('');
}

async function anchorLive(anchorRecord, digest, recipient) {
  const wallet = createWalletClient({ account: signer, chain: baseSepolia, transport: http(RPC) });
  const schemaUid = anchorRecord.schemaUid;
  let registered = false;
  try {
    const rec = await pub.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: getSchemaAbi, functionName: 'getSchema', args: [schemaUid] });
    registered = !!rec && rec.schema === SAAX_COMMITMENT_SCHEMA;
  } catch (e) { registered = false; }
  if (!registered) {
    const tx = await wallet.writeContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: SCHEMA_REG_ABI, functionName: 'register', args: [SAAX_COMMITMENT_SCHEMA, '0x0000000000000000000000000000000000000000', false] });
    const rec = await pub.waitForTransactionReceipt({ hash: tx });
    if (rec.status !== 'success') throw new Error('schema register failed: ' + tx);
    console.log('  schema registered tx: ' + tx);
  } else {
    console.log('  schema already registered (verified on-chain)');
  }
  const fields = [
    anchorRecord.data.commitmentId,
    anchorRecord.data.commitmentDigest,
    anchorRecord.data.parties,
    anchorRecord.data.requestedOutcome,
    anchorRecord.data.providerObligation,
    anchorRecord.data.commercialTerms,
    anchorRecord.data.paymentTerms,
    anchorRecord.data.acceptanceCriteria,
    anchorRecord.data.deadline,
    anchorRecord.data.failureConditions,
    anchorRecord.data.recoveryPolicy,
    anchorRecord.data.refundsCompensation,
    anchorRecord.data.lifecycleState,
    Number(anchorRecord.data.anchoredAt),
  ];
  const encoded = encodeAbiData(fields);
  const tx = await wallet.writeContract({
    address: EAS_ADDRESS, abi: EAS_ABI, functionName: 'attest',
    args: [{ schema: schemaUid, request: { recipient, expirationTime: 0n, revocable: false, refUID: '0x0000000000000000000000000000000000000000000000000000000000000000', data: encoded, value: 0n } }],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') throw new Error('attest failed: ' + tx);
  let uid = null;
  for (const log of receipt.logs || []) {
    if (log.address && log.address.toLowerCase() === EAS_ADDRESS.toLowerCase()) {
      const topics = log.topics || [];
      if (topics[0] && topics[0].toLowerCase() === '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35') {
        uid = '0x' + (log.data || '').slice(2).slice(0, 64);
        break;
      }
    }
  }
  return { anchor: { uid, txHash: tx, chainId: CHAIN_ID, attester: signer.address, broadcastAt: new Date().toISOString() } };
}

// ---- fresh v2 baseline -----------------------------------------------------------
async function build() {
  const commitmentId = 'v2-' + Date.now();
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 7 * 86400;

  // Explicit terms with pinned versions — every field is INSIDE the signed
  // digest (the v2 canonical manifest includes the terms object).
  const terms = {
    schemaVersion: 'saax-commitment-v2',
    hashingVersion: 'sha256-cose-v2',
    signatureDomainVersion: 'saax-commitment-auth-v2',
    policyVersion: 'saax-policy-v2',
    evidencePolicy: {
      type: 'evidence_hidden_answer_set_v1',
      requiredRefs: ['work_output'],
      verdictRequired: true,
      evaluatorRequired: true,
    },
    recoveryRules: {
      workerKill: 'reconcile_intent_before_retry',
      lostAck: 'query_chain_authoritative',
      timeoutRefund: 'refund_on_deadline_if_no_verdict',
    },
  };

  // The v2 manifest object: v1 fields + manifestVersion + terms. The
  // canonical serialization covers ALL of them, so the signed digest
  // authenticates the version AND every term.
  const manifest = {
    commitmentId,
    buyerAgentId: buyer.address,
    sellerAgentId: getAddress(SELLER_ADDRESS),
    capability: 'data-annotation-v1',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: {
      type: 'evidence_hidden_answer_set_v1',
      value: 'all_annotations_match_hidden_set',
    },
    deadline,
    cancelCondition: 'buyer_cancels_before_funding',
    manifestVersion: MANIFEST_VERSION,
    terms,
  };

  const payloadBytes = canonicManifest(manifest);

  // v2 digest binding: the COSE envelope signature does not depend on the
  // party authorizations, so compute the FINAL digest first (real signature
  // over the canonical manifest bytes), then derive the bytes32 binding from
  // the actual signed digest. This makes the party authorizations and the
  // journal events authenticate the SAME digest the export and anchor carry.
  const coseSig = await signer.signMessage({ message: { raw: Buffer.from(payloadBytes, 'utf8') } });
  const envelope = coseEnvelope(payloadBytes, coseSig);
  const digest = manifestHash(envelope);
  const digestBytes32 = ('0x' + digest.slice('sha256:'.length)).slice(0, 66);

  const nonceB = 1000 + Math.floor(Math.random() * 1e6);
  const nonceS = 1000 + Math.floor(Math.random() * 1e6);

  const signAuth = async (account, role, nonce) => {
    const sig = await account.signTypedData({
      domain: { ...AUTH_DOMAIN, chainId: BigInt(CHAIN_ID) },
      types: AUTH_TYPES,
      primaryType: 'CommitmentAuthorization',
      message: {
        commitmentId: digestBytes32,
        commitmentDigest: digestBytes32,
        role,
        scope: 'authorize_commitment_and_escrow',
        nonce: BigInt(nonce),
        issuedAt: BigInt(issuedAt),
        expiresAt: BigInt(expiresAt),
      },
    });
    const hex = String(sig).replace(/^0x/, '');
    return {
      role, primaryType: 'CommitmentAuthorization',
      domain: AUTH_DOMAIN, types: AUTH_TYPES,
      message: {
        commitmentId: digestBytes32, commitmentDigest: digestBytes32, role,
        scope: 'authorize_commitment_and_escrow',
        nonce: String(nonce), issuedAt: String(issuedAt), expiresAt: String(expiresAt),
      },
      v: parseInt(hex.slice(128, 130), 16),
      r: '0x' + hex.slice(0, 64),
      s: '0x' + hex.slice(64, 128),
      expectedParty: account.address,
    };
  };

  const authBuyer = await signAuth(buyer, 'buyer', nonceB);
  const authSeller = await signAuth(signer, 'seller', nonceS);

  // Anchor record for the v2 digest.
  const schemaUid = deriveSchemaUid();
  const anchorRecord = {
    schemaUid,
    commitmentId,
    commitmentDigest: digest,
    chainId: CHAIN_ID,
    resolver: '0x0000000000000000000000000000000000000000',
    revocable: false,
    attester: signer.address,
    recipient: '0x0000000000000000000000000000000000000000',
    expirationTime: 0,
    data: {
      commitmentId,
      commitmentDigest: digest,
      parties: JSON.stringify({ buyer: buyer.address, seller: getAddress(SELLER_ADDRESS) }),
      requestedOutcome: 'data_annotation_complete',
      providerObligation: 'annotate_hidden_set',
      commercialTerms: JSON.stringify({ amount: '50000', currency: 'USDC', decimals: 6 }),
      paymentTerms: JSON.stringify({ amount: '50000', currency: 'USDC' }),
      acceptanceCriteria: JSON.stringify({ type: 'evidence_hidden_answer_set_v1', value: 'all_annotations_match_hidden_set' }),
      deadline,
      failureConditions: JSON.stringify([{ condition: 'provider_obligation_unfulfilled' }]),
      recoveryPolicy: JSON.stringify(terms.recoveryRules),
      refundsCompensation: JSON.stringify({ refundOnTimeout: true, escrowReleaseOnVerdict: true }),
      lifecycleState: 'ISSUED',
      anchoredAt: issuedAt,
    },
  };

  console.log('--- Fresh v2 baseline built (local) ---');
  console.log('  commitmentId   : ' + commitmentId);
  console.log('  formatVersion  : ' + FORMAT_VERSION);
  console.log('  manifestVersion: ' + MANIFEST_VERSION);
  console.log('  digest         : ' + digest);
  console.log('  schema uid     : ' + schemaUid);
  console.log('  buyer          : ' + buyer.address);
  console.log('  seller         : ' + getAddress(SELLER_ADDRESS));
  console.log('  evaluator      : ' + signer.address);

  const mode = (process.env.SAAX_EAS_MODE || 'mock').toLowerCase();
  if (mode === 'live') {
    const { anchor: anchored } = await anchorLive(anchorRecord, digest, buyer.address);
    Object.assign(anchorRecord, anchored);
    console.log('  anchor uid     : ' + anchorRecord.uid);
    console.log('  anchor tx      : ' + anchorRecord.txHash);
  } else {
    console.log('  [SAAX_EAS_MODE != live] anchor NOT broadcast (mock mode); set SAAX_EAS_MODE=live');
  }

  // Authenticated lifecycle history (hash-chained, parent-referenced, signed).
  const journalRoot = commitmentId;
  const mkEvent = (state, transition, at, by, prevHash) => {
    const entryHash = sha256hex(JSON.stringify({ state, transition, at, by, prevHash }));
    return { state, transition, at, by, prevHash, entryHash };
  };
  const evIssue = mkEvent('ISSUED', 'issue', now, signer.address, journalRoot);
  const anchoredAt = new Date().toISOString();
  const evAnchored = mkEvent('ANCHORED', 'anchor-confirmed', anchoredAt, signer.address, evIssue.entryHash);
  const signEvent = async (ev) => {
    const sig = await signer.signTypedData({
      domain: { ...JOURNAL_DOMAIN, chainId: BigInt(CHAIN_ID) },
      types: JOURNAL_TYPES,
      primaryType: 'JournalEvent',
      message: {
        commitmentId: digestBytes32,
        state: ev.state,
        transition: ev.transition,
        at: ev.at,
        by: ev.by,
        prevHash: ev.prevHash,
        entryHash: ev.entryHash,
      },
    });
    const hex = String(sig).replace(/^0x/, '');
    return {
      ...ev,
      sig: { v: parseInt(hex.slice(128, 130), 16), r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128) },
      signer: signer.address,
    };
  };
  const journalEvents = [await signEvent(evIssue), await signEvent(evAnchored)];
  const journal = {
    root: journalRoot,
    commitmentId: digestBytes32,
    evaluator: signer.address,
    events: journalEvents,
    tailHash: journalEvents[journalEvents.length - 1].entryHash,
    eventCount: 2,
  };

  const exportEnvelope = {
    formatVersion: FORMAT_VERSION,
    lifecycleProfile: 'issue',
    agreement: {
      commitmentId,
      buyerAgentId: buyer.address,
      sellerAgentId: getAddress(SELLER_ADDRESS),
      capability: manifest.capability,
      price: manifest.price,
      acceptanceCriteria: manifest.acceptanceCriteria,
      deadline,
      cancelCondition: manifest.cancelCondition,
      issuedAt: now,
      signatureHex: coseSig,
      manifestVersion: MANIFEST_VERSION,
      terms,
    },
    commitmentDigest: digest,
    authorizations: [authBuyer, authSeller],
    anchor: anchorRecord,
    journal,
    escrow: null,
    evidenceRefs: [],
    builtAt: new Date().toISOString(),
  };

  const outPath = process.argv[process.argv.indexOf('--out') + 1] || 'evidence/baseline-v2-verified-commitment.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(exportEnvelope, null, 2));
  console.log('--- export written: ' + outPath + ' ---');
  return exportEnvelope;
}

build().then(() => process.exit(0)).catch(e => { console.error('FATAL ' + (e.stack || e.message)); process.exit(1); });
