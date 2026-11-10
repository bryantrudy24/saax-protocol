// SAAX MCP cross-instance verification harness (independent processes A/B).
//
// Question: what happens when a streamable-http session initialized on one
// Vercel instance is later routed to a DIFFERENT instance (or the original
// instance restarts)? Vercel has NO sticky-session routing for /mcp (plain
// rewrite in vercel.json; no session-affinity config). Session maps are
// process-local (api/mcp.mjs `sessions` Map) — a DB would not preserve a live
// transport. This harness proves the ACTUAL behavior with two independent
// Node processes running the REAL api/mcp.mjs handler, no shared memory, and
// a deterministic routing oracle.
//
// Scenarios (each asserts expected -> observed):
//   S1  init on A, next request to B            -> 404 Session not found (-32001)
//   S2  alternate A/B with re-init on each miss -> each 404 deterministic; each
//       reinit yields a NEW unique session; no hang/5xx
//   S3  restart A, reuse pre-restart session ID -> 404 (no memory across restart)
//   S4  DELETE one session; another stays alive -> scoped teardown
//   S5  GET SSE open on A; POST with same session to B -> 404; A's stream lives
//   S6  abort in-flight on A; reconnect         -> no poisoning; new session works
//   S7  two concurrent clients across A and B   -> responses isolated
//   S8  SDK client behavior on 404             -> surfaces error; re-init new
//       session works (no endless loop within default maxRetries)
//
// Runs only against local isolated processes. NOT a live multi-instance
// financial verification.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT_A = 19101;
const PORT_B = 19102;
const BASE_A = `http://127.0.0.1:${PORT_A}/mcp`;
const BASE_B = `http://127.0.0.1:${PORT_B}/mcp`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("FAIL " + name + (extra ? " | " + extra : "")); }
}

// ---- minimal MCP client over fetch ------------------------------------------
async function rpc(base, { method, params, id, sessionId, accept = "application/json, text/event-stream", signal } = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const headers = { "content-type": "application/json", accept };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  let res;
  try {
    res = await fetch(base, { method: "POST", headers, body, signal });
  } catch (e) {
    return { error: { code: -32000, message: "fetch failed: " + e.message }, status: 0 };
  }
  const text = await res.text();
  const sess = res.headers.get("mcp-session-id") || null;
  let payload = text;
  if (text.startsWith("event:")) {
    const dl = text.split("\n").find((l) => l.startsWith("data:"));
    if (dl) payload = dl.slice(5).trim();
  }
  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = { error: { code: -32700, message: "unparseable" } }; }
  return { json: parsed, status: res.status, sessionId: sess, raw: text };
}

async function initialize(base, name, id) {
  const r = await rpc(base, {
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } },
    id,
  });
  return r;
}

function startServer(handler, port) {
  const server = createServer(handler);
  return new Promise((ok) => server.listen(port, ok));
}

