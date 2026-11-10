# Agentic Commerce Protocols Explained: AP2, x402, ACP, and UCP

*October 11, 2026* 

*Last updated: 2026-10-17*

---

The infrastructure for agentic commerce is being built at an unprecedented pace. Four major protocols are competing to define how agents authorize, pay for, and complete transactions. Here is what each one does, what it doesn't, and where the gaps remain.

## AP2 (Agent Payments Protocol)

Google's protocol, launched with 60+ partners including Mastercard, PayPal, American Express, and Coinbase. AP2 introduces Verifiable Credentials — Intent Mandates, Cart Mandates, and Payment Mandates — that cryptographically capture user authorization and intent. The goal is to solve the "crisis of trust" inherent in autonomous agent payments.

**What it handles:** Authorization.

**What it doesn't:** It does not record what the agent actually committed to, what counts as fulfillment, or what happens when the deliverable doesn't match the agreement.

## x402

Coinbase's protocol, released four months before AP2 appeared. It revives HTTP status code 402 ("Payment Required") and makes payment a native HTTP operation. Request a paid resource, receive a 402 response with payment terms, send payment, get the resource. By October 2025, x402 processed 500,000 weekly transactions.

**What it handles:** Settlement.

**What it doesn't:** It does not verify whether the deliverable matched the agreed terms. It proves payment moved, not that fulfillment occurred.

## ACP (Agentic Commerce Protocol)

OpenAI and Stripe's protocol, currently in beta. It defines the Agentic Checkout Specification (ACS) as a REST API contract for agents to complete purchases. The merchant remains the system of record — same principle as UCP, but more focused on the checkout flow.

**What it handles:** Checkout.

**What it doesn't:** It does not provide a structured commitment record that survives the transaction. The checkout completes; the record of what was agreed is held by the merchant, not by a neutral artifact both parties can reference.

## UCP (Universal Commerce Protocol)

Google's broader commerce protocol, co-developed with Shopify, Etsy, Wayfair, Target, and Walmart. UCP lets merchants declare their capabilities (product listing, cart management, checkout, returns) through a standardized profile, and agents discover those capabilities dynamically.

**What it handles:** Capability discovery.

**What it doesn't:** It does not bind the terms of a specific transaction. Discovery is the first step; commitment is the record of what was actually agreed.

## The gap none of them close

Each protocol handles a different piece of the agent commerce stack. AP2 handles authorization. x402 handles settlement. ACP handles checkout. UCP handles capability discovery.

As of their currently published scope, none of them specifies the commitment layer — the structured record of what the agent actually agreed to, what counts as fulfillment, and what happens when fulfillment fails. Protocol scope evolves; verify each protocol's current specification before relying on this comparison.

This is the gap that matters when something goes wrong. A signed payment mandate proves the transaction was permitted. It does not prove the deliverable matched the agreement. When an agent buys wrong, there's no structured record to resolve the dispute against.

## What a commitment layer adds

A commitment layer records the authority, terms, acceptance criteria, evidence requirements, and recovery policy before execution begins. It survives the transaction. It is the artifact both parties work from if something goes wrong.

A commitment ID can prevent double-charging when the execution and settlement layers enforce durable deduplication on it; the identifier alone is not sufficient. If the fulfillment doesn't match the agreement, the commitment record is the evidence. If a dispute arises, the recovery policy was set at commitment time — but enforcing it still depends on the parties and the settlement mechanism, and is not guaranteed.

The spec is at [saax-protocol.com/spec](/spec). The conformance suite is at [saax-protocol.com/conformance](/conformance). The commitment lifecycle, the evidence interface, and the settlement-linkage model are documented there.