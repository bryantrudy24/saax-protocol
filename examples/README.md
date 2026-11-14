# SAAX Developer Examples — Nonfinancial Starter Kits

Three reproducible, nonfinancial examples that show how SAAX works **before** you touch any real money or production credentials.

| Example | Directory | What it demonstrates | Requires |
|---|---|---|---|
| Crash-Safe Agent Workflow | `crash-safe-workflow/` | Commitment creation, acceptance, simulated crash, durable recovery, idempotent retry | Docker testbed |
| MCP Agent Recovery | `mcp-recovery/` | Real MCP tool discovery + read-only inspection; points to the full recovery suite | Local MCP server / Docker testbed |
| Agentic Commerce Authorization Boundary | `authorization-boundary/` | Conceptual buyer→authority→policy→commitment→payment(sim)→evidence→recovery workflow with every external step clearly labeled | None (pure, offline) |

## Quick start

```bash
npm install
node examples/authorization-boundary/run.cjs     # offline, no testbed needed
node examples/crash-safe-workflow/run.cjs        # needs the Docker testbed
node examples/mcp-recovery/run.cjs               # needs the local MCP server
```

## Safety boundaries

- **Nonfinancial:** none of these examples create real payments, settlements, escrows, or financial obligations.
- **No production credentials:** every example defaults to the local testbed (or fails closed).
- **No production mutations:** nothing writes to `saax-protocol.com` or the production Supabase project.
- **Simulated steps are labeled:** anything standing in for x402/AP2/payment rails or a policy engine is clearly marked `simulated`.

## Going deeper

- Full lifecycle test suite: `npm run test:lifecycle` (needs testbed)
- Full recovery demonstration: `node tests/reliability/test-mcp-three-agent-recovery.cjs` (needs testbed)
- Protocol conformance: `npm run test:conformance` (offline)
- Evidence verification: `npm run test:evidence` (offline)

## What SAAX is (one paragraph)

SAAX Protocol is a vendor-neutral commitment, verification, and recovery layer for agentic commerce. It records durable commitments, persists an attributable lifecycle journal, verifies fulfillment evidence (EIP-712 / COSE / JWS), and lets independently authorized replacement agents recover interrupted workflows. It is not a payment rail, identity provider, oracle, marketplace, or escrow custodian — and the examples above keep those boundaries explicit.
