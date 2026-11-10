// SAAX Day 14 — local self-mode x402 demo on Base MAINNET (real broadcast).
// Drives the full chain locally: create_commitment -> signed EIP-3009
// transferWithAuthorization -> POST /route with extensions.saax_commitment_id
// -> real broadcast -> store settlement_ref -> GET /receipt resolves the ID.
//
// Usage (from repo root):
//   set SAAX_X402_MODE=self&& set SAAX_CHAIN_ID=8453&& set SAAX_X402_NETWORK=base&& node scripts/demo-x402-mainnet-local.mjs
//
// Reads .env for: SAAX_TEST_BUYER_KEY/ADDRESS, SAAX_SELLER_*, SAAX_SIGNER_*,
// SAAX_VAULT_ADDRESS, SAAX_RPC_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import "dotenv/config";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { signTypedData } from "viem/accounts";

// ---- resolve env ------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY;
const BUYER_KEY = process.env.SAAX_TEST_BUYER_KEY;
const BUYER_ADDR = (process.env.SAAX_TEST_BUYER_ADDRESS || "").toLowerCase();
const ASSET = process.env.SAAX_X402_ASSET;
const CHAIN_ID = Number(process.env.SAAX_CHAIN_ID || 8453);
const PORT = Number(process.env.SAAX_PORT || 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const RECEIPT_BASE = process.env.SAAX_RECEIPT_BASE || "https://saax-protocol.com";
const AMOUNT_RAW = "50000"; // 0.05 USDC (6 dp) — small settlement
const RAIL = "x402";

function fail(msg) { console.error("FATAL:", msg); process.exit(1); }
if (!SUPABASE_URL) fail("SUPABASE_URL not set (add to .env)");
if (!SERVICE_KEY) fail("SUPABASE_SERVICE_ROLE_KEY not set");
if (!BUYER_KEY) fail("SAAX_TEST_BUYER_KEY not set");
if (!ASSET) fail("SAAX_X402_ASSET not set");
if (CHAIN_ID !== 8453) fail("CHAIN_ID must be 8453 (Base mainnet) for this demo");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "ax_router" },
});

// ---- Step 1: create_commitment (mirror of the MCP tool, service role) -------
function commitmentIdFrom(input, nonce) {
  const canon = JSON.stringify(input, Object.keys(input).sort());
  return "saax_" + crypto.createHash("sha256").update(canon + "|nonce:" + nonce, "utf8").digest("hex").slice(0, 16);
}
const terms = {
  deliverable: "local x402 mainnet demo",
  price: { amount: "0.05", currency: "USDC" },
  deadline: new Date(Date.now() + 3600_000).toISOString(),
};
const input = {
  buyerId: BUYER_ADDR,
  sellerId: (process.env.SAAX_SELLER_ADDRESS || "").toLowerCase(),
  terms,
  acceptanceCriteria: ["transfer confirmed on Base mainnet"],
  evidenceRequirements: ["txHash"],
  recoveryPolicy: "buyer-cancel-before-delivery",
  settlementRail: RAIL,
};
const commitmentId = commitmentIdFrom(input, crypto.randomBytes(8).toString("hex"));
console.log("\n=== STEP 1 — create_commitment (rail: x402) ===");
console.log(JSON.stringify({ commitment_id: commitmentId, created_at: new Date().toISOString(), status: "open", settlement_rail: RAIL }, null, 2));
const { error: upsertErr } = await supabase.rpc("upsert_commitment", {
  p_commitment_id: commitmentId,
  p_state: "issued",
  p_capability: terms.deliverable,
  p_buyer_email: null,
  p_terms: input,
  p_authority_ref: null,
  p_evidence_refs: [],
  p_settlement_ref: null,
  p_manifest_hash: "sha256:" + crypto.createHash("sha256").update(commitmentId).digest("hex"),
});
if (upsertErr) fail("create_commitment upsert failed: " + JSON.stringify(upsertErr));

// ---- Step 2: sign EIP-3009 TransferWithAuthorization with the buyer key -----
const { default: gateway } = await import("../endpoint/gateway.js");
const domain = await gateway.domainFor(ASSET, CHAIN_ID);
console.log("\n=== STEP 2 — EIP-3009 signing ===");
console.log("domain:", JSON.stringify(domain));

