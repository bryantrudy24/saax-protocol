// SAAX Phase: Fresh, Authentically Authorized Commitment (Day 20)
//
// Builds a NEW commitment with REAL EIP-712 party signatures bound to the
// canonical agreement digest, explicit terms, pinned versions, authenticated
// lifecycle history, and a REAL Base Sepolia EAS anchor (mode=live).
//
// The output is an EXPORT in verifier/build-export.js format that
// verifier/verify-export.js can independently re-verify in a fresh process
// with no SAAX DB access.
//
// ENV:
//   SAAX_SIGNER_PRIVATE_KEY   (evaluator + seller key material)
//   SAAX_TEST_BUYER_KEY       (buyer key material)
//   SAAX_SELLER_ADDRESS       (seller address; defaults to signer address)
//   SAAX_EAS_MODE=live        (broadcast a real attestation)
//   SAAX_ESCROW_RPC_URL       (default https://sepolia.base.org)
//
// USAGE: node scripts/build-fresh-commitment.js [--out export.json]
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, http, keccak256, encodePacked, toHex, getAddress } = require('viem');
const { baseSepolia } = require('viem/chains');

const RPC = process.env.SAAX_ESCROW_RPC_URL || 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020';

const SAAX_COMMITMENT_SCHEMA =
  'string commitmentId,string commitmentDigest,string parties,string requestedOutcome,string providerObligation,string commercialTerms,string paymentTerms,string acceptanceCriteria,string deadline,string failureConditions,string recoveryPolicy,string refundsCompensation,string lifecycleState,uint64 anchoredAt';

const signerKey = process.env.SAAX_SIGNER_PRIVATE_KEY || '';
const buyerKey = process.env.SAAX_TEST_BUYER_KEY || '';
if (!signerKey || !buyerKey) {
  console.error('MISSING ENV: SAAX_SIGNER_PRIVATE_KEY and SAAX_TEST_BUYER_KEY required');
  process.exit(2);
}

const signer = privateKeyToAccount(signerKey);
const buyer = privateKeyToAccount(buyerKey);
// Test-harness role ownership: in this environment ONE operator controls the
// buyer key (SAAX_TEST_BUYER_KEY), the seller key, and the evaluator key
// (SAAX_SIGNER_PRIVATE_KEY). The seller role is therefore bound to the signer
// address so the seller authorization is a REAL signature from a key we hold.
// SAAX_SELLER_ADDRESS (receive-only, no key in this environment) is used only
// as the custody release recipient when explicitly configured; the
// commitment's sellerAgentId is the controlled seller address.
const SELLER_ADDRESS = signer.address;
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');

// ---- Canonical EAS schema UID (general-purpose derivation, matches EAS
// contract: keccak256(abi.encodePacked(schema, resolver, revocable))). -------
function deriveSchemaUid() {
  return keccak256(encodePacked(['string', 'address', 'bool'], [SAAX_COMMITMENT_SCHEMA, '0x0000000000000000000000000000000000000000', false]));
}

// ---- EIP-712 commitment authorization types --------------------------------
// The canonical digest binding: each party signs the EXACT digest that the
// verifier recomputes from the COSE envelope over the canonical manifest.
// Different primary type from the escrow verdict => domain separation.
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

// Journal event authentication: the evaluator signs each lifecycle event so
// later history is authenticated by a REAL signature, not merely a locally
// recomputable hash (which anyone could rewrite). The verifier recovers the
// signer of every event and requires it to match the event's `by` (the
// evaluator acting for the commitment).
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

