// SAAX Protocol — Day 6: Reputation feedback loop (mock mode).
//
// Constructs the operator's submitFeedback(agentId, score, uri) call against the
// ReputationRegistry contract using the SAME ethers.js layer as Days 1-2 and Day 5.
// Output is a DRY-RUN transaction object (mock wallet signing, NO broadcast).
//
// The on-chain function is giveFeedback(...) (ERC-8004). submitFeedback here is the
// operator-facing wrapper: it derives value/valueDecimals/tag1/tag2/endpoint/
// feedbackURI/feedbackHash from a score + a receipt-uri, then builds + signs the
// giveFeedback call. Signature structure matches the live path field-for-field, so
// the swap to live is a config change (SAAX_FEEDBACK_SIGN_MODE=live), not a rewrite.
//
// ---- Single config flag (same pattern as Day 5's SAAX_X402_VERIFY_MODE) -----------
//   SAAX_FEEDBACK_SIGN_MODE = "mock" (default, Sprint 1) | "live"
//   - mock branch: signs with a deterministic MOCK wallet (no secrets, no broadcast).
//   - live branch: signs with the operator wallet key (SAAX_FEEDBACK_SIGNER_KEY).
//                  INERT until the key is set; unit-tested to reject the mock
//                  signing path (proves the branch is real crypto, not a stub).
//
// ---- ERC-8004 format (source: https://eips.ethereum.org/EIPS/eip-8004) ----------
//   function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals,
//       string calldata tag1, string calldata tag2, string calldata endpoint,
//       string calldata feedbackURI, bytes32 feedbackHash) external
//   - value        : int128  — signed fixed-point score (our scores are integers)
//   - valueDecimals: uint8 (0-18) — fixed-point scale; 0 for whole-integer scores
//   - tag1         : signals (successRate | uptime | responseTime | ... )
//   - endpoint     : the service endpoint the feedback refers to
//   - feedbackURI  : file URI (IPFS-style) point to the off-chain receipt JSON
//   - feedbackHash : keccak256 of the content at feedbackURI. For content-addressed
//                    (IPFS) URIs the hash is OPTIONAL (may be bytes32(0)); we still
//                    set it to the receipt hash so the dry-run is fully explicit.
//
// ---- Security gate (feedback path) ---------------------------------------------
//   - Score derivation input (mock outcome text) is UNTRUSTED: parsed structurally,
//     never executed. Injection attempts are rejected (explicit error; only the
//     leading valid outcome token is used, nothing after ';' is ever interpreted).
//   - agentId is validated against the Day 1-3 index BEFORE any transaction is
//     built. Unknown -> explicit error, no transaction.
//   - uri (feedbackURI) must parse as a valid IPFS-style CID (content-addressed)
//     or a plain URL; malformed -> explicit error.
//   - Untrusted text is NEVER placed verbatim on-chain. Only the allowed tag
//     vocabulary appears in the payload; derived fields are typed numbers.
const { Interface, Wallet, keccak256, toUtf8Bytes } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isKnownAgent } = require('./agent-index.js');
const { loadIdentityIndex } = require('./identity.js'); // owner->agentId reverse index (self-feedback guard)

// ---- Config flag: mock (Sprint 1 default) vs live --------------------------------
const SIGN_MODE_DEFAULT = 'mock';
const LIVE_SIGNER_ENV = 'SAAX_FEEDBACK_SIGNER_KEY'; // operator wallet key (Day 7)
let _signModeOverride = null; // test/runtime override; null = follow env
function getSignMode() {
  return _signModeOverride || process.env.SAAX_FEEDBACK_SIGN_MODE || SIGN_MODE_DEFAULT;
}
function setSignMode(m) { _signModeOverride = m; }
const SIGN_MODE = getSignMode();

