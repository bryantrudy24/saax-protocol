-- SAAX Gate H — additive operator_secrets audit columns (CANDIDATE — NOT APPLIED)
-- Adds created_at / revoked_at so operator-secret lifecycle is auditable.
-- Purely additive: no data rewrite, no table rewrite, no dependency change.
-- Requires separate owner approval before any production application.
-- Safe to run on the testbed for validation.

ALTER TABLE ax_router.operator_secrets
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

COMMENT ON COLUMN ax_router.operator_secrets.created_at IS 'When this operator-secret row was first created.';
COMMENT ON COLUMN ax_router.operator_secrets.revoked_at IS 'When the operator secret was revoked (cleared). NULL = active.';

-- Backfill created_at from the row update time for pre-existing rows (no data loss).
UPDATE ax_router.operator_secrets
   SET created_at = updated_at
 WHERE created_at IS NULL;

-- Revocation remains expressed by clearing secret_hash (fail-closed) AND now recorded.
