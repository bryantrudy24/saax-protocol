# How Do Agentic Commerce Protocols Secure a Transaction?

*SAAX Protocol — developer education series*

*November 19, 2026*

---

An agentic commerce protocol is a defined set of rules and interfaces that let AI agents discover, authorize, pay for, and track commercial transactions in a machine-verifiable way. The security question is not "can agents act?" — it is "how do we know the right agent acted, within the right limits, for the right purpose, and that the outcome can be verified afterward?"

This article answers that question directly, continuing the industrial filter purchase from [What Is Agentic Commerce? How an Agentic Commerce Platform Works](/blog/agentic-commerce-platform) — but this time the purchase goes wrong.

---

## The scenario: payment succeeds, then the agent times out

The plant's procurement agent has ordered the replacement filter. Payment succeeded — USDC moved from buyer to seller via x402, and a receipt was issued. Then the purchasing agent's process times out and dies.

The buyer later receives the shipment and disputes it: the filter does not conform to the specification. The part number is right, but the filtration rating is wrong.

This is the case that separates agentic commerce security from ordinary payment security. The payment was authorized. The money moved. The dispute is about *fulfillment*, not about whether the payment was permitted.

## What each system in the stack actually verifies

### Authorization

Authorization answers: "was this agent permitted to pay?" Google's AP2 (Agent Payments Protocol) captures this with verifiable credentials — Intent, Cart, and Payment Mandates — signed by the principal. The mandate limits amount, payee, items, and expiry.

**What it verifies:** the agent had permission. **What it does not:** whether the delivered goods matched the mandate.

### Payment confirmation

Payment answers: "did value move?" Coinbase's x402 makes payment an HTTP operation — request a resource, receive a 402 with payment terms, pay in USDC, receive the resource. The receipt proves the transfer.

**What it verifies:** value moved from buyer to seller. **What it does not:** that the correct filter was shipped, or that it works.

### Order evidence

Order evidence answers: "what was actually agreed?" A durable commitment record captures the parties, terms, acceptance criteria, evidence requirements, and recovery policy — before payment, not after. This is the artifact the buyer and seller both reference when the filter arrives wrong.

**What it verifies:** the terms of the agreement, durably recorded. **What it does not:** that the seller performed.

### Delivery evidence

Delivery evidence answers: "was the deliverable provided?" This can be a delivery note, a tracking event, a hash of a delivered digital artifact, or a signed attestation from a delivery system.

**What it verifies:** something was delivered. **What it does not:** that the delivered item matched the specification. A delivery receipt for a box is not proof of the filtration rating inside it.

### Dispute authority

Dispute authority answers: "who decides when the buyer and seller disagree?" In a governed dispute flow, an authorized evaluator — not the buyer, not the seller — reviews the evidence and issues a decision.

**What it verifies:** the decision came from the authorized party under the agreed rules. **What it does not:** that the decision is factually correct. A valid signature proves who signed, not that the underlying claim is true.

### Evaluator fallback

Evaluator fallback answers: "what happens when the evaluator disappears?" SAAX's Financial Recovery Engine design includes a preauthorized fallback evaluator — agreed before funding, eligible only under defined conditions, with a defined decision scope. A timeout alone never authorizes a release or refund.

**What it verifies:** a fallback exists and is bound by the same rules. **What it does not:** that a fallback decision is more trustworthy than the primary one.

### Financial enforcement

Financial enforcement answers: "does the authorized decision actually move money?" In the custody architecture, the escrow contract holds the funds and enforces the release/refund rules — the contract itself rejects unauthorized, replayed, or premature settlement. An approved refund decision is executed by the contract; a forged one is rejected.

**What it verifies:** the financial effect matches the authorized decision. **What it does not:** that the decision was correct about the real world.

### Settlement verification

Settlement verification answers: "did the transfer actually confirm?" A transaction hash is not proof of finality. The system must observe the chain, confirm the transfer, and reconcile its durable records with the actual contract and token balances.

**What it verifies:** the on-chain outcome. **What it does not:** that the physical filter conforms.

---

## Why a payment receipt cannot prove delivery

A payment receipt establishes that a transfer occurred — the amount, the asset, the sender, the recipient, the transaction hash. It is excellent evidence of *payment*. It is not evidence of *fulfillment*.

The logic is simple: the payment and the delivery are different events, performed by different actors, at different times, with different evidence. A receipt for the payment says nothing about the state of the filter in the box. The same logic applies to cryptographic evidence more broadly:

- A **signature** proves who signed a message — not that the message's claims are true.
- A **hash** proves a file was not altered after it was hashed — not that the contents are accurate.
- An **EAS attestation** anchors a claim on-chain, providing integrity and provenance — it does not independently establish that the physical event occurred.
- A **transaction submission** proves a transfer was attempted — not that it settled.

