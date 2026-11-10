// MCP stale-transport / warm-instance recovery regression — session-based.
//
// The previous fix closed the module-level server's transport before each
// request; the per-session model makes a stale-shared-transport state
// impossible: each session owns its own McpServer + transport, so a frozen
// warm instance cannot leave ANOTHER session's transport attached. This test:
//   1. Cold initialize works.
//   2. Warm initialize (new session) works.
//   3. 5 repeated tools/list calls in a warm process (same session) all work.
//   4. Concurrent burst of initializes all succeed (distinct sessions).
//   5. A failed request then a success in the same session recovers.
import { startServer, stopServer, rawJsonRpc, newSession } from "./helpers/mcp-client.mjs";
import handler from "../api/mcp.mjs";

const PORT = 18996;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("FAIL " + name + (extra ? " | " + extra : "")); }
}

const server = await startServer(handler, PORT);
console.log("=== MCP stale-transport recovery regression (: " + PORT + ") ===");

try {
  // 1. Cold initialize -> works.
  const init1 = await rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cold", version: "1" } }, id: 1 });
  check("cold initialize ok", !init1.json.error && init1.sessionId, init1.json.error ? JSON.stringify(init1.json.error).slice(0, 120) : "ok");

  // 2. Warm initialize (a NEW session) after the prior request.
  const init2 = await rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "warm", version: "1" } }, id: 2 });
  check("warm initialize (new session) ok", !init2.json.error && init2.sessionId, init2.json.error ? JSON.stringify(init2.json.error).slice(0, 160) : "ok");

  // 3. 5 repeated tools/list in warm process (same session).
  let warmOk = 0, warmErr = 0;
  for (let i = 0; i < 5; i++) {
    const r = await rawJsonRpc(BASE, { method: "tools/list", params: {}, id: 10 + i, sessionId: init2.sessionId });
    if (!r.json.error) warmOk++; else warmErr++;
  }
  check("5 repeated tools/list in warm process all ok", warmErr === 0, "ok=" + warmOk + " err=" + warmErr);

  // 4. Concurrent burst of initializes (each its own session).
  const burst = await Promise.allSettled(
    [3, 4, 5, 6, 7].map((id) => rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "b" + id, version: "1" } }, id }))
  );
  const bOk = burst.filter((r) => r.status === "fulfilled" && r.value && !r.value.json.error && r.value.sessionId).length;
  const bLeaks = burst.filter((r) => r.status === "fulfilled" && r.value && r.value.json.error && /already connected|transport/i.test(JSON.stringify(r.value.json.error))).length;
  check("concurrent burst: all succeed, no transport leak", bLeaks === 0 && bOk === 5, "ok=" + bOk + "/5 leaks=" + bLeaks);

  // 5. Failed request then success (error recovery in same session).
  const s = await newSession(BASE, "er", { id: 20 });
  check("error-recovery session init ok", !s.error, s.error ? JSON.stringify(s.error).slice(0, 120) : "ok");
  const bad = await rawJsonRpc(BASE, { method: "tools/call", params: { name: "route_request", arguments: {} }, id: 21, sessionId: s.sessionId });
  const good = await rawJsonRpc(BASE, { method: "tools/call", params: { name: "ping", arguments: {} }, id: 22, sessionId: s.sessionId });
  check("failed request then success recovers", !good.json.error, good.json.error ? JSON.stringify(good.json.error).slice(0, 160) : "ok");
} finally {
  await stopServer(server);
}

console.log("=== RESULT: " + pass + " pass, " + fail + " fail ===");
process.exit(fail ? 1 : 0);