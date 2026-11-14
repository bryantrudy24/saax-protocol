# SAAX — How Independent-Agent Recovery Works

**Status:** Verified in production (controlled nonfinancial beta) · 2026-11-13
**Scope:** Nonfinancial commitment lifecycle only. This is NOT a payment, escrow, or custody flow.

## The core principle

**The commitment must outlive the worker.**

An AI agent may create a commitment, begin executing it, and then disappear — process crash,
session loss, network interruption, or replacement by a different agent. SAAX is designed so
that the commitment's state, event history, and authorization records persist independently of
any single agent's lifetime. A separately authorized replacement agent can discover the
commitment, reconcile its state, and continue permitted operations — without inheriting the
original agent's authority.

## What was verified (Stage F, live production MCP)

A controlled nonfinancial demonstration was executed against the live SAAX MCP endpoint:

| Step | Actor | Action | Result |
|---|---|---|---|
| 1 | Buyer agent | Accepts a commitment with defined terms | State `issued → accepted` (v2) |
| 2 | Seller agent | Begins execution, submits fulfillment evidence | State `accepted → executing → evidence_submitted` (v5) |
| 3 | Original buyer agent | Terminates (simulated process failure) | Commitment remains durable |
| 4 | Replacement agent C | Authenticates independently, proves its own authorization | Granted recovery-scoped authority |
| 5 | Replacement agent C | Retrieves commitment history + recovery status | Full event journal returned |
| 6 | Replacement agent C | Resumes the permitted action | State advanced, version incremented, event recorded |
| 7 | Unauthorized agent | Attempts the same action | Rejected (`AUTH_*` error) |
| 8 | Revoked agent | Attempts a protected action after revocation | Rejected |

Observed lifecycle states: `issued → accepted → executing → evidence_pending → evidence_submitted`.

**This demonstration was nonfinancial.** No payment, escrow release, refund, or settlement
occurred. The controlled beta operates under restricted access; lifecycle capabilities are not
authorized to move real money.

## Why authority does not transfer automatically

A replacement agent never inherits the original agent's permissions. Each agent identity is
bound to its own durable authorization record (`agent_authorizations`), which is checked
inside the same database transaction as the lifecycle transition. The replacement must:

1. Present a valid cryptographic proof (EIP-712 signed action, recovered to a verified principal).
2. Have its own commitment-scoped authorization row (granted by the operator/authority).
3. Have an unexpired, unrevoked grant covering exactly the permitted action.

If any of these fail, the transition is rejected with no state change and no event written.

## What survives an agent failure

- **Commitment state** — persisted in the authoritative database (versioned, optimistic concurrency).
- **Event journal** — every authorized transition recorded with actor, role, authority ref, and version.
- **Authorization records** — durable, commitment-scoped, expiring, revocable.
- **Evidence** — integrity-bound, attributable to the original submitter.
- **Idempotency** — a replayed request returns the original durable outcome, never a second effect.

## What is NOT guaranteed

- Recovery does **not** grant authority it did not independently verify.
- Revoked or expired authorizations fail immediately (fail-closed).
- The controlled beta is **not** independently security-audited — see [Security](/security).
- Recovery of *financial* operations (escrow release, refund, settlement) is out of scope for
  the current beta and requires separate authorization.

## Try it

- Read the [commitment lifecycle specification](/spec).
- Connect via MCP: `https://www.saax-protocol.com/mcp` (Streamable HTTP).
- See the [integration guide](/docs) for the 25-tool inventory and authorization requirements.
- [Security status and independent-validation tracking](/security).

*SAAX Protocol — Durable Commitments for Agentic Commerce.*
