// SAAX Protocol — Day 15, Item 2: Authority-Proof Interface
//
// The commitment currently assumes the buyer's (or seller's) signature is
// sufficient authorization. This module ADDS an external authority proof that
// the gateway can reference at issuance and re-evaluate at execution time.
//
// CRITICAL PRINCIPLE: SAAX does NOT issue authority proofs. It CONSUMES them
// from external systems — AP2 mandates, verifiable intents, OAuth tokens, or
// custom schemes. The commitment records the proof reference at issuance and
// re-checks (still valid? still in scope?) at execution time.
//
// AuthorityProof structure (validated, only recognized fields kept):
// {
//   "authorityProofId": "0x...",
//   "proofType": "ap2-mandate|verifiable-intent|oauth-token|custom",
//   "issuer": "0x...",                       // who issued the proof
//   "subject": "0x...",                      // the agent being authorized
//   "scope": { ... },                        // what the agent is authorized to do
//   "validFrom": "2026-10-06T...",
//   "validUntil": "2026-10-07T...",
//   "signature": "COSE_Sign1...",
//   "verificationScheme": "cose|jws|eip712",
//   "verificationMaterial": "0x..."
// }
//
// Scope model (provider-neutral):
//   scope = {
//     actions: ['route', 'settle'],   // requestedAction must be in this list
//     capability: 'security-scan',    // optional; must equal commitment.capability when present
//     amountMax: '250000',            // optional raw units; commitment price must be <=
//     currency: 'USDC'                // optional; must equal commitment currency when present
//   }
//
// SCOPE SEMANTICS: when a scope dimension is ABSENT, that dimension is
// unrestricted (a proof with no amountMax authorizes any amount). When
// PRESENT, the commitment must satisfy it. The legacy path — a commitment
// with NO authority proof at all — remains fully operational (backward
// compatible with buyer-signature-only authorization).

const { verifyTypedData } = require('viem');
// Phase 5C: real cose/jws verification for authority proofs (same pluggable
// verifier as evidence). Loaded lazily so the eip712-only path has no cost.
let _coseJwsVerifier = null;
function coseJwsVerifier() {
  if (!_coseJwsVerifier) _coseJwsVerifier = require('./cose-jws-verifier.js');
  return _coseJwsVerifier;
}

// ---- EIP-712 domain + types for authority proofs (eip712 scheme) ----------------
const PROOF_TYPES = {
  AuthorityProof: [
    { name: 'authorityProofId', type: 'string' },
    { name: 'issuer', type: 'address' },
    { name: 'subject', type: 'address' },
    { name: 'validFrom', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'scopeDigest', type: 'string' },
  ],
};
const PROOF_DOMAIN_NAME = 'SAAX Authority';
const PROOF_DOMAIN_VERSION = '1';

// Phase 5C — chain-binding policy.
// The PROOF domain is a chain-INDEPENDENT off-chain authorization by default
// (no chainId — v1 compatibility). When a proof explicitly binds a chain
// (scope.chainId, or a verificationMaterial chain-hint of the form
// "chain:<chainId>"), the domain object is built WITH that chainId at
// signature-verification time, so cross-chain replay of a chain-bound proof
// is rejected. A binding that is present but cannot be parsed is a hard
// failure (never silently treated as unbound).
function proofDomainFor(proof) {
  const base = { name: PROOF_DOMAIN_NAME, version: PROOF_DOMAIN_VERSION };
  const scopeChain = proof && proof.scope && proof.scope.chainId;
  const matMatch = proof && proof.verificationMaterial && String(proof.verificationMaterial).match(/^chain:(\d+)$/);
  const matChain = matMatch ? matMatch[1] : null;
  if (scopeChain != null && matChain != null && String(scopeChain) !== String(matChain)) {
    throw new Error('PROOF_CHAIN_BINDING_CONFLICT: scope.chainId=' + scopeChain + ' conflicts with verificationMaterial chain=' + matChain);
  }
  const chainId = scopeChain != null ? scopeChain : matChain;
  if (chainId == null || chainId === '') return base; // unbound -> v1 domain
  const n = Number(chainId);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('PROOF_CHAIN_BINDING_INVALID: chainId must be a positive integer');
  }
  return Object.assign({}, base, { chainId: BigInt(n) });
}

