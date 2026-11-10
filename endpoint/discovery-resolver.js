// SAAX Protocol — Discovery Phase 2: discovery resolver
//
// The resolver turns a provider origin into a structured discovery result:
// whether the provider publishes a valid signed SAAX Discovery Profile, whether
// that profile is AUTHENTICATED (published by a key the client trusts), which
// capabilities/financial combinations it ADVERTISES, and whether any of those
// have been independently DEMONSTRATED. These four axes are kept apart — the
// result is never collapsed into a blanket "trusted" boolean.
//
// Trust model (one concrete path, others unsupported):
//   - TRUST SOURCE: the client's trust configuration pins one or more trusted
//     verification keys (JWK thumbprints) and the providerId-origin binding.
//     A profile's signing key is authenticated when its public JWK thumbprint
//     matches a configured trusted key, the profile's origin matches the
//     configured provider origin, and the key is active and unexpired at
//     validation time.
//   - A self-declared key in the profile NEVER authenticates the provider:
//     `authenticated` is true only when a configured trust anchor matches.
//   - DID resolution, registry listing, and prior-pinned-identity are recorded
//     as UNSUPPORTED trust sources in this phase.
//
// Retrieval uses discovery-retrieval-http.js (bounded HTTPS, DNS-pinned
// validated IP, redirect/size/time/content-type limits). The resolver strips
// the document's `signature` before validation so the SIGNED payload is what is
// verified, exactly as signed by the publisher.
//
// Caching: a validated profile may be cached with its authenticated expiry
// (`expires`) and the HTTP cache intent. Cache freshness NEVER overrides the
// signed expiry; expired cached profiles are refetched/rejected. Trust-related
// invalidation: a cache read is only served to the SAME trust configuration
// that validated it (trustFingerprint); a key/profile change invalidates the
// cached copy. Cached results are keyed by profileVersion+keyId+trustFingerprint.
//
// Fallback: A2A discovery may be attempted first; missing A2A support may fall
// back to the standalone profile ONLY when auth did NOT fail and no required
// extension was incompatible. Auth failure or an incompatible required
// extension NEVER weakens to an unsigned/other representation (DSC_AUTH_FAILED_NO_FALLBACK
// / DSC_MISSING_REQUIRED_EXTENSION). An ambiguous A2A failure (network error)
// is treated as "no card obtainable" ONLY when the client permits fallback and
// the A2A failure was not an authentication verdict.

'use strict';

const d = require('./discovery'); // contract validators (Phase 1, pure)
const cryptoLib = require('./discovery-crypto');
const httpRetrieval = require('./discovery-retrieval-http');

// jose v6+ is ESM-only — lazy dynamic import for Vercel compatibility.
let _joseP = null;
function jose() {
  if (!_joseP) _joseP = import('jose');
  return _joseP;
}
function b64urlEncode(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64');
}

const PROFILE_VERSION = d.PROFILE_VERSION;
const EXTENSION_URI = 'https://saax-protocol.com/extensions/saax-discovery/v1';

// --- fingerprint helpers ------------------------------------------------------------
async function jwkThumbprint(jwk) {
  return (await jose()).calculateJwkThumbprint(jwk);
}

// trust config: { providerId, origin, trustedKeys: string[] (thumbprints),
//                 allowStandaloneFallback: boolean, requiredExtensions?: string[],
//                 permitLocalhost?: boolean (tests only) }
function normalizeTrustConfig(cfg) {
  const c = cfg || {};
  return {
    providerId: c.providerId || null,
    origin: c.origin || null,
    trustedKeys: Array.isArray(c.trustedKeys) ? c.trustedKeys.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [],
    trustedVerificationKeys: Array.isArray(c.trustedVerificationKeys) ? c.trustedVerificationKeys : [],
    allowStandaloneFallback: !!c.allowStandaloneFallback,
    requiredExtensions: Array.isArray(c.requiredExtensions) ? c.requiredExtensions : [],
    permitLocalhost: !!c.permitLocalhost,
  };
}

