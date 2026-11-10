# SAAX Protocol — The Standard

*Part of the SAAX system. The Protocol is the standard; the Network carries it; the Router is one commercial implementation of it.*

> **SAAX Protocol — Public Beta**
>
> SAAX Protocol is currently in public Beta. Immediate-payment functionality is available on Base mainnet, while escrow custody remains limited to testnet.
>
> Independent external security review is pending. Although internal verification and reliability testing have been performed, these do not replace an independent security assessment.
>
> Live transactions involve financial and technical risks, including potential loss of funds and irreversible blockchain transfers. Users should evaluate these risks carefully and use the platform at their own discretion.
>
> *This notice does not constitute a guarantee of reimbursement, dispute recovery, or financial protection.*

---

## What SAAX Protocol Is

SAAX Protocol is a vendor-neutral standard for governed, contract-defined, outcome-verified, recoverable and auditable economic commitments between autonomous systems.

It defines how two parties — usually agents — enter into an economic commitment with each other: what was authorized, what was committed, what proves fulfillment, what happens on failure, how settlement is linked, and when the commitment becomes final.

SAAX is **not** a payment rail. It is **not** an identity system. It is **not** a marketplace. It is a standard for what a commitment means — for what must be true for a commitment to be valid, fulfilled, and final.

---

## Why It Exists

Autonomous agents are starting to transact with each other: buying compute, data, security services, and tools. But there is no common way for one agent to know what another agent has actually committed to — or whether it delivered.

SAAX answers the basic questions of agent commerce:

- **Authority** — was this actor actually authorized to make this commitment?
- **Terms** — what was promised, at what price, under what constraints and deadlines?
- **Acceptance criteria** — what objectively counts as successful fulfillment?
- **Evidence** — what external, independently-verifiable proof is required?
- **Outcome verification** — how is evidence evaluated against the criteria?
- **Recovery** — what happens on failure, timeout, partial completion, or dispute?
- **Settlement linkage** — how does an external economic settlement relate to the commitment?
- **Finality** — when does the commitment conclusively reach its terminal state?
- **Audit** — can another party reconstruct the full history?

The Protocol does not answer *who* you should transact with, or *how* value should move. Those are separate layers.

---

## The Commitment Lifecycle

A SAAX commitment moves through a defined sequence:

**Authority → Commitment → Contract Terms → Execution → Evidence → Verification → Fulfilled or Failed → Settlement or Recovery → Finality → Audit**

1. **Authority** — proof that an autonomous actor was authorized to enter the commitment (external authority proofs are referenced, not issued by SAAX).
2. **Commitment** — the commitment is issued with its terms, acceptance criteria, and verification policies.
3. **Contract Terms** — what was promised, at what price, under what constraints and deadlines.
4. **Execution** — the parties perform their obligations.
5. **Evidence** — external, independently-verifiable proof is submitted, bound to a specific acceptance criterion.
6. **Verification** — SAAX validates the evidence (structure, signature, provenance, binding) and evaluates it against the criterion's verification policy.
7. **Fulfilled or Failed** — the outcome is recorded: satisfied, not satisfied, or insufficient evidence.
8. **Settlement or Recovery** — a satisfied commitment links to settlement; a failed or partial one enters recovery semantics.
9. **Finality** — the commitment conclusively reaches its terminal state.
10. **Audit** — the full history can be reconstructed by another party.

---

## Evidence and Authority — External by Design

Two design choices separate SAAX from systems that trust the parties to declare fulfillment.

### Evidence

SAAX does not trust the buyer or seller to declare fulfillment. Evidence comes from **external sources** with independent verification — temperature sensors, delivery trackers, reputation oracles, inspectors, or any issuer that signs a verifiable claim.

Each evidence record binds to a commitment and a specific acceptance criterion, and is validated against:

- Structure and signature (EIP-712, COSE, or JWS schemes)
- Provenance and issuance time (freshness windows)
- Binding to the commitment and criterion
- The criterion's **verification policy** — required evidence type, optional accepted-issuer allowlist, evaluation logic, maximum evidence age, and minimum evidence count

### Authority

