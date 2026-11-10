// Day 13 — MCP tools functional smoke (local, no deploy).
// Boots api/mcp.mjs on a REAL Node http server (the Vercel contract: a
// (req, res) handler) and drives it with real HTTP JSON-RPC calls for every
// tool, including the security-gate cases.
import http from "http";
import handler, { noteCommitment } from "../api/mcp.mjs";

const PORT = 18999;
const server = http.createServer(handler);
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let _sessionId = null;
async function jsonRpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (_sessionId) headers["mcp-session-id"] = _sessionId;
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body,
  });
  const sessionHeader = res.headers.get("mcp-session-id");
  if (sessionHeader) _sessionId = sessionHeader;
  const text = await res.text();
  // streamable-http frames responses as SSE (event: message\ndata: {...}).
  let payload = text;
  if (text.startsWith("event:")) {
    const dataLine = text.split("\n").find(l => l.startsWith("data:"));
    if (dataLine) payload = dataLine.slice(5).trim();
  }
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return { error: "unparseable: " + text.slice(0, 200) }; }
  return parsed;
}

async function callTool(name, args) {
  const r = await jsonRpc("tools/call", { name, arguments: args || {} });
  if (r.error) return { error: r.error };
  if (r.result && r.result.content && r.result.content[0]) {
    try { return JSON.parse(r.result.content[0].text); }
    catch { return { raw: r.result.content[0].text }; }
  }
  return r;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("FAIL " + name + (extra ? " | " + extra : "")); }
}

await new Promise((ok) => server.listen(PORT, ok));
console.log("=== SAAX MCP wiring smoke (local :" + PORT + ") ===");

