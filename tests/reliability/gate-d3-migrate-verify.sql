-- Gate D.3 Phase C testbed: verification queries after migration apply
-- Expect: 2 tables, 3 functions, service_role-only EXECUTE, RLS enabled, 0 policies (deny-all)

SELECT count(*) AS pilot_tables
FROM information_schema.tables
WHERE table_schema='ax_router' AND table_name IN ('payment_reservations','pilot_wallets');

SELECT count(*) AS pilot_fns
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='ax_router' AND p.proname IN ('reserve_payment_quota','finalize_payment_reservation','reconcile_payment_reservations');

SELECT p.proname, p.prosecdef, p.proconfig,
       (SELECT string_agg(privilege_type, ',') FROM information_schema.role_routine_grants
         WHERE routine_schema='ax_router' AND routine_name=p.proname AND grantee='service_role') AS service_role_exec,
       (SELECT string_agg(privilege_type, ',') FROM information_schema.role_routine_grants
         WHERE routine_schema='ax_router' AND routine_name=p.proname AND grantee='anon') AS anon_exec,
       (SELECT string_agg(privilege_type, ',') FROM information_schema.role_routine_grants
         WHERE routine_schema='ax_router' AND routine_name=p.proname AND grantee='authenticated') AS auth_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='ax_router' AND p.proname IN ('reserve_payment_quota','finalize_payment_reservation','reconcile_payment_reservations')
ORDER BY 1;

SELECT tablename, relrowsecurity, relforcerowsecurity
FROM pg_tables t JOIN pg_class c ON c.relname=t.tablename JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='ax_router'
WHERE t.schemaname='ax_router' AND t.tablename IN ('payment_reservations','pilot_wallets')
ORDER BY 1;

SELECT policyname, tablename, cmd FROM pg_policies WHERE schemaname='ax_router' AND tablename IN ('payment_reservations','pilot_wallets');

SELECT string_agg(grantee || ':' || privilege_type, ',') AS tbl_grants
FROM information_schema.role_table_grants
WHERE table_schema='ax_router' AND table_name IN ('payment_reservations','pilot_wallets')
  AND grantee IN ('anon','authenticated','service_role');
