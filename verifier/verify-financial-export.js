#!/usr/bin/env node
'use strict';

// Independent verifier for the bounded discovery-financial-v2 testnet profile.
// Intentionally has no SAAX application/DB imports. All chain access is read-only.
// Runtime dependency: ethers v6 (already used by the repository's testnet tools).

const fs = require('node:fs');
const crypto = require('node:crypto');
const { verifyFulfillment, verifyVerdictAuthorization } = require('./financial-evidence.js');
const {
  Interface,
  JsonRpcProvider,
  verifyTypedData,
  keccak256,
  solidityPackedKeccak256,
  TypedDataEncoder,
} = require('ethers');

const CHAIN_ID = 84532;
const NETWORK = 'eip155:84532';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const CUSTODY_RUNTIME_KECCAK = '0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473';
const TEST_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const SR_VERSION = 'manifest-v1.1+saax-proposal-bound';
const DEFAULT_RPC = 'https://sepolia.base.org';

// ABI is copied from the committed escrow-custody-build.json ABI at the pinned
// source revision. Do not build this verifier from current Solidity source: the
// independent verifier must decode the deployed contract's committed ABI.
const CUSTODY_ABI = [
  'function fund(bytes32 commitmentId,bytes32 commitmentDigest,address token,address buyer,address seller,address evaluator,uint256 amount,uint256 deadline,uint64 minReleaseTime) returns (bool)',
  'function release(bytes32 commitmentId,bytes32 commitmentDigest,uint256 nonce,uint256 issuedAt,uint8 v,bytes32 r,bytes32 s) returns (bool)',
  'function refund(bytes32 commitmentId,bytes32 commitmentDigest,uint256 nonce,uint256 issuedAt,uint8 v,bytes32 r,bytes32 s) returns (bool)',
  'function getEscrow(bytes32 commitmentId) view returns (bytes32 id,bytes32 digest,address token,address buyer,address seller,address evaluator,uint256 amount,uint256 deadline,uint64 minReleaseTime,uint8 state,address disputedBy,uint256 disputeAt,uint64 releasedAt,uint64 refundedAt)',
  'function usedVerdictNonce(uint256 nonce) view returns (bool)',
  'function domainSeparator() view returns (bytes32)',
  'function chainId() view returns (uint256)',
  'function VERDICT_TYPEHASH() view returns (bytes32)',
  'event Funded(bytes32 indexed commitmentId,bytes32 commitmentDigest,address token,address buyer,address seller,address evaluator,uint256 amount,uint256 deadline)',
  'event Released(bytes32 indexed commitmentId,address indexed seller,uint256 amount,bytes32 verdictHash)',
  'event Refunded(bytes32 indexed commitmentId,address indexed buyer,uint256 amount,bytes32 verdictHash)',
];
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
];
const custodyInterface = new Interface(CUSTODY_ABI);
const erc20Interface = new Interface(ERC20_ABI);
const VERDICT_TYPES = {
  EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// RFC 8785-compatible canonicalization for the JSON/I-JSON values used here.
function jcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (!isObject(value)) throw new Error('JCS_UNSUPPORTED_VALUE');
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + jcs(value[key])).join(',') + '}';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function proposalDigestOf(proposal) {
  const unsigned = structuredClone(proposal);
  delete unsigned.signature;
  return 'sha256:' + sha256Hex(jcs(unsigned));
}

function termsDigestOf(terms) {
  return 'sha256:' + sha256Hex(jcs(terms));
}

function normalizeAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase();
}

function normalizeBytes32(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

function digestToBytes32(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/^sha256:/i, '').replace(/^0x/i, '');
  return /^[0-9a-fA-F]{64}$/.test(hex) ? '0x' + hex.toLowerCase() : null;
}

function canonicalBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('JWS_INVALID_BASE64URL');
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4), 'base64');
  const encoded = bytes.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (encoded !== text) throw new Error('JWS_NON_CANONICAL_BASE64URL');
  return bytes;
}

function validatePublicJwk(jwk) {
  return isObject(jwk) && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' &&
    typeof jwk.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jwk.x) && !Object.hasOwn(jwk, 'd');
}

function verifyCompactJws({ jws, publicJwk, expectedKeyId, expectedPayload }) {
  try {
    if (!validatePublicJwk(publicJwk)) return { ok: false, code: 'JWS_TRUST_KEY_INVALID' };
    if (typeof jws !== 'string') return { ok: false, code: 'JWS_MISSING' };
    const parts = jws.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return { ok: false, code: 'JWS_COMPACT_INVALID' };

    const headerBytes = canonicalBase64Url(parts[0]);
    const payloadBytes = canonicalBase64Url(parts[1]);
    const signature = canonicalBase64Url(parts[2]);
    const header = JSON.parse(headerBytes.toString('utf8'));
    if (!isObject(header) || header.alg !== 'EdDSA') return { ok: false, code: 'JWS_ALGORITHM_INVALID' };
    if (header.kid !== expectedKeyId) return { ok: false, code: 'JWS_KID_MISMATCH' };
    if (Object.hasOwn(header, 'crit')) return { ok: false, code: 'JWS_CRITICAL_HEADER_UNSUPPORTED' };
    if (header.b64 === false) return { ok: false, code: 'JWS_UNENCODED_PAYLOAD_UNSUPPORTED' };
    if (signature.length !== 64) return { ok: false, code: 'JWS_SIGNATURE_LENGTH_INVALID' };

    const publicKey = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
    const signingInput = Buffer.from(parts[0] + '.' + parts[1], 'ascii');
    if (!crypto.verify(null, signingInput, publicKey, signature)) return { ok: false, code: 'JWS_SIGNATURE_INVALID' };

    if (expectedPayload !== undefined) {
      const expected = Buffer.from(jcs(expectedPayload), 'utf8');
      if (!expected.equals(payloadBytes)) return { ok: false, code: 'JWS_PAYLOAD_MISMATCH' };
    }
    let payload;
    try { payload = JSON.parse(payloadBytes.toString('utf8')); }
    catch (_) { return { ok: false, code: 'JWS_PAYLOAD_JSON_INVALID' }; }
    return { ok: true, payload, kid: header.kid };
  } catch (error) {
    return { ok: false, code: error && /^JWS_/.test(error.message) ? error.message : 'JWS_MALFORMED' };
  }
}

function signatureEnvelopeCheck(envelope, trustKeyId) {
  return isObject(envelope) && envelope.scheme === 'jws' && envelope.alg === 'EdDSA' &&
    envelope.canonicalization === 'rfc8785' && envelope.keyId === trustKeyId && typeof envelope.jws === 'string';
}

function jwkPublicFromTrust(trustEntry) {
  return { kty: trustEntry.publicJwk.kty, crv: trustEntry.publicJwk.crv, x: trustEntry.publicJwk.x };
}

function financialAgreementOf(proposal) {
  return proposal && proposal.terms && proposal.terms.policies && proposal.terms.policies.financialAgreement;
}

function agreementProblems(agreement) {
  const problems = [];
  if (!isObject(agreement)) return ['FA_MISSING'];
  if (agreement.schemaVersion !== 'saax-financial-agreement-v1') problems.push('FA_SCHEMA_VERSION');
  if (Number(agreement.chainId) !== CHAIN_ID) problems.push('FA_CHAIN_ID');
  if (agreement.network !== NETWORK) problems.push('FA_NETWORK');
  if (typeof agreement.asset !== 'string' || !/^eip155:84532\/erc20:0x[0-9a-fA-F]{40}$/.test(agreement.asset)) problems.push('FA_CAIP19');
  if (!normalizeAddress(agreement.buyer) || /^0x0{40}$/i.test(agreement.buyer)) problems.push('FA_BUYER_ADDRESS');
  if (!normalizeAddress(agreement.seller) || /^0x0{40}$/i.test(agreement.seller) || eqAddress(agreement.buyer, agreement.seller)) problems.push('FA_SELLER_ADDRESS');
  if (!isObject(agreement.evaluator) || !normalizeAddress(agreement.evaluator.address)) problems.push('FA_EVALUATOR');
  const decisions = agreement.evaluator && agreement.evaluator.permittedDecisions;
  if (!Array.isArray(decisions) || decisions.length === 0 || decisions.some((d) => !['release', 'refund'].includes(d)) || new Set(decisions).size !== decisions.length) {
    problems.push('FA_PERMITTED_DECISIONS');
  }
  if (!isObject(agreement.custody) || normalizeAddress(agreement.custody.address) !== CUSTODY ||
      String(agreement.custody.runtimeKeccak || '').toLowerCase() !== CUSTODY_RUNTIME_KECCAK) problems.push('FA_CUSTODY_PIN');
  if (!isObject(agreement.token) || normalizeAddress(agreement.token.address) !== TEST_USDC ||
      agreement.token.symbol !== 'USDC' || Number(agreement.token.decimals) !== 6) problems.push('FA_TOKEN');
  const minRelease = agreement.minReleaseTime;
  if (!(typeof minRelease === 'string' && /^\d+$/.test(minRelease)) && !(Number.isSafeInteger(minRelease) && minRelease >= 0)) problems.push('FA_MIN_RELEASE_TIME');
  const recovery = agreement.recovery;
  if (!isObject(recovery) || typeof recovery.timeoutRefund !== 'boolean' || typeof recovery.signedRefund !== 'boolean' ||
      recovery.refundBeneficiary !== 'buyer' || (!recovery.timeoutRefund && !recovery.signedRefund)) problems.push('FA_RECOVERY');
  if (Array.isArray(decisions)) {
    if (!decisions.includes('release')) problems.push('FA_RELEASE_NOT_PERMITTED');
    if (recovery && recovery.signedRefund && !decisions.includes('refund')) problems.push('FA_SIGNED_REFUND_NOT_PERMITTED');
  }
  const expectedAsset = 'eip155:84532/erc20:' + TEST_USDC;
  if (String(agreement.asset || '').toLowerCase() !== expectedAsset) problems.push('FA_ASSET_PIN');
  return problems;
}

