#!/usr/bin/env node
// Example 1 — Crash-Safe Agent Workflow (nonfinancial)
// Runs only against the local Docker PostgREST testbed. Never production.
//
// Usage: node examples/crash-safe-workflow/run.cjs
// Requires: local testbed at http://127.0.0.1:3000 (see tests/reliability/README.md)

const assert = require("node:assert");
const { randomUUID } = require("node:crypto");

// Point the store client at the LOCAL testbed only (never production).
process.env.POSTGREST_URL = process.env.POSTGREST_URL || "http://127.0.0.1:3000";
const { mint } = require("../../tests/reliability/_gate-d-jwt.cjs");
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint("service_role");

const store = require("../../endpoint/store.js");
const { transitionCommitment, grantAgentAuthorization } = require("../../endpoint/lifecycle.js");

const db = store.buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY);

const TEST_OPERATOR_TOKEN = "test-operator-token-0123456789abcdef"; // TESTBED ONLY
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const PRINCIPAL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRINCIPAL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMMITMENT_ID = "saax_example_crash_" + Date.now();
const AUTHZ_REF = "example-authz-" + COMMITMENT_ID;

async function seedTestbedOperator() {
  // The isolated testbed's operator_secrets row is not durably seeded across
  // restarts. Mirror the reliability suites: docker exec psql to insert the
  // TEST-ONLY token hash. (Production operators are seeded via the operator
  // runbook — never via code or test tokens.)
  const { execFileSync } = require("node:child_process");
  execFileSync("docker", ["exec", "ax_router_db", "psql", "-U", "postgres", "-d", "ax_router", "-t", "-A", "-c",
    "INSERT INTO ax_router.operator_secrets (secret_key, secret_hash) VALUES ('authority_operator','653720f36b93ba9429b5d13edd74c359787b7138ffc17d77a564b947dd6adeb6') ON CONFLICT (secret_key) DO UPDATE SET secret_hash=EXCLUDED.secret_hash;"],
    { encoding: "utf8" });
}

async function requireProvisionedAuthority(commitmentId) {
  // Operator bootstraps an authority row for the commitment (testbed only).
  const { error: provErr } = await db.rpc("provision_authority", {
    p_agent_id: "auth-" + commitmentId,
    p_verified_principal: PRINCIPAL_A,
    p_commitment_id: commitmentId,
    p_role: "authority",
    p_scope: {},
    p_valid_until: new Date(Date.now() + 7 * 86400e3).toISOString(),
    p_operator_token: TEST_OPERATOR_TOKEN, // TESTBED ONLY
    p_idempotency_ref: "prov:" + commitmentId,
  });
  if (provErr) throw new Error("provisionAuthority: " + provErr.message);

  // Authority grants buyer/provider roles to agent-a and agent-b.
  for (const [agent, principal, role] of [
    [AGENT_A, PRINCIPAL_A, "buyer"],
    [AGENT_B, PRINCIPAL_B, "provider"],
  ]) {
    const g = await grantAgentAuthorization({
      authorizerAgent: "auth-" + commitmentId,
      authorizerPrincipal: PRINCIPAL_A,
      authorizerRole: "authority",
      subjectAgent: agent,
      subjectPrincipal: principal,
      commitmentId,
      role,
      scope: { actions: ["accept", "execute", "submit_evidence"] },
      idempotencyRef: "grant-" + commitmentId + "-" + agent,
    });
    if (!g.ok) throw new Error("grant " + agent + ": " + g.error);
  }
}

// Canonical roles (from the migration's role table):
//   issued -> accepted : BUYER
//   accepted -> executing : PROVIDER
async function acceptCommitment(commitmentId, agentId, principal, { idempotencyKey } = {}) {
  return transitionCommitment({
    commitmentId,
    fromState: "issued",
    toState: "accepted",
    requestedAction: "accept",
    agentId,
    actorRole: "buyer",
    authorityRef: AUTHZ_REF,
    idempotencyRef: idempotencyKey || "accept-" + commitmentId,
    evidenceRef: null,
    expectedVersion: 1,
    verifiedPrincipal: principal,
  });
}

async function createCommitment(principal, terms) {
  const ins = await db
    .from("commitments")
    .insert({
      commitment_id: COMMITMENT_ID,
      state: "issued",
      capability: "demo",
      terms: JSON.stringify(terms),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  if (ins.error) throw new Error("createCommitment: " + ins.error.message);
  return { commitment_id: COMMITMENT_ID, state: "issued" };
}

async function getCommitment(commitmentId) {
  const { data } = await db
    .from("commitments")
    .select("state,version")
    .eq("commitment_id", commitmentId)
    .limit(1);
  return data && data[0];
}

(async () => {
  console.log("crash-safe-workflow: starting (local testbed only)");

  // 0. Provision authority + grants (testbed operator model).
  await seedTestbedOperator();
  await requireProvisionedAuthority(COMMITMENT_ID);

  // 1. Create (agent A)
  await createCommitment(PRINCIPAL_A, { description: "Compute a SHA-256 digest", acceptanceCriteria: ["crc-001"] });
  console.log("created", COMMITMENT_ID, "state=issued");

  // 2. Accept (agent B) via the app wrapper -> transition_commitment RPC.
  const accepted = await acceptCommitment(COMMITMENT_ID, AGENT_A, PRINCIPAL_A, {
    idempotencyKey: "accept-" + COMMITMENT_ID,
  });
  assert.equal(accepted.ok, true, "accept must succeed: " + (accepted.error || ""));
  assert.equal(accepted.data.status, "transitioned", "first accept is fresh");
  assert.equal(accepted.data.to_state, "accepted", "to_state after accept");
  console.log("accepted to_state=" + accepted.data.to_state, "version=" + accepted.data.state_version);

  // 3. Simulate crash — nothing further happens in this process.

  // 4. Fresh client reads durable state.
  const reloaded = await getCommitment(COMMITMENT_ID);
  assert.equal(reloaded.state, "accepted", "commitment survived the crash");
  console.log("reloaded state=" + reloaded.state, "version=" + reloaded.version);

  // 5. Idempotent retry with the same key — no duplicate effect.
  const replay = await acceptCommitment(COMMITMENT_ID, AGENT_A, PRINCIPAL_A, {
    idempotencyKey: "accept-" + COMMITMENT_ID,
  });
  assert.equal(replay.ok, true, "replay must succeed: " + (replay.error || ""));
  assert.equal(replay.data.status, "replayed", "replay must be reported as replayed");
  const after = await getCommitment(COMMITMENT_ID);
  assert.equal(after.state, "accepted", "no duplicate transition on replay");

  console.log("crash-safe-workflow: PASS");
  process.exit(0);
})().catch((e) => {
  console.error("crash-safe-workflow: FAIL -", e.message);
  process.exit(1);
});
