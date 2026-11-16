# SAAX Production Environment Reference

**Canonical internal reference for SAAX production infrastructure identity.**
Maintained per Gate J.16, Workstream A2. Historical records and prior-gate evidence
reports are NOT modified by this document's corrections.

---

## 1. Canonical Production Identity

| Item | Value | Notes |
|---|---|---|
| Production Supabase project ID | `codboejrwohkjidrrcgl` | **THE ONLY valid SAAX production Supabase project.** |
| Production schema | `ax_router` | All commitment/authorization/evidence tables + RPCs. |
| PostgREST base URL | `https://codboejrwohkjidrrcgl.supabase.co` | Trimmed; no trailing whitespace (Phase 6 finding). |
| Production MCP endpoint | `https://saax-protocol.com/mcp` | Streamable HTTP. |
| MCP tool inventory | 26 tools | Verified live, Gate J.15.2 / J.16. |
| Public repository | `https://github.com/bryantrudy24/saax-protocol` | remote `public`; internal dev repo is `origin` (solvent-applied-saax-protocol). |
| Website | `https://saax-protocol.com` (+ `www`) | Vercel project `ax-router-discovery` (production aliases). |
| RNWY listing | `bryantrudy24/saax-protocol` (https://rnwy.com/explorer/mcp/bryantrudy24/saax-protocol) | Claimed by @bryantrudy24. |

## 2. Related Projects That Are NOT SAAX Production

| Project ID | Owner label | Relationship |
|---|---|---|
| `nlmmrqgzintyynelyuep` | "bryantrudy24's safecity ai" | **SafeCity AI project — DIFFERENT project. NEVER use for SAAX operations.** Referenced in historical J.15 reports only (evidence). |
| `kndahofkhxpllmvnqlce` | "supabase-citron-envelope" | Unrelated/inactive project in the same Vercel org. |

## 3. Environment Names & Secrets Handling

- Runtime env vars used by the store layer (see `endpoint/store.js`):
  - `SUPABASE_URL` / `SAAX_SUPABASE_URL` — base URL, must resolve to project `codboejrwohkjidrrcgl`.
  - `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SAAX_SUPABASE_KEY` — keys.
  - `POSTGREST_URL` / `SAAX_POSTGREST_URL` — self-hosted PostgREST (preferred when set); also must reference the SAAX project/schema.
- **Never commit, print, log, or publish any credential value** (anon/service keys, connection strings with passwords).
- `.env*` files are gitignored; do not force-add them.
- Verify scripts must read credentials from the environment, never embed them.

## 4. Read-Only Verification Requirements

- All verification queries against production are **read-only (SELECT / count)**.
- Preferred surface: the StarNet Supabase connector (`list_projects` first confirms project identity,
  then read-only `execute_sql`/table listings against the confirmed project).
- **Fail-closed identity guard**: before ANY query, verify the resolved project reference resolves to
  `codboejrwohkjidrrcgl`; if it resolves to any other project (or is unset), abort with a clear error.
- Run `scripts/_verify_project_identity.mjs` (added Gate J.16) as the pre-query gate.

## 5. Production Deployment Restrictions

- **No deployment, promotion, alias change, DB migration, or DB write without explicit owner approval.**
- Isolated worktree mandatory for candidate work (see `release/gate-j16-developer-onboarding`).
- Preserve the current production deployment + rollback target:
  - Current promoted deployment (J.15): `ax-router-discovery-cnref9pei`
  - Rollback target (J.14): `ax-router-discovery-bhy2yjyqd`
- Financial enforcement OFF, telemetry OFF, scheduler E-STOPPED, mainnet escrow/EAS inactive,
  external pilot PAUSED, independent security assessment NOT STARTED.

## 6. Verification Checklist (every gate touching the DB)

1. `connectors.list` — Supabase connected (OAuth).
2. `mcp__supabase__list_projects` — confirm `codboejrwohkjidrrcgl` status ACTIVE_HEALTHY.
3. Run `scripts/_verify_project_identity.mjs` — identity guard PASS.
4. Execute read-only counts against `ax_router` tables.
5. Record counts; compare to baseline; explain discrepancies without modifying data.

---
*Gate J.16 · Maintained by the operator. Corrections to this document require evidence, not opinion.*
