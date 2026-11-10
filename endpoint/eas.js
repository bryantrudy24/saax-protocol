// SAAX Protocol — EAS Commitment Anchoring (viem, Base mainnet)
//
// Binds the versioned commitment digest to a confirmed on-chain Ethereum
// Attestation Service (EAS) attestation on Base, so the exact agreed terms
// are tamper-evident and independently verifiable WITHOUT trusting SAAX's
// reported database status.
//
// Flow (capability 1 of the connected build):
//   agreement terms -> canonical commitmentDigest (commitment.js)
//   -> EAS schema UID (deterministic, keccak256 of the schema string)
//   -> EAS attestation { schema, recipient, data = digest } written on Base
//   -> attestation UID (deterministic, keip.chain nonceless derivation)
//   -> receipt carries the UID; verifyAnchor() reads the chain independently
//
// The chain write is MOCK-SAFE by default (same posture as broadcast.js):
//   SAAX_EAS_MODE=mock  -> derive UID + return the anchor record WITHOUT any
//                          network write (disposable/testnet-safe). [default]
//   SAAX_EAS_MODE=live  -> broadcast the EAS `attest` tx on Base, pay gas from
//                          SAAX_SIGNER_PRIVATE_KEY, wait `confirmations`.
//
// verifyAnchor() is READ-ONLY (getAttestation) and always safe to call:
// it never signs, never pays gas, never writes.
//
// NO new dependency: uses viem (already a dependency) with the minimal EAS
// ABI. The EAS contract on Base is the canonical deployer proxy at
// 0x4200000000000000000000000000000000000021 (EAS) and ...20 (SchemaRegistry),
// which is the standard address on every EVM chain (attest.org/docs).
'use strict';

const { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, decodeAbiParameters, parseAbiParameters, getAddress, toHex, pad, encodePacked, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base, baseSepolia } = require('viem/chains');

// ---- Canonical EAS addresses on Base (standard deployer proxies). --------------
const EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020';
// Active chain selection — CHAIN_ID follows the active chain configuration
// (SAAX_CHAIN_ID), matching gateway.js. Default is Base Sepolia 84532; mainnet
// EAS (8453) is selected explicitly with SAAX_CHAIN_ID=8453 + its own RPC.
// SAAX_NETWORK (local | base-sepolia) makes the chain intent explicit: the
// local EVM uses a DISTINCT chain ID (31337) and is never described as 84532.
const ACTIVE_CHAIN_ID = Number(process.env.SAAX_CHAIN_ID || 84532);
const ACTIVE_NETWORK = String(
  process.env.SAAX_NETWORK || (ACTIVE_CHAIN_ID === 8453 ? 'base' : 'base-sepolia')
).trim().toLowerCase();
const CHAIN_ID = ACTIVE_CHAIN_ID; // legacy exported name; now resolved from active config
const RPC_DEFAULT = ACTIVE_CHAIN_ID === 8453 ? 'https://mainnet.base.org' : 'https://sepolia.base.org';

// ---- SAAX commitment EAS schema (canonical string) ------------------------------
// The schema string is the frozen, versioned definition of what a SAAX
// commitment anchor carries. The schema UID is keccak256 of this exact string.
// Versioning: the string embeds a version tag (saax-commitment-v1); changing
// the schema changes the UID, so old anchors remain independently resolvable.
const SAAX_COMMITMENT_SCHEMA = 'string commitmentId,string commitmentDigest,string parties,string requestedOutcome,string providerObligation,string commercialTerms,string paymentTerms,string acceptanceCriteria,string deadline,string failureConditions,string recoveryPolicy,string refundsCompensation,string lifecycleState,uint64 anchoredAt';