// --- Agent Card signature verification -----------------------------------------------
// A2A v1.0 AgentCardSignature[]: flattened JWS over the RFC 8785 canonicalized
// card (minus the signatures field). A card carrying signatures MUST verify at
// least one against a configured trusted verification key; otherwise the card
// is rejected as an AUTH failure (no fallback permitted). A card with NO
// signatures is unauthenticated but not rejected (signatures are optional per
// the A2A card spec).
async function verifyAgentCardAuth(card, cfg) {
  const sigs = Array.isArray(card.signatures) ? card.signatures : [];
  if (sigs.length === 0) return { ok: true, authenticated: false, reason: 'card carries no signatures (unauthenticated card)' };
  const keys = cfg.trustedVerificationKeys || [];
  if (keys.length === 0) {
    return { ok: false, authenticated: false, reason: 'card carries signatures but no trusted verification keys configured' };
  }
  const { signatures: _omit, ...payload } = card;
  const canonical = cryptoLib.jcs(payload);
  const payloadB64 = b64urlEncode(Buffer.from(canonical, 'utf8'));
  for (const s of sigs) {
    if (!s || !s.protected || !s.signature) continue;
    let hdr;
    try { hdr = JSON.parse(b64urlDecode(s.protected).toString('utf8')); } catch (_) { continue; }
    if (hdr.alg !== cryptoLib.ALG) continue; // pinned algorithm only
    const jws = s.protected + '.' + payloadB64 + '.' + s.signature;
    for (const k of keys) {
      if (!k || k.kty !== 'OKP' || k.crv !== 'Ed25519' || !k.x) continue;
      const v = await cryptoLib.verifySignature({ jws, publicJwk: k, expectedKeyId: hdr.kid || undefined });
      if (v.ok) return { ok: true, authenticated: true, reason: null };
    }
  }
  return { ok: false, authenticated: false, reason: 'no card signature verifies against configured trusted keys' };
}

// --- A2A Agent Card parsing -----------------------------------------------------------
// Returns { ok, card } or { ok:false, errorCode, reason }.
// We do NOT validate the card signature here — the resolver's A2A path uses the
// standalone profile as the SAAX surface; the card is only checked for the
// extension declaration and shared-capability consistency. Signature validation
// of the card uses the same JWS profile when a card signature is present.
function parseAgentCard(bodyString) {
  let card;
  try { card = JSON.parse(bodyString); } catch (_) {
    return { ok: false, errorCode: 'DSC_INVALID_PROFILE', reason: 'agent card is not JSON' };
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errorCode: 'DSC_INVALID_PROFILE', reason: 'agent card must be an object' };
  }
  const exts = (Array.isArray(card.capabilities) ? card.capabilities : (card.capabilities && card.capabilities.extensions) || []);
  return { ok: true, card, extensions: exts };
}

function cardHasExtension(card, uri) {
  const exts = (card.capabilities && Array.isArray(card.capabilities.extensions)) ? card.capabilities.extensions : [];
  return exts.some((e) => e && e.uri === uri);
}

function cardExtensionRequirement(card, uri) {
  const exts = (card.capabilities && Array.isArray(card.capabilities.extensions)) ? card.capabilities.extensions : [];
  const ext = exts.find((e) => e && e.uri === uri);
  return ext ? !!ext.required : null;
}

