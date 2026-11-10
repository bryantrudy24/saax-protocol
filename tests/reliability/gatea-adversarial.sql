-- ===== Gate A adversarial testbed (local Docker ax_router_db only; never live) =====
\set ON_ERROR_STOP on
\echo '--- T-1: fabricated evidence key for NONEXISTENT row (must not create anything)'
DELETE FROM ax_router.idempotency_keys WHERE key LIKE 'gatea:%';
SELECT ax_router.reconcile_idempotency(60, 100, false, ARRAY['gatea:nonexistent'], '{}') AS rpc_result;
SELECT count(*) AS rows_created FROM ax_router.idempotency_keys WHERE key = 'gatea:nonexistent';

\echo '--- T-2/T-3: malicious keys with SQL/path junk (literal matching only, never executed)'
SELECT ax_router.reconcile_idempotency(60, 100, false, ARRAY['gatea:x''; DROP TABLE ax_router.idempotency_keys; --'], '{}') AS rpc_sqli;
SELECT ax_router.reconcile_idempotency(60, 100, false, ARRAY['gatea:x'' OR 1=1 --'], '{}') AS rpc_rce;
SELECT count(*) AS table_still_exists FROM ax_router.idempotency_keys;

\echo '--- T-4: empty evidence lists + force_unknown=false on stale pending -> UNRESOLVED, status pending'
INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at)
VALUES ('gatea:stale', 'pending', 'ph:stale', now() - interval '5 minutes', now() + interval '1 hour')
ON CONFLICT (key) DO NOTHING;
SELECT ax_router.reconcile_idempotency(60, 100, false, '{}', '{}') AS rpc_empty;
SELECT key, status FROM ax_router.idempotency_keys WHERE key = 'gatea:stale';

\echo '--- T-5: force_unknown=true -> STILL not settled/failed (status must stay pending)'
SELECT ax_router.reconcile_idempotency(60, 100, true, '{}', '{}') AS rpc_force;
SELECT key, status FROM ax_router.idempotency_keys WHERE key = 'gatea:stale';

\echo '--- T-6: caller-asserted evidence on a real pending row (service-role only path)'
INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at)
VALUES ('gatea:claimed', 'pending', 'ph:claimed', now() - interval '5 minutes', now() + interval '1 hour')
ON CONFLICT (key) DO NOTHING;
SELECT ax_router.reconcile_idempotency(60, 100, false, ARRAY['gatea:claimed'], '{}') AS rpc_claimed;
SELECT key, status FROM ax_router.idempotency_keys WHERE key = 'gatea:claimed';

\echo '--- T-7: failed-list marks failed; already-settled/verified rows are NOT touched'
INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at)
VALUES ('gatea:finish', 'pending', 'ph:finish', now() - interval '5 minutes', now() + interval '1 hour')
ON CONFLICT (key) DO NOTHING;
UPDATE ax_router.idempotency_keys SET status='settled' WHERE key='gatea:claimed';
SELECT ax_router.reconcile_idempotency(60, 100, false, ARRAY['gatea:claimed','gatea:finish'], ARRAY['gatea:finish']) AS rpc_mixed;
SELECT key, status FROM ax_router.idempotency_keys WHERE key IN ('gatea:claimed','gatea:finish') ORDER BY key;

\echo '--- T-8: expired pending rows are NOT reconciled (only created_at < stale AND expires_at > now)'
INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at)
VALUES ('gatea:expired', 'pending', 'ph:exp', now() - interval '5 minutes', now() - interval '1 minute')
ON CONFLICT (key) DO NOTHING;
SELECT ax_router.reconcile_idempotency(60, 100, false, '{}', '{}') AS rpc_expired;
SELECT key, status FROM ax_router.idempotency_keys WHERE key = 'gatea:expired';