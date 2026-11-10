// SAAX Protocol — Discovery Phase 4: buyer authorization + commitment creation core
//
// Connects a verified, signed preflight proposal to explicit buyer acceptance
// and creation of EXACTLY ONE authenticated SAAX commitment.
//
// Flow (spec §7.1-§7.4, made executable):
//   1. verify the provider-proposal binding (Phase-2 trust path: configured-key
//      thumbprint anchor + current profile key still active);
//   2. revalidate terms/compatibility/expiry/staleness (§7.2);
//   3. verify buyer acceptance (actual signature — the buyer authorized the
//      EXACT proposal digest + terms; caller-supplied identity is not proof);
//   4. durably accept ONCE (single decision point: acceptance-store persist);
//   5. create or reconcile the commitment (manifest v1 + provider JWS over the
//      canonical manifest+proposal binding — signedRepresentationVersion
//      "manifest-v1.1+saax-proposal-bound");
//   6. return operation + commitment record + status.
//
// Guarantees:
//   - Preflight alone NEVER authorizes spending/funding/execution (no
//     payment/custody/execution/release functions are reachable).
//   - A buyer acceptance is NOT a payment authorization or an evaluator
//     release verdict (single acceptance contract, domain-separated).
//   - No financial effects on failure (rejections happen before any persist).
//   - A proposal accepted once cannot create additional commitments through
//     new nonces unless the signed proposal declares repeatability (none do
//     in scope -> single-use, DSC_PROPOSAL_REUSED).
//
// Signature domains (domain separation):
//   - provider JWS (EdDSA, RFC 8785 canonical payload) — discovery-crypto.js
//   - buyer acceptance JWS (EdDSA, RFC 8785 canonical acceptance payload) —
//     acceptance-crypto.js (Phase-4 extension of the same profile)
//   - manifest COSE_Sign1 placeholder (historically emulated; preserved v1) —
//     commitment.js defaultSigningHook (documented: NOT real crypto)
//   - NEW signed representation wrapper (provider EdDSA JWS over canonical
//     manifest+proposal binding) — closes the "signed terms + evaluator
//     authority" gap WITHOUT changing manifest v1 (additive, explicit version)

'use strict';

const crypto = require('node:crypto');
const disc = require('./discovery');
const cryptoLib = require('./discovery-crypto');
const acceptCrypto = require('./acceptance-crypto');
const commitmentMod = require('./commitment');
const { AcceptanceStore, operationDigestOf } = require('./acceptance-store');

// jose v6+ is ESM-only — lazy dynamic import for Vercel compatibility.
let _joseT = null;
async function joseThumbprint(jwk) {
  if (!_joseT) _joseT = import('jose');
  const j = await _joseT;
  return j.calculateJwkThumbprint(jwk);
}

const PROFILE_VERSION = disc.PROFILE_VERSION || '1.0.0';
const MANIFEST_VERSION = '1';
const SIGNED_REPRESENTATION_VERSION = 'manifest-v1.1+saax-proposal-bound';
const ACCEPTANCE_SCHEMA_VERSION = 'acceptance-v1';
const DEFAULT_ACCEPTANCE_TTL_MS = 10 * 60 * 1000; // acceptance validity window (10 min)
const MAX_ACCEPTANCE_TTL_MS = 30 * 60 * 1000;     // enforce a sane upper bound

