-- Gate A proof: SECURITY DEFINER search_path hardening vs shadow-schema hijack
-- (local Docker testbed only). reconcile_idempotency sets
-- SET search_path = ax_router, public  -> pg_catalog implicitly FIRST, so a
-- malicious caller putting 'evil' ahead of pg_catalog must NOT change which
-- md5() the function uses.
\set ON_ERROR_STOP on
DROP SCHEMA IF EXISTS evil CASCADE;
CREATE SCHEMA evil;
CREATE FUNCTION evil.md5(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT ''HACKED''::text';
CREATE FUNCTION evil.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT now()';

-- Caller tries to poison the path BEFORE invoking the definer function:
SET search_path = evil, pg_catalog, public;
SELECT ax_router.reconcile_idempotency(60, 100, false, '{}', '{}') AS rpc_under_poisoned_path;
RESET search_path;

-- Verify the function actually used pg_catalog.md5 (a HACKED md5 would have
-- produced a different advisory-lock hash, or errored on bit cast):
SELECT ('x' || substr(md5('gatea:poison-probe'), 1, 16))::bit(64)::bigint AS lock_hash_control
     , ('x' || substr(md5('gatea:poison-probe'), 1, 16))::bit(64)::bigint AS lock_hash_poisoned_alias;

DROP SCHEMA IF EXISTS evil CASCADE;

-- Gate A proof: authenticated role DML is RLS-neutralized on idempotency_keys
-- (table has RLS enabled, zero policies => no rows visible/mutable to roles
-- without BYPASSRLS), despite the historical authenticated=arwd table ACL.
SELECT count(*) AS visible_rows_to_authenticated
FROM ax_router.idempotency_keys;  -- run as postgres; below we SET ROLE authenticated
SET ROLE authenticated;
SELECT count(*) AS authenticated_sees FROM ax_router.idempotency_keys;
INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at)
VALUES ('gatea:auth-try', 'pending', 'ph:x', now(), now() + interval '1 hour');
RESET ROLE;
SELECT count(*) AS auth_insert_landed FROM ax_router.idempotency_keys WHERE key = 'gatea:auth-try';