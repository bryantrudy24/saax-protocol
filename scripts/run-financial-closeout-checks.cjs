'use strict';
// Repeatable check runner. No testnet writes. Each independent verifier receives
// a minimal explicit environment: no dotenv loading or app database credentials.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence/discovery-phase6');
const configRoot = process.argv.find(a => a.startsWith('--fixtures-root='));
if (configRoot) {
  const src = path.resolve(configRoot.slice('--fixtures-root='.length), 'spec/examples/discovery/keys');
  const dst = path.join(ROOT, 'spec/examples/discovery/keys');
  // Existing gitignored, throwaway test fixtures only; never overwrite/generate
  // a provider identity underneath committed signature fixtures.
  for (const name of ['example-private.jwk.json', 'example-buyer-private.jwk.json']) {
    if (!fs.existsSync(path.join(dst, name))) fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
}
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP,
  TMP: process.env.TMP, PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH,
  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA,
  SAAX_STORE_REMOTE_ENABLED: '0', SAAX_RPC_ENABLED: '0', SAAX_CI_ISOLATED: '1' };
const commands = [
  ['syntax-verifier', ['--check', 'verifier/verify-financial-export.js']],
  ['syntax-producer', ['--check', 'scripts/discovery-financial-closeout.cjs']],
  ['network-binding', ['tests/discovery-phase6/test-network-binding.cjs']],
  ['focused-primitives-verdict-metadata', ['--test', 'tests/discovery-phase6/test-custody-metadata.cjs', 'tests/discovery-phase6/test-financial-primitives.cjs', 'tests/discovery-phase6/test-financial-verdict.cjs']],
  ['verifier-selftest', ['verifier/verify-financial-export.js', '--self-test']],
  ['phase2', ['tests/discovery-phase2/run-phase2-tests.cjs']],
  ['phase3', ['tests/discovery-phase3/run-phase3-tests.cjs']],
  ['phase4', ['tests/discovery-phase4/run-phase4-tests.cjs']],
  ['ownership-regression', ['tests/discovery-phase4/test-gap1-ownership.cjs']],
  ['sr-regression', ['tests/discovery-phase4/test-gap2-verifier.cjs']],
  ['financial-terms-regression', ['tests/discovery-phase4/test-gap3-financial-terms.cjs']],
  ['recovery-regression', ['tests/discovery-phase4/test-gap4-recovery.cjs']],
  ['supabase-store-contract', ['tests/discovery-phase4/test-gap5-supabase-store.cjs']],
  ['supabase-proposal-contract', ['tests/discovery-phase4/test-gap5b-supabase-proposal-store.cjs']],
  ['checkd-cli', ['tests/discovery-phase4/test-checkd-cli.cjs']],
  ['conformance', ['conformance/runner/run-conformance.mjs']],
  ['schemas', ['scripts/_check-discovery-schemas.cjs']],
  ['public-export-negatives', ['tests/discovery-phase6/test-financial-export-negative.cjs']],
];
fs.mkdirSync(OUT, { recursive: true });
const records = [];
for (const [name, args] of commands) {
  const start = new Date().toISOString();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const text = '$ node ' + args.join(' ') + '\n' + (r.stdout || '') + (r.stderr || '') + '\nEXIT ' + r.status + '\n';
  fs.writeFileSync(path.join(OUT, 'test-' + name + '.txt'), text);
  records.push({ name, command: 'node ' + args.join(' '), startedAt: start, exit: r.status,
    error: r.error ? r.error.message : null, output: 'test-' + name + '.txt' });
  console.log(name + ': exit ' + r.status);
}
for (const kind of ['release', 'refund']) {
  const args = ['verifier/verify-financial-export.js', 'evidence/discovery-phase6/closeout-' + kind + '-export.json',
    '--trust=evidence/discovery-phase6/trust.json', '--json'];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(path.join(OUT, 'independent-' + kind + '-verification.json'), r.stdout);
  if (r.stderr) fs.writeFileSync(path.join(OUT, 'independent-' + kind + '-stderr.txt'), r.stderr);
  const report = JSON.parse(r.stdout);
  records.push({ name: 'separate-process-' + kind, command: 'node ' + args.join(' '), exit: r.status,
    verdict: report.verdict, passed: report.checks.filter(c => c.status === 'PASS').length,
    failed: report.checks.filter(c => c.status === 'FAIL').length,
    incomplete: report.checks.filter(c => c.status === 'INCOMPLETE').length,
    environment: 'explicit allowlist; no application DB URL/key/role/POSTGREST variables or dotenv' });
  console.log(kind + ' independent: ' + report.verdict + ' exit ' + r.status);
}
fs.writeFileSync(path.join(OUT, 'test-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), records,
  failed: records.filter(r => r.exit !== 0).length }, null, 2) + '\n');
process.exitCode = records.some(r => r.exit !== 0) ? 1 : 0;
