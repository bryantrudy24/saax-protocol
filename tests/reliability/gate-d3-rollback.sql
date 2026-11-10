-- Gate D.3 Phase C testbed: capture post-rollback state (expect 0 rows both queries)
SELECT count(*) AS pilot_tables_after_rollback
FROM information_schema.tables
WHERE table_schema='ax_router' AND table_name IN ('payment_reservations','pilot_wallets');

SELECT count(*) AS pilot_fns_after_rollback
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='ax_router' AND p.proname IN ('reserve_payment_quota','finalize_payment_reservation','reconcile_payment_reservations');
