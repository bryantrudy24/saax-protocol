# SAAX Phase 7 — Shared-Config Safety + Onboarded-Buyer Flow: CHECKPOINT

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **Start HEAD:** `7d934f15` (verified; pushed, `origin/main` == HEAD) · **Supabase:** `codboejrwohkjidrrcgl` · **Vercel:** `ax-router` / `bryant-s-projects5` / `saax-protocol.com`

## Completed (with evidence)

1. **Shared PostgREST compatibility (read-only)** — `docs/discovery-phase7/shared-postgrest-compat.md`.
   Live config `pgrst.db_schemas=public, vv_survey, ax_router`; all three schemas
   exist; `vv_survey` RLS enabled+forced on sensitive tables; zero anon/authenticated
   table grants; function grants unchanged incl. `vv_survey_runtime`;
   `ax_router.lookup_receipt_by_txhash` is authenticated/service_role only (no anon).
   No participant data read, no submissions created, no survey service modification.
2. **Separate rollback documentation** — `docs/discovery-phase7/separate-rollback.md`.
   Vercel (app/content) vs PostgREST (schema exposure + reload) vs key/registry
   (operational env). States plainly that restoring the old PostgREST config
   reintroduces the `/receipt` 500. Exact identities: current prod deployment
   `ax-router-apizzisdi-…` (source `1f87f307`), rollback `ax-router-k2tlim371-…`,
   migration `data/migration-20261106-expose-ax-router-postgrest.sql`.
3. **Receipt smoke re-run** — `scripts/_verify-receipt-live.mjs` → **10/10 PASS**
   (known txHash 200 → `saax_e8c3107513646a58`; unknown 404; invalid/missing 400).
4. **Nonfinancial live bounds probe** — `scripts/_phase7-live-bounds.mjs` → **7/7 PASS**:
   profile fetch 200; declared signing key active/in-validity (`live-2026-11`); internal
   JWS validity under declared key (validity only, NOT trust); prepare-commitment 200 ok
   (proposal `prop_2de8a4d9fe937e78`); identical retry → duplicate, same proposalId;
   unregistered buyer → 401 `DSC_UNAUTHORIZED`. Evidence:
   `evidence/discovery-phase7/live-bounds-evidence.json`. No payment/custody/execution/release requested.
5. **Trust semantics documented (existing)** — `docs/discovery-phase4/trust-onboarding.md`:
   configured-key thumbprint only; key from the same profile never self-authenticates.

## Open dependency — exact (blocks steps 3–4 of the directive's flow)

- **No authorized buyer participant exists.** `SAAX_BUYER_REGISTRY_JSON` is set in
  production (presence verified; value never read) but contains NO buyer entry for
  the operator (nor any confirmed external participant). No instruction authorizing
  the owner to act as buyer was found in memory, repo, or session history; the
  pilot docs explicitly require the Commander to name the participant
  (`pilot/external-testnet-pilot-phase6.md`, `…-readiness-addendum.md`). A generated
  test wallet is not a participant; the 401 rejection is a successful boundary test,
  not a pilot.
- **Required input (smallest):** the Commander either (a) names an external buyer with
  a public signing key to onboard (registry + trust onboarding), or (b) explicitly
  authorizes the owner-operated pilot (owner signs as buyer with an operator-held
  key; result labeled `owner-operated pilot`, never external adoption). Also needed
  for (a): the intended scope (capability/currency/max amount).

## Next executable actions (after the dependency resolves)

1. Onboard buyer: add entry to `SAAX_BUYER_REGISTRY_JSON` (preserve existing entries;
   scope-bound; rollback = restore prior JSON) via `vercel env` + redeploy; verify
   with `vercel env ls production` (names only).
2. Run the full onboarded flow live: signed profile → preflight → acceptance →
   one commitment → export → independent verifier (separate process, no app DB);
   retry-identical → same operation; rejection cases (altered terms, expired
   acceptance, replay conflict, unregistered buyer 401).
3. Document the flow, retry behaviour, no-financial-effect evidence; commit/push.

## Constraints held

- No payments, escrow, execution, or release initiated (probe + this phase).
- LUMIYOU / Victoria's Vision untouched (only read-only inspection of shared
  Postgres config; no modification, restart, or reconfigure; no participant data).
- Unrelated dirty working tree preserved uncommitted.
