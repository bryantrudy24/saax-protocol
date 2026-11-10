'use strict';
// Copy only tracked source/config and explicit checkpoint additions to an OS
// temp directory. Never remove or reinstall the working repository's modules.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-phase3b-clean-'));
const files = execFileSync('git', ['ls-files', '-z', '--', 'contracts', 'verifier', 'mainnet/design/support', 'scripts/test-custody-v2-realsafe.cjs', 'package.json', 'package-lock.json', 'hardhat.config.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean);
files.push('.npmrc', 'mainnet/design/support/v4-signatures.js', 'verifier/verify-v4.js', 'verifier/v4-candidate-identity.json', 'scripts/test-v4-checkpoint.cjs');
for (const file of new Set(files)) {
  // No node_modules, historical scratch, private state or application data.
  if (!/^(contracts\/|verifier\/|mainnet\/design\/support\/|scripts\/test-custody-v2-realsafe.cjs$|scripts\/test-v4-checkpoint.cjs$|package(-lock)?\.json$|hardhat\.config\.js$|\.npmrc$)/.test(file)) continue;
  const dest = path.join(target, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(root, file), dest);
}
let log = 'Isolated directory: ' + target + '\nNode: ' + process.version + '\n';
function run(command) {
  const r = spawnSync(command, { cwd: target, shell: true, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  log += '\n$ ' + command + '\n' + r.stdout + r.stderr + '\nexit=' + r.status + '\n';
  console.log(command + ': exit=' + r.status);
  fs.mkdirSync(path.join(root, 'evidence/phase3b-v4'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evidence/phase3b-v4/clean-install.txt'), log);
  if (r.status !== 0) throw new Error(command + ' failed: ' + String(r.stderr).slice(-2000));
}
run('npm ci --ignore-scripts --no-audit --no-fund');
run('node -e "console.log(require(\'@safe-global/safe-contracts/package.json\').version, require(\'solc\').version(), require(\'hardhat/package.json\').version)"');
run('npx --no-install hardhat compile');
run('node scripts/test-custody-v2-realsafe.cjs');
run('node scripts/test-v4-checkpoint.cjs --skip-legacy');
console.log('Isolated clean install/build and both focused harnesses passed; retained temp directory for inspection.');