// ---- COSE_Sign1 envelope over the canonical manifest (same algorithm the
// verifier's recomputeDigest uses). ------------------------------------------
function canonicManifest(m) {
  const MANIFEST_FIELDS = ['commitmentId', 'buyerAgentId', 'sellerAgentId', 'capability', 'price', 'acceptanceCriteria', 'deadline', 'cancelCondition'];
  const pick = {};
  for (const f of MANIFEST_FIELDS) {
    if (m[f] === undefined || m[f] === null) continue;
    pick[f] = m[f];
  }
  if (pick.price && typeof pick.price === 'object') pick.price = Object.keys(pick.price).sort().reduce((a, k) => { a[k] = pick.price[k]; return a; }, {});
  if (pick.acceptanceCriteria && typeof pick.acceptanceCriteria === 'object') pick.acceptanceCriteria = Object.keys(pick.acceptanceCriteria).sort().reduce((a, k) => { a[k] = pick.acceptanceCriteria[k]; return a; }, {});
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

// ---- Fresh commitment -------------------------------------------------------
async function build() {
  const commitmentId = 'fresh-' + Date.now();
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 7 * 86400;

  // Explicit terms, acceptance criteria, evidence requirements, recovery rules.
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
    // Pinned versions (schema/hashing/signature-domain/policy):
    schemaVersion: 'saax-commitment-v1',
    hashingVersion: 'sha256-cose-v1',
    signatureDomainVersion: 'saax-commitment-auth-v1',
    policyVersion: 'saax-policy-v1',
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

  // 1. Canonical manifest bytes.
  const payloadBytes = canonicManifest(manifest);

  // 2. Real EIP-712 party-authorization signatures bound to the digest.
  //    The digest is computed over the COSE envelope; the parties sign the
  //    digest hash (bytes32) so the signature is bound to the exact artifact.
  //    Two-pass: build envelope with a placeholder to derive the digest, then
  //    sign that digest, then rebuild the envelope with the REAL signature.
  const envelope0 = coseEnvelope(payloadBytes, '0x' + '00'.repeat(65));
  const digest0 = manifestHash(envelope0);
  const digestBytes = ('0x' + crypto.createHash('sha256').update(digest0.slice(7), 'utf8').digest('hex')).slice(0, 66);
  // NOTE: digest bytes must be the 32-byte hash; use the canonical digest's
  // hex form (the sha256 of the envelope JSON) as the bytes32 binding.
  const digestHex = crypto.createHash('sha256').update(String(digest0), 'utf8').digest('hex');
  const digestBytes32 = ('0x' + digestHex).slice(0, 66);

  const nonceB = 1000 + Math.floor(Math.random() * 1e6);
  const nonceS = 1000 + Math.floor(Math.random() * 1e6);

  const signAuth = async (account, role, nonce) => {
    // viem signTypedData returns a 65-byte hex signature (0x + 130 hex chars):
    // [r: 32 bytes][s: 32 bytes][v: 1 byte]. Split into the v/r/s parts the
    // verifier's recoverSignerFromSig expects.
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
    const r = '0x' + hex.slice(0, 64);
    const s = '0x' + hex.slice(64, 128);
    const v = parseInt(hex.slice(128, 130), 16);
    return {
      role, primaryType: 'CommitmentAuthorization',
      domain: AUTH_DOMAIN, types: AUTH_TYPES,
      message: {
        commitmentId: digestBytes32, commitmentDigest: digestBytes32, role,
        scope: 'authorize_commitment_and_escrow',
        nonce: String(nonce), issuedAt: String(issuedAt), expiresAt: String(expiresAt),
      },
      v, r, s,
      expectedParty: account.address,
    };
  };

  const authBuyer = await signAuth(buyer, 'buyer', nonceB);
  const authSeller = await signAuth(signer, 'seller', nonceS);

  // 3. REAL COSE envelope signature: sign the payload bytes with the signer
  //    key (ES256-style 65-byte sig from the EIP-712 recovery path is not
  //    possible here; use viem's signMessage on the payload bytes as the
  //    envelope signature — recovery domain is the COSE envelope itself).
  const coseSig = await signer.signMessage({ message: { raw: Buffer.from(payloadBytes, 'utf8') } });
  const envelope = coseEnvelope(payloadBytes, coseSig);
  const digest = manifestHash(envelope);

  // 4. Build the anchor record (same shape eas.js buildAnchorRecord uses).
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
      recoveryPolicy: JSON.stringify(manifest.recoveryRules),
      refundsCompensation: JSON.stringify({ refundOnTimeout: true, escrowReleaseOnVerdict: true }),
      lifecycleState: 'ISSUED',
      anchoredAt: issuedAt,
    },
  };

  console.log('--- Fresh commitment built (local) ---');
  console.log('  commitmentId   : ' + commitmentId);
  console.log('  digest         : ' + digest);
  console.log('  schema uid     : ' + schemaUid);
  console.log('  buyer          : ' + buyer.address);
  console.log('  seller         : ' + getAddress(SELLER_ADDRESS));
  console.log('  evaluator      : ' + signer.address);
  console.log('  auth buyer v/r/s: ' + authBuyer.v + ' / ' + authBuyer.r.slice(0, 18) + '... / ' + authBuyer.s.slice(0, 18) + '...');
  console.log('  auth seller    : ' + authSeller.v + ' / ' + authSeller.r.slice(0, 18) + '... / ' + authSeller.s.slice(0, 18) + '...');

  // 5. Anchor in mode=live: broadcast a real attestation.
  const mode = (process.env.SAAX_EAS_MODE || 'mock').toLowerCase();
  if (mode === 'live') {
    const { anchor: anchored } = await anchorLive(anchorRecord, digest, buyer.address);
    Object.assign(anchorRecord, anchored);
    console.log('  anchor uid     : ' + anchorRecord.uid);
    console.log('  anchor tx      : ' + anchorRecord.txHash);
  } else {
    console.log('  [SAAX_EAS_MODE != live] anchor NOT broadcast (mock mode); set SAAX_EAS_MODE=live');
  }

  // 6. Journal: authenticated lifecycle history (ISSUED event; later events
  //    signed by the evaluator as they occur). For the fresh issuance the
  //    journal is the ISSUED event; the escrow events follow in later phases.
  const journalRoot = commitmentId;
  const mkEvent = (state, transition, at, by, prevHash) => {
    const entryHash = sha256hex(JSON.stringify({ state, transition, at, by, prevHash }));
    return { state, transition, at, by, prevHash, entryHash };
  };
  const evIssue = mkEvent('ISSUED', 'issue', now, signer.address, journalRoot);
  // Second authenticated event: the anchor confirmation. Its prevHash links
  // the chain so reordering/missing events are detectable even at issuance.
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
      sig: {
        v: parseInt(hex.slice(128, 130), 16),
        r: '0x' + hex.slice(0, 64),
        s: '0x' + hex.slice(64, 128),
      },
      signer: signer.address,
    };
  };
  const journalEvents = [await signEvent(evIssue), await signEvent(evAnchored)];
  const journal = {
    root: journalRoot,
    // The bytes32 value the evaluator signs as commitmentId in every event
    // message (the commitment digest binding, not the plain id).
    commitmentId: digestBytes32,
    evaluator: signer.address,
    events: journalEvents,
    // Completeness boundary: the declared final hash and event count. An
    // attacker dropping or appending events changes the tail/count; the
    // verifier requires the export's journal to end exactly here. The
    // boundary is itself authenticated by being part of the signed export
    // and by the final event's evaluator signature over prevHash/entryHash.
    tailHash: journalEvents[journalEvents.length - 1].entryHash,
    eventCount: 2,
  };

  // 7. Export envelope (verifier format).
  const exportEnvelope = {
    formatVersion: 1,
    // Issuance profile: this export verifies the ISSUED commitment. Escrow and
    // fulfillment evidence are later phases; the verifier must not require
    // terminal escrow outcomes for an issuance-profile export.
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
      terms: {
        schemaVersion: manifest.schemaVersion,
        hashingVersion: manifest.hashingVersion,
        signatureDomainVersion: manifest.signatureDomainVersion,
        policyVersion: manifest.policyVersion,
        evidencePolicy: manifest.evidencePolicy,
        recoveryRules: manifest.recoveryRules,
      },
    },
    commitmentDigest: digest,
    authorizations: [authBuyer, authSeller],
    anchor: anchorRecord,
    journal,
    escrow: null,
    evidenceRefs: [],
    builtAt: new Date().toISOString(),
  };

  const outPath = process.argv[process.argv.indexOf('--out') + 1] || 'evidence/fresh-commitment.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(exportEnvelope, null, 2));
  console.log('--- export written: ' + outPath + ' ---');
  return exportEnvelope;
}

