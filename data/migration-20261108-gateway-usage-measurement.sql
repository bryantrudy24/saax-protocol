-- SAAX Protocol — usage-measurement telemetry (PREPARED, NOT APPLIED)
--
-- Purpose: give SAAX a durable, structured record of inbound gateway requests
-- (separate from commitment/payment records) so usage can be measured without
-- conflating website traffic, gateway hits, commitments, and payments.
--
-- DESIGN (per the usage-audit remediation brief):
--   * ADDITIVE ONLY: one new table + one view. No existing table, column,
--     grant, policy or function is altered.
--   * NO PERSON-IDENTIFYING DATA: we do NOT log IP addresses, user-agents,
--     cookies, authorization headers, or payment payloads. The only identity
--     dimension is an OPTIONAL authenticated client/agent identifier supplied
--     by the application (never derived from an IP).
--   * TELEMETRY CANNOT AFFECT FINANCIAL BEHAVIOR: this table is write-only
--     instrumentation. Nothing reads it during payment processing. A write
--     failure is swallowed by the application (never fail-closed on telemetry).
--   * RETENTION: rows are retained 90 days by default; a cron (not part of
--     this migration) may purge older rows. The view reports the window.
--   * ACCESS: service_role can INSERT + SELECT. No anon/authenticated access.
--     RLS enabled with no policies = deny-all for non-BYPASSRLS roles.
--
-- DO NOT APPLY TO PRODUCTION without separate approval. This file is a
-- reviewable artifact prepared for the deployment plan.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. gateway_requests — one row per inbound gateway HTTP request
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ax_router.gateway_requests (
  request_id        text        PRIMARY KEY,          -- correlation id (uuid)
  ts                timestamptz NOT NULL DEFAULT now(),
  environment       text        NOT NULL DEFAULT 'production'
                                  CHECK (environment IN ('production', 'preview', 'local', 'test')),
  endpoint          text        NOT NULL,             -- '/route' | '/mcp' | '/receipt' | '/status' | ...
  method            text        NOT NULL,             -- GET | POST | OPTIONS | ...
  status            integer,                          -- HTTP status (nullable: client disconnect)
  outcome           text        NOT NULL DEFAULT 'unknown'
                                  CHECK (outcome IN ('ok', 'error', 'timeout', 'client_disconnect', 'unknown')),
  duration_ms       integer,                          -- server-side handling time
  client_id         text,                             -- OPTIONAL authenticated agent/client id (never an IP)
  commitment_id     text,                             -- when the request maps to a commitment
  idempotency_key   text,                             -- when the request carried one
  tx_hash           text,                             -- settlement tx hash when known (mainnet/testnet)
  chain_id          integer,                          -- 8453 mainnet | 84532 sepolia | null unknown
  is_retry          boolean     NOT NULL DEFAULT false,
  is_synthetic      boolean     NOT NULL DEFAULT false, -- demo/fixture/test traffic
  error_code        text,                             -- machine-readable error code when applicable
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_requests_ts_idx
  ON ax_router.gateway_requests (ts DESC);
CREATE INDEX IF NOT EXISTS gateway_requests_endpoint_status_idx
  ON ax_router.gateway_requests (endpoint, status, ts DESC);
CREATE INDEX IF NOT EXISTS gateway_requests_client_idx
  ON ax_router.gateway_requests (client_id, ts DESC);
CREATE INDEX IF NOT EXISTS gateway_requests_commitment_idx
  ON ax_router.gateway_requests (commitment_id, ts DESC);

COMMENT ON TABLE ax_router.gateway_requests IS
  'Usage-measurement telemetry. One row per inbound gateway HTTP request. No IPs, user-agents, cookies, credentials or payment payloads. Write-only instrumentation; never read by payment logic.';

-- ---------------------------------------------------------------------------
-- 2. usage_measurement — a read-only summary view for reproducible reporting
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ax_router.usage_measurement AS
SELECT
  date_trunc('day', ts)::date AS day,
  environment,
  endpoint,
  method,
  outcome,
  status,
  chain_id,
  count(*)                                   AS requests,
  count(*) FILTER (WHERE is_retry)           AS retries,
  count(*) FILTER (WHERE is_synthetic)       AS synthetic,
  count(DISTINCT client_id)                  AS distinct_clients,
  count(DISTINCT commitment_id)              AS distinct_commitments,
  count(DISTINCT tx_hash)                    AS distinct_tx_hashes,
  round(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 1) AS avg_duration_ms,
  max(duration_ms)                           AS max_duration_ms
FROM ax_router.gateway_requests
GROUP BY 1, 2, 3, 4, 5, 6, 7;

COMMENT ON VIEW ax_router.usage_measurement IS
  'Read-only daily usage summary. distinct_clients counts authenticated client_ids only (never IPs); unauthenticated traffic reports NULL.';

-- ---------------------------------------------------------------------------
-- 3. Privileges — service_role only
-- ---------------------------------------------------------------------------
ALTER TABLE ax_router.gateway_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE ax_router.gateway_requests FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.gateway_requests FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE ax_router.gateway_requests TO service_role;

REVOKE ALL ON VIEW ax_router.usage_measurement FROM PUBLIC;
REVOKE ALL ON VIEW ax_router.usage_measurement FROM anon, authenticated;
GRANT SELECT ON VIEW ax_router.usage_measurement TO service_role;

-- PostgREST schema-cache refresh so the new table/view are visible to the API
-- immediately (mirrors the previously-reviewed migration pattern).
NOTIFY pgrst, 'reload schema';

COMMIT;
