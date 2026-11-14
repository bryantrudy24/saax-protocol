#!/usr/bin/env node
// Example 2 — MCP Agent Recovery (nonfinancial)
//
// Two parts:
//   PART A (live): connects to the public MCP endpoint (https://saax-protocol.com/mcp)
//     with a real SDK client, verifies initialization + tool discovery, and runs
//     read-only inspection. No authentication, no mutations, no production writes.
//   PART B (full): invokes the reliability suite that demonstrates the complete
//     independent-agent recovery sequence against the local Docker testbed:
//     A creates -> B accepts -> A terminates -> C (independently authorized)
//     retrieves durable state -> C resumes -> journal records C -> unauthorized
//     and revoked agents rejected -> idempotent replay.
//
// Usage: node examples/mcp-recovery/run.cjs
// Part B requires the local Docker testbed (tests/reliability/README.md).

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const MCP_URL = "https://saax-protocol.com/mcp";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  [" + detail + "]" : "")); }
}

(async () => {
  console.log("--- PART A: live MCP discovery (read-only) ---");

  let client;
  try {
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
    client = new Client({ name: "example-mcp-recovery", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    check("MCP tool discovery returns tools", names.length > 0);
    check("25-tool inventory", names.length === 25, "got " + names.length);
    const required = ["get_commitment_history", "resume_commitment", "get_recovery_status", "create_commitment", "accept_commitment", "get_protocol_info"];
    for (const r of required) check("exposes " + r, names.includes(r));

    const info = await client.callTool({ name: "get_protocol_info", arguments: {} });
    check("get_protocol_info is callable (read-only)", info && !info.isError);

    await client.close();
  } catch (e) {
    check("live MCP connect succeeds", false, e.message);
  }

  console.log("\n--- PART B: independent-agent recovery (local testbed suite) ---");
  const suite = path.resolve(__dirname, "../../tests/reliability/test-mcp-three-agent-recovery.cjs");
  const res = spawnSync(process.execPath, [suite], { stdio: "inherit", timeout: 300000 });
  check("full recovery demonstration passes", res.status === 0, "exit " + res.status);

  console.log(`\nmcp-recovery example: ${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("mcp-recovery example: FAIL -", e.message);
  process.exit(1);
});