function checkFinancialProposalBindings(proposal, agreement, commitment) {
  const errors = [];
  const terms = proposal && proposal.terms;
  const manifest = commitment && commitment.manifest;
  const fa = agreement;
  if (!isObject(terms)) return ['PROPOSAL_TERMS_MISSING'];
  if (terms.network !== NETWORK) errors.push('PROPOSAL_NETWORK');
  if (String(terms.asset || '').toLowerCase() !== 'eip155:84532/erc20:' + TEST_USDC) errors.push('PROPOSAL_ASSET');
  if (terms.rail !== 'x402' || terms.mode !== 'escrow') errors.push('PROPOSAL_ESCROW_MODE');
  if (terms.currency !== 'USDC' || terms.decimals !== 6 || terms.financialTerms !== 'financial' ||
      terms.unit !== 'micro-units of settlement asset') errors.push('PROPOSAL_TOKEN_TERMS');
  if (typeof terms.amount !== 'string' || !/^\d+$/.test(terms.amount) || BigInt(terms.amount) <= 0n) errors.push('PROPOSAL_AMOUNT');
  if (!isObject(terms.policies) || !terms.policies.financialAgreement) errors.push('FA_MISSING');
  if (!manifest || !isObject(manifest.price) || String(manifest.price.amount) !== String(terms.amount) ||
      manifest.price.currency !== terms.currency || Number(manifest.price.decimals) !== Number(terms.decimals)) errors.push('MANIFEST_PRICE_BINDING');
  if (fa && normalizeAddress(fa.buyer) !== normalizeAddress(proposal.audience && proposal.audience.buyer)) errors.push('FA_PROPOSAL_BUYER_BINDING');
  if (fa && manifest && normalizeAddress(manifest.buyerAgentId) !== normalizeAddress(fa.buyer)) errors.push('MANIFEST_BUYER_BINDING');
  if (manifest && proposal.provider && String(manifest.sellerAgentId).replace(/\/+$/, '').toLowerCase() !== String(proposal.provider.providerId).replace(/\/+$/, '').toLowerCase()) errors.push('MANIFEST_PROVIDER_BINDING');
  if (manifest && terms.deadline && manifest.deadline !== terms.deadline) errors.push('MANIFEST_DEADLINE_BINDING');
  if (fa && terms.deadline && Number.isFinite(Date.parse(terms.deadline))) {
    // Deadline is authenticated by proposal terms + acceptance + SR; no separate
    // deadline copy is accepted from the export.
  }
  return errors;
}

function normalizedRequestProblems(request, proposal, agreement, commitment) {
  const errors = [];
  if (!isObject(request)) return ['NORMALIZED_REQUEST_MISSING'];
  if (request.profileVersion !== proposal.profileVersion) errors.push('NORMALIZED_REQUEST_PROFILE_VERSION');
  const fp = request.financialProfile || {};
  const terms = proposal.terms || {};
  if (fp.network !== terms.network || fp.asset !== terms.asset || fp.rail !== terms.rail || fp.mode !== terms.mode) {
    errors.push('NORMALIZED_REQUEST_FINANCIAL_BINDING');
  }
  if (!request.units || String(request.units.amount) !== String(terms.amount) || request.units.unit !== terms.unit) {
    errors.push('NORMALIZED_REQUEST_UNITS_BINDING');
  }
  if (!request.schema || jcs(request.schema) !== jcs(proposal.manifest && proposal.manifest.schema)) {
    errors.push('NORMALIZED_REQUEST_SCHEMA_BINDING');
  }
  if (!request.capability || !request.capability.id || !commitment || !commitment.manifest ||
      request.capability.id !== commitment.manifest.capability) errors.push('NORMALIZED_REQUEST_CAPABILITY_BINDING');
  if (!request.intendedParties || !eqAddress(request.intendedParties.buyer, agreement && agreement.buyer)) {
    errors.push('NORMALIZED_REQUEST_BUYER_BINDING');
  }
  if ('seller' in (request.intendedParties || {}) && !eqAddress(request.intendedParties.seller, agreement && agreement.seller)) {
    errors.push('NORMALIZED_REQUEST_SELLER_BINDING');
  }
  if ('deadline' in (request.constraints || {}) && request.constraints.deadline !== terms.deadline) {
    errors.push('NORMALIZED_REQUEST_DEADLINE_BINDING');
  }
  if (!request.issuedAt || !Number.isFinite(Date.parse(request.issuedAt)) || typeof request.clientNonce !== 'string' || request.clientNonce !== proposal.nonce) {
    errors.push('NORMALIZED_REQUEST_ISSUANCE_BINDING');
  }
  const requestDigest = 'sha256:' + sha256Hex(jcs(request));
  if (requestDigest !== proposal.requestDigest) errors.push('NORMALIZED_REQUEST_DIGEST');
  return errors;
}

function buildLegacyManifestHash(manifest) {
  // This is the repository's manifest-v1 hashing format (commitment.js): hash
  // the JSON COSE_Sign1 envelope with the original fixed field order.
  const fields = ['commitmentId', 'buyerAgentId', 'sellerAgentId', 'capability', 'price', 'acceptanceCriteria', 'deadline', 'cancelCondition'];
  const selected = {};
  for (const field of fields) {
    if (manifest[field] !== undefined && manifest[field] !== null) selected[field] = manifest[field];
  }
  for (const field of ['price', 'acceptanceCriteria']) {
    if (selected[field] && isObject(selected[field])) {
      selected[field] = Object.keys(selected[field]).sort().reduce((out, key) => {
        out[key] = selected[field][key];
        return out;
      }, {});
    }
  }
  const payloadBytes = JSON.stringify(selected);
  const signatureTag = String(manifest.signature || '');
  const sigMatch = /^COSE_Sign1:(0x[0-9a-fA-F]{130})$/.exec(signatureTag);
  if (!sigMatch) throw new Error('MANIFEST_SIGNATURE_SHAPE');
  const protectedB64 = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'saax-protocol-phase1' }), 'utf8').toString('base64url');
  const envelope = {
    tag: 'COSE_Sign1',
    protected: protectedB64,
    unprotected: '',
    payload: Buffer.from(payloadBytes, 'utf8').toString('base64url'),
    signature: sigMatch[1],
  };
  return 'sha256:' + sha256Hex(JSON.stringify(envelope));
}

function srPayloadFor({ proposal, commitment, agreement, proposalDigest }) {
  const manifest = commitment.manifest;
  const sr = commitment.signedRepresentation;
  return {
    signedRepresentationVersion: SR_VERSION,
    commitmentId: commitment.commitmentId,
    proposalId: proposal.proposalId,
    proposalDigest,
    manifestDigest: commitment.manifestHash,
    acceptanceCriteria: manifest.acceptanceCriteria,
    deadline: manifest.deadline,
    price: manifest.price,
    sellerAgentId: manifest.sellerAgentId,
    buyerAgentId: manifest.buyerAgentId,
    capability: manifest.capability,
    evaluator: agreement.evaluator,
    permittedDecisions: agreement.evaluator.permittedDecisions,
    profileVersion: proposal.profileVersion,
    manifestVersion: proposal.manifest && proposal.manifest.commitmentManifestVersion,
    signedAt: sr.signedAt,
  };
}

function checkProfileTrust(profile, providerTrust) {
  if (!isObject(profile) || !Array.isArray(profile.signingKeys)) return 'PROFILE_SHAPE';
  if (profile.providerId !== providerTrust.providerId) return 'PROFILE_PROVIDER_ID_MISMATCH';
  if (profile.origin !== new URL(providerTrust.providerId).origin ||
      (providerTrust.origin && profile.origin !== providerTrust.origin)) return 'PROFILE_ORIGIN_TRUST_MISMATCH';
  const key = profile.signingKeys.find((entry) => entry && entry.id === providerTrust.keyId);
  if (!key || !key.jwk) return 'PROFILE_TRUSTED_KEY_MISSING';
  if (key.type !== 'jwk' || key.status !== 'active') return 'PROFILE_TRUSTED_KEY_NOT_ACTIVE_JWK';
  if (key.jwk.kty !== providerTrust.publicJwk.kty || key.jwk.crv !== providerTrust.publicJwk.crv || key.jwk.x !== providerTrust.publicJwk.x) {
    return 'PROFILE_PUBLIC_KEY_MISMATCH';
  }
  return null;
}

function checkTrustSchema(trust) {
  const issues = [];
  if (!isObject(trust)) return ['TRUST_FILE_SHAPE'];
  const provider = trust.provider;
  const buyer = trust.buyer;
  if (!isObject(provider) || typeof provider.providerId !== 'string' || !provider.providerId ||
      typeof provider.keyId !== 'string' || !provider.keyId || !validatePublicJwk(provider.publicJwk)) issues.push('TRUST_PROVIDER_ENTRY');
  if (!isObject(buyer) || !normalizeAddress(buyer.address) || typeof buyer.keyId !== 'string' || !buyer.keyId ||
      !validatePublicJwk(buyer.publicJwk)) issues.push('TRUST_BUYER_ENTRY');
  return issues;
}

function addCheck(results, code, ok, detail) {
  results.push({ code, status: ok ? 'PASS' : 'FAIL', detail: String(detail || '') });
}

function addIncomplete(results, code, detail) {
  results.push({ code, status: 'INCOMPLETE', detail: String(detail || '') });
}

