// SAAX Protocol — Day 5: Payment settlement orchestrator (mock mode)
//
// For every ROUTED supplier (x402 or MPP):
//   x402: build PaymentRequirements from the rail detail -> mock-sign the payload
//         (exact scheme for fixed-price, upto scheme for usage-based) ->
//         verify through SAAX_X402_VERIFY_MODE (mock branch accepts) ->
//         settle to a mock receipt whose structure matches the documented
//         LIVE receipt structure field-for-field.
//   mpp:  STUB only. Log { rail: "mpp", status: "stubbed",
//         reason: "Sprint 1 mock mode" }. mppx is NOT installed, Stripe rails
//         are NOT configured — that is a Day 7+ item (wallet live + a real MPP
//         supplier exists in the index).
//
// SECURITY GATE (payment path, unchanged):
//   - payTo already validated in the router before any payload construction
//     (validatePayTo) — this layer re-checks as defense in depth.
//   - Payment payloads are parsed structurally; nothing inside a payload is
//     ever executed/evaluated/echoed back.
//   - Demand-text sanitization at the HTTP boundary remains in force.
//
// ROUTE-AROUND: mppx / any MPP dependency is deferred with a log entry rather
// than installed; no external spend ever happens on the payment path.

const x402 = require('./x402.js');

// The exact routing fee (mock): $0.05 USDC on Base, structured like the live
// path (which will read per-supplier prices on Day 5+ when real prices exist).
function feeFor(routedSupplier) {
  return {
    usd: 0.05, // SAAX_ROUTING_FEE_USD
    scheme: (routedSupplier.railDetail && routedSupplier.railDetail.scheme) || 'exact',
    network: (routedSupplier.railDetail && routedSupplier.railDetail.network) || 'base',
  };
}

// Build the PaymentRequirements issued for one supplier (what the server WOULD
// put in a PAYMENT-REQUIRED challenge). exact -> fixed amount;
// upto -> authorized maximum (settle-time actual is revealed later).
function buildRequirements(routedSupplier, fee) {
  const detail = routedSupplier.railDetail;
  return {
    scheme: detail.scheme,          // 'exact' | 'upto'
    amount: x402.rawUnits(fee.usd), // raw USDC units (6 dp)
    asset: x402.USDC_ADDRESS[detail.network],
    networkName: detail.network,    // 'base'
    network: x402.NETWORK_CAIP2[detail.network], // 'eip155:8453'
    payTo: detail.payTo,
    maxTimeoutSeconds: detail.maxTimeoutSeconds || 60,
  };
}

// Settle one routed supplier through the x402 payment authorization flow.
// Returns the settlement record incl. the mock receipt (or a failure record).
function settleRouted(routedSupplier, capability, decisionLog) {
  const fee = feeFor(routedSupplier);

  if (routedSupplier.selectedRail === 'mpp') {
    // ---- MPP path: stub only ------------------------------------------------
    const record = {
      agentId: routedSupplier.agent_id,
      capability,
      rail: 'mpp',
      status: 'stubbed',
      reason: 'Sprint 1 mock mode',
      note: 'mppx client flow + Stripe rails deferred to Day 7+ (wallet live + real MPP supplier in index). No mppx installed; no Stripe configured.',
    };
    decisionLog.push({ agentId: routedSupplier.agent_id, capability, selectedRail: 'mpp', reason: 'stubbed: ' + record.reason });
    return record;
  }

  // ---- x402 path: requirements -> mock sign -> verify (mock branch) -> settle
  const requirements = buildRequirements(routedSupplier, fee);
  decisionLog.push({
    agentId: routedSupplier.agent_id,
    capability,
    selectedRail: 'x402',
    reason: 'settling via x402 ' + requirements.scheme + ' scheme (' + fee.usd + ' USDC raw ' + requirements.amount + ')',
  });

  const payload = x402.signMockPayload(requirements);
  const verification = x402.verifyPaymentPayload(payload, requirements);
  if (!verification.verified) {
    return {
      agentId: routedSupplier.agent_id,
      capability,
      rail: 'x402',
      status: 'verification_failed',
      reason: verification.reason,
    };
  }

  // Receipt structure === documented live receipt structure (field-for-field)
  const receipt = x402.settleX402Mock(payload);
  return {
    agentId: routedSupplier.agent_id,
    capability,
    rail: receipt.rail,
    scheme: receipt.scheme,
    amount: receipt.amount,
    asset: receipt.asset,
    network: receipt.network,
    payTo: receipt.payTo,
    txHash: receipt.txHash,
    status: receipt.status,
    verificationMode: verification.mode,
  };
}

// Full payment pass over routed suppliers.
function runPayments(routed, excluded, capability) {
  const decisionLog = [];
  const settlements = [];
  for (const sup of routed) {
    settlements.push(settleRouted(sup, capability, decisionLog));
  }
  for (const ex of excluded) {
    decisionLog.push({
      agentId: ex.agent_id,
      capability,
      selectedRail: 'unsupported',
      reason: ex.excludedReason,
    });
  }
  return { settlements, decisionLog };
}

module.exports = { feeFor, buildRequirements, settleRouted, runPayments };