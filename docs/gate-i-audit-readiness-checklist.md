# SAAX Gate I — Independent Security Audit Readiness Checklist

**Status:** PENDING RELEASE REQUIREMENT — independent third-party security validation has not been performed. Internal testing is not an independent audit.

Companion to the Gate H auditor handoff: `docs/gate-h-audit-package.md`. This checklist verifies the package covers the required components and records the owner decision points required before engaging an assessor.

---

## 1. Required package components (verified against the Gate H package + this repo)

| Component | Location | Present |
|---|---|---|
| Architecture overview | `docs/gate-h-audit-package.md` §3 | ✅ |
| Trust-boundary diagrams | Gate H package | ✅ (T1–T5) |
| Threat model | Gate H package | ✅ |
| Authorization model | Gate H package + `spec/`, `endpoint/lifecycle.js` | ✅ |
| Custody model | `endpoint/escrow*.js`, Gate H package | ✅ |
| Smart-contract inventory | `contracts/` + Gate H package | ✅ |
| Cryptographic verification design | `endpoint/cose-jws-verifier.js`, `endpoint/evidence-verification.js`, `spec/` | ✅ |
| Database migration history | `data/migration-*.sql`, `docs/stage-d-production-migration-record.md` | ✅ |
| Incident / recovery procedures | `docs/gate-h-operator-runbook.md`, Stage E runbook | ✅ |
| Test evidence | `tests/reliability/` (25+ suites), conformance 94/94 | ✅ |
| Known unresolved issues | Gate H package (residual risks R1–R10), Gate I final report | ✅ |
| Deployment configuration | Vercel deployment records, `.env.example` | ✅ |
| Scope exclusions | Gate H package | ✅ |

## 2. Reviewer reproduction instructions (added in Gate I)

A reviewer must be able to build and test the system from source without Lucius's explanations:

```bash
git clone https://github.com/bryantrudy24/saax-protocol
cd saax-protocol
npm install
npm test                    # offline suites (conformance 94/94, evidence 19/19)
npm run test:infra -- --run # infra suites (Docker PostgREST testbed)
node examples/authorization-boundary/run.cjs
```

The Gate I release candidate (`feature/saax-gate-i`, `8fdc1471`) adds the developer quickstart, three starter examples, and a repaired `npm test` — making the package self-contained for a reviewer.

## 3. Candidate audit scopes

1. **Commitment lifecycle and authorization** — state machine, EIP-712 principal binding, durable `agent_authorizations`, revocation/expiry, idempotency fingerprinting.
2. **MCP security** — 25-tool surface, session transport, proof verification, abuse controls (distributed rate limiting, fail-closed crypto ops), discovery consistency.
3. **Cryptographic verification** — EIP-712 / COSE / JWS verifiers, issuer/key trust policies, algorithm allowlists, test-key isolation.
4. **Escrow custody contracts** — `contracts/` custody V1/V3, testnet-only deployment, financial isolation.
5. **Database and operational security** — SECURITY DEFINER RPC inventory, least-privilege grants, RLS, migration chain P1→P3→P4→G1, operator management (`docs/gate-h-operator-runbook.md`).

## 4. Suggested engagement sequence

1. Application/protocol security review (scopes 1–3) — highest priority.
2. Database/RPC authorization review (scope 5).
3. Custody/smart-contract review (scope 4) — required before any mainnet custody consideration.

## 5. Owner decisions required (no audit can be engaged without these)

- [ ] Choose auditor (application security firm with MCP/protocol experience).
- [ ] Approve scope and fee.
- [ ] Provide frozen release artifact (Gate G.1 `184439b1` + Gate I `8fdc1471`).
- [ ] Approve findings-disclosure policy.

**Costs require explicit owner approval. No auditor has been engaged. No certification claimed.**