function exactEvents(receipt, contractInterface, eventName, address) {
  const found = [];
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== address.toLowerCase()) continue;
    try {
      const parsed = contractInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === eventName) found.push(parsed);
    } catch (_) { /* unrelated log or event */ }
  }
  return found;
}

function transferEvents(receipt, tokenAddress) {
  const found = [];
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== tokenAddress.toLowerCase()) continue;
    try {
      const parsed = erc20Interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === 'Transfer') found.push(parsed.args);
    } catch (_) { /* unrelated token log */ }
  }
  return found;
}

function argAt(args, index, name) {
  return args[name] !== undefined ? args[name] : args[index];
}

function secondsFromIso(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? BigInt(Math.floor(milliseconds / 1000)) : null;
}

function eqAddress(left, right) {
  const a = normalizeAddress(String(left || ''));
  const b = normalizeAddress(String(right || ''));
  return !!a && !!b && a === b;
}

function verifyAcceptanceShape(acceptance, proposal, proposalDigest, buyerTrust, generatedAt) {
  const errors = [];
  if (!isObject(acceptance)) return ['ACCEPTANCE_MISSING'];
  if (acceptance.schemaVersion !== 'acceptance-v1') errors.push('ACCEPTANCE_SCHEMA');
  if (acceptance.action !== 'accept_commitment' || acceptance.domain !== 'saax:acceptance:v1') errors.push('ACCEPTANCE_DOMAIN_ACTION');
  if (!eqAddress(acceptance.buyer, buyerTrust.address)) errors.push('ACCEPTANCE_BUYER_TRUST_BINDING');
  if (!acceptance.provider || acceptance.provider.providerId !== proposal.provider.providerId ||
      acceptance.provider.signingKeyId !== proposal.provider.signingKeyId) errors.push('ACCEPTANCE_PROVIDER_BINDING');
  if (!acceptance.proposal || acceptance.proposal.proposalId !== proposal.proposalId ||
      acceptance.proposal.proposalDigest !== proposalDigest) errors.push('ACCEPTANCE_PROPOSAL_BINDING');
  if (acceptance.termsDigest !== termsDigestOf(proposal.terms)) errors.push('ACCEPTANCE_TERMS_DIGEST');
  const audience = String(acceptance.audience || '').toLowerCase().replace(/\/+$/, '');
  const providerId = String(proposal.provider.providerId || '').toLowerCase().replace(/\/+$/, '');
  if (!audience || audience !== providerId) errors.push('ACCEPTANCE_AUDIENCE');
  if (!isObject(acceptance.versions) || acceptance.versions.profileVersion !== proposal.profileVersion ||
      !proposal.manifest || acceptance.versions.manifestVersion !== proposal.manifest.commitmentManifestVersion ||
      !acceptance.versions.schema || jcs(acceptance.versions.schema) !== jcs(proposal.manifest.schema)) errors.push('ACCEPTANCE_VERSIONS');
  if (acceptance.signature && acceptance.signature.keyId !== buyerTrust.keyId) errors.push('ACCEPTANCE_KID');
  const from = Date.parse(acceptance.notBefore || '');
  const to = Date.parse(acceptance.notAfter || '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) errors.push('ACCEPTANCE_VALIDITY_WINDOW');
  if (typeof acceptance.nonce !== 'string' || acceptance.nonce.length < 8 || acceptance.nonce === proposal.nonce) errors.push('ACCEPTANCE_NONCE');
  if (!signatureEnvelopeCheck(acceptance.signature, buyerTrust.keyId)) errors.push('ACCEPTANCE_SIGNATURE_ENVELOPE');
  return errors;
}

function verifyProposalShape(proposal, providerTrust, profile) {
  const errors = [];
  if (!isObject(proposal)) return ['PROPOSAL_MISSING'];
  if (proposal.profileVersion !== '1.0.0') errors.push('PROPOSAL_PROFILE_VERSION');
  if (typeof proposal.proposalId !== 'string' || !/^prop_[A-Za-z0-9_-]+$/.test(proposal.proposalId)) errors.push('PROPOSAL_ID');
  if (typeof proposal.nonce !== 'string' || proposal.nonce.length < 8) errors.push('PROPOSAL_NONCE');
  if (!/^sha256:[0-9a-f]{64}$/.test(proposal.requestDigest || '')) errors.push('PROPOSAL_REQUEST_DIGEST');
  if (!proposal.provider || proposal.provider.providerId !== providerTrust.providerId ||
      proposal.provider.signingKeyId !== providerTrust.keyId) errors.push('PROPOSAL_PROVIDER_TRUST_BINDING');
  if (profile && profile.origin && proposal.provider && proposal.provider.origin !== profile.origin) errors.push('PROPOSAL_PROVIDER_ORIGIN');
  if (!proposal.audience || !eqAddress(proposal.audience.buyer, proposal.audience.buyer) ||
      !proposal.terms || !proposal.terms.policies || !proposal.terms.policies.financialAgreement ||
      !eqAddress(proposal.audience.buyer, proposal.terms.policies.financialAgreement.buyer)) {
    errors.push('PROPOSAL_AUDIENCE_BUYER');
  }
  if (!proposal.manifest || !proposal.manifest.schema || !proposal.manifest.commitmentManifestVersion ||
      !/^sha256:[0-9a-f]{64}$/.test(proposal.manifest.commitmentManifestDigest || '') ||
      !/^sha256:[0-9a-f]{64}$/.test(proposal.manifest.schema.digest || '')) errors.push('PROPOSAL_MANIFEST_SCHEMA');
  const issued = Date.parse(proposal.issuedAt || '');
  const expires = Date.parse(proposal.expires || '');
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) errors.push('PROPOSAL_TIME_WINDOW');
  if (proposal.status !== 'proposed') errors.push('PROPOSAL_STATUS');
  if (!signatureEnvelopeCheck(proposal.signature, providerTrust.keyId)) errors.push('PROPOSAL_SIGNATURE_ENVELOPE');
  if (profile && profile.financialCompatibility && Array.isArray(profile.financialCompatibility.supportedCombinations)) {
    const terms = proposal.terms || {};
    const supported = profile.financialCompatibility.supportedCombinations.some((combo) =>
      combo.network === terms.network && combo.asset === terms.asset && combo.rail === terms.rail && combo.mode === terms.mode &&
      String(combo.settlementCurrency || '').toUpperCase() === String(terms.currency || '').toUpperCase() &&
      Number(combo.settlementDecimals) === Number(terms.decimals));
    if (!supported) errors.push('PROPOSAL_PROFILE_COMBINATION');
  } else {
    errors.push('PROFILE_FINANCIAL_COMPATIBILITY_MISSING');
  }
  if (profile && Array.isArray(profile.capabilities)) {
    const schema = proposal.manifest && proposal.manifest.schema;
    const declared = !!schema && profile.capabilities.some((capability) =>
      Array.isArray(capability.schemas) && capability.schemas.some((candidate) =>
        candidate.id === schema.id && candidate.version === schema.version && candidate.digest === schema.digest &&
        (!candidate.purpose || candidate.purpose === 'commitment-manifest')));
    if (!declared) errors.push('PROPOSAL_PROFILE_SCHEMA');
    if (profile.providerId !== proposal.provider.providerId) errors.push('PROPOSAL_PROFILE_ID');
  } else {
    errors.push('PROFILE_CAPABILITIES_MISSING');
  }
  return errors;
}

function parseCallData(contractInterface, tx) {
  try { return contractInterface.parseTransaction({ data: tx.data, value: tx.value }); }
  catch (_) { return null; }
}

async function historicalCall(provider, transaction, blockNumber) {
  // ethers v6 takes blockTag in TransactionRequest, not a second call argument.
  // Explicit JSON-RPC avoids accidentally verifying latest state as historical.
  const tag = typeof blockNumber === 'string' ? blockNumber : '0x' + BigInt(blockNumber).toString(16);
  return provider.send('eth_call', [transaction, tag]);
}