// Minimal ABIs (the two calls we need; viem infers from these).
const EAS_ABI = [
  {
    type: 'event',
    name: 'Attested',
    inputs: [
      { type: 'address', name: 'recipient', indexed: true },
      { type: 'address', name: 'attester', indexed: true },
      { type: 'bytes32', name: 'uid', indexed: false },
      { type: 'bytes32', name: 'schema', indexed: true },
    ],
  },
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        components: [
          { type: 'bytes32', name: 'schema' },
          { type: 'tuple', components: [
            { type: 'address', name: 'recipient' },
            { type: 'uint64', name: 'expirationTime' },
            { type: 'bool', name: 'revocable' },
            { type: 'bytes32', name: 'refUID' },
            { type: 'bytes', name: 'data' },
            { type: 'uint256', name: 'value' },
          ], name: 'data' },
        ],
        name: 'request',
      },
    ],
    outputs: [{ type: 'bytes32', name: '' }],
  },
  {
    type: 'function',
    name: 'getAttestation',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32', name: 'uid' }],
    outputs: [
      { type: 'bytes32', name: 'uid' },
      { type: 'bytes32', name: 'schema' },
      { type: 'uint64', name: 'time' },
      { type: 'uint64', name: 'expirationTime' },
      { type: 'bool', name: 'revocable' },
      { type: 'bytes32', name: 'refUID' },
      { type: 'address', name: 'recipient' },
      { type: 'bytes', name: 'data' },
    ],
  },
];

const SCHEMA_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getSchema',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32', name: 'uid' }],
    outputs: [{ type: 'tuple', components: [
      { type: 'bytes32', name: 'uid' },
      { type: 'bytes', name: 'schema' },
      { type: 'address', name: 'resolver' },
      { type: 'bool', name: 'revocable' },
    ], name: '' }],
  },
];

// ---- Mode / config helpers -------------------------------------------------------
function getEasMode() {
  return (process.env.SAAX_EAS_MODE || 'mock').toString().trim().toLowerCase();
}
function getRpcUrl() {
  return (process.env.SAAX_RPC_URL || RPC_DEFAULT).trim();
}
function getSignerKey() {
  return (process.env.SAAX_SIGNER_PRIVATE_KEY || '').trim();
}

// ---- Schema UID (deterministic) ---------------------------------------------------
// EAS schema UID = keccak256(abi.encodePacked(schemaString, resolver, revocable)).
// Verified against the on-chain SchemaRegistry: register(schema, 0x0, false) yields
// keccak256(encodePacked(['string','address','bool'], [schema, zero, false])).
// (All-zero resolver + revocable=false are the SAAX schema's fixed registration.)
function deriveSchemaUid() {
  return keccak256(
    encodePacked(['string', 'address', 'bool'], [SAAX_COMMITMENT_SCHEMA, '0x0000000000000000000000000000000000000000', false])
  );
}

// ---- Attestation payload construction ----------------------------------------------
// The attestation data is the canonical ABI encoding of the anchor fields.
// The FIRST data field is the commitmentDigest — the field verifyAnchor reads.
function encodeAttestationData(commitment) {
  const c = commitment || {};
  return encodeAbiParameters(
    parseAbiParameters(
      'string,string,string,string,string,string,string,string,string,string,string,string,string,uint64'
    ),
    [
      String(c.commitmentId || ''),
      String(c.commitmentDigest || ''),
      String(c.parties || ''),
      String(c.requestedOutcome || ''),
      String(c.providerObligation || ''),
      String(c.commercialTerms || ''),
      String(c.paymentTerms || ''),
      String(c.acceptanceCriteria || ''),
      String(c.deadline || ''),
      String(c.failureConditions || ''),
      String(c.recoveryPolicy || ''),
      String(c.refundsCompensation || ''),
      String(c.lifecycleState || 'issued'),
      BigInt(c.anchoredAt || Math.floor(Date.now() / 1000)),
    ]
  );
}

// Deterministic attestation UID (per EAS: keccak256 of the schema + recipient +
// time + expiration + revocable + refUID + data). We compute the SAME derivation
// the EAS contract uses so the receipt can carry a stable, checkable UID even in
// mock mode (no chain write). In live mode the on-chain uid is authoritative;
// this derivation is used for the receipt field and the verifyAnchor lookup key.
function attestationUid({ schema, recipient, time, expirationTime, revocable, refUID, data }) {
  const recipientPadded = pad(getAddress(recipient || '0x0000000000000000000000000000000000000000'), { size: 32 });
  const timePadded = pad(toHex(BigInt(time || 0)), { size: 32 });
  const expPadded = pad(toHex(BigInt(expirationTime || 0)), { size: 32 });
  const revocableWord = revocable ? toHex(1, { size: 32 }) : toHex(0, { size: 32 });
  const refPadded = pad(refUID || '0x0000000000000000000000000000000000000000000000000000000000000000', { size: 32 });
  // EAS _getUID: keccak256(abi.encode(schema, recipient, time, expirationTime,
  // revocable, refUID, data)) — exactly 7 ABI words, no duplicate time field.
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32,address,uint64,uint64,bool,bytes32,bytes'),
      [pad(schema, { size: 32 }), recipient, BigInt(time || 0), BigInt(expirationTime || 0), !!revocable, refPadded, data]
    )
  );
}