SAAX does not issue authority proofs. It **consumes** them from external systems — AP2 mandates, verifiable intents, OAuth tokens, or custom schemes.

Each authority proof references who issued it, who is authorized, what scope of action is authorized, and a validity window. At issuance, the commitment references the proof; at execution time, the proof is re-evaluated — still valid? still in scope?

In the current v3 agreement format, the agreement is signed directly by the parties — the buyer and the seller — and those signatures are part of the digest that is hashed and anchored. Authority proofs from external systems are an additional authorization mechanism that can be referenced by a commitment; they are not required for an agreement to be valid. The signed-agreement path is the normal path today, not a legacy fallback.

---

## Settlement Linkage — Rail-Neutral

SAAX does not prescribe a settlement rail.

A commitment issues a settlement **requirement (R)** — the amount, currency, payee, and expectation — that carries no rail knowledge. The actual **rail (S)** is resolved at execution time from a registered registry. The commitment knows *that* value will move and *how much*; it does not know or care *which* mechanism moves it.

Any system that implements the rail interface — realise a requirement into a credential, validate a credential against the requirement, settle a credential into a transaction reference — can register as a SAAX settlement rail. Currently registered rails include x402 and MPP; future rails (entitlement, card, ACH, internal ledger) can be added by implementing the same interface.

---

## The Network

The SAAX Network is the intended federated collection of independently operated endpoints that exchange conforming SAAX commitment messages. This is the protocol's design target — it has not yet been demonstrated with independent operators. Today the only running endpoint is the SAAX Router, operated by the SAAX team.

Any conforming node would be able to participate in the Network regardless of its underlying infrastructure, settlement rail, or commercial operator. The Network is not owned by any single party — it is the transport for commitments that conform to the Protocol. That federation is planned, not yet deployed.

---

## Reference Implementation

The SAAX Router is one implementation of the Protocol — an optional commercial service for discovering, ranking and matching providers and connecting commitments to supported settlement rails.

The Router currently settles on Base mainnet via USDC through x402 or MPP. That is the Router's current settlement profile — a choice, not a requirement of the Protocol. The Router is the practical way to use SAAX today: [integration guide](/docs), [settlement endpoint](https://settlement.saax-protocol.com), [MCP server](https://www.saax-protocol.com/mcp).

Other implementations are free to build on the Protocol. The Protocol does not depend on the Router; the Router depends on the Protocol.

---

## Implemented Discovery and the testnet financial profile

Public beta Discovery interfaces now serve a signed provider profile, free nonbinding preflight and configured-buyer acceptance creating one authenticated commitment. They do not execute payments or services. Provider identity uses independently authenticated configured-key onboarding; a profile's own public key is not an independent trust anchor.

The new connected financial demonstration uses a separately signed Base Sepolia profile and an explicit buyer-authorized financial agreement. A provider proposal signature, buyer acceptance, payment/funding authorization and evaluator verdict are different authorities. The exact selected network, asset, integer amount/decimals, mode, parties, evaluator permissions and custody remain bound throughout. A later rail or asset choice cannot override an already signed selection; it needs fresh authorization. The general rail-neutral model does not weaken a profile that explicitly selects financial terms.

This testnet preview uses actual CustodyV1 funding/release/refund with independent verification of complete signed records and public-chain facts. Its evidence is an operator-controlled deterministic SHA256 self-test, not an external service or independent audit. It does not claim the self-test uses external attesters or an EAS anchor. Mainnet immediate payments remain a separate public-beta direct-payment lane; mainnet escrow is unavailable. [Integration guide](/docs), [verification walkthrough](/blog/signed-discovery-to-testnet-finance), [current status](/status).

## The Full Specification

Read the complete commitment lifecycle specification — evidence abstraction, authority interface, verification policies, recovery semantics, settlement-rail neutrality, and the rail interface — at the [Commitment Lifecycle Spec](/spec).

---

*SAAX components vary in maturity: the specification is public and versioned, routing and immediate payments are public beta on Base mainnet, commitment verification and receipts are beta, escrow custody is testnet preview (not approved for mainnet funds), and unreleased custody/governance candidates are under development / security review. See the [current status](/status) page for details. [Read the full terms of use](/terms) before using it with real funds.*