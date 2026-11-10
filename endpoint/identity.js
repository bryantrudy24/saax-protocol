// SAAX Protocol — Day 8, Item 4: Buyer reputation from the x402 signature (pre-live)
//
// Threat: the discount tier logic currently trusts the x-mock-buyer-rep header.
// ANY client can spoof it to claim high reputation and get a discount. On live,
// buyer reputation MUST derive from a VERIFIED source.
//
// Path (a) — confirmed by the operator (Day 7 checklist §9):
//   1. After a live x402 payment VERIFIES, recover the signer address from
//      authorization.from in the payment payload (the verification layer
//      already proves the signature recovers to authorization.from).
//   2. Query the ERC-8004 Identity Registry for the agent owned by that address:
//      reverse-lookup getAgentByOwner(address) -> agentId | null.
//      The deployed IdentityRegistry ABI has NO getAgentByOwner; the reverse
//      lookup is implemented as:
//        a) local index cache  — owner -> agentId from the Day 1 snapshot
//           (data/agents-day1-named.json), the authoritative index the ranker
//           and feedback gates already consume;
//        b) on-chain fallback  — ownerOf(agentId) probe over the known id set
//           (Day 1-3 index); the FIRST direct hit is returned;
//        c) verification      — getAgentWallet(agentId) must recover the same
//           address (bind the identity to the wallet the on-chain registry
//           actually assigned).
//      Ambiguous owners (an owner with MULTIPLE agents) resolve to NULL
//      (fail-safe: no discount) unless the wallet check disambiguates.
//   3. If an agent is found, query ReputationRegistry for its score using the
//      SAME getSummary -> getClients -> getSummary pattern from Day 2
//      (getClients first, then getSummary over [...clients]; zero clients ->
//      no score -> reputation 0).
//   4. Discount tier: 0 for no agent, 0 for agents with no feedback, actual
//      score for agents with feedback.
//   5. Remove the x-mock-buyer-rep header entirely in LIVE mode. In mock mode,
//      keep it as a stand-in for testing.
//   6. Log EVERY resolution:
//      { walletAddress, resolvedAgentId, reputationScore, discountApplied,
//        source: "signature" | "mock_header" }.
//
// EDGE: if the recovered signer address does NOT match authorization.from,
// reject with 401 Unauthorized — signature invalid or payload tampered. (The
// x402 verification layer already enforces this; this module re-checks the
// recovered-vs-payload binding as defense in depth for the reputation path.)
const fs = require('fs');
const path = require('path');
const { JsonRpcProvider, Contract } = require('ethers');

// ---- Test seam (Day 8 closure, Item 4 harness) --------------------------------
// The Item 4 harness must run OFFLINE against the identity module in isolation
// (brief: "no real wallet, no real RPC, no real funds"). When set, this stub
// replaces the on-chain registry layer (IdentityRegistry + ReputationRegistry)
// with fixture data so tests are deterministic and never touch a live RPC.
// nil (default) = real on-chain behavior; the harness sets it before resolving.
let _offlineStub = null; // { agents: Map<ownerLower, agentId>, ownerOf: Map<agentId, ownerLower>,
                         //   getClients: (agentId)=>[clientAddrs], getSummary: (agentId)=>[count, value, decimals] }
function setOfflineStub(stub) { _offlineStub = stub; }
function isOffline() { return !!_offlineStub; }

// ---- RPC-call counter (Day 8 closure, kill-switch harness) --------------------
// The kill-switch brief requires asserting ZERO RPC calls fire when the switch
// is ON. Every entry point that could touch the chain increments this counter;
// the kill-switch harness asserts it stays 0 while the switch is active. Plain
// process-global counter + optional file flush for cross-process assertions
// (the spawned server writes the count to SAAX_RPC_COUNTER_FILE after each call).
let _rpcCallCount = 0;
const fsRpc = require('fs');
function rpcCalled() {
  _rpcCallCount++;
  const f = process.env.SAAX_RPC_COUNTER_FILE;
  if (f) { try { fsRpc.writeFileSync(f, String(_rpcCallCount)); } catch (_) {} }
  return _rpcCallCount;
}
function getRpcCallCount() { return _rpcCallCount; }
function resetRpcCallCount() { _rpcCallCount = 0; }

