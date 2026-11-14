# MCP, x402, AP2, ACP, and EAS: The Agentic Commerce Stack, Explained

*November 14, 2026*

---

When people talk about "agentic commerce infrastructure," they are usually talking about five different protocols that do five different jobs. This article maps the stack: what each protocol is, what it settles, what it does not, and how they fit together.

## The five protocols at a glance

| Protocol | Maintainer | Layer | What it does |
|---|---|---|---|
| **MCP** | Anthropic (open standard) | Tool access | Lets AI models call tools and read data through a standard interface |
| **x402** | Coinbase (open standard) | Payment execution | Makes payment a native HTTP operation for agents |
| **AP2** | Google → FIDO Alliance | Authorization | Signed mandates proving a user allowed an agent to pay |
| **ACP** | OpenAI + Stripe + Meta | Checkout | Defines how an agent and a business complete a purchase |
| **EAS** | Ethereum Attestation Service | Verifiable records | On-chain or off-chain attestations that something is true |

Each one answers a different question. Knowing which question each answers is how you avoid building the wrong layer.

## MCP — the tool access layer

The Model Context Protocol, introduced by Anthropic in November 2024, standardizes how AI systems connect to external tools and data. It is often called "the USB-C for AI applications": build a tool server once, and any MCP-capable client (Claude, ChatGPT, VS Code, Cursor) can use it.

MCP answers: **"How does an agent call a tool?"**

What MCP does not answer: **"What happens after the tool call creates a business obligation?"** MCP carries tool requests and responses; it does not define commitments, payments, or dispute resolution. An MCP server can expose a checkout tool, but the protocol itself does not guarantee the checkout is durable.

## x402 — the payment execution layer

Coinbase's x402 (announced May 2025) makes payment a native HTTP exchange. A server responds to a request with HTTP 402 and payment terms; the agent pays in USDC on Base; the server verifies and releases the resource. By mid-2026, x402 had processed 165 million agent transactions, and a foundation including Visa, Mastercard, and Stripe supports it.

x402 answers: **"How does an agent pay for something?"**

What x402 does not answer: **"Did the deliverable match the agreement?"** Payment moves money; the receipt proves money moved. Whether the resource delivered was the right one, in the right condition, is outside the protocol's scope.

## AP2 — the authorization layer

Google's Agent Payments Protocol (launched September 2025 with 60+ partners, including Mastercard, PayPal, American Express, and Coinbase) defines Verifiable Credentials — Intent Mandates, Cart Mandates, and Payment Mandates — that cryptographically capture user authorization. In 2026, Google donated AP2 to the FIDO Alliance to steward it.

AP2 answers: **"Did the user allow this agent to spend this amount, on this, at this time?"**

What AP2 does not answer: **"What were the full commercial terms, and what counts as fulfillment?"** A mandate is an authorization artifact, not a complete agreement record. It expires, it is scoped, and it is silent on what happens after the payment if the delivery is wrong.

## ACP — the checkout layer

The Agentic Commerce Protocol, co-developed by OpenAI, Stripe, and Meta (announced September 2025), defines how an agent and a business interact to complete a purchase. It powers experiences like Instant Checkout in ChatGPT (Stripe).

ACP answers: **"How does an agent complete a checkout with a merchant?"**

What ACP does not answer: **"What happens after checkout when the agent process dies or the fulfillment fails?"** ACP defines the flow to buy; the durable record of what was agreed — and what to do about it later — is left to the merchant's systems and any commitment layer built on top.

## EAS — the verifiable-record layer

The Ethereum Attestation Service is an open protocol for creating attestations — signed statements about anything — on-chain or off-chain (attest.org). EAS lets any party register a schema and issue attestations that others can verify independently.

EAS answers: **"How do we make a verifiable claim that survives the systems that created it?"**

EAS does not by itself define commerce semantics: an attestation proves someone signed a statement, not that the statement is true or that it fulfills a contract. Used well, it anchors evidence (delivery notes, verification results, commitment hashes) so the record can be checked long after the original systems are gone.

## How they fit together

A complete agentic purchase uses them in sequence:

```
MCP  →  agent discovers and calls tools
AP2  →  user authorization, captured as signed mandates
x402 →  payment moves (USDC over HTTP)
ACP  →  checkout flow between agent and merchant
EAS  →  optional anchoring of the commitment + evidence records
```

None of these five defines the **commitment layer** — the structured record of the parties, terms, acceptance criteria, evidence requirements, and recovery policy that exists before the transaction and survives it.

That is the layer the commitment lifecycle fills: a versioned state machine with durable event history, identity-bound authorization, evidence verification, and authorized recovery. It uses the other protocols where they are strongest — payment execution via x402, authorization evidence via AP2-style mandates, discoverability via MCP — and adds the durable record none of them specifies.

The SAAX implementation of this layer is documented in the [specification](/spec), with integration guidance in [What Exists and What's Missing](/blog/agentic-commerce-rails) and the [Verified Map of Protocols](/blog/agentic-commerce-protocols-verified-map-2026).

## Choosing your stack

- If you are a merchant: make your catalog agent-discoverable (structured feeds, ACP/UCP profiles), support machine-readable payment terms (x402), and decide your mandate rules (AP2-style).
- If you are a platform: choose MCP for tool exposure, a payment rail for settlement, and a commitment layer for the durable record.
- If you are a buyer of agent services: demand an architecture that records what was agreed before money moves, and that can recover when the agent fails.

The stack is young but the pattern is clear: execution, authorization, and checkout are all being standardized. The durable agreement record is the remaining gap — and it is the layer that turns a convenient demo into something you can rely on.