const nonce = "0x" + crypto.randomBytes(32).toString("hex");
const validAfter = Math.floor(Date.now() / 1000) - 60;
const validBefore = Math.floor(Date.now() / 1000) + 3600;
const to = (process.env.SAAX_VAULT_ADDRESS || process.env.SAAX_SELLER_ADDRESS || "").toLowerCase(); // self-mode payee = vault (cold storage; falls back to seller)
const value = BigInt(AMOUNT_RAW);
const signature = await signTypedData({
  domain,
  types: { TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ] },
  primaryType: "TransferWithAuthorization",
  message: { from: BUYER_ADDR, to, value, validAfter, validBefore, nonce },
  privateKey: BUYER_KEY,
});
console.log("signature:", signature, "signer:", BUYER_ADDR);

// ---- Step 3: build the x402 payload with extensions.saax_commitment_id ------
const payload = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    amount: AMOUNT_RAW,
    asset: ASSET,
    network: "eip155:8453",
    payTo: to,
  },
  payload: {
    signature,
    authorization: {
      from: BUYER_ADDR,
      to,
      value: AMOUNT_RAW,
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce,
    },
  },
  extensions: { saax_commitment_id: commitmentId },
};
const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
console.log("\n=== STEP 3 — POST /route with PAYMENT-SIGNATURE ===");
console.log("extensions.saax_commitment_id:", commitmentId);

// ---- Step 4: POST to local server -------------------------------------------
const res = await fetch(BASE + "/route", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "payment-signature": encoded,
  },
  body: JSON.stringify({ capability: "security scan", budget: 500, deadline: new Date(Date.now() + 3600_000).toISOString() }),
});
const text = await res.text();
console.log("HTTP", res.status);
console.log("PAYMENT-RESPONSE:", res.headers.get("payment-response"));
console.log("body:", text.slice(0, 2000));

const txHash = (() => {
  const pr = res.headers.get("payment-response");
  if (!pr) return null;
  try { return JSON.parse(Buffer.from(pr, "base64").toString("utf8")).transactionHash; } catch { return null; }
})();
if (!txHash) fail("no real txHash in PAYMENT-RESPONSE — broadcast did not settle");
console.log("\nTXHASH_A (real Base mainnet):", txHash);

// ---- Step 5: verify store row has settlement_ref ----------------------------
console.log("\n=== STEP 5 — store row ===");
const { data: row, error: rowErr } = await supabase.rpc("lookup_commitment_by_id", { p_commitment_id: commitmentId });
if (rowErr) fail("lookup failed: " + JSON.stringify(rowErr));
console.log(JSON.stringify(row, null, 2));
// RPC is SETOF commitments -> returns an array; unwrap to the first object carrying settlement_ref,
// regardless of nesting depth (object, array, or nested arrays).
function findSettlementRef(node){
  if (!node || typeof node !== 'object') return null;
  if (node.settlement_ref) return node;
  if (Array.isArray(node)){
    for (const item of node){
      const hit = findSettlementRef(item);
      if (hit) return hit;
    }
  }
  return null;
}
const settledRow = findSettlementRef(row);
const ref = settledRow && settledRow.settlement_ref ? (typeof settledRow.settlement_ref === 'string' ? JSON.parse(settledRow.settlement_ref) : settledRow.settlement_ref) : null;
if (!ref || ref.txHash !== txHash || ref.rail !== "x402") {
  fail("settlement_ref missing or mismatched — linkage did NOT land");
}

// ---- Step 6: GET /receipt resolves the commitment ID ------------------------
console.log("\n=== STEP 6 — /receipt ===");
const rec = await fetch(`${RECEIPT_BASE}/receipt?txHash=${txHash}&rail=x402`);
const recBody = await rec.text();
console.log("HTTP", rec.status);
console.log("body:", recBody.slice(0, 1000));
if (rec.status !== 200) fail("receipt endpoint did not return 200");
const parsed = JSON.parse(recBody);
if (parsed.commitment_id !== commitmentId) {
  fail("receipt commitment_id mismatch: " + parsed.commitment_id + " != " + commitmentId);
}

console.log("\n=== RESULT ===");
console.log("MATCH: The commitment ID created via create_commitment matches the commitment ID returned by /receipt. The thread holds against a live Base mainnet transaction.");
console.log("COMMITMENT_ID_A=" + commitmentId);
console.log("TXHASH_A=" + txHash);
console.log("settlement_ref=" + JSON.stringify(ref));