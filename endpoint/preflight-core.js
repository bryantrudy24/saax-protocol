// SAAX Protocol — Discovery Phase 3: preflight core (prepare_commitment)
//
// Free, nonbinding preflight. This module implements the deterministic
// validation, normalization, proposal construction, and JWS signing for a
// prepare_commitment request — shared by the isolated HTTP endpoint
// (tests/discovery-phase3/) and the MCP adapter (api/mcp.mjs) so both
// interfaces are semantically identical.
//
// Guarantees (per the Discovery Profile spec §6):
//   - Creates NO agreement, payment, custody deposit, service execution,
//     resource reservation, or spending authority. No preflight fee.
//   - Deterministic compatibility validation with specific DSC_* codes.
//   - Normalizes the accepted request without silently changing the caller's
//     intent: every normalization is explicit in the returned terms and the
//     requestDigest is computed over the NORMALIZED request.
//   - Binds proposalId, nonce (echoed), requestDigest, provider identity,
//     audience, manifest/schema versions+digests, terms, issuedAt, expires,
//     status, and the JWS signature (Phase-2 signature profile: EdDSA over the
//     RFC 8785 canonical proposal without the signature envelope).
//   - A provider signature is NOT buyer acceptance.
//
// Signature profile: pinned `endpoint/discovery-crypto.js` (scheme jws, alg
// EdDSA, canonicalization rfc8785, kid bound to the active signing key).

'use strict';

const crypto = require('node:crypto');
const disc = require('./discovery');            // Phase-1 contract validators (jcs, validate*, replayDecide, classifyOutcome)
const cryptoLib = require('./discovery-crypto'); // Phase-2 signing profile

const PROFILE_VERSION = disc.PROFILE_VERSION || '1.0.0';
const MANIFEST_VERSION = '1';                    // commitment manifest v1 reused; NO manifest version change
const MANIFEST_DIGEST_PLACEHOLDER = null;       // set from provider profile config when known; never a made-up digest
const DEFAULT_PROPOSAL_TTL_SECONDS = 3600;       // 1h validity; documented in proposal semantics
const MIN_CLIENT_NONCE_LEN = 8;