// ---- Public: build the anchor record (mock-safe, no network) ----------------------
// SYNCHRONOUS deterministic builder used by the commitment flow (mock mode).
// Returns the anchor record or throws. Never touches the network; the live
// broadcast path is async (attestCommitment) and only used in live mode.
function buildAnchorRecord(commitment, opts = {}) {
  const mode = getEasMode();
  const rpcUrl = opts.rpcUrl || getRpcUrl();
  const now = Math.floor(Date.now() / 1000);

  const c = commitment || {};
  // The SAAX manifest digest is canonicalized as "sha256:<64hex>" (the COSE
  // binding). The EAS anchor binds the BARE digest (the on-chain-representable
  // form) — the "sha256:" prefix is a string tag, not part of the hash. Accept
  // either form and normalize to canonical 0x + 64 hex.
  let digestRaw = String(c.commitmentDigest || '').trim();
  if (digestRaw.startsWith('sha256:')) digestRaw = digestRaw.slice('sha256:'.length);
  if (!/^[a-fA-F0-9]{64}$/.test(digestRaw) && !/^0x[a-fA-F0-9]{64}$/.test(digestRaw)) {
    throw new Error('commitmentDigest must be sha256:<64hex> or 0x + 64 hex');
  }
  const commitmentDigestNormalized = (digestRaw.startsWith('0x') ? digestRaw : '0x' + digestRaw).toLowerCase();
  if (!c.commitmentId) throw new Error('commitmentId is required');

  const schemaUid = deriveSchemaUid();
  const recipient = (opts.recipient || (process.env.SAAX_EAS_RECIPIENT || '').trim() || '0x0000000000000000000000000000000000000000');
  try {
    getAddress(recipient);
  } catch (e) {
    throw new Error('invalid recipient: ' + String(e.message || e).slice(0, 120));
  }

  const data = encodeAttestationData({
    ...c,
    commitmentDigest: commitmentDigestNormalized,
    anchoredAt: now,
    parties: JSON.stringify(c.parties || {}),
    requestedOutcome: JSON.stringify(c.requestedOutcome || {}),
    providerObligation: JSON.stringify(c.providerObligation || {}),
    commercialTerms: JSON.stringify(c.commercialTerms || {}),
    paymentTerms: JSON.stringify(c.paymentTerms || {}),
    acceptanceCriteria: JSON.stringify(c.acceptanceCriteria || []),
    failureConditions: JSON.stringify(c.failureConditions || []),
    recoveryPolicy: JSON.stringify(c.recoveryPolicy || {}),
    refundsCompensation: JSON.stringify(c.refundsCompensation || {}),
  });

  const anchor = {
    schemaUid,
    uid: '0x0000000000000000000000000000000000000000000000000000000000000000', // filled below
    commitmentDigest: commitmentDigestNormalized,
    commitmentId: String(c.commitmentId),
    chainId: CHAIN_ID,
    rpc: rpcUrl,
    mode,
    time: now,
    attestationData: data,
  };

  if (mode !== 'live') {
    // Mock/disposable path: deterministic UID derived exactly as the EAS
    // contract would, NO network write, NO gas, NO broadcast.
    anchor.uid = attestationUid({
      schema: schemaUid, recipient, time: now, expirationTime: 0, revocable: false,
      refUID: '0x0000000000000000000000000000000000000000000000000000000000000000', data,
    });
    return anchor;
  }

  // Live mode: the caller must use the async attestCommitment (broadcast).
  // buildAnchorRecord returns the pre-broadcast record carrying the txHash
  // placeholder; attestCommitment replaces it with the on-chain Attested uid.
  anchor.pendingLive = true;
  return anchor;
}

