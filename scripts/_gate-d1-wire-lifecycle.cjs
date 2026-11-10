// Gate D.1 — wire the reservation lifecycle into the settlement boundaries.
// Idempotent: refuses to apply twice.
'use strict';
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'endpoint', 'route-server.js');
let src = fs.readFileSync(target, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const L = (lines) => lines.join(EOL);

if (src.includes('PILOT LIMITS: reservation confirmed')) {
  console.log('ALREADY PRESENT — no change');
  process.exit(0);
}

// ---- 1. Settlement failure -> RELEASE (authoritative: nothing was broadcast)
const failAnchor = L([
  "      log.push('DAY 9 SETTLEMENT FAILED: ' + selfSettlementError);",
  '      if (idemKeyNow && idem.fresh) {',
  "        await idempotency.markFailed(idemKeyNow, 502, JSON.stringify({ error: 'settlement failed' }));",
  '      }',
]);
if (!src.includes(failAnchor)) { console.error('ANCHOR 1 NOT FOUND'); process.exit(1); }

const failBlock = L([
  "      log.push('DAY 9 SETTLEMENT FAILED: ' + selfSettlementError);",
  '      // Gate D.1: a broadcast that provably failed is authoritative evidence',
  '      // that the operation cannot settle, so the reserved exposure is released.',
  '      // (A TIMEOUT is not this case — it leaves the reservation consuming',
  '      // budget until reconciliation establishes the real outcome.)',
  '      if (pilotReservation) {',
  "        try { await pilotLimits.release(pilotReservation, 'settlement broadcast failed'); } catch (_) {}",
  '      }',
  '      if (idemKeyNow && idem.fresh) {',
  "        await idempotency.markFailed(idemKeyNow, 502, JSON.stringify({ error: 'settlement failed' }));",
  '      }',
]);
src = src.replace(failAnchor, failBlock);

// ---- 2. Successful settlement -> CONFIRM (keeps consuming exposure)
const okAnchor = L([
  '  if (idemKeyNow && idem.fresh) {',
  '    await idempotency.markSettled(idemKeyNow, 200, respBody);',
  "    log.push('IDEMPOTENCY: key ' + idemKeyNow + ' marked settled (cached response)');",
  '  }',
  "  const respHeaders = { 'Content-Type': 'application/json' };",
]);
if (!src.includes(okAnchor)) { console.error('ANCHOR 2 NOT FOUND'); process.exit(1); }

const okBlock = L([
  '  if (idemKeyNow && idem.fresh) {',
  '    await idempotency.markSettled(idemKeyNow, 200, respBody);',
  "    log.push('IDEMPOTENCY: key ' + idemKeyNow + ' marked settled (cached response)');",
  '  }',
  '  // Gate D.1: settlement observed -> CONFIRMED. A confirmed reservation keeps',
  '  // consuming its window budget (real money moved); it is never released.',
  '  if (pilotReservation) {',
  '    const settleRef = (selfSettlement && selfSettlement.txHash) ||',
  '      (mppSettlement && (mppSettlement.txHash || mppSettlement.reference)) || null;',
  "    try { await pilotLimits.confirm(pilotReservation, settleRef); log.push('PILOT LIMITS: reservation confirmed ' + pilotReservation); } catch (_) {}",
  '  }',
  "  const respHeaders = { 'Content-Type': 'application/json' };",
]);
src = src.replace(okAnchor, okBlock);

fs.writeFileSync(target, src, 'utf8');
console.log('WIRED — ' + src.length + ' bytes');
