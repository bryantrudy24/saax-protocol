// Financial handoff — authenticated, isolated Base Sepolia only.
// Deliberately async: no financial intent is emitted until the provider proposal,
// buyer acceptance and provider-signed commitment representation are verified.

'use strict';

const { ethers } = require('ethers');
const crypto = require('node:crypto');

const acceptanceCore = require('./acceptance-core.js');
const cryptoLib = require('./discovery-crypto.js');
const commitmentMod = require('./commitment.js');
const CUSTODY_ABI = require('../data/escrow-custody-build.json').abi;

const CHAIN_ID = 84532;
const NETWORK = 'eip155:84532';
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const SR_VERSION = 'manifest-v1.1+saax-proposal-bound';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^sha256:[0-9a-fA-F]{64}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const VERDICT_TYPES = {
  EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
};

function reject(errorCode, reason) { return { ok: false, errorCode, reason }; }
function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function address(value) { return typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null; }
function canonicalUsdc() { return USDC; }
function caipToChainId(network) {
  const match = /^eip155:(\d+)$/.exec(network);
  return match ? Number(match[1]) : null;
}
function caipToToken(asset) {
  const match = /^eip155:84532\/erc20:(0x[0-9a-fA-F]{40})$/.exec(asset);
  return match ? match[1].toLowerCase() : null;
}
function digestBytes32(digest) {
  if (!DIGEST.test(digest)) throw new Error('manifestHash must be sha256:<64 hex>');
  return '0x' + digest.slice(7).toLowerCase();
}
function custodyDomain(custodyAddress) {
  if (address(custodyAddress) !== CUSTODY) throw new Error('unapproved custody address');
  return { name: 'SAAX Escrow Custody V1', version: '1', chainId: CHAIN_ID, verifyingContract: CUSTODY };
}
async function resolveAndEnforceChain(provider, signedNetwork = NETWORK) {
  if (!provider || typeof provider.getNetwork !== 'function') throw new Error('chain provider required');
  if (signedNetwork !== NETWORK) throw new Error('signed network does not authorize Base Sepolia 84532');
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) throw new Error('chain ' + chainId + ' != required 84532 (Base Sepolia)');
  return chainId;
}

function srExpected(manifest, proposal, signedAt) {
  return {
    signedRepresentationVersion: SR_VERSION,
    commitmentId: manifest.commitmentId,
    proposalId: proposal.proposalId,
    proposalDigest: acceptanceCore.proposalDigestOf(proposal),
    manifestDigest: manifest.manifestHash,
    acceptanceCriteria: manifest.acceptanceCriteria,
    deadline: manifest.deadline,
    price: manifest.price,
    sellerAgentId: manifest.sellerAgentId,
    buyerAgentId: manifest.buyerAgentId,
    capability: manifest.capability,
    // The provider may declare evaluator *requirements* here; the on-chain
    // wallet and decisions come only from the signed proposal's financialAgreement.
    evaluator: null,
    permittedDecisions: null,
    profileVersion: proposal.profileVersion,
    manifestVersion: proposal.manifest.commitmentManifestVersion,
    signedAt,
  };
}