// ---- Public: async attest (mock-safe by default) --------------------------------
// Returns { ok, anchor } where anchor = { schemaUid, uid, commitmentDigest,
// commitmentId, chainId, rpc, mode, time, attestationData }. In mock mode this is
// fully deterministic and disposable (no gas, no broadcast). In live mode it
// validates the signer key exists and returns the record AFTER the tx lands.
async function attestCommitment(commitment, opts = {}) {
  const mode = getEasMode();
  const rpcUrl = opts.rpcUrl || getRpcUrl();
  const now = Math.floor(Date.now() / 1000);

  const c = commitment || {};
  if (mode !== 'live') {
    try {
      const anchor = buildAnchorRecord(commitment, opts);
      return { ok: true, anchor, mock: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e).slice(0, 200) };
    }
  }

  // Live path: broadcast the EAS attest transaction on Base.
  let anchor;
  try {
    anchor = buildAnchorRecord(commitment, opts); // pre-broadcast record (schemaUid, data, recipient)
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
  const schemaUid = anchor.schemaUid;
  const recipient = (opts.recipient || (process.env.SAAX_EAS_RECIPIENT || '').trim() || '0x0000000000000000000000000000000000000000');
  const data = anchor.attestationData;
  const key = getSignerKey();
  if (!key) return { ok: false, error: 'SAAX_EAS_MODE=live but SAAX_SIGNER_PRIVATE_KEY is not set' };
  let account;
  try {
    account = privateKeyToAccount(key);
  } catch (e) {
    return { ok: false, error: 'invalid SAAX_SIGNER_PRIVATE_KEY: ' + String(e.message || e).slice(0, 120) };
  }

  try {
    const client = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const txHash = await client.writeContract({
      address: EAS_ADDRESS,
      abi: EAS_ABI,
      functionName: 'attest',
      args: [{
        schema: schemaUid,
        data: { recipient, expirationTime: 0n, revocable: false, refUID: '0x0000000000000000000000000000000000000000000000000000000000000000', data, value: 0n },
      }],
    });
    // Wait for the receipt and extract the authoritative uid from the Attested
    // event log (the on-chain uid is derived with the block timestamp, which we
    // cannot know in advance; never guess it from `now`).
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    let emittedUid = null;
    for (const log of receipt.logs || []) {
      if (String(log.address).toLowerCase() !== EAS_ADDRESS.toLowerCase()) continue;
      if (log.topics && log.topics.length >= 4) {
        // Attested(recipient indexed, attester indexed, uid non-indexed, schema indexed)
        // topics = [sig, recipient, attester, schema]; uid is the data field.
        if (log.data && log.data.length >= 66) emittedUid = log.data.slice(0, 66);
      }
    }
    if (!emittedUid) return { ok: false, error: 'EAS attest tx landed but Attested event uid not found in receipt logs (tx ' + txHash + ')' };
    anchor.uid = emittedUid.toLowerCase();
    anchor.txHash = txHash;
    anchor.blockNumber = receipt.blockNumber ? String(receipt.blockNumber) : undefined;
    anchor.broadcastAt = new Date().toISOString();
    return { ok: true, anchor, mock: false };
  } catch (e) {
    return { ok: false, error: 'EAS attest failed: ' + String(e.message || e).slice(0, 200) };
  }
}

