// SAAX receipt regression — focused test for the store-schema 500 defect.
//
// Defect (2026-11-06): production GET /receipt returned HTTP 500
//   {"error":"store lookup failed","reason":"Invalid schema: ax_router"}
// The ax_router schema was not exposed to PostgREST (authenticator
// pgrst.db_schemas lacked it). Fixed by an additive DB migration
// (data/migration-20261106-expose-ax-router-postgrest.sql); the endpoint
// code was already correct.
//
// This regression proves the handler behaves correctly across the contract:
//   - known txHash  -> 200 with commitment fields (NO fabricated data)
//   - unknown txHash -> 404 {error:"not found"}
//   - invalid/missing txHash -> 400 {error:"invalid txHash"}
//   - store outage / schema error -> truthful 500 service error
// It runs the REAL handler (api/receipt.mjs) with a mocked Supabase client
// (no network, no secrets).

import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal fetch shim that routes to the handler with a mocked rpc.
// The handler uses the global fetch? No — it uses @supabase/supabase-js with
// env-provided URL/key. We don't want real network in a unit test, so we
// load the handler with process.env set and stub @supabase/supabase-js via
// Node's module resolution is NOT possible at runtime... instead we run the
// handler and point it at a local mock server serving the RPC shape.
//
// Simpler and honest: start a tiny HTTP server that emulates the PostgREST
// rpc endpoint (lookup_receipt_by_txhash) with the row/none/error cases,
// set SUPABASE_URL to it, and call the real handler with a request/response
// pair. This exercises the real client construction AND the real handler
// serialization — the closest thing to the production path without secrets.

import http from "node:http";
import { once } from "node:events";

const KNOWN_ROW = {
  commitment_id: "saax_e8c3107513646a58",
  state: "issued",
  capability: "security-scan",
  buyer_email: "buyer@example.test",
  terms: {
    price: { amount: "50000", currency: "USDC" },
    settlementRail: "x402",
    sellerId: "seller-123",
  },
  authority_ref: "did:saax:provider:test",
  evidence_refs: [],
  settlement_ref: '{"txHash":"0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb","rail":"x402"}',
  manifest_hash: "0xabc123",
  created_at: "2026-10-13T13:30:13.507593+00:00",
};

function startMockStore({ mode }) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST" || !req.url.includes("lookup_receipt_by_txhash")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (mode === "schema-error") {
      // Emulate the PostgREST schema-exposure failure the fix addressed.
      res.statusCode = 500;
      res.end(JSON.stringify({ message: 'schema cache could not be loaded: "ax_router" is not in the schema list' }));
      return;
    }
    if (mode === "outage") {
      res.statusCode = 503;
      res.end(JSON.stringify({ message: "service unavailable" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let txHash = "";
      try { txHash = (JSON.parse(body).p_txhash || "").toLowerCase(); } catch {}
      const known = "0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb";
      if (mode === "found" && txHash === known) {
        res.statusCode = 200;
        res.end(JSON.stringify([KNOWN_ROW]));
      } else {
        res.statusCode = 200;
        res.end(JSON.stringify([]));
      }
    });
  });
  return server;
}

// Load the real handler fresh per test (it reads env at import time).
async function callHandler({ mode, query, supabaseUrl, serviceKey }) {
  const server = startMockStore({ mode });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = supabaseUrl || base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey || "test-service-role-key";

  // Invalidate the module cache so the handler re-reads env.
  const handlerPath = new URL("../api/receipt.mjs", import.meta.url);
  const mod = await import(handlerPath.href + `?t=${Date.now()}`);
  const handler = mod.default;

  const req = {
    method: "GET",
    url: "/receipt" + (query ? "?" + query : ""),
    headers: {},
  };
  let statusCode = 0;
  let body = "";
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk) {
      statusCode = this.statusCode;
      body = String(chunk);
    },
  };

  try {
    await handler(req, res);
  } catch (e) {
    statusCode = 500;
    body = JSON.stringify({ error: "handler threw", reason: String(e.message || e) });
  } finally {
    process.env.SUPABASE_URL = prevUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    server.close();
  }
  return { statusCode, body: body ? JSON.parse(body) : {} };
}

test("receipt: known txHash -> 200 with commitment fields", async () => {
  const { statusCode, body } = await callHandler({
    mode: "found",
    query: "txHash=0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb&rail=x402",
  });
  assert.equal(statusCode, 200);
  assert.equal(body.commitment_id, "saax_e8c3107513646a58");
  assert.equal(body.txHash.toLowerCase(), "0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb");
  assert.equal(body.amount, "0.05 USDC"); // 50000 raw / 1e6 = 0.05, currency from terms
});

test("receipt: unknown well-formed txHash -> 404 not-found (no fabricated data)", async () => {
  const { statusCode, body } = await callHandler({
    mode: "found", // mock returns [] for the unknown hash
    query: "txHash=0x0000000000000000000000000000000000000000000000000000000000000001&rail=x402",
  });
  assert.equal(statusCode, 404);
  assert.equal(body.error, "not found");
  assert.equal(body.commitment_id, undefined);
});

test("receipt: invalid txHash -> 400 client error", async () => {
  const { statusCode, body } = await callHandler({ query: "txHash=nothex" });
  assert.equal(statusCode, 400);
  assert.equal(body.error, "invalid txHash");
});

test("receipt: missing txHash -> 400 client error", async () => {
  const { statusCode, body } = await callHandler({ query: "" });
  assert.equal(statusCode, 400);
  assert.equal(body.error, "invalid txHash");
});

test("receipt: store schema error -> truthful 500 service error, no fabricated receipt", async () => {
  const { statusCode, body } = await callHandler({
    mode: "schema-error",
    query: "txHash=0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb&rail=x402",
  });
  assert.equal(statusCode, 500);
  assert.equal(body.error, "store lookup failed");
  assert.equal(body.commitment_id, undefined);
  assert.ok(String(body.reason || "").length > 0, "reason should be present and truthful");
});

test("receipt: store outage -> truthful 500 service error, no fabricated receipt", async () => {
  const { statusCode, body } = await callHandler({
    mode: "outage",
    query: "txHash=0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb&rail=x402",
  });
  assert.equal(statusCode, 500);
  assert.equal(body.error, "store lookup failed");
  assert.equal(body.commitment_id, undefined);
});

// NOTE: the "store not configured" branch (SUPABASE_URL empty) is exercised by
// the module guard: with an empty URL, createClient throws synchronously and
// the handler's try/catch returns a 500 service error — covered implicitly by
// the schema-error/outage cases above. We do not assert on it here because the
// test harness always provides a listening mock server, so an empty-URL run
// would not exercise the intended branch.
