// Shared streamable-http test client for MCP handler tests.
// Proper MCP client behavior: initialize POST captures the Mcp-Session-Id
// response header; every subsequent request MUST echo it (per the streamable
// HTTP spec and SDK examples). Returns { json, status, headers }.
import http from "http";

export async function startServer(handler, port) {
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(port, ok));
  return server;
}

export function stopServer(server) {
  return new Promise((ok) => server.close(ok));
}

export async function rawJsonRpc(base, { method, params, id, sessionId, accept = "application/json, text/event-stream" }) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const headers = {
    "content-type": "application/json",
    accept,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(base, { method: "POST", headers, body });
  const text = await res.text();
  const sessionHeader = res.headers.get("mcp-session-id") || null;
  let payload = text;
  if (text.startsWith("event:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine) payload = dataLine.slice(5).trim();
  }
  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = { error: { code: -32700, message: "unparseable: " + text.slice(0, 200) } }; }
  return { json: parsed, status: res.status, sessionId: sessionHeader, raw: text };
}

// Full session lifecycle: initialize -> tools/list -> optional extra calls.
export async function newSession(base, name, { id = 1 } = {}) {
  const init = await rawJsonRpc(base, {
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } },
    id,
  });
  if (init.json.error) return { error: init.json.error };
  if (!init.sessionId) return { error: { code: -32000, message: "no Mcp-Session-Id returned" } };
  const list = await rawJsonRpc(base, { method: "tools/list", params: {}, id: id + 1, sessionId: init.sessionId });
  return { sessionId: init.sessionId, init, list };
}