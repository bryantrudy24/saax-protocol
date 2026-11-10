# Google AP2 and SAAX: Authorization Evidence vs Durable Commitments

*November 8, 2026*

*Last updated: 2026-11-08*

---

Google's Agent Payments Protocol (AP2) answers a precise question: *was this agent permitted to spend this money?* SAAX answers a different one: *what was the money for, and what happens when the deal goes wrong?* The two are complementary layers, and understanding the boundary between them is the difference between a payment integration that survives a dispute and one that does not.

## What AP2 actually is

AP2 is Google's protocol for agent payments authorization. Its core artifacts are signed mandates:

- **Intent Mandates** capture the user's intent to authorize a purchase.
- **Cart Mandates** capture the specific items and amounts.
- **Payment Mandates** authorize the actual payment to a specific merchant.

These Verifiable Credentials cryptographically bind the payer's authorization to the payment. AP2's design goal is to solve the "crisis of trust" in autonomous agent payments: when an agent spends money, there must be cryptographic evidence that a human (or an authorized principal) consented.

AP2 is, at its core, an **authorization-and-evidence layer**. It produces signed artifacts proving that a payment was permitted and that payment evidence can be presented for review.

## What AP2 does not (per its official scope)

AP2's mandate evidence can support dispute review — a signed intent mandate plus payment evidence tells a reviewer what was authorized and what was paid. But the official materials reviewed for this article do not establish AP2 as a complete dispute-adjudication protocol, a fulfillment-verification system, or a post-failure recovery protocol.

In particular, AP2 does not claim to answer:

- **What was agreed?** A payment mandate authorizes a transfer amount to a merchant. It does not define the acceptance criteria of the deliverable, the recovery policy on failure, or the evidence that counts as fulfillment.
- **Was the work done?** AP2 verifies consent, not delivery. A valid mandate plus a settled payment says nothing about whether the report was accurate, the dataset was complete, or the API key was delivered.
- **What happens on failure?** If the agent crashes after payment, if the seller never delivers, if the buyer disputes — AP2's scope does not define a resolution workflow.

This is not a criticism. It is a statement of the layer. AP2 solves authorization; the durable deal record is a separate artifact.

## The authorization-vs-commitment distinction

The cleanest way to see the boundary is to separate three things that are easy to conflate:

1. **Authorization** — the payer permits a specific payment to a specific payee for a specific purpose. (AP2's layer.)
2. **Execution** — money moves. (x402 or another rail's layer.)
3. **Acceptance of the deal** — the buyer agrees to the terms of what the payee will deliver, what counts as success, and what happens on failure. (The commitment layer's job.)

A signed payment mandate covers #1 and (with the rail) #2. It is not #3. When an agent pays for a research report, the mandate proves the transfer was permitted. It does not prove the report was delivered, that it met the acceptance criteria, or that both parties share a record of what was promised.

This is the failure mode behind most agent-commerce disputes: the payment succeeded, so the seller treats it as acceptance of the work; the buyer treats it as a down payment on a deliverable. Neither party has a record of *what was agreed*. [What an AI Agent Payment Authorization Actually Authorizes](/blog/what-agent-payment-authorization-actually-authorizes) examines this distinction in depth.

## How SAAX complements AP2

SAAX is a vendor-neutral commitment layer. Its design explicitly **consumes** authority proofs from external systems rather than issuing its own identity or authorization. AP2-style mandates are exactly the kind of external authority proof a SAAX commitment can reference.

The SAAX commitment lifecycle records:

- **Authority** — a reference to the external authorization (an AP2 mandate, verifiable intent, or other proof), re-evaluated at execution time (still valid? still in scope?).
- **Terms** — what was promised, at what price, under what constraints and deadlines.
- **Acceptance criteria** — what objectively constitutes successful fulfillment.
- **Evidence requirements** — what external, independently verifiable proof is required.
- **Recovery policy** — what happens on failure, timeout, partial completion, or dispute.
- **Settlement linkage** — the actual rail settlement reference bound to the commitment.
- **Finality** — when the commitment reaches its terminal state.

The relationship is additive: AP2 proves the agent was allowed to pay; SAAX records what the payment was for and what happens next. The commitment can reference the mandate as its authority proof; the mandate benefits from a durable record of the deal terms that survives the transaction.

## Overlap and complementarity

| Concern | AP2 | SAAX commitment |
|---|---|---|
| Was the payment authorized? | Yes — signed mandates | References external authority; not an identity issuer |
| What was agreed? | Not defined per official scope | Terms, acceptance criteria, recovery policy |
| Was the work delivered? | Not defined | Evidence requirements + verification policy |
| What if the agent crashes? | Not defined | Durable record survives; recovery semantics |
| What if the buyer disputes? | Mandate evidence can support review | Dispute states + evaluator governance (testnet custody) |
| Settlement linkage | Payment evidence | Settlement reference bound to commitment ID |

Neither replaces the other. A mandate without a commitment lacks durable terms; a commitment without authorization lacks proof of permission. Together they give an agent payment both legs: consent and record.

## What SAAX has verified today

Precision about what is implemented versus aspirational:

- **Live on Base mainnet:** immediate x402 payments (live rail is x402; MPP not registered in production).
- **Beta:** signed Discovery profile, free preflight, buyer acceptance creating one authenticated commitment; MCP tools; receipt lookup.
- **Testnet preview:** escrow custody on Base Sepolia (operator-run test-USDC release/refund evidence).
- **Under development / security review:** Custody V3 candidate; independent external security review pending.
- **Financial limits:** infrastructure deployed, enforcement OFF.

SAAX's [status page](/status) is explicit that mainnet payments are final and non-custodial, that disputed testnet funds can remain frozen if the evaluator disappears, and that internal tests are not an independent audit.

## The takeaway

AP2 gives agent payments **consent evidence**. SAAX gives them **durable terms and recovery semantics**. They sit on different layers and reinforce each other. If you are building on AP2, the durable-commitment question is the natural next layer: what survives the transaction?

Next step: read the [protocol overview](/protocol) and the [commitment lifecycle specification](/spec), then run the [public acceptance flow](/docs#discovery-quickstart) — it creates a signed commitment without moving funds, and it is the fastest way to see how an authorization reference and a durable record fit together.
