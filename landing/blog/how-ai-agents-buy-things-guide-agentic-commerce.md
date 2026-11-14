# How AI Agents Buy Things: A Plain-English Guide to Agentic Commerce

*November 14, 2026*

---

You tell an assistant what you want, and it goes and buys it. That is agentic commerce, and in 2026 it is moving from demos to real transactions. This guide explains how it works in plain English, what is already real, and what is still being built.

## What agentic commerce means

Agentic commerce is the practice of an AI agent completing part or all of a purchase on a person's behalf. Instead of you searching for a product, reading reviews, and checking out, you describe what you want and an agent does the comparison, selection, and purchase.

Two flavors exist today:

- **Consumer-facing agents**: You ask ChatGPT, Gemini, Claude, or another assistant to buy something. The agent researches options, presents a choice, and can complete the purchase with your approval.
- **Business-facing agents**: Companies deploy agents for procurement, vendor management, subscriptions, and data access. These agents transact with external services continuously, not one purchase at a time.

The trust threshold is different. Letting an agent buy a $50 item is a different risk from letting it commit to a $5,000 contract. Most of the infrastructure being built in 2026 is about making the second case safe enough to trust.

## How an agent actually buys something

A purchase by an agent looks like a series of machine-to-machine messages rather than a human filling in a form:

1. **Intent.** You tell the agent what you want, with constraints (budget, delivery time, brand preferences).
2. **Discovery.** The agent searches catalogs and product feeds that are structured for machine reading. Retailers expose their inventory through standardized profiles so agents can find them.
3. **Selection.** The agent compares options against your constraints and picks one. You may confirm the choice, or the agent may have standing authority to decide.
4. **Authorization.** The agent proves it is allowed to spend on your behalf. This is where protocols like Google's AP2 (Agent Payments Protocol) and the Agentic Commerce Protocol (ACP) from OpenAI and Stripe enter: they define cryptographically signed mandates that capture your intent and limit what the agent may do.
5. **Payment.** The agent pays. Coinbase's x402 protocol makes payment a native HTTP operation, returning HTTP 402 with payment terms so an agent can pay in USDC and receive the resource. By 2026 x402 had processed over 165 million agent transactions.
6. **Fulfillment and verification.** The merchant delivers, and both sides need evidence that the deliverable matched the agreement. This is the newest and least standardized layer.
7. **Recovery.** If the agent process dies mid-transaction, something must preserve the record of what was agreed so a replacement agent can continue. This is the durability problem.

Each step has its own infrastructure, and no single protocol covers all of them.

## What is already real in 2026

The market signals are concrete, not hypothetical:

- **Forrester** reported that 11% of US online transactions over $75 already involve an AI agent.
- **Shopify** reported AI-driven traffic to its stores tripled year over year in Q2 2026.
- **Morgan Stanley** estimated agentic shoppers could represent $190–385 billion in US e-commerce sales by 2030, capturing 10–20% of market share, with 23% of US adults already having tried an agentic shopping assistant.
- **Bain** projected AI agents could drive 15–25% of US e-commerce sales by 2030, a $300–500 billion market.
- **McKinsey** sized the global opportunity at $3–5 trillion by 2030 (goods only).
- **Juniper Research** estimated agentic commerce transaction value at $8 billion in 2026, growing to $3.5 trillion by 2031.

These forecasts come from different methodologies and should be treated as directional. The one consistent conclusion: agentic commerce is growing quickly enough that merchants and developers are already building for it.

## The four protocols you will hear about

- **x402 (Coinbase)** — payment execution over HTTP. Lets an agent pay for a resource with stablecoins. It proves money moved; it does not by itself prove the deliverable matched the agreement.
- **AP2 (Google, now donated to the FIDO Alliance)** — authorization. Cryptographically signed mandates (Intent, Cart, Payment) capture what the user allowed the agent to do.
- **ACP (OpenAI + Stripe + Meta)** — checkout. Defines how an agent and a business complete a purchase, powering experiences like Instant Checkout in ChatGPT.
- **MCP (Anthropic)** — tool access. The standard way agents connect to tools and data; the "USB-C for AI" that lets an agent use a merchant's API.

These protocols are complementary. Each solves one layer of the stack.

## What is still missing

The layer that remains thinnest is the **durable agreement record**:

- What exactly did the agent commit to? Not just the payment amount, but the terms, acceptance criteria, and delivery expectations?
- What counts as fulfillment? Who verifies the deliverable matched the agreement?
- What happens when the agent process dies, the network drops, or the outcome is uncertain?
- Who is authorized to continue if the original agent disappears?

Payment authorization proves permission. Payment execution proves money moved. Neither proves that the deliverable matched what was promised, and neither preserves the agreement if the worker vanishes.

This is the problem a commitment layer addresses. A commitment is a structured record — parties, terms, authorization, acceptance criteria, evidence requirements, and recovery policy — created *before* execution and durable *after* it. It is the artifact both sides work from when something goes wrong.

You can read how SAAX structures that layer in the [protocol overview](/protocol), the [specification](/spec), and the [commitment lifecycle documentation](/docs). A worked example of an agent order flow is in [From Intent to Fulfillment](/blog/agentic-commerce-order-flow), and the failure-recovery side is covered in [AI Agent Security in 2026](/blog/ai-agent-security-identity-authorization-recovery).

## Where to start

If you are a business evaluating agentic commerce:

1. Make your product data machine-readable and well-structured. Agents discover through structured feeds and standardized profiles.
2. Decide your authorization model: what an agent may do without a human, and what always requires approval.
3. Define your fulfillment evidence: how you prove a deliverable was delivered, and how a buyer's agent verifies it.
4. Plan for failures: what happens when an agent retries, when a payment outcome is unknown, and when a process dies mid-order.

The infrastructure is young but moving fast. The businesses that will benefit are the ones that treat agent customers as first-class customers with the same rigor as human ones.