// ---- spawn an independent process server on a port ---------------------------
function spawnInstance(port) {
  // Each child imports the REAL handler with its own module registry; module
  // state (sessions Map, McpServer cache, commitmentStore) is per-process.
  const child = spawn(process.execPath, ["-e", `
    import { pathToFileURL } from "node:url";
    import { createServer } from "node:http";
    import path from "node:path";
    const root = ${JSON.stringify(ROOT)};
    const handler = (await import(pathToFileURL(path.join(root, "api", "mcp.mjs")).href)).default;
    const server = createServer(handler);
    server.listen(${port}, "127.0.0.1", () => process.send && process.send({ type: "ready" }));
    process.on("message", (m) => { if (m === "shutdown") { server.close(() => process.exit(0)); } });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  return new Promise((ok, err) => {
    const t = setTimeout(() => err(new Error("spawn timeout: " + stderr.slice(0, 300))), 15000);
    child.on("message", (m) => { if (m.type === "ready") { clearTimeout(t); ok(child); } });
    child.on("exit", (code) => { clearTimeout(t); err(new Error("child exited " + code + ": " + stderr.slice(0, 300))); });
  });
}

async function stopInstance(child) {
  if (!child || child.exitCode !== null) return;
  child.send("shutdown");
  await new Promise((ok) => { child.once("exit", ok); setTimeout(ok, 2000); });
  try { child.kill(); } catch (_) {}
}

// ---- main --------------------------------------------------------------------
console.log("=== SAAX MCP cross-instance verification (processes A/B, no shared memory) ===");

let A = null, B = null;
try {
  A = await spawnInstance(PORT_A);
  B = await spawnInstance(PORT_B);
  console.log(`spawned A(:${PORT_A}) and B(:${PORT_B}) as independent processes`);

  // S1: initialize on A, next request to B (same session).
  const initA = await initialize(BASE_A, "clientX", 1);
  const sidA = initA.sessionId;
  check("S1a init on A returns session", initA.status === 200 && !!sidA, "sid=" + String(sidA).slice(0, 8));
  const toB = await rpc(BASE_B, { method: "tools/list", params: {}, id: 2, sessionId: sidA });
  check("S1b same-session request to B -> 404", toB.status === 404 && toB.json.error && toB.json.error.code === -32001,
    "status=" + toB.status + " code=" + (toB.json.error && toB.json.error.code));

  // S2: alternation with re-init on each miss.
  const initB1 = await initialize(BASE_B, "clientX", 11);
  const sidB1 = initB1.sessionId;
  check("S2a reinit on B yields NEW unique session", !!sidB1 && sidB1 !== sidA, "sidB1=" + String(sidB1).slice(0, 8));
  const toA2 = await rpc(BASE_A, { method: "tools/list", params: {}, id: 12, sessionId: sidB1 });
  check("S2b session from B to A -> 404", toA2.status === 404, "status=" + toA2.status);
  const initA2 = await initialize(BASE_A, "clientX", 13);
  const sidA2 = initA2.sessionId;
  check("S2c reinit on A unique vs B and prior A", !!sidA2 && sidA2 !== sidA && sidA2 !== sidB1, "sidA2=" + String(sidA2).slice(0, 8));
  const worksA = await rpc(BASE_A, { method: "tools/list", params: {}, id: 14, sessionId: sidA2 });
  check("S2d new session on A works", worksA.status === 200 && !worksA.json.error && worksA.json.result && worksA.json.result.tools, "tools=" + (worksA.json.result && worksA.json.result.tools ? worksA.json.result.tools.length : "?"));
  const worksB = await rpc(BASE_B, { method: "tools/list", params: {}, id: 15, sessionId: sidB1 });
  check("S2e original B session still works", worksB.status === 200 && !worksB.json.error, "status=" + worksB.status);
  const noHang = Date.now() - 0;
  const t0 = Date.now();
  await rpc(BASE_A, { method: "tools/list", params: {}, id: 16, sessionId: "bogus-session" });
  check("S2f unknown session returns fast (no hang)", Date.now() - t0 < 2000, "ms=" + (Date.now() - t0));
  void noHang;

  // S3: restart A, reuse pre-restart session id.
  const sidBeforeRestart = sidA2;
  await stopInstance(A);
  A = await spawnInstance(PORT_A);
  const afterRestart = await rpc(BASE_A, { method: "tools/list", params: {}, id: 21, sessionId: sidBeforeRestart });
  check("S3 restart A: old session -> 404 (no memory)", afterRestart.status === 404, "status=" + afterRestart.status);
  const initAfterRestart = await initialize(BASE_A, "clientX", 22);
  check("S3b fresh init after restart works", initAfterRestart.status === 200 && !!initAfterRestart.sessionId, "status=" + initAfterRestart.status);

  // S4: two sessions on A; DELETE one; the other remains.
  const s1 = (await initialize(BASE_A, "clientY", 31)).sessionId;
  const s2 = (await initialize(BASE_A, "clientZ", 32)).sessionId;
  const delRes = await rpc(BASE_A, { method: "", params: {}, id: 0, sessionId: s1, accept: "application/json" }, { delete: true });
  // DELETE is a raw HTTP method in the handler; use fetch directly.
  const del = await fetch(BASE_A, { method: "DELETE", headers: { "mcp-session-id": s1 } });
  check("S4a DELETE returns 200", del.status === 200, "status=" + del.status);
  const s1after = await rpc(BASE_A, { method: "tools/list", params: {}, id: 33, sessionId: s1 });
  check("S4b deleted session -> 404", s1after.status === 404, "status=" + s1after.status);
  const s2still = await rpc(BASE_A, { method: "tools/list", params: {}, id: 34, sessionId: s2 });
  check("S4c other session still works after scoped DELETE", s2still.status === 200 && !s2still.json.error, "status=" + s2still.status);
  void delRes;

  // S5: open SSE GET on A; POST with same session to B -> 404; A stream alive.
  const sseCtrl = new AbortController();
  const ssePromise = fetch(BASE_A, {
    method: "GET",
    headers: { accept: "text/event-stream", "mcp-session-id": s2 },
    signal: sseCtrl.signal,
  }).then(async (res) => ({ status: res.status, ct: res.headers.get("content-type") })).catch((e) => ({ error: e.message }));
  await new Promise((ok) => setTimeout(ok, 300));
  const crossPost = await rpc(BASE_B, { method: "tools/list", params: {}, id: 41, sessionId: s2 });
  check("S5a same-session POST from A-SSE to B -> 404", crossPost.status === 404, "status=" + crossPost.status);
  const sseState = await ssePromise;
  check("S5b SSE on A opened (200 text/event-stream)", sseState.status === 200 && String(sseState.ct || "").includes("text/event-stream"), "ct=" + sseState.ct);
  sseCtrl.abort();

  // S6: abort in-flight on A; reconnect; no poisoning.
  const ctl = new AbortController();
  const aborted = rpc(BASE_A, { method: "tools/call", params: { name: "get_protocol_info", arguments: {} }, id: 51, sessionId: s2, signal: ctl.signal }).catch(() => null);
  ctl.abort();
  await aborted;
  const afterAbort = await rpc(BASE_A, { method: "tools/list", params: {}, id: 52, sessionId: s2 });
  check("S6 aborted in-flight does not poison session", afterAbort.status === 200 && !afterAbort.json.error, "status=" + afterAbort.status);

  // S7: concurrent clients across A/B — response isolation.
  const c1 = await initialize(BASE_A, "cc1", 61);
  const c2 = await initialize(BASE_B, "cc2", 62);
  const [l1, l2] = await Promise.all([
    rpc(BASE_A, { method: "tools/list", params: {}, id: 63, sessionId: c1.sessionId }),
    rpc(BASE_B, { method: "tools/list", params: {}, id: 64, sessionId: c2.sessionId }),
  ]);
  check("S7a concurrent A+B tools/list both succeed", l1.status === 200 && l2.status === 200 && !l1.json.error && !l2.json.error, "A=" + l1.status + " B=" + l2.status);

  // S8: SDK-client-like recovery — 404 surfaces, then reinit works (no loop).
  // (Approximated by protocol-level behavior: the SDK surfaces the error and
  // the app decides to reinitialize; a new initialize is the recovery.)
  const after404 = await rpc(BASE_A, { method: "tools/call", params: { name: "ping", arguments: {} }, id: 71, sessionId: "lost-session" });
  check("S8a unknown session -> clean -32001 error (not hang, not 5xx)", after404.status === 404 && after404.json.error && after404.json.error.code === -32001, "code=" + (after404.json.error && after404.json.error.code));
  const s8re = await initialize(BASE_A, "clientX", 72);
  check("S8b reinit after 404 succeeds (recovery path)", s8re.status === 200 && !!s8re.sessionId && s8re.sessionId !== "lost-session", "status=" + s8re.status);

  console.log("\n===== CROSS-INSTANCE SUMMARY =====");
  console.log("passed=" + pass + " failed=" + fail);
} catch (e) {
  console.error("HARNESS ERROR: " + (e && e.stack || e));
  console.log("passed=" + pass + " failed=" + fail);
  fail++;
} finally {
  await stopInstance(A);
  await stopInstance(B);
}
process.exit(fail > 0 ? 1 : 0);