const PROOF_TYPES_LIST = ['ap2-mandate', 'verifiable-intent', 'oauth-token', 'custom'];
const SCHEMES = ['cose', 'jws', 'eip712'];

// ---- Structural validation -------------------------------------------------------
function validateAuthorityProofStructure(proof) {
  if (!proof || typeof proof !== 'object') return { ok: false, reason: 'proof must be an object' };
  if (!proof.authorityProofId || typeof proof.authorityProofId !== 'string') return { ok: false, reason: 'authorityProofId must be a string' };
  if (!proof.proofType || !PROOF_TYPES_LIST.includes(String(proof.proofType).toLowerCase())) {
    return { ok: false, reason: 'proofType must be one of ' + PROOF_TYPES_LIST.join('|') };
  }
  if (!proof.issuer || !/^0x[a-fA-F0-9]{40}$/.test(proof.issuer)) return { ok: false, reason: 'issuer must be an address' };
  if (!proof.subject || !/^0x[a-fA-F0-9]{40}$/.test(proof.subject)) return { ok: false, reason: 'subject must be an address' };
  if (!proof.scope || typeof proof.scope !== 'object') return { ok: false, reason: 'scope must be an object' };
  if (proof.scope.actions !== undefined) {
    if (!Array.isArray(proof.scope.actions) || !proof.scope.actions.length) {
      return { ok: false, reason: 'scope.actions must be a non-empty array when present' };
    }
    for (const a of proof.scope.actions) if (typeof a !== 'string' || !a) return { ok: false, reason: 'scope.actions entries must be non-empty strings' };
  }
  if (proof.scope.amountMax !== undefined && !/^\d+$/.test(String(proof.scope.amountMax))) {
    return { ok: false, reason: 'scope.amountMax must be a non-negative integer string when present' };
  }
  if (proof.scope.currency !== undefined && typeof proof.scope.currency !== 'string') {
    return { ok: false, reason: 'scope.currency must be a string when present' };
  }
  if (!proof.validFrom || isNaN(Date.parse(proof.validFrom))) return { ok: false, reason: 'validFrom must be a parseable ISO 8601 timestamp' };
  if (!proof.validUntil || isNaN(Date.parse(proof.validUntil))) return { ok: false, reason: 'validUntil must be a parseable ISO 8601 timestamp' };
  if (Date.parse(proof.validFrom) > Date.parse(proof.validUntil)) return { ok: false, reason: 'validity window inverted (validFrom > validUntil)' };
  if (!proof.signature || typeof proof.signature !== 'string') return { ok: false, reason: 'signature is required' };
  if (!proof.verificationScheme || !SCHEMES.includes(String(proof.verificationScheme).toLowerCase())) {
    return { ok: false, reason: 'verificationScheme must be one of cose|jws|eip712' };
  }
  const scheme = String(proof.verificationScheme).toLowerCase();
  if (scheme === 'eip712' && !/^0x[a-fA-F0-9]{130}$/.test(proof.signature)) {
    return { ok: false, reason: 'eip712 signature must be 65-byte hex (0x + 130 hex chars)' };
  }
  if ((scheme === 'cose' || scheme === 'jws') && !String(proof.signature).startsWith(scheme.toUpperCase() + '_')) {
    return { ok: false, reason: scheme + ' signature must carry the ' + scheme.toUpperCase() + '_ envelope tag' };
  }
  if (proof.verificationMaterial !== undefined && proof.verificationMaterial !== null && typeof proof.verificationMaterial !== 'string') {
    return { ok: false, reason: 'verificationMaterial must be a string when present' };
  }
  return { ok: true, reason: null };
}

// ---- Scope digest ------------------------------------------------------------------
// Canonical digest of the scope object (sorted keys). The eip712 signed message
// commits to this digest so scope tampering breaks signature recovery.
function scopeDigest(scope) {
  const canonical = JSON.stringify(scope, (k, v) => {
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {});
    }
    return v;
  });
  return 'sha256:' + require('crypto').createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---- Signature verification (scheme-aware) -----------------------------------------