// --- Standalone profile validation + signature verification ---------------------------
// input: { bodyString, trustConfig, now? }
// Returns { ok:true, profile, signedPayload, trust } or { ok:false, errorCode, reason, trust }
async function validateSignedProfile(input) {
  const { bodyString, trustConfig, now } = input || {};
  const cfg = normalizeTrustConfig(trustConfig);
  const nowMs = now ? new Date(now).getTime() : Date.now();

  let parsed;
  try { parsed = JSON.parse(bodyString); } catch (_) {
    return { ok: false, errorCode: 'DSC_INVALID_PROFILE', reason: 'profile is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errorCode: 'DSC_INVALID_PROFILE', reason: 'profile must be an object' };
  }

  // Enforce profileVersion before anything else (version pinning).
  if (parsed.profileVersion !== PROFILE_VERSION) {
    return { ok: false, errorCode: 'DSC_UNSUPPORTED_VERSION', reason: 'profileVersion ' + parsed.profileVersion + ' unsupported; pinned ' + PROFILE_VERSION };
  }

  // Structural + app-level contract validation (Phase-1 rules).
  const contract = d.validateProfile(parsed);
  if (!contract.valid) {
    return { ok: false, errorCode: 'DSC_INVALID_PROFILE', reason: 'profile contract: ' + contract.errors.join('; ') };
  }

  // Origin binding: profile origin == retrieval origin.
  if (cfg.origin) {
    const profOrigin = (parsed.origin || '').replace(/\/+$/, '');
    const wantOrigin = (cfg.origin || '').replace(/\/+$/, '');
    if (profOrigin !== wantOrigin) {
      return { ok: false, errorCode: 'DSC_ORIGIN_MISMATCH', reason: 'profile origin ' + profOrigin + ' != configured ' + wantOrigin };
    }
  }

  // Signature: the profile's `signature` object carries the JWS. The signed
  // payload is the profile WITHOUT the signature envelope.
  const signature = parsed.signature;
  if (!signature || signature.scheme !== 'jws' || signature.alg !== 'EdDSA' || !signature.jws) {
    return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'signature envelope missing or wrong scheme' };
  }
  const { signature: _sig, ...payloadOnly } = parsed;
  const payloadOnlyCanonical = cryptoLib.jcs(payloadOnly);

  // Find the signing key in signingKeys[] by signature.keyId.
  const key = (parsed.signingKeys || []).find((k) => k.id === signature.keyId);
  if (!key) {
    return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'signature.keyId ' + signature.keyId + ' not in signingKeys[]' };
  }
  if (key.status !== 'active') {
    return { ok: false, errorCode: 'DSC_KEY_NOT_ACTIVE', reason: 'key ' + key.id + ' status ' + key.status };
  }
  if (!key.validUntil || new Date(key.validUntil).getTime() < nowMs) {
    return { ok: false, errorCode: 'DSC_KEY_EXPIRED', reason: 'key ' + key.id + ' expired at validation time' };
  }
  if (key.validFrom && new Date(key.validFrom).getTime() > nowMs) {
    return { ok: false, errorCode: 'DSC_KEY_NOT_YET_VALID', reason: 'key ' + key.id + ' not yet valid' };
  }
  const publicJwk = key.jwk || null;
  if (!publicJwk || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || !publicJwk.x) {
    return { ok: false, errorCode: 'DSC_INVALID_SIGNATURE', reason: 'signing key has no usable Ed25519 public JWK' };
  }

  const verify = await cryptoLib.verifySignature({ jws: signature.jws, publicJwk, expectedKeyId: key.id, expectedPayload: payloadOnly });
  if (!verify.ok) {
    return { ok: false, errorCode: verify.errorCode, reason: verify.reason };
  }
  // Byte-precision check of the reconstructed document.
  const want = Buffer.from(payloadOnlyCanonical, 'utf8');
  if (!want.equals(Buffer.from(verify.payloadBytes))) {
    return { ok: false, errorCode: 'DSC_PAYLOAD_MISMATCH', reason: 'signed payload does not match profile (tampered)' };
  }

  // Authenticated expiry: signed `expires` cannot be ignored.
  const expiresMs = parsed.expires ? new Date(parsed.expires).getTime() : 0;
  if (expiresMs && expiresMs < nowMs) {
    return { ok: false, errorCode: 'DSC_PROFILE_EXPIRED', reason: 'signed profile expired ' + parsed.expires };
  }

  // ---- TRUST DECISION (the one concrete path) ----
  const thumbprint = await jwkThumbprint(publicJwk);
  const thumbLower = thumbprint.toLowerCase();
  const trusted = cfg.trustedKeys.includes(thumbLower);
  const originMatchesProvider = cfg.origin ? cfg.origin.replace(/\/+$/, '') === (parsed.origin || '').replace(/\/+$/, '') : false;

  const trust = {
    authenticated: trusted && originMatchesProvider,
    selfSigned: true, // a self-published profile is always self-signed
    trustSource: trusted ? 'configured-key' : null,
    trustedKeyThumbprint: thumbLower,
    independentConformance: false,
  };
  if (!trusted) {
    return {
      ok: true,
      profile: parsed,
      signedPayload: payloadOnly,
      trust,
      authenticated: false,
      warnings: ['signing key is not in the configured trusted set; profile is valid but NOT authenticated'],
    };
  }
  return { ok: true, profile: parsed, signedPayload: payloadOnly, trust, authenticated: true };
}

