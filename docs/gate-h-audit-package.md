# SAAX Gate H — Independent Security Assessment Package (Auditor Handoff)

**Status:** COMPLETE — prepared for external assessment · No auditor engaged · Independent Third-Party Security Validation remains a **PENDING RELEASE REQUIREMENT**
**Date:** 2026-11-14 · **Prepared by:** Lucius Fox (internal) — this is NOT an independent audit

## 1. Purpose

Hand a self-contained, reproducible package to an independent third-party security
assessor so they can evaluate SAAX without relying on the internal developer's
explanations. All claims distinguish internally verified behavior, production-observed
behavior, isolated-test evidence, untested assumptions, and pending independent
assessment.

## 2. System identity & release provenance

- **Protocol:** SAAX (Solvent Applied Autonomous Exchange Protocol) — vendor-neutral
  commitment, verification, governance, and recovery layer for agentic commerce.
- **Production domains:** https://saax-protocol.com · https://www.saax-protocol.com
- **Production deployment:** `ax-router-bc9vmoetm` (Vercel) — Stage F targeted-deployment.
- **Deployed source:** commit `b20406b2` (branch `feature/saax-gate-g1`).
- **Git history:** main `cd6fd913` (PR #9/#10) → branch contains 13 unmerged lifecycle commits.
- **DB:** Supabase project `codboejrwohkjidrrcgl` (schema `ax_router`).
- **MCP endpoint:** https://saax-protocol.com/mcp (Streamable HTTP, `saax-protocol` 1.0.3).
- **MCP tools:** 25 registered (13 production + 12 lifecycle/evidence/dispute additions).
- **Rollback target:** `ax-router-30rf9r5q2` (previous production).

## 3. Architecture overview

SAAX is a commitment lifecycle protocol layered ABOVE payment rails, identity, and
commerce infrastructure. It is NOT a payment rail, identity provider, oracle,
marketplace, or replacement for x402/AP2/ACP/MCP.

Core principle: **The commitment must outlive the worker.**

Components:
- **MCP server** (`api/mcp.mjs`) — 25 tools, Streamable HTTP transport, per-session ownership.
- **Lifecycle engine** (`endpoint/lifecycle.js`, `endpoint/lifecycle-mcp.js`) — canonical 17-state,
  39-transition state machine enforced at runtime by the `transition_commitment` SECURITY DEFINER RPC.
- **Authorization** (`endpoint/authority.js`, `endpoint/evidence-verification.js`) — EIP-712 proofs,
  COSE/JWS verification, durable `agent_authorizations` registry.
- **Evidence** (`endpoint/evidence-lifecycle.js`, `endpoint/evidence-verification.js`) — durable
  submission, retrieval, verification.
- **Disputes** (`endpoint/dispute.js`) — nonfinancial dispute governance.
- **Abuse protection** (`endpoint/abuse-guard.js`) — distributed rate limiting, auth-abuse protection,
  fail-closed sensitive operations.
- **Recovery** — independent-agent recovery through `resume_commitment`, `get_recovery_status`,
  `get_pending_actions`, `get_commitment_history`.
- **EAS anchoring** (`endpoint/eas-anchor.js`) — simulated/testnet-only; NOT production-signing.

## 4. Trust boundaries

| Boundary | From | To | Control |
|---|---|---|---|
| T1 | Public MCP client | MCP server | Body-size bound (256KiB), Accept header, session-id |
| T2 | MCP caller | Lifecycle RPC | EIP-712 proof → verifiedPrincipal → durable authz |
| T3 | Verified principal | SECURITY DEFINER RPC | Registry check (agent+principal+role+scope, expiry/revocation) |
| T4 | Application | Supabase | service_role SELECT-only on tables, EXECUTE-only on RPCs |
| T5 | Operator | provision_authority | One-way sha256 operator-secret gate (fail-closed) |

## 5. Threat model (summary)

- Identity impersonation / forged roles → blocked by proof recovery + registry binding.
- Replay / cross-commitment → EIP-712 domain separation, commitment scope, op_fingerprint idempotency.
- Direct RPC bypass → no service-role DML grants; RPCs SECURITY DEFINER with fixed search_path.
- Rate-limit evasion → shared Supabase store, per-IP/principal/op tiers; sensitive ops fail CLOSED.
- Credential exposure → operator secret is hash-only in DB, mode-600 env file, never in Git/logs.
- Financial side-effects → lifecycle/evidence/dispute/recovery have NO settlement path (verified).

## 6. MCP tool inventory (25)

Production (13): get_protocol_info, get_routing_fee, ping, route_request, get_commitment,
list_capabilities, list_commitments, get_commitment_status, create_commitment,
get_evidence_verification, get_authority_validation, prepare_commitment, accept_commitment.
Lifecycle/evidence/dispute (12): get_commitment_history, get_recovery_status, get_pending_actions,
resume_commitment, cancel_commitment, close_commitment, submit_evidence, list_evidence,
verify_evidence, raise_dispute, resolve_dispute, list_disputes.

## 7. Lifecycle state machine

17 states, 39 transition edges (canonical spec `spec/lifecycle.md` §2, mirrored exactly in the
`transition_commitment` RPC and the MCP helper). Terminal: finalized, cancelled, expired, failed.
Financial transitions (settled, release, refund) are NOT exposed via MCP.

## 8. Authorization model

- Caller presents an EIP-712 signed action proof (domain `SAAX Authority` v1).
- Recovered signer = verifiedPrincipal (sole accepted identity; caller-supplied agentId/role are never authority).
- Durable `agent_authorizations` row must bind (agent, principal, commitment, role, scope, expiry, revoked_at).
- Replacement agents NEVER inherit; each needs its own row.
- Revocation/expiry checked in-transaction (FOR UPDATE).

## 9. Operator credential design

- `operator_secrets.secret_hash` = sha256(operator token), SELECT-only for service_role.
- Plaintext token only in operator's mode-600 env file (gitignored).
- `provision_authority` compares hash; cleared hash → fail-closed (AUTH_OPERATOR_TOKEN_INVALID).
- Gate H runner `scripts/operator-manage.cjs` implements bootstrap/rotate/revoke/recover/status.
- Additive migration candidate adds created_at/revoked_at (NOT applied to prod).

## 10. Evidence verification architecture

- Envelope structure + schema version + commitment/acceptance-criteria binding + integrity hash.
- EIP-712 for wallet-owned proofs; COSE/JWS via `cose-jws-verifier.js` (issuer→key resolver, allowlist).
- `verify_evidence` requires evaluator authz; a submitter can never self-declare verified.
- Verification outcomes persisted durably with verifier identity + policy version.

## 11. COSE/JWS trust policies

- JWS: ES256/EdDSA allowlist via `jose`; COSE_Sign1: P-256/Ed25519 via cbor+node:crypto.
- Issuer→key resolver (trusted keys from `SAAX_COSE_JWS_TRUSTED_KEYS_B64`, fail-closed unset).
- Structural-only evidence NEVER marked verified (E4 boundary fixed).
- Test key isolated (rejected unless explicit test policy).

## 12. EAS integration boundaries

- Simulated/testnet-only anchoring; deterministic event hash; no-false-anchor policy.
- Production EAS signing requires separate owner approval + custody decision + independent review.
- DB journal remains authoritative; EAS is tamper-evidence, not operational truth.

## 13. Dispute governance

- raise_dispute / resolve_dispute / list_disputes; initiator + evaluator authz required.
- Evaluator decision → nonfinancial lifecycle outcome only; NO settlement/escrow/refund trigger.

## 14. Independent-agent recovery

- Agent C (replacement) authenticates independently, proves its own registry row, retrieves
  history/recovery status, resumes only permitted actions. No automatic inheritance.

## 15. Idempotency & durability

- Durable idempotency store (Supabase in prod; file-backed fallback) — 19/19 suite.
- Reconcile-before-respond (7/7); stale pending → failed (mock) / unresolved (self).
- SELF mode fails closed (503) when durable store unavailable.

## 16. Financial isolation

- Lifecycle/evidence/dispute/recovery modules contain NO settlement, escrow, refund, or wallet paths.
- Pilot enforcement OFF, telemetry OFF, scheduler E-STOPPED, mainnet escrow/EAS inactive.
- `payment_reservations`/`pilot_wallets` 0; escrows 2 (existing).

## 17. Database permissions & RLS

- RLS enabled on all ax_router tables (deny-all for anon/authenticated).
- service_role: SELECT-only on tables, EXECUTE-only on SECURITY DEFINER RPCs.
- No INSERT/UPDATE/DELETE grants to any role except owner on lifecycle/evidence/dispute tables.
- Migration chain P1→P3→P4→G1 applied (Stage D); operator audit columns migration candidate only.

## 18. Abuse protections

- Distributed rate limiting: scopes ip/principal/op/auth_fail, shared Supabase store.
- Sensitive ops fail CLOSED (503) during store outage; discovery reads fail-open with memory fallback.
- Auth-abuse: per-source failed-auth accumulation, bounded exponential backoff, anti-lockout.
- 256KiB body bound, 64KiB evidence payload bound.

## 19. Regression & conformance evidence

- Protocol conformance: 94/94.
- Reliability suites: lifecycle 25/25, agent harness 35/35, principal-binding 18/18, MCP recovery 12/12,
  evidence lifecycle 21/21, evidence verification 19/19, evidence recovery 13/13, EAS 14/14,
  dispute 22/22 + 15/15, COSE/JWS 14/14, authority domain 11/11, operator provisioning 14/14,
  abuse guard 10/10, endpoint abuse 8/8, migration round-trip 13/13, pilot default-off 12/12,
  durable idempotency 19/19, reconcile-restart 7/7, settle 13/13, phase2-smoke OK.
- Total across gates: 436/436 (Gate G) + Gate G.1 suites + Stage F live evidence.

## 20. Known limitations & unresolved findings

1. EAS production signing requires custody decision + owner approval (not implemented).
2. `chainId` not bound in EIP-712 domains (pre-condition for chain-specific proofs; v1 compatibility).
3. `operator_secrets` lacks audit columns in production (candidate migration, not applied).
4. `test-payment-idempotency-restart.cjs` excluded (proof harness; guarantees satisfied by durable store — documented).
5. Plain-GET MCP discovery still lists the pre-lifecycle subset (F-M1; JSON-RPC tools/list is correct 25).
6. No rate-limit bypass/abuse under sustained attacker load was live-tested (isolated only).
7. Internal review ≠ independent audit.

## 21. Deployment & rollback procedures

- Deployment: `vercel deploy --skip-domain` (no alias promotion) → validate candidate → explicit alias set.
- Rollback target: `ax-router-30rf9r5q2` (previous production).
- Database: additive migrations only; no destructive rollback of lifecycle/evidence tables.
- Forward-recovery: reconcile-before-respond; unknown outcomes left unresolved, never auto-replayed.

## 22. Proposed assessment scope & acceptance criteria

Suggested review scope (application security, DB/RPC authorization, cryptography, evidence
integrity, dispute governance, recovery/concurrency, EAS custody, operations):
1. MCP endpoint security (T1) — auth bypass, payload abuse, session handling.
2. Authorization chain (T2/T3) — EIP-712 recovery, registry binding, revocation/expiry.
3. SECURITY DEFINER RPCs — search_path, injection, privilege escalation, direct-invocation bypass.
4. Cryptographic verification — COSE/JWS allowlist, key resolution, algorithm confusion.
5. Evidence integrity — binding, immutability, verification attribution, replay.
6. Dispute governance — evaluator authz, decision binding, financial isolation.
7. Recovery — replacement-agent authz, no inheritance, idempotent continuation.
8. Abuse controls — rate-limit enforcement, fail-closed behavior, lockout.
9. Migration/RBAC — grants matrix, RLS, least-privilege.
10. EAS custody design (not production) — signer governance, no-false-anchor.

Acceptance: all Critical/High findings resolved + independently retested; Medium documented with
owner risk acceptance; no unresolved financial-integrity or auth-bypass defect.

## Audit-readiness confirmation

- Source hashes recorded (b20406b2, migration SHAs in Stage D record).
- Reproducible install: `npm ci` (799 pkgs, 0 errors); testbed via `docker exec ax_router_db psql`.
- All evidence paths listed; no secrets in this package.
- **Independent Third-Party Security Validation: PENDING RELEASE REQUIREMENT — not yet assessed.**
