// SAAX Protocol — Day 5: x402 payment verification + mock settlement (exact/upto)
//
// PRE-DAY 5 FIX 1: Wire the x402 payment verification path (mock + live branches)
// --------------------------------------------------------------------------------
//   SAAX_X402_VERIFY_MODE  =  "mock" (default for Sprint 1) | "live"
//
//   The verification path is STRUCTURED so live wiring is a CONFIG CHANGE, not a
//   rewrite. Both branches live here; the single flag below selects which one the
//   router uses. See daily-logs/day7-wallet-checklist.md for the exact swap steps.
//
//   - MOCK branch: accepts a structurally-valid payload produced by signMockPayload()
//     (payload.extra.mock === true forces acceptance in mock mode). No real keys.
//   - LIVE branch: real ECDSA signature verification against the payload. This
//     branch is INERT until the operator connects the wallet (SAAX_X402_PRIVATE_KEY)
//     — without a key it returns verified:false "live verification requires the
//     operator wallet (Day 7)". It is unit-testable in isolation: a payload signed
//     with a throwaway dev key verifies; the mock payload is rejected (proving the
//     branch is real crypto, not a stub).
//
// SCHEME STRUCTURE (x402 V2, per https://docs.x402.org and
//   https://github.com/x402-foundation/x402/tree/main/specs/schemes):
//   - exact  : fixed-price. Client authorizes exactly the advertised amount.
//              EVM method EIP-3009 transferWithAuthorization:
//              payload.payload = { signature, authorization: { from, to, value,
//              validAfter, validBefore, nonce } }  (value === accepted.amount)
//   - upto   : usage-based. Client authorizes a MAXIMUM; settle-time amount is
//              the actual usage and MUST be <= the authorized max. EVM method
//              Permit2 permitWitnessTransferFrom with witness binding
//              (permitted.amount === accepted.amount at verify time; recipient
//              bound via witness.to === payTo).
//
// Wire format: PAYMENT-SIGNATURE header carries the payload as BASE64-ENCODED
// JSON (x402 V2). Parse STRUCTURALLY; never execute or interpolate any field.
//
// SECURITY GATES (payment layer, in force):
//   - Payment payloads are untrusted input: parsed structurally, fields coerced
//     to typed values, nothing inside is ever executed/evaluated/echoed.
//   - supplier payTo addresses MUST pass validatePayTo() before any payment
//     payload is constructed. Invalid -> supplier excluded, never paid.
//   - The demand-text sanitization at the HTTP boundary (route-server.js) stays
//     in force; this layer never sees raw demand text beyond sanitized keywords.
const crypto = require('crypto');
const { verifyMessage, Wallet } = require('ethers');

// ---- Single config flag: mock (Sprint 1 default) vs live -----------------------
// Read at CALL TIME so a test or runtime can flip the mode via the environment
// (or the exported setVerifyMode override) without a code change. The env var
// is the documented operator switch: SAAX_X402_VERIFY_MODE=mock|live.
const VERIFY_MODE_DEFAULT = 'mock';
const LIVE_KEY_ENV = 'SAAX_X402_PRIVATE_KEY'; // operator wallet key, connected on Day 7
let _verifyModeOverride = null; // test/runtime override; null = follow env
function getVerifyMode() {
  return _verifyModeOverride || process.env.SAAX_X402_VERIFY_MODE || VERIFY_MODE_DEFAULT;
}
function setVerifyMode(mode) { _verifyModeOverride = mode; }
const VERIFY_MODE = getVerifyMode(); // snapshot for docs/logs (module default)