async function verifyExport(exportObject, trust, rpcUrl = DEFAULT_RPC, options = {}) {
  const results = [];
  const exp = exportObject;
  const trustIssues = checkTrustSchema(trust);
  for (const issue of trustIssues) addCheck(results, issue, false, 'Invalid explicit trust file.');
  if (trustIssues.length) return { verdict: 'NOT VERIFIED', checks: results };

  // Historical v1 exports lack the authenticated agreement and full signature
  // bindings required here. They are explicitly incomplete, never verified.
  if (!exp || exp.formatVersion !== 'discovery-financial-v2') {
    addIncomplete(results, 'E_OLD_FORMAT_INCOMPLETE', 'Only discovery-financial-v2 is verifiable. Historical/incomplete exports are not promoted to VERIFIED.');
    return { verdict: 'INCOMPLETE', checks: results };
  }
  addCheck(results, 'E_FORMAT_V2', true, exp.formatVersion);
  const providerTrust = trust.provider;
  const buyerTrust = trust.buyer;
  addCheck(results, 'E_KIND', ['real-sepolia-release', 'real-sepolia-refund'].includes(exp.kind), exp.kind);

  // The provider profile itself must be signed by the configured provider key.
  const profile = exp.providerProfile;
  const profileUnsigned = isObject(profile) ? structuredClone(profile) : null;
  if (profileUnsigned) delete profileUnsigned.signature;
  const profileSig = isObject(profile) && profile.signature;
  const profileShapeOk = isObject(profile) && signatureEnvelopeCheck(profileSig, providerTrust.keyId);
  addCheck(results, 'E_PROVIDER_PROFILE_SIGNATURE_ENVELOPE', profileShapeOk, profileShapeOk ? 'JWS envelope uses the pinned provider kid.' : 'Missing/mismatched signed providerProfile envelope.');
  if (profileShapeOk) {
    const profileTrustProblem = checkProfileTrust(profileUnsigned, { ...providerTrust, publicJwk: jwkPublicFromTrust(providerTrust) });
    addCheck(results, 'E_PROVIDER_PROFILE_TRUST_BINDING', !profileTrustProblem, profileTrustProblem || 'providerId and public signing key match --trust.');
    const pv = verifyCompactJws({ jws: profileSig.jws, publicJwk: jwkPublicFromTrust(providerTrust), expectedKeyId: providerTrust.keyId, expectedPayload: profileUnsigned });
    addCheck(results, 'E_PROVIDER_PROFILE_JWS', pv.ok, pv.code || 'Signed provider profile JWS verified.');
  }

  const proposal = exp.proposal;
  const shapeErrors = verifyProposalShape(proposal, providerTrust, profileUnsigned);
  for (const error of shapeErrors) addCheck(results, error, false, 'Proposal/profile binding failed.');
  if (!shapeErrors.length) addCheck(results, 'E_PROPOSAL_COMPLETE_BINDINGS', true, 'Provider, audience, schema, supported financial combination, and required proposal fields are present.');
  if (isObject(proposal) && signatureEnvelopeCheck(proposal.signature, providerTrust.keyId)) {
    const unsigned = structuredClone(proposal);
    delete unsigned.signature;
    const pv = verifyCompactJws({ jws: proposal.signature.jws, publicJwk: jwkPublicFromTrust(providerTrust), expectedKeyId: providerTrust.keyId, expectedPayload: unsigned });
    addCheck(results, 'E_PROPOSAL_JWS', pv.ok, pv.code || 'Provider proposal JWS verified against explicit trust key.');
  }

  const commitment = exp.commitment;
  if (isObject(proposal)) {
    const normalizedErrors = normalizedRequestProblems(exp.normalizedRequest, proposal,
      financialAgreementOf(proposal), commitment);
    for (const error of normalizedErrors) addCheck(results, error, false, 'Exported normalized request must match the signed proposal.');
    if (!normalizedErrors.length) addCheck(results, 'E_NORMALIZED_REQUEST_BINDINGS', true,
      'Request digest, financial profile, schema, capability, parties, units, and deadline match.');
  }

  const proposalDigest = isObject(proposal) ? proposalDigestOf(proposal) : null;
  if (isObject(proposal)) {
    const acceptanceErrors = verifyAcceptanceShape(exp.acceptance, proposal, proposalDigest, buyerTrust);
    for (const error of acceptanceErrors) addCheck(results, error, false, 'Acceptance contract/binding failed.');
    if (!acceptanceErrors.length) {
      const acceptanceUnsigned = structuredClone(exp.acceptance);
      delete acceptanceUnsigned.signature;
      const av = verifyCompactJws({ jws: exp.acceptance.signature.jws, publicJwk: jwkPublicFromTrust(buyerTrust), expectedKeyId: buyerTrust.keyId, expectedPayload: acceptanceUnsigned });
      addCheck(results, 'E_ACCEPTANCE_JWS', av.ok, av.code || 'Buyer acceptance JWS verified against the pinned buyer key.');
    }
  }

  const agreement = financialAgreementOf(proposal);
  const faErrors = agreementProblems(agreement);
  for (const error of faErrors) addCheck(results, error, false, 'Explicit signed financialAgreement is invalid or incomplete.');
  if (!faErrors.length) addCheck(results, 'E_FINANCIAL_AGREEMENT', true, 'Signed terms bind parties, evaluator authority, custody, chain, asset, timing, and recovery.');

  const bindingErrors = checkFinancialProposalBindings(proposal, agreement, commitment);
  for (const error of bindingErrors) addCheck(results, error, false, 'Proposal, financialAgreement, and commitment manifest disagree.');
  if (!bindingErrors.length) addCheck(results, 'E_FINANCIAL_BINDINGS', true, 'Financial terms and manifest price match.');
  addCheck(results, 'E_BUYER_AGREEMENT_TRUST', !!agreement && eqAddress(agreement.buyer, buyerTrust.address),
    'Buyer wallet identity is independently bound to the configured acceptance key.');

  let commId = null;
  let manifestDigestBytes = null;
  if (!isObject(commitment) || !normalizeBytes32(commitment.commitmentId) || !isObject(commitment.manifest)) {
    addCheck(results, 'E_COMMITMENT_SHAPE', false, 'Commitment ID/manifest missing or malformed.');
  } else {
    commId = normalizeBytes32(commitment.commitmentId);
    const manifest = commitment.manifest;
    addCheck(results, 'E_MANIFEST_ID_BINDING', normalizeBytes32(manifest.commitmentId) === commId, 'Commitment ID must match manifest ID.');
    addCheck(results, 'E_MANIFEST_REQUEST_CRITERIA', !!manifest.acceptanceCriteria && manifest.acceptanceCriteria.type === 'hash' &&
      manifest.acceptanceCriteria.value === proposal.requestDigest, 'Manifest criteria bind the normalized request digest.');
    try {
      const recomputed = buildLegacyManifestHash(manifest);
      addCheck(results, 'E_MANIFEST_HASH_RECOMPUTED', recomputed === commitment.manifestHash && recomputed === manifest.manifestHash,
        recomputed === commitment.manifestHash ? recomputed : 'Recomputed manifest-v1 hash differs from claimed digest.');
      manifestDigestBytes = digestToBytes32(recomputed);
    } catch (error) {
      addCheck(results, 'E_MANIFEST_HASH_RECOMPUTED', false, error.message);
    }
    const sr = commitment.signedRepresentation;
    const srEnvelopeOk = isObject(sr) && sr.version === SR_VERSION && sr.keyId === providerTrust.keyId && typeof sr.jws === 'string' &&
      sr.manifestHash === commitment.manifestHash && typeof sr.signedAt === 'string';
    addCheck(results, 'E_SR_VERSION_ENVELOPE', srEnvelopeOk, srEnvelopeOk ? SR_VERSION : 'Missing or mismatched v1.1 signedRepresentation.');
    if (srEnvelopeOk && isObject(proposal) && faErrors.length === 0 && agreement && proposalDigest) {
      const expectedSr = srPayloadFor({ proposal, commitment, agreement, proposalDigest });
      const srCheck = verifyCompactJws({ jws: sr.jws, publicJwk: jwkPublicFromTrust(providerTrust), expectedKeyId: providerTrust.keyId, expectedPayload: expectedSr });
      addCheck(results, 'E_SR_DECODED_FULL_MANIFEST', srCheck.ok, srCheck.code || 'Decoded JWS binds the complete manifest/proposal/evaluator payload.');
      if (sr.canonicalBytes) {
        try {
          const encodedBytes = String(sr.canonicalBytes);
          const bytes = Buffer.from(encodedBytes, 'base64');
          const normalizedBase64 = bytes.toString('base64');
          if (normalizedBase64.replace(/=+$/, '') !== encodedBytes.replace(/=+$/, '')) throw new Error('SR_CANONICAL_BYTES_ENCODING');
          addCheck(results, 'E_SR_CANONICAL_BYTES', bytes.toString('utf8') === jcs(expectedSr), 'Stored canonical bytes must exactly equal decoded full JWS payload.');
        } catch (_) {
          addCheck(results, 'E_SR_CANONICAL_BYTES', false, 'Malformed SR canonicalBytes.');
        }
      }
    }
  }

  if (!isObject(exp.funding) || !isObject(exp.release || exp.refund)) {
    addCheck(results, 'E_LIFECYCLE_SHAPE', false, 'Funding and exactly one terminal record are required.');
  }
  const kind = String(exp.kind || '');
  const isRelease = kind === 'real-sepolia-release';
  const terminal = isRelease ? exp.release : exp.refund;
  if (exp.release && exp.refund) addCheck(results, 'E_SINGLE_TERMINAL_OUTCOME', false, 'Export cannot claim both release and refund.');
  else addCheck(results, 'E_SINGLE_TERMINAL_OUTCOME', !!terminal, isRelease ? 'release' : 'refund');

  const funding = exp.funding || {};
  const declaredChain = Number(exp.chainId);
  const pinnedAssetId = 'eip155:84532/erc20:' + TEST_USDC;
  addCheck(results, 'E_EXPORT_CHAIN_ID', declaredChain === CHAIN_ID, 'Expected 84532; got ' + String(exp.chainId));
  addCheck(results, 'E_EXPORT_NETWORK', exp.network === NETWORK, String(exp.network));
  addCheck(results, 'E_EXPORT_ASSET', String(exp.asset || '').toLowerCase() === pinnedAssetId, String(exp.asset));
  addCheck(results, 'E_CUSTODY_ADDRESS_PIN', normalizeAddress(exp.custody) === CUSTODY, String(exp.custody || 'missing'));
  const declaredPin = String(exp.custodyRuntimeKeccak || '').toLowerCase();
  const custodyPin = String(exp.custodyPin || '').toLowerCase();
  addCheck(results, 'E_CUSTODY_RUNTIME_PIN', declaredPin === CUSTODY_RUNTIME_KECCAK && custodyPin === CUSTODY_RUNTIME_KECCAK && declaredPin === custodyPin,
    declaredPin + ' / ' + custodyPin + ' expected ' + CUSTODY_RUNTIME_KECCAK);
  if (agreement) {
    addCheck(results, 'E_AGREEMENT_CUSTODY_EXPORT_BINDING', normalizeAddress(agreement.custody && agreement.custody.address) === normalizeAddress(exp.custody) &&
      String(agreement.custody && agreement.custody.runtimeKeccak || '').toLowerCase() === declaredPin, 'FA custody must match export address and runtime pin.');
  }
  addCheck(results, 'E_FUNDING_CHAIN_DECLARATION', Number(funding.chainId) === CHAIN_ID, String(funding.chainId));
  addCheck(results, 'E_FUNDING_NETWORK_DECLARATION', funding.network === NETWORK, String(funding.network));
  addCheck(results, 'E_FUNDING_ASSET_DECLARATION', String(funding.asset || '').toLowerCase() === 'eip155:84532/erc20:' + TEST_USDC, String(funding.asset));
  if (terminal) {
    addCheck(results, 'E_TERMINAL_CHAIN_DECLARATION', Number(terminal.chainId) === CHAIN_ID, String(terminal.chainId));
    addCheck(results, 'E_TERMINAL_NETWORK_DECLARATION', terminal.network === NETWORK, String(terminal.network));
    addCheck(results, 'E_TERMINAL_ASSET_DECLARATION', String(terminal.asset || '').toLowerCase() === 'eip155:84532/erc20:' + TEST_USDC, String(terminal.asset));
  }
  if (agreement) {
    const asset = 'eip155:84532/erc20:' + TEST_USDC;
    addCheck(results, 'E_ALL_RECORDS_NETWORK_ASSET', proposal.terms.network === NETWORK && String(proposal.terms.asset).toLowerCase() === asset &&
      agreement.network === NETWORK && String(agreement.asset).toLowerCase() === asset && normalizeAddress(funding.token) === TEST_USDC,
      'Proposal, agreement, and funding must declare Base Sepolia test USDC.');
  }

  // A public RPC outage is INCOMPLETE, never a pass. All RPC methods used below
  // are reads: chain id, code, transaction/receipt/block, eth_call.
  let provider;
  try {
    provider = options.provider || new JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    addCheck(results, 'E_RPC_CHAIN_ID', Number(network.chainId) === CHAIN_ID, 'RPC chainId=' + String(network.chainId));
  } catch (error) {
    addIncomplete(results, 'I_RPC_UNAVAILABLE', error.message || error);
    provider = null;
  }

  if (provider) {
    try {
      const code = await provider.getCode(CUSTODY);
      const liveKeccak = keccak256(code).toLowerCase();
      addCheck(results, 'E_LIVE_CUSTODY_CODE_PIN', liveKeccak === CUSTODY_RUNTIME_KECCAK,
        liveKeccak + ' expected ' + CUSTODY_RUNTIME_KECCAK);
    } catch (error) {
      addIncomplete(results, 'I_CUSTODY_CODE_READ', error.message || error);
    }

    const fundHash = String(funding.fundTx || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(fundHash)) {
      addCheck(results, 'E_FUNDING_TX_HASH', false, 'fundTx must be a 32-byte transaction hash.');
    } else {
      try {
        const [tx, receipt] = await Promise.all([provider.getTransaction(fundHash), provider.getTransactionReceipt(fundHash)]);
        if (!tx || !receipt) {
          addIncomplete(results, 'I_FUNDING_TX_NOT_FOUND', fundHash);
        } else {
          addCheck(results, 'E_FUNDING_RECEIPT_SUCCESS', receipt.status === 1, 'status=' + String(receipt.status));
          addCheck(results, 'E_FUNDING_TX_TO_CUSTODY', normalizeAddress(tx.to) === CUSTODY && normalizeAddress(receipt.to) === CUSTODY, String(tx.to || 'contract creation'));
          const parsed = parseCallData(custodyInterface, tx);
          const expectedFund = faErrors.length === 0 && agreement && commitment && manifestDigestBytes;
          const args = parsed && parsed.name === 'fund' ? parsed.args : null;
          if (!args) {
            addCheck(results, 'E_FUNDING_CALLDATA', false, 'Transaction calldata is not custody fund(...).');
          } else if (expectedFund) {
            const terms = proposal.terms;
            const agreementDeadline = secondsFromIso(terms.deadline);
            const minRelease = BigInt(agreement.minReleaseTime);
            const exact = normalizeBytes32(argAt(args, 0, 'commitmentId')) === commId &&
              normalizeBytes32(argAt(args, 1, 'commitmentDigest')) === manifestDigestBytes &&
              normalizeAddress(argAt(args, 2, 'token')) === TEST_USDC &&
              normalizeAddress(argAt(args, 3, 'buyer')) === normalizeAddress(agreement.buyer) &&
              normalizeAddress(argAt(args, 4, 'seller')) === normalizeAddress(agreement.seller) &&
              normalizeAddress(argAt(args, 5, 'evaluator')) === normalizeAddress(agreement.evaluator.address) &&
              BigInt(argAt(args, 6, 'amount')) === BigInt(terms.amount) &&
              agreementDeadline !== null && BigInt(argAt(args, 7, 'deadline')) === agreementDeadline &&
              BigInt(argAt(args, 8, 'minReleaseTime')) === minRelease;
            addCheck(results, 'E_FUNDING_CALLDATA_BINDINGS', exact, exact ? 'All decoded fund arguments equal signed agreement/manifest.' : 'Decoded fund args differ from signed agreement/manifest.');
            addCheck(results, 'E_FUNDING_SENDER', normalizeAddress(tx.from) === normalizeAddress(agreement.buyer), String(tx.from));
            if (normalizeBytes32(funding.commitmentId) !== commId || normalizeBytes32(funding.commitmentDigest) !== manifestDigestBytes ||
                normalizeAddress(funding.token) !== TEST_USDC || normalizeAddress(funding.buyer) !== normalizeAddress(agreement.buyer) ||
                normalizeAddress(funding.seller) !== normalizeAddress(agreement.seller) || normalizeAddress(funding.evaluator) !== normalizeAddress(agreement.evaluator.address) ||
                String(funding.amount) !== String(terms.amount) || agreementDeadline === null ||
                String(funding.deadline) !== agreementDeadline.toString() || Number(funding.chainId) !== CHAIN_ID ||
                funding.network !== NETWORK || String(funding.asset || '').toLowerCase() !== 'eip155:84532/erc20:' + TEST_USDC) {
              addCheck(results, 'E_FUNDING_EXPORT_BINDINGS', false, 'Funding export fields disagree with signed agreement/manifest.');
            } else addCheck(results, 'E_FUNDING_EXPORT_BINDINGS', true, 'Funding export fields agree.');
          }

          const funded = exactEvents(receipt, custodyInterface, 'Funded', CUSTODY);
          const fundEvent = funded.find((event) => normalizeBytes32(event.args.commitmentId) === commId);
          const fundEventOk = funded.length === 1 && !!fundEvent && expectedFund &&
            normalizeBytes32(fundEvent.args.commitmentDigest) === manifestDigestBytes &&
            normalizeAddress(fundEvent.args.token) === TEST_USDC &&
            normalizeAddress(fundEvent.args.buyer) === normalizeAddress(agreement.buyer) &&
            normalizeAddress(fundEvent.args.seller) === normalizeAddress(agreement.seller) &&
            normalizeAddress(fundEvent.args.evaluator) === normalizeAddress(agreement.evaluator.address) &&
            BigInt(fundEvent.args.amount) === BigInt(proposal.terms.amount) && args &&
            BigInt(fundEvent.args.deadline) === BigInt(argAt(args, 7, 'deadline'));
          addCheck(results, 'E_FUNDING_EVENT_EXACT', fundEventOk, fundEventOk ? 'Exact Funded event from pinned custody.' : 'Missing, duplicate, or mismatched Funded event.');

          const deposits = transferEvents(receipt, TEST_USDC).filter((event) =>
            normalizeAddress(event.from) === normalizeAddress(agreement && agreement.buyer) &&
            normalizeAddress(event.to) === CUSTODY && BigInt(event.value) === BigInt(proposal && proposal.terms && proposal.terms.amount || '0'));
          addCheck(results, 'E_FUNDING_USDC_TRANSFER', deposits.length === 1,
            deposits.length === 1 ? 'One exact buyer-to-custody USDC Transfer.' : 'Expected exactly one exact buyer-to-custody transfer.');
          const balance = async (who, block) => BigInt(erc20Interface.decodeFunctionResult('balanceOf',
            await historicalCall(provider, { to: TEST_USDC, data: erc20Interface.encodeFunctionData('balanceOf', [who]) }, block))[0]);
          const [buyerBefore, buyerAfter, custodyBefore, custodyAfter] = await Promise.all([
            balance(agreement.buyer, receipt.blockNumber - 1), balance(agreement.buyer, receipt.blockNumber),
            balance(CUSTODY, receipt.blockNumber - 1), balance(CUSTODY, receipt.blockNumber)]);
          addCheck(results, 'E_FUNDING_HISTORICAL_BALANCE_DELTAS', buyerBefore - buyerAfter === BigInt(proposal.terms.amount) &&
            custodyAfter - custodyBefore === BigInt(proposal.terms.amount),
            'Block-pinned buyer/custody balance changes match this isolated transaction; aggregate custody need not be zero.');
          addCheck(results, 'E_FUNDING_CHAIN_SIGNED_TX', Number(tx.chainId) === CHAIN_ID && BigInt(tx.value) === 0n,
            'Signed transaction chain and zero native value are exact.');
          addCheck(results, 'E_FUNDING_RECEIPT_IDENTITY', String(receipt.hash).toLowerCase() === fundHash.toLowerCase() &&
            String(tx.hash).toLowerCase() === fundHash.toLowerCase() && tx.blockHash === receipt.blockHash &&
            tx.blockNumber === receipt.blockNumber, 'Transaction and receipt share the referenced hash/block.');
          const fundBlock = await provider.getBlock(receipt.blockNumber);
          const acceptedAt = Date.parse(commitment.signedRepresentation && commitment.signedRepresentation.signedAt);
          const acceptanceStart = Date.parse(exp.acceptance.notBefore), acceptanceEnd = Date.parse(exp.acceptance.notAfter);
          const proposalStart = Date.parse(proposal.issuedAt), proposalEnd = Date.parse(proposal.expires);
          const key = (profile.signingKeys || []).find(k => k.id === providerTrust.keyId);
          const timingOk = Number.isFinite(acceptedAt) && proposalStart <= acceptedAt && acceptedAt < proposalEnd &&
            acceptanceStart <= acceptedAt && acceptedAt < acceptanceEnd && key &&
            Date.parse(key.validFrom) <= acceptedAt && acceptedAt < Date.parse(key.validUntil) &&
            acceptedAt < Date.parse(profile.expires) && fundBlock && acceptedAt <= Number(fundBlock.timestamp) * 1000 + 1000 &&
            Number(fundBlock.timestamp) < Number(secondsFromIso(proposal.terms.deadline));
          addCheck(results, 'E_ACCEPTANCE_PROFILE_ISSUANCE_TIME', timingOk,
            'Authenticated SR issuance is within proposal, buyer acceptance and profile key windows, before funding/deadline.');
          const tokenDecimals = await historicalCall(provider, { to: TEST_USDC, data: erc20Interface.encodeFunctionData('decimals') }, receipt.blockNumber);
          const decodedDecimals = Number(erc20Interface.decodeFunctionResult('decimals', tokenDecimals)[0]);
          addCheck(results, 'E_ONCHAIN_USDC_DECIMALS', decodedDecimals === 6, 'decimals=' + decodedDecimals);
          if (funding.fundBlock !== undefined) addCheck(results, 'E_FUNDING_BLOCK_DECLARATION', Number(funding.fundBlock) === receipt.blockNumber, String(receipt.blockNumber));
          if (expectedFund) {
            const fundingEscrowData = await historicalCall(provider, {
              to: CUSTODY,
              data: custodyInterface.encodeFunctionData('getEscrow', [commId]),
            }, receipt.blockNumber);
            const fundingEscrow = custodyInterface.decodeFunctionResult('getEscrow', fundingEscrowData);
            const fundedStateExact = normalizeBytes32(fundingEscrow.id) === commId &&
              normalizeBytes32(fundingEscrow.digest) === manifestDigestBytes && normalizeAddress(fundingEscrow.token) === TEST_USDC &&
              normalizeAddress(fundingEscrow.buyer) === normalizeAddress(agreement.buyer) &&
              normalizeAddress(fundingEscrow.seller) === normalizeAddress(agreement.seller) &&
              normalizeAddress(fundingEscrow.evaluator) === normalizeAddress(agreement.evaluator.address) &&
              BigInt(fundingEscrow.amount) === BigInt(proposal.terms.amount) &&
              BigInt(fundingEscrow.minReleaseTime) === BigInt(agreement.minReleaseTime) &&
              BigInt(fundingEscrow.deadline) === secondsFromIso(proposal.terms.deadline) && Number(fundingEscrow.state) === 1;
            addCheck(results, 'E_ESCROW_STATE_AT_FUNDING_BLOCK', fundedStateExact,
              'Funding block must show exact Funded state and signed terms.');
          }
        }
      } catch (error) {
        if (error && error.code === 'BAD_DATA') addCheck(results, 'E_FUNDING_CALLDATA', false, 'Malformed or unrecognized custody calldata.');
        else addIncomplete(results, 'I_FUNDING_CHAIN_READ', error.message || error);
      }
    }

    if (terminal && /^0x[0-9a-fA-F]{64}$/.test(String(terminal.tx || ''))) {
      try {
        const [tx, receipt] = await Promise.all([provider.getTransaction(terminal.tx), provider.getTransactionReceipt(terminal.tx)]);
        if (!tx || !receipt) {
          addIncomplete(results, 'I_TERMINAL_TX_NOT_FOUND', terminal.tx);
        } else {
          addCheck(results, 'E_TERMINAL_RECEIPT_SUCCESS', receipt.status === 1, 'status=' + String(receipt.status));
          addCheck(results, 'E_TERMINAL_CHAIN_SIGNED_TX', Number(tx.chainId) === CHAIN_ID && BigInt(tx.value) === 0n, 'Exact signed transaction chain and native value.');
          addCheck(results, 'E_TERMINAL_RECEIPT_IDENTITY', String(tx.hash).toLowerCase() === terminal.tx.toLowerCase() &&
            String(receipt.hash).toLowerCase() === terminal.tx.toLowerCase() && tx.blockHash === receipt.blockHash &&
            tx.blockNumber === receipt.blockNumber && receipt.blockNumber > Number(funding.fundBlock),
            'Referenced transaction/receipt block identity and funding-before-terminal ordering.');
          addCheck(results, 'E_TERMINAL_TX_TO_CUSTODY', normalizeAddress(tx.to) === CUSTODY && normalizeAddress(receipt.to) === CUSTODY, String(tx.to || 'contract creation'));
          if (terminal.block !== undefined) addCheck(results, 'E_TERMINAL_BLOCK_DECLARATION', Number(terminal.block) === receipt.blockNumber, String(receipt.blockNumber));
          const parsed = parseCallData(custodyInterface, tx);
          const desiredAction = isRelease ? 'release' : 'refund';
          addCheck(results, 'E_TERMINAL_EXPORT_FIELDS', Number(terminal.chainId) === CHAIN_ID && terminal.network === NETWORK &&
            String(terminal.asset || '').toLowerCase() === 'eip155:84532/erc20:' + TEST_USDC,
            'Terminal record must declare exact chain and CAIP-19 asset.');
          if (!parsed || parsed.name !== desiredAction) {
            addCheck(results, 'E_TERMINAL_CALLDATA', false, 'Expected custody ' + desiredAction + '(...), got ' + (parsed && parsed.name || 'unrecognized'));
          } else if (faErrors.length === 0 && agreement && commId && manifestDigestBytes) {
            const args = parsed.args;
            const cidArg = normalizeBytes32(argAt(args, 0, 'commitmentId'));
            const digestArg = normalizeBytes32(argAt(args, 1, 'commitmentDigest'));
            addCheck(results, 'E_TERMINAL_COMMITMENT_BINDING', cidArg === commId && digestArg === manifestDigestBytes,
              cidArg + ' / ' + digestArg);
            let nonce = BigInt(argAt(args, 2, 'nonce'));
            let issuedAt = BigInt(argAt(args, 3, 'issuedAt'));
            const v = Number(argAt(args, 4, 'v'));
            const r = String(argAt(args, 5, 'r'));
            const s = String(argAt(args, 6, 's'));
            const zeroSignature = v === 0 && /^0x0{64}$/i.test(r) && /^0x0{64}$/i.test(s);
            addCheck(results, 'E_TERMINAL_MODE_LABEL', zeroSignature ? (desiredAction === 'refund' && terminal.timeout === true) :
              terminal.timeout !== true, 'Signed evaluator refund must never be represented as an unsigned timeout.');
            const signedVerdict = terminal.verdict || {};
            const block = await provider.getBlock(receipt.blockNumber);
            if (!block) addIncomplete(results, 'I_TERMINAL_BLOCK_TIMESTAMP', 'Block not available from RPC.');
            const timestamp = block ? BigInt(block.timestamp) : null;

            if (desiredAction === 'release' || !zeroSignature) {
              if (desiredAction === 'refund') {
                addCheck(results, 'E_SIGNED_REFUND_POLICY', agreement.recovery.signedRefund === true,
                  'Signed refund requires explicit permission in the financialAgreement.');
              }
              const permitted = agreement.evaluator.permittedDecisions.includes(desiredAction);
              addCheck(results, 'E_VERDICT_ACTION_PERMITTED', permitted, desiredAction);
              const recordMatches = signedVerdict.action === desiredAction &&
                String(signedVerdict.nonce) === nonce.toString() && String(signedVerdict.issuedAt) === issuedAt.toString() &&
                Number(signedVerdict.v) === v && String(signedVerdict.r).toLowerCase() === r.toLowerCase() &&
                String(signedVerdict.s).toLowerCase() === s.toLowerCase();
              addCheck(results, 'E_VERDICT_EXPORT_CALLDATA_BINDING', recordMatches, recordMatches ? 'Verdict fields equal decoded call.' : 'Verdict artifact differs from decoded call.');
              if (signedVerdict.commitmentId !== undefined) addCheck(results, 'E_VERDICT_ID_BINDING', normalizeBytes32(signedVerdict.commitmentId) === commId, String(signedVerdict.commitmentId));
              if (signedVerdict.commitmentDigest !== undefined) addCheck(results, 'E_VERDICT_DIGEST_BINDING', normalizeBytes32(signedVerdict.commitmentDigest) === manifestDigestBytes, String(signedVerdict.commitmentDigest));
              const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: CHAIN_ID, verifyingContract: CUSTODY };
              if (timestamp !== null) {
                const authErrors = verifyVerdictAuthorization({ verdict: signedVerdict,
                  evaluator: agreement.evaluator.address, permittedDecisions: agreement.evaluator.permittedDecisions,
                  action: desiredAction, commitmentId: commId, commitmentDigest: manifestDigestBytes,
                  blockTimestamp: timestamp, custody: CUSTODY });
                addCheck(results, 'E_COMPLETE_VERDICT_AUTHORIZATION', authErrors.length === 0, authErrors.join(', ') || 'Exact signed authority/struct/time checks pass.');
              }
              addCheck(results, 'E_VERDICT_DECLARED_DOMAIN', !!signedVerdict.domain && jcs(signedVerdict.domain) === jcs(domain) &&
                jcs(signedVerdict.types) === jcs(VERDICT_TYPES) && signedVerdict.primaryType === 'EscrowVerdict',
                'Export must state exactly the deployed-contract domain, primary type and struct.');
              const chainDomain = custodyInterface.decodeFunctionResult('domainSeparator', await historicalCall(provider,
                { to: CUSTODY, data: custodyInterface.encodeFunctionData('domainSeparator') }, receipt.blockNumber))[0];
              const contractChain = custodyInterface.decodeFunctionResult('chainId', await historicalCall(provider,
                { to: CUSTODY, data: custodyInterface.encodeFunctionData('chainId') }, receipt.blockNumber))[0];
              const typeHash = custodyInterface.decodeFunctionResult('VERDICT_TYPEHASH', await historicalCall(provider,
                { to: CUSTODY, data: custodyInterface.encodeFunctionData('VERDICT_TYPEHASH') }, receipt.blockNumber))[0];
              addCheck(results, 'E_DEPLOYED_EIP712_DOMAIN_STRUCT', chainDomain === TypedDataEncoder.hashDomain(domain) &&
                Number(contractChain) === CHAIN_ID && typeHash === keccak256(Buffer.from(
                  'EscrowVerdict(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt)')),
                'On-chain domain separator, constructor chain and type hash match the independent decoder.');
              try {
                const signature = { v, r, s };
                const signer = verifyTypedData(domain, VERDICT_TYPES, {
                  commitmentId: commId,
                  commitmentDigest: manifestDigestBytes,
                  action: desiredAction,
                  nonce,
                  issuedAt,
                }, signature);
                addCheck(results, 'E_VERDICT_EIP712_SIGNER', normalizeAddress(signer) === normalizeAddress(agreement.evaluator.address), signer);
              } catch (error) {
                addCheck(results, 'E_VERDICT_EIP712_SIGNER', false, error.message || error);
              }
              if (timestamp !== null) {
                const valid = issuedAt <= timestamp + 120n && timestamp <= issuedAt + 300n;
                addCheck(results, 'E_VERDICT_BLOCK_TIME_WINDOW', valid,
                  'issuedAt=' + issuedAt + ' blockTimestamp=' + timestamp + ' expected issuedAt<=timestamp+120 and timestamp<=issuedAt+300');
              }
              const usedData = await historicalCall(provider, {
                to: CUSTODY,
                data: custodyInterface.encodeFunctionData('usedVerdictNonce', [nonce]),
              }, receipt.blockNumber);
              const consumed = custodyInterface.decodeFunctionResult('usedVerdictNonce', usedData)[0] === true;
              addCheck(results, 'E_VERDICT_NONCE_CONSUMED', consumed, 'nonce=' + nonce + ' at terminal block');
              const unusedData = await historicalCall(provider, { to: CUSTODY,
                data: custodyInterface.encodeFunctionData('usedVerdictNonce', [nonce]) }, receipt.blockNumber - 1);
              addCheck(results, 'E_VERDICT_NONCE_UNUSED_BEFORE', custodyInterface.decodeFunctionResult('usedVerdictNonce', unusedData)[0] === false,
                'Consumption is checked before and after; it is not standalone proof of action.');
            } else {
              const recoveryAllowed = desiredAction === 'refund' && agreement.recovery.timeoutRefund === true;
              const deadline = secondsFromIso(proposal.terms.deadline);
              addCheck(results, 'E_TIMEOUT_REFUND_POLICY', recoveryAllowed && timestamp !== null && timestamp >= deadline,
                'zero-signature timeout path requires signed policy permission and block timestamp >= funded deadline');
              const artifactSaysTimeout = terminal.timeout === true || signedVerdict.timeout === true || signedVerdict.kind === 'timeout';
              addCheck(results, 'E_TIMEOUT_REFUND_EXPLICIT', artifactSaysTimeout, 'Export must explicitly label zero-signature timeout refund.');
              if (signedVerdict.v !== undefined || signedVerdict.r !== undefined || signedVerdict.s !== undefined) {
                addCheck(results, 'E_TIMEOUT_ZERO_SIGNATURE', Number(signedVerdict.v || 0) === 0 && /^0x0{64}$/i.test(String(signedVerdict.r || '0x' + '00'.repeat(32))) &&
                  /^0x0{64}$/i.test(String(signedVerdict.s || '0x' + '00'.repeat(32))), 'Export signature fields must be all zero.');
              }
            }

            const eventName = desiredAction === 'release' ? 'Released' : 'Refunded';
            const terminalEvents = exactEvents(receipt, custodyInterface, eventName, CUSTODY);
            const event = terminalEvents.find((entry) => normalizeBytes32(entry.args.commitmentId) === commId);
            const recipient = desiredAction === 'release' ? agreement.seller : agreement.buyer;
            const verdictHash = solidityPackedKeccak256(['uint8', 'bytes32', 'bytes32'], [v, r, s]).toLowerCase();
            const eventExact = terminalEvents.length === 1 && !!event && normalizeAddress(event.args[1]) === normalizeAddress(recipient) &&
              BigInt(event.args.amount) === BigInt(proposal.terms.amount) && String(event.args.verdictHash).toLowerCase() === verdictHash;
            addCheck(results, 'E_TERMINAL_EVENT_EXACT', eventExact, eventExact ? eventName + ' event exactly binds recipient/amount/verdict hash.' : 'Missing, duplicate, or mismatched terminal event.');
            const transfers = transferEvents(receipt, TEST_USDC).filter((entry) =>
              normalizeAddress(entry.from) === CUSTODY && normalizeAddress(entry.to) === normalizeAddress(recipient) &&
              BigInt(entry.value) === BigInt(proposal.terms.amount));
            addCheck(results, 'E_TERMINAL_USDC_TRANSFER', transfers.length === 1,
              transfers.length === 1 ? 'One exact custody-to-beneficiary USDC Transfer.' : 'Expected exactly one exact custody-to-beneficiary transfer.');
            const balance = async (who, block) => BigInt(erc20Interface.decodeFunctionResult('balanceOf',
              await historicalCall(provider, { to: TEST_USDC, data: erc20Interface.encodeFunctionData('balanceOf', [who]) }, block))[0]);
            const [recipientBefore, recipientAfter, custodyBefore, custodyAfter] = await Promise.all([
              balance(recipient, receipt.blockNumber - 1), balance(recipient, receipt.blockNumber),
              balance(CUSTODY, receipt.blockNumber - 1), balance(CUSTODY, receipt.blockNumber)]);
            addCheck(results, 'E_TERMINAL_HISTORICAL_BALANCE_DELTAS', recipientAfter - recipientBefore === BigInt(proposal.terms.amount) &&
              custodyBefore - custodyAfter === BigInt(proposal.terms.amount),
              'Recipient and custody deltas are read from public historical state, not declared before/after balances.');

            const escrowData = await historicalCall(provider, {
              to: CUSTODY,
              data: custodyInterface.encodeFunctionData('getEscrow', [commId]),
            }, receipt.blockNumber);
            const escrow = custodyInterface.decodeFunctionResult('getEscrow', escrowData);
            const expectedState = desiredAction === 'release' ? 3 : 4;
            const stateExact = normalizeBytes32(escrow.id) === commId && normalizeBytes32(escrow.digest) === manifestDigestBytes &&
              normalizeAddress(escrow.token) === TEST_USDC && normalizeAddress(escrow.buyer) === normalizeAddress(agreement.buyer) &&
              normalizeAddress(escrow.seller) === normalizeAddress(agreement.seller) && normalizeAddress(escrow.evaluator) === normalizeAddress(agreement.evaluator.address) &&
              BigInt(escrow.amount) === BigInt(proposal.terms.amount) && BigInt(escrow.minReleaseTime) === BigInt(agreement.minReleaseTime) &&
              BigInt(escrow.deadline) === secondsFromIso(proposal.terms.deadline) &&
              Number(escrow.state) === expectedState &&
              BigInt(desiredAction === 'release' ? escrow.releasedAt : escrow.refundedAt) === timestamp;
            addCheck(results, 'E_ESCROW_STATE_AT_TERMINAL_BLOCK', stateExact,
              'state=' + String(escrow.state) + ' expected=' + expectedState + ' with all agreement bindings.');
            const beforeData = await historicalCall(provider, { to: CUSTODY,
              data: custodyInterface.encodeFunctionData('getEscrow', [commId]) }, receipt.blockNumber - 1);
            const beforeState = custodyInterface.decodeFunctionResult('getEscrow', beforeData);
            addCheck(results, 'E_TERMINAL_PRIOR_STATE', Number(beforeState.state) === 1 &&
              (desiredAction !== 'release' || timestamp >= BigInt(beforeState.minReleaseTime)),
              'Pre-terminal Funded state and minimum release time match.');
            if (!zeroSignature) {
              for (const item of verifyFulfillment(exp, agreement, commId, manifestDigestBytes, desiredAction, timestamp)) results.push(item);
            }
          }
        }
      } catch (error) {
        if (error && error.code === 'BAD_DATA') addCheck(results, 'E_TERMINAL_CALLDATA', false, 'Malformed or unrecognized custody calldata.');
        else addIncomplete(results, 'I_TERMINAL_CHAIN_READ', error.message || error);
      }
    } else if (terminal) {
      addCheck(results, 'E_TERMINAL_TX_HASH', false, 'Terminal tx must be a 32-byte hash.');
    }
  }

  const failed = results.some((result) => result.status === 'FAIL');
  const incomplete = results.some((result) => result.status === 'INCOMPLETE');
  const verdict = failed ? 'NOT VERIFIED' : incomplete ? 'INCOMPLETE' : 'VERIFIED';
  if (provider && !options.provider) provider.destroy();
  return { verdict, checks: results };
}

