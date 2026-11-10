// scan.js — Secret detection + security-pattern scan over the whole project.
// Excludes .env, node_modules, handoff-staging, the workspace root, and
// git-related state. Prints categorized findings; exits non-zero if any
// HIGH-severity pattern is found in a source/artifact file.
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'handoff-staging', '.git', 'workshop']);
const SKIP_FILES = new Set(['.env', 'package-lock.json']);
const HEX64 = /0x[0-9a-fA-F]{64}\b/g;
const HEX40 = /0x[0-9a-fA-F]{40}\b/g;
const API_PREFIXES = /(sandbox:|live:|nvm_|cdp_|sk_live|sk_test|supabase\.co|postgres(ql)?:\/\/[^\s"'`]+|postgrest[^\s"'`]*)/gi;
const URL_EMBEDDED_KEY = /https?:\/\/[^\s"'`]*(apikey|api_key|token|key|password|secret)=[^\s"'`]+/gi;

let high = 0, info = 0;
const findings = [];

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
    } else {
      if (SKIP_FILES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      // Skip binary-ish files
      if (/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4000))) continue;

      const hex64 = text.match(HEX64) || [];
      const hex40 = text.match(HEX40) || [];
      const api = text.match(API_PREFIXES) || [];
      const urlKey = text.match(URL_EMBEDDED_KEY) || [];

      if (hex64.length || api.length || urlKey.length) {
        findings.push({ rel, hex64: hex64.length, hex40: hex40.length, api: api.slice(0, 3), urlKey: urlKey.slice(0, 3) });
        for (const h of hex64) if (!/^0x0{64}$/.test(h)) high++;
        for (const a of api) if (/sandbox:|live:|nvm_|cdp_|sk_live|sk_test/.test(a)) high++;
        for (const u of urlKey) high++;
      }
      if (hex40.length) info += hex40.length;
    }
  }
}
walk(ROOT);

console.log('HEX64 (0x+64) occurrences by file (excluding all-zero placeholders):');
for (const f of findings) if (f.hex64) console.log('  ' + (f.hex64 > 1 ? f.hex64 + 'x ' : '') + f.rel);
console.log('API-key / embedded-credential patterns:');
for (const f of findings) {
  if (f.api.length) console.log('  ' + f.rel + ' -> ' + f.api.join(' | '));
  if (f.urlKey.length) console.log('  URLKEY ' + f.rel + ' -> ' + f.urlKey.join(' | '));
}
console.log('ADDRESSES-40hex (likely public hashes/addresses; informational): ' + info + ' occurrences');
console.log('HIGH_SEV_FINDINGS: ' + high);
process.exit(high > 0 ? 1 : 0);