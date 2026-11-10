#!/usr/bin/env node
// Fix x402/MPP overstatements across docs.html and protocol.html.
const fs = require('fs');
for (const p of ['landing/docs.html', 'landing/protocol.html']) {
  let s = fs.readFileSync(p, 'utf8');
  let n = 0;
  const subs = [
    ['Immediate x402/MPP payment', 'Immediate x402 payment'],
    ['The existing live mainnet Router uses x402/MPP with Base USDC.',
     'The existing live mainnet Router uses x402 with Base USDC. The MPP rail implementation exists but is not registered in production (x402-only mode).'],
    ['Currently registered rails include x402 and MPP; future rails (entitlement, card, ACH, internal ledger) can be added by implementing the same interface.',
     'Currently registered rails include x402; the MPP rail is implemented but not registered in the production deployment (x402-only mode). Future rails (entitlement, card, ACH, internal ledger) can be added by implementing the same interface.'],
    ['The Router currently settles on Base mainnet via USDC through x402 or MPP.',
     'The Router currently settles on Base mainnet via USDC through x402.'],
  ];
  for (const [o, nw] of subs) {
    if (s.includes(o)) { s = s.split(o).join(nw); n++; }
    else console.log('MISS in', p, ':', o.slice(0, 50));
  }
  fs.writeFileSync(p, s);
  console.log(p, 'replaced', n);
}
