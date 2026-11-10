# SAAX — Separate Application / Database / Configuration Rollback

**Date:** 2026-11-06 · **Applies to:** the public nonfinancial Discovery surface
(`saax-protocol.com`) and its shared Supabase backend (`codboejrwohkjidrrcgl`).

Three independent rollback scopes. **They are not interchangeable.** Rolling back the
application does not undo a database migration; rolling back the database schema
exposure does not restore an application version. Do each one only for its own
purpose.

Also: **restoring the former PostgREST configuration (dropping `ax_router` from
`pgrst.db_schemas`) would reintroduce the `/receipt` store-schema 500** unless a
different compatible remedy (e.g. a whitelist route or separate API user) is applied
first. That regression is the reason the exposure was added; treat reversion as a
deliberate, documented trade-off.

---

## 1. Vercel rollback — application/content deployment

**What it is:** replaces the deployed serverless functions and static content with
those of an earlier deployment. Does NOT change environment variables, the database,
or the PostgREST config.

**Identity (current production):**
- Deployment: `https://ax-router-apizzisdi-bryant-s-projects5.vercel.app` (alias
  `https://saax-protocol.com`, current source `1f87f307` receipt-fix deploy as
  promoted in the 2026-11-06 release).
- Rollback target (previous production): `https://ax-router-k2tlim371-bryant-s-projects5.vercel.app`
  (Ready, pre-`1f87f307`).

**Command (authorized SAAX workflow):**
```
vercel promote https://ax-router-k2tlim371-bryant-s-projects5.vercel.app --scope bryant-s-projects5
```
or redeploy the prior commit:
```
vercel deploy --prod --yes   # from a clean checkout of the prior commit
```
**After rollback:** re-run `scripts/_verify-receipt-live.mjs`; note that if the
rolled-back deployment predates the `/receipt` fix, the store-schema 500 will return
(the rollback target above is the pre-fix build — see §2 before promoting it for a
receipt issue).

## 2. PostgREST rollback — schema-exposure configuration and reload

**What it is:** changes which schemas the PostgREST authenticator exposes and
reloads the PostgREST schema cache. Does NOT change application code, tables, RPCs,
grants, or RLS policies.

**Migration identity:** `data/migration-20261106-expose-ax-router-postgrest.sql`
(applied live 2026-11-06; the only PostgREST setting it changed is
`authenticator.pgrst.db_schemas`).

**Rollback SQL (documented in the migration file):**
```sql
alter role authenticator set pgrst.db_schemas = 'public, vv_survey';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
```
**Guardrail:** this restores the pre-fix exposure and **reintroduces the `/receipt`
500**. Only do it if (a) the `ax_router` exposure itself is the problem, and (b) a
compatible replacement (e.g. a dedicated Postgres role + connection string for the
receipt RPC, or a route-level whitelist) is staged. Preserve `vv_survey` and `public`
in whatever the replacement value is; never expose more than the needed schemas.

**Verification after any PostgREST change (read-only):**
```
SELECT rolname, rolconfig FROM pg_roles WHERE rolname='authenticator';
-- expect pgrst.db_schemas to equal exactly the intended list
```

## 3. Key / buyer-registry configuration changes — separate operational state

**What it is:** the Vercel environment variables that hold signing keys and the buyer
registry (`SAAX_OPERATOR_PRIVATE_JWK`, `SAAX_BUYER_REGISTRY_JSON`,
`SAAX_SIGNED_PROFILE_JSON` if set). These are **operational state**, not releases:
changing them does not roll back code or schema.

**How to change (authorized workflow):**
```
vercel env rm SAAX_BUYER_REGISTRY_JSON production
vercel env add SAAX_BUYER_REGISTRY_JSON production   # paste the JSON; value never printed
vercel deploy --prod --yes
```
**Never print the values.** Presence check only:
```
vercel env ls production | findstr /i SAAX_BUYER_REGISTRY SAAX_OPERATOR
```
**Rollback of a registry change:** restore the previous registry JSON (from the
operator's stored backup or the last known-good committed example — never from a log)
and redeploy. A registry change does not alter the database or prior
commitments; it only affects which buyer keys the acceptance endpoint accepts.

## 4. Preservation rules

- These instructions are documented; **no rollback was executed** as part of this task.
- Unrelated exposed schemas (`public`, `vv_survey`) must be preserved in any
  documented replacement value.
- Release/migration identities above are the exact values to record in any incident
  post-mortem.
- Secret-safe verification commands: `vercel env ls production` (names only),
  `git diff` for committed files only, `SELECT ... FROM pg_roles` (no data).
