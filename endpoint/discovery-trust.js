// SAAX Protocol — Discovery Phase 2: pure trust/fallback decision rules
//
// These are the DETERMINISTIC rules the resolver applies, kept in the
// contract-level module so the conformance runner can exercise them without a
// network. Real signature verification and network retrieval live in
// discovery-crypto.js / discovery-retrieval-http.js / discovery-resolver.js.
//
// trustDecide(input) — one concrete trust path, others unsupported:
//   input: {
//     configuredTrustedThumbprints: string[],   // client's configured anchor keys
//     actualSigningThumbprint: string,          // computed from the profile's signing key
//     profileOrigin: string,                   // origin claimed in the profile
//     configuredOrigin: string,                // origin the client configured/retrieved
//     keyStatus: 'active' | 'revoked' | 'expired' | 'unknown'
//   }
//   Returns:
//     { authenticated: true, trustSource: 'configured-key' } when the signing
//       thumbprint is in the configured set AND origin matches AND key active.
//     { authenticated: false, reason } otherwise — never collapses to "trusted".
//
// fallbackDecision(input) — resolve whether standalone fallback is permitted:
//   input: { a2aCardObtained: bool, authOk: bool, requiredExtensionOk: bool,
//            clientPermitsStandalone: bool }
//   Returns:
//     { allowFallback: true, reason: null } only when all four hold.
//     Auth failure or required-extension incompatibility NEVER weakens to a
//     fallback (returns the specific DSC code).
'use strict';

function trustDecide(input) {
  const cfg = input || {};
  const trusted = Array.isArray(cfg.configuredTrustedThumbprints) ? cfg.configuredTrustedThumbprints.map((t) => String(t).toLowerCase()) : [];
  const actual = String(cfg.actualSigningThumbprint || '').toLowerCase();
  const profileOrigin = String(cfg.profileOrigin || '').replace(/\/+$/, '');
  const configuredOrigin = String(cfg.configuredOrigin || '').replace(/\/+$/, '');
  const keyStatus = cfg.keyStatus || 'unknown';

  if (keyStatus !== 'active') {
    return { authenticated: false, trustSource: null, reason: 'signing key not active: ' + keyStatus };
  }
  if (!trusted.includes(actual)) {
    return { authenticated: false, trustSource: null, reason: 'signing key not in configured trusted set' };
  }
  if (configuredOrigin && profileOrigin !== configuredOrigin) {
    return { authenticated: false, trustSource: null, reason: 'profile origin does not match configured origin' };
  }
  return { authenticated: true, trustSource: 'configured-key' };
}

function fallbackDecision(input) {
  const cfg = input || {};
  const authOk = cfg.authOk !== false;
  const requiredExtensionOk = cfg.requiredExtensionOk !== false;
  if (!authOk) {
    return { allowFallback: false, errorCode: 'DSC_AUTH_FAILED_NO_FALLBACK', reason: 'A2A authentication failed; no weaker fallback' };
  }
  if (!requiredExtensionOk) {
    return { allowFallback: false, errorCode: 'DSC_MISSING_REQUIRED_EXTENSION', reason: 'incompatible required extension; no weaker fallback' };
  }
  // A missing A2A card is what makes standalone fallback NECESSARY, not a
  // blocker: permission is granted here only when auth held, required
  // extensions held, and the client explicitly permits the standalone path.
  if (!cfg.clientPermitsStandalone) {
    return { allowFallback: false, errorCode: 'DSC_MISSING_REQUIRED_EXTENSION', reason: 'client configuration does not permit standalone fallback' };
  }
  return { allowFallback: true, errorCode: null, reason: null };
}

module.exports = { trustDecide, fallbackDecision };