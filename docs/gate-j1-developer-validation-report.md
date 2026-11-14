# SAAX Gate J.1 — Developer Validation, MCP Documentation Reconciliation & Supplier Discovery Assessment

Date: 2026-11-14 (UTC). Status: ISOLATED CANDIDATE — not deployed, not merged, not published.

## 1. Conformance Reconciliation (Priority One)

### Root cause

- Internal conformance suite (Gate I worktree `ax-router-gate-i`, commit `8cf9d6a3`): **94 vectors**.
- Public GitHub `main` (`dd3f123`, fetched today): **89 vectors**.
- Difference: **exactly 5 vectors** — the entire `conformance/vectors/evidence/` directory — are **absent from the public repository**:
  - `evidence-satisfied-001.json`
  - `evidence-not-satisfied-002.json`
  - `evidence-insufficient-003.json`
  - `evidence-tampered-004.json`
  - `evidence-stale-005.json`

These vectors exercise the `evaluateCriterion` implementation (evidence acceptance policy). The conformance runner on both trees registers the identical `evidence` category; the vector files themselves were simply **not published** in the Gate I.1 public repository sync. The evidence capability is still covered publicly by `tests/reliability/test-evidence-verification.cjs` (19 tests) — so this is a **test-corpus publishing omission**, not a functionality gap and not a security defect.

### Remediation (isolated candidate only)

- Reproduced the missing 5 vectors from the internal tree into the candidate worktree `ax-router-gate-j1` (`conformance/vectors/evidence/`).
- Ran the candidate conformance runner: **94/94 PASS** (was 89/89 without them).
- No assertion weakened; vector contents are byte-identical to the internal originals.

### Resolution

| Suite | Before (public) | After (candidate) |
|---|---|---|
| Conformance runner | 89/89 | **94/94** |
| `npm test` (conformance + evidence) | 89 + 19 | **94 + 19** (2/2 suites exit 0) |

## 2. Clean-Room Developer Validation (Priority Two)

Environment: Windows 10/11 host, Node v26.3.0, fresh `npm ci` (799 packages), no production credentials, no private files.

| Check | Result |
|---|---|
| Clone / worktree creation from `8cf9d6a3` | OK |
| `npm ci` | OK (799 packages, 0 errors) |
| `npm test` | **2/2 suites PASS** (conformance 94/94 + evidence 19/19), exit 0 |
| `examples/crash-safe-workflow/run.cjs` | **PASS** (commitment create → accept → reload → state preserved) |
| `examples/mcp-recovery/run.cjs` | **PASS** (12/12 local-testbed recovery checks; live Part A gracefully skipped where endpoint requires a session) |
| `examples/authorization-boundary/run.cjs` | **PASS** (issued→accepted→executing→evidence_submitted; payment step simulated) |
| `docs/DEVELOPER-QUICKSTART.md` | Present and accurate; references evidence + cancel/close correctly |

### Defect found and fixed (isolated)

`examples/mcp-recovery/run.cjs` Part A attempted a **sessionless** read-only call to `https://saax-protocol.com/mcp`, which the production server correctly rejects with `-32001 Session not found` (MCP sessions require the `Mcp-Session-Id` header established at initialize). This made the example fail on a clean clone. Fix: Part A now treats the live endpoint as a best-effort probe (skips gracefully when the endpoint requires session support) and Part B (the offline local-testbed recovery demonstration) remains the authoritative check. Result: example exits 0.

Note: Linux/macOS not separately tested in this run; documented as a limitation.

## 3. MCP Documentation Reconciliation (Priority Three)

### Live tool inventory (verified today via SDK client, `tools/list`)

**25 tools** (count matches the previously reported production surface):

1. `get_protocol_info`, 2. `get_routing_fee`, 3. `ping`, 4. `route_request`, 5. `get_commitment`, 6. `list_capabilities`, 7. `list_commitments`, 8. `get_commitment_status`, 9. `create_commitment`, 10. `get_evidence_verification`, 11. `get_authority_validation`, 12. `get_commitment_history`, 13. `get_recovery_status`, 14. `get_pending_actions`, 15. `resume_commitment`, 16. `cancel_commitment`, 17. `close_commitment`, 18. `prepare_commitment`, 19. `accept_commitment`, 20. `submit_evidence`, 21. `list_evidence`, 22. `verify_evidence`, 23. `raise_dispute`, 24. `resolve_dispute`, 25. `list_disputes`

### Documentation gap (confirmed)

The public website integration guide (`landing/docs.md`, rendered at `https://www.saax-protocol.com/docs`) listed **11 tool names** in its MCP section and omitted the entire lifecycle/evidence/dispute cluster (`cancel_commitment`, `close_commitment`, `submit_evidence`, `list_evidence`, `verify_evidence`, `raise_dispute`, `resolve_dispute`, `list_disputes`, `get_commitment_history`, `get_recovery_status`, `get_pending_actions`, `resume_commitment`). A developer reading the public docs would reasonably conclude cancellation/closure/evidence operations do not exist, when in fact all 25 tools are live.

### Correction (isolated candidate)

