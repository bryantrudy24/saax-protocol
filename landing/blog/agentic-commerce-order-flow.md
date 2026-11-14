# From Intent to Fulfillment: How an Agentic Commerce Order Actually Flows

*November 14, 2026*

---

An agentic purchase is more than "the agent clicks buy." It is a sequence of distinct steps, each with its own trust boundary. This article walks the full journey — intent, discovery, selection, authorization, payment, commitment, fulfillment, evidence, recovery — and shows where the process can break.

## The ten stages of an agent order

### 1. Intent

The user tells the agent what they want: "find a mechanical keyboard under $100, backlit, with hot-swap switches, delivered Friday." The agent now holds constraints, not a purchase order. Intent must be captured in a form the agent can act on without inventing terms.

### 2. Discovery

The agent searches machine-readable catalogs. Retailers expose products through structured feeds: JSON-LD product schemas, ACP product feeds, UCP capability profiles, or plain APIs. An agent finds what is available, in stock, and shippable.

Discovery is where "the agent can't find your store" happens. If your catalog is not structured for machine reading, agents never see it.

### 3. Selection

The agent compares candidates against the user's constraints. This is reasoning work: weighing price, availability, delivery, and trade-offs. The agent may present options for human confirmation, or — with standing authority — decide.

### 4. Authorization

Before any money moves, the agent must prove it is allowed to spend. This is the layer Google's AP2 addresses with signed mandates (Intent, Cart, Payment), and the layer ACP defines for checkout. A mandate cryptographically limits what the agent may do: amount, payee, items, and expiry.

**Authorization is not the same as agreement.** A mandate proves the user permitted a payment. It does not record the full terms of what the agent committed to buy and what counts as delivery.

### 5. Payment

The agent pays using a machine-native rail. Coinbase's x402 makes payment an HTTP operation: the server responds 402 with payment terms, the agent pays in USDC on Base, and the resource is released. By 2026, x402 had processed over 165 million agent transactions.

Payment is fast and final. That is exactly why the surrounding record matters: once money moves, the only thing left to argue about is whether the deliverable matched the agreement.

### 6. Commitment

A commitment is the durable record created before or at the moment of the transaction: parties, terms, authorization reference, acceptance criteria, evidence requirements, and recovery policy. It is the artifact both sides can point to after the fact.

In SAAX's model, a commitment passes through a versioned lifecycle — `issued`, `accepted`, `executing`, `evidence_pending`, `evidence_submitted`, and terminal states. Each transition is recorded in an append-only event journal with the verified actor. The canonical lifecycle is defined in the [specification](/spec).

### 7. Fulfillment

The merchant delivers. For digital goods, delivery is the API response or file transfer. For physical goods, fulfillment is the shipment and its tracking events. Fulfillment produces evidence: a delivery note, a hash of the delivered artifact, a signed attestation.

### 8. Evidence verification

The buyer's agent checks the evidence against the acceptance criteria. Did the deliverable match the terms? Was it the right item, right quantity, right quality? This is the least-standardized step — and the one where most disputes begin.

A payment receipt proves money moved. It does not prove the deliverable matched. That gap is why evidence verification is a distinct step with its own authority: the submitter of evidence is rarely the same party as the verifier.

### 9. Recovery

The agent process dies. The network drops. The payment outcome is uncertain. The original buyer agent disappears mid-workflow.

If the only record of the transaction lived inside the agent's memory, everything is lost. Recovery means an independently authorized replacement agent can retrieve the durable commitment, inspect its history, and continue only the permitted next action — without inheriting the original agent's full authority.

This is the scenario SAAX demonstrated in production: a buyer agent accepted, a seller agent began execution, the original agent terminated, and a replacement agent with its own authorization resumed the commitment through the public MCP interface. The event journal recorded each transition with the acting principal. The demonstration was nonfinancial and is documented on the [recovery page](/recovery).

### 10. Completion and dispute

If everything matches, the commitment reaches a terminal state (`fulfilled` or `finalized`). If not, the dispute path begins: an authorized party raises a dispute, an evaluator reviews the evidence, and the lifecycle resolves to a governed outcome — without automatically triggering money movement.

## Where the flow breaks

| Stage | Typical failure | Consequence |
|---|---|---|
| Discovery | Catalog not machine-readable | Agent never finds the product |
| Authorization | Mandate too broad or expired | Agent exceeds user intent |
| Payment | Timeout after send | Outcome unknown; double-charge risk on retry |
| Commitment | No durable record | Both parties disagree on terms after the fact |
| Fulfillment | Deliverable not matching terms | Dispute with no evidence baseline |
| Recovery | No replacement authority | Workflow permanently stuck |

The two most expensive failures are the ones at the edges: **payment without a durable commitment** (money moved, but the agreement is a memory) and **agent failure without recovery** (agreement exists, but no one can continue it).

## The architectural takeaway

Every layer of agentic commerce — discovery, authorization, payment, checkout — exists to make one transaction happen. The layers that make it *durable* are the ones that survived after the transaction: the commitment record, the evidence trail, and the recovery path.

A useful way to think about it: **payment execution is the moment; the commitment is the memory.** A reliable agentic commerce stack needs both.

For the protocol-level detail of how commitments are structured and verified, see [SAAX Protocol: What Exists and What's Missing](/blog/agentic-commerce-rails), the [protocol overview](/protocol), and the [MCP documentation](/docs).