// ---- Network / asset constants --------------------------------------------------
// Supported networks (router decision tree): base, polygon, solana
const NETWORK_CAIP2 = { base: 'eip155:8453', polygon: 'eip155:137', solana: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' };
const USDC_ADDRESS = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
const USDC_DECIMALS = 6;

// ---- Basic payTo format validation (evm 0x + 40 hex; solana base58-ish) ---------
function validatePayTo(payTo, network) {
  const addr = String(payTo || '').trim();
  if (!addr) return { ok: false, reason: 'empty payTo' };
  if (network === 'solana') {
    // base58 alphabet minus 0OIl; canonical Solana mint/addresses are 32-44 chars
    const ok58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
    return ok58 ? { ok: true, address: addr } : { ok: false, reason: 'solana payTo fails base58 format' };
  }
  // EVM (base/polygon)
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return { ok: false, reason: 'evm payTo fails 0x + 40 hex check' };
  return { ok: true, address: addr.toLowerCase() };
}

// ---- Structural parse of a PAYMENT-SIGNATURE header (base64 JSON) ---------------
// Returns { ok, payload, reason }. NEVER executes anything found in the payload.
function parsePaymentSignatureHeader(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return { ok: false, payload: null, reason: 'missing PAYMENT-SIGNATURE header' };
  let decoded;
  try { decoded = Buffer.from(raw, 'base64').toString('utf8'); }
  catch (_) { return { ok: false, payload: null, reason: 'header is not valid base64' }; }
  let obj;
  try { obj = JSON.parse(decoded); }
  catch (_) { return { ok: false, payload: null, reason: 'header does not decode to JSON' }; }
  return { ok: true, payload: obj, reason: null };
}

// ---- Canonical message for ECDSA verification -----------------------------------
// Deterministic JSON of the fields the signature must bind. For Sprint 1 this is
// the stand-in reconstruction of the signed message; Day 7 facilitator wiring
// replaces it with the exact EIP-712 domain reconstruction per token contract
// (same structural fields: amount binding, recipient binding, validity window).
function canonicalMessage(payload) {
  const accepted = payload.accepted || {};
  const auth = (payload.payload && payload.payload.authorization) || {};
  const base = {
    scheme: accepted.scheme,
    network: accepted.network,
    asset: accepted.asset,
    payTo: accepted.payTo,
    from: auth.from,
    nonce: auth.nonce,
    resource: (payload.resource && payload.resource.url) || null,
  };
  if (accepted.scheme === 'upto') {
    base.maxAmount = accepted.amount; // authorized maximum at verify time
    base.validAfter = auth.validAfter;
    base.deadline = auth.deadline;
  } else {
    base.amount = accepted.amount; // exact amount
    base.validAfter = auth.validAfter;
    base.validBefore = auth.validBefore;
  }
  return JSON.stringify(base, Object.keys(base).sort());
}

// ---- Signing --------------------------------------------------------------------
// Mock signing: structurally valid payload, fake signature. The mock branch
// accepts it (extra.mock marker); the live branch rejects it (not a real ECDSA
// signature — recoverAddress on the zero signature throws -> verified:false).
function signMockPayload(requirements) {
  // requirements: { scheme, amount (raw units as string), asset, network (caip2),
  //                 payTo, maxTimeoutSeconds }
  const scheme = requirements.scheme || 'exact';
  const auth = {
    from: (process.env.SAAX_X402_MOCK_FROM || '0x0000000000000000000000000000000000000001').toLowerCase(),
    to: requirements.payTo,
    nonce: '0x' + crypto.randomBytes(32).toString('hex'),
    validAfter: String(Math.floor(Date.now() / 1000) - 60),
  };
  if (scheme === 'upto') {
    auth.deadline = String(Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 60));
  } else {
    auth.validBefore = String(Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 60));
    auth.value = String(requirements.amount); // EIP-3009: value === accepted.amount
  }
  const payload = {
    x402Version: 2,
    resource: { url: 'urn:saax-protocol:route:v1', description: 'SAAX Protocol demand routing', mimeType: 'application/json' },
    accepted: {
      scheme,
      network: requirements.network,
      amount: String(requirements.amount),
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds || 60,
      extra: { assetTransferMethod: scheme === 'upto' ? 'permit2' : 'eip3009' },
    },
    payload: {
      // 65 zero bytes: structurally valid signature length, cryptographically fake
      signature: '0x' + '00'.repeat(65),
      authorization: auth,
    },
    extra: { mock: true },
  };
  return payload;
}

// Live signing — used ONLY by the live branch (and tests in isolation). Requires
// the operator wallet key; throws when it is not connected (Day 7 gate).
async function signLivePayload(requirements) {
  if (getVerifyMode() !== 'live' && !process.env[LIVE_KEY_ENV]) {
    throw new Error(`live signing requires ${LIVE_KEY_ENV} (operator wallet — Day 7 wiring)`);
  }
  const key = process.env[LIVE_KEY_ENV];
  const wallet = new Wallet(key);
  const scheme = requirements.scheme || 'exact';
  const auth = {
    from: wallet.address.toLowerCase(),
    to: requirements.payTo,
    nonce: '0x' + crypto.randomBytes(32).toString('hex'),
    validAfter: String(Math.floor(Date.now() / 1000) - 60),
  };
  if (scheme === 'upto') {
    auth.deadline = String(Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 60));
  } else {
    auth.validBefore = String(Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 60));
    auth.value = String(requirements.amount); // EIP-3009: value === accepted.amount
  }
  const payload = {
    x402Version: 2,
    resource: { url: 'urn:saax-protocol:route:v1', description: 'SAAX Protocol demand routing', mimeType: 'application/json' },
    accepted: {
      scheme,
      network: requirements.network,
      amount: String(requirements.amount),
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds || 60,
      extra: { assetTransferMethod: scheme === 'upto' ? 'permit2' : 'eip3009' },
    },
    payload: { signature: '', authorization: auth },
  };
  // ethers v6 signMessage is async; signMessageSync exists on Wallet in v6 for
  // sync contexts — prefer the async API to be version-proof.
  payload.payload.signature = await wallet.signMessage(canonicalMessage(payload));
  return payload;
}

