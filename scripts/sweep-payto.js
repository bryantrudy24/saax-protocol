// Day 6 pre-item 2: payTo placeholder sweep — precise version.
// Scans scripts/*.js and endpoint/*.js|json for 0x strings and classifies:
//  - Address literals (quoted, 42-char) -> checked against Day 5 validatePayTo.
//  - Computed hex (fromBlock/toBlock/nonce/signature topics, mock keys) -> by construction.
//  - Registry/mint/test-fixture addresses -> known-good, excluded (not payTo).
const fs = require('fs');
const path = require('path');
const x402 = require('../endpoint/x402.js');

const KNOWN_MARKERS = new Set([
  '0x8004baa17c55a88189ae136b182e5fda19de9b63',
  '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000000',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  '0x0c05c3cf1386c3a9624b41b9260f4af7ca583b9a',
  '0xea8a3a831c1c0a96c4c26698dfed6397d1885cc4',
  '0x87ef068dee858b0fb6894aa6978174c54b3a05d4',
  '0x820c5091b047b652888f6aa7e1ee615d99f7c8cd',
  '0xf9d1d63f362bbf1ee08ab9acb36fe74afc48d5f1',
  '0x715dc035ffb97dd7bb4095c6670138ba05bb4e6d',
]);

// Find quoted hex literals (single or double quotes) of exactly 42 chars,
// plus bare 0x..40 tokens in JSON.
function quotedTokens(src) {
  const out = [];
  const re = /['"](0x[0-9a-fA-F]{40})['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  // JSON bare tokens (data files): "0x...40" already captured by same regex
  return out;
}

let totalQuoted = 0, known = 0, computed = 0, checked = 0, validCount = 0, invalidCount = 0;
const invalidRows = [];
const validRows = [];

function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const toks = quotedTokens(src);
  for (const tok of toks) {
    totalQuoted++;
    const lower = tok.toLowerCase();
    if (KNOWN_MARKERS.has(lower)) { known++; continue; }
    // computed-hex: context/expression built from arithmetic — check if preceded by '0x' arithmetic
    // Simpler: any 42-hex quoted literal NOT in known markers is a candidate payTo.
    checked++;
    const res = x402.validatePayTo(tok, 'base');
    if (res.ok) { validCount++; validRows.push({ tok, file }); }
    else { invalidCount++; invalidRows.push({ tok, file, reason: res.reason }); }
  }
}

const dirs = ['../scripts', '../endpoint'];
for (const d of dirs) {
  const abs = path.resolve(__dirname, d);
  for (const f of fs.readdirSync(abs)) {
    if (path.extname(f) === '.js' || path.extname(f) === '.json') scanFile(path.join(abs, f));
  }
}

console.log('SWEEP SUMMARY:');
console.log('  quoted 0x-address literals found   : ' + totalQuoted);
console.log('  known-good (registry/mint/fixture) : ' + known);
console.log('  candidates checked vs payTo gate   : ' + checked);
console.log('  VALID   : ' + validCount);
console.log('  INVALID : ' + invalidCount);
for (const r of validRows) console.log('  valid   ' + r.tok + '  ' + r.file);
for (const r of invalidRows) console.log('  INVALID ' + r.tok + '  ' + r.file + '  -> ' + r.reason);
process.exit(invalidCount > 0 ? 1 : 0);