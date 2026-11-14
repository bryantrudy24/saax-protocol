-- ===========================================================================
-- SAAX MCP Lifecycle Phase 3 — Rollback (evidence infrastructure)
-- Reverses migration-20261112-mcp-lifecycle-phase3-evidence.sql
--
-- IMPORTANT — forward-recovery note:
--   commitment_evidence rows are DURABLE evidence records. Dropping the table
--   destroys attributable submission history irreversibly. Prefer FORWARD
--   RECOVERY (keep the table, fix the defect, re-verify) over destructive
--   rollback whenever any evidence row exists. This script is intended for
--   (a) disposable testbeds, or (b) pre-data rollback during the isolated
--   development phase where NO real submissions exist.
--   If production evidence exists, DO NOT run this script; instead run a
--   corrective forward migration.
-- ===========================================================================
BEGIN;

DROP FUNCTION IF EXISTS ax_router.submit_evidence(text,text,text,text,jsonb,text,text);
DROP FUNCTION IF EXISTS ax_router.verify_evidence(text,text,text,text,text,integer);
DROP FUNCTION IF EXISTS ax_router.list_evidence(text,text,text,text,integer,integer);

DROP TABLE IF EXISTS ax_router.commitment_evidence;

COMMIT;