function err(code, httpStatus, reason, extra) {
  const e = new Error(reason);
  e.code = code;
  e.httpStatus = httpStatus;
  if (extra) Object.assign(e, extra);
  return e;
}

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// ---------------------------------------------------------------------------
// Revalidation (spec §7.2) — all checks BEFORE any persist
// ---------------------------------------------------------------------------
// ctx: {
//   profile,                    // current resolved provider profile (signed, trusted)
//   trustedThumbprints,         // Set of configured trusted key thumbprints
//   proposal,                   // the signed proposal (Phase-3)
//   buyerScope,                 // { buyer, scopeMaxAmount?, scopeCurrency?, scopeCapability? }
//   acceptance,                 // buyer acceptance (signed contract)
//   nowIso?,                    // controlled clock
//   requireKeyActive?           // default true: verify key not revoked/expired
// }
// Returns { ok:true, check } | { ok:false, code, reason }
async function revalidateProposal(ctx) {
  const profile = ctx.profile;
  const proposal = ctx.proposal;
  const now = ctx.nowIso ? ctx.nowIso() : new Date().toISOString();
  const nowMs = Date.parse(now);

  const fail = (code, reason) => ({ ok: false, code, reason, httpStatus: code === 'DSC_EXPIRED_PROPOSAL' ? 410 : (code === 'DSC_PROPOSAL_STALE' ? 409 : 422) });

  // 1. Provider identity through the implemented trusted-key path.
  if (!profile || typeof profile !== 'object') return fail('DSC_INVALID_PROFILE', 'current provider profile required');
  const trustedSet = Array.isArray(ctx.trustedThumbprints)
    ? new Set(ctx.trustedThumbprints.map((t) => String(t).toLowerCase()))
    : (ctx.trustedThumbprints instanceof Set ? ctx.trustedThumbprints : null);
  if (!trustedSet || trustedSet.size === 0) {
    return fail('DSC_TRUST_NOT_CONFIGURED', 'no trusted provider key configured');
  }
  const profileKey = (profile.signingKeys || [])[0];
  if (!profileKey || !profileKey.id) return fail('DSC_INVALID_PROFILE', 'profile signing key missing');
  let thumb = '';
  try { thumb = await joseThumbprint(profileKey.jwk); } catch (_) { /* fall through */ }
  thumb = (thumb || '').toLowerCase();
  if (!thumb || !trustedSet.has(thumb)) {
    return fail('DSC_UNTRUSTED_PROVIDER', 'provider signing key not in the configured trust set');
  }
  // Proposal signature must verify under the CURRENT profile key.
  const proposalCheckPayload = JSON.parse(JSON.stringify(proposal));
  delete proposalCheckPayload.signature;
  const pv = await cryptoLib.verifySignature({
    jws: proposal.signature && proposal.signature.jws,
    publicJwk: profileKey.jwk,
    expectedKeyId: proposal.signature && proposal.signature.keyId,
    expectedPayload: proposalCheckPayload,
  });
  if (!pv.ok) {
    if (pv.errorCode === 'DSC_UNSUPPORTED_ALGORITHM') return fail('DSC_UNSUPPORTED_ALGORITHM', pv.reason);
    if (pv.errorCode === 'DSC_KEY_ID_MISMATCH') return fail('DSC_PROPOSAL_STALE', 'proposal keyId does not match the current profile key (key rotated?): ' + pv.reason);
    return fail('DSC_INVALID_SIGNATURE', 'proposal signature failed: ' + pv.reason);
  }

  // 2. profileVersion equality (no downgrade).
  if (proposal.profileVersion !== profile.profileVersion) {
    return fail('DSC_PROPOSAL_STALE', 'proposal profileVersion ' + proposal.profileVersion + ' != current ' + profile.profileVersion);
  }

  // 3. Expiry under the controlled clock.
  if (!proposal.expires || Date.parse(proposal.expires) <= nowMs) {
    return fail('DSC_EXPIRED_PROPOSAL', 'proposal expired (expires ' + proposal.expires + ' < now ' + now + ')');
  }

  // 4. Capability/schema/units/financial combination still supported.
  const caps = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  // The proposal carries capability via schema id; resolve by matching declared schema.
  const capBySchema = caps.find((c) => c && Array.isArray(c.schemas) && c.schemas.some((s) => s && s.id === proposal.manifest.schema.id && s.version === proposal.manifest.schema.version && s.digest === proposal.manifest.schema.digest));
  if (!capBySchema) return fail('DSC_PROPOSAL_STALE', 'proposal schema no longer declared by the current profile');
  const combination = (profile.financialCompatibility && profile.financialCompatibility.supportedCombinations || [])
    .find((c) => c && c.network === proposal.terms.network && c.asset === proposal.terms.asset && c.rail === proposal.terms.rail && c.mode === proposal.terms.mode);
  if (!combination) return fail('DSC_INVALID_COMBINATION', 'proposal financial combination no longer in the current profile supportedCombinations');
  // Explicit financial terms revalidation: the proposal's currency/decimals/
  // financialTerms must match the CURRENT profile combination. A financial
  // proposal missing currency/decimals is rejected (no silent default); a
  // nonfinancial combination must not carry a currency (no silent economic
  // choice substituted into an accepted commitment).
  const finTerms = combination.financialTerms || 'financial';
  const propCurrency = proposal.terms.currency || null;
  const propFinTerms = proposal.terms.financialTerms || 'financial';
  if (finTerms === 'financial') {
    const wantCurrency = String(combination.settlementCurrency || '').trim();
    if (!wantCurrency) return fail('DSC_INVALID_COMBINATION', 'current profile financial combination lacks declared settlementCurrency');
    if (!propCurrency || String(propCurrency).toUpperCase() !== wantCurrency.toUpperCase()) {
      return fail('DSC_INVALID_COMBINATION', 'proposal currency ' + (propCurrency || '(none)') + ' does not match the current profile settlement currency ' + wantCurrency);
    }
    if (proposal.terms.decimals === undefined || proposal.terms.decimals === null || Number(proposal.terms.decimals) !== Number(combination.settlementDecimals)) {
      return fail('DSC_INVALID_COMBINATION', 'proposal decimals do not match the current profile settlement decimals');
    }
  } else {
    // nonfinancial / rail-neutral: no currency may be authenticated into the
    // commitment; a currency present in the proposal terms is a substitution.
    if (propCurrency) {
      return fail('DSC_INVALID_COMBINATION', 'nonfinancial/rail-neutral proposal must not carry a settlement currency (explicit re-proposal required for economic choices)');
    }
    if (propFinTerms !== finTerms) {
      return fail('DSC_INVALID_COMBINATION', 'proposal financialTerms ' + propFinTerms + ' != profile ' + finTerms + ' (term-class substitution rejected)');
    }
  }

  // 5. Manifest version+digest still declared.
  const manSchema = capBySchema.schemas.find((s) => s && s.purpose === 'commitment-manifest');
  if (!manSchema) return fail('DSC_PROPOSAL_STALE', 'current profile no longer declares a commitment-manifest schema');
  const declaredManifestDigest = manSchema.digest || null;
  if (proposal.manifest.commitmentManifestVersion !== String(MANIFEST_VERSION)) {
    return fail('DSC_PROPOSAL_STALE', 'proposal manifest version ' + proposal.manifest.commitmentManifestVersion + ' != ' + MANIFEST_VERSION);
  }
  if (declaredManifestDigest && proposal.manifest.commitmentManifestDigest !== declaredManifestDigest) {
    return fail('DSC_PROPOSAL_STALE', 'proposal manifest digest no longer matches the current profile (digest changed)');
  }

  // Buyer scope and limits (§7.2 "buyer scope and limits").
  const buyerScope = ctx.buyerScope || {};
  if (!buyerScope.buyer) return fail('DSC_UNAUTHORIZED', 'buyer scope (buyer identity) required');
  if (proposal.audience && proposal.audience.buyer && String(proposal.audience.buyer).toLowerCase() !== String(buyerScope.buyer).toLowerCase()) {
    return fail('DSC_UNAUTHORIZED', 'accepting buyer does not match the proposal audience');
  }
  if (buyerScope.scopeMaxAmount !== undefined && buyerScope.scopeMaxAmount !== null) {
    if (BigInt(proposal.terms.amount) > BigInt(String(buyerScope.scopeMaxAmount))) {
      return fail('DSC_SCOPE_EXCEEDED', 'proposal amount exceeds the buyer scope maxAmount');
    }
  }
  // Currency scope only enforces when the proposal actually declares a
  // currency in the authenticated terms (some capability profiles price in
  // units without a currency symbol — then the scope dimension is
  // uncheckable, not violated).
  if (buyerScope.scopeCurrency && proposal.terms.currency && String(proposal.terms.currency).toUpperCase() !== String(buyerScope.scopeCurrency).toUpperCase()) {
    return fail('DSC_SCOPE_MISMATCH', 'proposal currency does not match the buyer scope currency');
  }
  if (buyerScope.scopeCapability && capabilityFor(profile, proposal) && String(capabilityFor(profile, proposal).id) !== String(buyerScope.scopeCapability)) {
    return fail('DSC_SCOPE_MISMATCH', 'proposal capability does not match the buyer scope capability');
  }

  return {
    ok: true,
    check: {
      providerId: profile.providerId,
      profileVersion: profile.profileVersion,
      signingKeyId: profileKey.id,
      manifestVersion: String(MANIFEST_VERSION),
      manifestDigest: declaredManifestDigest,
      schema: proposal.manifest.schema,
      combination,
      capabilityId: capBySchema.id,
      proposalDigest: proposalDigestOf(proposal),
      checkedAt: now,
    },
  };
}

