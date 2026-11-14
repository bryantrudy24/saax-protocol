# AI Agent Security in 2026: Identity, Authorization, and Recovering from Failure

*November 14, 2026*

---

AI agents can now initiate payments, sign agreements, and take actions across systems. The security question is no longer "can they act?" It is "how do we keep acting agents safe, accountable, and recoverable?"

This article covers the three pillars of agent security in 2026 — identity, authorization, and recovery — and the concrete controls that matter.

## Why agent security is a distinct problem

Traditional security assumes a human at the keyboard. Agents break that assumption: they can ingest untrusted content at runtime, reason over enterprise data, and execute tool calls autonomously. In May 2026, NIST published a set of ten principles for AI agent identity and authorization, emphasizing delegated access, revocable permissions, and audit trails. The message: agent workflows need controls designed for machines, not just humans.

The stakes are visible in the numbers. Shopify reported AI-driven traffic to its stores tripled year over year in Q2 2026, and analysts project hundreds of billions in agent-mediated US e-commerce by 2030 (Bain: $300–500B; Morgan Stanley: $190–385B). Each of those transactions is an authorization decision made by software.

## Pillar 1 — Identity: who is acting?

An agent is not a person, but it still needs a verifiable identity: something that lets a counterparty confirm *which* agent (and *whose* authority) is making a claim.

Minimum controls:

- **Cryptographic identity.** The agent's proofs are signed with a key bound to a principal. In SAAX, proofs are EIP-712 signatures over a domain-separated message; the recovered signer is the verified principal. A literal identity string in a request header is not identity — it is self-attestation.
- **Distinct from the person.** An agent identity is the *delegation*, not the owner. Agent A and Agent C can both act for the same principal without being interchangeable.
- **No identity spoofing.** The counterparty must not be able to claim another agent's identity by passing a different field value. The system must derive identity from the verified signature, never from caller-supplied arguments.

Relevant to the ecosystem: ERC-8004 is a draft standard for agent identity; NIST's ten principles cover agent identity and authorization; Microsoft Entra Agent ID and IBM's agentic identity work apply least-privilege patterns to agents.

## Pillar 2 — Authorization: what may it do?

Identity answers "who are you?" Authorization answers "what are you allowed to do?" — and for agents, that must be *scoped, bounded, and revocable*.

Practical rules:

- **Least privilege.** Grant the minimum actions needed for the task, scoped to a specific commitment or resource. Never a global "agent can do anything" grant.
- **Explicit delegation.** A replacement agent never inherits the original agent's permissions. It must be granted its own authorization, bound to its own identity, for the specific commitment.
- **Expiration.** Grants carry `valid_from` / `valid_until`. An expired grant fails closed.
- **Revocation.** A grant can be revoked at any time by an authorized principal, durably recorded so the revoked agent is rejected on the *next* protected operation — including a replayed operation. Revocation must not require deleting history; the record remains for audit.
- **Separation of roles.** Buyer, seller, evaluator, and operator are distinct roles with distinct permissions. An evaluator cannot submit evidence as the seller; an agent cannot declare its own evidence verified.

The SAAX implementation models this as a durable authorization registry: rows bind `(agent_id, principal, role, commitment scope, action allowlist, validity window)`, with an append-only authorization event log for grants and revocations. Every lifecycle transition re-checks the registry *inside* the transaction, so a concurrent revocation cannot be bypassed by a cached approval.

## Pillar 3 — Recovery: what happens when the agent dies?

The strongest identity and authorization controls still leave the hardest problem: the agent process dies mid-workflow, the network drops after a payment, or the original builder of the commitment disappears.

Recovery requirements:

- **Durable state.** The commitment record and its event history live in durable storage, not in agent memory. If the agent process vanishes, the record remains.
- **Reconciliation before mutation.** A recovery operation reads the authoritative current state and reconciles pending operations before attempting any mutation. It never guesses from stale state.
- **Independent authority.** Recovery does not grant authority. A replacement agent may inspect and continue only within its own authorization scope — an unauthorized or revoked replacement is rejected.
- **Idempotency.** Retrying a request with the same idempotency key returns the original result instead of creating a second effect. This is what prevents a timeout+retry from double-charging or double-fulfilling.
- **Version enforcement.** Writes carry an expected version; a stale write fails. Concurrent agents cannot silently overwrite each other.

In a demonstrated production scenario (SAAX, nonfinancial beta), a buyer agent accepted a commitment, a seller agent began execution, the original buyer agent terminated, and a separately authorized replacement agent resumed the commitment through the public MCP interface: it retrieved the durable history, performed the permitted next action, and the event journal recorded the replacement's identity. Unauthorized and revoked replacements were rejected. The demo is described on the [recovery page](/recovery).

## The control checklist

When evaluating any agentic commerce system, ask:

1. Is the agent's identity derived from a verified cryptographic signature, not a self-asserted header?
2. Are permissions commitment-scoped, least-privilege, expiring, and revocable?
3. Does revocation take effect immediately — even against a replayed request?
4. Does the system persist commitment state and event history durably, independent of the agent process?
5. Can an authorized replacement agent recover a workflow? Can an unauthorized one be rejected?
6. Are duplicate requests (retries, replays) idempotent?
7. Are grant, revocation, transition, and evidence actions all auditable with verified actor identity?

## Where the controls live

- **NIST** ten principles for agent identity/authorization (May 2026).
- **ERC-8004** draft standard for agent identity, and **Microsoft Entra / IBM** agent-identity patterns for enterprise deployments.
- **SAAX** implements commitment-scoped authorization, durable event journaling, version-based concurrency, idempotent transitions, and independent-agent recovery as an open protocol: see the [specification](/spec), the [security page](/security), and the [audit trail article](/blog/the-audit-trail-problem-in-agentic-commerce).

Agent security is not one control; it is a system. Identity establishes who acts, authorization bounds what they may do, and recovery keeps the workflow alive when the worker fails. Get all three right and an agent becomes something you can trust to act for you — get any one wrong and the failure mode is expensive.