const RPC = process.env.SAAX_RPC_URL || 'https://base-rpc.publicnode.com';
const IDENTITY_REGISTRY = process.env.SAAX_IDENTITY_REGISTRY || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY = process.env.SAAX_REPUTATION_REGISTRY || '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

let _identityIndex = null; // owner-lowercase -> [agentId,...] (loaded once)

// ---- Reverse index (local cache, Day 1 snapshot) ------------------------------
function loadIdentityIndex() {
  if (_identityIndex) return _identityIndex;
  const map = new Map();
  const agents = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agents-day1-named.json'), 'utf8'));
  for (const a of agents) {
    const owner = String(a.owner || '').trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(owner)) continue;
    const arr = map.get(owner) || [];
    arr.push(Number(a.agent_id));
    map.set(owner, arr);
  }
  _identityIndex = map;
  return map;
}

// ---- On-chain fallback: probe ownerOf(agentId) over the known id set ----------
async function onChainOwnerLookup(address) {
  if (_offlineStub) {
    // Offline: reverse-lookup through the fixture ownerOf map.
    const want = String(address).toLowerCase();
    for (const [id, owner] of (_offlineStub.ownerOf || [])) {
      if (String(owner).toLowerCase() === want) return id;
    }
    return null;
  }
  rpcCalled(); // on-chain reverse probe = an RPC call
  const provider = new JsonRpcProvider(RPC);
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abis', 'IdentityRegistry.json'), 'utf8'));
  const reg = new Contract(IDENTITY_REGISTRY, abi, provider);
  const ids = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agent-ids-day2.json'), 'utf8')).map(Number);
  const want = address.toLowerCase();
  // Probe the known id set (Day 1-3 index); first direct hit wins.
  for (const id of ids) {
    try {
      const owner = String(await reg.ownerOf(id)).toLowerCase();
      if (owner === want) return id;
    } catch (_) { /* id may not exist; keep scanning */ }
  }
  return null;
}

// ---- getAgentByOwner(address) -> agentId | null -------------------------------
// Local index first (fast, deterministic), on-chain ownerOf probe as fallback,
// getAgentWallet(agentId) as the binding verification.
async function getAgentByOwner(address) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(String(address))) return null;
  const want = String(address).toLowerCase();
  const index = loadIdentityIndex();
  const candidates = index.get(want) || [];

  let agentId = null;
  if (candidates.length === 1) {
    agentId = candidates[0];
  } else if (candidates.length > 1) {
    // Ambiguous (an owner with multiple agents). Fail-safe: try the on-chain
    // wallet binding to disambiguate; otherwise NULL (no discount).
    try {
      for (const id of candidates) {
        const w = await getAgentWallet(id);
        if (w && w.toLowerCase() === want) { agentId = id; break; }
      }
    } catch (_) { agentId = null; }
    if (agentId === null) return null;
  } else {
    // Not in the local snapshot -> try the on-chain reverse probe.
    try {
      const probed = await onChainOwnerLookup(want);
      if (probed !== null) agentId = probed;
    } catch (_) { agentId = null; }
    if (agentId === null) return null;
  }

  // Verification step: the on-chain registry must bind the wallet to this agent.
  try {
    const wallet = await getAgentWallet(agentId);
    if (!wallet || wallet.toLowerCase() !== want) return null;
  } catch (_) {
    return null;
  }
  return agentId;
}

async function getAgentWallet(agentId) {
  if (_offlineStub) {
    const owner = _offlineStub.ownerOf && _offlineStub.ownerOf.get(Number(agentId));
    return owner ? String(owner) : null;
  }
  rpcCalled(); // getAgentWallet = an RPC call
  const provider = new JsonRpcProvider(RPC);
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abis', 'IdentityRegistry.json'), 'utf8'));
  const reg = new Contract(IDENTITY_REGISTRY, abi, provider);
  return String(await reg.getAgentWallet(agentId));
}

