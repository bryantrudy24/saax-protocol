-- SAAX Gate G.1 — Extend rate_limits.scope CHECK for the distributed MCP
-- abuse guard (mcp_ip / mcp_principal / mcp_op / mcp_auth_fail scopes).
--
-- Additive, non-destructive: no existing rows are rewritten; existing
-- 'ip'/'wallet' rows retain full validity. The new scopes are consumed only by
-- endpoint/abuse-guard.js (MCP endpoint rate limiting + auth-abuse protection).
-- Financial isolation is preserved: the financial pilot reservation counters
-- (payment_reservations, pilot-limits RPCs) are NOT touched by this migration.
--
-- Rollback: drop the new scopes from the CHECK (safe — no production rows use
-- them before the MCP gate is deployed; after deployment, forward-recovery is
-- preferred over destructive rollback per the release plan).

BEGIN;

ALTER TABLE ax_router.rate_limits
  DROP CONSTRAINT rate_limits_scope_check;

ALTER TABLE ax_router.rate_limits
  ADD CONSTRAINT rate_limits_scope_check CHECK (
    scope = ANY (ARRAY[
      'ip',
      'wallet',
      'mcp_ip',
      'mcp_principal',
      'mcp_op',
      'mcp_auth_fail'
    ])
  );

COMMIT;