// eip712: real EIP-712 recovery — verifyTypedData returns whether the signature
// recovers to the claimed issuer over the PROOF domain with the scope digest.
// cose/jws: structural envelope validation (Phase 1 posture, same as evidence);
// an optional verifyVerifier hook can do real verification later.
async function verifyProofSignature(proof, opts = {}) {
  const scheme = String(proof.verificationScheme).toLowerCase();
  if (scheme === 'eip712') {
    try {
      let domain;
      try {
        domain = proofDomainFor(proof);
      } catch (e) {
        return { ok: false, reason: String(e.message || e).slice(0, 200) };
      }
      const ok = await verifyTypedData({
        address: proof.issuer,
        types: PROOF_TYPES,
        primaryType: 'AuthorityProof',
        message: {
          authorityProofId: proof.authorityProofId,
          issuer: proof.issuer,
          subject: proof.subject,
          validFrom: BigInt(Math.floor(Date.parse(proof.validFrom) / 1000)),
          validUntil: BigInt(Math.floor(Date.parse(proof.validUntil) / 1000)),
          scopeDigest: scopeDigest(proof.scope),
        },
        domain,
        signature: proof.signature,
      });
      return { ok: !!ok, reason: ok ? null : 'eip712 signature does not recover to the claimed issuer' };
    } catch (e) {
      return { ok: false, reason: 'eip712 verification failed: ' + String(e.message || e).slice(0, 160) };
    }
  }
  const tag = scheme.toUpperCase() + '_';
  const sig = String(proof.signature || '');
  if (!sig.startsWith(tag)) return { ok: false, reason: 'missing ' + tag + ' envelope tag' };
  if (sig.length <= tag.length + 1) return { ok: false, reason: scheme + ' envelope carries no signature material' };
  if (opts && typeof opts.verifyVerifier === 'function') {
    try {
      const r = await opts.verifyVerifier(proof);
      return { ok: !!r, reason: r ? null : 'verifier hook rejected ' + scheme + ' proof' };
    } catch (e) {
      return { ok: false, reason: 'verifier hook error: ' + String(e.message || e).slice(0, 160) };
    }
  }
  // Phase 5C: real cryptographic verification for cose/jws authority proofs.
  // NEVER ok:true on structure alone.
  try {
    // Phase 5C: authority proofs bind via their own scope/authority validation
    // (like the eip712 typed message), NOT an evidence payloadHash — so the
    // evidence-specific payload binding is skipped; the signature is still
    // cryptographically verified against the trusted issuer key (fail closed
    // on untrusted key, unknown alg, tampered token).
    const verifierOpts = { skipEvidenceBinding: true };
    if (typeof opts.resolver === 'function') verifierOpts.resolver = opts.resolver;
    const r = await coseJwsVerifier().verifyCoseJws(proof, verifierOpts);
    return { ok: !!r.ok, reason: r.ok ? null : (r.reason || scheme + ' verification failed') };
  } catch (e) {
    return { ok: false, reason: scheme + ' verification error: ' + String(e.message || e).slice(0, 160) };
  }
}

// ---- Scope check --------------------------------------------------------------------
// Does the proof's scope cover the requested action + commitment context?
// An ABSENT scope dimension is unrestricted. Returns { ok, reason }.
function scopeCovers(proof, requestedAction, commitmentContext = {}) {
  const scope = proof && proof.scope ? proof.scope : {};
  const action = String(requestedAction || '').trim();
  if (!action) return { ok: false, reason: 'requestedAction is required' };
  if (scope.actions && Array.isArray(scope.actions) && scope.actions.length) {
    if (!scope.actions.includes(action)) {
      return { ok: false, reason: 'action "' + action + '" not in proof scope.actions' };
    }
  }
  const cap = commitmentContext.capability;
  if (cap && scope.capability && String(scope.capability) !== String(cap)) {
    return { ok: false, reason: 'capability "' + cap + '" not authorized by proof scope' };
  }
  const cur = commitmentContext.currency;
  if (cur && scope.currency && String(scope.currency).toUpperCase() !== String(cur).toUpperCase()) {
    return { ok: false, reason: 'currency "' + cur + '" not authorized by proof scope' };
  }
  const amt = commitmentContext.amountRaw;
  if (amt && scope.amountMax !== undefined && scope.amountMax !== null) {
    if (!/^\d+$/.test(String(amt))) return { ok: false, reason: 'commitment amount must be a non-negative integer string' };
    if (BigInt(String(amt)) > BigInt(String(scope.amountMax))) {
      return { ok: false, reason: 'commitment amount exceeds proof scope.amountMax' };
    }
  }
  return { ok: true, reason: null };
}