async function runSelfTests() {
  const assert = require('node:assert/strict');
  let passed = 0;
  function test(name, fn) {
    fn();
    passed += 1;
    console.log('PASS ' + name);
  }
  test('JCS sorts object keys', () => assert.equal(jcs({ z: 1, a: 2 }), '{"a":2,"z":1}'));
  test('JCS rejects non-finite numeric values', () => assert.throws(() => jcs({ n: Infinity }), /JCS_NON_FINITE_NUMBER/));
  test('legacy manifest-v1 hash recomputes', () => {
    const manifest = {
      commitmentId: '0x' + '11'.repeat(32), buyerAgentId: '0x' + '22'.repeat(20), sellerAgentId: 'provider',
      capability: 'audit', price: { amount: '125', currency: 'USDC', decimals: 6 },
      acceptanceCriteria: { type: 'hash', value: 'sha256:' + '33'.repeat(32) }, deadline: '2030-01-01T00:00:00Z',
      cancelCondition: 'refund', signature: 'COSE_Sign1:0x' + '00'.repeat(65),
    };
    assert.match(buildLegacyManifestHash(manifest), /^sha256:[0-9a-f]{64}$/);
  });
  const completeAgreement = {
    schemaVersion: 'saax-financial-agreement-v1', network: NETWORK, chainId: CHAIN_ID,
    asset: 'eip155:84532/erc20:' + TEST_USDC,
    buyer: '0x' + '11'.repeat(20), seller: '0x' + '22'.repeat(20),
    evaluator: { address: '0x' + '33'.repeat(20), permittedDecisions: ['release', 'refund'] },
    custody: { address: CUSTODY, runtimeKeccak: CUSTODY_RUNTIME_KECCAK },
    token: { address: TEST_USDC, symbol: 'USDC', decimals: 6 }, minReleaseTime: '0',
    recovery: { signedRefund: true, timeoutRefund: true, refundBeneficiary: 'buyer' },
  };
  test('complete pinned financialAgreement accepted', () => assert.deepEqual(agreementProblems(completeAgreement), []));
  test('wrong agreement chain fails with exact failure code', () => {
    assert.ok(agreementProblems({ ...completeAgreement, chainId: 1 }).includes('FA_CHAIN_ID'));
  });
  test('missing explicit agreement fails with exact failure code', () => assert.deepEqual(agreementProblems(null), ['FA_MISSING']));
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const payload = { action: 'control', count: 7 };
  const protectedPart = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'fixture-kid' })).toString('base64url');
  const payloadPart = Buffer.from(jcs(payload)).toString('base64url');
  const signaturePart = crypto.sign(null, Buffer.from(protectedPart + '.' + payloadPart), pair.privateKey).toString('base64url');
  const fixtureJws = protectedPart + '.' + payloadPart + '.' + signaturePart;
  test('positive JWS control verifies', () => assert.equal(verifyCompactJws({ jws: fixtureJws, publicJwk, expectedKeyId: 'fixture-kid', expectedPayload: payload }).ok, true));
  test('tampered JWS payload fails exact signature', () => {
    const tampered = protectedPart + '.' + Buffer.from('{"action":"tampered","count":7}').toString('base64url') + '.' + signaturePart;
    assert.equal(verifyCompactJws({ jws: tampered, publicJwk, expectedKeyId: 'fixture-kid', expectedPayload: payload }).code, 'JWS_SIGNATURE_INVALID');
  });
  test('wrong pinned kid has exact failure code', () => assert.equal(verifyCompactJws({ jws: fixtureJws, publicJwk, expectedKeyId: 'other-kid', expectedPayload: payload }).code, 'JWS_KID_MISMATCH'));
  test('wrong expected document fails payload binding', () => assert.equal(verifyCompactJws({ jws: fixtureJws, publicJwk, expectedKeyId: 'fixture-kid', expectedPayload: { action: 'control' } }).code, 'JWS_PAYLOAD_MISMATCH'));
  test('trust file forbids a private JWK', () => {
    const result = checkTrustSchema({
      provider: { providerId: 'https://provider.test/', keyId: 'fixture-kid', publicJwk: { ...publicJwk, d: 'private' } },
      buyer: { address: '0x' + '11'.repeat(20), keyId: 'fixture-kid', publicJwk },
    });
    assert.deepEqual(result, ['TRUST_PROVIDER_ENTRY']);
  });
  test('manifest provider identity mismatch has exact failure code', () => {
    const proposal = { provider: { providerId: 'https://provider.test/' }, terms: {}, audience: {} };
    const manifest = { sellerAgentId: 'https://attacker.test/' };
    assert.ok(checkFinancialProposalBindings(proposal, null, { manifest }).includes('MANIFEST_PROVIDER_BINDING'));
  });
  test('signed custody escrow uses rail x402 with mode escrow', () => {
    const agreement = {
      schemaVersion: 'saax-financial-agreement-v1', network: NETWORK, chainId: CHAIN_ID,
      asset: 'eip155:84532/erc20:' + TEST_USDC, buyer: '0x' + '11'.repeat(20), seller: '0x' + '22'.repeat(20),
      evaluator: { address: '0x' + '33'.repeat(20), permittedDecisions: ['release', 'refund'] },
      custody: { address: CUSTODY, runtimeKeccak: CUSTODY_RUNTIME_KECCAK },
      token: { address: TEST_USDC, symbol: 'USDC', decimals: 6 }, minReleaseTime: '0',
      recovery: { signedRefund: true, timeoutRefund: true, refundBeneficiary: 'buyer' },
    };
    const proposal = { terms: { network: NETWORK, asset: agreement.asset, rail: 'x402', mode: 'escrow',
      currency: 'USDC', decimals: 6, amount: '5000', policies: { financialAgreement: agreement } },
      audience: { buyer: agreement.buyer }, provider: { providerId: 'https://provider.test/' } };
    const manifest = { buyerAgentId: agreement.buyer, sellerAgentId: 'https://provider.test/',
      price: { amount: '5000', currency: 'USDC', decimals: 6 } };
    assert.equal(checkFinancialProposalBindings(proposal, agreement, { manifest }).includes('PROPOSAL_ESCROW_MODE'), false);
    assert.ok(checkFinancialProposalBindings({ ...proposal, terms: { ...proposal.terms, mode: 'x402' } }, agreement,
      { manifest }).includes('PROPOSAL_ESCROW_MODE'));
  });
  test('v1 export is INCOMPLETE and cannot be VERIFIED', async () => {
    const result = await verifyExport({ formatVersion: 'discovery-financial-v1' }, {
      provider: { providerId: 'https://example.test', keyId: 'fixture-kid', publicJwk },
      buyer: { address: '0x' + '11'.repeat(20), keyId: 'fixture-kid', publicJwk },
    });
    assert.equal(result.verdict, 'INCOMPLETE');
    assert.equal(result.checks[0].code, 'E_OLD_FORMAT_INCOMPLETE');
  });
  console.log('SELF-TESTS: ' + passed + ' passed, 0 failed');
}

