// SAAX MCP acceptance-proxy: a single deterministic URL that alternates EVERY
// forwarded HTTP request — POST, GET, DELETE, notifications, retries — between
// two upstream handler processes in strict DISPATCH order, using ONE shared
// monotonically increasing dispatch counter. No per-method counters, no
// session pinning, no client-side instance selection, no hidden recovery.
//
// The MCP client knows ONLY this proxy URL. The proxy:
//   - Assigns a MONOTONIC dispatch sequence number SYNCHRONOUSLY at request
//     arrival (before any asynchronous forwarding), selects backend odd/even
//     from that single shared counter, and records the dispatch entry
//     immediately — even while the response is still open.
//   - Routes 100% of requests (all methods) strictly A/B/A/B in dispatch order.
//   - For GET (SSE): pipes the upstream body through as a LIVE stream (never
//     buffers with arrayBuffer()); the response stays open until the client
//     cancels, and the dispatch entry is recorded at forward time with
//     separate status/completion/abort tracking.
//   - Records separate "status" (HTTP status once known), "completed"
//     (response finished or stream initiated), and "aborted/error" fields.
//   - Never buffers open streams. Never omits requests.
//
// Stateless mode (SAAX_MCP_MODE=stateless) issues no session id, so there are
// no sessions to pin; the shared counter is the ONLY routing rule.

import { createServer } from "node:http";
import { Readable } from "node:stream";

export function createAlternatingProxy({ ports, log = () => {} }) {
  let dispatchCounter = 0; // ONE shared counter: every forwarded request
  const dispatchOrder = []; // recorded in strict dispatch order

  const server = createServer(async (req, res) => {
    // Synchronous dispatch decision BEFORE any await: one counter, all methods.
    const port = ports[dispatchCounter % ports.length];
    const seq = ++dispatchCounter; // 1-based
    const slot = "global#" + seq;

    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const rawBody = chunks.join("");
    let parsedBody = null;
    try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch (_) {}
    const rpcMethod = parsedBody && parsedBody.method ? parsedBody.method : null;
    const sid = req.headers["mcp-session-id"] || null;

    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers["content-length"];
    headers["connection"] = "close";

    const t0 = Date.now();
    const dispatchEntry = {
      seq, dispatchIndex: dispatchOrder.length + 1, method: req.method, rpc: rpcMethod,
      session: sid, upstreamPort: port, status: null, latencyMs: null, completed: false,
      aborted: false, error: null, slot,
    };
    dispatchOrder.push(dispatchEntry);
    log(dispatchEntry); // record immediately, even while the response is open

    let upstream;
    try {
      upstream = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: req.method,
        headers,
        body: req.method === "POST" || req.method === "DELETE" ? (rawBody || undefined) : undefined,
        redirect: "manual",
      });
    } catch (e) {
      dispatchEntry.status = 502;
      dispatchEntry.latencyMs = Date.now() - t0;
      dispatchEntry.completed = true;
      dispatchEntry.error = String(e.message || e);
      log(dispatchEntry);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "proxy upstream error" }, id: null }));
      return;
    }

    const outHeaders = {};
    for (const [k, v] of upstream.headers) {
      if (k.toLowerCase() === "mcp-session-id") continue;
      outHeaders[k] = v;
    }

    // SSE (GET with Accept: text/event-stream): pipe through as a LIVE stream.
    // Never buffer; the response stays open until the client cancels.
    if (req.method === "GET") {
      dispatchEntry.status = upstream.status;
      dispatchEntry.latencyMs = Date.now() - t0;
      dispatchEntry.completed = true; // response initiated (stream open)
      res.writeHead(upstream.status, outHeaders);
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", () => { dispatchEntry.aborted = true; dispatchEntry.error = "upstream stream closed"; });
      res.on("close", () => { try { nodeStream.destroy(); } catch (_) {} });
      nodeStream.pipe(res);
      log(dispatchEntry);
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    dispatchEntry.status = upstream.status;
    dispatchEntry.latencyMs = Date.now() - t0;
    dispatchEntry.completed = true;
    res.writeHead(upstream.status, outHeaders);
    res.end(body);
    log(dispatchEntry);
  });

  return { server, trace: () => dispatchOrder };
}
