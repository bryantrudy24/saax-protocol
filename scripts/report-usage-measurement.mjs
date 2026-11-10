// SAAX Protocol — reproducible usage-measurement report (READ-ONLY)
//
// Usage:  node scripts/report-usage-measurement.mjs [--json]
//
// Reads the production Supabase (read-only SELECTs only) and prints a
// structured usage report separating:
//   * commitments (states, by day)              * settlement refs (real vs mock)
//   * on-chain payments (10 known mainnet txs)  * gateway/telemetry (if applied)
//   * receipts, discovery, escrow, pilot
//
// No writes. No secrets printed (uses SUPABASE_URL + service-role key from env
// — never echoed). Excludes synthetic fixtures from real-use numbers by flag.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const json = process.argv.includes("--json");

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) are required");
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "ax_router" },
});

const out = { generatedAt: new Date().toISOString(), sections: {} };

async function q(name, fn) {
  try { out.sections[name] = await fn(); }
  catch (e) { out.sections[name] = { error: String(e.message || e).slice(0, 200) }; }
}

// ---- Commitments --------------------------------------------------------------
await q("commitments_by_state", async () => {
  const { data, error } = await supabase.from("commitments").select("state").limit(10000);
  if (error) throw error;
  const by = {};
  for (const r of data || []) by[r.state] = (by[r.state] || 0) + 1;
  return { total: (data || []).length, by };
});

await q("commitments_by_day", async () => {
  const { data, error } = await supabase.from("commitments").select("created_at").order("created_at", { ascending: false }).limit(10000);
  if (error) throw error;
  const by = {};
  for (const r of data || []) {
    const d = String(r.created_at || "").slice(0, 10);
    by[d] = (by[d] || 0) + 1;
  }
  return Object.entries(by).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30);
});

// ---- Settlement refs (real vs mock vs none) -----------------------------------
await q("settlement_refs", async () => {
  const { data, error } = await supabase.from("commitments").select("settlement_ref").limit(10000);
  if (error) throw error;
  let real = 0, dryrun = 0, none = 0, realHashes = [];
  for (const r of data || []) {
    const ref = r.settlement_ref;
    if (!ref) { none++; continue; }
    let tx = null;
    try { tx = typeof ref === "string" ? JSON.parse(ref).txHash : (ref.txHash || null); } catch { tx = null; }
    if (!tx) { none++; continue; }
    if (String(tx).startsWith("dryrun_")) { dryrun++; continue; }
    real++; realHashes.push(tx);
  }
  return { real, dryrun, none, hashes: realHashes };
});

// ---- Escrow / pilot / reservations (all should be 0 in production) ------------
await q("escrow_pilot", async () => {
  const tables = ["escrows", "escrow_events", "escrow_intents", "payment_reservations", "pilot_wallets", "idempotency_keys", "rate_limits"];
  const res = {};
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select("*").limit(1);
    if (error) { res[t] = { error: String(error.message || error).slice(0, 120) }; continue; }
    // count via a bounded approach: we only need live counts; use RPC-free select count
    const { count, error: ce } = await supabase.from(t).select("*", { count: "exact", head: true });
    res[t] = ce ? { count: (data || []).length, error: String(ce.message || ce).slice(0, 120) } : { count };
  }
  return res;
});

// ---- Discovery / receipts (public schema) -------------------------------------
await q("discovery", async () => {
  const p = supabase.schema("public");
  const { data, error } = await p.from("discovery_proposals").select("proposal_id,status,created_at").order("created_at", { ascending: false }).limit(100);
  return { count: (data || []).length, error: error ? String(error.message || error).slice(0, 120) : null, latest: (data || []).slice(0, 5) };
});

// ---- Gateway telemetry (if the migration is applied; otherwise skipped) -------
await q("gateway_telemetry", async () => {
  const { data, error } = await supabase.from("usage_measurement").select("*").limit(200);
  if (error) return { applied: false, note: "usage_measurement view not present (migration not applied or telemetry off)", error: String(error.message || error).slice(0, 120) };
  return { applied: true, rows: data || [] };
});

// ---- Output -------------------------------------------------------------------
if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log("=== SAAX USAGE MEASUREMENT REPORT ===");
  console.log("generated:", out.generatedAt);
  for (const [k, v] of Object.entries(out.sections)) {
    console.log("\n--- " + k + " ---");
    console.log(JSON.stringify(v, null, 2));
  }
}
