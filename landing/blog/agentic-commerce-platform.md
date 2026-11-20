# What Is Agentic Commerce? How an Agentic Commerce Platform Works

*SAAX Protocol — developer education series*

*November 19, 2026*

---

Agentic commerce is the practice of an AI agent completing part or all of a purchase on a person's or business's behalf. Instead of a human searching for a product, comparing options, and checking out, a software agent does the work — and, increasingly, the agent also authorizes the payment, tracks the delivery, and handles the aftermath when something goes wrong.

This article answers two questions directly: **what is agentic commerce?** and **what is an agentic commerce platform?** It then walks through a complete industrial purchasing example — a maintenance agent reordering a replacement filter — showing exactly what each system in the stack verifies, and where the gaps are.

---

## What is agentic commerce?

Agentic commerce is the category of transactions initiated, negotiated, authorized, or executed by AI agents rather than by humans directly. It spans:

- **Consumer-facing agents** — an assistant that researches and buys products for a person.
- **Business-facing agents** — procurement agents, inventory agents, and operations agents that buy goods and services for a company.
- **Agent-to-agent transactions** — one agent paying another agent for data, compute, or services.

The defining feature is not the payment method. It is that a *machine* makes decisions with real commercial consequences — and that the machine can fail, be interrupted, or be impersonated.

## What is an agentic commerce platform?

An agentic commerce platform is the infrastructure that lets agents discover, authorize, pay for, and track commercial transactions. A platform typically provides some combination of:

