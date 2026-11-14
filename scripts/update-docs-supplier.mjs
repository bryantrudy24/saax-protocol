// Gate J.3 Phase E: update landing/docs.html with supplier discovery section + 26-tool count
import { readFileSync, writeFileSync } from "node:fs";

const p = "landing/docs.html";
let c = readFileSync(p, "utf8");
const EOL = c.includes("\r\n") ? "\r\n" : "\n";

const anchor = "<li><code>raise_dispute</code>, <code>resolve_dispute</code>, <code>list_disputes</code></li>" + EOL + "</ul>";
const insert =
  "<li><code>raise_dispute</code>, <code>resolve_dispute</code>, <code>list_disputes</code></li>" + EOL + "</ul>" +
  EOL + "<h3>Supplier discovery</h3>" + EOL + "<ul>" + EOL +
  "<li><code>get_supplier_details</code> — read-only detailed lookup of a single registered supplier (identifier, name, description, services with endpoints, owner, source provenance). Call after <code>route_request</code>/<code>list_capabilities</code> to inspect a specific supplier before preparing a commitment. Exact <code>supplier_id</code> match only (no enumeration); a registry entry is not a guarantee of service quality or verification — <code>verification_status</code> is reported as <code>unverified</code> unless an authoritative verification source exists.</li>" + EOL + "</ul>";

let changed = 0;
if (c.includes(anchor)) {
  c = c.replace(anchor, insert);
  changed++;
} else {
  console.log("ANCHOR-NOT-FOUND");
  process.exit(1);
}
if (c.includes("All 25 tools are available")) {
  c = c.replace("All 25 tools are available", "All 26 tools are available");
  changed++;
}
writeFileSync(p, c, "utf8");
console.log("OK changed=" + changed);
