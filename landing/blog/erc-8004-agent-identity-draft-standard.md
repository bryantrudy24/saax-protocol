# ERC-8004 and Agent Identity: What the Draft Standard Actually Defines

*November 4, 2026*

*Last updated: 2026-11-04*

---

ERC-8004 is a Draft standard for on-chain agent identity and trust. It defines registries for identity, reputation, and validation — and it explicitly leaves payments out of scope.

That last part is the detail most commentary skips. ERC-8004 is often described as the identity half of an "agent payments stack", but the [proposal itself](https://eips.ethereum.org/EIPS/eip-8004) says payments are orthogonal: its examples show x402 payments enriching feedback signals, not carrying them. Understanding what ERC-8004 does and does not define matters more than its marketing framing, because building on a draft means building on a moving target.

## What ERC-8004 proposes

ERC-8004 ("Trustless Agents", currently Draft on the Ethereum Standards Track, created 2025-08-13) proposes three registries, deployable per chain:

- **Identity Registry** — an ERC-721-based handle that resolves to an agent's registration file: name, description, endpoints (MCP, A2A, ENS, DID, and more), x402 support flag, and related registrations. Every agent gets a portable identifier expressed as namespace:chainId:registry address, plus an agentId token.
- **Reputation Registry** — a standard interface for posting and fetching feedback signals, with scoring and aggregation allowed both on-chain and off-chain, enabling third-party scorers, auditor networks, and insurance pools.
- **Validation Registry** — hooks for requesting and recording independent validator checks: stakers re-running a job, zkML verifiers, TEE oracles, or trusted judges.

The design is explicitly tiered: trust models are pluggable, with security proportional to value at risk, from low-stakes tasks like ordering pizza to high-stakes ones like medical diagnosis. The authors span MetaMask, the Ethereum Foundation, Google, and Coinbase.

## What "draft" means in practice

Draft is the earliest Standards Track status. The interface, the registries' deployment model, and even concrete field semantics can change before Last Call. Some implications for builders:

- **Adopt the concepts, not the byte-for-byte interface.** Code against the ERC-721 identity handle and the registration file shape as design inputs; expect the final interface to differ.
- **Deployments are not finality.** Several agent registries have shipped implementations and infrastructure providers have announced support for x402 and ERC-8004 together — but a draft's ecosystem momentum does not freeze its interface.
- **Verify the current spec before relying on any detail.** Any article, including this one, is a snapshot.

## Where ERC-8004 stops

The proposal is precise about its boundary. The registries cover discovery, identity, reputation, and independent validation. They do not cover:

- **Payments or settlement.** "Payments are orthogonal to this protocol and not covered here."
- **Commitments.** Nothing in the registries records what a specific transaction agreed, what counts as fulfillment, or what happens on failure.
- **Authorization of a specific purchase.** A reputation signal says past interactions went well or badly; it does not say this agent was permitted to buy this thing at this price.

Reputation is also gameable. Feedback can be posted by sybils, aggregated by biased scorers, or gamed into staleness. The proposal's own framing treats reputation as one trust model among several, not a guarantee. SAAX mirrors that caution: reputation signals reflect reported outcomes and can be gamed, stale, or incomplete — see the [current status page](/status).

## How identity and commitment fit together

For an agent-commerce transaction, identity answers "who is this actor?" Commitment answers "what did the parties agree, and what proves it happened?"

They are complementary and separable. A commitment record can reference an ERC-8004-style agent identifier as one of its parties, and it can consume authority proofs and reputation signals from external systems — including ERC-8004 — without depending on the standard's registry semantics. SAAX's architecture takes exactly this posture: the protocol consumes identity and reputation signals from ERC-8004 per its own documentation, and external authority proofs (AP2 mandates, Verifiable Intent, or custom issuers) are evaluated at issuance and execution time. SAAX does not issue credentials or operate an identity provider.

The separation is a feature. If ERC-8004's interfaces shift as it moves toward final, a commitment layer that references agent identities by a stable handle (namespace:chainId:registry:agentId) can keep its records intact even when the surrounding registry code changes.

## Tradeoffs and cautions

- **Single-registry assumptions.** The proposal defines per-chain singleton registries. Cross-chain identity still requires resolvers and conventions the draft does not fully specify.
- **Transferable identity.** Identity is an ERC-721 token — ownership can transfer. Tying irreversible commitments to a transferable handle needs care about which party is bound.
- **Draft churn.** Build the integration behind an adapter. The interface is not settled.

## Where this fits

For a developer evaluating the agent-commerce stack in 2026: ERC-8004 is the identity and reputation layer, x402 is the payment transport ([see what a receipt actually proves](/blog/x402-receipts-what-a-receipt-proves)), and neither defines the commitment record. A stack that binds identity to commitments — referencing a stable agent handle in the commitment's parties, and attaching reputation and authority signals as verification inputs — gets durability that wiring identity directly into payment logic does not.

The [commitment schema, lifecycle, and authority/evidence interfaces](/spec) are documented in the SAAX specification, with [published conformance vectors](/conformance).

Next step: model your own agent as an ERC-8004-shaped registration (name, endpoints, x402 flag) and then write a commitment that references that agent handle as a party — no registry deployment needed to test the reference pattern against the SAAX spec's canonical schema.