// ---- Public: independently verify an anchor (READ-ONLY, always safe) ---------------
// Reads the EAS contract's getAttestation(uid) on Base and checks:
//   1. the attestation exists (revoked=false, schema matches our schema UID)
//   2. the first data field (commitmentDigest) equals the claimed digest
// Returns { ok, verified, reason, attestation }.
async function verifyAnchor({ uid, commitmentDigest, commitmentId, rpcUrl } = {}) {
  const rpc = rpcUrl || getRpcUrl();
  if (!uid || !/^0x[a-fA-F0-9]{64}$/.test(String(uid))) return { ok: false, verified: false, reason: 'uid must be 0x + 64 hex' };

  try {
    // Use the OFFICIAL EAS SDK to read + decode the attestation. The raw
    // getAttestation response on the Base EAS proxy uses a nested tuple that
    // viem/ethers flat-ABI decoders misread; the SDK handles it correctly.
    const { EAS } = require('@ethereum-attestation-service/eas-sdk');
    const easClient = new EAS(EAS_ADDRESS);
    easClient.connect({ provider: new (require('ethers').JsonRpcProvider)(rpc, ACTIVE_CHAIN_ID) });
    const att = await easClient.getAttestation(uid);
    const attUid = String(att.uid || '');
    const schema = String(att.schema || '');
    const time = att.time ? att.time.toString() : '';
    const expirationTime = att.expirationTime ? att.expirationTime.toString() : '';
    const revocable = !!att.revocable;
    const refUID = String(att.refUID || '');
    const recipient = String(att.recipient || '');
    const data = att.data || '0x';
    // Decode the data field: 13 strings + uint64 (anchoredAt).
    let onChainId = '';
    let onChainDigest = '';
    if (data && data.length > 2) {
      const decoded = new (require('ethers').AbiCoder)().decode(
        ['string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'uint64'],
        data
      );
      onChainId = String(decoded[0] || '');
      onChainDigest = String(decoded[1] || '').toLowerCase();
    }

    if (!attUid || attUid === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      return { ok: false, verified: false, reason: 'attestation not found on chain' };
    }
    const expectedSchema = deriveSchemaUid();
    if (String(schema).toLowerCase() !== expectedSchema.toLowerCase()) {
      return { ok: false, verified: false, reason: 'schema mismatch: on-chain ' + schema + ' != expected ' + expectedSchema };
    }
    if (revocable) {
      return { ok: false, verified: false, reason: 'attestation is revocable (anchor must be immutable)' };
    }

    let digestOk = false;
    if (commitmentDigest) {
      // Normalize the claimed digest the same way buildAnchorRecord does
      // (accept "sha256:<64hex>" or "0x<64hex>"; compare bare hex).
      let claimed = String(commitmentDigest).trim();
      if (claimed.startsWith('sha256:')) claimed = claimed.slice('sha256:'.length);
      claimed = (claimed.startsWith('0x') ? claimed : '0x' + claimed).toLowerCase();
      digestOk = onChainDigest === claimed;
      if (!digestOk) return { ok: false, verified: false, reason: 'commitmentDigest mismatch: on-chain ' + onChainDigest + ' != claimed ' + claimed };
    } else {
      digestOk = /^0x[a-fA-F0-9]{64}$/.test(onChainDigest);
    }
    if (!digestOk) return { ok: false, verified: false, reason: 'commitmentDigest missing/invalid on chain' };

    // If a commitmentId was claimed, verify it too (first data field).
    if (commitmentId) {
      if (onChainId !== String(commitmentId).toLowerCase()) {
        return { ok: false, verified: false, reason: 'commitmentId mismatch: on-chain ' + onChainId + ' != claimed ' + String(commitmentId).toLowerCase() };
      }
    }

    return {
      ok: true, verified: true, reason: null,
      attestation: {
        uid: String(attUid), schema: String(schema), time: String(time),
        expirationTime: String(expirationTime), revocable: !!revocable,
        refUID: String(refUID), recipient: String(recipient),
        commitmentDigest: onChainDigest, commitmentId: onChainId,
      },
    };
  } catch (e) {
    return { ok: false, verified: false, reason: 'EAS read failed: ' + String(e.message || e).slice(0, 200) };
  }
}

// ---- Public: schema registry lookup (read-only, for verification docs) -------------
async function getSchemaRecord(uid, rpcUrl) {
  const rpc = rpcUrl || getRpcUrl();
  try {
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
    const rec = await publicClient.readContract({
      address: SCHEMA_REGISTRY_ADDRESS,
      abi: SCHEMA_REGISTRY_ABI,
      functionName: 'getSchema',
      args: [uid],
    });
    return { ok: true, record: { uid: String(rec[0]), schema: new TextDecoder().decode(rec[1]), resolver: String(rec[2]), revocable: !!rec[3] } };
  } catch (e) {
    return { ok: false, error: 'schema registry read failed: ' + String(e.message || e).slice(0, 200) };
  }
}

module.exports = {
  SAAX_COMMITMENT_SCHEMA,
  EAS_ADDRESS,
  SCHEMA_REGISTRY_ADDRESS,
  CHAIN_ID,
  ACTIVE_CHAIN_ID,
  ACTIVE_NETWORK,
  deriveSchemaUid,
  buildAnchorRecord,
  encodeAttestationData,
  attestationUid,
  attestCommitment,
  verifyAnchor,
  getSchemaRecord,
};