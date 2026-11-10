// Cleanup: remove the leftover OLD banner lines (CRLF-safe).
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'endpoint', 'route-server.js');
let raw = fs.readFileSync(p, 'utf8');
const hadCRLF = raw.includes('\r\n');
const c = raw.replace(/\r\n/g, '\n');

const leftover = [
  "  console.log(`POST http://localhost:${PORT}/route`);",
  "  console.log(`fee: ${ROUTING_FEE_USD} USDC | payTo: ${MOCK_PAYTO} | floor: ${SAAX_CAPABILITY_FLOOR}`);",
  "  console.log(`SAAX_PRICE_SCORE_DEFAULT=${SAAX_PRICE_SCORE_DEFAULT} | SAAX_FRESHNESS_STRATEGY=${SAAX_FRESHNESS_STRATEGY}`);",
  "  console.log(`DAY 8 GATES: killSwitch=${killswitch.isKillSwitchOn()} | store=${STORE_ACTIVE ? 'supabase' : 'in-memory'} | rateLimitStore=${RATE_LIMIT_STORE}`);",
].join('\n');

const count = c.split(leftover).length - 1;
if (count < 1) {
  console.error('LEFTOVER_NOT_FOUND count=' + count);
  process.exit(1);
}
let out = c.split(leftover).join('');
if (hadCRLF) out = out.replace(/\n/g, '\r\n');
fs.writeFileSync(p, out);

const lines = out.replace(/\r\n/g, '\n').split('\n');
for (let i = 1868; i < Math.min(1888, lines.length); i++) {
  console.log('[' + i + '] ' + lines[i]);
}
console.log('CLEANUP_OK removed ' + count + ' leftover banner block(s)');