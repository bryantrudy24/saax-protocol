/**
 * SAAX Phase 3A — genuine EIP-712 typed-data signatures for the v4
 * hash/signature chain (ISOLATED, LOCAL ONLY).
 *
 * Establishes the exact linkage (agreement-signing-spec.md §4):
 *   canonical manifest bytes
 *     -> sha256 manifest digest (COSE_Sign1 envelope, v4-canonical.js)
 *     -> EIP-712 typed data (keccak256, domain-separated)
 *     -> genuine secp256k1 signatures (ethers v6 Wallet)
 *
 * Two EIP-712 domains, NEVER conflated:
 *   1. Agreement/commitment-consent domain ("SAAX Commitment V4", version 4,
 *      verifyingContract = custody) — buyer/seller AUTHORIZATION over the
 *      manifest digest.
 *   2. Custody verdict domain ("SAAX Escrow Custody V2", version 2,
 *      verifyingContract = custody) — evaluator authority / mutual
 *      resolution typed data, verified by the custody contract.
 *
 * A custody verdict signature cannot authorize an agreement term change; an
 * agreement consent cannot move funds. Access authorization (role/action
 * nonce, EscrowAccess) is a third distinct domain in endpoint/escrow-access.js.
 */

'use strict';

const crypto = require('crypto');

// ——— custody verdict domain (matches SAAXEscrowCustodyV2) ———
const CUSTODY_DOMAIN_NAME = 'SAAX Escrow Custody V2';
const CUSTODY_DOMAIN_VERSION = '2';

