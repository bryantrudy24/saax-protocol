// SAAX Protocol — Day 5: Payment routing decision tree (mock mode)
//
// selectRail(supplierRegistration) -> { rail: "x402" | "mpp" | "unsupported", reason, detail? }
//
// DECISION TREE (per operator spec):
//   1. x402 path:  supplier's registration advertises an x402-compatible payTo
//                  address AND accepts USDC on a supported network
//                  (base | polygon | solana). Use x402 for micropayments,
//                  instant settlement.
//   2. MPP path:   supplier requires fiat rails or Stripe-native settlement.
//                  Router selects MPP; the actual mppx settlement call is
//                  STUBBED in Sprint 1 (no mppx install, no Stripe rails —
//                  Day 7+ item once the wallet is live and a real MPP supplier
//                  exists in the index).
//   3. Fallback:   advertises neither -> rail "unsupported", the supplier is
//                  EXCLUDED from the returned match list. The router NEVER
//                  silently routes to a rail the supplier did not accept.
//
// Every supplier in every test logs:
//   { agentId, capability, selectedRail, reason }
//
// payTo safety: any x402 payTo failing validatePayTo() is treated as
// unsupported -> excluded (never paid, never routed).
const fs = require('fs');
const path = require('path');
const x402 = require('./x402.js');

const SUPPORTED_X402_NETWORKS = ['base', 'polygon', 'solana'];
const REGISTRATIONS_PATH = process.env.SAAX_SUPPLIER_REGISTRATIONS ||
  path.join(__dirname, 'supplier-registrations.json');

function loadRegistrations() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRATIONS_PATH, 'utf8'));
    return raw.registrations || raw;
  } catch (e) {
    throw new Error('cannot load supplier registrations: ' + String(e.message || e) + ' (' + REGISTRATIONS_PATH + ')');
  }
}

// The decision itself — pure, unit-testable.
function selectRail(reg) {
  if (!reg || typeof reg !== 'object') {
    return { rail: 'unsupported', reason: 'no registration' };
  }
  const rails = (reg.rails && typeof reg.rails === 'object') ? reg.rails : {};

  // 1. x402 path — advertised payTo + USDC on supported network
  const x402c = rails.x402;
  if (x402c && typeof x402c === 'object') {
    if (!Array.isArray(x402c.networks) || x402c.networks.length === 0) {
      return { rail: 'unsupported', reason: 'x402 advertised but no networks listed' };
    }
    const supported = x402c.networks.filter(n => SUPPORTED_X402_NETWORKS.includes(n));
    if (supported.length === 0) {
      return { rail: 'unsupported', reason: 'x402 advertised but no supported network (base/polygon/solana)' };
    }
    if (String(x402c.asset || '').toUpperCase() !== 'USDC') {
      return { rail: 'unsupported', reason: 'x402 advertised but asset is not USDC' };
    }
    const network = supported[0];
    const pt = x402.validatePayTo(x402c.payTo, network);
    if (!pt.ok) {
      return { rail: 'unsupported', reason: 'x402 payTo rejected (' + pt.reason + ')' };
    }
    return {
      rail: 'x402',
      reason: 'x402-compatible payTo + USDC on ' + network,
      detail: {
        scheme: x402c.scheme || (reg.pricing === 'usage' ? 'upto' : 'exact'),
        payTo: pt.address,
        asset: 'USDC',
        network,
        maxTimeoutSeconds: x402c.maxTimeoutSeconds || 60,
      },
    };
  }

  // 2. MPP path — fiat / Stripe-native settlement required
  const mppc = rails.mpp;
  if (mppc && typeof mppc === 'object') {
    return {
      rail: 'mpp',
      reason: 'supplier requires fiat rails / Stripe-native settlement (mppx client flow on Day 7+)',
    };
  }

  // 3. Fallback
  return { rail: 'unsupported', reason: 'supplier advertises neither x402 nor MPP rail' };
}

// Route every matched supplier; EXCLUDE unsupported from the returned match
// list (no silent rail). Returns { routed: [...], excluded: [...] }.
function routeMatches(matchedCandidates, capability, registrations) {
  const routed = [];
  const excluded = [];
  const decisionLog = [];
  for (const cand of matchedCandidates) {
    const reg = registrations[String(cand.agent_id)] || null;
    const decision = selectRail(reg);
    const entry = {
      agentId: cand.agent_id,
      capability,
      selectedRail: decision.rail,
      reason: decision.reason,
    };
    decisionLog.push(entry);
    if (decision.rail === 'unsupported') {
      excluded.push({ ...cand, excludedReason: decision.reason });
    } else {
      routed.push({ ...cand, selectedRail: decision.rail, railDetail: decision.detail || null });
    }
  }
  return { routed, excluded, decisionLog };
}

module.exports = { selectRail, routeMatches, loadRegistrations, SUPPORTED_X402_NETWORKS };