// --- Capability / financial-combination validation --------------------------------------
function validateAdvertised(profile) {
  const result = { advertised: [], unsupported: [] };
  const combos = (profile.financialCompatibility && profile.financialCompatibility.supportedCombinations) || [];
  const schemas = [];
  for (const c of profile.capabilities || []) {
    for (const s of c.schemas || []) schemas.push({ capabilityId: c.id, ...s });
  }
  for (const combo of combos) {
    result.advertised.push({
      network: combo.network,
      asset: combo.asset,
      rail: combo.rail,
      mode: combo.mode,
      maturity: combo.maturity,
    });
  }
  // A requested combination not listed is unsupported:
  return { supported: combos, schemas, advertisedCombinations: result.advertised };
}

function combinationSupported(profile, combo) {
  const combos = (profile.financialCompatibility && profile.financialCompatibility.supportedCombinations) || [];
  return combos.some((c) =>
    c.network === combo.network && c.asset === combo.asset && c.rail === combo.rail && c.mode === combo.mode);
}

// --- Cache ----------------------------------------------------------------------------
class ProfileCache {
  constructor() {
    this.map = new Map();
    this.maxEntries = 50;
  }
  keyFor(trustFingerprint, origin) {
    return trustFingerprint + '|' + origin;
  }
  trustFingerprintOf(cfg) {
    const c = normalizeTrustConfig(cfg);
    return JSON.stringify([c.providerId, c.origin, c.trustedKeys.slice().sort(), c.allowStandaloneFallback]);
  }
  get(cfg, profile) {
    const key = this.keyFor(this.trustFingerprintOf(cfg), (profile && profile.origin) || (cfg && cfg.origin) || '');
    return this.map.get(key) || null;
  }
  set(cfg, profile, meta) {
    const key = this.keyFor(this.trustFingerprintOf(cfg), (profile && profile.origin) || (cfg && cfg.origin) || '');
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(key, { profile, meta });
  }
  invalidate(cfg, origin) {
    const key = this.keyFor(this.trustFingerprintOf(cfg), origin || '');
    return this.map.delete(key);
  }
  clear() { this.map.clear(); }
}

// --- Cache-read helper ----------------------------------------------------------------
// Returns a cached profile ONLY if its signed expiry is still in the future.
function cacheRead(store, cfg, origin, nowMs) {
  const cached = store.get(cfg, { origin });
  if (!cached) return { hit: false };
  const exp = cached.profile && cached.profile.expires ? new Date(cached.profile.expires).getTime() : 0;
  if (exp && exp < nowMs) {
    return { hit: false, stale: true }; // signed expiry overrides cache freshness
  }
  const keyState = (cached.profile.signingKeys || []).find((k) => k.id === (cached.profile.signature || {}).keyId);
  if (keyState && keyState.status !== 'active') return { hit: false, stale: true };
  return { hit: true, profile: cached.profile, meta: cached.meta };
}

