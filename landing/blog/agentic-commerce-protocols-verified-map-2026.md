# Agentic Commerce Protocols in November 2026: A Verified Map of ACP, AP2, UCP, x402, MCP, A2A — and Where a Commitment Layer Fits

*November 8, 2026*

*Last updated: 2026-11-08*

---

The agentic-commerce stack is no longer hypothetical. By late 2026 there are at least six protocols in active use: ACP and ACS for checkout, AP2 for payments authorization, UCP for commerce capabilities, x402 for machine payments, MCP for agent-tool connectivity, and A2A for agent-to-agent tasks. Each solves a real problem. None of them, on its own, defines what happens **after** the checkout completes and the payment settles — when the work is wrong, the agent crashes, or the parties disagree about what was promised.

This article is a verified, primary-source map of those six protocols as of November 2026: what each one officially covers, what its own documentation excludes, and where a durable commitment layer such as SAAX fits around them. Every claim about a protocol is sourced from that protocol's official specification or repository. Where an official source does not state a status label, this article says so instead of guessing.

## The six protocols, at a glance

| Protocol | Maintainer | Official scope | Status per official sources |
|---|---|---|---|
| ACP / ACS | OpenAI, Stripe, Meta (lead maintainers per MAINTAINERS.md) | Checkout sessions; merchant is the system of record | Repository says "currently in beta"; ACS RFC is draft 2026-01-16 |
| AP2 | Google | Agent payments authorization: signed mandates (intent, cart, payment) and payment evidence | Public launch; official mandate specs |
| UCP | Google | Commerce capabilities and lifecycle: discovery, catalog, cart, checkout, orders, post-purchase | Public launch with commerce partners |
| x402 | x402 Foundation (Coinbase repo is a development fork) | HTTP resource payments: signed payment payloads, verification, settlement | V1 and V2 specs; V2 current main |
| MCP | Model Context Protocol (Linux Foundation project) | LLM-to-tool/context connectivity: resources, prompts, tools, lifecycle, authorization | Spec revision 2025-11-25; tasks experimental |
| A2A | Agent2Agent Protocol (Linux Foundation) | Inter-agent discovery, messaging, delegated tasks, async status, artifacts, cancellation | v1.0 materials on official site |

The table is deliberately precise about status. Several projects do not publish a stable/beta/draft label; for those, status is marked UNVERIFIED rather than inferred from publication dates.

## What each protocol actually covers

### ACP and the Agentic Checkout Specification (ACS)

The Agentic Commerce Protocol describes itself as "an interaction model and open standard for connecting buyers, their AI agents, and businesses to complete purchases seamlessly." The Agentic Checkout Specification is its merchant REST API contract: endpoints for creating, updating, retrieving, completing, and canceling checkout sessions, with authoritative cart state, safe POST retries, and webhook order-lifecycle updates.

The ACS RFC is explicit about boundaries: "Out of scope: PSP authorization/capture semantics, returns/exchanges workflows, tax configuration, fraud modeling details." And: "The merchant remains the system of record for all orders, payments, taxes, and compliance."

What this means: ACP standardizes the checkout conversation between an agent and a merchant. The merchant's own systems stay authoritative for orders and payments. There is no merchant-neutral record that survives the relationship.

### AP2 (Agent Payments Protocol)

Google's AP2 introduces signed mandates — Intent Mandates, Cart Mandates, Payment Mandates — that cryptographically capture user authorization and intent for agent payments. It is the authorization-and-evidence layer: it tells a payment processor that an agent was permitted to spend, and it provides signed payment evidence.

AP2 covers **authorization** and **payment evidence**. Its own materials position it as solving the "crisis of trust" in autonomous agent payments by making consent verifiable. What the official scope does not establish is a complete dispute-adjudication or post-failure recovery protocol; the mandate evidence can support dispute review, but AP2 is not a dispute-resolution system.

### UCP (Universal Commerce Protocol)

Google's Universal Commerce Protocol is the broader commerce layer, co-developed with merchants and commerce platforms. It standardizes how agents discover and interact with commerce capabilities: product listing, cart management, checkout, returns, and order lifecycle. UCP is about **capability discovery and commerce lifecycle**, not about the durable record of a specific transaction's terms.

### x402

x402 turns HTTP 402 into a machine payment flow: a client requests a resource, the server returns a payment requirement, the client submits a signed payment credential, and the server verifies and settles. The current main spec is V2, which moved payment data into headers (PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE) and added lifecycle hooks including before/after settlement verification. The x402 repo notes that the Coinbase repository is now a development fork and the protocol is maintained under the x402 Foundation.

x402 covers **payment payloads, verification, and settlement evidence**. It explicitly does not define a commercial commitment, fulfillment verification, dispute, or recovery protocol. A settlement proof answers "did value move between two addresses"; it does not answer "was the work done as agreed."

### MCP (Model Context Protocol)

MCP is the standard for connecting LLM applications to tools and context: resources, prompts, tools, lifecycle, and authorization. It is the connectivity layer that lets an agent call a payment API or a merchant's checkout API. The "tasks" capability is experimental in the current revision for durable requests, but MCP is not a commerce, payment, or records protocol.

### A2A (Agent2Agent Protocol)

A2A standardizes inter-agent interaction: discovery, messaging, delegated tasks, asynchronous status and artifacts, streaming, cancellation, and authentication. It answers "how do two agents coordinate work?" It is not a commercial commitment, payment, dispute, or financial recovery protocol.

