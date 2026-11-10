// Bounded patch: replace the static Day-8 MOCK MODE banner with effective-runtime-state reporting.
// The banner's em-dash is mojibake'd in the file (C3 A2 E2 82 AC E2 80 9D), so match on the ASCII prefix.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'endpoint', 'route-server.js');
let c = fs.readFileSync(p, 'utf8');

// Match the whole banner line by its stable ASCII prefix, whatever the dash bytes are.
const lineRe = /console\.log\(`SAAX Protocol [\s\S]*?Day 8 demand intake endpoint \(MOCK MODE, verify=\$\{x402\.VERIFY_MODE\}\)`\);/;
if (!lineRe.test(c)) {
  console.error('PATCH_ANCHOR_NOT_FOUND');
  process.exit(1);
}

const neu = [
  "  const effectiveMode = SELF_MODE ? 'self' : x402.VERIFY_MODE;",
  "  console.log(`SAAX Protocol route endpoint (mode=${effectiveMode}, verify=${SELF_MODE ? 'self' : x402.VERIFY_MODE}, escrowBacked=${ESCROW_BACKED ? '1' : '0'}, chain=${String(process.env.SAAX_CHAIN_ID || 'not-set')})`);",
  "  console.log(`POST http://${HOST}:${PORT}/route (bound ${HOST}, localhost-only when HOST=127.0.0.1)`);",
  "  console.log(`fee: ${ROUTING_FEE_USD} USDC | payTo: ${SELF_MODE ? (gateway.getOperativePayee() || MOCK_PAYTO) : MOCK_PAYTO} | floor: ${SAAX_CAPABILITY_FLOOR}`);",
  "  console.log(`SAAX_PRICE_SCORE_DEFAULT=${SAAX_PRICE_SCORE_DEFAULT} | SAAX_FRESHNESS_STRATEGY=${SAAX_FRESHNESS_STRATEGY}`);",
  "  console.log(`GATES: killSwitch=${killswitch.isKillSwitchOn()} | store=${STORE_ACTIVE ? 'supabase' : 'in-memory'} | rateLimitStore=${RATE_LIMIT_STORE}`);",
].join('\n');

c = c.replace(lineRe, neu);
fs.writeFileSync(p, c);
console.log('PATCH_OK banner now reports effective runtime state');