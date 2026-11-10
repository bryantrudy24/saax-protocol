// SAAX MCP financial-boundary verification: session loss must NOT duplicate
// durable financial state.
//
// The MCP tools (create_commitment, prepare_commitment, accept_commitment) do
// NOT execute payments (payment is POST /route). Their durable side effect is
// persistence: a deterministic commitment ID + upsert RPC (create_commitment),
// a durable proposal (prepare_commitment), a single-writer acceptance
// (accept_commitment). This test proves that when a client loses its MCP
// session (404 cross-instance / after restart) and retries with the SAME
// durable identity, the shared store dedupes — no duplicate row, no invented
// settlement state.
//
// Uses the REAL upsert_commitment RPC on the ISOLATED local Docker testbed
// (ax_router_postgrest :3000, ax_router_db :5433) via the same wire shape the
// application uses (direct PostgREST with schema profile headers; the
// supabase-js RPC path does not set Accept-Profile/Content-Profile on this
// testbed, which is exactly why endpoint/store.js implements its own client).
// NO mainnet/testnet, NO real money, NO payments.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const POSTGREST_URL = process.env.POSTGREST_URL || "http://127.0.0.1:3000";
const { mint } = require(path.join(__dirname, "reliability", "_gate-d-jwt.cjs"));
const JWT = process.env.SAAX_POSTGREST_KEY || mint("service_role");

const PROFILE = { "Accept-Profile": "ax_router", "Content-Profile": "ax_router", "Content-Type": "application/json", Authorization: "Bearer " + JWT };

async function rpc(fn, body) {
  const res = await fetch(POSTGREST_URL + "/rpc/" + fn, { method: "POST", headers: PROFILE, body: JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error("RPC " + fn + " -> " + res.status + " " + text.slice(0, 300));
  return data;
}

async function upsert(cid, state, ref = null, over = {}) {
  return rpc("upsert_commitment", {
    p_commitment_id: cid,
    p_state: state,
    p_capability: "cross-instance session-loss fixture",
    p_buyer_email: null,
    p_terms: { deliverable: "fixture", price: { amount: "0.00", currency: "USDC" }, deadline: "2026-12-31T00:00:00Z" },
    p_authority_ref: null,
    p_evidence_refs: [],
    p_settlement_ref: ref,
    p_manifest_hash: "sha256:" + cid,
    ...over,
  });
}

async function countRows(cid) {
  const res = await fetch(POSTGREST_URL + "/commitments?commitment_id=eq." + encodeURIComponent(cid) + "&select=commitment_id,state,settlement_ref", { headers: PROFILE });
  const rows = await res.json();
  if (!res.ok) throw new Error("select -> " + res.status + " " + JSON.stringify(rows).slice(0, 200));
  return rows;
}

async function delRow(cid) {
  const res = await fetch(POSTGREST_URL + "/commitments?commitment_id=eq." + encodeURIComponent(cid), { method: "DELETE", headers: PROFILE });
  if (!res.ok && res.status !== 404) console.log("  (cleanup warn: " + res.status + ")");
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("FAIL " + name + (extra ? " | " + extra : "")); }
}

const commitmentId = "saax_xinst_" + Date.now().toString(16) + "_" + Math.random().toString(16).slice(2, 8);
const otherId = commitmentId + "_other";

console.log("=== MCP financial-boundary: session loss around durable persistence (testbed :3000) ===");
console.log("fixture commitmentId=" + commitmentId);

try {
  await delRow(commitmentId);
  await delRow(otherId);

  // F1: initial persistence (the "authorized operation executes").
  await upsert(commitmentId, "issued");
  let rows = await countRows(commitmentId);
  check("F1 first persistence creates exactly 1 row", rows.length === 1 && rows[0].state === "issued", "rows=" + rows.length);

  // F2: response lost; client retries with SAME durable identity (new MCP
  // session, same commitment id — the session ID is NOT part of the identity).
  await upsert(commitmentId, "issued");
  rows = await countRows(commitmentId);
  check("F2 retry with same identity -> still 1 row (no duplicate)", rows.length === 1, "rows=" + rows.length);

  // F3: retry through another process (same shared store): spawn a child that
  // does the same upsert — the store dedupes across processes by PK.
  const childCode = `
    const { mint } = require(${JSON.stringify(path.join(__dirname, "reliability", "_gate-d-jwt.cjs"))});
    const jwt = mint('service_role');
    const PROFILE = { "Accept-Profile": "ax_router", "Content-Profile": "ax_router", "Content-Type": "application/json", Authorization: "Bearer " + jwt };
    const body = ${JSON.stringify({ p_commitment_id: commitmentId, p_state: "issued", p_capability: "cross-instance session-loss fixture", p_buyer_email: null, p_terms: {}, p_authority_ref: null, p_evidence_refs: [], p_settlement_ref: null, p_manifest_hash: "sha256:" + commitmentId })};
    fetch(${JSON.stringify(POSTGREST_URL)} + "/rpc/upsert_commitment", { method: "POST", headers: PROFILE, body: JSON.stringify(body) })
      .then(async r => { process.stdout.write("" + r.status); process.exit(0); })
      .catch(e => { process.stderr.write(e.message); process.exit(1); });
  `;
  const child = spawn(process.execPath, ["-e", childCode], { stdio: ["ignore", "pipe", "pipe"] });
  const childOut = await new Promise((ok) => {
    let out = "", err = "";
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => err += d);
    child.on("close", (code) => ok({ code, out, err }));
  });
  rows = await countRows(commitmentId);
  check("F3 cross-process retry (child status " + (childOut.out || childOut.code) + ") -> still 1 row", rows.length === 1, "rows=" + rows.length + " child=" + (childOut.out || childOut.code));

  // F4: NO invented settlement state — upsert with issued cannot fabricate a
  // settlement_ref (we never write one; the RPC only sets what is passed).
  rows = await countRows(commitmentId);
  check("F4 no settlement_ref invented", !rows[0].settlement_ref, "ref=" + String(rows[0].settlement_ref));

  // F5: distinct commitment ID (different operation) is NOT deduped — proves
  // dedupe is keyed on the durable identity, not blanket.
  await upsert(otherId, "issued");
  const otherRows = await countRows(otherId);
  check("F5 different identity -> independent row", otherRows.length === 1 && otherRows[0].commitment_id === otherId, "rows=" + otherRows.length);

  // F6: store reachable (deterministic resolution possible; a throw would have
  // been caught above and would NOT be reported as success).
  const probe = await rpc("lookup_commitment_by_id", { p_commitment_id: commitmentId });
  check("F6 store reachable + deterministic lookup", probe && probe.commitment_id === commitmentId, "found=" + (probe && probe.commitment_id));
} catch (e) {
  console.error("HARNESS ERROR: " + (e && e.stack || e));
  fail++;
} finally {
  await delRow(commitmentId);
  await delRow(otherId);
}

console.log("\n===== FINANCIAL-BOUNDARY SUMMARY =====");
console.log("passed=" + pass + " failed=" + fail);
process.exit(fail > 0 ? 1 : 0);