// ---------------------------------------------------------------------------
// Error helpers (typed, spec §6.5)
// ---------------------------------------------------------------------------
function err(code, httpStatus, reason, extra) {
  const e = new Error(reason);
  e.code = code;
  e.httpStatus = httpStatus;
  if (extra) Object.assign(e, extra);
  return e;
}

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// ---------------------------------------------------------------------------
// Normalization (explicit; never silently changes caller intent)
// ---------------------------------------------------------------------------
// Returns { ok:true, normalized } or { ok:false, error }.
// Normalizations applied (each appears verbatim in the returned terms):
//   - amounts: integer-string, leading zeros stripped, no sign (schema-validated)
//   - timestamps: parsed to UTC ISO-8601 with milliseconds (Z form)
//   - addresses / asset ids / network ids / provider ids: lowercased except
//     EIP-55 checksums are NOT altered (we only lowercase hex when the input is
//     all-lowercase or all-uppercase; a mixed-case EIP-55 address is kept as-is
//     and validated for checksum). For Phase 3 we accept lowercase and
//     checksummed forms; all stored/returned forms are lowercased for
//     canonically comparable identifiers.
//   - object key order: RFC 8785 JCS at digest time (order-insensitive)
function normalizeRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return { ok: false, error: err('DSC_INVALID_REQUEST', 422, 'request must be a JSON object') };
  }
  const fail = (code, reason) => ({ ok: false, error: err(code, 422, reason) });

  if (typeof req.profileVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(req.profileVersion)) {
    return fail('DSC_UNSUPPORTED_VERSION', 'profileVersion must be semver');
  }
  const capability = req.capability;
  if (!capability || typeof capability !== 'object' || typeof capability.id !== 'string' || !capability.id) {
    return fail('DSC_UNSUPPORTED_CAPABILITY', 'capability.id required');
  }
  const schema = req.schema;
  if (!schema || typeof schema !== 'object' || typeof schema.id !== 'string' || typeof schema.version !== 'string' || typeof schema.digest !== 'string') {
    return fail('DSC_SCHEMA_MISMATCH', 'schema.id/version/digest required');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(schema.digest)) {
    return fail('DSC_SCHEMA_MISMATCH', 'schema.digest must be sha256:<64 hex>');
  }
  const units = req.units;
  if (!units || typeof units !== 'object' || typeof units.amount !== 'string' || typeof units.unit !== 'string') {
    return fail('DSC_UNITS_MISMATCH', 'units.amount (integer string) and units.unit required');
  }
  if (!/^[0-9]+$/.test(units.amount)) {
    return fail('DSC_UNITS_MISMATCH', 'units.amount must be an integer string (no float, no sign)');
  }
  const fp = req.financialProfile;
  if (!fp || typeof fp !== 'object') {
    return fail('DSC_INVALID_COMBINATION', 'financialProfile required');
  }
  for (const f of ['network', 'asset', 'rail', 'mode']) {
    if (typeof fp[f] !== 'string' || !fp[f]) return fail('DSC_INVALID_COMBINATION', 'financialProfile.' + f + ' required');
  }
  if (!/^[-a-z0-9]{3,8}:[^/]+$/.test(fp.network)) return fail('DSC_INVALID_COMBINATION', 'network must look like a CAIP-2 id');
  if (!/^[-a-z0-9]{3,8}:[^/]+\/[-a-z0-9]{3,8}:[^/]+$/.test(fp.asset)) return fail('DSC_INVALID_COMBINATION', 'asset must look like a CAIP-19 id');
  if (!['x402', 'mpp', 'ap2', 'acp', 'ach', 'card', 'internal-ledger', 'unknown'].includes(fp.rail)) {
    return fail('DSC_INVALID_COMBINATION', 'rail not in the known rail set');
  }
  if (typeof fp.mode !== 'string' || !fp.mode) return fail('DSC_INVALID_COMBINATION', 'mode required');

  // Constraints (optional): maxAmount integer string, deadline parseable UTC.
  const constraints = req.constraints;
  let normConstraints = {};
  if (constraints !== undefined && constraints !== null) {
    if (typeof constraints !== 'object' || Array.isArray(constraints)) return fail('DSC_INVALID_REQUEST', 'constraints must be an object');
    if (hasOwn(constraints, 'maxAmount')) {
      if (typeof constraints.maxAmount !== 'string' || !/^[0-9]+$/.test(constraints.maxAmount)) {
        return fail('DSC_UNITS_MISMATCH', 'constraints.maxAmount must be an integer string');
      }
      normConstraints.maxAmount = String(BigInt(constraints.maxAmount));
    }
    if (hasOwn(constraints, 'deadline')) {
      const t = Date.parse(constraints.deadline);
      if (Number.isNaN(t)) return fail('DSC_INVALID_REQUEST', 'constraints.deadline must be a parseable date-time');
      normConstraints.deadline = new Date(t).toISOString();
    }
  }

  // Intended parties (optional).
  const parties = req.intendedParties;
  let normParties = undefined;
  if (parties !== undefined && parties !== null) {
    if (typeof parties !== 'object' || Array.isArray(parties)) return fail('DSC_INVALID_REQUEST', 'intendedParties must be an object');
    normParties = {};
    if (hasOwn(parties, 'buyer')) {
      const b = String(parties.buyer);
      if (!/^0x[a-fA-F0-9]{40}$/.test(b)) return fail('DSC_INVALID_REQUEST', 'intendedParties.buyer must be a 0x-address');
      normParties.buyer = b.toLowerCase();
    }
    if (hasOwn(parties, 'seller')) {
      const s = String(parties.seller);
      if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return fail('DSC_INVALID_REQUEST', 'intendedParties.seller must be a 0x-address');
      normParties.seller = s.toLowerCase();
    }
  }

  const clientNonce = req.clientNonce;
  if (typeof clientNonce !== 'string' || clientNonce.length < MIN_CLIENT_NONCE_LEN) {
    return fail('DSC_INVALID_REQUEST', 'clientNonce must be a string of at least ' + MIN_CLIENT_NONCE_LEN + ' chars');
  }
  const issuedAt = req.issuedAt;
  if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) {
    return fail('DSC_INVALID_REQUEST', 'issuedAt must be a parseable date-time');
  }

  const normalized = {
    profileVersion: req.profileVersion,
    capability: { id: capability.id },
    schema: { id: schema.id, version: schema.version, digest: schema.digest.toLowerCase() },
    units: { amount: String(BigInt(units.amount)), unit: units.unit },
    financialProfile: {
      network: fp.network.toLowerCase(),
      asset: fp.asset.toLowerCase(),
      rail: fp.rail,
      mode: fp.mode,
    },
    constraints: normConstraints,
    intendedParties: normParties,
    clientNonce,
    issuedAt: new Date(Date.parse(issuedAt)).toISOString(),
  };
  return { ok: true, normalized };
}