// ctx = { profile, trustedThumbprints, buyerScope, proposal?, acceptance? }.
// The first three inputs MUST come from trusted server configuration / registry,
// not commitment.handoff; proposal and acceptance may live in that container.
// No opts/env values can supply an economic field or party address.
async function validateHandoff(commitment, ctx) {
  const fail = reject;
  const embedded = commitment && commitment.handoff;
  if (!ctx || !ctx.profile || !ctx.buyerScope || !ctx.trustedThumbprints ||
      !(ctx.proposal || (embedded && embedded.proposal)) ||
      !(ctx.acceptance || (embedded && embedded.acceptance))) {
    return fail('DSC_UNAUTHENTICATED_HANDOFF', 'trusted profile/keys/buyer scope and signed proposal/acceptance required');
  }
  const { profile, buyerScope, trustedThumbprints } = ctx;
  if (!ctx.providerId || !ctx.origin || !ctx.providerKeyId || !buyerScope.buyerKeyId ||
      profile.providerId !== ctx.providerId || profile.origin !== ctx.origin) {
    return fail('DSC_UNAUTHENTICATED_HANDOFF', 'configured provider identity, origin, key ID and buyer key ID required');
  }
  const profileKey = profile.signingKeys && profile.signingKeys[0];
  const now = Date.now();
  if (!profile.signature || !profileKey || profileKey.id !== ctx.providerKeyId ||
      profile.signature.keyId !== ctx.providerKeyId || profileKey.status !== 'active' ||
      !(Date.parse(profileKey.validFrom) <= now && now < Date.parse(profileKey.validUntil)) ||
      !(now < Date.parse(profile.expires))) {
    return fail('DSC_INVALID_PROFILE', 'separately signed active testnet profile required');
  }
  const { calculateJwkThumbprint } = await import('jose');
  const actualThumbprint = await calculateJwkThumbprint(profileKey.jwk);
  if (![...trustedThumbprints].includes(actualThumbprint)) {
    return fail('DSC_UNTRUSTED_PROVIDER', 'profile key does not match exact configured thumbprint');
  }
  const profilePayload = JSON.parse(JSON.stringify(profile)); delete profilePayload.signature;
  const verifiedProfile = await cryptoLib.verifySignature({ jws: profile.signature.jws,
    publicJwk: profileKey.jwk, expectedKeyId: ctx.providerKeyId, expectedPayload: profilePayload });
  if (!verifiedProfile.ok || verifiedProfile.kid !== ctx.providerKeyId) {
    return fail('DSC_INVALID_PROFILE', 'testnet profile signature invalid');
  }
  const proposal = ctx.proposal || embedded.proposal;
  const acceptance = ctx.acceptance || embedded.acceptance;
  if (embedded && ((embedded.proposal && ctx.proposal && cryptoLib.jcs(embedded.proposal) !== cryptoLib.jcs(ctx.proposal)) ||
      (embedded.acceptance && ctx.acceptance && cryptoLib.jcs(embedded.acceptance) !== cryptoLib.jcs(ctx.acceptance)))) {
    return fail('DSC_BINDING_MISMATCH', 'embedded and external agreement artifacts differ');
  }
  const manifest = commitment && commitment.manifest;
  const sr = commitment && commitment.signedRepresentation;
  if (!manifest || !manifest.price || !sr || !BYTES32.test(manifest.commitmentId) || !DIGEST.test(manifest.manifestHash) ||
      commitment.commitmentId !== manifest.commitmentId ||
      (commitment.manifestHash && commitment.manifestHash !== manifest.manifestHash) ||
      sr.version !== SR_VERSION || !sr.jws) {
    return fail('DSC_INVALID_COMMITMENT', 'complete manifest and pinned provider-signed representation required');
  }
  let rv, av;
  try {
    rv = await acceptanceCore.revalidateProposal({ profile, trustedThumbprints, proposal, buyerScope });
    if (!rv.ok) return fail(rv.code, rv.reason);
    av = await acceptanceCore.verifyBuyerAcceptance({ proposal, acceptance, buyerScope });
    if (!av.ok) return fail(av.code, av.reason);
  } catch (error) {
    return fail('DSC_UNAUTHENTICATED_HANDOFF', 'proposal/acceptance validation failed: ' + error.message);
  }
  const terms = proposal.terms;
  if (!acceptance.signature || acceptance.signature.keyId !== buyerScope.buyerKeyId ||
      cryptoLib.jcs(acceptance.versions) !== cryptoLib.jcs({ profileVersion: proposal.profileVersion,
        manifestVersion: proposal.manifest.commitmentManifestVersion, schema: proposal.manifest.schema })) {
    return fail('DSC_ACCEPTANCE_MISMATCH', 'registered buyer key and exact acceptance versions required');
  }
  const policy = terms && terms.policies && terms.policies.financialAgreement;
  if (!policy || typeof policy !== 'object') return fail('DSC_INVALID_POLICY', 'signed financialAgreement required');
  const activeKey = profile.signingKeys && profile.signingKeys[0];
  if (!activeKey || !activeKey.id || !activeKey.jwk) return fail('DSC_UNAUTHENTICATED_HANDOFF', 'trusted provider key required');
  if (!proposal.provider || proposal.provider.providerId !== profile.providerId ||
      !proposal.audience || address(proposal.audience.buyer) !== address(policy.buyer) ||
      !acceptance.provider || acceptance.provider.providerId !== profile.providerId) {
    return fail('DSC_INVALID_PARTIES', 'signed provider identity and intended buyer must match trusted profile and policy');
  }
  if (!proposal.signature || proposal.signature.keyId !== activeKey.id ||
      proposal.provider.signingKeyId !== activeKey.id ||
      acceptance.provider.signingKeyId !== activeKey.id) {
    return fail('DSC_INVALID_SIGNATURE', 'proposal/acceptance provider key differs from trusted profile');
  }
  if (terms.network !== NETWORK || caipToChainId(terms.network) !== CHAIN_ID || policy.chainId !== CHAIN_ID) {
    return fail('DSC_WRONG_NETWORK', 'network, asset and financialAgreement must name Base Sepolia 84532');
  }
  if (caipToToken(terms.asset) !== USDC || address(policy.token && policy.token.address) !== USDC ||
      policy.asset !== terms.asset || policy.network !== NETWORK ||
      policy.token.symbol !== 'USDC' || policy.token.decimals !== 6) {
    return fail('DSC_INVALID_ASSET', 'signed CAIP-19 asset and policy token must be fixed Base Sepolia USDC');
  }
  if (terms.currency !== 'USDC' || terms.decimals !== 6 || terms.financialTerms !== 'financial' ||
      terms.unit !== 'micro-units of settlement asset') {
    return fail('DSC_INVALID_UNITS', 'explicit USDC/6/financial/micro-units terms required');
  }
  if (typeof terms.amount !== 'string' || !/^[1-9]\d*$/.test(terms.amount)) {
    return fail('DSC_INVALID_AMOUNT', 'positive integer-string atomic units required');
  }
  if (policy.schemaVersion !== 'saax-financial-agreement-v1' ||
      address(policy.custody && policy.custody.address) !== CUSTODY ||
      policy.custody.runtimeKeccak !== '0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473' ||
      !address(policy.buyer) || !address(policy.seller) || address(policy.buyer) === address(policy.seller) ||
      !address(policy.evaluator && policy.evaluator.address) ||
      policy.minReleaseTime !== '0' || !policy.recovery || policy.recovery.timeoutRefund !== true ||
      policy.recovery.signedRefund !== true || policy.recovery.refundBeneficiary !== 'buyer' ||
      !Array.isArray(policy.evaluator.permittedDecisions) ||
      policy.evaluator.permittedDecisions.length !== 2 ||
      policy.evaluator.permittedDecisions[0] !== 'release' ||
      policy.evaluator.permittedDecisions[1] !== 'refund') {
    return fail('DSC_INVALID_POLICY', 'signed custody, parties, evaluator, decisions and timeout rules must be explicit');
  }
  if (address(manifest.buyerAgentId) !== address(policy.buyer) ||
      manifest.sellerAgentId !== proposal.provider.providerId ||
      address(acceptance.buyer) !== address(policy.buyer) ||
      address(buyerScope.buyer) !== address(policy.buyer)) {
    return fail('DSC_INVALID_PARTIES', 'policy buyer and provider identity must match signed proposal/acceptance/manifest');
  }
  if (manifest.price.amount !== terms.amount || manifest.price.currency !== terms.currency ||
      manifest.price.decimals !== terms.decimals || manifest.deadline !== terms.deadline ||
      !commitmentMod.checkSpendBinding(manifest, { amount: terms.amount, currency: terms.currency }).ok) {
    return fail('DSC_SPEND_BINDING', 'manifest price/deadline differs from authenticated proposal terms');
  }
  const signatureMatch = /^COSE_Sign1:(0x[0-9a-fA-F]{130})$/.exec(manifest.signature || '');
  const expectedManifestHash = signatureMatch && 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(
    commitmentMod.coseSign1Envelope(commitmentMod.canonicManifest(manifest), signatureMatch[1]))).digest('hex');
  if (!expectedManifestHash || expectedManifestHash !== manifest.manifestHash ||
      !manifest.acceptanceCriteria || manifest.acceptanceCriteria.type !== 'hash' ||
      manifest.acceptanceCriteria.value !== proposal.requestDigest) {
    return fail('DSC_BINDING_MISMATCH', 'manifest digest or request criteria do not recompute');
  }
  if (commitment.terms && cryptoLib.jcs(commitment.terms) !== cryptoLib.jcs(terms)) {
    return fail('DSC_TERMS_MISMATCH', 'external commitment terms differ from signed proposal');
  }
  if ((commitment.proposalId && commitment.proposalId !== proposal.proposalId) ||
      (commitment.proposalDigest && commitment.proposalDigest !== rv.check.proposalDigest) ||
      (sr.keyId && sr.keyId !== activeKey.id) ||
      (sr.manifestHash && sr.manifestHash !== manifest.manifestHash)) {
    return fail('DSC_BINDING_MISMATCH', 'commitment references differ from signed representation/proposal');
  }
  // Reconstruct the complete SR payload, including its existing optional
  // evaluator requirements. Never take a financial wallet from the SR wrapper.
  const expected = srExpected(manifest, proposal, sr.signedAt);
  if (typeof sr.signedAt !== 'string' || Number.isNaN(Date.parse(sr.signedAt))) {
    return fail('DSC_INVALID_SIGNATURE', 'signed representation timestamp required');
  }
  let srPayload;
  try {
    const encoded = sr.jws.split('.')[1];
    srPayload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (_) { return fail('DSC_INVALID_SIGNATURE', 'malformed signed representation'); }
  expected.evaluator = srPayload.evaluator;
  expected.permittedDecisions = srPayload.permittedDecisions;
  // If the SR happens to name a wallet/decisions, it must not conflict with
  // the more specific signed financialAgreement. Legacy evaluatorRequirements
  // without an address are not promoted into an on-chain identity.
  if (srPayload.evaluator && own(srPayload.evaluator, 'address') &&
      address(srPayload.evaluator.address) !== address(policy.evaluator.address)) {
    return fail('DSC_INVALID_POLICY', 'signed representation evaluator conflicts with financialAgreement');
  }
  if (srPayload.permittedDecisions !== null && srPayload.permittedDecisions !== undefined &&
      cryptoLib.jcs(srPayload.permittedDecisions) !== cryptoLib.jcs(policy.evaluator.permittedDecisions)) {
    return fail('DSC_INVALID_POLICY', 'signed representation decisions conflict with financialAgreement');
  }
  const verified = await cryptoLib.verifySignature({
    jws: sr.jws, publicJwk: activeKey.jwk,
    expectedKeyId: activeKey.id, expectedPayload: expected,
  });
  if (!verified.ok || verified.kid !== activeKey.id ||
      (sr.canonicalBytes && sr.canonicalBytes !== verified.payloadBytes.toString('base64'))) {
    return fail('DSC_INVALID_SIGNATURE', 'provider signed representation failed: ' + (verified.reason || 'key/payload mismatch'));
  }
  // A verified SR may carry evaluator requirements, but not a second
  // financial agreement. Reject any duplicate fields on the SR or manifest
  // that would let a later caller mistake those for the signed policy.
  if (own(srPayload, 'financialAgreement') || own(manifest, 'financialAgreement')) {
    return fail('DSC_INVALID_POLICY', 'financialAgreement must live only in signed proposal terms');
  }
  const deadline = Date.parse(terms.deadline);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return fail('DSC_EXPIRED_TERMS', 'financial deadline must be in the future');
  return {
    ok: true,
    binding: {
      commitmentId: manifest.commitmentId.toLowerCase(),
      commitmentDigest: digestBytes32(manifest.manifestHash),
      amount: terms.amount, token: USDC, network: NETWORK,
      buyer: address(policy.buyer), seller: address(policy.seller),
      evaluator: address(policy.evaluator.address), custody: CUSTODY,
      deadline: Math.floor(deadline / 1000), minReleaseTime: policy.minReleaseTime,
      currency: terms.currency, decimals: terms.decimals,
      proposalDigest: rv.check.proposalDigest,
    },
    rail: terms.rail, mode: terms.mode,
  };
}