- **Discovery** — machine-readable product catalogs agents can search (e.g., UCP capability profiles, ACP product feeds).
- **Authorization** — verifiable proof that the agent is permitted to spend a specific amount with a specific counterparty (e.g., AP2 mandates).
- **Payment** — a machine-native payment rail (e.g., x402's HTTP-402 flow, stablecoin settlement).
- **Checkout** — a structured purchase flow an agent can execute (e.g., ACP's Agentic Checkout Specification).
- **Commitment and recovery** — a durable record of what was agreed, what counts as fulfillment, and what happens when the agent fails.

The confusion in the market is that these layers are often described as one thing. They are not interchangeable. **An AI agent** is the actor that decides and acts. **A commerce platform** is the marketplace or checkout infrastructure. **A payment mechanism** is how value moves. **A durable commitment record** is the surviving artifact that documents what was agreed.

A payment mechanism proves money moved. It does not prove the deliverable matched the agreement. That distinction is the whole reason the commitment layer exists.

---

## The worked example: an industrial filter reorder

Consider a manufacturing plant with an autonomous procurement agent. A replacement filter is needed for a production line.

### 1. Spending authorization

The plant operator authorizes the agent: "You may spend up to $400 with approved suppliers on replacement filters for line 3." This is a *mandate* — scoped, bounded, and recorded. In AP2 terms, this is an Intent Mandate: the operator's intent, signed.

**What this verifies:** the agent is permitted to act at all, within defined limits.

### 2. Supplier discovery

The agent queries machine-readable supplier catalogs. It finds three suppliers with the filter in stock, with prices, delivery dates, and part numbers.

**What this verifies:** the product exists and is available. It does not verify quality or suitability.

### 3. Product requirements

The agent matches the filter against the plant's requirements: the correct part number, the correct specifications (filtration rating, thread size, flow rate).

**What this verifies:** the candidate product nominally matches the requirement. Nothing has been purchased yet.

### 4. Quote

The agent requests a quote from the chosen supplier: price, delivery, terms. The supplier returns a structured quote.

**What this verifies:** the commercial offer. The quote is the basis of the eventual agreement.

### 5. Part-number verification

The agent cross-checks the supplier's part number against the plant's approved parts list and, where available, the manufacturer's data. This is a real verification step — a wrong part number has caused more agentic-commerce failures than payment failures.

**What this verifies:** the part number matches an approved reference. It does not verify the physical item in the box.

### 6. Purchase approval

The agent assembles the quote, the verification result, and the authorization reference, and requests approval — either from the operator directly, or automatically if the mandate allows.

**What this verifies:** the purchase is authorized by the principal.

### 7. Order acceptance

The supplier accepts the order. At this point, both parties have agreed to terms: product, price, delivery, acceptance criteria.

**What this verifies:** mutual agreement exists. This is where a durable commitment record should be created — before payment, not after.

### 8. Payment

The agent pays. With x402, the payment is an HTTP operation: the agent receives a 402 response with payment terms, sends USDC, and receives a receipt. With a card rail, the agent uses tokenized payment credentials.

**What this verifies:** value moved from buyer to seller. It does **not** verify that the correct filter was shipped, or that it works.

### 9. Receipt

The agent receives a receipt: a transaction hash, a payment reference, or an invoice. The receipt is evidence of payment — nothing more.

**What this verifies:** the payment occurred. A receipt is not proof of fulfillment, quality, or conformity.

### 10. Agent failure

The purchasing agent's process crashes. The network drops. The payment was sent, but the order status is unknown. The original agent is gone.

**What breaks:** everything the agent held in memory — the order context, the authorization reference, the next step — is lost with it.

### 11. Replacement-worker recovery

A replacement agent — independently authorized by the same principal — resumes the workflow. It needs to know: What was ordered? From whom? At what price? Was payment sent? What is the acceptance criteria? What is the next permitted action?

This is where a durable commitment record earns its keep. If the original transaction created a commitment — parties, terms, authorization reference, evidence requirements, recovery policy — the replacement agent can reconstruct the entire context and continue safely. It does **not** inherit the original agent's authority; it has its own, scoped to the same commitment. It must not blindly retry the payment, because the payment may already have succeeded.

**What this verifies:** the replacement agent can reconstruct the transaction from durable state and avoid unsafe retries. It does not independently verify the physical filter.

---

## Where SAAX fits

SAAX is a vendor-neutral commitment and recovery layer for autonomous commerce. It complements MCP (agent-tool interoperability), x402 (payment execution), AP2 (payment authorization), and ACP (checkout) by providing the durable record that survives the transaction.

SAAX does not process payments. It does not run a marketplace. It records commitments — who agreed, to what, under what evidence requirements, with what recovery policy — and provides the lifecycle, authorization, evidence, and recovery tooling around them. The principle is simple: **the commitment must outlive the worker.**

The protocol's current status is published on the [status page](/status): immediate x402 payments are available on Base mainnet, escrow functionality is testnet-only, and the Financial Recovery Engine custody candidates are local demonstrations not yet deployed to production. The [specification](/spec) and [conformance suite](/conformance) document the commitment lifecycle, the evidence interface, and the settlement-linkage model.

If you are building an agentic commerce integration, the question worth asking is: **what survives the transaction?** The payment is the moment. The commitment is the memory.

## Sources

The protocol comparisons in this article reference the following primary documentation:

- **MCP** (Model Context Protocol) — [official specification](https://modelcontextprotocol.io/specification/), maintained by the Agentic AI Foundation (Linux Foundation).
- **x402** — [x402 specification v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) and [x402.org](https://x402.org), the machine-payment standard.
- **AP2** (Agent Payments Protocol) — [AP2 specification](https://ap2-protocol.org/ap2/specification/) and [AP2 repository](https://github.com/google-agentic-commerce/AP2).
- **ACP** (Agentic Commerce Protocol) — [agentic-commerce-protocol repository](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol).
- **A2A** (Agent2Agent) — [a2a-protocol.org](https://a2a-protocol.org).
- **EAS** (Ethereum Attestation Service) — [attest.org](https://attest.org) and [EASScan](https://easscan.org).
- **Protocol ecosystem registry** — [agenticcommerceprotocol.info](https://agenticcommerceprotocol.info/), a dated, source-linked registry of commerce, payment-authorization, and machine-payment standards.

Protocol scopes evolve. Verify each protocol's current specification before relying on this comparison.

*AI disclosure: This article was developed with AI assistance and reviewed by the SAAX team. Claims about external protocols are sourced from official documentation linked in the text; SAAX status claims reflect the published status page. Nothing here is an independent audit, certification, or production-custody approval.*

**Next step:** read the [protocol overview](/protocol) and the [commitment lifecycle specification](/spec), then try the [public preflight and acceptance flow](/docs) — it creates a signed commitment without moving funds.