// ---- Core: validateAuthorityProof -----------------------------------------------------
// Checks structure, signature, scope, and TIME validity. Returns { ok, reason }.
async function validateAuthorityProof(proof, commitment, opts = {}) {
  const structural = validateAuthorityProofStructure(proof);
  if (!structural.ok) return { ok: false, reason: structural.reason, stage: 'structure' };
  if (commitment && commitment.authorityProofId && String(commitment.authorityProofId) !== String(proof.authorityProofId)) {
    return { ok: false, reason: 'proof does not match the commitment authorityProofId', stage: 'binding' };
  }
  if (commitment && commitment.buyerAgentId && String(commitment.buyerAgentId).toLowerCase() !== String(proof.subject).toLowerCase()) {
    return { ok: false, reason: 'proof subject is not the commitment buyer', stage: 'binding' };
  }
  const sig = await verifyProofSignature(proof, opts);
  if (!sig.ok) return { ok: false, reason: sig.reason, stage: 'signature' };
  // Time validity (wall clock)
  const nowMs = Date.now();
  const fromMs = Date.parse(proof.validFrom);
  const untilMs = Date.parse(proof.validUntil);
  if (nowMs < fromMs) return { ok: false, reason: 'proof not yet valid (validFrom in future)', stage: 'time' };
  if (nowMs > untilMs) return { ok: false, reason: 'proof expired (validUntil passed)', stage: 'time' };
  return { ok: true, reason: null, stage: 'ok' };
}

// ---- Core: isAuthorized -------------------------------------------------------------------
// Verifies the proof covers the specific action the commitment represents.
// Combines validateAuthorityProof (integrity + time) with scopeCovers (action +
// commitment context). Returns { ok, reason }.
async function isAuthorized(proof, requestedAction, commitmentContext, opts = {}) {
  const validated = await validateAuthorityProof(proof, commitmentContext && commitmentContext.commitment ? commitmentContext.commitment : null, opts);
  if (!validated.ok) return { ok: false, reason: validated.reason, stage: validated.stage };
  const ctx = commitmentContext || {};
  const cover = scopeCovers(proof, requestedAction, {
    capability: ctx.capability,
    currency: ctx.currency,
    amountRaw: ctx.amountRaw,
  });
  if (!cover.ok) return { ok: false, reason: cover.reason, stage: 'scope' };
  return { ok: true, reason: null, stage: 'ok' };
}

// ---- Attach proof to a commitment record (issuance-time reference) ---------------------
// Stores ONLY the reference on the commitment (proofId + proofType + issuer +
// subject + expiry) — never the full proof or its signature (non-leakage: the
// proof material lives at the external issuer; the commitment carries a
// verifiable reference). Returns the commitment record.
function attachAuthorityProof(commitment, proof) {
  if (!commitment || typeof commitment !== 'object') throw new Error('attachAuthorityProof: commitment is required');
  if (!proof || typeof proof !== 'object') throw new Error('attachAuthorityProof: proof is required');
  commitment.authorityProof = {
    authorityProofId: proof.authorityProofId,
    proofType: proof.proofType,
    issuer: proof.issuer,
    subject: proof.subject,
    scope: proof.scope,              // for execution-time re-evaluation
    validUntil: proof.validUntil,
    verificationScheme: proof.verificationScheme,
    verificationMaterial: proof.verificationMaterial || null,
  };
  return commitment;
}

module.exports = {
  validateAuthorityProofStructure,
  validateAuthorityProof,
  isAuthorized,
  scopeCovers,
  scopeDigest,
  verifyProofSignature,
  proofDomainFor,
  attachAuthorityProof,
  PROOF_TYPES,
  PROOF_TYPES_LIST,
  PROOF_DOMAIN_NAME,
  PROOF_DOMAIN_VERSION,
  SCHEMES,
};