// ---- Reputation score (Day 2 pattern: getClients -> getSummary) ----------------
// Returns { score: number|null, count, note }.
// Score semantics per brief: 0 for no agent / no feedback; actual score with
// feedback. The SHAPE is { reputation: <number|null> } for computeFee().
async function getReputationForAgent(agentId) {
  if (!agentId) return { reputation: null, note: 'no agent; no reputation', count: 0 };
  if (_offlineStub) {
    // Offline: fixture-driven ReputationRegistry (getClients -> getSummary).
    const clients = await _offlineStub.getClients(Number(agentId));
    if (!clients || clients.length === 0) {
      return { reputation: null, note: 'agent has no feedback clients; no reputation', count: 0 };
    }
    const [count, value, decimals] = await _offlineStub.getSummary(Number(agentId));
    const norm = Number(value) / Math.pow(10, Number(decimals));
    const avgX100 = Math.round(norm * 100) / 100;
    return { reputation: avgX100, note: 'on-chain ReputationRegistry avgX100 (offline stub)', count: Number(count) };
  }
  rpcCalled(); // ReputationRegistry read = an RPC call
  try {
    const provider = new JsonRpcProvider(RPC);
    const abi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abis', 'ReputationRegistry.json'), 'utf8'));
    const rep = new Contract(REPUTATION_REGISTRY, abi, provider);
    const clients = await rep.getClients(Number(agentId));
    if (clients.length === 0) {
      return { reputation: null, note: 'agent has no feedback clients; no reputation', count: 0 };
    }
    const [count, summaryValue, valueDecimals] = await rep.getSummary(Number(agentId), [...clients], '', '');
    const norm = Number(summaryValue) / Math.pow(10, Number(valueDecimals));
    const avgX100 = Math.round(norm * 100) / 100;
    return { reputation: avgX100, note: 'on-chain ReputationRegistry avgX100', count: Number(count) };
  } catch (e) {
    const msg = String(e);
    // v2.0.0 contract reverts on zero-client agents -> same as no score
    if (msg.includes('missing revert data') || msg.includes('clientAddresses required')) {
      return { reputation: null, note: 'agent has no feedback; no reputation', count: 0 };
    }
    return { reputation: null, note: 'reputation lookup failed: ' + msg.slice(0, 120), count: 0 };
  }
}

// ---- Live-mode reputation resolution from a VERIFIED payment payload ----------
// payload must have passed x402 verification. Re-checks recovered-vs-from
// (401 on mismatch) as defense in depth. Returns a resolve object suitable for
// computeFee() + the required log line:
//   { ok, buyerRep, discountApplied, log, status? }
async function resolveReputationFromSignature(payload, verifyResult) {
  const auth = (payload && payload.payload && payload.payload.authorization) || {};
  const from = String(auth.from || '').toLowerCase();
  const recovered = String(verifyResult && verifyResult.recoveredAddress || '').toLowerCase();
  // Defense-in-depth: recovered signer MUST equal authorization.from.
  if (recovered && from && recovered !== from) {
    return { ok: false, status: 401, reason: 'signer mismatch: recovered ' + recovered + ' != authorization.from ' + from };
  }
  const walletAddress = from;
  const agentId = await getAgentByOwner(walletAddress);
  const rep = await getReputationForAgent(agentId);
  const score = rep.reputation === null ? 0 : rep.reputation;
  const discountApplied = score >= 95 ? 0.2 : (score >= 90 ? 0.1 : 0);
  return {
    ok: true,
    buyerRep: { reputation: score, note: rep.note },
    discountApplied,
    log: {
      walletAddress,
      resolvedAgentId: agentId || null,
      reputationScore: score,
      discountApplied,
      source: 'signature',
    },
  };
}

// ---- Mock-mode stand-in (x-mock-buyer-rep header) -------------------------------
function reputationFromMockHeader(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw || isNaN(Number(raw))) return null;
  const score = Number(raw);
  const discountApplied = score >= 95 ? 0.2 : (score >= 90 ? 0.1 : 0);
  return {
    buyerRep: { reputation: score, note: 'mock buyer rep from header (stand-in; live mode ignores this header)' },
    discountApplied,
    log: {
      walletAddress: null,
      resolvedAgentId: null,
      reputationScore: score,
      discountApplied,
      source: 'mock_header',
    },
  };
}

module.exports = {
  RPC,
  IDENTITY_REGISTRY,
  REPUTATION_REGISTRY,
  loadIdentityIndex,
  getAgentByOwner,
  getAgentWallet,
  getReputationForAgent,
  resolveReputationFromSignature,
  reputationFromMockHeader,
  setOfflineStub,
  isOffline,
  rpcCalled,
  getRpcCallCount,
  resetRpcCallCount,
};