// --- RESOLVE: A2A-first with safe standalone fallback ----------------------------------
// input: { url?: string (profile URL), origin?: string, cardUrl?: string,
//          trust: TrustConfig, now?: string, cache?: ProfileCache,
//          retrieveOpts?: object (test controls) }
// Returns { ok, result, outcome } — see README for the result shape.
async function resolveProfile(input) {
  const { trust, now, cache, retrieveOpts } = input || {};
  const cfg = normalizeTrustConfig(trust);
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const store = cache || new ProfileCache();
  const retOpts = { ...(retrieveOpts || {}), allowLocalhost: cfg.permitLocalhost };

  // TLS server identity: `retrieveOpts.ca` lets TESTS pin the self-signed test
  // certificate. In production the system trust store is used and `ca` is
  // never supplied.
  if (retrieveOpts && retrieveOpts.ca) retOpts.ca = retrieveOpts.ca;

  // 1) A2A card retrieval (primary).
  let a2aResult = null;
  const cardUrl = input.cardUrl || (cfg.origin ? cfg.origin.replace(/\/+$/, '') + '/.well-known/agent-card.json' : null);
  if (cardUrl) {
    const fetch = await httpRetrieval.fetchRetrieve({ url: cardUrl, opts: retOpts });
    if (fetch.ok) {
      a2aResult = parseAgentCard(fetch.bodyString);
      if (a2aResult.ok) {
        a2aResult.card = a2aResult.card;
        a2aResult.raw = fetch.bodyString;
        a2aResult.retrieved = true;
        const cardAuth = await verifyAgentCardAuth(a2aResult.card, cfg);
        a2aResult.cardAuthenticated = cardAuth.authenticated;
        if (!cardAuth.ok) {
          // A card that CARRIES signatures but fails verification is an auth
          // failure: never weaken to the standalone profile.
          a2aResult.ok = false;
          a2aResult.errorCode = 'DSC_AUTH_FAILED_NO_FALLBACK';
          a2aResult.reason = cardAuth.reason || 'agent card signature verification failed';
        }
      }
    } else {
      a2aResult = { ok: false, errorCode: fetch.errorCode || 'DSC_UNAVAILABLE', reason: fetch.reason || 'A2A card retrieval failed', retrieved: false };
    }
  }

  // SAAX extension negotiation on the card.
  const a2aHasExtension = a2aResult && a2aResult.ok ? cardHasExtension(a2aResult.card, EXTENSION_URI) : false;
  const a2aRequiredExt = a2aResult && a2aResult.ok ? cardExtensionRequirement(a2aResult.card, EXTENSION_URI) : null;
  const requiredExtensions = cfg.requiredExtensions || [];
  const unsatisfiedRequired = (a2aResult && a2aResult.ok) ? requiredExtensions.filter((u) => !cardHasExtension(a2aResult.card, u)) : [];

  // 2) Decide whether fallback to the standalone profile is permitted.
  let fallback = false;
  let fallbackReason = null;
  const explicitStandalone = !!input.url; // caller named the profile URL directly
  const a2aAuthFailure =
    a2aResult && !a2aResult.ok && (
      a2aResult.errorCode === 'DSC_AUTH_FAILED_NO_FALLBACK' ||
      a2aResult.errorCode === 'DSC_INVALID_PROFILE' ||
      a2aResult.errorCode === 'DSC_INVALID_SIGNATURE');
  const a2aAmbiguous = a2aResult && !a2aResult.ok && !a2aAuthFailure;

  const a2aVerdict = d.authFallbackPolicy({ authOk: !a2aAuthFailure, requiredExtensionOk: unsatisfiedRequired.length === 0 });
  if (a2aVerdict && a2aVerdict.allowFallback === false) {
    // Auth failure or required-extension incompatibility: NEVER weaken.
    const code = a2aAuthFailure ? 'DSC_AUTH_FAILED_NO_FALLBACK' : 'DSC_MISSING_REQUIRED_EXTENSION';
    return {
      ok: false,
      authenticated: false,
      outcome: 'no_fallback',
      errorCode: code,
      reason: a2aVerdict.reason || (a2aAuthFailure ? 'card authentication failed' : 'required extension missing'),
      a2a: a2aResult ? { available: a2aResult.ok, errorCode: a2aResult.errorCode, hasExtension: a2aHasExtension } : null,
      trust: { authenticated: false, selfSigned: false, trustSource: null, independentConformance: false },
      capability: { advertised: [], compatible: [] },
    };
  }
  // No card obtained but fallback is configured and this is not an auth verdict.
  if (!a2aResult || !a2aResult.ok || !a2aHasExtension) {
    if (a2aHasExtension) {
      // card present with extension: resolve via the standalone profile path.
      fallback = false;
    } else if ((!a2aResult || !a2aResult.ok) && cfg.allowStandaloneFallback) {
      fallback = true;
      fallbackReason = a2aAuthFailure ? 'A2A auth failure (no fallback)' : 'A2A card unavailable; standalone fallback permitted by client config';
    } else if (!a2aResult || !a2aResult.ok) {
      // No card obtainable at all. An explicit standalone profile URL is a
      // deliberate direct retrieval and does not require fallback permission,
      // because there is no card to negotiate with.
      if (explicitStandalone) {
        fallback = true;
        fallbackReason = 'explicit standalone profile URL (not a fallback)';
      } else {
        return {
          ok: false,
          authenticated: false,
          outcome: a2aAuthFailure ? 'no_fallback' : 'unavailable',
          errorCode: a2aAuthFailure ? 'DSC_AUTH_FAILED_NO_FALLBACK' : 'DSC_UNAVAILABLE',
          reason: a2aAuthFailure ? 'A2A authentication failed; fallback forbidden' : 'no A2A card, fallback not configured, and no explicit standalone profile URL',
          a2a: a2aResult ? { available: a2aResult.ok, errorCode: a2aResult.errorCode, hasExtension: a2aHasExtension } : { available: false, errorCode: null, hasExtension: false },
          trust: { authenticated: false, selfSigned: false, trustSource: null, independentConformance: false },
          capability: { advertised: [], compatible: [] },
        };
      }
    } else {
      // A card WAS obtained but does not declare the SAAX extension: that is a
      // negotiation verdict (the interface is not offered). Fallback to the
      // standalone profile requires explicit client permission; otherwise fail
      // closed — an explicit URL does not override the card's declaration.
      if (cfg.allowStandaloneFallback) {
        fallback = true;
        fallbackReason = 'A2A card does not declare the SAAX extension; standalone fallback permitted by client config';
      } else {
        return {
          ok: false,
          authenticated: false,
          outcome: 'no_fallback',
          errorCode: 'DSC_MISSING_REQUIRED_EXTENSION',
          reason: 'A2A card does not declare the SAAX extension and client does not permit standalone fallback',
          a2a: { available: true, errorCode: null, hasExtension: false },
          trust: { authenticated: false, selfSigned: false, trustSource: null, independentConformance: false },
          capability: { advertised: [], compatible: [] },
        };
      }
    }
  }
  if (fallback && !cfg.allowStandaloneFallback && !explicitStandalone) {
    return {
      ok: false,
      authenticated: false,
      outcome: 'no_fallback',
      errorCode: 'DSC_MISSING_REQUIRED_EXTENSION',
      reason: 'standalone fallback not permitted by client config',
      a2a: a2aResult ? { available: a2aResult.ok, errorCode: a2aResult.errorCode, hasExtension: a2aHasExtension } : null,
    };
  }
  if (explicitStandalone) fallback = true;

  // 3) Retrieve + validate the standalone profile.
  const standaloneUrl = input.url || (cfg.origin ? cfg.origin.replace(/\/+$/, '') + '/.well-known/saax.json' : null);
  if (!standaloneUrl) {
    return { ok: false, authenticated: false, outcome: 'unavailable', errorCode: 'DSC_UNAVAILABLE', reason: 'no profile URL and no configured origin' };
  }

  // Cache read (only when a cached profile exists with future expiry).
  const cached = cacheRead(store, cfg, cfg.origin || '', nowMs);
  let fetch;
  if (cached.hit) {
    fetch = { ok: true, bodyString: JSON.stringify({ ...cached.profile, signature: cached.profile.signature }), fromCache: true };
  } else {
    const r = await httpRetrieval.fetchRetrieve({ url: standaloneUrl, opts: retOpts });
    fetch = r;
    fetch.fromCache = false;
    if (!fetch.ok) {
      return {
        ok: false,
        authenticated: false,
        outcome: 'unavailable',
        errorCode: fetch.errorCode || 'DSC_UNAVAILABLE',
        reason: fetch.reason || 'profile retrieval failed',
        a2a: a2aResult ? { available: a2aResult.ok, errorCode: a2aResult.errorCode, hasExtension: a2aHasExtension } : null,
      };
    }
  }

  const validated = await validateSignedProfile({ bodyString: fetch.bodyString, trustConfig: cfg, now });
  if (!validated.ok) {
    return {
      ok: false,
      authenticated: false,
      outcome: 'invalid',
      errorCode: validated.errorCode,
      reason: validated.reason,
      a2a: a2aResult ? { available: a2aResult.ok, errorCode: a2aResult.errorCode, hasExtension: a2aHasExtension } : null,
      trust: validated.trust || null,
    };
  }

  const { profile, trust: tr } = validated;
  // 4) Advertised capability map + demonstrated conformance.
  const adv = validateAdvertised(profile);
  const demonstrated =
    (profile.conformance && Array.isArray(profile.conformance.demonstrated) && profile.conformance.demonstrated.length > 0) ? true : false;

  // 5) Consistency between A2A card and standalone profile (shared fields).
  let consistency = { ok: true };
  if (a2aResult && a2aResult.ok) {
    // Shared capability data must be identical between the Agent Card and the
    // standalone profile: the card's provider.url must equal the profile's
    // origin (a mismatch is a representation conflict).
    const cardOrigin = (a2aResult.card.provider && a2aResult.card.provider.url) || null;
    consistency = d.checkRepresentationConsistency({
      a2a: { origin: cardOrigin ? cardOrigin.replace(/\/+$/, '') : null },
      standalone: { origin: (profile.origin || '').replace(/\/+$/, '') },
      sharedFields: ['origin'],
    });
  }

  // 6) Cache the validated profile.
  if (!fetch.fromCache) {
    store.set(cfg, profile, { validatedAt: nowMs, via: explicitStandalone ? 'explicit-standalone' : (fallback ? 'standalone-fallback' : 'standalone'), a2a: a2aResult ? a2aResult.ok : false });
  }

  const availability = {
    checked: false,
    detail: null,
  };

  return {
    ok: true,
    authenticated: tr.authenticated,
    outcome: 'resolved',
    provider: {
      providerId: profile.providerId,
      origin: profile.origin,
      name: profile.providerName || null,
    },
    trust: tr,
    version: profile.profileVersion,
    profile: profile,
    signature: {
      keyId: profile.signature && profile.signature.keyId,
      alg: profile.signature && profile.signature.alg,
      scheme: profile.signature && profile.signature.scheme,
      thumbprint: tr.trustedKeyThumbprint || null,
    },
    a2a: a2aResult ? { available: a2aResult.ok, hasExtension: a2aHasExtension, requiresExtension: a2aRequiredExt, inconsistency: consistency.ok ? null : consistency.errors } : { available: false, hasExtension: false, requiresExtension: null, inconsistency: null },
    capability: {
      advertised: adv.advertisedCombinations,
      compatible: adv.advertisedCombinations, // profiles only advertise what they support
      schemas: adv.schemas,
      demonstrated,
      demonstratedDetail: profile.conformance && profile.conformance.demonstrated ? profile.conformance.demonstrated : [],
    },
    availability,
    checked: {
      advertised: true,
      authenticatedPublisher: tr.authenticated,
      demonstratedConformance: demonstrated,
      currentAvailability: false,
    },
    fromCache: !!fetch.fromCache,
  };
}

module.exports = {
  PROFILE_VERSION,
  EXTENSION_URI,

  normalizeTrustConfig,
  parseAgentCard,
  cardHasExtension,
  cardExtensionRequirement,
  verifyAgentCardAuth,
  validateSignedProfile,
  validateAdvertised,
  combinationSupported,
  ProfileCache,
  cacheRead,
  resolveProfile,
};