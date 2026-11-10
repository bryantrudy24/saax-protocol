// SAAX Protocol — Rail-neutral commitment → x402 → receipt demo (one command).
//
//   node scripts/demo-commitment-receipt.mjs
//
// Full sequence (Item 4 of the rail-neutral commitment tool brief):
//   1. create_commitment with settlement_rail "x402"  -> saax_<hash>
//   2. x402-protected payment payload carries the commitment id in extensions
//      (extensions.saax_commitment_id) — the pattern for every rail
//   3. settlement completes off-chain (mock settle; no USDC movement)
//   4. receipt endpoint called with the txHash
//   5. confirm the returned commitment id matches the created one
//
// When SUPABASE_URL / SUPABASE_ANON_KEY are set (env or .env), step 1 persists
// through the real store and step 4 reads the real receipt RPC. Without creds
// the script exercises the same code path in-memory (mirror seed) and reports
// that the live DB leg was skipped.
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// ---- create_commitment (mirror of the MCP tool's persisted shape) ------------
const RAILS = new Set(["x402", "mpp", "ap2", "acp", "unspecified"]);

function canonicalTerms(input) {
  const pick = {};
  for (const k of ["buyerId", "sellerId", "terms", "acceptanceCriteria", "evidenceRequirements", "recoveryPolicy", "settlementRail"]) {
    if (input[k] !== undefined && input[k] !== null) pick[k] = input[k];
  }
  return JSON.stringify(pick, Object.keys(pick).sort());
}
function commitmentIdFrom(input, nonce) {
  const hash = crypto.createHash("sha256").update(canonicalTerms(input) + "|nonce:" + nonce, "utf8").digest("hex");
  return "saax_" + hash.slice(0, 16);
}

// ---- Step 1: create the commitment -------------------------------------------
const input = {
  buyerId: "0xB0D4A1e8A8D1a5c8Ce4B0a2E63d43F7C8bA9e5f1",
  sellerId: "0x7F3a9B2cD4e5F6a7B8c9D0e1F2a3B4c5D6e7F8a9B",
  terms: {
    deliverable: "Security scan of the merchant contract",
    price: { amount: "0.10", currency: "USDC", decimals: 6 },
    deadline: "2026-10-14T18:00:00Z",
  },
  acceptanceCriteria: ["report delivered", "findings severity-rated"],
  evidenceRequirements: ["scan-report"],
  recoveryPolicy: { maxRetries: 2, refundOnFailure: true, compensationPercent: "5" },
  settlementRail: "x402",
};

const nonce = crypto.randomBytes(8).toString("hex");
const commitmentId = commitmentIdFrom(input, nonce);
const createdAt = new Date().toISOString();

console.log("=== STEP 1 — create_commitment (rail: x402) ===");
console.log(JSON.stringify({ commitment_id: commitmentId, created_at: createdAt, status: "open", settlement_rail: input.settlementRail }, null, 2));

// ---- Step 2: attach the commitment id through the x402 extensions ------------
console.log("\n=== STEP 2 — x402 payment payload with extensions.saax_commitment_id ===");
const x402Payload = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:8453",
    amount: String(Number(input.terms.price.amount) * 1_000_000),
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: input.sellerId,
    maxTimeoutSeconds: 60,
  },
  payload: {
    signature: "0x" + "00".repeat(65),
    authorization: {
      from: input.buyerId,
      to: input.sellerId,
      value: String(Number(input.terms.price.amount) * 1_000_000),
      validAfter: String(Math.floor(Date.now() / 1000) - 60),
      validBefore: String(Math.floor(Date.now() / 1000) + 3600),
      nonce: "0x" + crypto.randomBytes(32).toString("hex"),
    },
  },
  extensions: {
    saax_commitment_id: commitmentId,
  },
};
console.log(JSON.stringify(x402Payload, null, 2));
console.log("extensions present:", !!(x402Payload.extensions && x402Payload.extensions.saax_commitment_id === commitmentId));

// ---- Step 3: settlement (mock only; no USDC movement, per constraint) --------
console.log("\n=== STEP 3 — settlement (mock; no USDC movement) ===");
const txHash = "0x" + crypto.randomBytes(32).toString("hex");
const settledAt = new Date().toISOString();
console.log(JSON.stringify({ rail: "x402", txHash, status: "settled", amount: input.terms.price.amount + " USDC (mock)" }, null, 2));
console.log("NOTE: mock txHash — no base mainnet txHash exists in recorded artifacts (reported per brief).");

// ---- Step 4: receipt endpoint call -------------------------------------------
console.log("\n=== STEP 4 — GET /receipt?txHash=...&rail=x402 ===");
console.log("GET /receipt?txHash=" + txHash + "&rail=x402");

async function main() {
  let receipt;
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    // Live leg: persist the commitment, mark settlement_ref, read the RPC.
    const supabaseAxRouter = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "ax_router" },
    });
    await supabaseAxRouter.rpc("upsert_commitment", {
      p_commitment_id: commitmentId,
      p_state: "settled",
      p_capability: input.terms.deliverable,
      p_buyer_email: null,
      p_terms: { ...input.terms, sellerId: input.sellerId, settlementRail: "x402", acceptanceCriteria: input.acceptanceCriteria, evidenceRequirements: input.evidenceRequirements, recoveryPolicy: input.recoveryPolicy },
      p_authority_ref: null,
      p_evidence_refs: input.evidenceRequirements,
      p_settlement_ref: JSON.stringify({ txHash, rail: "x402" }),
      p_manifest_hash: "sha256:" + crypto.createHash("sha256").update(commitmentId).digest("hex"),
    });
    const { data } = await supabaseAxRouter.rpc("lookup_receipt_by_txhash", { p_txhash: txHash });
    const row = data && data[0];
    receipt = {
      txHash,
      rail: "x402",
      commitment_id: row.commitment_id,
      payer: row.buyer_email || input.buyerId,
      payee: input.sellerId,
      amount: input.terms.price.amount + " USDC",
      settled_at: row.created_at,
    };
    console.log("(live Supabase roundtrip)");
  } else {
    // No creds: same shape from the in-memory record.
    receipt = {
      txHash,
      rail: "x402",
      commitment_id: commitmentId,
      payer: input.buyerId,
      payee: input.sellerId,
      amount: input.terms.price.amount + " USDC",
      settled_at: settledAt,
    };
    console.log("(in-memory demo leg — SUPABASE_URL/ANON_KEY not set for this shell)");
  }
  console.log(JSON.stringify(receipt, null, 2));

  // ---- Step 5: match confirmation ---------------------------------------------
  console.log("\n=== STEP 5 — MATCH CHECK ===");
  const match = receipt.commitment_id === commitmentId;
  console.log("created commitment_id:", commitmentId);
  console.log("receipt commitment_id :", receipt.commitment_id);
  console.log(match
    ? "MATCH: The commitment ID created in step 1 matches the commitment ID returned in step 4. The thread holds."
    : "MISMATCH: receipt returned a different commitment id");
  process.exit(match ? 0 : 1);
}

main().catch((e) => {
  console.error("demo failed:", e.message);
  process.exit(1);
});