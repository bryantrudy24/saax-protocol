// SAAX Protocol — /route as a Vercel serverless function.
//
// Converts endpoint/route-server.js's handleRoute (a Node http handler) into a
// Vercel function. handleRoute(req, res, body) is fully self-contained: it
// reads req.method / req.headers / req.url and writes via res.writeHead / res.end.
// The standalone server now guards its listener behind require.main, so this
// module can import handleRoute without starting a socket.
import { handleRoute } from "../endpoint/route-server.js";
import usageTelemetry from "../endpoint/usage-telemetry.js";
import { buildStoreClient } from "../endpoint/store.js";

export const config = { runtime: "nodejs", maxDuration: 60 };

// Telemetry is OPT-IN (SAAX_USAGE_TELEMETRY=on) and never affects the request
// outcome: record() swallows every failure and is fire-and-forget. When the
// gateway_requests table is absent (migration not applied), the insert no-ops.
// The store client is the same shared PostgREST client the idempotency /
// rate-limit / pilot-limit modules use — service-role, schema-scoped, and
// write-only for telemetry rows.
if (usageTelemetry.isEnabled()) {
  try { usageTelemetry.setStoreClient(buildStoreClient()); } catch (_) { /* stays disabled */ }
}

/**
 * Vercel handler: adapts the incoming request to the shape handleRoute expects.
 * Only POST /route is supported (matches the standalone server's routing).
 */
export default async function handler(req, res) {
  // CORS preflight (matched by vercel.json headers, but handle it explicitly).
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  if (req.method !== "POST" || url.pathname !== "/route") {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // Buffer the raw body (handleRoute expects a string; it parses internally).
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (chunks.join("").length > 64 * 1024) break;
  }
  const body = chunks.join("");

  // Adapter: handleRoute calls res.writeHead(status, headers) and res.end(string).
  const adaptedRes = {
    writeHead(status, headers) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
    },
    end(payload) {
      if (!res.headersSent) {
        if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
        res.end(payload === undefined ? "" : String(payload));
      } else {
        res.end(payload === undefined ? "" : String(payload));
      }
    },
  };

  const _t0 = Date.now();
  let _outcome = "unknown";
  let _status = null;
  if (typeof res.writeHead === "function") {
    const _origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => {
      _status = status;
      return _origWriteHead(status, headers);
    };
  }
  try {
    await handleRoute(req, adaptedRes, body);
    _outcome = _status && _status < 400 ? "ok" : (_status && _status < 500 ? "error" : "error");
    if (!_status) _status = res.statusCode;
  } catch (e) {
    _outcome = "error";
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify({ error: "internal error", reason: String(e.message || e).slice(0, 300) }));
  } finally {
    // Best-effort telemetry; never awaited, never throws into the response.
    usageTelemetry.record({
      endpoint: "/route",
      method: "POST",
      status: _status || res.statusCode || 500,
      outcome: _outcome,
      durationMs: Date.now() - _t0,
      requestId: req.headers["x-request-id"] || null,
      idempotencyKey: req.headers["idempotency-key"] || null,
      isRetry: !!(req.headers["idempotency-key"]),
      isSynthetic: !!(req.headers["x-mock-*"] || req.headers["x-x402-mock"]),
    }).catch(() => {});
  }
}