function capabilityFor(profile, proposal) {
  const caps = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  return caps.find((c) => c && Array.isArray(c.schemas) && c.schemas.some((s) => s && s.id === proposal.manifest.schema.id)) || null;
}

function proposalDigestOf(proposal) {
  const p = JSON.parse(JSON.stringify(proposal));
  delete p.signature;
  const canonical = cryptoLib.jcs(p);
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Buyer acceptance verification (actual signature — not caller-supplied identity)
// ---------------------------------------------------------------------------
// ctx.acceptance: the signed acceptance contract (acceptance-crypto.js shape)
// Returns { ok:true, verification } | { ok:false, code, reason }
async function verifyBuyerAcceptance(ctx) {
  const acceptance = ctx.acceptance;
  const proposal = ctx.proposal;
  const buyerScope = ctx.buyerScope || {};
  const now = ctx.nowIso ? ctx.nowIso() : new Date().toISOString();
  const nowMs = Date.parse(now);
  const fail = (code, reason) => ({ ok: false, code, reason, httpStatus: code === 'DSC_ACCEPTANCE_EXPIRED' ? 410 : 422 });

  if (!acceptance || typeof acceptance !== 'object') return fail('DSC_INVALID_ACCEPTANCE', 'acceptance contract required');
  if (!acceptance.schemaVersion || acceptance.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION) {
    return fail('DSC_INVALID_ACCEPTANCE', 'unsupported acceptance schemaVersion ' + acceptance.schemaVersion);
  }
  // Signature present?
  if (!acceptance.signature || !acceptance.signature.jws) return fail('DSC_INVALID_ACCEPTANCE', 'acceptance signature required');
  // Action and domain separation.
  if (acceptance.action !== 'accept_commitment') return fail('DSC_INVALID_ACCEPTANCE', 'acceptance action must be accept_commitment');
  if (!acceptance.domain || acceptance.domain !== 'saax:acceptance:v1') return fail('DSC_INVALID_ACCEPTANCE', 'acceptance domain must be saax:acceptance:v1');
  // Proposal binding.
  if (!acceptance.proposal || acceptance.proposal.proposalId !== proposal.proposalId) {
    return fail('DSC_ACCEPTANCE_MISMATCH', 'acceptance proposalId does not match the proposal');
  }
  const wantProposalDigest = proposalDigestOf(proposal);
  if (!acceptance.proposal.proposalDigest || acceptance.proposal.proposalDigest !== wantProposalDigest) {
    return fail('DSC_ACCEPTANCE_MISMATCH', 'acceptance does not commit to the exact signed proposal digest');
  }
  // Terms digest: the buyer authorized the EXACT normalized agreement/terms.
  const terms = JSON.parse(JSON.stringify(proposal.terms));
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(terms), 'utf8').digest('hex');
  if (!acceptance.termsDigest || acceptance.termsDigest !== termsDigest) {
    return fail('DSC_ACCEPTANCE_MISMATCH', 'acceptance termsDigest does not match the proposal terms');
  }
  // Buyer identity + intended provider.
  if (String(acceptance.buyer || '').toLowerCase() !== String(buyerScope.buyer || '').toLowerCase()) {
    return fail('DSC_UNAUTHORIZED', 'accepted buyer does not match the buyer scope');
  }
  if (!acceptance.provider || acceptance.provider.providerId !== proposal.provider.providerId) {
    return fail('DSC_ACCEPTANCE_MISMATCH', 'acceptance provider does not match the proposal provider');
  }
  // Audience: acceptance must be addressed to the intended provider/buyer.
  // Compare origins with trailing slashes normalized (providerId may carry a
  // trailing slash while origins do not).
  const normProvider = String(proposal.provider.providerId || '').toLowerCase().replace(/\/+$/, '');
  if (String(acceptance.audience || '').toLowerCase().replace(/\/+$/, '') !== normProvider) {
    return fail('DSC_ACCEPTANCE_MISMATCH', 'acceptance audience must be the proposal provider');
  }
  // Validity window (controlled clock).
  if (acceptance.notBefore && Date.parse(acceptance.notBefore) > nowMs) return fail('DSC_ACCEPTANCE_NOT_YET_VALID', 'acceptance not yet valid');
  if (acceptance.notAfter && Date.parse(acceptance.notAfter) <= nowMs) return fail('DSC_ACCEPTANCE_EXPIRED', 'acceptance validity window passed');
  // Nonce + replay.
  if (!acceptance.nonce || typeof acceptance.nonce !== 'string' || acceptance.nonce.length < 8) {
    return fail('DSC_INVALID_ACCEPTANCE', 'acceptance nonce required (>= 8 chars)');
  }
  // The acceptance nonce must be distinct from the proposal/request nonce (no shared space).
  if (acceptance.nonce === proposal.nonce) return fail('DSC_INVALID_ACCEPTANCE', 'acceptance nonce must differ from the proposal clientNonce');

  // Actual cryptographic verification.
  const acceptancePayload = JSON.parse(JSON.stringify(acceptance));
  delete acceptancePayload.signature;
  const ver = await acceptCrypto.verifyAcceptance({
    jws: acceptance.signature.jws,
    publicJwk: buyerScope.buyerPublicJwk,
    expectedKeyId: acceptance.signature.keyId,
    expectedPayload: acceptancePayload,
  });
  if (!ver.ok) {
    if (ver.errorCode === 'DSC_UNSUPPORTED_ALGORITHM') return fail('DSC_UNSUPPORTED_ALGORITHM', ver.reason);
    return fail('DSC_ACCEPTANCE_SIGNATURE_INVALID', 'buyer acceptance signature failed: ' + ver.reason);
  }
  if (ver.kid && acceptance.signature.keyId && ver.kid !== acceptance.signature.keyId) {
    return fail('DSC_ACCEPTANCE_SIGNATURE_INVALID', 'acceptance kid mismatch');
  }

  return {
    ok: true,
    verification: {
      acceptanceId: acceptance.acceptanceId,
      acceptanceDigest: acceptanceDigestOf(acceptance),
      keyId: acceptance.signature.keyId,
      verifiedAt: now,
    },
  };
}