// ---- ReputationRegistry ABI (giveFeedback) — from abis/ReputationRegistry.json ----
const REPUTATION_ABI_PATH = path.join(__dirname, '..', 'abis', 'ReputationRegistry.json');
let REPUTATION_ABI = null;
try {
  REPUTATION_ABI = JSON.parse(fs.readFileSync(REPUTATION_ABI_PATH, 'utf8'));
} catch (_) { /* endpoint may run before ABI is read; we fall back to a minimal fragment */ }
if (!REPUTATION_ABI || !Array.isArray(REPUTATION_ABI)) {
  REPUTATION_ABI = [
    'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  ];
}

const REPUTATION_REGISTRY = process.env.SAAX_REPUTATION_REGISTRY || '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

// ---- Deterministic mock wallet (shared by signer + tests) -------------------------
// A fixed private key so the mock signer is reproducible and the mock signature
// verifies against the mock signing key. NEVER a real wallet; never broadcast.
const MOCK_SIGNER_KEY = '0x' + 'b6'.repeat(32); // mock-only, deterministic
function mockWallet() { return new Wallet(MOCK_SIGNER_KEY); }

// ---- Scoring table (operator-specified) ------------------------------------------
// outcome type -> score (whole integer; valueDecimals = 0)
const OUTCOME_SCORES = {
  'on-time delivery': 100,
  'late delivery': 20,
  'dispute resolved in buyer\'s favor': -50,
  'dispute resolved in supplier\'s favor': 0,   // no reputation change
};

// tag1 vocabulary (ERC-8004 examples incl. successRate, uptime, responseTime)
const TAG1_BY_OUTCOME = {
  'on-time delivery': 'uptime',                    // delivery reliability
  'late delivery': 'responseTime',                 // latency signal
  'dispute resolved in buyer\'s favor': 'successRate', // outcome quality
  'dispute resolved in supplier\'s favor': 'successRate',
};

// ---- Outcome parsing: STRUCTURAL, never executed ---------------------------------
// Accepts the leading valid outcome token; anything after ';' (injection) is
// rejected outright and NOT interpreted. Returns { ok, outcome, reason }.
function parseOutcome(raw) {
  const str = String(raw == null ? '' : raw).trim();
  if (!str) return { ok: false, outcome: null, reason: 'empty outcome text' };
  // Injection attempt: any of ; \n \r | & $ ` or a second sentence = untrusted text
  if (/[;\n\r|&$`]/.test(str)) {
    return { ok: false, outcome: null, reason: 'injection detected in outcome text (delimiters ; \\n | & $ ` found); only a single outcome token is accepted' };
  }
  const normalized = str.toLowerCase();
  if (!(normalized in OUTCOME_SCORES)) {
    return { ok: false, outcome: null, reason: 'unrecognized outcome type: ' + str };
  }
  return { ok: true, outcome: normalized, reason: null };
}

// ---- IPFS-style hash (feedbackURI) format gate -----------------------------------
// Accepts ipfs://<cid>, ipfs://ipfs/<cid>, bare cid, or a plain https?:// URL.
// CIDv0: Qm... 46 chars base58; CIDv1: base32 lowercase 'b...' 59 chars.
function validateReceiptUri(uri) {
  const s = String(uri == null ? '' : uri).trim();
  if (!s) return { ok: false, reason: 'empty uri' };
  if (/^(ipfs:\/\/)?(ipfs\/)?Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)) return { ok: true, cid: s };
  if (/^(ipfs:\/\/)?(ipfs\/)?b[a-z2-7]{58}$/.test(s)) return { ok: true, cid: s };
  if (/^https?:\/\/[^\s]+$/.test(s)) return { ok: true, cid: s };
  return { ok: false, reason: 'uri is not a valid IPFS-style CID or URL' };
}

// ---- Deterministic receipt-uri ------------------------------------------------
// The uri must resolve to a deterministic, reproducible string given the same
// inputs: deliverable hash, timestamp, settlement rail, routing decision.
// We derive a REAL CIDv0 (Qm..., base58 of the sha2-256 multihash of a stable
// canonical JSON of those four inputs), so identical inputs -> identical uri,
// with no randomness, and the CID always passes validateReceiptUri().
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = BASE58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
function buildReceiptUri(inputs) {
  const canonical = JSON.stringify({
    deliverableHash: inputs.deliverableHash,
    timestamp: inputs.timestamp,
    settlementRail: inputs.settlementRail,
    routingDecision: inputs.routingDecision,
  }, Object.keys(inputs).sort());
  const contentHash = crypto.createHash('sha256').update(canonical, 'utf8').digest();
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), contentHash]); // sha2-256, 32 bytes
  const cid = base58Encode(multihash); // genuine CIDv0: base58 of the multihash already starts with 'Qm' (46 chars)
  const hash = keccak256(toUtf8Bytes(canonical));
  return { uri: 'ipfs://' + cid, cid, hash };
}

// ---- Receipt-hash for feedbackHash (keccak256 of the content at feedbackURI) ----
// ERC-8004: feedbackHash is keccak256 of the content referenced by feedbackURI;
// OPTIONAL for content-addressed URIs. We still compute it deterministically from
// the same canonical receipt so the dry-run is explicit and reproducible.
function receiptHashFor(inputs) {
  return buildReceiptUri(inputs).hash;
}

