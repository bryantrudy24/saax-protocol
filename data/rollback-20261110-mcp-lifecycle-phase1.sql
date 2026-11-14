-- SAAX Protocol — MCP Lifecycle Phase 1: documented ROLLBACK (v2)
--
-- ISOLATED / NOT APPLIED TO PRODUCTION unless separately approved.
--
-- Reverses data/migration-20261110-mcp-lifecycle-phase1.sql (v2).
--
-- IMPORTANT (forward-recovery note):
--   * If commitment_events / authorization_events have accrued rows at
--     rollback time, dropping the tables destroys the audit evidence.
--     The preferred forward path is: REVOKE EXECUTE on the RPCs to halt new
--     transitions/grants, reconcile states, and only then drop.
--   * This script documents BOTH paths. Run inside a transaction.
--
-- ORDER MATTERS:
--   1. Drop the functions first (they depend on the tables).
--   2. Drop child tables (commitment_events FK -> commitments).
--   3. Drop the registry + audit table.
--   4. Drop the version column from commitments (additive column; dropping it
--      restores the pre-migration shape).

BEGIN;

-- Halt new transitions/grants/revokes (safe to run even if tables exist).
REVOKE ALL ON FUNCTION ax_router.transition_commitment(text,text,text,text,text,text,text,text,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.grant_agent_authorization(text,text,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.revoke_agent_authorization(text,text,text,text,text,text) FROM PUBLIC;

DROP FUNCTION IF EXISTS ax_router.transition_commitment(text,text,text,text,text,text,text,text,text,text,integer);
DROP FUNCTION IF EXISTS ax_router.grant_agent_authorization(text,text,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text);
DROP FUNCTION IF EXISTS ax_router.revoke_agent_authorization(text,text,text,text,text,text);

DROP TABLE IF EXISTS ax_router.commitment_events;
DROP TABLE IF EXISTS ax_router.authorization_events;
DROP TABLE IF EXISTS ax_router.agent_authorizations;

ALTER TABLE ax_router.commitments DROP COLUMN IF EXISTS version;

COMMIT;