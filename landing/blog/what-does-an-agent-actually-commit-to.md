# What Does an Agent Actually Commit To?

*October 10, 2026* 

*Last updated: 2026-10-17*

---

A payment authorization is a promise to pay. A fulfillment is proof that something was delivered.

Between those two events, something has to define what the agent actually agreed to. Price. Deliverable. Deadline. Acceptance criteria. Evidence requirements. What happens if the delivery fails.

This is the commitment layer, and it's the piece most agent commerce systems are missing.

## Why authorization isn't enough

When a human buys something, the gap between "I authorized this" and "this was delivered correctly" is closed by the human. They know what they wanted. When the goods arrive, they compare. If it doesn't match, they dispute it — and the card network handles it based on the human's testimony.

When an agent is the buyer, none of that works. The agent's intent is not the principal's intent. The record of what the agent was asked to do lives in a prompt log that may expire. The record of what the agent actually did lives in a tool-call log that may not be preserved. The record of what the merchant delivered lives in the merchant's database. None of them reference each other.

Six months later, when someone asks what happened, the answer is: you can't reconstruct it.

## What a commitment records

A commitment binds five things before execution begins:

**Authority** — who authorized the agent to act, under what scope, with what limits. This is the proof that the agent was permitted to enter the commitment.

**Terms** — what was agreed. Price, deliverable, deadline, and the specific conditions under which the commitment is fulfilled.

**Acceptance criteria** — what objectively counts as fulfillment. Not "the merchant says it shipped" but "the evidence shows the item matched the specified criteria."

**Evidence requirements** — what proof must be submitted to demonstrate fulfillment. External attestations, delivery hashes, signed receipts, or sensor data depending on the domain.

**Recovery policy** — what happens if fulfillment fails. Refund, compensation, dispute, or escalation. Set at commitment time, not negotiated after the problem emerges.

## The lifecycle

A commitment has states. It moves through them, and each state has defined transitions:

`COMMITTED → EXECUTING → FULFILLED`

or

`COMMITTED → EXECUTING → FAILED → RECOVERY → DISPUTE → RESOLVED → FINAL`

Failure doesn't terminate the commitment. It moves it into a recovery state where the recovery policy applies. External systems handle the refund, the compensation, or the arbitration. The commitment records what was required, what failed, what action occurred, and when the commitment became final.

## The in-flight problem

The hardest state is `in_flight` — the window where the merchant has received the commitment but the agent hasn't yet received confirmation.

If the agent's first attempt times out, it can't know whether the merchant never received it or is processing it right now. A naive retry with the same commitment ID races the merchant's accept path and creates a duplicate.

The protocol rule is simple: **an unknown outcome is a status check, not another POST.** This rule is safe only when the status check can determine the real outcome — from durable state or from the chain. Where the broadcast reference was never durably recorded (the broadcast-before-durable-hash gap), an absent record is not proof that a retry is safe; the outcome must be determined from the chain before retrying.

The agent queries the commitment state before retrying. `not_found` means safe to retry. `in_flight` means wait. `fulfilled` means stop. `failed` means retry with a fresh commitment ID.

On the merchant side, the rule is equally clear: the merchant writes `in_flight` to durable storage **before** processing the request. The write is the lock. A second request with the same commitment ID returns `in_flight` — it isn't processed again.

Both sides need both rules. Neither alone closes the gap.

## Why this matters for the parties involved

**For the buyer** — the commitment is the evidence. If the delivered result doesn't match the acceptance criteria, the commitment is what proves it.

**For the merchant** — the commitment shows that fulfillment was performed against specific terms. The merchant doesn't carry the liability for a decision that was made against the commitment.

**For the platform or rail** — the commitment links the settlement to the agreement it was for. The platform doesn't need to reconstruct what the transaction was about.

**For the regulator or auditor** — the commitment is the structured record that makes the transaction verifiable and reconstructable.

## What this isn't

A commitment layer is not a payment rail, an identity provider, or an oracle. It doesn't replace x402, MPP, AP2, or the card networks. It sits above them.

The payment layer proves the transaction was permitted. The commitment layer proves the transaction delivered what it was supposed to.

Authorization is not fulfillment. The two are treated as equivalent in most commerce infrastructure, and that assumption breaks the moment an agent is on the other end of the purchase.

The spec is at [saax-protocol.com/spec](/spec). The conformance suite is at [saax-protocol.com/conformance](/conformance). The commitment schema, the lifecycle states, and the in-flight handling rule are documented there.