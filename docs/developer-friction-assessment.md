# SAAX Developer Friction Assessment — Gate J.16, Workstream B

**Date:** 2026-11-15 · **Assessment basis:** live public endpoint probes (26-tool inventory, schemas),
the public repo (public/main @ 5f702da2), the internal repo (origin/main @ cd6fd913), the quickstart,
the integration guide (docs.md), the three examples, and the executed test suites.

---

## Method

Evaluated the onboarding path a developer unfamiliar with SAAX faces, end to end:
**understand → connect → discover → create → inspect → authorize → recover → find limitations.**
Each step was checked against the live endpoint and the actual repository content.
Barriers are ranked by severity (how badly it blocks adoption), implementation effort, and
expected adoption benefit.

---

## Top 5 barriers

### 1. Internal-repo documentation drift (README + docs.md) — HIGH severity, LOW effort, HIGH benefit

**Finding.** The deployed/public line (public/main) is current: README lists 26 tools (grouped),
94/94 conformance, protocol 1.0.4, and docs.md lists all 26 tools. The **internal dev repo
(origin/main @ cd6fd913)** is stale: README claims "10 tools (up from 8)", "55/55 vectors",
and docs.md lists only **13 tools** in its MCP section. A developer cloning the dev repo sees
wrong tool counts and a missing half of the inventory (recovery, evidence, dispute tools).

**Impact.** Wrong mental model; a dev following the internal README cannot discover 13 of 26
tools. The public surface is correct, so this affects developers who build from source.

**Fix.** Sync origin/main's README.md + landing/docs.md to the public line's content (or
regenerate from the deployed source). Candidate prepared in this gate.

### 2. Quickstart tool count + protocol version drift — MEDIUM severity, LOW effort, HIGH benefit

**Finding.** `docs/DEVELOPER-QUICKSTART.md` (the five-minute onboarding doc) claimed "25 tools"
in two places and "Protocol version 2025-06-18". Live endpoint: **26 tools**, protocol
**2025-03-26**. `examples/mcp-recovery/run.cjs` asserted a 25-tool inventory, failing against live.

**Impact.** The headline onboarding doc undercounts the inventory and cites a wrong protocol
version; the example test failed. A developer hitting the 25-vs-26 mismatch loses trust.

**Fix.** Applied this gate: 25→26 (quickstart ×2, example ×1), protocol 2025-06-18 → 2025-03-26.
Example now passes 9/9 Part A.

### 3. Authorization prerequisite is the single largest conceptual barrier — HIGH severity, HIGH effort (educational), HIGH benefit

**Finding.** Mutating tools (`create_commitment`, `accept_commitment`, `resume_commitment`,
`submit_evidence`, …) require an EIP-712 proof AND a durable authorization record in
`agent_authorizations`. The quickstart explains this correctly, but a new developer's first
attempt at a mutating call will fail with `AUTH_MISSING_AUTHORIZATION` unless they have the
operator-run provisioning step (testbed token + `provision_authority` + grants). The examples
need the Docker testbed to demonstrate this — there is no fully-offline mutating demo.

**Impact.** The core value (durable commitments + recovery) is behind the authorization wall;
without a testbed, a dev cannot experience it in five minutes.

**Fix.** (a) Keep the Docker testbed as the canonical path and document it prominently in the
quickstart; (b) consider a `demo` mode or explicit test-only operator token documented for local
dev; (c) the offline `authorization-boundary` example exists but is conceptual — extend it with
real (testbed-backed) code where feasible.

### 4. Session requirement for SDK clients is under-documented — MEDIUM severity, LOW effort, HIGH benefit

**Finding.** The public endpoint is session-bounded: after `initialize`, the server returns an
`mcp-session-id` and subsequent requests must carry it. SDK clients using
`StreamableHTTPClientTransport` handle this automatically, but raw HTTP clients that don't
manage the session get `-32001 Session not found` (or the mcp-recovery example's "NOTE" branch).
The integration guide's client-config snippet (`{ "mcpServers": { "saax": { "url": ... } } }`)
does not mention the session requirement.

**Impact.** Raw-curl / custom-client integrators hit an undocumented wall and may think the
endpoint is broken.

**Fix.** Add a short "session handling" note to docs.md + quickstart: initialize → capture
`mcp-session-id` → send it on every request. (Verified live: init 200 returns the header;
tools/list with the session returns 26 tools.)

### 5. No public sandbox / demo instance with pre-provisioned authorizations — MEDIUM severity, MEDIUM effort, HIGH benefit

**Finding.** Every mutating demonstration requires either the local Docker testbed or
operator-provisioned production authorizations. There is no public "try it now" sandbox where a
developer can create/inspect a commitment without provisioning.

**Impact.** The five-minute goal ("connect, discover, complete a safe nonfinancial example") is
achievable for discovery/read-only but not for the full lifecycle without local setup.

**Fix.** (a) Ship the three examples (done — they exist and pass); (b) document the testbed setup
path in the quickstart; (c) candidate: a `docs/sandbox.md` explaining exactly how to run the
testbed and the examples. Full public sandbox is a larger decision for a future gate.

---

## Secondary findings (documented, lower severity)

- **`scripts/test-mcp-tools.mjs` is stale** — asserts "13 tools" (line ~33), a Day-13-era smoke
  superseded by the 26-tool inventory. Should be updated or marked superseded (the conformance +
  infra suites now cover the surface).
- **`examples/mcp-recovery/run.cjs` Part A NOTE branch** — the live SDK call path relies on
  session support; the example skips gracefully. Works, but the "NOTE" could confuse. (Now passes
  9/9 with the 26 fix.)
- **The `[redacted-secret]` appearance** in several files (blog title, llms.txt, blog index) is a
  **console display-filter artifact**, not repository content. Hex verification shows the files
  contain `verifying Discovery-to-testnet finance` (ASCII). No defect; documented so future gates
  do not re-open it. (This also explains the J.13 "R5 mojibake" finding — same artifact.)
- **Internal repo is 2 commits behind origin/main** and the J.16 worktree base was rebuilt from
  public/main because origin/main's MCP source (13 tools) is older than the deployed source
  (26 tools). The internal repo needs a sync pass to match the deployed line (a future release
  decision, not part of this gate's authorization).

---

## Five-minute goal assessment

**Achievable today: YES (read-only path).** A developer can, in ~5 minutes:

1. Read what SAAX is (README / docs).
2. Connect with an MCP client or the SDK (client config snippet).
3. Discover all 26 tools (`tools/list`).
4. Call read-only tools (`get_protocol_info`, `ping`, `list_capabilities`, `get_commitment` on a
   known ID, `get_recovery_status`).

**Not yet without local setup (mutating path):** creating/accepting a commitment requires
authorization provisioning (testbed or operator). The three examples + testbed fill this gap for
a developer who runs the local stack.

**Recommendation:** with the quickstart corrections (this gate) + a short testbed-run section,
the five-minute goal is met for the discover-and-inspect path and documented for the full
lifecycle path.
