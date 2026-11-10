# SAAX receipt reliability + payment availability checkpoint

Date: 2026-11-06. Continuing from `b7e838dd` (main). Targets the public `/receipt`
defect and the immediate-payment availability question. SAAX only; LUMIYOU,
Victoria's Vision, CreatorAgentX and iGen untouched; unrelated dirty working tree
preserved uncommitted.

## Objective
1. Reproduce the public `/receipt` store-schema 500 and fix it at the correct layer.
2. Establish the actual availability of immediate (x402) payments, per evidence level,
   without unauthorized spending.
3. Correct public status docs only as supported by verified evidence.
4. Prepare the external integration/pilot with only proven capabilities.

## Root cause (verified, not inferred)
- Live repro (2026-11-06): `GET /receipt?txHash=<known>` -> HTTP 500
  `{"error":"store lookup failed","reason":"Invalid schema: ax_router"}`; unknown
  well-formed txHash also 500; invalid/missing txHash -> 400 (handler OK).
- The `ax_router` schema, `lookup_receipt_by_txhash` RPC, and grants all existed.
  The authenticator role's `pgrst.db_schemas` was `'public, vv_survey'` — the
  `ax_router` schema was NOT exposed to PostgREST, so the schema-scoped client
  was refused. The endpoint code and DB grants were correct; the PostgREST
  configuration had lost the schema exposure.
- Fix: additive DB migration (`data/migration-20261106-expose-ax-router-postgrest.sql`):
  `alter role authenticator set pgrst.db_schemas = 'public, vv_survey, ax_router'` +
  `notify pgrst, 'reload config'` + `notify pgrst, 'reload schema'`. No app redeploy
  required (config-only). Rollback documented in the migration file.
- Post-fix live matrix: known txHash -> 200 `commitment_id saax_e8c3107513646a58`
  (the real 2026-10-13 Base-mainnet 0.05 USDC settlement); unknown -> 404
  `{"error":"not found"}`; invalid/missing -> 400 `{"error":"invalid txHash"}`.
- Grants re-verified: read RPCs anon-exec=false (service_role/authenticated only);
  `upsert_commitment` public-exec unchanged. Access posture unchanged.

## Payment availability (x402 immediate payments) — evidence levels
Production Vercel env (by name; values never read): `SAAX_X402_MODE`, `SAAX_X402_NETWORK`,
`SAAX_X402_ASSET`, `SAAX_X402_PAYTO`, `SAAX_SIGNER_PRIVATE_KEY`, `SAAX_SIGNER_ADDRESS`,
`SAAX_VAULT_ADDRESS`, `SAAX_SELLER_PRIVATE_KEY`, `SAAX_RPC_URL`, `SAAX_CHAIN_ID`,
`SAAX_OPERATOR_PRIVATE_JWK`, `SAAX_BUYER_REGISTRY_JSON`. **No `SAAX_X402_PRIVATE_KEY`.**

- `SAAX_X402_PRIVATE_KEY` gates ONLY the legacy `live` verification branch in
  `endpoint/x402.js` (Day-7-era `SAAX_X402_VERIFY_MODE=live`). Production runs
  self-hosted settlement (`SAAX_X402_MODE=self`), which broadcasts signed
  EIP-3009 via `SAAX_SIGNER_PRIVATE_KEY` (see `endpoint/gateway.js` settle path,
  day7-wallet-checklist.md §5 rollback table). The missing key is therefore a
  **local tooling / legacy-branch concern, NOT a production payment-backend
  dependency**. Production had a recorded real Base-mainnet self-mode settlement
  (2026-10-13, tx 0x49123f..., 0.05 USDC, commitment saax_e8c3107513646a58) —
  level: HISTORICAL SETTLEMENT DEMONSTRATED (chain + receipt). Not re-run in this
  task (no unauthorized spending). Current LIVE fresh-settlement status: NOT
  verified this task; no claim of a fresh end-to-end settlement today.

## Files touched (this task)
- `data/migration-20261106-expose-ax-router-postgrest.sql` (new; additive migration + rollback + live proof)
- `tests/receipt-reliability.test.mjs` (new; 6/6, handler-level, mock store)
- `scripts/_verify-receipt-live.cjs` -> `_verify-receipt-live.mjs` (live smoke; 10/10)
- `landing/status.md` / `landing/status.html` (removed stale "store-schema error" caveat; added verified live behavior)
- docs: this checkpoint + runbook note (`docs/discovery-phase6/technical-closeout.md` receipt line will be appended)

## Commands / results (all exit 0)
- `node --test tests/receipt-reliability.test.mjs` -> 6 pass, 0 fail
- `node scripts/_verify-receipt-live.mjs` -> ALL PASS (10/10)
- `node tests/discovery-phase2/run-phase2-tests.cjs` -> 26/26
- `node tests/discovery-phase3/run-phase3-tests.cjs` -> 68/68
- `node tests/discovery-phase4/run-phase4-tests.cjs` -> 67/67
- `node scripts/_check-discovery-schemas.cjs` -> 14/14

## Deployment (2026-11-06, after commit 1f87f307)
- Production deploy from a clean checkout of commit `1f87f307` via the established
  SAAX Vercel workflow: `vercel link --project ax-router --scope bryant-s-projects5`
  then `vercel deploy --prod --yes`.
- Deployment: `https://ax-router-apizzisdi-bryant-s-projects5.vercel.app`
  (Ready 38s), aliased to `https://saax-protocol.com` (and www).
- Live verification after alias:
  - `GET /status` no longer contains the stale "store-schema error" caveat; it now
    states `GET /receipt?txHash=...` resolves a settled txHash to its commitment,
    verified live on 2026-11-06.
  - `GET /receipt?txHash=0x49123f...` -> HTTP 200, commitment
    `saax_e8c3107513646a58`, amount `0.05 USDC`.
  - `POST /mcp` -> 406 (expected for unframed POST; MCP requires JSON-RPC framing —
    HTTP 200 alone was never the MCP proof).
- Rollback target (previous production): `https://ax-router-k2tlim371-bryant-s-projects5.vercel.app`
  (Ready, pre-1f87f307). Rollback = `vercel promote` that deployment or redeploy
  the prior commit.

## Pilot package (2026-11-06)
- Added `pilot/pilot-client-example.mjs` — runnable reference client for an authorized
  external testnet pilot: fetches + (optionally) verifies the signed profile,
  prepares a proposal from the profile's declared supported combination,
  signs a buyer acceptance (acceptance-v1 EdDSA), calls accept-commitment, and
  demonstrates the receipt contract. NEVER moves funds.
- Verified live against https://saax-protocol.com:
  - profile fetch: OK (signed, self-declared, trust via --trust-jwk)
  - prepare-commitment: OK -> signed proposal `prop_90b10db098c74ca9`
    (saved `pilot/pilot-proposal.json`, no secrets)
  - accept-commitment with a THROWAWAY buyer key -> 401 DSC_UNAUTHORIZED
    "buyer not registered" — the intended authorization boundary (a real pilot
    participant must be onboarded, public key in SAAX_BUYER_REGISTRY_JSON).
- Pilot participation still requires explicit Commander authorization; no outreach.

## Next executable actions
1. Final report (receipt fix deployed + verified; x402 key question resolved; pilot
   example verified live).

## Authorization notes
- No mainnet spending, no new financial execution, no custody activation, no
  outreach. Pilot invitation requires the Commander's explicit authorization.