function custodyDomain(verifyingContract, chainId, name, version) {
  return {
    name: name || CUSTODY_DOMAIN_NAME,
    version: version || CUSTODY_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

// ——— agreement/commitment-consent domain (agreement-signing-spec §4.1) ———
const AGREEMENT_DOMAIN_NAME = 'SAAX Commitment V4';
const AGREEMENT_DOMAIN_VERSION = '4';

function agreementDomain(verifyingContract, chainId) {
  return { name: AGREEMENT_DOMAIN_NAME, version: AGREEMENT_DOMAIN_VERSION, chainId, verifyingContract };
}

const ESCROW_VERDICT_TYPES = {
  EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
};

const MUTUAL_RESOLUTION_TYPES = {
  MutualResolution: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
};

const COMMITMENT_CONSENT_TYPES = {
  CommitmentConsent: [
    { name: 'manifestHash', type: 'bytes32' },
    { name: 'role', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
};

function sha256Hex(bytes) {
  return '0x' + crypto.createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function toBytes32(v) {
  // Never silently truncate a digest or interpret a sha256: string as hex.
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error('exact 32-byte 0x-prefixed hex required');
  }
  return v.toLowerCase();
}

// ——— digest helpers (pure; no signing) ———
// Required-field validation: a missing action/nonce/issuedAt (or an
// unspecified commitment/domain binding) must fail with a useful error
// BEFORE EIP-712 encoding — never reach TypedDataEncoder with an undefined
// field. Contract action literals and the verdict/mutual signing domains
// are NOT normalized or changed here.
function assertRequiredDigestFields(kind, { commitmentId, commitmentDigest, action, nonce, issuedAt, verifyingContract, chainId }) {
  const missing = [];
  if (typeof action !== 'string' || action === '') missing.push('action');
  if (nonce === undefined || nonce === null) missing.push('nonce');
  if (issuedAt === undefined || issuedAt === null) missing.push('issuedAt');
  if (!commitmentId || !/^0x[0-9a-fA-F]{64}$/.test(String(commitmentId))) missing.push('commitmentId');
  if (!commitmentDigest || !/^0x[0-9a-fA-F]{64}$/.test(String(commitmentDigest))) missing.push('commitmentDigest');
  if (!verifyingContract || !/^0x[0-9a-fA-F]{40}$/.test(String(verifyingContract))) missing.push('verifyingContract');
  if (chainId === undefined || chainId === null) missing.push('chainId');
  if (missing.length) {
    throw new Error(kind + ' signed-data missing/invalid required field(s): ' + missing.join(', ') + ' — refused before EIP-712 encoding');
  }
  return { commitmentId: String(commitmentId).toLowerCase(), commitmentDigest: String(commitmentDigest).toLowerCase(), action, nonce, issuedAt, verifyingContract: String(verifyingContract).toLowerCase(), chainId };
}

async function verdictDigest(fields) {
  const { commitmentId, commitmentDigest, action, nonce, issuedAt, verifyingContract, chainId, name, version } = assertRequiredDigestFields('verdict', fields || {});
  const { ethers } = await import('ethers');
  return ethers.TypedDataEncoder.hash(
    custodyDomain(verifyingContract, chainId, name, version),
    ESCROW_VERDICT_TYPES,
    { commitmentId, commitmentDigest, action, nonce, issuedAt }
  );
}

async function mutualDigest(fields) {
  const { commitmentId, commitmentDigest, action, nonce, issuedAt, verifyingContract, chainId } = assertRequiredDigestFields('mutual', fields || {});
  const { ethers } = await import('ethers');
  return ethers.TypedDataEncoder.hash(
    custodyDomain(verifyingContract, chainId),
    MUTUAL_RESOLUTION_TYPES,
    { commitmentId, commitmentDigest, action, nonce, issuedAt }
  );
}

// ——— genuine signatures ———
async function signVerdict(wallet, { commitmentId, commitmentDigest, action, nonce, issuedAt, verifyingContract, chainId }) {
  const { ethers } = await import('ethers');
  const sig = await wallet.signTypedData(
    custodyDomain(verifyingContract, chainId),
    ESCROW_VERDICT_TYPES,
    { commitmentId, commitmentDigest, action, nonce, issuedAt }
  );
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, signature: sig };
}

async function signMutual(wallet, { commitmentId, commitmentDigest, action, nonce, issuedAt, verifyingContract, chainId }) {
  const { ethers } = await import('ethers');
  const sig = await wallet.signTypedData(
    custodyDomain(verifyingContract, chainId),
    MUTUAL_RESOLUTION_TYPES,
    { commitmentId, commitmentDigest, action, nonce, issuedAt }
  );
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, signature: sig };
}

async function signConsent(wallet, { manifestHash, role, nonce, expiresAt, verifyingContract, chainId }) {
  const { ethers } = await import('ethers');
  const sig = await wallet.signTypedData(
    agreementDomain(verifyingContract, chainId),
    COMMITMENT_CONSENT_TYPES,
    { manifestHash, role, nonce, expiresAt }
  );
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, signature: sig };
}

module.exports = {
  CUSTODY_DOMAIN_NAME,
  CUSTODY_DOMAIN_VERSION,
  AGREEMENT_DOMAIN_NAME,
  AGREEMENT_DOMAIN_VERSION,
  custodyDomain,
  agreementDomain,
  ESCROW_VERDICT_TYPES,
  MUTUAL_RESOLUTION_TYPES,
  COMMITMENT_CONSENT_TYPES,
  sha256Hex,
  toBytes32,
  verdictDigest,
  mutualDigest,
  signVerdict,
  signMutual,
  signConsent,
};// ——— v4 journal domain (design doc §5) ———
// NEW versioned journal domain: name 'SAAX Commitment Journal', version '4',
// chainId = the signed agreement's custody.chainId, verifyingContract = the
// signed agreement's custody.custodyAddress. Explicitly NOT v3's domain
// ('SAAX Commitment Journal'/'1' + zero verifyingContract + hardcoded 84532),
// NOT the custody domain (SAAX Escrow Custody V2/'2'), and never inferred
// from formatVersion.
const JOURNAL_DOMAIN_NAME = 'SAAX Commitment Journal';
const JOURNAL_DOMAIN_VERSION = '4';

function journalDomain(verifyingContract, chainId) {
  return { name: JOURNAL_DOMAIN_NAME, version: JOURNAL_DOMAIN_VERSION, chainId, verifyingContract };
}

const JOURNAL_EVENT_V4_TYPES = {
  JournalEventV4: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'manifestHash', type: 'bytes32' },
    { name: 'transition', type: 'string' },
    { name: 'role', type: 'string' },
    { name: 'by', type: 'address' },
    { name: 'contractAction', type: 'string' },
    { name: 'resultingState', type: 'string' },
    { name: 'at', type: 'string' },
    { name: 'observed', type: 'bool' },
    { name: 'prevHash', type: 'string' },
    { name: 'entryHash', type: 'string' },
    { name: 'evidenceDigest', type: 'bytes32' },
  ],
};

async function journalEventDigest({ commitmentId, manifestHash, transition, role, by, contractAction, resultingState, at, observed, prevHash, entryHash, evidenceDigest, verifyingContract, chainId }) {
  const { ethers } = await import('ethers');
  return ethers.TypedDataEncoder.hash(
    journalDomain(verifyingContract, chainId),
    JOURNAL_EVENT_V4_TYPES,
    { commitmentId, manifestHash, transition, role, by, contractAction, resultingState, at, observed, prevHash, entryHash, evidenceDigest }
  );
}