async function buildPaymentRequirements(commitment, ctx) {
  const result = await validateHandoff(commitment, ctx);
  if (!result.ok) return result;
  if (result.rail !== 'x402' || result.mode !== 'x402') {
    return reject('DSC_UNSUPPORTED_RAIL', 'immediate payment requires signed x402/x402 terms');
  }
  const b = result.binding;
  return { ok: true, requirements: {
    scheme: 'exact', amount: b.amount, asset: b.token,
    networkName: 'base-sepolia', network: b.network, payTo: b.seller,
    maxTimeoutSeconds: 60, reference: b.commitmentId,
    commitmentDigest: b.commitmentDigest, currency: b.currency, decimals: b.decimals,
  } };
}

async function buildEscrowFunding(commitment, ctx) {
  const result = await validateHandoff(commitment, ctx);
  if (!result.ok) return result;
  // Escrow may be chosen only when signed as such; it never piggybacks on an
  // accepted immediate-payment proposal or guesses a rail from a caller flag.
  if (result.rail !== 'x402' || result.mode !== 'escrow') return reject('DSC_UNSUPPORTED_MODE', 'signed x402 compatibility rail and explicit escrow mode required');
  const b = result.binding;
  return { ok: true, funding: {
    custody: b.custody, commitmentId: b.commitmentId, commitmentDigest: b.commitmentDigest,
    token: b.token, buyer: b.buyer, seller: b.seller, evaluator: b.evaluator,
    amount: b.amount, deadline: b.deadline, minReleaseTime: b.minReleaseTime,
  } };
}

