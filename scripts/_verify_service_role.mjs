// TEMP verification script — Item 3 (Check A + B) on the service-role key.
// Loads .env, exercises the REAL commitment store + the REAL /receipt handler.
import "dotenv/config";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://codboejrwohkjidrrcgl.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!KEY) {
  console.error("FATAL: SUPABASE_SERVICE_ROLE_KEY missing from .env");
  process.exit(2);
}

const ax = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "ax_router" },
});

// ---- CHECK A: create_commitment persists to the real store -------------------
console.log("=== CHECK A — create_commitment (live store, service-role key) ===");
const id = "saax_" + crypto.randomBytes(8).toString("hex");
const terms = {
  deliverable: "Service-role verification probe",
  price: { amount: "0.01", currency: "USDC", decimals: 6 },
  deadline: "2026-10-20T00:00:00Z",
  acceptanceCriteria: ["probe row persisted"],
  evidenceRequirements: [],
  recoveryPolicy: { maxRetries: 0, refundOnFailure: false },
  settlementRail: "unspecified",
};
const record = {
  commitmentId: id,
  state: "issued",
  capability: terms.deliverable,
  buyerEmail: null,
  terms: { ...terms, sellerId: "0xVerify" },
  authorityRef: null,
  evidenceRefs: [],
  settlementRef: null,
  manifestHash: "sha256:" + crypto.createHash("sha256").update(id).digest("hex"),
};
const { data: upsertData, error: upsertError } = await ax.rpc("upsert_commitment", {
  p_commitment_id: record.commitmentId,
  p_state: record.state,
  p_capability: record.capability,
  p_buyer_email: record.buyerEmail,
  p_terms: record.terms,
  p_authority_ref: record.authorityRef,
  p_evidence_refs: record.evidenceRefs,
  p_settlement_ref: record.settlementRef,
  p_manifest_hash: record.manifestHash,
});
if (upsertError) {
  console.error("CHECK A FAILED — upsert_commitment error:", JSON.stringify(upsertError));
  process.exit(1);
}
console.log("upsert_commitment RPC result:", JSON.stringify(upsertData));

const { data: readBack, error: readError } = await ax.rpc("lookup_commitment_by_id", { p_commitment_id: id });
if (readError) {
  console.error("CHECK A FAILED — read-back error:", JSON.stringify(readError));
  process.exit(1);
}
console.log("read-back row:", JSON.stringify(readBack));
if (!readBack || !readBack.length) {
  console.error("CHECK A FAILED — row did not persist");
  process.exit(1);
}
console.log("CHECK A PASS — persisted commitment_id:", id, "state:", readBack[0].state);

// ---- CHECK B: /receipt handler resolves a KNOWN txHash ------------------------
// The handler reads process.env directly — set it explicitly before importing.
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
console.log("\n=== CHECK B — GET /receipt?txHash=...&rail=x402 (real handler) ===");
const knownTxHash = "0xd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2"; // saax_tool_x402_demo
const { default: receiptHandler } = await import("../api/receipt.mjs");
const res = { statusCode: 0, setHeader() {}, end(b) { this.body = b; } };
const req = { method: "GET", url: "/receipt?txHash=" + knownTxHash + "&rail=x402", headers: {} };
await receiptHandler(req, res);
console.log("RAW STATUS:", res.statusCode);
console.log("RAW BODY:", res.body || res._body || "(none)");