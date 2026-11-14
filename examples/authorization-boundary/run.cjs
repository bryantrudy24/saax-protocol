#!/usr/bin/env node
// Example 3 — Agentic Commerce Authorization Boundary (nonfinancial)
// A conceptual workflow with SAAX-native and simulated steps clearly labeled.
// No real funds, no production credentials, no production mutations.

const assert = require("node:assert");

// ---- Simulated external components (clearly labeled) --------------------
// These stand in for x402/AP2/payment rails or a business's policy engine.
// They are NOT SAAX and NOT real integrations.
function simulateSpendingPolicyCheck(agent, amountUsd, budgetUsd) {
  return amountUsd <= budgetUsd; // simulated policy engine
}
function simulatePaymentAuthorization(commitment, amountUsd) {
  // Simulates an external payment authorization (x402/AP2-style).
  return { authorized: true, reference: "sim-x402-" + commitment.slice(-8), amountUsd };
}

// ---- SAAX-native components (conceptual; no store contact) -------------
// This example documents the workflow and the boundary between SAAX
// lifecycle semantics and external payment/execution systems. It does NOT
// contact the database; run tests/reliability suites for executable proof.

class CommitmentBook {
  constructor() { this.rows = new Map(); }
  create({ id, buyer, provider, terms, criteria }) {
    this.rows.set(id, {
      id, buyer, provider, terms, criteria,
      state: "issued",
      version: 1,
      authorizationRef: null,
      evidence: [],
    });
    return this.rows.get(id);
  }
  transition(id, toState, actor) {
    const c = this.rows.get(id);
    if (!c) throw new Error("unknown commitment");
    if (c.state === "finalized" || c.state === "cancelled") {
      throw new Error("terminal state: " + c.state);
    }
    c.state = toState;
    c.version += 1;
    c.lastActor = actor;
    return c;
  }
  get(id) { return this.rows.get(id); }
}

(async () => {
  const book = new CommitmentBook();
  const BUYER = "agent-buyer-1";
  const PROVIDER = "agent-provider-1";
  const AMOUNT_USD = 12.5;
  const BUDGET_USD = 50;

  // 1. Buyer instruction (simulated external event)
  const instruction = { item: "compute job", maxAmountUsd: AMOUNT_USD };
  assert.equal(typeof instruction.item, "string");

  // 2. Agent authority resolution (SAAX-native concept: durable authorization)
  //    A real deployment verifies an EIP-712 proof against agent_authorizations.
  const agentAuthority = { agent: BUYER, spendCapUsd: BUDGET_USD, role: "buyer" };
  assert.equal(agentAuthority.role, "buyer");

  // 3. Spending-policy check (SIMULATED external policy engine)
  const policyOk = simulateSpendingPolicyCheck(BUYER, AMOUNT_USD, agentAuthority.spendCapUsd);
  assert.equal(policyOk, true, "spending policy must permit the amount");

  // 4. Commitment preparation (SAAX-native)
  const commitment = book.create({
    id: "saax_example_authz_" + Date.now(),
    buyer: BUYER,
    provider: PROVIDER,
    terms: { description: "Compute a SHA-256 digest", amountUsd: AMOUNT_USD },
    criteria: ["crc-001"],
  });
  assert.equal(commitment.state, "issued");
  console.log("commitment created:", commitment.id, "state=issued");

  // 5. Simulated payment authorization (EXTERNAL — x402/AP2-style, simulated)
  //    SAAX itself does not move money. A payment authorization is a separate
  //    responsibility of the payment rail.
  const paymentAuth = simulatePaymentAuthorization(commitment.id, AMOUNT_USD);
  assert.equal(paymentAuth.authorized, true);
  console.log("payment authorized (SIMULATED):", paymentAuth.reference);

  // 6. Acceptance + execution (SAAX-native lifecycle transitions)
  book.transition(commitment.id, "accepted", PROVIDER);
  book.transition(commitment.id, "executing", PROVIDER);
  assert.equal(book.get(commitment.id).state, "executing");
  console.log("lifecycle: issued -> accepted -> executing");

  // 7. Evidence requirement (SAAX-native): fulfillment evidence is bound to
  //    the commitment and its acceptance criteria; submission does NOT imply
  //    successful fulfillment (verification is a separate step).
  const evidence = { evidenceId: "ev-" + commitment.id, criterionId: "crc-001", payloadHash: "sha256:abc123" };
  book.transition(commitment.id, "evidence_pending", PROVIDER);
  const c = book.get(commitment.id);
  c.evidence.push(evidence);
  console.log("evidence submitted (bound to criteria; not yet verified)");

  // 8. Completion or recovery (SAAX-native): the commitment outlives the
  //    worker. If the buyer agent disappeared here, a separately authorized
  //    replacement could resume — see examples/mcp-recovery and /recovery.
  book.transition(commitment.id, "evidence_submitted", PROVIDER);
  assert.equal(book.get(commitment.id).state, "evidence_submitted");
  console.log("workflow complete (nonfinancial). Commitment state:", book.get(commitment.id).state);

  // Boundary assertion: no payment was executed by SAAX in this example.
  assert.ok(paymentAuth.reference.startsWith("sim-"), "payment must remain simulated");
  console.log("\nauthorization-boundary example: PASS (all boundaries held)");
  process.exit(0);
})().catch((e) => {
  console.error("authorization-boundary example: FAIL -", e.message);
  process.exit(1);
});
