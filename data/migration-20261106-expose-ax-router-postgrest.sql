-- SAAX /receipt reliability fix (2026-11-06)
-- ===========================================
-- Defect reproduced live: GET /receipt returned HTTP 500
--   {"error":"store lookup failed","reason":"Invalid schema: ax_router"}
-- for BOTH known and unknown well-formed txHash values (invalid/missing
-- txHash correctly returned 400). The ax_router schema existed with the
-- lookup_receipt_by_txhash RPC and correct grants; PostgREST refused it
-- because the authenticator role's pgrst.db_schemas was
-- 'public, vv_survey' -- ax_router was NOT exposed to PostgREST.
--
-- Root cause: PostgREST schema exposure (config), not the application query,
-- not the table, not the RPC, not grants. The endpoint code was correct; the
-- deployed PostgREST configuration had lost the ax_router exposure.
--
-- Fix (this migration, additive):
--   1. alter role authenticator set pgrst.db_schemas = 'public, vv_survey, ax_router';
--   2. notify pgrst, 'reload config';   -- apply the new schema list
--   3. notify pgrst, 'reload schema';   -- rebuild the schema cache so the
--                                         RPC is discoverable
-- Preserves the pre-existing public and vv_survey schemas. No tables, RPCs,
-- grants, RLS policies, or data were changed.
--
-- Rollback:
--   alter role authenticator set pgrst.db_schemas = 'public, vv_survey';
--   notify pgrst, 'reload config';
--   notify pgrst, 'reload schema';
--
-- Live verification after fix (2026-11-06):
--   GET https://saax-protocol.com/receipt?txHash=0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb&rail=x402
--     -> HTTP 200, commitment_id saax_e8c3107513646a58, amount "0.05 USDC"
--   unknown well-formed txHash -> HTTP 404 {error:"not found", ...}
--   invalid txHash / missing    -> HTTP 400 {error:"invalid txHash", ...}

alter role authenticator set pgrst.db_schemas = 'public, vv_survey, ax_router';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
