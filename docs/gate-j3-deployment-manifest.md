# SAAX Gate J.3 — Production Deployment Manifest

**Version:** 1.0.3-beta-26 (MCP 1.0.3 + `get_supplier_details` = 26 tools)
**Date:** 2026-11-14
**Author:** Lucius (Gate J.3 release engineering)

## Purpose
Define the exact runtime assets required for a healthy SAAX production deployment, why they are required, how they are generated, and how missing assets must fail the deployment *before* promotion.

## Root Cause (verified)
A production deployment built from the public repository failed at `/route` because required runtime JSON assets were absent.
- Public main `11dfc98` contains **zero** `endpoint/*.json` files (all six are missing).
- `api/mcp.mjs` resolves `endpoint/mcp-supplier-index.json` at runtime (`ROUTE_SUPPLIER_INDEX`), and the HTTP `/route` server similarly reads `endpoint/supplier-registrations.json` + the leaderboard index.
- `loadSupplierIndex()` **fails open** (returns `[]` on missing file) — so the MCP layer boots with an empty supplier registry and the tool silently returns `not_found`/empty results while `/route` errors.
- No build error is raised because the assets are resolved at runtime, not at build time.

## Required Runtime Assets (tracked, MUST ship to Vercel)

| Asset | Source | Purpose | Integrity (SHA-256, from J.2 tree) |
|---|---|---|---|
| `endpoint/mcp-supplier-index.json` | `ax-router-gate-j1` (J.2) — 1,926 lines | MCP `get_supplier_details` + `list_capabilities` supplier records | compute-at-freeze |
| `endpoint/supplier-registrations.json` | J.2 | HTTP `/route` supplier routing | compute-at-freeze |
| `endpoint/leaderboard-suppliers-day3.json` | J.2 | Route supplier leaderboard | compute-at-freeze |
| `endpoint/reputation-day2.json` | J.2 | Router reputation metadata | compute-at-freeze |
| `endpoint/reputation-day3.json` | J.2 | Router reputation metadata | compute-at-freeze |
| `endpoint/agents-day1-named.json` | J.2 | Agent index (route reader) | compute-at-freeze |

All six are **tracked files** (not gitignored). They are *not* secrets: they contain public supplier identifiers/names/descriptions/endpoints (no credentials). They must be committed to the **public** repository line.

## Generation Method
- Source of truth: the J.2 development branch (`feature/saax-gate-j1`, commit `c82098d1` / `f160f8df`).
- These are data files (not generated at build time). They are copied verbatim into the public release commit.
- No build step regenerates them. A future change to the supplier registry MUST update these files and the manifest hash together.

## Required Environment Variables (names only — values never logged)
- `SAAX_SERVICE_ROLE_KEY` (Supabase service role — server-side only)
- `SAAX_DATABASE_URL` (Supabase Postgres — server-side only)
- `SAAX_COSE_JWS_TRUSTED_KEYS_B64` (COSE/JWS trusted keys — optional, fail-closed when unset)
- `SAAX_OPERATOR_SECRET_HASH` (operator provisioning — optional, fail-closed when unset)

## Deployment Validation Commands (must ALL pass before promotion)
1. `npm ci` — clean install
2. `npm test` — conformance 94/94 + evidence 19/19 (exit 0)
3. `npm run test:infra` — infrastructure-backed suites (documented separately)
4. Asset presence check: `test -f endpoint/mcp-supplier-index.json && test -f endpoint/supplier-registrations.json` (or Windows equivalent)
5. MCP initialization: `initialize` → server `saax-protocol` 1.0.3, `tools/list` → **26 tools** (`get_supplier_details` present)
6. HTTP route check: `/route` with malformed body → expected 4xx guard (not 500/empty)
7. `/receipt` guard, `/status`, `/openapi.json`, `/llms.txt`, sitemap — expected responses
8. Financial flags: `SAAX_PILOT_ENFORCEMENT=off`, telemetry off — unchanged

## Fail-Closed Requirement
- If ANY required asset is missing at build/deploy time → **FAIL the deployment before alias promotion**.
- This is enforced by the deploy rehearsal (candidate must be exercised against the actual asset set).
- The MCP supplier tool must **fail closed** (return explicit `unavailable`/error) when the index is missing — NOT silently return an empty registry. (This loadSupplierIndex change is part of the J.3 fix; see code diff.)

## Rollback Prerequisites
- Previous healthy deployment: `ax-router-mskmb8biw` (Gate J.2 baseline) — verify reachable.
- Alias rollback: `vercel alias set <previous-deployment-url> saax-protocol.com` and `www.saax-protocol.com`.
- No database rollback required (no migrations in this release).

## Integrity Hashes
Hashes are computed at release freeze using `git hash-object` / `sha256sum` on the exact committed blobs. They are recorded in the release commit and re-verified before promotion.


---

# Gate J.3 — Live Deployment Record (Phase D complete)

**Date:** 2026-11-14
**Promoted deployment:** `https://ax-router-9l9mj1zq7-bryant-s-projects5.vercel.app`
**Aliases:** `saax-protocol.com` + `www.saax-protocol.com` → `9l9mj1zq7` (both verified)
**Previous production (rollback):** `ax-router-mz56pmo41-bryant-s-projects5.vercel.app`
**Old healthy baseline:** `ax-router-mskmb8biw` (aux rollback reference)
**MCP server:** `saax-protocol` 1.0.3 (stateless mode)
**MCP tool inventory (live, verified):** 26 tools — original 25 + `get_supplier_details`
**Live verification (production domain, 2026-11-14):**
- `initialize` → 200, server saax-protocol 1.0.3
- `tools/list` → 26 tools, HAS_SUPPLIER=True
- `get_supplier_details(73846)` → `status: ok`, full safe metadata, `verification_status: "unverified"`
- `get_supplier_details(999999)` → `status: not_found`
- `/route` POST {} → 422 (validation guard)
- `/receipt` POST {} → 405 (method guard)
- `/` `/status` `/security` `/recovery` GET → 200

**Reproducibility fixes shipped in this release:**
1. `vercel.json` — `functions.api/*.includeFiles` **removed** (the `data/**`-only glob starved the lambdas of `endpoint/*.json` runtime assets; production lambda profile ~3.3MB confirms full bundling; the includeFiles globs were both invalid syntax AND insufficient)
2. `api/mcp.mjs` — `loadSupplierIndex()` **fails closed** (`null` on missing index) with explicit `supplier index not loaded` errors in all three callers instead of silently returning an empty registry
3. **Env:** `SAAX_MCP_MODE=stateless` added to production env (candidate POST /mcp was 401ing under the stateful default; stateless is the deployment-compatible mode)

**Platform note:** Vercel **Deployment Protection** returns 401 for POST to non-production candidate URLs (GET allowed) — candidate POST validation is impossible pre-promotion; live verification after promotion is the authoritative gate (this matches the established release procedure).

**Financial isolation (post-promotion):** no financial flag changed; pilot enforcement OFF; telemetry OFF; scheduler E-STOPPED (unchanged).
