const store = require("../endpoint/commitment-store.js");
const { createClient } = require("@supabase/supabase-js");
(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "ax_router" } });
  const { data: row, error: rowErr } = await supabase.rpc("lookup_commitment_by_id", { p_commitment_id: "saax_d67e14db6485e322" });
  if (rowErr) { console.error("row read FAIL", rowErr.message); process.exit(1); }
  const r = Array.isArray(row) ? row[0] : row;
  console.log("row before:", JSON.stringify({ commitment_id: r.commitment_id, state: r.state, cap: r.capability, ref: r.settlement_ref }));
  const result = await store.persistSettlementRef({
    commitmentId: r.commitment_id, state: r.state, capability: r.capability,
    buyerEmail: r.buyer_email, terms: r.terms, authorityRef: r.authority_ref,
    evidenceRefs: r.evidence_refs, manifestHash: r.manifest_hash,
    settlementRef: { txHash: "0x115187c46e199a99f63f0d2cb2f662f1c401bf027ec34eed5b8e22b88b8061a0", rail: "x402" },
  });
  console.log("persistSettlementRef result:", JSON.stringify(result));
  const { data: after } = await supabase.rpc("lookup_commitment_by_id", { p_commitment_id: "saax_d67e14db6485e322" });
  const a = Array.isArray(after) ? after[0] : after;
  console.log("row after:", JSON.stringify({ commitment_id: a.commitment_id, ref: a.settlement_ref }));
  const { data: receipt } = await supabase.rpc("lookup_receipt_by_txhash", { p_txhash: "0x115187c46e199a99f63f0d2cb2f662f1c401bf027ec34eed5b8e22b88b8061a0" });
  console.log("receipt lookup:", JSON.stringify(Array.isArray(receipt) ? receipt[0] : receipt));
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
