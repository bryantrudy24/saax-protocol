# SAAX Quickstart — Five-Minute Developer Onboarding

**Goal:** Understand what SAAX does, connect to the public MCP endpoint, and run a safe nonfinancial demonstration — in about five minutes.

**Audience:** Developers already using MCP, x402, or building agentic-commerce workflows.

---

## 1. What SAAX is (and is not)

SAAX Protocol is a vendor-neutral **commitment, verification, and recovery layer** for agentic commerce.

- It records durable commitments (who, what, under what authority, with what acceptance criteria).
- It persists lifecycle state and an audit-grade event journal independently of any agent process.
- It verifies fulfillment evidence (EIP-712, COSE, and JWS proof schemes).
- It governs authorized state transitions — including **independent-agent recovery** after the original agent disappears.

It is **not** a payment rail, identity provider, oracle, marketplace, or escrow custodian. It complements existing payment and identity infrastructure (x402, AP2, ACP, MCP, USDC rails).

Core principle: **The commitment must outlive the worker.**

---

## 2. Connect to the public MCP endpoint

The live MCP server is available at:

```
https://saax-protocol.com/mcp
```

Server name: `saax-protocol` · Protocol version: `2025-06-18` · Application version: `1.0.3`

Use any MCP client (Claude, Roo, Cursor, or the SDK):

```bash
npx @modelcontextprotocol/inspector https://saax-protocol.com/mcp
```

Or a minimal SDK client (Node):

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://saax-protocol.com/mcp")));

const tools = await client.listTools();
console.log(tools.tools.map((t) => t.name).sort());
// 25 tools, including create_commitment, accept_commitment,
// submit_evidence, verify_evidence, resume_commitment, and more
```

**Read-only tools work without authentication** (e.g. `get_protocol_info`, `list_capabilities`, `get_commitment`, `get_commitment_history`). **Mutating tools require a verified principal + durable authorization** — see [Authorization](#4-how-authorization-works).

---

## 3. How commitments work

A commitment is a durable record with a canonical lifecycle:

```
issued → accepted → executing → evidence_pending → evidence_submitted → fulfilled
```

Every transition is:

- Validated against the canonical 17-state / 39-edge state machine.
- Versioned (optimistic concurrency — stale writes are rejected).
- Persisted atomically with an attributable event in the journal.

The lifecycle is exposed through MCP tools (`create_commitment`, `accept_commitment`, `cancel_commitment`, `close_commitment`, `get_commitment_history`).

Read-only inspection (`get_commitment_status`, `get_commitment`, `list_commitments`, `get_recovery_status`, `get_pending_actions`) is open.

---

## 4. How authorization works

Caller-supplied identities are never trusted.

1. Every mutating call must include an **EIP-712 proof** signed by the caller's key.
2. SAAX recovers the signer and verifies the proof domain/scope/validity.
3. The recovered principal must have a **durable authorization record** (`agent_authorizations`) binding agent + principal + role + commitment scope.
4. Authorization is commitment-scoped, expiring, and revocable. **A replacement agent never inherits the original agent's permissions.**

For local testing, the Docker testbed includes a test-only operator token and provisioning helpers. Production provisioning is an operator action (see `docs/gate-h-operator-runbook.md`).

---

## 5. How recovery works

The defining SAAX capability — verified in production:

1. Agent A creates and accepts a commitment.
2. Agent A terminates (process failure, network loss, or abandonment).
3. A separately authorized replacement agent (Agent C) connects.
4. Agent C retrieves the durable state (`get_commitment`, `get_recovery_status`).
5. Agent C performs only the actions its own authorization permits (`resume_commitment`).
6. The journal records the replacement agent's actions; version and idempotency protections prevent double effects.

**Authority never transfers automatically.** Agent C must hold its own independently granted, commitment-scoped authorization.

See [How Independent-Agent Recovery Works](https://saax-protocol.com/recovery) and the worked examples in this repository's `examples/` directory.

---

## 6. Run a safe local demonstration

The repository ships three nonfinancial starter examples under `examples/`:

| Example | Demonstrates |
|---|---|
| `crash-safe-workflow/` | Commitment creation, acceptance, simulated interruption, durable recovery, idempotent retry |
| `mcp-recovery/` | Real MCP tool calls, independent replacement-agent authorization, event-history verification |
| `authorization-boundary/` | Buyer instruction → agent authority → spending policy → commitment → evidence → completion/recovery |

Each example runs against the local Docker testbed (no real funds, no production credentials). See `examples/README.md` for the exact commands.

---

## 7. What's production-verified vs experimental

| Capability | Status |
|---|---|
| MCP endpoint + 25 tools | Live (production) |
| Read-only commitment inspection | Live |
| EIP-712 / COSE / JWS evidence verification | Live (with trusted-issuer policy) |
| Independent-agent recovery | Verified in production (nonfinancial) |
| Dispute governance | Nonfinancial beta |
| Escrow custody | Testnet only — **not** mainnet-ready |
| Payment limits (pilot) | Implemented, **enforcement OFF** |
| Mainnet escrow / EAS signing / settlement automation | **Not activated** |

**Security status:** Independent third-party security validation is a **Pending Release Requirement**. The controlled beta is restricted to authorized nonfinancial evaluation. See [Security Status](https://saax-protocol.com/security).

---

## 8. Next steps

- Clone & test: `npm install && npm test`
- Read the spec: `spec/`
- Run conformance: `npm run test:conformance`
- Explore the examples: `examples/`
- Join the developer discussion: see the GitHub README links

**SAAX — The commitment must outlive the worker.**
