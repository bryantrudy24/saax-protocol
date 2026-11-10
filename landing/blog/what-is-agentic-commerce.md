# Agentic Commerce Foundations: The Complete Guide

*October 11, 2026* 

*Last updated: 2026-10-17*

---

Agentic commerce is the practice of an AI agent completing part or all of a purchase on a person's behalf. Instead of you searching for a product, reading reviews, and buying it, you tell an assistant what you want and it does the work.

The demand signal is hard to ignore. US searches for "agentic commerce" are up 408% year on year. But the category is still early — most purchases are still human, and the infrastructure to make agent commerce trustworthy is still being built.

## The two sides of agentic commerce

**Consumer-facing agents** are the ones most people have heard of. You tell ChatGPT, Gemini, or Claude what you want to buy, and the agent researches, compares, and potentially completes the purchase. Google has been folding agentic checkout into AI Mode and AI Overviews. Shopify, Etsy, Wayfair, Target, and Walmart have all signed on to Google's Universal Commerce Protocol (UCP) to make their products discoverable by agents.

**Business-facing agents** are where the real volume exists today. Companies are deploying agents for procurement, research, data processing, and vendor management. The agents transact with external services — API calls, data lookups, subscriptions — and the payment rails to support this are maturing fast.

The distinction matters because the trust threshold is different. A consumer letting an agent buy a $50 product is a different risk profile from a business letting an agent commit to a $5,000 contract.

## The protocols trying to define how agents pay

Four major protocols are competing to become the standard for agent payments:

**AP2 (Agent Payments Protocol).** Google's protocol, launched with 60+ partners including Mastercard, PayPal, American Express, and Coinbase. AP2 introduces Verifiable Credentials — Intent Mandates, Cart Mandates, and Payment Mandates — that cryptographically capture user authorization and intent. The goal is to solve the "crisis of trust" inherent in autonomous agent payments.

**x402.** Coinbase's protocol, released four months before AP2 appeared. It revives HTTP status code 402 ("Payment Required") and makes payment a native HTTP operation. Request a paid resource, receive a 402 response with payment terms, send payment, get the resource. By October 2025, x402 processed 500,000 weekly transactions.

**ACP (Agentic Commerce Protocol).** OpenAI and Stripe's protocol, currently in beta. It defines the Agentic Checkout Specification (ACS) as a REST API contract for agents to complete purchases. The merchant remains the system of record — same principle as UCP, but more focused on the checkout flow.

**UCP (Universal Commerce Protocol).** Google's broader commerce protocol, co-developed with Shopify, Etsy, Wayfair, Target, and Walmart. UCP lets merchants declare their capabilities (product listing, cart management, checkout, returns) through a standardized profile, and agents discover those capabilities dynamically.

## The gap none of them close

Each of these protocols handles a different piece of the agent commerce stack. AP2 handles authorization. x402 handles settlement. ACP handles checkout. UCP handles capability discovery.

None of them handle the commitment layer — the structured record of what the agent actually agreed to, what counts as fulfillment, and what happens when fulfillment fails.

This is the gap that matters when something goes wrong. A signed payment mandate proves the transaction was permitted. It does not prove the deliverable matched the agreement. When an agent buys wrong, there's no structured record to resolve the dispute against.

## What agentic commerce needs to scale

The infrastructure exists. The demand is growing. The missing piece is trust — the ability for a buyer to enter a transaction with an agent they've never used before and know that the outcome is verifiable.

That's what a commitment layer adds. It records the authority, terms, acceptance criteria, evidence requirements, and recovery policy before execution begins. A commitment ID can prevent double-charging only when the settlement layer enforces durable deduplication — the same ID must be recognized as the same intent and the same payment authorization must not settle twice. If the fulfillment doesn't match the agreement, the commitment record is the evidence.

For the integration details, see the [integration guide](/docs): MCP connection, immediate x402/MPP payments on Base mainnet, and the testnet-only escrow flow. For a closer look at the individual protocols, see [Agentic Commerce Protocols Explained: AP2, x402, ACP, and UCP](/blog/agentic-commerce-protocols-explained), which compares what each one handles and what it does not. The spec is at [saax-protocol.com/spec](/spec) and the conformance suite at [saax-protocol.com/conformance](/conformance); the commitment lifecycle, the evidence interface, and the settlement-linkage model are documented there.
