// manual-static-review.js — grep the codebase for dangerous JS patterns.
// Looks for: eval, child_process/exec*, new Function, dynamic require of
// variables, template-literal interpolation into exec, and any place where a
// payment/signature header field could reach one of them. Prints findings.
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SCAN_DIRS = ['endpoint', 'scripts', 'dump'];
const PATTERNS = [
  { name: 'eval(', re: /\beval\s*\(/g },
  { name: 'new Function', re: /new\s+Function\s*\(/g },
  { name: 'child_process exec', re: /\b(child_process|execSync|spawnSync|execFileSync|execFile|spawn|fork)\s*\(/g },
  { name: 'dynamic require (var)', re: /require\(\s*[^'"`][^)]*\)/g },
  { name: 'shell interpolate', re: /(`[^`]*\$\{[^}]*`)\s*[;|&]/g },
  { name: 'JSON.parse of untrusted', re: /JSON\.parse\(\s*(req\.|body|header)/g },
];

let findings = 0;
for (const dir of SCAN_DIRS) {
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { continue; }
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const full = path.join(dir, f);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
    for (const p of PATTERNS) {
      const m = text.match(p.re);
      if (m && m.length) {
        // Grab surrounding line context for the first hit
        const lines = text.split('\n');
        const hitLine = lines.findIndex(l => p.re.test(l));
        const ctx = hitLine >= 0 ? lines[hitLine].trim().slice(0, 120) : '';
        console.log(p.name + '  ' + dir + '/' + f + ' x' + m.length + (ctx ? '  | ' + ctx : ''));
        findings += m.length;
      }
    }
  }
}
console.log('MANUAL_STATIC_FINDINGS: ' + findings);
process.exit(0);