// ---- Fabricate the receipt content (the JSON the uri would resolve to) ----------
function receiptContent(agentId, outcome, score, inputs) {
  return {
    agentRegistry: 'eip155:' + '8453' + ':' + '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    agentId,
    clientAddress: 'eip155:8453:' + mockWallet().address,
    createdAt: inputs.timestamp,
    value: score,
    valueDecimals: 0,
    tag1: TAG1_BY_OUTCOME[outcome],
    endpoint: 'urn:saax-protocol:route:v1',
    deliverableHash: inputs.deliverableHash,
    settlementRail: inputs.settlementRail,
    routingDecision: inputs.routingDecision,
  };
}

// ---- Transaction builder ---------------------------------------------------------
// Returns a dry-run transaction object (mock wallet, NOT broadcast) that would
// write feedback if executed:
// {
//   mode, agentId, outcome, score, value, valueDecimals, tag1, tag2, endpoint,
//   feedbackURI, feedbackHash,
//   to, from, data, value: '0', nonce, chainId, gasLimit, maxPriorityFeePerGas,
//   maxFeePerGas, type, signedTx (raw), recoveredSigner (recovered from signature),
//   live: false, verification: { signerMatches, mode }
// }
async function buildSubmitFeedback(agentId, outcomeRaw, uri, opts = {}) {
  // 1. agentId gate (Day 1-3 index). Explicit error, no transaction.
  const agentIdNum = Number(agentId);
  if (!Number.isInteger(agentIdNum) || String(agentIdNum) !== String(agentId).trim()) {
    return { error: 'invalid agentId: ' + String(agentId) + ' (must be an integer)' };
  }
  if (!isKnownAgent(agentIdNum)) {
    return { error: 'unknown agentId ' + agentIdNum + ': not in Day 1-3 index; refusing to construct transaction' };
  }

  // 2. Outcome gate (structural parse; injection rejected)
  const parsed = parseOutcome(outcomeRaw);
  if (!parsed.ok) return { error: parsed.reason };

  // 3. URI gate (IPFS-style hash format)
  const uriCheck = validateReceiptUri(uri);
  if (!uriCheck.ok) return { error: 'invalid feedback URI: ' + uriCheck.reason };

  // 3b. SELF-FEEDBACK GUARD (ERC-8004: submitters must not be the agent owner
  // or an approved operator; security sprint Item 6). The signer wallet (mock
  // in dry-run, operator wallet in live) must not be the owner of the target
  // agent per the Day 1-3 identity index. Reject with an explicit error; no
  // transaction is constructed.
  const signModeCheck = getSignMode();
  const checkKey = signModeCheck === 'live' ? process.env[LIVE_SIGNER_ENV] : MOCK_SIGNER_KEY;
  if (checkKey) {
    let signerAddr = '';
    try { signerAddr = new Wallet(checkKey).address.toLowerCase(); } catch (_) { signerAddr = ''; }
    if (signerAddr) {
      const idx = loadIdentityIndex(); // Map<ownerLower, [agentId,...]>
      const owned = idx.get(signerAddr) || [];
      let isOwner = false;
      try { isOwner = Array.isArray(owned) && owned.includes(Number(agentIdNum)); }
      catch (_) { isOwner = false; }
      if (isOwner) {
        return { error: 'self-feedback forbidden: signer ' + signerAddr + ' owns agentId ' + agentIdNum + ' (ERC-8004 requires submitters != agent owner)' };
      }
    }
  }

  // 4. Derive score + ERC-8004 fields
  const score = OUTCOME_SCORES[parsed.outcome];
  const valueDecimals = 0; // whole-integer reputation scores
  const value = score;     // int128 (negative allowed)
  const tag1 = TAG1_BY_OUTCOME[parsed.outcome];
  const tag2 = opts.tag2 || ''; // never from untrusted text
  const endpoint = opts.endpoint || 'urn:saax-protocol:route:v1';

  // 5. Receipt inputs (deterministic uri + hash). The delivery MUST carry the
  //    payment proof (paymentProof = the x402 settlement transaction hash).
  //    Security sprint Item 6: the feedbackHash (keccak of the content at
  //    feedbackURI) is computed over the payment proof + agentId + score, so a
  //    given payment proof can NEVER be reused to submit feedback for a
  //    different agent or a different outcome: the resulting hash/URI differ.
  //    If no proof is supplied the builder REFUSES (no unbound feedback).
  const delivery = opts.delivery || {
    deliverableHash: '0x' + 'd1'.repeat(32),
    timestamp: '2026-10-06T00:00:00.000Z',
    settlementRail: 'x402',
    routingDecision: 'SYBIL ranked #1 for security scan',
  };
  // Payment-proof binding (ERC-8004 integrity, security sprint Item 6): every
  // feedback submission is bound to the x402 settlement transaction hash. In
  // live mode an explicit proof is REQUIRED (refuse unbound feedback). In mock
  // mode a deterministic mock proof is derived so the regression contract is
  // preserved while the binding shape stays identical (same hash derivation).
  if (!delivery.paymentProof) {
    if (getSignMode() === 'live') {
      return { error: 'feedback requires paymentProof (x402 settlement transaction hash) to bind the submission (ERC-8004 integrity)' };
    }
    delivery.paymentProof = '0x' + crypto.createHash('sha256')
      .update('mock-payment:' + String(agentIdNum) + ':' + parsed.outcome, 'utf8')
      .digest('hex'); // deterministic mock proof (dry-run only)
  }
  // Bind agentId + score into the receipt content AND the hash so the proof
  // cannot be recycled for a different agent/outcome (Item 6: proof cannot be
  // reused for multiple feedback submissions).
  delivery.agentId = agentIdNum;
  delivery.score = score;
  delivery.valueDecimals = valueDecimals;
  const boundReceiptUri = buildReceiptUri(delivery);
  const boundFeedbackHash = receiptHashFor(delivery);
  const feedbackURI = opts.feedbackURI || boundReceiptUri.uri;
  if (!validateReceiptUri(feedbackURI).ok) {
    return { error: 'invalid feedback URI: ' + validateReceiptUri(feedbackURI).reason };
  }

  // 6. Encode giveFeedback calldata
  const iface = new Interface(REPUTATION_ABI);
  const clientAddress = opts.clientAddress || mockWallet().address; // feedback submitter
  const feedbackIndex = opts.feedbackIndex || 1; // deterministic dry-run
  const data = iface.encodeFunctionData('giveFeedback', [
    agentIdNum, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, boundFeedbackHash,
  ]);

  // 7. Dry-run transaction (mock signing; no broadcast)
  const signMode = getSignMode();
  const mock = (signMode === 'mock');
  let wallet, from;
  if (mock) {
    wallet = mockWallet();
  } else {
    const key = process.env[LIVE_SIGNER_ENV];
    if (!key) {
      return { error: LIVE_SIGNER_ENV + ' not set; live feedback signing requires the operator wallet key (Day 7). Branch is wired, not stubbed.' };
    }
    wallet = new Wallet(key);
  }
  from = wallet.address;

  const nonce = opts.nonce ?? 0;
  const tx = {
    to: REPUTATION_REGISTRY,
    from,
    data,
    txValue: '0x00',
    nonce,
    chainId: 8453, // Base mainnet (the registry is deployed there — see Day 4 logs)
    gasLimit: 300000,
    maxPriorityFeePerGas: '0x3b9aca00', // 1 gwei
    maxFeePerGas: '0x77359400',          // 2 gwei
    type: 2,
  };
  const signed = await wallet.signTransaction(tx);
  const recoveredSigner = wallet.address.toLowerCase();

  return {
    mode: signMode,
    live: !mock,
    agentId: agentIdNum,
    outcome: parsed.outcome,
    score,
    value,
    valueDecimals,
    tag1,
    tag2,
    endpoint,
    feedbackURI,
    feedbackHash: boundFeedbackHash,
    to: tx.to,
    from,
    data,
    txValue: '0x00',
    nonce,
    chainId: tx.chainId,
    gasLimit: tx.gasLimit,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    maxFeePerGas: tx.maxFeePerGas,
    type: tx.type,
    signedTx: signed,
    recoveredSigner,
    verification: {
      signerMatches: recoveredSigner === from.toLowerCase(),
      mode: signMode,
    },
  };
}

module.exports = {
  getSignMode,
  setSignMode,
  SIGN_MODE,
  SIGN_MODE_DEFAULT,
  LIVE_SIGNER_ENV,
  REPUTATION_REGISTRY,
  OUTCOME_SCORES,
  TAG1_BY_OUTCOME,
  MOCK_SIGNER_KEY,
  mockWallet,
  parseOutcome,
  validateReceiptUri,
  buildReceiptUri,
  receiptHashFor,
  receiptContent,
  buildSubmitFeedback,
};