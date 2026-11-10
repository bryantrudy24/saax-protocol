#!/usr/bin/env node
// Add verified capability rows to the status page maturity table (CRLF-safe).
const fs = require('fs');
const p = 'landing/status.html';
let s = fs.readFileSync(p, 'utf8');
const EOL = s.includes('\r\n') ? '\r\n' : '\n';
const anchor = '</tbody>' + EOL + '</table>' + EOL + '<h2 id="publicly-deployed-today">';
const rows = `<tr>
<td>Durable idempotency and reconciliation</td>
<td><strong>Beta (deployed)</strong></td>
<td>Durable payment idempotency (file-backed locally; Supabase/PostgreSQL in the production topology), reconcile-before-respond, and a Supabase reconciliation RPC for stale pending operations. Verified by reliability and fault-injection suites; production multi-instance financial concurrency not yet exercised.</td>
</tr>
<tr>
<td>Financial-limit infrastructure (pilot)</td>
<td><strong>Implemented / disabled</strong></td>
<td>Per-buyer and global transaction limits, wallet allowlist, and atomic reservation engine are deployed with <strong>enforcement OFF</strong>. Pilot allowlist is not populated; no limits are active. Activation requires separate owner authorization.</td>
</tr>`.split('\n').join(EOL);
if (s.includes(anchor) && !s.includes('Financial-limit infrastructure (pilot)')) {
  s = s.replace(anchor, rows + EOL + EOL + anchor);
  fs.writeFileSync(p, s);
  console.log('status rows added');
} else {
  console.log('MISS or already present');
}
