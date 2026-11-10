// SAAX Protocol — Seller-side receipt endpoint (rail-neutral, read-only).
//
// GET /receipt?txHash=0x...&rail=x402|mpp|ap2|acp|unspecified
//
// Reads the EXISTING commitment store (ax_router.commitments) through the
// lookup_receipt_by_txhash RPC. The commitment_id is linked to the on-chain
// txHash at settlement time via settlement_ref->>'txHash', regardless of rail.
// The rail query param is carried through to the response (the store also
// records it in terms.settlementRail when known). Additive; no settlement-path
// code is touched.
import { createClient } from "@supabase/supabase-js";
import usageTelemetry from "../endpoint/usage-telemetry.js";
import { buildStoreClient } from "../endpoint/store.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const config = { runtime: "nodejs", maxDuration: 10 };

if (usageTelemetry.isEnabled()) {
  try { usageTelemetry.setStoreClient(buildStoreClient()); } catch (_) { /* stays disabled */ }
}

export default async function handler(req, res) {
  const _t0 = Date.now();
  let _outcome = "unknown";
  let _status = null;
  // Capture the HTTP status for telemetry WITHOUT assuming res.writeHead
  // exists (unit mocks use { statusCode, setHeader, end } only). Telemetry
  // must never crash the handler path.
  if (typeof res.writeHead === "function") {
    const _origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => { _status = status; return _origWriteHead(status, headers); };
  }
  const _finish = (defaultStatus) => {
    const status = _status || res.statusCode || defaultStatus || 200;
    _outcome = status < 400 ? "ok" : "error";
    usageTelemetry.record({
      endpoint: "/receipt",
      method: req.method,
      status,
      outcome: _outcome,
      durationMs: Date.now() - _t0,
      requestId: req.headers["x-request-id"] || null,
      txHash: String(req.url || "").match(/txHash=([0-9a-fA-Fx]+)/)?.[1] || null,
      chainId: 8453,
      isSynthetic: false,
    }).catch(() => {});
  };

  // CORS (same posture as vercel.json headers).
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    _finish(204);
    return;
  }
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "method not allowed", hint: "use GET /receipt?txHash=...&rail=..." }));
    _finish(405);
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const txHash = String(url.searchParams.get("txHash") || "").trim();
  const rail = String(url.searchParams.get("rail") || "unspecified").trim();

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "invalid txHash", hint: "txHash must be a 0x-prefixed 64-hex hash" }));
    _finish(400);
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "store not configured", hint: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" }));
    _finish(500);
    return;
  }

  const supabaseAxRouter = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "ax_router" },
  });

  let rows;
  try {
    const { data, error } = await supabaseAxRouter.rpc("lookup_receipt_by_txhash", { p_txhash: txHash });
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "store lookup failed", reason: String(e.message || e).slice(0, 200) }));
    _finish(500);
    return;
  }

  if (!rows.length) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found", txHash, rail, message: "no settlement bound to this txHash" }));
    _finish(404);
    return;
  }

  const row = rows[0];
  const terms = row.terms && typeof row.terms === "object" ? row.terms : {};
  const storedRail = terms.settlementRail || null;
  const amountRaw = terms.price && terms.price.amount ? String(terms.price.amount) : "0";
  const currency = terms.price && terms.price.currency ? String(terms.price.currency) : "USDC";

  const receipt = {
    txHash,
    rail: rail !== "unspecified" ? rail : storedRail || "unspecified",
    commitment_id: row.commitment_id,
    payer: row.buyer_email || null,
    payee: terms.sellerId || null,
    amount: amountRaw.includes(".") ? amountRaw + " " + currency : Number(amountRaw) / 1_000_000 + " " + currency,
    settled_at: row.created_at,
  };

  res.statusCode = 200;
  res.end(JSON.stringify(receipt, null, 2));
  _finish(200);
}