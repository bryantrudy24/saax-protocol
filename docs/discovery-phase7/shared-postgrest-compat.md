# SAAX — Shared PostgREST Configuration Compatibility Check (read-only)

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **HEAD:** `7d934f15` (verified) · **Supabase project:** `codboejrwohkjidrrcgl`

Scope: this is a **read-only, narrowly scoped** verification that the prior PostgREST
schema-exposure migration (applied for the SAAX `/receipt` fix) did not disturb the
shared `vv_survey` (Victoria's Vision survey) service. **No survey submissions were
created and no participant/response data was retrieved.** The `vv_survey` service was
not modified, restarted, or reconfigured. No participant-identifying content is
recorded here.

## 1. What was checked (all read-only)

| # | Check | Query / source | Result |
|---|---|---|---|
| 1 | Authenticator `pgrst.db_schemas` effective configuration | `SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('authenticator','anon','authenticated','service_role')` | `authenticator` rolconfig includes `pgrst.db_schemas=public, vv_survey, ax_router` — **exactly the three intended schemas**, additive to the prior `public, vv_survey` state. |
| 2 | All three schemas exist | `SELECT nspname, nspowner::regrole FROM pg_namespace WHERE nspname IN ('public','vv_survey','ax_router')` | `public`, `vv_survey`, `ax_router` all present. Owners: `pg_database_owner`, `postgres`, `postgres`. |
| 3 | `vv_survey` usage grant preserved | `pg_namespace.nspacl` | `vv_survey=postgres=UC/postgres, anon=U, authenticated=U, service_role=U, vv_survey_runtime=U/postgres` — the dedicated `vv_survey_runtime` usage is intact. |
| 4 | `vv_survey` RLS posture unchanged | `pg_class.relrowsecurity/relforcerowsecurity` where nspname='vv_survey' | Sensitive tables have RLS **enabled and forced**: `participants`, `responses`, `sessions`, `attempts`, `audit`, `research_answers` (RLS on; force on for participants/responses/sessions/attempts/audit). No weakening observed. |
| 5 | No direct anon/authenticated table grants in `vv_survey` | `information_schema.role_table_grants` for anon/authenticated | **Empty set** — no anonymous/authenticated direct table access; access is via the security-definer functions and `vv_survey_runtime`. |
| 6 | `vv_survey` function grants unchanged | `pg_proc.proacl` for vv_survey functions | `start_survey`, `submit_survey`, `admin_*` — EXECUTE granted to anon/authenticated/service_role (unchanged, expected for the survey's public intake); `valid_answers` EXECUTE to `vv_survey_runtime` only. No principal lost access. |
| 7 | `ax_router` read RPC grants unchanged (the receipt fix boundary) | `pg_proc.proacl` for `lookup_receipt_by_txhash`, `upsert_commitment` | `lookup_receipt_by_txhash`: EXECUTE to authenticated + service_role only (**no anon**); `upsert_commitment`: anon EXECUTE (pre-existing, needed for the mainnet settlement webhook). The receipt-fix migration altered **schema exposure only**; it did not change grants/RLS. |
| 8 | SAAX `/receipt` bounded smoke (existing committed script) | `node scripts/_verify-receipt-live.mjs` | **10/10 PASS** (known txHash 200 → commitment `saax_e8c3107513646a58`; unknown 404; invalid/missing 400). Matches the post-fix behavior already recorded; no regression. |

## 2. Comparison with expected behavior

- Expected: `public`, `vv_survey`, `ax_router` exposed to PostgREST; `vv_survey` grants
  and RLS exactly as before; `ax_router` read RPCs not anon-executable.
- Actual: matches all four expectations. The migration is **config-additive** (one role
  setting + two reload notifies) and its rollback is documented in
  `data/migration-20261106-expose-ax-router-postgrest.sql` (restores
  `pgrst.db_schemas = 'public, vv_survey'`).

## 3. What was NOT checked (limits)

- **No participant/response data** was read (neither raw rows nor aggregates that
  could identify individuals). The survey's functional behaviour (submit/serve)
  was not exercised — doing so would create submissions.
- No cross-service load/response-time comparison was performed; the migration does
  not alter query plans or timeouts (authenticator `statement_timeout=8s`,
  `lock_timeout=8s` are unchanged).
- `vv_survey` **application-level** behaviour (its hosting, env, edge functions) was
  not restarted or touched; only the shared Postgres/PostgREST configuration was
  inspected.
- The PostgREST **schema cache** reload was already applied by the migration on
  2026-11-06; this check confirms the persisted role configuration, not a new reload.

## 4. Conclusion (bounded)

The shared PostgREST change is **compatible with the configured state**: the three
schemas remain exposed as intended, `vv_survey` RLS and grants are unchanged, and the
survey service's schema/function permissions are intact. This is a *configuration
and permission* finding; it is **not** a claim of zero behavioural impact on the
survey service's runtime, which was not exercised.

**Files:** this report; evidence `evidence/discovery-phase7/live-bounds-evidence.json`
(nonfinancial live probe). Supabase project `codboejrwohkjidrrcgl`.
