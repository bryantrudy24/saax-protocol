#!/usr/bin/env node
// SAAX infrastructure-backed test suites — require the local Docker testbed.
//
// These suites talk to a disposable PostgREST/Postgres testbed
// (http://127.0.0.1:3000 by default, see tests/reliability/README.md) and
// must NEVER run against production credentials.
//
// Usage:
//   npm run test:infra                  # describe the required testbed
//   npm run test:infra -- --run          # run every infra suite
//   npm run test:infra -- <suite-name>   # run one suite
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const SUITES = [
  { name: "lifecycle", cmd: "node", args: ["tests/reliability/test-lifecycle-transitions.cjs"] },
  { name: "recovery", cmd: "node", args: ["tests/reliability/test-mcp-three-agent-recovery.cjs"] },
  { name: "harness", cmd: "node", args: ["tests/reliability/test-agent-harness.cjs"] },
  { name: "disputes", cmd: "node", args: ["tests/reliability/test-dispute-lifecycle.cjs"] },
  { name: "evidence-lifecycle", cmd: "node", args: ["tests/reliability/test-evidence-lifecycle.cjs"] },
];

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h") {
  console.log(
    "Infrastructure-backed suites require the local Docker PostgREST testbed.\n" +
      "  npm run test:infra -- --run          run all suites\n" +
      "  npm run test:infra -- recovery       run one suite\n" +
      "Suites: " + SUITES.map((s) => s.name).join(", ") + "\n" +
      "See tests/reliability/README.md for the testbed setup."
  );
  process.exit(0);
}

if (arg !== "--run") {
  const suite = SUITES.find((s) => s.name === arg);
  if (!suite) {
    console.error("Unknown suite: " + arg);
    process.exit(1);
  }
  const res = spawnSync(suite.cmd, suite.args, { cwd: root, stdio: "inherit", timeout: 300000 });
  process.exit(res.status === 0 ? 0 : 1);
}

let failed = 0;
for (const suite of SUITES) {
  process.stdout.write(`\n=== ${suite.name} ===\n`);
  const res = spawnSync(suite.cmd, suite.args, { cwd: root, stdio: "inherit", timeout: 300000 });
  if (res.status !== 0) { failed += 1; process.stdout.write(`[FAIL] ${suite.name} (exit ${res.status})\n`); }
  else { process.stdout.write(`[PASS] ${suite.name}\n`); }
}
process.stdout.write(`\n${SUITES.length - failed}/${SUITES.length} infra suites passed.\n`);
process.exit(failed === 0 ? 0 : 1);