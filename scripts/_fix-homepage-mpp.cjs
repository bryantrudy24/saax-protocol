#!/usr/bin/env node
// Fix x402/MPP overstatements on the homepage (production is x402-only).
const fs = require('fs');
const p = 'landing/index.html';
let s = fs.readFileSync(p, 'utf8');
const subs = [
  ['Mainnet is limited to existing immediate x402/MPP payments. No mainnet custody or completed independent audit.',
   'Mainnet is limited to existing immediate x402 payments. No mainnet custody or completed independent audit.'],
  ['Existing immediate payments settle USDC on Base mainnet via x402/MPP.',
   'Existing immediate payments settle USDC on Base mainnet via x402.'],
  ['<li>USDC on Base mainnet (immediate x402/MPP payments)</li>',
   '<li>USDC on Base mainnet (immediate x402 payments)</li>'],
  ['x402 / MPP via USDC on Base mainnet; operated by SAAX team',
   'x402 via USDC on Base mainnet; operated by SAAX team'],
  ['<li><strong>Immediate payments</strong> via the SAAX Router — x402 and MPP, USDC on Base. Operated by the SAAX team.</li>',
   '<li><strong>Immediate payments</strong> via the SAAX Router — x402, USDC on Base. Operated by the SAAX team.</li>'],
];
let n = 0;
for (const [o, nw] of subs) {
  if (s.includes(o)) { s = s.split(o).join(nw); n++; }
  else console.log('MISS:', o.slice(0, 60));
}
fs.writeFileSync(p, s);
console.log('replaced', n, 'of', subs.length);
