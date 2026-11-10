'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const files = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const patterns = [
  /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/,
  /"d"\s*:\s*"[A-Za-z0-9_-]{30,}/,
  /(?:SAAX_TEST_BUYER_KEY|SAAX_SIGNER_PRIVATE_KEY|SAAX_SELLER_PRIVATE_KEY|SAAX_EVALUATOR_PRIVATE_KEY)\s*=\s*0x[0-9a-fA-F]{64}/,
  /postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@/,
];
const violations = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  for (let index = 0; index < patterns.length; index++) {
    if (patterns[index].test(content)) violations.push({ path: file, pattern: index });
  }
}
console.log(JSON.stringify({ stagedPaths: files.length, findings: violations }, null, 2));
process.exitCode = violations.length ? 1 : 0;
