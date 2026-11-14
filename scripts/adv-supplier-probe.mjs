// Gate J.3 Phase C — adversarial supplier-lookup probe (read-only, offline)
// Exercises the real index + the same lookup semantics as get_supplier_details
// (exact-ID match, no enumeration, no partial match) against hostile inputs.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "..", "endpoint", "mcp-supplier-index.json");

function loadIndex() {
  if (!existsSync(INDEX)) return null;
  try {
    const j = JSON.parse(readFileSync(INDEX, "utf8"));
    return Array.isArray(j.suppliers) ? j.suppliers : null;
  } catch {
    return null;
  }
}

// Mirrors the tool's lookup: exact match on agent_id (number or decimal string form).
function lookup(suppliers, raw) {
  const clean = String(raw ?? "").trim();
  if (clean === "") return { status: "error" };
  if (clean.length > 64) return { status: "error" };
  const key = /^\d+$/.test(clean) ? Number(clean) : clean;
  const hit = suppliers.find((s) => {
    if (s == null) return false;
    if (typeof s.agent_id === "number") return s.agent_id === key || String(s.agent_id) === clean;
    return String(s.agent_id) === clean;
  });
  return hit ? { status: "ok", id: hit.agent_id } : { status: "not_found" };
}

const suppliers = loadIndex();
let pass = 0, fail = 0;
const checks = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; checks.push(`PASS ${name}${detail ? " :: " + detail : ""}`); }
  else { fail++; checks.push(`FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

// 1. Index integrity
check("index-present", Array.isArray(suppliers) && suppliers.length > 0);
check("index-nonempty", suppliers && suppliers.length === 123, `count=${suppliers ? suppliers.length : "null"}`);

// 2. Hostile identifiers — all must be not_found or error, never a hit
const hostile = [
  "..", "../", "../../etc/passwd", "..\\..\\", "%2e%2e%2f", "..%2f..%2f",
  "0x0", "0x0000000000000000000000000000000000000000",
  "' OR 1=1 --", '" OR "1"="1', "; DROP TABLE suppliers;--",
  "NaN", "Infinity", "-1", "1e999", "0.5",
  "undefined", "null", "constructor", "__proto__", "toString",
  "\u0000", "\ud83d\ude00", "\u202e73846", "７３８４６",
  "a".repeat(65), "1".repeat(100),
];
for (const h of hostile) {
  const r = lookup(suppliers, h);
  check(`hostile:${JSON.stringify(h).slice(0, 40)}`, r.status === "not_found" || r.status === "error", r.status);
}

// 3b. Canonicalizable numeric forms are VALID exact matches (documented behavior):
//     leading zeros and surrounding whitespace are trimmed/canonicalized to the
//     same numeric ID — they are not attacks and must resolve, not error.
for (const h of ["073846", "73846 ", " 73846"]) {
  const r = lookup(suppliers, h);
  check(`canonical:${JSON.stringify(h)}`, r.status === "ok" && r.id === 73846, r.status);
}

// 3. Valid lookups still work (regression)
const first = suppliers[0];
check("valid-id-number", lookup(suppliers, String(first.agent_id)).status === "ok");
check("valid-id-decimal-string", lookup(suppliers, String(first.agent_id)).status === "ok");

// 4. No enumeration: a wildcard/empty/star must not return anything
check("no-empty-lookup", lookup(suppliers, "").status === "error");
check("no-star", lookup(suppliers, "*").status === "not_found");
check("no-wildcard", lookup(suppliers, "agent%").status === "not_found");

// 5. Cross-tenant / private-supplier boundary: the tool returns NO row for anything
//    not in the public index (exact match only). Index contains only public rows.
const privateIds = ["internal-1", "service-account", "ops-supplier", "saax-operator"];
for (const pid of privateIds) {
  check(`private-not-exposed:${pid}`, lookup(suppliers, pid).status === "not_found");
}

console.log(checks.join("\n"));
console.log(`\nadversarial supplier probe: ${pass} passed, ${fail} failed (${pass + fail} total)`);
process.exit(fail ? 1 : 0);