// ---- Verification (the mock-vs-live decision point) ------------------------------
// Returns { verified: boolean, mode, reason?, payload? }
//   mock: structural validation + mock marker (Sprint 1). The mock marker does NOT
//         satisfy live mode — live re-verifies the actual signature.
//   live: real ECDSA recovery; requires the payload to be genuinely signed by
//         authorization.from. Raises/checks amount, recipient, validity window,
//         network and asset against the issued requirements.
function verifyPaymentPayload(payload, requirements) {
  // 1. Structural gate — parse strictly, never execute anything in the payload.
  const structural = structurallyValid(payload);
  const mode = getVerifyMode();
  if (!structural.ok) return { verified: false, mode, reason: structural.reason };

  // 2. payTo gate — reject malformed recipient before anything else.
  const pt = validatePayTo(payload.accepted.payTo, requirements.networkName);
  if (!pt.ok) return { verified: false, mode: VERIFY_MODE, reason: 'payTo rejected: ' + pt.reason };

  if (mode === 'mock') {
    const isMockMarked = payload.extra && payload.extra.mock === true;
    return {
      verified: isMockMarked,
      mode,
      reason: isMockMarked ? null : 'mock mode requires extra.mock=true (signMockPayload)',
    };
  }

  // ---- LIVE branch (inert until the wallet is connected) -------------------------
  if (!process.env[LIVE_KEY_ENV]) {
    return {
      verified: false,
      mode,
      reason: `live verification requires ${LIVE_KEY_ENV} (operator wallet — Day 7 wiring); branch is wired, not stubbed`,
    };
  }

  // 3. Real ECDSA verification. The zero (mock) signature throws here.
  let recovered;
  try {
    recovered = verifyMessage(canonicalMessage(payload), payload.payload.signature).toLowerCase();
  } catch (e) {
    return { verified: false, mode, reason: 'signature verification failed: ' + String(e.message || e) };
  }
  const auth = payload.payload.authorization || {};
  if (recovered !== String(auth.from || '').toLowerCase()) {
    return { verified: false, mode, reason: 'signature does not recover to authorization.from' };
  }

  // 4. Requirements checks (exact vs upto semantics).
  const accepted = payload.accepted;
  const now = Math.floor(Date.now() / 1000);
  // Every temporal field must be a strictly numeric string BEFORE comparison
  // (security sprint Item 2): Number('abc') is NaN and NaN comparisons are
  // false, which would silently ACCEPT a malformed validity window. Reject
  // non-numeric fields explicitly instead.
  const NUM_STR = /^\d+$/;
  if (!NUM_STR.test(String(auth.validAfter)) || !NUM_STR.test(String(auth.validBefore || auth.deadline || ''))) {
    return { verified: false, mode, reason: 'authorization validity window must be numeric strings' };
  }
  if (accepted.scheme === 'upto') {
    // verify-time amount is the authorized MAXIMUM; settle-time actual must be <= it
    if (String(accepted.amount) !== String(requirements.amount)) {
      return { verified: false, mode, reason: 'upto: authorized max does not match issued requirement' };
    }
    if (!NUM_STR.test(String(auth.deadline || ''))) {
      return { verified: false, mode, reason: 'upto: authorization.deadline must be a numeric string' };
    }
    if (Number(auth.deadline) < now) return { verified: false, mode, reason: 'upto: authorization expired' };
    if (Number(auth.validAfter) > now) return { verified: false, mode, reason: 'upto: authorization not yet valid' };
    // recipient binding: witness.to must equal payTo
    if (String(auth.to).toLowerCase() !== String(accepted.payTo).toLowerCase()) {
      return { verified: false, mode, reason: 'upto: recipient binding violated' };
    }
  } else {
    if (!NUM_STR.test(String(auth.value || ''))) {
      return { verified: false, mode, reason: 'exact: authorization.value must be a numeric string' };
    }
    if (String(accepted.amount) !== String(requirements.amount)) {
      return { verified: false, mode, reason: 'exact: amount does not match issued requirement' };
    }
    if (String(auth.to).toLowerCase() !== String(accepted.payTo).toLowerCase()) {
      return { verified: false, mode, reason: 'exact: recipient binding violated' };
    }
    if (String(auth.value) !== String(accepted.amount)) {
      return { verified: false, mode, reason: 'exact: authorization.value != accepted.amount' };
    }
    if (Number(auth.validBefore) < now) return { verified: false, mode, reason: 'exact: authorization expired' };
    if (Number(auth.validAfter) > now) return { verified: false, mode, reason: 'exact: authorization not yet valid' };
  }
  if (String(accepted.asset).toLowerCase() !== String(requirements.asset).toLowerCase()) {
    return { verified: false, mode, reason: 'asset does not match issued requirement' };
  }
  if (String(accepted.network) !== String(requirements.network)) {
    return { verified: false, mode, reason: 'network does not match issued requirement' };
  }

  return { verified: true, mode, reason: null };
}