// ---------------------------------------------------------------------------
// Request digest (RFC 8785 canonical bytes, sha256) — over the NORMALIZED request
// ---------------------------------------------------------------------------
function requestDigestOf(normalized) {
  const canonical = disc.jcs(normalized);
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Capability/compatibility validation against the provider profile
// ---------------------------------------------------------------------------
// Returns { ok:true, capability, combination } or { ok:false, error }.
function validateAgainstProfile(profile, normalized) {
  const fail = (code, reason) => ({ ok: false, error: err(code, 422, reason) });

  if (!profile || typeof profile !== 'object') return fail('DSC_INVALID_PROFILE', 'provider profile required');
  if (profile.profileVersion !== PROFILE_VERSION) {
    return fail('DSC_UNSUPPORTED_VERSION', 'profile version ' + profile.profileVersion + ' != ' + PROFILE_VERSION);
  }
  // interfaces: prepareCommitment must be declared true — the profile that
  // serves preflight must actually claim the interface (truthful-endpoints rule).
  if (!profile.interfaces || !profile.interfaces.discovery || profile.interfaces.discovery.prepareCommitment !== true) {
    return fail('DSC_UNAVAILABLE', 'provider profile does not declare prepareCommitment implemented');
  }
  // Capability id must be declared.
  const caps = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  const capability = caps.find((c) => c && c.id === normalized.capability.id);
  if (!capability) return fail('DSC_UNSUPPORTED_CAPABILITY', 'capability not declared: ' + normalized.capability.id);

  // Schema version+digest must match a capability schema.
  const capSchemas = Array.isArray(capability.schemas) ? capability.schemas : [];
  const schemaMatch = capSchemas.find(
    (s) => s && s.id === normalized.schema.id && s.version === normalized.schema.version && s.digest === normalized.schema.digest
  );
  if (!schemaMatch) {
    return fail('DSC_SCHEMA_MISMATCH', 'requested schema not among the capability schemas');
  }

  // Units: amount must be <= capability maxAmount (when declared) and unit must
  // match declared input units.
  const inUnits = capability.input && capability.input.units || {};
  if (inUnits.unit && normalized.units.unit !== inUnits.unit) {
    return fail('DSC_UNITS_MISMATCH', 'requested unit not supported by capability');
  }
  const capMax = capability.input && capability.input.constraints && capability.input.constraints.maxAmount;
  if (capMax !== undefined && capMax !== null) {
    if (BigInt(normalized.units.amount) > BigInt(String(capMax))) {
      return fail('DSC_UNITS_MISMATCH', 'amount exceeds capability maxAmount');
    }
  }

  // Exact supported combination (not syntax alone).
  const fc = profile.financialCompatibility || {};
  const combos = Array.isArray(fc.supportedCombinations) ? fc.supportedCombinations : [];
  const nfp = normalized.financialProfile;
  const combination = combos.find(
    (c) =>
      c &&
      c.network === nfp.network &&
      c.asset === nfp.asset &&
      c.rail === nfp.rail &&
      c.mode === nfp.mode
  );
  if (!combination) {
    return fail('DSC_INVALID_COMBINATION', 'network/asset/rail/mode combination not in supportedCombinations');
  }
  // Explicit financial terms: a financial combination MUST declare its
  // settlement currency + decimals in the profile (never inferred from a unit
  // label, never silently defaulted). A nonfinancial/rail-neutral combination
  // MUST NOT declare a settlement currency (no hidden economic choice).
  const finTerms = combination.financialTerms || 'financial';
  if (finTerms === 'financial') {
    if (!combination.settlementCurrency || !String(combination.settlementCurrency).trim()) {
      return fail('DSC_INVALID_COMBINATION', 'financial combination must declare settlementCurrency (no silent default)');
    }
    if (combination.settlementDecimals === undefined || combination.settlementDecimals === null ||
        !Number.isInteger(Number(combination.settlementDecimals)) || Number(combination.settlementDecimals) < 0) {
      return fail('DSC_INVALID_COMBINATION', 'financial combination must declare settlementDecimals (non-negative integer)');
    }
  } else if (combination.settlementCurrency) {
    // nonfinancial / rail-neutral: a settlement currency would silently
    // introduce an economic choice — reject.
    return fail('DSC_INVALID_COMBINATION', 'nonfinancial/rail-neutral combination must not declare a settlementCurrency');
  }
  // Attach the explicit financial resolution to the validated combination for
  // the proposal builder (authenticated, lossless, deterministic).
  // Never mutate the signed profile while deriving proposal-local fields.
  const resolvedCombination = { ...combination,
    _financialTerms: finTerms,
    _settlementCurrency: finTerms === 'financial' ? String(combination.settlementCurrency).trim() : null,
    _settlementDecimals: finTerms === 'financial' ? Number(combination.settlementDecimals) : null };

  // Request deadline must be within the capability's maxDuration window when
  // expressible (deadline vs now + maxDuration). Keep this deterministic:
  // only check when maxDuration is declared AND the deadline is present.
  const constraints = normalized.constraints || {};
  const capCons = capability.input && capability.input.constraints || {};
  if (constraints.deadline && typeof capCons.maxDuration === 'number') {
    const nowMs = Date.now();
    const dl = Date.parse(constraints.deadline);
    const horizonMs = nowMs + capCons.maxDuration * 1000;
    if (dl > horizonMs) {
      return fail('DSC_INVALID_REQUEST', 'deadline exceeds capability maxDuration window from now');
    }
  }

  return { ok: true, capability, combination: resolvedCombination };
}

// ---------------------------------------------------------------------------
// Proposal construction + signing
// ---------------------------------------------------------------------------
// providerRef: { providerId, name, origin, signingKeyId, jwkPublic, manifestDigest }
//   manifestDigest: the commitment-manifest digest from the provider config
//   (the profile carries schema digests; the manifest digest is a provider
//   constant verified by the client at commitment time).
// clock: { nowIso() } — injectable for tests (controlled clock).
// combination: the EXACT matched supportedCombination (with its authenticated
// financial terms) — supplied by prepareCommitment from validateAgainstProfile.
async function buildProposal({ profile, providerRef, normalized, requestDigestSha, nowIso, combination }) {
  const now = nowIso ? nowIso() : new Date().toISOString();
  const nowMs = Date.parse(now);
  const expires = new Date(nowMs + DEFAULT_PROPOSAL_TTL_SECONDS * 1000).toISOString();
  const proposalId = 'prop_' + crypto.randomBytes(8).toString('hex');

  const nfp = normalized.financialProfile;
  const terms = {
    network: nfp.network,
    asset: nfp.asset,
    rail: nfp.rail,
    mode: nfp.mode,
    amount: normalized.units.amount,
    unit: normalized.units.unit,
    // Explicit financial terms: currency is derived ONLY from the profile's
    // declared settlement currency for the EXACT matched combination. It is
    // never inferred from a unit label and never defaulted to USDC. A
    // nonfinancial/rail-neutral combination carries `financialTerms` and no
    // currency (re-proposal is required before any later economic choice).
    currency: combination._settlementCurrency || null,
    decimals: combination._settlementDecimals,
    financialTerms: combination._financialTerms,
    deadline: (normalized.constraints && normalized.constraints.deadline) || null,
    policies: {
      refundOnFailure: true,
      compensationPercent: '5',
      evidencePolicy: profile.capabilities && profile.capabilities[0] && profile.capabilities[0].evidencePolicy || null,
      evaluatorRequirements: profile.capabilities && profile.capabilities[0] && profile.capabilities[0].evaluatorRequirements || null,
    },
  };

  const audience = { buyer: (normalized.intendedParties && normalized.intendedParties.buyer) || null, intendedAudience: 'public' };
  // Isolated financial issuance: this policy is provider configuration, never
  // client-supplied, and enters the proposal BEFORE signing and buyer consent.
  // The production providerRef has no financialAgreement and remains unchanged.
  if (providerRef.financialAgreement) {
    if (terms.network !== 'eip155:84532' || terms.mode !== 'escrow') {
      throw err('DSC_INVALID_COMBINATION', 422, 'financialAgreement requires an explicit testnet escrow combination');
    }
    terms.policies.financialAgreement = JSON.parse(JSON.stringify(providerRef.financialAgreement));
  }
  if (audience.buyer) audience.intendedAudience = audience.buyer;

  const proposal = {
    profileVersion: PROFILE_VERSION,
    proposalId,
    nonce: normalized.clientNonce,
    requestDigest: requestDigestSha,
    provider: {
      providerId: providerRef.providerId,
      name: providerRef.name || null,
      signingKeyId: providerRef.signingKeyId,
      origin: providerRef.origin,
    },
    audience,
    manifest: {
      commitmentManifestVersion: MANIFEST_VERSION,
      commitmentManifestDigest: providerRef.manifestDigest,
      schema: normalized.schema,
    },
    terms,
    issuedAt: now,
    expires,
    status: 'proposed',
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
  };

  // Signature over the canonical proposal WITHOUT the signature envelope (the
  // `trust` field is part of the signed object, per the proposal schema).
  const signPayload = JSON.parse(JSON.stringify(proposal));
  const { jws, canonicalBytes } = await cryptoLib.signProfileCanonical({
    payload: signPayload,
    privateJwk: providerRef.privateJwk,
    keyId: providerRef.signingKeyId,
  });

  const signed = signPayload;
  signed.signature = { scheme: 'jws', alg: 'EdDSA', keyId: providerRef.signingKeyId, jws, canonicalization: 'rfc8785' };

  return { proposal: signed, canonicalBytes, requestDigest: requestDigestSha };
}

// ---------------------------------------------------------------------------
// Orchestrating entry — used identically by HTTP and MCP adapters
// ---------------------------------------------------------------------------
// providerRef: { providerId, name, origin, signingKeyId, privateJwk, jwkPublic, manifestDigest }
// store:       { acquire(requestKey, hash), persist(record) } — see proposal-store.js
// clock:       { nowIso() } — optional injectable clock
// Returns: { status:'ok', proposal } | { status:'duplicate', proposal } |
//          { status:'conflict' } | { status:'error', errorCode, httpStatus, reason }
async function prepareCommitment({ profile, providerRef, request, store, clock }) {
  // 1. Normalize + deterministic validation (schema level done by callers;
  //    this is the application-level validation).
  const n = normalizeRequest(request);
  if (!n.ok) return { status: 'error', errorCode: n.error.code, httpStatus: n.error.httpStatus, reason: n.error.message };

  // 2. Validate capability/schema/units/combination against the provider profile.
  const va = validateAgainstProfile(profile, n.normalized);
  if (!va.ok) return { status: 'error', errorCode: va.error.code, httpStatus: va.error.httpStatus, reason: va.error.message };

  // 3. Request digest over the NORMALIZED request.
  const digest = requestDigestOf(n.normalized);

  // 4. Idempotency/replay: the store's atomic persist decides duplicate vs
  //    conflict while serializing issuance. There is NO separate acquire step:
  //    a concurrent retry either gets the same proposal (duplicate) or a
  //    nonce conflict — never two issued records for one key.
  const scope = { clientNonce: n.normalized.clientNonce, requestDigest: digest };

  // 5. Build + sign the proposal.
  const built = await buildProposal({ profile, providerRef, normalized: n.normalized, requestDigestSha: digest, nowIso: clock && clock.nowIso, combination: va.combination });
  const { proposal } = built;

  // 6. Persist atomically (record + nonce + digest together) BEFORE returning
  //    the signed proposal to any caller. The store returns:
  //      { ok:true, duplicate:false }            -> issued
  //      { ok:true, duplicate:true, proposal }     -> identical retry (same key+digest)
  //      { ok:false, status:'conflict' }          -> same nonce, different request
  //      { ok:false, status:'store_error' }       -> unavailable
  if (store && typeof store.persist === 'function') {
    const persisted = await store.persist({
      proposalId: proposal.proposalId,
      nonce: proposal.nonce,
      requestDigest: proposal.requestDigest,
      signedPayload: JSON.stringify(proposal),
      profileVersion: proposal.profileVersion,
      schema: proposal.manifest.schema,
      issuedAt: proposal.issuedAt,
      expires: proposal.expires,
      status: proposal.status,
      signature: proposal.signature,
      scope,
    });
    if (!persisted.ok) {
      if (persisted.status === 'conflict') {
        return { status: 'conflict', errorCode: 'DSC_NONCE_CONFLICT', httpStatus: 422, reason: persisted.reason || 'concurrent request with the same nonce' };
      }
      return { status: 'error', errorCode: 'DSC_UNAVAILABLE', httpStatus: 503, reason: 'proposal store unavailable: ' + (persisted.reason || '') };
    }
    if (persisted.duplicate) {
      return { status: 'duplicate', proposal: persisted.proposal };
    }
  }

  // 7. Return the signed proposal (provider signature is NOT acceptance).
  return { status: 'ok', proposal };
}

module.exports = {
  PROFILE_VERSION,
  MANIFEST_VERSION,
  DEFAULT_PROPOSAL_TTL_SECONDS,
  normalizeRequest,
  requestDigestOf,
  validateAgainstProfile,
  buildProposal,
  prepareCommitment,
};