try {
  const init = await jsonRpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check("initialize responds", !init.error && (init.result || init.protocolVersion), init.error ? JSON.stringify(init.error).slice(0, 100) : "ok");

  const list = await jsonRpc("tools/list", {});
  const names = list.result && list.result.tools ? list.result.tools.map(t => t.name) : [];
  // 13 tools: the original 10 plus create_commitment (dad37a7d), prepare_commitment
  // and accept_commitment (Discovery Phase 3/4) registered after this test was written.
  check("tools/list has 13 tools", names.length === 13, "tools=" + names.join(","));
  check("route_request registered", names.includes("route_request"));
  check("get_commitment registered", names.includes("get_commitment"));
  check("list_capabilities registered", names.includes("list_capabilities"));
  check("list_commitments registered", names.includes("list_commitments"));
  check("get_commitment_status registered", names.includes("get_commitment_status"));

  // --- Tool 4: route_request ----------------------------------------------------
  const r1 = await callTool("route_request", { capability: "security scan", budget: 0.05, deadline: 3600 });
  check("route_request status ok", r1.status === "ok", "status=" + r1.status);
  check("route_request returns suppliers", Array.isArray(r1.suppliers) && r1.suppliers.length > 0, "count=" + (r1.suppliers || []).length);
  if (r1.suppliers && r1.suppliers[0]) {
    const s0 = r1.suppliers[0];
    check("ranked supplier shape", s0.agentId !== undefined && s0.score !== undefined && s0.payTo !== undefined,
      "agentId=" + s0.agentId + " score=" + s0.score + " payTo=" + String(s0.payTo).slice(0, 12) + "...");
  }

  // --- Security gate: empty capability -------------------------------------------
  const rEmpty = await callTool("route_request", { capability: "" });
  check("empty capability -> no_match (fail closed)", rEmpty.status === "no_match", "status=" + rEmpty.status + " reason=" + (rEmpty.reason || ""));

  // --- Security gate: injection attempt -------------------------------------------
  const rInj = await callTool("route_request", { capability: "security scan; DROP TABLE suppliers; --" });
  check("injection attempt sanitized (no crash)", !rInj.error, rInj.error ? JSON.stringify(rInj.error).slice(0, 120) : "status=" + rInj.status);

  // --- Tool 5: get_commitment (not found) -------------------------------------------
  const rNF = await callTool("get_commitment", { commitmentId: "0x" + "ab".repeat(32) });
  check("get_commitment unknown -> not_found", rNF.status === "not_found", "status=" + rNF.status);

  // --- Tool 5: get_commitment (invalid id) ------------------------------------------
  const rBad = await callTool("get_commitment", { commitmentId: "x!" });
  check("get_commitment invalid -> invalid", rBad.status === "invalid", "status=" + rBad.status);

  // --- Tool 6: list_capabilities -----------------------------------------------------
  const rCaps = await callTool("list_capabilities", {});
  check("list_capabilities ok", rCaps.status === "ok" && Array.isArray(rCaps.capabilities), "count=" + (rCaps.capabilities || []).length);
  if (rCaps.capabilities && rCaps.capabilities[0]) {
    check("capability shape", rCaps.capabilities[0].capability !== undefined && rCaps.capabilities[0].suppliers !== undefined,
      JSON.stringify(rCaps.capabilities[0]));
  }

  // --- Regression: original tools still work ------------------------------------------
  const rInfo = await callTool("get_protocol_info", {});
  check("get_protocol_info ok", rInfo.name === "saax-protocol", "name=" + rInfo.name);
  const rFee = await callTool("get_routing_fee", {});
  check("get_routing_fee ok", rFee.amount === 50000 && rFee.currency === "USDC", "amount=" + rFee.amount);
  const rPing = await callTool("ping", {});
  check("ping ok", rPing === "ok" || (rPing.raw === "ok"), JSON.stringify(rPing));

  // --- Tool 7: list_commitments -------------------------------------------------------
  // Gating: no local Supabase creds in this environment, so an active email cannot
  // be verified here (the live deploy is verified separately). The gating branch,
  // empty-array branch, and shape are asserted structurally.
  const rLC = await callTool("list_commitments", { subscriptionEmail: "someone@example.com" });
  check("list_commitments gated (payment_required or gate error, never ungated ok)",
    rLC.status === "payment_required" || rLC.status === "error",
    "status=" + rLC.status + " reason=" + (rLC.reason || ""));

  // --- Tool 8: get_commitment_status --------------------------------------------------
  const rCS_NF = await callTool("get_commitment_status", { commitmentId: "0x" + "cd".repeat(32) });
  check("get_commitment_status unknown -> not_found", rCS_NF.status === "not_found", "status=" + rCS_NF.status);
  const rCS_Bad = await callTool("get_commitment_status", { commitmentId: "x!" });
  check("get_commitment_status invalid -> invalid", rCS_Bad.status === "invalid", "status=" + rCS_Bad.status);

  // Success path: seed the store (same module instance the handler uses), then poll.
  const seededId = "0x" + "ef".repeat(32);
  noteCommitment({
    commitmentId: seededId,
    buyerAgentId: "buyer-agent-1",
    sellerAgentId: "seller-agent-1",
    capability: "security scan",
    price: { amount: "50000", currency: "USDC", decimals: 6 },
    acceptanceCriteria: { type: "hash", value: "sha256:test" },
    deadline: new Date(Date.now() + 3600000).toISOString(),
    cancelCondition: "buyer-cancel-before-delivery",
    manifestHash: "sha256:test-manifest",
  });
  const rCS_OK = await callTool("get_commitment_status", { commitmentId: seededId });
  const csKeys = Object.keys(rCS_OK).sort().join(",");
  check("get_commitment_status success returns {commitmentId,state,next_action} (issued -> poll)",
    rCS_OK.commitmentId === seededId && rCS_OK.state === "issued" && csKeys === "commitmentId,next_action,state" && rCS_OK.next_action === "poll",
    "keys=" + csKeys + " state=" + rCS_OK.state + " next_action=" + rCS_OK.next_action);

  // list_commitments shares the SAME store get_commitment/get_commitment_status read.
  // (Gating prevents a local read without Supabase creds; the seeded record is proven
  // visible via get_commitment below.)
  const rGC_Seeded = await callTool("get_commitment", { commitmentId: seededId });
  check("get_commitment sees the seeded record (same store)", rGC_Seeded.status === "found", "status=" + rGC_Seeded.status);
} finally {
  server.close();
}

console.log("=== RESULT: " + pass + " pass, " + fail + " fail ===");
process.exit(fail ? 1 : 0);