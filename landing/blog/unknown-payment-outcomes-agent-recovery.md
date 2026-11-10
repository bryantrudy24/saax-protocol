# Unknown Payment Outcomes: The Agent Recovery Problem Nobody Instruments

*November 4, 2026*

*Last updated: 2026-11-04*

---

The most dangerous moment in an agent payment is not the payment. It is the timeout after it.

An agent calls a purchase endpoint. The call times out. The response never arrives. Was the purchase made? The agent does not know. Every reliable-agent tutorial says retry; every commerce system treats the second request as a second purchase. Out of that collision come the duplicate charges, the reconciliation messes, and the "the agent bought it twice" incidents that the retry guidance was supposed to prevent.

## Why unknown outcomes are structural

Unknown outcomes are not a bug in one component. They are the intersection of three reasonable design decisions:

- **Agents retry.** Network calls fail, timeouts happen, and the standard remedy is a bounded retry with backoff.
- **Purchases are not idempotent by default.** A second POST to an order API creates a second order unless the server explicitly deduplicates.
- **Settlement is asynchronous.** The agent's tool call often returns when the order is acknowledged, not when the payment confirms.

The dangerous case is the request whose outcome is genuinely unknown: the call timed out, the response was lost, or the process crashed mid-flight. From the agent's seat, "no response" is indistinguishable from "response lost". Retrying on an absent response is exactly how a double-purchase gets created; assuming the first attempt failed is exactly how a missing record gets declared a non-purchase.

## The partial fixes, and where each stops

- **Idempotency keys** work for agents provided the key is persisted and reused across retries, session restarts, and process boundaries. The failure mode is a regenerated key: if the agent loses the key or mints a fresh one on retry, the server sees a new request. And when the agent cannot tell whether the first request arrived at all, it still needs reconciliation, not just a key.
- **Nonce-based authorization** (EIP-3009 style) prevents double-settlement — the chain rejects a second settlement with the same nonce. It does not prevent double-order: the merchant may have accepted both orders before either authorization reaches the chain.
- **Spend limits** bound the damage. They do not prevent the duplicate, and they fail silently when the duplicate is inside the limit.
- **Tool-call deduplication** in the agent runtime works when the runtime has a stable view of what "the same tool call" means. It fails across session restarts, process boundaries, and context resets — precisely the boundaries where crashes happen.

Each of these addresses a slice. None addresses the core need: a durable record, created before the attempt, that makes the duplicate detectable and the outcome reconcilable. The double-purchasing failure mode is detailed in [Preventing Autonomous Agent Double-Purchasing](/blog/preventing-autonomous-agent-double-purchasing).

## The durable-record pattern

The pattern that survives unknown outcomes has three parts:

1. **A commitment identifier minted before the attempt.** The agent creates a commitment record — intent, authority, terms, acceptance criteria, recovery policy — and receives an ID. Every retry of the same intent carries the same ID.
2. **Durable deduplication at the execution layer.** The merchant's execution path rejects a second request carrying a commitment ID it already processed. An identifier alone does not stop a duplicate; enforcement does.
3. **Reconciliation of unknown outcomes.** When the outcome is unknown, recovery checks on-chain settlement state and the commitment record before deciding whether a retry is safe. Absence of a response is never treated as proof the purchase did not happen.

Step three is the one most systems skip. A missing response, record, or receipt never means the purchase did not happen — so absence alone is never grounds to retry. The correct move is to query the settlement state (did the chain move funds for this reference?) and the commitment state (is there an in-flight commitment with this ID?) before the next attempt.

## How SAAX structures this

SAAX treats the commitment as the primary artifact of the purchase. The commitment is created before execution begins and carries an ID that survives retries, session restarts, and process boundaries; recovery semantics for failure, timeout, partial completion, and dispute are part of the [commitment lifecycle](/spec), and the [current status page](/status) is explicit that recovery is operator-assisted and demonstrated at specific crash boundaries — not automatic.

That last qualifier matters. A commitment record makes the unknown outcome *detectable* and gives recovery something durable to reconcile against. It does not by itself guarantee that a hung workflow resumes itself. Anyone evaluating SAAX for agent recovery should read the [current status page](/status): immediate x402/MPP payments are public beta on Base mainnet and non-custodial; escrow custody is testnet preview only; a Custody V3 candidate with governance work is under development and has not been independently reviewed.

## Tradeoffs

- **Dedup enforcement is a coordination problem.** The merchant, the agent, and the settlement rail must all honor the same ID. A commitment ID without enforcement is just a label.
- **Reconciliation is only as good as its sources.** Checking on-chain state assumes you can read the chain; checking the commitment record assumes the record store survived the crash.
- **Bounded retries still need a verdict.** At some point the agent must stop and escalate to a human or a recovery process; durable records make that escalation legible, not automatic.

## Where this fits

For a builder wiring agent payments today: persist an idempotency key or commitment ID across process boundaries, make your merchant execution path reject duplicate IDs, and — above all — replace "retry on timeout" with "reconcile, then decide". Treat every unknown outcome as potentially settled until on-chain and commitment state say otherwise.

The [commitment schema, lifecycle states, and recovery semantics](/spec) are documented in the SAAX specification, with [published conformance vectors](/conformance).

Next step: instrument one of your existing purchase tool calls — before the call, write a commitment/attempt record with a stable ID; on timeout, check the settlement chain and the record before retrying; log what the reconciliation step concluded. Run it against a test endpoint until you see the duplicate case disappear.
