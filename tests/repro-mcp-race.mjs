// MCP concurrent-session race regression — session-based.
//
// The old repro fired 6 initializes without awaiting and checked for the
// "Already connected" leak on the shared server. The per-session model has no
// shared server state, so the assertion is: all concurrent initialize POSTs
// succeed, each returns a DISTINCT session id, and each session remains
// independently usable afterward (no cross-talk).
import { startServer, stopServer, rawJsonRpc } from "./helpers/mcp-client.mjs";
import handler from "../api/mcp.mjs";

const PORT = 18997;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("FAIL " + name + (extra ? " | " + extra : "")); }
}

const server = await startServer(handler, PORT);
console.log("=== MCP concurrent-session race regression (: " + PORT + ") ===");

try {
  // Warm the instance with one successful initialize.
  const warm = await rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "warm", version: "1" } }, id: 1 });
  check("warm initialize ok", !warm.json.error && warm.sessionId, warm.json.error ? JSON.stringify(warm.json.error).slice(0, 120) : "ok");

  // Fire 6 initializes WITHOUT awaiting between them (true concurrency).
  const ids = [2, 3, 4, 5, 6, 7];
  const results = await Promise.allSettled(
    ids.map((id) => rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c" + id, version: "1" } }, id }))
  );
  const ok = results.filter((r) => r.status === "fulfilled" && r.value && !r.value.json.error && r.value.sessionId);
  const sessionIds = new Set(ok.map((r) => r.value.sessionId));
  check("all 6 concurrent initializes succeed with distinct sessions", ok.length === 6 && sessionIds.size === 6, "ok=" + ok.length + " distinct=" + sessionIds.size);

  // Each returned session must be usable (tools/list on every one).
  let usable = 0;
  for (const r of ok) {
    const list = await rawJsonRpc(BASE, { method: "tools/list", params: {}, id: 100 + r.value.json.id, sessionId: r.value.sessionId });
    if (!list.json.error && list.json.result && list.json.result.tools && list.json.result.tools.length === 13) usable++;
  }
  check("all 6 sessions independently usable (13 tools)", usable === 6, "usable=" + usable + "/6");

  // Repeat the burst twice more (warm instance, repeated use).
  for (let round = 0; round < 2; round++) {
    const burst = await Promise.allSettled(
      [8, 9, 10, 11].map((id) => rawJsonRpc(BASE, { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "b" + id, version: "1" } }, id }))
    );
    const bOk = burst.filter((r) => r.status === "fulfilled" && r.value && !r.value.json.error && r.value.sessionId).length;
    const sessionsSet = new Set(burst.filter((r) => r.status === "fulfilled" && r.value && r.value.sessionId).map((r) => r.value.sessionId));
    check("round " + round + ": all succeed, distinct sessions", bOk === 4 && sessionsSet.size === 4, "ok=" + bOk + " distinct=" + sessionsSet.size);
  }
} finally {
  await stopServer(server);
}

console.log("=== RESULT: " + pass + " pass, " + fail + " fail ===");
process.exit(fail ? 1 : 0);