## How they relate — and what none of them alone provides

The protocols are layered, not competing:

- A2A plus MCP connect agents to each other and to tools.
- UCP lets an agent discover a merchant's commerce capabilities and move through cart, checkout, orders, post-purchase.
- ACP/ACS standardizes the checkout session itself.
- AP2 authorizes the payment with signed mandates.
- x402 executes and verifies the value transfer.

That is a functional stack for **finding, buying, and paying**. What is not covered by any single protocol's official scope is the layer that survives the transaction: a vendable, merchant-neutral record of what was agreed (terms, acceptance criteria, recovery policy), bound to the payment evidence, that both parties and any future process can verify after the fact.

This is not a claim that the ecosystems "lack" order management or accountability. UCP explicitly covers order lifecycle; AP2 provides signed evidence that supports dispute review; ACP defines order webhooks. The precise, evidence-backed statement is: the official specifications reviewed for this article do not define a cross-party, persistent commitment contract with verification and recovery semantics as their core artifact. That is the gap SAAX addresses — and it is designed to complement these protocols rather than replace them.

## Where SAAX fits: complement, not replacement

SAAX Protocol is a vendor-neutral commitment layer. It defines a commitment lifecycle — authority, terms, acceptance criteria, evidence requirements, recovery policy, settlement linkage, finality — as a first-class, durable record that is created **before** value moves and survives the worker or platform that executed it.

SAAX does not replace any of the six protocols:

- It consumes authority proofs from external systems (AP2-style mandates, verifiable intents, OAuth) rather than issuing identity.
- It does not define checkout; ACP/ACS and UCP handle that layer.
- It is not a payment rail; x402 and others settle value, and SAAX records the settlement reference on the commitment.
- It does not connect agents; MCP and A2A do that, and SAAX exposes its own interface as MCP tools so agents can interact with commitments through the standard tool protocol.

The [SAAX protocol overview](/protocol) says it plainly: SAAX is not a payment network, marketplace, identity provider, or agent framework. It is the durable record those systems can share.

## A concrete lifecycle: where each protocol touches the same transaction

Consider an agent authorized to buy a research report for 0.05 USDC on Base:

1. **Discovery:** UCP (or ERC-8004-style discovery) lets the agent find the merchant's offering. *(Not SAAX.)*
2. **Connectivity:** MCP lets the agent call the merchant's checkout API; A2A coordinates any sub-agent work. *(Not SAAX.)*
3. **Checkout:** ACP/ACS creates and completes the checkout session; the merchant remains the system of record. *(Not SAAX.)*
4. **Authorization:** AP2 issues a signed payment mandate for the amount and merchant. *(Not SAAX — SAAX can reference such proofs.)*
5. **Payment:** x402 returns the challenge; the agent settles; the chain records the transfer. *(Not SAAX — but the transaction reference is recorded on the SAAX commitment.)*
6. **Commitment and recovery:** SAAX records, before or at payment time, what was agreed, what counts as fulfillment, and what happens if the agent crashes or the work is wrong. The commitment ID travels in the payment's external-reference field, and the receipt endpoint resolves the transaction hash back to the commitment. *(This is SAAX.)*

Step 6 is the one that makes the other five auditable after the fact. If the agent crashes after payment, the commitment survives and a replacement process can find it. If the buyer disputes the deliverable, there is a signed record of the acceptance criteria and the recovery policy.

## What SAAX has implemented today (verified, not aspirational)

SAAX's [current status page](/status) distinguishes implemented capability from aspiration. As of this release:

- **Live on Base mainnet:** immediate x402 payments; the Router settles USDC on Base, operated by the SAAX team. The live rail is x402; the MPP rail implementation exists but is not registered in production (the production log shows x402-only mode).
- **Beta, publicly deployed:** signed Discovery profile, free preflight, buyer acceptance creating one authenticated commitment; MCP tools including prepare_commitment and accept_commitment; receipt lookup by transaction hash.
- **Testnet preview only:** escrow custody on Base Sepolia with real test-USDC funding, release, refund, and independent export verification — operator-run, not a public financial API.
- **Under development / security review:** Custody V3 candidate (local EVM only; owner-approved snapshot for independent review; review not completed).
- **Financial-limit infrastructure:** deployed with enforcement OFF; pilot allowlist not populated.

SAAX's own documentation is explicit that internal tests are not an independent audit, and that dispute resolution and recovery are bounded: disputed testnet funds can remain frozen if the evaluator disappears; mainnet immediate payments are final and non-custodial.

## The takeaway

ACP, AP2, UCP, x402, MCP, and A2A each own a piece of the agent-commerce stack: checkout, authorization, discovery, settlement, tool connectivity, and agent communication. None of them, per its official scope, owns the persistent, merchant-neutral commitment record with verification and recovery semantics.

That is the layer SAAX builds — and it is built to sit alongside the six, consuming their outputs and referencing their proofs, not replacing them.

Next step: read the [SAAX protocol overview](/protocol) and the [commitment lifecycle specification](/spec), then try the [public preflight and acceptance flow](/docs#discovery-quickstart) — it creates a signed commitment without moving funds. If you are building agent commerce on ACP, AP2, UCP, or x402, the question worth asking is: what survives the transaction?
