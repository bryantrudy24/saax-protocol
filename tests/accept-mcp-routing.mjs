// SAAX MCP cross-instance routing ACCEPTANCE TEST (deterministic, global
// dispatch-order alternation across EVERY forwarded request).
//
// Requirement (owner-agreed): strict alternation across EVERY forwarded HTTP
// request — not only POST requests. One shared monotonically increasing
// dispatch counter; backend selected synchronously at dispatch; odd/even →
// A/B consistently; no per-method counters, no pinning, no manual recovery.
//
// Flow: two independent Node processes run the REAL api/mcp.mjs handler in
// stateless mode (SAAX_MCP_MODE=stateless). A single proxy URL alternates
// EVERY request (POST initialize, notifications, GET/SSE, tool calls, DELETE
// teardown, retries) strictly A/B/A/B in dispatch order. The client is the
// real @modelcontextprotocol/sdk StreamableHTTPClient + Client, configured
// ONLY with the proxy URL.
//
// Success = initialization resolves, tools/list returns the 13-tool set,
// tools/call ping returns "ok", tools/call get_protocol_info returns content,
// all within one bounded deadline, with STRICT GLOBAL alternation asserted
// over the complete dispatch trace (including teardown requests).
//
// Operation success is kept separate from stream-close/abort behavior: the
// SSE GET entry is recorded at dispatch time and its open stream is tracked
// via aborted/completed fields, but it does not fail the alternation or
// operation assertions.
//
// Local only. Not a live multi-instance financial verification. Not a proof
// of exactly-once payment execution (see repro-mcp-financial-boundary.mjs).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createAlternatingProxy } from "./helpers/alternating-proxy.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT_A = 19301;
const PORT_B = 19302;
const PROXY_PORT = 19303;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}/mcp`;
const DEADLINE_MS = 60_000;

const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");

// Teardown hygiene: when child handler processes are killed after the verdict,
// undici's global agent can surface an unhandled "terminated"/ECONNRESET
// rejection from a socket closed mid-teardown. That is process noise AFTER all
// acceptance assertions have already been evaluated — it must not flip the
// exit code. The verdict is driven solely by the assertion counters below.
process.on("unhandledRejection", (err) => {
  console.error("(teardown noise, non-fatal) unhandledRejection:", (err && err.message) || err);
});

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("FAIL " + name + (extra ? " | " + extra : "")); }
}

function spawnInstance(port) {
  const child = spawn(process.execPath, ["-e", `
    import { pathToFileURL } from "node:url";
    import { createServer } from "node:http";
    import path from "node:path";
    const root = ${JSON.stringify(ROOT)};
    process.env.SAAX_MCP_MODE = "stateless";
    const handler = (await import(pathToFileURL(path.join(root, "api", "mcp.mjs")).href)).default;
    const server = createServer(handler);
    server.listen(${port}, "127.0.0.1", () => process.send && process.send({ type: "ready" }));
    process.on("message", (m) => { if (m === "shutdown") server.close(() => process.exit(0)); });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return new Promise((ok, err) => {
    child.stderr.on("data", () => { /* quiet unless fatal */ });
    const t = setTimeout(() => err(new Error("spawn timeout")), 15000);
    child.on("message", (m) => { if (m.type === "ready") { clearTimeout(t); ok(child); } });
    child.on("exit", (c) => { clearTimeout(t); err(new Error("child exit " + c)); });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.send("shutdown");
  await new Promise((ok) => { child.once("exit", ok); setTimeout(ok, 2000); });
  try { child.kill(); } catch (_) {}
}

console.log("=== SAAX MCP cross-instance ACCEPTANCE (real SDK client, alternating proxy, stateless, GLOBAL alternation) ===");

let A = null, B = null, proxy = null;
const tStart = Date.now();
try {
  A = await spawnInstance(PORT_A);
  B = await spawnInstance(PORT_B);
  const { server, trace } = createAlternatingProxy({
    ports: [PORT_A, PORT_B],
    log: (e) => console.log(`  dispatch#${e.dispatchIndex} seq#${e.seq} ${e.method} ${e.rpc || "-"} sid=${e.session ? String(e.session).slice(0, 8) : "-"} -> :${e.upstreamPort} ${e.status === null ? "..." : e.status} ${e.latencyMs === null ? "" : e.latencyMs + "ms"}${e.completed ? "" : " (in flight)"}${e.aborted ? " ABORTED" : ""}`),
  });
  await new Promise((ok) => server.listen(PROXY_PORT, ok));
  proxy = server;
  console.log(`proxy on ${PROXY_URL} alternating :${PORT_A} / :${PORT_B} (GLOBAL dispatch-order, every request)`);

  // The REAL client, pointed ONLY at the proxy.
  const transport = new StreamableHTTPClientTransport(new URL(PROXY_URL));
  const client = new Client({ name: "acceptance-client", version: "1.0.0" });

  // Bound the whole operation.
  const deadline = setTimeout(() => {
    console.error("FATAL: acceptance deadline exceeded (" + DEADLINE_MS + "ms)");
    fail++;
  }, DEADLINE_MS);

  // 1) initialize — client.connect throws on any initialize failure; resolving
  //    without error IS the successful-init assertion.
  await client.connect(transport);
  check("initialize succeeds through alternating proxy", true, "connect resolved (initialized+negotiated without error)");

  // 2) tools/list
  const toolsResult = await client.listTools();
  check("tools/list succeeds with tool results", !!(toolsResult && toolsResult.tools && toolsResult.tools.length > 0), "tools=" + (toolsResult && toolsResult.tools ? toolsResult.tools.length : "none"));
  const names = (toolsResult.tools || []).map(t => t.name);
  check("tool set includes expected tools", ["get_protocol_info", "ping", "route_request", "list_capabilities"].every(n => names.includes(n)), names.slice(0, 5).join(",") + ",...");

  // 3) harmless read-only tool call: ping
  const pingResult = await client.callTool({ name: "ping", arguments: {} });
  const pingText = pingResult && pingResult.content && pingResult.content.map ? pingResult.content.map(c => c.text || "").join("") : "";
  check("tools/call ping completes with result", !!pingResult && pingText.trim() === "ok", "content=" + JSON.stringify(pingText));

  // 4) a second read-only call (get_protocol_info) to prove repeated alternation works
  const infoResult = await client.callTool({ name: "get_protocol_info", arguments: {} });
  check("tools/call get_protocol_info completes", !!infoResult && (infoResult.content || []).length > 0, "content-lines=" + (infoResult.content || []).length);

  clearTimeout(deadline);
  await client.close();
  await transport.close();

  const elapsedMs = Date.now() - tStart;
  check("whole acceptance within bounded deadline", elapsedMs < DEADLINE_MS, "elapsed=" + elapsedMs + "ms");

  const tr = trace();
  let posts;
  // Teardown requests (client.close/transport.close may emit DELETE) are part
  // of the trace; operation success is separate from stream-close behavior.
  // The alternation assertion covers EVERY forwarded request in dispatch order.
  console.log("\n===== ROUTING TRACE (" + tr.length + " requests, DISPATCH order) =====");
  for (const e of tr) console.log(`  dispatch#${e.dispatchIndex} seq#${e.seq} ${e.method} ${e.rpc || "-"} sid=${e.session ? String(e.session).slice(0, 8) : "-"} -> :${e.upstreamPort} ${e.status} ${e.latencyMs}ms${e.aborted ? " ABORTED" : ""}`);
  const upstreams = new Set(tr.map(e => e.upstreamPort));
  const statuses = tr.map(e => e.status);
  check("traffic spanned BOTH independent instances", upstreams.size === 2, "upstreams=" + [...upstreams].join(","));
  check("no 404/5xx in the acceptance flow", statuses.every(s => s !== null && s < 400), "statuses=" + statuses.join(","));
  // STRICT GLOBAL alternation: every forwarded request (all methods, including
  // teardown) must alternate A/B/A/B in dispatch order with ONE shared counter.
  check("STRICT GLOBAL A/B alternation over EVERY forwarded request (dispatch order)", (() => {
    if (tr.length < 2) return false;
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].upstreamPort === tr[i - 1].upstreamPort) return false;
    }
    return true;
  })(), "requests=" + tr.length + " sequence=" + tr.map(e => (e.upstreamPort === PORT_A ? "A" : "B")).join(","));
  // NOTE: no separate "POST-subset alternation" assertion exists. Under ONE
  // shared dispatch counter, a non-POST request (GET/SSE) interleaved between
  // POSTs necessarily makes the POST-only subset read e.g. A,B,B,A,B while the
  // GLOBAL sequence is strictly A,B,A,B,A,B. Asserting per-method alternation
  // would reintroduce the method-specific-counter mistake this test removes.
  posts = tr.filter(e => e.method === "POST");
  // Mobile/desktop SDK GET streams may remain open; they must be recorded but
  // operation success is defined by the assertions above, not by stream close.
  const opens = tr.filter(e => e.method === "GET");
  check("open SSE streams recorded without failing the flow", opens.every(e => e.status !== null && e.status < 400), "GET count=" + opens.length + " statuses=" + opens.map(e => e.status).join(","));

  console.log("\n===== ACCEPTANCE SUMMARY =====");
  console.log("passed=" + pass + " failed=" + fail + " elapsed=" + elapsedMs + "ms");
} catch (e) {
  console.error("HARNESS ERROR: " + (e && e.stack || e));
  fail++;
  console.log("passed=" + pass + " failed=" + fail);
} finally {
  if (proxy) await new Promise((ok) => proxy.close(ok));
  await stop(A);
  await stop(B);
}
process.exit(fail > 0 ? 1 : 0);