async function signJournalEvent(wallet, { commitmentId, manifestHash, transition, role, by, contractAction, resultingState, at, observed, prevHash, entryHash, evidenceDigest, verifyingContract, chainId }) {
  const { ethers } = await import('ethers');
  const sig = await wallet.signTypedData(
    journalDomain(verifyingContract, chainId),
    JOURNAL_EVENT_V4_TYPES,
    { commitmentId, manifestHash, transition, role, by, contractAction, resultingState, at, observed, prevHash, entryHash, evidenceDigest }
  );
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, signature: sig };
}

module.exports = {
  CUSTODY_DOMAIN_NAME,
  CUSTODY_DOMAIN_VERSION,
  AGREEMENT_DOMAIN_NAME,
  AGREEMENT_DOMAIN_VERSION,
  JOURNAL_DOMAIN_NAME,
  JOURNAL_DOMAIN_VERSION,
  custodyDomain,
  agreementDomain,
  journalDomain,
  ESCROW_VERDICT_TYPES,
  MUTUAL_RESOLUTION_TYPES,
  COMMITMENT_CONSENT_TYPES,
  JOURNAL_EVENT_V4_TYPES,
  sha256Hex,
  toBytes32,
  verdictDigest,
  mutualDigest,
  journalEventDigest,
  signVerdict,
  signMutual,
  signConsent,
  signJournalEvent,
};// ——— v4 evidence domain (Phase C) ———
// NEW versioned evidence domain: name 'SAAX Commitment Evidence', version '4',
// chainId = the signed agreement's custody.chainId, verifyingContract = the
// signed agreement's custody.custodyAddress. Explicitly NOT the agreement
// domain (SAAX Commitment V4), NOT the custody/verdict domain (SAAX Escrow
// Custody V2), NOT the journal domain (SAAX Commitment Journal), and never
// inferred from formatVersion.
const EVIDENCE_DOMAIN_NAME = 'SAAX Commitment Evidence';
const EVIDENCE_DOMAIN_VERSION = '4';

function evidenceDomain(verifyingContract, chainId) {
  return { name: EVIDENCE_DOMAIN_NAME, version: EVIDENCE_DOMAIN_VERSION, chainId, verifyingContract };
}

const EVIDENCE_ITEM_TYPES = {
  EvidenceItemV4: [
    { name: 'recordVersion', type: 'uint256' },
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'manifestHash', type: 'bytes32' },
    { name: 'criterionId', type: 'string' },
    { name: 'itemId', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'issuer', type: 'address' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'at', type: 'string' },
    { name: 'amount', type: 'string' },
  ],
};

async function evidenceItemDigest({ recordVersion, commitmentId, manifestHash, criterionId, itemId, type, issuer, payloadHash, at, amount, verifyingContract, chainId }) {
  const { ethers } = await import('ethers');
  return ethers.TypedDataEncoder.hash(
    evidenceDomain(verifyingContract, chainId),
    EVIDENCE_ITEM_TYPES,
    { recordVersion, commitmentId, manifestHash, criterionId, itemId, type, issuer, payloadHash, at, amount }
  );
}

async function signEvidenceItem(wallet, { recordVersion, commitmentId, manifestHash, criterionId, itemId, type, issuer, payloadHash, at, amount, verifyingContract, chainId }) {
  const { ethers } = await import('ethers');
  const sig = await wallet.signTypedData(
    evidenceDomain(verifyingContract, chainId),
    EVIDENCE_ITEM_TYPES,
    { recordVersion, commitmentId, manifestHash, criterionId, itemId, type, issuer, payloadHash, at, amount }
  );
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, signature: sig };
}

module.exports = {
  CUSTODY_DOMAIN_NAME,
  CUSTODY_DOMAIN_VERSION,
  AGREEMENT_DOMAIN_NAME,
  AGREEMENT_DOMAIN_VERSION,
  JOURNAL_DOMAIN_NAME,
  JOURNAL_DOMAIN_VERSION,
  EVIDENCE_DOMAIN_NAME,
  EVIDENCE_DOMAIN_VERSION,
  custodyDomain,
  agreementDomain,
  journalDomain,
  evidenceDomain,
  ESCROW_VERDICT_TYPES,
  MUTUAL_RESOLUTION_TYPES,
  COMMITMENT_CONSENT_TYPES,
  JOURNAL_EVENT_V4_TYPES,
  EVIDENCE_ITEM_TYPES,
  sha256Hex,
  toBytes32,
  verdictDigest,
  mutualDigest,
  journalEventDigest,
  evidenceItemDigest,
  signVerdict,
  signMutual,
  signConsent,
  signJournalEvent,
  signEvidenceItem,
};