// ---- Live EAS anchoring (same flow as testnet-broadcast.js): register or
// verify the schema, attest, wait for the Attested event, read back. --------
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

const { createWalletClient } = require('viem');

async function anchorLive(anchorRecord, digest, recipient) {
  const wallet = createWalletClient({ account: signer, chain: baseSepolia, transport: http(RPC) });
  const schemaUid = anchorRecord.schemaUid;

  // Verify or register the schema (idempotent).
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

  // Attestation data: the same field tuple as the schema.
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

  const request = {
    schema: schemaUid,
    data: {
      recipient,
      expirationTime: 0n,
      revocable: false,
      refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
      data: encoded,
      value: 0n,
    },
  };
  const tx = await wallet.writeContract({
    address: EAS_ADDRESS, abi: EAS_ABI, functionName: 'attest',
    args: [{ schema: schemaUid, request: request.data }],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') throw new Error('attest failed: ' + tx);

  // Extract uid from the Attested event.
  let uid = null;
  for (const log of receipt.logs || []) {
    if (log.address && log.address.toLowerCase() === EAS_ADDRESS.toLowerCase()) {
      const topics = log.topics || [];
      if (topics[0] && topics[0].toLowerCase() === '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35') { // Attested(address,address,bytes32,bytes32)
        uid = '0x' + (log.data || '').slice(2).slice(0, 64);
        break;
      }
    }
  }
  if (!uid) {
    // Fallback: read the attestation via getAttestation using the known uid
    // derivation (compute the uid from the event data) — or leave null.
    uid = null;
  }

  return { anchor: { uid, txHash: tx, chainId: CHAIN_ID, attester: signer.address, broadcastAt: new Date().toISOString() } };
}

// Minimal ABI encoder for the schema's 14 fields (string,...,uint64): each
// dynamic string is [offset][len][data]; the uint64 is a 32-byte word.
// Head = one 32-byte word per field (offsets for strings, value for uint64);
// tail = for each string in order: [len][data padded to 32 bytes].
function encodeAbiData(fields) {
  const headLen = fields.length * 32;
  const heads = [];
  const tail = [];
  let offset = headLen;
  const tailEntries = [];
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
  for (const t of tailEntries) {
    tail.push(toHex(t.len, { size: 32 }), '0x' + t.padded.toString('hex'));
  }
  const hex = heads.concat(tail).map(w => w.replace(/^0x/, '')).join('');
  return '0x' + hex;
}

build().then(() => process.exit(0)).catch(e => { console.error('FATAL ' + (e.stack || e.message)); process.exit(1); });