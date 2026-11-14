-- SAAX Protocol — MCP Lifecycle Phase 4: Rollback
-- Isolated testbed only. NOT for production.
--
-- Rollback policy:
--   - Drops the three dispute RPCs and the commitment_disputes table.
--   - Drops the evidence verification-attribution columns.
--   - Durable dispute records ARE deleted by table drop. Per the Phase 1/3
--     forward-recovery principle, the OPERATOR must export
--     ax_router.commitment_disputes (and any evidence verification columns)
--     BEFORE running this rollback if those records may be needed as evidence.
--   - The lifecycle events journal (commitment_events) is NOT touched: dispute
--     transitions recorded there remain as the authoritative audit trail.
--
-- Forward recovery: because commitment_events preserves every dispute-related
-- transition, re-applying the Phase 4 migration restores full dispute function
-- without losing the audit history.

BEGIN;

DROP FUNCTION IF EXISTS ax_router.raise_dispute(text,text,text,text,text,jsonb,text);
DROP FUNCTION IF EXISTS ax_router.resolve_dispute(text,text,text,text,text,text);
DROP FUNCTION IF EXISTS ax_router.list_disputes(text,text,text,text,integer,integer);

DROP TABLE IF EXISTS ax_router.commitment_disputes;

ALTER TABLE ax_router.commitment_evidence
  DROP COLUMN IF EXISTS verification_policy_version,
  DROP COLUMN IF EXISTS verifier_identity,
  DROP COLUMN IF EXISTS verification_timestamp,
  DROP COLUMN IF EXISTS verification_policy;

NOTIFY pgrst, 'reload schema';
COMMIT;