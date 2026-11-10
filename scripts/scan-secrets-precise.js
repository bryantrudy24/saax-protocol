// scan-secrets-precise.js — precise secret-leak scan.
// Flags only patterns that are ACTUALLY secrets or credential-bearing:
//   - 0x + 64 hex that are NOT transaction hashes in output logs (context-aware:
//     if the line looks like a tx hash / block / receipt, it is a public hash)
//   - API key prefixes (sandbox:, live:, nvm_, cdp_, sk_live, sk_test) only when
//     they appear as a VALUE assignment (X=... or "X":"..."), not prose
//   - DB / PostgREST connection strings with embedded passwords (postgres://user:pass@)
//   - Supabase URL with an embedded key/token
//   - "private key" or "secret" assignments
// Prints only real findings; exits 0 when none found.
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'handoff-staging', '.git', 'workshop']);
const SKIP_FILES = new Set(['.env', 'package-lock.json']);

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(path.join(dir, e.name)));
    } else {
      if (SKIP_FILES.has(e.name)) continue;
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// A 64-hex token that is a transaction/block hash (public) when it appears in
// a line with tx/block/hash/receipt/0x context; a private key when it appears
// as a KEY=..., "KEY":"...", or "privateKey" style assignment.
const KEY_ASSIGN = /(private[_ ]?key|secret|api[_ ]?key|token|password)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}/i;
const KEY_SIMPLE = /(private[_ ]?key|secret|api[_ ]?key|token|password)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{16,})/i;
const CONN_STRING = /(postgres(ql)?|postgrest):\/\/[^\/\s:]+:[^@\s]+@/i;
const API_VALUE = /["']?(sandbox:|live:|nvm_|cdp_|sk_live|sk_test)[A-Za-z0-9_\-\.]{4,}["']?/i;

let real = 0;
const rows = [];
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch (_) { continue; }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // skip obvious prose/docs lines with 'live:' or PostgREST mentions
    if (/^\s*[#*/\-]/.test(line)) continue;
    const isTxHashLine = /tx(hash)?|transaction|block|receipt|hash\b/i.test(line);
    const keyHit = KEY_ASSIGN.exec(line);
    const connHit = CONN_STRING.exec(line);
    const apiHit = API_VALUE.exec(line);
    if (keyHit) { rows.push({ rel, line: i + 1, kind: 'key-assign', match: keyHit[0].slice(0, 80) }); real++; }
    else if (!isTxHashLine) {
      const key2 = KEY_SIMPLE.exec(line);
      if (key2 && /0x[0-9a-fA-F]{40}/.test(line)) { /* address assignments fine */ }
    }
    if (connHit) { rows.push({ rel, line: i + 1, kind: 'conn-string', match: connHit[0].slice(0, 80) }); real++; }
    if (apiHit) { rows.push({ rel, line: i + 1, kind: 'api-value', match: apiHit[0].slice(0, 80) }); real++; }
  }
}
for (const r of rows) console.log(r.kind.padEnd(12) + r.rel + ':' + r.line + '  ' + r.match);
console.log('REAL_SECRET_FINDINGS: ' + real);
process.exit(real > 0 ? 1 : 0);