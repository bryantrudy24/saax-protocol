# Example 2 — MCP Agent Recovery

Demonstrates the full independent-agent recovery sequence through the **real MCP interface** (not direct database calls).

**Nonfinancial.** Uses the local MCP server + Docker testbed. No production credentials, no production mutations.

## What this proves

1. An MCP client can connect and discover tools.
2. Agent A (buyer) creates and accepts a commitment.
3. Agent A terminates (simulated).
4. A separately authorized replacement agent (Agent C) connects, proves authority, and retrieves durable state.
5. Agent C performs only the actions its own authorization permits (`resume_commitment`).
6. The event journal records the replacement agent's actions.
7. Unauthorized replacement agents are rejected; idempotent retries create no duplicate effects.

## Prerequisites

- Node.js 20+
- The SAAX local Docker testbed, with the MCP server running in `stateless` mode and the testbed migrations applied. See `tests/reliability/README.md`.

## Run

```bash
npm install
node examples/mcp-recovery/run.cjs
```

## Key sequence (abridged)

```js
// A real MCP client against the local server
const client = new Client({ name: "replacement-agent-c", version: "0.1.0" });
await client.connect(transport);

// 1. Discover tools
const tools = await client.listTools();
assert(tools.tools.some(t => t.name === "get_commitment_history"));

// 2. Agent C retrieves durable state (read-only, no auth required)
const history = await client.callTool({ name: "get_commitment_history", arguments: { commitmentId } });
assert(history.state === "accepted");

// 3. Agent C resumes via its OWN authorization (no inheritance)
const resumed = await client.callTool({
  name: "resume_commitment",
  arguments: { commitmentId, proof: agentCProof, action: "execute" },
});
assert(resumed.ok);

// 4. An unauthorized agent is rejected
await assertRejected(client.callTool({ name: "resume_commitment", arguments: { commitmentId, proof: malloryProof, action: "execute" } }));

// 5. Replay is idempotent
const replay = await client.callTool({ name: "resume_commitment", arguments: { commitmentId, proof: agentCProof, action: "execute", idempotencyKey: sameKey } });
assert(replay.replayed === true);
```

## Exit codes

- `0` — all assertions passed
- `1` — an assertion failed

## Notes

- The proof objects are EIP-712 signatures over the SAAX Authority domain; the example generates them with the testbed's test keys.
- This example can also run against `https://saax-protocol.com/mcp` for read-only discovery (set `SAAX_MCP_URL`), but **mutations against production require separately provisioned production authorization and are NOT part of this example.**