Each of these is a layer of evidence. They stack. None of them alone establishes real-world truth.

## Token terminology: three different "tokens"

The word "token" is overloaded in agentic commerce. There are at least three distinct meanings:

1. **Authorization credentials** — e.g., AP2 verifiable credentials, OAuth tokens, JWTs. These prove permission to act; they are not value.
2. **Tokenized payment credentials** — e.g., a card token that represents a payment instrument. These enable payment; they are not the payment itself.
3. **Blockchain assets** — e.g., USDC, a tokenized stablecoin. These are the value being transferred.

These are not interchangeable. An authorization token does not pay a bill. A payment credential does not prove the agent was authorized. A blockchain asset does not prove the purchase was permitted. A system's security depends on which "token" it means — and confusing them is how agentic commerce vulnerabilities happen.

## How the protocol layers complement each other

The current agentic commerce protocols form a stack, not competing monoliths:

- **MCP** connects agents to tools (Model Context Protocol).
- **A2A** connects agents to agents (Agent2Agent).
- **AP2** authorizes agent payments (Google's Agent Payments Protocol).
- **x402** executes machine-native payments (Coinbase's protocol).
- **ACP** defines agentic checkout (OpenAI and Stripe's Agentic Commerce Protocol, including the Agentic Checkout Specification).
- **MPP** (Machine Payments Protocol) and EAS (Ethereum Attestation Service) also play roles in payment and evidence anchoring respectively.

SAAX is designed to complement these — recording the durable commitment, the evidence trail, the dispute lifecycle, and the settlement authorization around them. It is not a replacement for any of them. It does not process payments, run a marketplace, or provide identity. It preserves and governs the commercial commitment lifecycle.

Protocol scopes evolve. Verify each protocol's current specification before relying on this comparison; the sources reviewed for this article are linked in the text.

## Where SAAX stands today

SAAX's current release state is published on the [status page](/status):

- Immediate x402 payments: available on Base mainnet.
- Escrow functionality: testnet-only.
- Financial Recovery Engine custody candidates (including the preauthorized fallback): local demonstrations, not deployed to production.
- Independent security audit: not completed. The protocol's conformance suite and internal adversarial tests are not an independent audit.

The commitment lifecycle, evidence interface, authorization model, and settlement-linkage are documented in the [specification](/spec); the conformance suite is at [/conformance](/conformance).

## The security checklist

When evaluating an agentic commerce system, ask:

1. Is the agent's identity derived from a verified cryptographic signature, not a self-asserted field?
2. Are permissions commitment-scoped, least-privilege, expiring, and revocable?
3. Does revocation take effect immediately — even against a replayed request?
4. Is the commitment state durable, independent of the agent process?
5. Can an authorized replacement agent recover the workflow? Is an unauthorized one rejected?
6. Are duplicate requests idempotent — no double-charge on retry?
7. Are grant, revocation, transition, and evidence actions auditable with verified actor identity?
8. Does the custody contract itself enforce the settlement rules — not just the application layer?
9. Does the system distinguish *authorized* from *factually true*?
10. What survives when every agent in the workflow disappears?

The commitment must outlive the worker — and an authorized financial remedy must have an actual mechanism capable of executing it.

## Sources

The protocol comparisons in this article reference the following primary documentation:

- **AP2** (Agent Payments Protocol) — [AP2 specification](https://ap2-protocol.org/ap2/specification/) and [AP2 repository](https://github.com/google-agentic-commerce/AP2).
- **x402** — [x402 specification v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) and [x402.org](https://x402.org).
- **ACP** (Agentic Commerce Protocol) — [agentic-commerce-protocol repository](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol).
- **MCP** (Model Context Protocol) — [official specification](https://modelcontextprotocol.io/specification/).
- **A2A** (Agent2Agent) — [a2a-protocol.org](https://a2a-protocol.org).
- **EAS** (Ethereum Attestation Service) — [attest.org](https://attest.org) and [EASScan](https://easscan.org).
- **Protocol ecosystem registry** — [agenticcommerceprotocol.info](https://agenticcommerceprotocol.info/).

Protocol scopes evolve. Verify each protocol's current specification before relying on this comparison; the sources reviewed for this article are linked above.

*AI disclosure: This article was developed with AI assistance and reviewed by the SAAX team. Claims about external protocols are sourced from official documentation linked in the text; SAAX status claims reflect the published status page. Nothing here is an independent audit, certification, or production-custody approval.*

**Next step:** read the [protocol overview](/protocol) and the [security page](/security), then try the [public preflight and acceptance flow](/docs) — it creates a signed commitment without moving funds.
