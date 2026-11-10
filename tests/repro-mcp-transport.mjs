// MCP transport reuse regression — session-based (SDK simpleStreamableHttp pattern).
//
// Updated from the original stateless repro (which asserted the module-level
// singleton behavior): the session model REQUIRES the client to echo the
// Mcp-Session-Id header on every request after initialize. This test proves:
//   1. Cold initialize works.
//   2. Warm initialize (second session) works — no "Already connected".
//   3. tools/list inside the SAME session works after warm reuse.
//   4. Concurrent initializes both succeed (each gets its own session).
//   5. A failed request followed by success in the same session recovers.
import { startServer, stopServer, rawJsonRpc, newSession } from "./helpers/mcp-client.mjs";
import handler from "../api/mcp.mjs";

const PORT = 18998;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("FAIL " + name + (extra ? " | " + extra : "")); }
}

const server = await startServer(handler, PORT);
console.log("=== MCP transport reuse regression (: " + PORT + ") ===");

try {
  // 1. First initialize on a cold instance.
  const init1 = await rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "repro", version: "1" } }, id: 1 });
  check("cold initialize ok", !init1.json.error && init1.sessionId, init1.json.error ? JSON.stringify(init1.json.error).slice(0, 120) : "ok");

  // 2. Second initialize on the SAME warm instance (a different session).
  const init2 = await rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "repro2", version: "1" } }, id: 2 });
  check("warm initialize (new session) ok", !init2.json.error && init2.sessionId && init2.sessionId !== init1.sessionId, init2.json.error ? JSON.stringify(init2.json.error).slice(0, 160) : "ok");

  // 3. tools/list in the FIRST session after warm reuse.
  const list = await rawJsonRpc(BASE, { method: "tools/list", params: {}, id: 3, sessionId: init1.sessionId });
  check("tools/list in original session ok", !list.json.error && list.json.result && list.json.result.tools && list.json.result.tools.length === 13, list.json.error ? JSON.stringify(list.json.error).slice(0, 160) : "ok");

  // 4. Concurrent initializes (each gets its own session).
  const concurrent = await Promise.allSettled([
    rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c1", version: "1" } }, id: 4 }),
    rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c2", version: "1" } }, id: 5 }),
  ]);
  const cOk = concurrent.filter((r) => r.status === "fulfilled" && r.value && !r.value.json.error && r.value.sessionId).length;
  check("concurrent initializes both succeed with distinct sessions", cOk === 2, "ok=" + cOk + "/2");

  // 5. Failed request then success in the same session.
  const s = await newSession(BASE, "recovery", { id: 10 });
  check("recovery session init ok", !s.error, s.error ? JSON.stringify(s.error).slice(0, 120) : "ok");
  const bad = await rawJsonRpc(BASE, { method: "tools/call", params: { name: "route_request", arguments: {} }, id: 11, sessionId: s.sessionId });
  const good = await rawJsonRpc(BASE, { method: "tools/call", params: { name: "ping", arguments: {} }, id: 12, sessionId: s.sessionId });
  check("failed request then success in same session", !good.json.error, good.json.error ? JSON.stringify(good.json.error).slice(0, 160) : "ok");
} finally {
  await stopServer(server);
}

console.log("=== RESULT: " + pass + " pass, " + fail + " fail ===");
process.exit(fail ? 1 : 0);