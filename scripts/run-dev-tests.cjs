#!/usr/bin/env node
// SAAX developer test runner — offline, credential-free, meaningful.
// Runs the core protocol suites a fresh clone can execute without any
// production credentials or external infrastructure.
//
// Infrastructure-backed suites (Docker PostgREST testbed) are intentionally
// NOT part of `npm test`; run them explicitly with `npm run test:infra`.
//
// Exit codes: 0 = all suites passed, 1 = any suite failed.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const SUITES = [
  { name: "conformance", cmd: "node", args: ["conformance/runner/run-conformance.mjs"] },
  { name: "evidence", cmd: "node", args: ["tests/reliability/test-evidence-verification.cjs"] },
];

let failed = 0;
for (const suite of SUITES) {
  process.stdout.write(`\n=== ${suite.name} ===\n`);
  const res = spawnSync(suite.cmd, suite.args, {
    cwd: root,
    stdio: "inherit",
    timeout: 300000,
  });
  if (res.status !== 0) {
    failed += 1;
    process.stdout.write(`[FAIL] ${suite.name} (exit ${res.status})\n`);
  } else {
    process.stdout.write(`[PASS] ${suite.name}\n`);
  }
}

process.stdout.write(`\n${SUITES.length - failed}/${SUITES.length} suites passed.\n`);
process.exit(failed === 0 ? 0 : 1);