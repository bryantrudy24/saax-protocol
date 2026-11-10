# Building Reliable Agentic Commerce with MCP, A2A, UCP, and SAAX

*November 8, 2026*

*Last updated: 2026-11-08*

---

MCP connects agents to tools. A2A connects agents to agents. UCP lets agents discover and navigate commerce capabilities. What connects the whole stack to a durable record of what was agreed, delivered, and settled? That is the question this article answers — with a concrete reference architecture and an explicit label: the cross-system wiring described here is *illustrative*, showing how SAAX's implemented commitment layer fits with these protocols.

## The four layers in one stack

| Layer | Protocol | What it does | What it does not do |
|---|---|---|---|
| Tool connectivity | MCP | Lets an LLM application call tools (payment APIs, checkout APIs, commitment APIs) | Not a commerce or records protocol |
| Agent-to-agent | A2A | Inter-agent discovery, messaging, delegated tasks, async status/artifacts, cancellation | Not a payment or commitment protocol |
| Commerce lifecycle | UCP | Capability discovery, catalog, cart, checkout, orders, post-purchase | Not a durable cross-party deal record |
| Durable commitment | SAAX | Records terms, acceptance criteria, evidence, recovery policy, settlement linkage; survives the worker | Not a payment rail, identity system, or marketplace |

The first three get the transaction going. The fourth is what makes it recoverable when something goes wrong.

## A reference architecture: the buying agent

Here is an illustrative architecture for an agent that buys a service with recovery built in. "Illustrative" means the SAAX pieces are implemented today, but the specific wiring with ACP/AP2/UCP in a live deployment is proposed, not yet production-verified.

### Components

- **Buyer agent** — an LLM application that plans and executes the purchase (via MCP tools).
- **Sub-agents** — helpers coordinated through A2A (e.g., a research sub-agent that fetches specs, a payment sub-agent that settles).
- **Merchant** — exposes commerce capabilities through UCP and checkout through ACP/ACS.
- **Payment rail** — x402 for the actual value transfer on Base.
- **SAAX commitment service** — exposes MCP tools (`prepare_commitment`, `accept_commitment`, `get_commitment`, `get_commitment_status`, `list_commitments`) and HTTP endpoints; persists commitments durably.
- **Verifier/recovery worker** — a separate process that reconciles unknown outcomes against the settlement chain and the commitment store.

### The flow

1. **Discover.** The buyer agent queries UCP to find a merchant offering the service and its capabilities.
2. **Connect.** MCP gives the agent tool access to the merchant's checkout API and to SAAX's commitment API; A2A coordinates any sub-agent work (e.g., "fetch the current price" delegated to a helper).
3. **Commit before value moves.** The buyer agent calls SAAX `prepare_commitment` → gets a provider-signed proposal. The buyer signs acceptance → `accept_commitment` records exactly one authenticated commitment with a stable ID. Terms, acceptance criteria, and recovery policy are now durable.
4. **Authorize and pay.** AP2 (or another authority mechanism) issues a signed mandate; the x402 challenge is presented; the agent settles. The commitment ID travels in the payment's external-reference field.
5. **Verify.** The settlement reference is recorded on the commitment. If the merchant claims fulfillment, evidence is submitted and checked against the acceptance criteria per the commitment's verification policy.
6. **Recover.** If the agent crashes after payment, the durable commitment survives. A replacement process calls `get_commitment` by ID, sees the settlement reference, and reconciles — it does not blindly retry. If the outcome is unknown, the verifier checks the settlement chain and the commitment store before deciding.

## Why the durable record is the linchpin

Each protocol in this stack has a failure mode that the others do not cover:

- MCP connects tools but has no commerce memory; if the agent crashes, the tool session is gone.
- A2A tracks tasks and artifacts, but it is not a commercial commitment or payment record.
- UCP covers the order lifecycle on the merchant side, but the merchant is one party; a dispute needs a record both parties share.
- x402 proves settlement but not intent, terms, or fulfillment.

SAAX's commitment record is the shared artifact: created before value moves, survives process death, and binds authority reference, terms, evidence, recovery policy, and settlement linkage into one verifiable record. That is the "commitment outlives the worker" property, implemented.

## The implemented SAAX pieces (verified)

What SAAX actually ships today, verified in the current release:

- **MCP tools:** `prepare_commitment`, `accept_commitment`, `get_commitment`, `get_commitment_status`, `list_commitments` (plus legacy `create_commitment`), exposed at `https://www.saax-protocol.com/mcp`. A read-only release check validates initialization, tool discovery, ping, and protocol-info — an HTTP 200 alone is not treated as MCP proof.
- **Durable idempotency:** the payment idempotency gate uses a durable store (file-backed locally; Supabase/PostgreSQL in the production topology), not process-local memory. Identical retries return the cached response; conflicting payloads are rejected; settled nonces cannot be replayed; state survives restarts.
- **Reconcile-before-respond:** on a lost response after persistence, retries reconcile to the existing commitment instead of creating a duplicate. On persistence failure, the system fails closed with an explicit retryable error.
- **Unknown outcomes:** preserved as unresolved until authoritative settlement evidence exists; expiry or timeout alone is never treated as payment failure.
- **Receipt linkage:** `/receipt?txHash=...&rail=x402` resolves a settled transaction hash back to the commitment ID.

The [current status page](/status) is the authoritative source for what is live, beta, testnet, or under development.

## What is illustrative versus implemented

To be precise about the boundary:

- **Implemented and deployed:** the SAAX MCP tools, the commitment lifecycle, durable idempotency, reconcile-before-respond, receipt linkage, x402 immediate payments on Base mainnet.
- **Implemented, testnet-only:** escrow custody (Base Sepolia, operator-run test-USDC release/refund).
- **Illustrative / proposed:** the specific wiring of this reference architecture with a particular ACP, AP2, or UCP deployment. SAAX can reference AP2-style authority proofs, but a live production integration with a specific AP2/UCP merchant deployment is not claimed in this article.
- **Under development / security review:** Custody V3 candidate; independent external security review pending.

## Tradeoffs and limitations

- **Cross-system coordination is hard.** For the full stack to be safe, the agent, the merchant, and the payment rail must all honor the same commitment ID. An ID without enforcement is just a label.
- **Reconciliation is only as good as its sources.** Checking on-chain state assumes you can read the chain; checking the commitment store assumes it survived the crash.
- **MCP "tasks" are experimental.** The current MCP revision marks tasks experimental; durable request semantics are not yet a stable part of MCP itself. That is precisely why the commitment layer sits above MCP rather than inside it.
- **Dispute resolution is bounded.** In SAAX's testnet custody flow, disputed funds can remain frozen if the evaluator disappears; mainnet immediate payments are final and non-custodial.

## The takeaway

MCP, A2A, and UCP make agent commerce *possible*; a durable commitment layer makes it *recoverable*. SAAX is that layer, designed to sit alongside the connectivity and commerce protocols rather than replace them — with the commitment created before value moves and outliving the worker that executes it.

Next step: connect an MCP client to `https://www.saax-protocol.com/mcp`, list the tools, and run `prepare_commitment` against the public endpoint. It is free, nonbinding, and the fastest way to see the commitment lifecycle in action.