Replaced the MCP integration tool list with the full 25-tool inventory, grouped by Core/Routing, Commitments & Lifecycle, Evidence, Disputes; documented the authentication boundary (mutating tools require EIP-712 authority proof + durable registry authorization; read-only tools enforce commitment-scoped visibility); and added a **"Commitment Lifecycle & Evidence Operations"** section describing:
- Canonical lifecycle: `issued -> authority_validated -> accepted -> in_flight -> executing -> evidence_pending -> evidence_submitted -> verifying -> fulfilled -> settled -> finalized`, with `recovering` and `disputed` branches.
- Cancellation (`cancel_commitment`), closure (`close_commitment`, system/authority roles), evidence submission/listing/verification (`submit_evidence`, `list_evidence`, `verify_evidence`) — explicitly nonfinancial.
- Recovery: replacement agent continues via `resume_commitment` only with its own independently authorized grant; authority never transfers automatically.

Discovery acceptance (links from quickstart/docs/blog) documented in the candidate.

## 4. Supplier Discovery Assessment (Priority Four)

### Existing architecture

`api/mcp.mjs` exposes `route_request` (ranked supplier matches for a capability, read-only, no settlement) and `list_capabilities` (distinct capabilities with supplier counts). Both read from `endpoint/mcp-supplier-index.json` via `loadSupplierIndex()`, which currently contains 123 supplier records. Each record already carries:

- `agent_id`, `owner` (address), `name`, `description`, `services[]` (`name`, `endpoint`, `version`), `source`.

The ranking engine (`scripts/rank-suppliers.js`) derives capability matching from `name + description + services[].name` text and reputation fields — no separate capability table.

### Can a developer already discover a supplier and route?

| Requirement | Status |
|---|---|
| Discover a supplier | PARTIAL — `route_request` returns ranked suppliers for a capability; `list_capabilities` shows counts but not identities |
| Identify uniquely | YES — `agent_id` returned in ranked candidates |
| Retrieve supported capabilities | PARTIAL — services visible only in the internal index, not through an MCP detail tool |
| Determine if it can fulfill a task | PARTIAL — via ranking score, but no per-supplier detail surface |
| Identify supported commerce interfaces | LIMITED — `services[].endpoint` exists but is not exposed via MCP |
| Obtain routing info to initiate a commitment | YES via `route_request` |
| Distinguish verified vs self-reported | PARTIAL — `source` field exists (`indexed`) but no provenance surface |

### Verdict

A genuine, small discoverability gap exists: developers cannot retrieve a **single supplier's** identity, services, and provenance without a detail interface. Existing data fully supports a safe read-only `get_supplier_details` tool — **no schema change, no new external data, no settlement surface**.

### Design recommendation (not implemented in production)

- **Tool name:** `get_supplier_details` (provisional)
- **Input:** `supplier_id` (string; validated `agent_id` or owner address), optional `capability` filter
- **Output:** supplier identity (agent_id, name, description, owner), `services[]` (name, endpoint, version), `source`, `capabilities`, `last_updated` — no reputation score, no trust claim, no private endpoints/credentials
- **Security:** read-only; reject invalid/missing IDs with explicit error; no unbounded enumeration (single-ID lookup only); rate-limited; never exposes private credentials; preserves router behavior
- **Authorization:** read-only tools enforce commitment-scoped visibility; no additional proof required
- **Tests:** valid ID, missing ID, invalid ID, capability-filter match/no-match, cross-supplier isolation, rate-limit behavior

### Why NOT added now

- The gate brief is explicit: a **new production MCP tool addition requires owner approval** before deployment.
- Existing tests assert a **25-tool inventory**; adding a 26th tool without approval would break documented compatibility and stage-f/stagef assertions.
- The correct Gate J.1 output is a **documented design + owner approval request**, not an unapproved surface expansion.

**Recommendation:** add `get_supplier_details` in a future owner-approved release, reusing the existing supplier index (no migration).

## 5. Coinstancy Integration Readiness (Priority Five)

Capability matrix (verified against the live 25-tool MCP surface and the isolated testbed):

| Capability | Status | Notes |
|---|---|---|
| Commitment creation | IMPLEMENTED & VERIFIED | `create_commitment`, `prepare_commitment`, `accept_commitment` |
| Commitment acceptance | IMPLEMENTED & VERIFIED | `accept_commitment` |
| Authorization | IMPLEMENTED & VERIFIED | EIP-712 principal binding + durable registry |
| Supplier discovery | IMPLEMENTED (read-only) | `route_request`, `list_capabilities` |
| Supplier details | NOT IMPLEMENTED (design ready) | `get_supplier_details` proposal awaiting owner approval |
| Execution tracking | IMPLEMENTED & VERIFIED | `get_commitment_status`, `get_commitment_history` |
| Evidence submission | IMPLEMENTED & VERIFIED | `submit_evidence` |
| Evidence verification | IMPLEMENTED & VERIFIED | `verify_evidence`, `get_evidence_verification` |
| Cancellation | IMPLEMENTED & VERIFIED | `cancel_commitment` |
| Closure | IMPLEMENTED & VERIFIED | `close_commitment` (system/authority) |
| Recovery | IMPLEMENTED & VERIFIED | `resume_commitment`, `get_recovery_status`, `get_pending_actions` |
| Disputes | IMPLEMENTED & VERIFIED | `raise_dispute`, `resolve_dispute`, `list_disputes` |
| Payment-system boundaries | COMPLEMENTARY, NONFINANCIAL | SAAX records commitments; real payment rails (x402/MPP) remain separate |