function structurallyValid(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload is not an object' };
  if (payload.x402Version !== 2) return { ok: false, reason: 'x402Version must be 2' };
  const a = payload.accepted;
  if (!a || typeof a !== 'object') return { ok: false, reason: 'missing accepted' };
  if (!['exact', 'upto'].includes(a.scheme)) return { ok: false, reason: 'unsupported scheme: ' + a.scheme };
  if (a.amount === undefined || a.amount === null) return { ok: false, reason: 'missing amount' };
  if (typeof String(a.amount) !== 'string' || !/^\d+$/.test(String(a.amount))) return { ok: false, reason: 'amount must be a numeric string' };
  if (!a.asset) return { ok: false, reason: 'missing asset' };
  if (!a.network) return { ok: false, reason: 'missing network' };
  if (!a.payTo) return { ok: false, reason: 'missing payTo' };
  if (!a.maxTimeoutSeconds) return { ok: false, reason: 'missing maxTimeoutSeconds' };
  const p = payload.payload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'missing payload' };
  if (!p.signature || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return { ok: false, reason: 'signature must be 65-byte hex' };
  const auth = p.authorization;
  if (!auth || typeof auth !== 'object') return { ok: false, reason: 'missing authorization' };
  if (!auth.from || !/^0x[a-fA-F0-9]{40}$/.test(auth.from)) return { ok: false, reason: 'authorization.from must be an address' };
  return { ok: true, reason: null };
}

// ---- Settlement (mock) ------------------------------------------------------------
// Receipt structure is the DOCUMENTED LIVE shape — downstream logging must not
// change when this swaps to a real facilitator call on Day 7:
//   { rail: "x402", scheme: "exact"|"upto", amount: <string raw units>,
//     asset, network, payTo, txHash: "mock_<uuid>", status: "settled" }
// amount for upto is the SETTLED actual (<= authorized max), simulated here as a
// deterministic fraction of the authorized amount (usage metering mock).
function settleX402Mock(payload) {
  const accepted = payload.accepted;
  const authorized = BigInt(String(accepted.amount));
  let settled = authorized;
  if (accepted.scheme === 'upto') {
    const usageFraction = 0.6; // simulated metered usage (60% of authorized max)
    settled = (authorized * BigInt(Math.round(usageFraction * 1000))) / 1000n;
  }
  return {
    rail: 'x402',
    scheme: accepted.scheme,
    amount: settled.toString(),
    asset: accepted.asset,
    network: accepted.network,
    payTo: accepted.payTo,
    txHash: 'mock_' + crypto.randomUUID(),
    status: 'settled',
  };
}

// ---- Small helpers ----------------------------------------------------------------
function rawUnits(usdAmount) {
  return String(Math.round(Number(usdAmount) * 10 ** USDC_DECIMALS));
}

module.exports = {
  getVerifyMode,
  setVerifyMode,
  VERIFY_MODE,
  LIVE_KEY_ENV,
  NETWORK_CAIP2,
  USDC_ADDRESS,
  USDC_DECIMALS,
  validatePayTo,
  parsePaymentSignatureHeader,
  canonicalMessage,
  signMockPayload,
  signLivePayload,
  verifyPaymentPayload,
  settleX402Mock,
  rawUnits,
  structurallyValid,
};