async function main(argv) {
  if (argv.includes('--self-test')) {
    await runSelfTests();
    return 0;
  }
  const exportPath = argv.find((arg) => !arg.startsWith('--'));
  const trustArg = argv.find((arg) => arg.startsWith('--trust='));
  const rpcArg = argv.find((arg) => arg.startsWith('--rpc='));
  const expectReject = argv.includes('--expect-reject');
  const expectIncomplete = argv.includes('--expect-incomplete');
  if (!exportPath || !trustArg) {
    console.error('usage: node verifier/verify-financial-export.js <export.json> --trust=<trust.json> [--rpc=https://sepolia.base.org] [--json]');
    return 2;
  }
  let exp;
  let trust;
  try {
    exp = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    trust = JSON.parse(fs.readFileSync(trustArg.slice('--trust='.length), 'utf8'));
  } catch (error) {
    console.error('VERDICT: NOT VERIFIED');
    console.error('E_INPUT_READ: ' + (error.message || error));
    return 1;
  }
  const result = await verifyExport(exp, trust, rpcArg ? rpcArg.slice('--rpc='.length) : DEFAULT_RPC);
  if (argv.includes('--json')) { console.log(JSON.stringify(result, null, 2));
    return result.verdict === 'VERIFIED' ? 0 : 1; }
  console.log('export: ' + exportPath);
  for (const check of result.checks) {
    const label = check.status === 'PASS' ? '[PASS]' : check.status === 'FAIL' ? '[FAIL]' : '[INCOMPLETE]';
    console.log(label + ' ' + check.code + (check.detail ? ' [' + check.detail + ']' : ''));
  }
  console.log('checks: ' + result.checks.length + ', failed: ' + result.checks.filter((check) => check.status === 'FAIL').length +
    ', incomplete: ' + result.checks.filter((check) => check.status === 'INCOMPLETE').length);
  console.log('VERDICT: ' + result.verdict);
  if (expectReject) return result.verdict === 'NOT VERIFIED' ? 0 : 1;
  if (expectIncomplete) return result.verdict === 'INCOMPLETE' ? 0 : 1;
  return result.verdict === 'VERIFIED' ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error('VERDICT: NOT VERIFIED');
    console.error('E_VERIFIER_INTERNAL: ' + (error && error.stack || error));
    process.exitCode = 1;
  });
}

module.exports = {
  CHAIN_ID,
  CUSTODY,
  CUSTODY_RUNTIME_KECCAK,
  TEST_USDC,
  jcs,
  proposalDigestOf,
  termsDigestOf,
  verifyCompactJws,
  agreementProblems,
  buildLegacyManifestHash,
  checkTrustSchema,
  verifyExport,
};