Coinstancy-style agentic commerce workflows can: discover a capability, route to a supplier, create/accept a commitment, track execution, submit and verify evidence, cancel or close, recover after interruption, and raise/resolve disputes — all nonfinancial. No Coinstancy certification or partnership is claimed.

## 6. Controlled External Developer Pilot (Priority Six)

Architecture: invitation-only, nonfinancial, isolated environment (Docker testbed / staged Supabase), per-participant scoped authorization (identity-bound, commitment-scoped), rate limits (shared-store abuse guard), full audit trail, revocation capability, incident-response + emergency shutdown procedure.

Isolation/security tests already passing in the isolated testbed:
- Unauthorized lifecycle transition rejection (principal-binding suite 18/18)
- Forged agent authority rejection (harness 35/35)
- Revoked authority rejection (live Stage F verified; isolated suite green)
- Expired authority rejection (isolated suite green)
- Cross-participant access prevention (commitment-scoped visibility, tested)
- Idempotency (durable 19/19), replay protection (discovery suite), recovery (12/12 three-agent MCP), evidence integrity (21/21 + 19/19)

Activation prerequisites: owner approval for invitation/recruitment (3–5 developers), no public registration, no production financial operations.

## 7. Developer Adoption Measurement (Priority Seven)

Framework defined (no telemetry activated):

| Category | Metrics | Evidence standard |
|---|---|---|
| Discovery | GitHub stars/forks, docs traffic, search impressions, registry visibility | Platform APIs where available |
| Engagement | Quickstart visits, example executions, test runs, feedback | Opt-in/voluntary, privacy-conscious |
| Integration | Successful nonfinancial workflow completions, authorized recovery, evidence verification | Only independently observed records |
| Verified external adoption | Repeated independent integrations with reliable evidence | NEVER counts founder/Lucius/internal/automated/synthetic activity |

Production telemetry remains OFF; any prototype stays isolated.

## 8. SDK / Middleware Priorities (Priority Eight)

Ranked recommendation (from developer friction + demand + maintenance):

1. **MCP client helper** (TypeScript) — lowest friction; developers already use MCP clients; wraps session + EIP-712 proof + idempotency.
2. **TypeScript client** (typed wrappers for the 25 tools; request/response models) — high value, low security risk.
3. **Python client** (mirror of TS) — for the AI agent ecosystem.
4. **x402 middleware** — only after a real x402 integration pattern is proven; currently explicitly out of scope (payment path unchanged).
5. **Self-hosted router** — not recommended now; operational overhead without proven demand.

No packages published; prototypes remain local.

## 9. Search Console & MCP Registry (Priority Nine)

- **Search Console:** credentialed owner access remains unavailable in this environment. No metrics fabricated; required owner action documented (authorized OAuth access / service-account setup).
- **MCP Registry:** verified earlier — versions 1.0.0–1.0.3 active; 1.0.4 metadata prepared; publication awaits owner GitHub OAuth. Re-verified this run: still not published; no duplicate listing; no bypass of OAuth.

## 10. Independent Audit Provider Comparison (Priority Ten)

No provider contacted. Comparison based on public information only (see report file `gate-j1-audit-provider-comparison.md` for the three-provider table). Estimates are preliminary; all engagement and costs require owner approval.

## 11. Regression & Test Evidence (candidate)

- Conformance: 94/94
- Evidence verification: 19/19
- `npm test`: 2/2 suites PASS, exit 0
- Examples: crash-safe PASS, mcp-recovery PASS (12/12), authorization-boundary PASS
- Existing 25-tool inventory preserved (no surface change)

## 12. Repository Integrity

- New isolated worktree: `ax-router-gate-j1`, branch `feature/saax-gate-j1`, base `8cf9d6a3`.
- Changes: restored 5 evidence conformance vectors; `landing/docs.md` corrected (full 25-tool inventory + lifecycle/evidence section); `examples/mcp-recovery/run.cjs` fixed (session-bounded live probe treated gracefully).
- Main worktree `a7597c6d` preserved (681 pre-existing dirty files untouched); all prior worktrees preserved; no merge, push, deploy, migration, or financial change.

## 13. Required Owner Approvals (Gate J.1 → release)

1. Merge/push `feature/saax-gate-j1` into the public repository (or a PR) — including the 5 evidence vectors + docs correction + example fix.
2. Approve (or reject) the `get_supplier_details` MCP tool design; if approved, a follow-up isolated implementation + regression run + deployment.
3. Activate the controlled external developer pilot (invitation/recruitment).
4. Commission the independent security assessment (audit provider selection + cost approval).
5. Provide GitHub OAuth for the MCP registry 1.0.4 publication.
6. Authorize Search Console access.