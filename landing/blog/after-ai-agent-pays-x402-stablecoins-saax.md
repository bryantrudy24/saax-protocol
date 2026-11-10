# What Happens After an AI Agent Pays? x402, Stablecoins, Settlement Evidence, and SAAX

*November 8, 2026*

*Last updated: 2026-11-08*

---

The hard part of an AI-agent payment is not the payment. It is everything that happens after the money moves: the response is lost, the process crashes, the agent restarts, and nobody knows whether the purchase completed, whether the work was delivered, or whether retrying will create a duplicate charge.

This article walks through what x402 and stablecoin settlement actually give you — and what they do not — then shows how SAAX's durable commitment records, idempotency, and reconciliation turn "the payment happened" into "the transaction can be recovered safely."

## What x402 and stablecoin settlement actually prove

### The x402 flow

x402 makes HTTP 402 a payment protocol. A client requests a resource; the server responds with a payment requirement (the challenge: amount, asset, recipient); the client returns a signed payment credential; the server verifies and settles; the client receives the resource.

The current main spec is V2, which moved payment data into headers — PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE — and added lifecycle hooks including before/after settlement verification, so integrators can capture and validate a receipt at the moment payment confirms.

What x402 produces, end to end:

- A **challenge**: what to pay, to whom, on what network.
- A **signed payment credential**: the payer's authorization for that exact amount to that recipient.
- A **settlement reference**: the transaction hash on the settlement chain.
- A **receipt**: the response body plus the payment signature data.

### What a stablecoin settlement proves

A settled USDC transfer on Base proves exactly this: `amount` of `asset` moved from `sender` to `recipient` at `block time`, confirmed by the chain. That is real, third-party-verifiable evidence — anyone can replay the read against a block explorer or RPC without trusting the agent or the seller.

That is the ceiling. A settlement reference says nothing about:

- Whether the deliverable was produced (the seller may have taken the payment and returned garbage).
- Whether the purchase was authorized (a settled transfer is not proof the payer's agent was permitted to buy).
- Whether the purchase was duplicated (two transfers to the same seller are two receipts; nothing says the second was a mistake).
- Whether the work met the agreed acceptance criteria (that requires evidence of fulfillment, not payment).

[x402 Receipts: What a Payment Receipt Actually Proves](/blog/x402-receipts-what-a-receipt-proves) goes deeper on this boundary.

## The failure modes after payment

### 1. Lost response

The agent sends the payment credential. The server settles. The response is lost in transit. The agent sees a timeout. Was the purchase made? It does not know.

Every retry tutorial says retry; every commerce system treats a retry as a new request. This is how a single intended purchase becomes two settled payments.

### 2. Process crash mid-flow

The agent's process is killed after settlement but before it can record what the payment was for. The next morning, the reconciliation sees a transaction hash and nothing else. No intent, no terms, no acceptance criteria, no recovery policy. The deal is unreconstructable from the chain alone.

### 3. Agent restart with no durable state

A replacement process starts. It has no memory of the earlier attempt. If its only source of truth is "did my previous call return?", and that call never returned, it re-runs the purchase.

## Why unknown outcomes are structural

Three design decisions collide to make unknown outcomes the norm:

1. **Agents retry.** Network calls fail; bounded retry with backoff is standard practice.
2. **Purchases are not idempotent by default.** Without server-side deduplication, a second POST is a second purchase.
3. **Settlement is asynchronous.** The agent's call often returns on acknowledgment, not confirmation; the settlement confirms later.

The dangerous case is the one where the outcome is genuinely unknown. "No response" is not proof of failure; it is proof of nothing. Treating a lost response as a failed purchase is how duplicates get created; treating it as a successful purchase is how missing records get declared non-purchases.

[Unknown Payment Outcomes: The Agent Recovery Problem](/blog/unknown-payment-outcomes-agent-recovery) explains this pattern in depth. This article focuses on what SAAX *implements* to make it safe.

## What SAAX implements: durable commitments, idempotency, reconciliation

SAAX's approach is to make the commitment — not the payment — the primary artifact of the transaction. The commitment is created before execution, carries a stable ID, and survives retries, restarts, and process boundaries. Here is the implemented mechanism, verified in the current release.

### 1. A durable commitment record, created before value moves

The SAAX commitment records authority, terms, acceptance criteria, evidence requirements, recovery policy, and settlement linkage. The signed path is:

- `prepare_commitment` returns a provider-signed proposal (free, nonbinding).
- `accept_commitment` records a buyer-signed acceptance, creating exactly one authenticated commitment.
- The commitment ID is deterministic when an idempotency key is present: a hash over a namespace and the operation scope, so identical retries re-derive the same commitment ID.

This is the fix for the crash problem: when the process restarts, the commitment is still there, findable by its durable ID, with the terms and recovery policy intact.

### 2. Durable idempotency, not process-local memory

SAAX's payment idempotency gate uses a durable, file-backed store (and, in production topology, Supabase/PostgreSQL) rather than an in-memory Map. The property that matters for financial safety:

- An identical retry with the same idempotency key returns the **cached response** — no second payment authorization, no second quota consumption.
- The same key with a **different payload** is rejected (422).
- A settled nonce is rejected on replay.
- The durable store survives process restarts; startup reconciliation re-derives in-flight state.

The distinction is critical: an idempotency key kept only in the agent's memory is useless after a crash. A key persisted in the durable store — and enforced by the server's durable store — survives the crash.

### 3. Reconcile-before-respond: never treat a timeout as proof of failure

The hardest case is the one where the database response is lost after commit: the reservation committed, the client saw a timeout, and the client retries. The correct behavior is:

1. Look up the existing reservation/commitment by the idempotency key.
2. If it exists, return the existing outcome — do not create a second reservation or authorize a second payment.
3. If persistence failed (the store was unavailable), **fail closed** with an explicit retryable error rather than silently proceeding.

SAAX's implementation verifies this with fault-injection tests: payment succeeds but the response is lost → retry returns the same commitment and one row; persistence fails → 503 with `retryable:true` and no payment challenge; six concurrent identical requests → exactly one commitment. The behavior is tested across process restarts.

### 4. Unknown settlement outcomes stay unresolved

When payment status is genuinely unknown (the settlement may or may not have confirmed), SAAX does not guess:

- The operation preserves an explicit unresolved state.
- Recovery reconciles against authoritative payment evidence — the on-chain settlement reference — before retrying.
- Expiration or timeout alone is never treated as proof of payment failure.
- An unresolved reservation keeps consuming its exposure budget rather than being released on a timer, until authoritative evidence says the operation cannot settle.

This is the fail-closed principle applied to financial state: doubt is preserved as doubt, not converted into success or failure.

## The verified production boundaries

Accuracy matters here. What SAAX has verified in production as of this release:

- **Live on Base mainnet:** immediate x402 payments (the live rail is x402; MPP is implemented but not registered in production).
- **Beta:** signed Discovery, preflight, acceptance, MCP tools, receipt lookup.
- **Testnet preview:** escrow custody on Base Sepolia with real test-USDC release/refund evidence and independent export verification — operator-run, not public financial API.
- **Under development / security review:** Custody V3 candidate; independent external security review not yet completed.
- **Financial limits:** infrastructure deployed, enforcement OFF.

SAAX's [status page](/status) is explicit that internal verification and reliability testing do not replace an independent security assessment, and that mainnet payments are final and non-custodial.

## What this means for your agent integration

If you are building an agent that pays over x402 with stablecoins, the practical checklist is:

1. **Persist an idempotency key or commitment ID across process boundaries** — in your durable store, not in the agent's memory.
2. **Make your payment path reject duplicate IDs** — a commitment ID is only useful if the execution layer enforces it.
3. **Replace "retry on timeout" with "reconcile, then decide."** On a lost response, check the settlement chain and the commitment record before retrying. Absence of a response is never proof the purchase did not happen.
4. **Treat receipts as settlement evidence, not fulfillment proof.** A receipt proves value moved; it does not prove delivery.

The [SAAX documentation](/docs) covers each of these mechanics, and the [conformance suite](/conformance) provides vectors to validate an implementation.

Next step: instrument one purchase tool call — before the call, write a durable attempt record with a stable ID; on timeout, query the settlement chain and the record before retrying. Run it against a test endpoint until the duplicate case disappears.