// A verdict signature is a distinct authorization. No nonce is generated: the
// caller must supply a durable, unique nonce and coordinate replay prevention.
async function buildVerdict(commitment, action, evaluatorWallet, ctx, nonce) {
  const result = await buildEscrowFunding(commitment, ctx);
  if (!result.ok) return result;
  if (!['release', 'refund'].includes(action)) return reject('DSC_FORBIDDEN_ACTION', 'unsupported evaluator verdict');
  if (!evaluatorWallet || typeof evaluatorWallet.signTypedData !== 'function' ||
      address(evaluatorWallet.address) !== result.funding.evaluator) {
    return reject('DSC_INVALID_EVALUATOR', 'wallet must match signed evaluator address');
  }
  if (typeof nonce !== 'string' || !/^[1-9]\d*$/.test(nonce)) {
    return reject('DSC_INVALID_NONCE', 'caller must supply a positive integer-string durable nonce');
  }
  const b = result.funding;
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const rawSignature = await evaluatorWallet.signTypedData(custodyDomain(b.custody), VERDICT_TYPES, {
    commitmentId: b.commitmentId, commitmentDigest: b.commitmentDigest,
    action, nonce: BigInt(nonce), issuedAt,
  });
  const sig = ethers.Signature.from(rawSignature);
  return { ok: true, verdict: {
    custody: b.custody, commitmentId: b.commitmentId, commitmentDigest: b.commitmentDigest,
    action, nonce, issuedAt: issuedAt.toString(), v: sig.v, r: sig.r, s: sig.s, rawSignature,
  } };
}

