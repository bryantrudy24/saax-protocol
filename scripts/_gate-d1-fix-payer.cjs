// Gate D.1 — resolve the pilot payer identity correctly.
//
// The first wiring read the payer ONLY from the signed authorization, which is
// absent in the mock lane (no signature exists there). That made the gate fail
// closed on every mock request — correct in spirit, but it also made the gate
// untestable and would have rejected the development lane outright.
//
// Correct rule:
//   * SELF/live lane  -> the payer MUST come from the verified signature. No
//     signature means no authenticated identity, so the gate fails closed.
//   * mock lane       -> there is no signature and no financial effect; the
//     mock buyer identity is the lane's own identity. Using it keeps the gate
//     exercisable without ever treating a caller string as authenticated in a
//     lane where money can move.
'use strict';
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'endpoint', 'route-server.js');
let src = fs.readFileSync(target, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';

if (src.includes('PILOT PAYER RESOLUTION')) {
  console.log('ALREADY PRESENT — no change');
  process.exit(0);
}

const oldLine = "    const verifiedPayer = authz.from ? String(authz.from).toLowerCase() : null;";
if (!src.includes(oldLine)) { console.error('ANCHOR NOT FOUND'); process.exit(1); }

const replacement = [
  '    // PILOT PAYER RESOLUTION: the payer is the SIGNATURE-derived address',
  '    // whenever a signature exists. Only the mock lane (no signature, no',
  '    // financial effect) falls back to its own mock buyer identity — a',
  '    // caller-supplied string is never treated as authenticated where money',
  '    // can move, and SELF mode with no signature fails closed.',
  '    const verifiedPayer = authz.from',
  '      ? String(authz.from).toLowerCase()',
  '      : (SELF_MODE ? null : (walletFromReq(req) || null));',
].join(EOL);

src = src.replace(oldLine, replacement);
fs.writeFileSync(target, src, 'utf8');
console.log('PATCHED — ' + src.length + ' bytes');
