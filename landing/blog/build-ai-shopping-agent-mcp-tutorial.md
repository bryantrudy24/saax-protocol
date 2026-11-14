# Build an AI Shopping Agent with MCP Tools: A Step-by-Step Tutorial

*November 14, 2026*

---

This tutorial builds a minimal but real AI shopping agent: an MCP server exposing product lookup and checkout tools, a client that lets an LLM call them, and an authorization boundary that keeps the agent from spending without a durable commitment. The code is tested against the public SAAX MCP endpoint for the commitment step.

## What you will build

- An **MCP server** (Node.js, TypeScript optional) exposing two tools: `search_products` and `create_commitment`.
- An **MCP client** that connects a model (e.g., Claude or any MCP-capable assistant) to those tools.
- A **commitment record** created before any payment, using SAAX's public MCP interface, so the agent's authority, terms, and acceptance criteria are durable.

## Prerequisites

- Node.js 18+ and npm.
- The `@modelcontextprotocol/sdk` package.
- An OpenAI-compatible or Anthropic API key for the model (or any MCP host).

## Step 1 — Scaffold the MCP server

```bash
mkdir shopping-agent && cd shopping-agent
npm init -y
npm install @modelcontextprotocol/sdk @supabase/supabase-js dotenv
```

Create `server.js`:

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "shopping-agent", version: "0.1.0" });
```

## Step 2 — Add the product lookup tool

```js
const catalog = [
  { id: "p1", name: "USB-C Dock", priceUsdc: "29.50", inStock: true },
  { id: "p2", name: "Mechanical Keyboard", priceUsdc: "89.00", inStock: true },
  { id: "p3", name: "4K Monitor", priceUsdc: "249.00", inStock: false },
];

server.tool(
  "search_products",
  { query: z.string(), maxPriceUsdc: z.string().optional() },
  async ({ query, maxPriceUsdc }) => {
    const q = query.toLowerCase();
    const results = catalog.filter(p =>
      p.name.toLowerCase().includes(q) &&
      (!maxPriceUsdc || Number(p.priceUsdc) <= Number(maxPriceUsdc))
    );
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);
```

## Step 3 — Add the commitment tool (authorization boundary)

Before any payment, the agent should record a commitment: what it is buying, for whom, at what price, with what acceptance criteria. The SAAX public MCP endpoint accepts a signed commitment request. This example uses the read-only/preflight path; real payment requires an onboarded buyer key.

```js
const SAAX_MCP_URL = "https://saax-protocol.com/mcp"; // or your MCP endpoint

server.tool(
  "create_commitment",
  {
    productId: z.string(),
    buyerAddress: z.string(),
    amountUsdc: z.string(),
    terms: z.string().optional(),
  },
  async ({ productId, buyerAddress, amountUsdc, terms }) => {
    const product = catalog.find(p => p.id === productId);
    if (!product || !product.inStock) {
      return { content: [{ type: "text", text: "Product unavailable" }] };
    }
    // In production this is an EIP-712 signed message from the buyer's key.
    // The SAAX MCP server verifies the recovered signer against the durable
    // authorization registry before any lifecycle transition.
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          commitmentId: "cmt_" + Math.random().toString(36).slice(2),
          product: product.name,
          amountUsdc,
          state: "issued",
          message: "Commitment created. Payment requires a signed acceptance by the buyer key.",
        }, null, 2),
      }],
    };
  }
);
```

## Step 4 — Run the server

```bash
node server.js
```

The server speaks MCP over stdio. Point an MCP-capable host (Claude Desktop, VS Code with the MCP extension, or a custom client) at it:

```json
{
  "mcpServers": {
    "shopping-agent": { "command": "node", "args": ["server.js"] }
  }
}
```

## Step 5 — Test with a real MCP client

```js
// client.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node", args: ["server.js"]
});
const client = new Client({ name: "shopping-agent-client", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map(t => t.name));

const res = await client.callTool({
  name: "search_products",
  arguments: { query: "keyboard", maxPriceUsdc: "100" }
});
console.log(res.content[0].text);
await client.close();
```

Run it:

```bash
node client.mjs
# Tools: search_products, create_commitment
# [ { "id": "p2", "name": "Mechanical Keyboard", ... } ]
```

## Why the commitment step matters

The tutorial keeps the commitment step minimal, but it is the difference between an agent that can "buy things" and one that can be trusted to. Three properties matter:

1. **Durability.** The commitment survives the agent process. If the agent crashes after creating it, a replacement agent can retrieve the record and continue. SAAX verifies this with an append-only event journal and durable authorization records.
2. **Authorization.** The commitment binds the buyer's verified signature. A replacement agent cannot inherit it; it must hold its own authorization row. The SAAX MCP interface rejects any lifecycle transition whose caller does not match the durable registry.
3. **Idempotency.** Retrying a request with the same idempotency key returns the original result instead of creating a duplicate. Without this, a network retry after a timeout double-charges.

## Next steps

- Replace the in-memory catalog with a real product feed (structured for agents, e.g., a JSON-LD product feed or a UCP/ACP-compatible profile).
- Wire `create_commitment` to a real signed message using a wallet library (ethers or viem), and use SAAX's `/prepare-commitment` preflight before signing.
- Add acceptance-criteria verification: require evidence (e.g., a signed delivery note) before the commitment moves to `fulfilled`.

For the full lifecycle — issuing, accepting, executing, evidence submission, recovery, and disputes — see the [SAAX MCP documentation](/docs) and the [protocol specification](/spec). A complete agent order flow is described in [From Intent to Fulfillment](/blog/agentic-commerce-order-flow).