async function readEscrow(commitment, provider, ctx) {
  const result = await buildEscrowFunding(commitment, ctx);
  if (!result.ok) return result;
  await resolveAndEnforceChain(provider);
  const b = result.funding;
  if (!provider.getCode || (await provider.getCode(b.custody)) === '0x') {
    return reject('DSC_NO_CUSTODY', 'signed custody contract code missing');
  }
  const esc = await new ethers.Contract(b.custody, CUSTODY_ABI, provider).getEscrow(b.commitmentId);
  return { ok: true, escrow: {
    commitmentId: esc[0], digest: esc[1], token: esc[2], buyer: esc[3], seller: esc[4],
    evaluator: esc[5], amount: esc[6].toString(), deadline: esc[7].toString(),
    minReleaseTime: esc[8].toString(), state: esc[9].toString(),
  }, expected: b };
}
async function verifyEscrowChainState(commitment, provider, ctx) {
  const read = await readEscrow(commitment, provider, ctx);
  if (!read.ok) return read;
  const e = read.escrow; const b = read.expected;
  if (e.state !== '1') return reject('DSC_UNFUNDED', 'escrow not currently funded (state ' + e.state + ')');
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
  if (!same(e.commitmentId, b.commitmentId) || !same(e.digest, b.commitmentDigest) ||
      !same(e.token, b.token) || !same(e.buyer, b.buyer) || !same(e.seller, b.seller) ||
      !same(e.evaluator, b.evaluator) || e.amount !== b.amount ||
      e.deadline !== String(b.deadline) || e.minReleaseTime !== String(b.minReleaseTime)) {
    return reject('DSC_FUNDING_BINDING', 'chain escrow differs from authenticated funding intent');
  }
  return { ok: true, escrow: e };
}

module.exports = {
  CHAIN_ID, NETWORK, USDC, CUSTODY, canonicalUsdc, caipToToken, caipToChainId,
  digestBytes32, custodyDomain, VERDICT_TYPES, resolveAndEnforceChain,
  validateHandoff, buildPaymentRequirements, buildEscrowFunding, buildVerdict,
  readEscrow, verifyEscrowChainState,
};