function acceptanceDigestOf(acceptance) {
  const a = JSON.parse(JSON.stringify(acceptance));
  delete a.signature;
  return 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(a), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Commitment creation (manifest v1 + provider JWS over the canonical binding)
// ---------------------------------------------------------------------------
// Returns { manifest, signedRepresentation } — never triggers payment/custody/
// execution/release (does NOT call gateway.commitmentFlow, which persists to
// Supabase and mints requirement R; Phase 4 keeps commitment creation local
// and deterministic; the authorized external-anchoring path stays deferred).
async function buildCommitment({ proposal, check, buyerScope, providerRef, nowIso }) {
  const commitmentId = commitmentMod.newCommitmentId();
  const manifest = commitmentMod.buildManifest({
    commitmentId,
    buyerAgentId: String(buyerScope.buyer).toLowerCase(),
    sellerAgentId: providerRef.providerId,
    capability: check.capabilityId,
    price: {
      amount: proposal.terms.amount,
      // Explicit authenticated financial terms: the currency + decimals come
      // from the SIGNED proposal terms (derived from the profile's declared
      // settlement currency for the matched combination). NEVER silently
      // defaulted to USDC. A nonfinancial/rail-neutral proposal carries
      // financialTerms without a currency — the manifest then cannot be
      // priced and the builder rejects (explicit re-proposal required).
      currency: proposal.terms.currency,
      decimals: proposal.terms.decimals,
    },
    acceptanceCriteria: { type: 'hash', value: 'sha256:' + proposal.requestDigest.replace('sha256:', '') },
    deadline: proposal.terms.deadline || new Date(Date.parse(check.checkedAt) + 3600 * 1000).toISOString(),
    cancelCondition: 'buyer-cancel-before-delivery',
  });
  // Provider JWS over the CANONICAL MANIFEST + PROPOSAL BINDING (signed
  // representation v1.1 wrapper — real crypto closing the v1 placeholder gap).
  // NOTE: must await — signCommitmentRepresentation is async (EdDSA JWS).
  const signedRepresentation = await signCommitmentRepresentation({ manifest, proposal, providerRef, nowIso });
  return { commitmentId, manifest, signedRepresentation };
}

async function signCommitmentRepresentation({ manifest, proposal, providerRef, nowIso }) {
  const now = nowIso ? nowIso() : new Date().toISOString();
  const payload = {
    signedRepresentationVersion: SIGNED_REPRESENTATION_VERSION,
    commitmentId: manifest.commitmentId,
    proposalId: proposal.proposalId,
    proposalDigest: proposalDigestOf(proposal),
    manifestDigest: manifest.manifestHash,
    acceptanceCriteria: manifest.acceptanceCriteria,
    deadline: manifest.deadline,
    price: manifest.price,
    sellerAgentId: manifest.sellerAgentId,
    buyerAgentId: manifest.buyerAgentId,
    capability: manifest.capability,
    // Evaluator + permitted-decision authority (authenticated — closes the
    // historical omission without changing manifest v1):
    evaluator: providerRef.evaluatorRef || null,
    permittedDecisions: providerRef.permittedDecisions || null,
    // Policy versions authenticated into the wrapper (so the standalone
    // verifier can bind profileVersion + manifestVersion to the SR payload).
    profileVersion: proposal.profileVersion,
    manifestVersion: proposal.manifest && proposal.manifest.commitmentManifestVersion,
    signedAt: now,
  };
  const { jws, canonicalBytes } = await cryptoLib.signProfileCanonical({
    payload,
    privateJwk: providerRef.privateJwk,
    keyId: providerRef.signingKeyId,
  });
  return {
    version: SIGNED_REPRESENTATION_VERSION,
    keyId: providerRef.signingKeyId,
    jws,
    canonicalBytes: canonicalBytes.toString('base64'),
    signedAt: now,
    manifestHash: manifest.manifestHash,
  };
}

// ---------------------------------------------------------------------------
// Orchestrating entry — used identically by HTTP and MCP adapters
// ---------------------------------------------------------------------------
// ctx: {
//   profile, trustedThumbprints, proposal, buyerScope, acceptance,
//   providerRef,      // { providerId, name, origin, signingKeyId, privateJwk, jwkPublic, manifestDigest, evaluatorRef?, permittedDecisions? }
//   store,            // AcceptanceStore instance
//   clock?,           // { nowIso() }
//   idempotencyKey,   // caller-scoped (MCP/HTTP), opaque
//   nowIso?,
// }
// Returns:
//   { status:'ok', operation, commitment, proposal, acceptance }      (created or replayed)
//   { status:'duplicate', operation, commitment }                      (identical retry)
//   { status:'conflict' | 'reused_proposal' | 'rejected' | 'error', errorCode, httpStatus, reason, operation? }
async function acceptCommitment(ctx) {
  // Resolve the controlled clock once and thread it into every check.
  const clockFn = ctx.nowIso || (ctx.clock && ctx.clock.nowIso) || (() => new Date().toISOString());

  // 1. Revalidate (all checks before any persist).
  const rv = await revalidateProposal({ ...ctx, nowIso: clockFn });
  if (!rv.ok) return { status: 'rejected', errorCode: rv.code, httpStatus: rv.httpStatus || 422, reason: rv.reason };

  // 2. Verify buyer acceptance.
  const av = await verifyBuyerAcceptance({ ...ctx, nowIso: clockFn });
  if (!av.ok) return { status: 'rejected', errorCode: av.code, httpStatus: av.httpStatus || 422, reason: av.reason };

  // 3. Idempotency-key validation.
  const idem = ctx.idempotencyKey;
  if (!idem || typeof idem !== 'string' || idem.length < 8) {
    return { status: 'rejected', errorCode: 'DSC_INVALID_REQUEST', httpStatus: 422, reason: 'idempotencyKey required (>= 8 chars)' };
  }

  // 4. Build the operation record + commitment (local, deterministic).
  const nowIsoVal = clockFn();
  const built = await buildCommitment({ proposal: ctx.proposal, check: rv.check, buyerScope: ctx.buyerScope, providerRef: ctx.providerRef, nowIso: () => nowIsoVal });
  const operationId = 'op_' + crypto.randomBytes(8).toString('hex');
  const acceptanceRef = { acceptanceId: av.verification.acceptanceId, digest: av.verification.acceptanceDigest, keyId: av.verification.keyId };
  const record = {
    kind: 'acceptance',
    operationId,
    commitmentId: built.commitmentId,
    proposalId: ctx.proposal.proposalId,
    requestDigest: ctx.proposal.requestDigest,
    clientNonce: ctx.proposal.nonce,
    acceptedAt: nowIsoVal,
    status: 'accepted',
    profileVersion: rv.check.profileVersion,
    signingKeyId: rv.check.signingKeyId,
    manifestVersion: rv.check.manifestVersion,
    manifestDigest: rv.check.manifestDigest,
    schema: rv.check.schema,
    buyerScope: {
      buyer: String(ctx.buyerScope.buyer).toLowerCase(),
      scopeMaxAmount: ctx.buyerScope.scopeMaxAmount || null,
      scopeCurrency: ctx.buyerScope.scopeCurrency || null,
      scopeCapability: ctx.buyerScope.scopeCapability || null,
    },
    proposalDigest: rv.check.proposalDigest,
    acceptanceRef,
    commitmentRef: { manifestHash: built.manifest.manifestHash },
    signedRepresentation: built.signedRepresentation,
    idempotencyKey: idem,
    terms: ctx.proposal.terms,
  };

  // 5. Durable accept ONCE (single decision point).
  const persisted = await ctx.store.persistAcceptance(record);
  if (!persisted.ok) {
    if (persisted.status === 'conflict') {
      return { status: 'conflict', errorCode: 'DSC_NONCE_CONFLICT', httpStatus: 422, reason: persisted.reason || 'idempotencyKey reused with a different request' };
    }
    if (persisted.status === 'reused_proposal') {
      return { status: 'reused_proposal', errorCode: 'DSC_PROPOSAL_REUSED', httpStatus: 409, reason: persisted.reason || 'proposal already accepted (single-use)' };
    }
    if (persisted.status === 'store_error') {
      return { status: 'error', errorCode: 'DSC_UNAVAILABLE', httpStatus: 503, reason: 'acceptance store unavailable: ' + (persisted.reason || '') };
    }
    return { status: 'error', errorCode: 'DSC_UNAVAILABLE', httpStatus: 503, reason: 'acceptance store error' };
  }
  if (persisted.duplicate) {
    const rec = persisted.record || record;
    return {
      status: 'duplicate',
      operation: rec,
      commitment: rec.commitmentRef ? { commitmentId: rec.commitmentId, manifestHash: rec.commitmentRef.manifestHash } : null,
    };
  }

  // 6. Create the commitment (deterministic; no execution).
  //    The commitment creation IS the acceptance (the manifest is built from
  //    the authenticated terms; the provider JWS binds the canonical manifest +
  //    proposal). Status transitions to commitment_created.
  const created = await ctx.store.transition(operationId, { status: 'commitment_created', commitmentRef: { manifestHash: built.manifest.manifestHash } });
  if (!created.ok) {
    // Persist succeeded but the status transition failed — the operation is
    // durably accepted; reconcile on retry (unknown outcome explicit).
    return {
      status: 'ok',
      operation: record,
      commitment: { commitmentId: built.commitmentId, manifestHash: built.manifest.manifestHash },
      proposal: ctx.proposal,
      acceptance: ctx.acceptance,
      reconcile: true,
      warning: 'acceptance persisted; status transition deferred (reconcile on retry)',
    };
  }

  return {
    status: 'ok',
    operation: created.record,
    commitment: { commitmentId: built.commitmentId, manifestHash: built.manifest.manifestHash, manifest: built.manifest, signedRepresentation: built.signedRepresentation },
    proposal: ctx.proposal,
    acceptance: ctx.acceptance,
  };
}

module.exports = {
  PROFILE_VERSION,
  MANIFEST_VERSION,
  SIGNED_REPRESENTATION_VERSION,
  ACCEPTANCE_SCHEMA_VERSION,
  DEFAULT_ACCEPTANCE_TTL_MS,
  MAX_ACCEPTANCE_TTL_MS,
  err,
  revalidateProposal,
  verifyBuyerAcceptance,
  proposalDigestOf,
  acceptanceDigestOf,
  buildCommitment,
  signCommitmentRepresentation,
  acceptCommitment,
};
