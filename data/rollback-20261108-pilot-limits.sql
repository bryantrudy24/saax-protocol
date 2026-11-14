-- SAAX Protocol — Gate D.1 rollback for migration-20261108-pilot-limits.sql
--
-- Reverses ONLY what that migration added. It does not touch idempotency_keys,
-- commitments, escrows, agents, or any pre-existing object.
--
-- DATA LOSS WARNING: dropping payment_reservations discards the reservation
-- history. Before running this in any environment that has served real traffic,
-- export the table:
--   \copy (SELECT * FROM ax_router.payment_reservations) TO 'reservations.csv' CSV HEADER
--   \copy (SELECT * FROM ax_router.pilot_wallets) TO 'pilot_wallets.csv' CSV HEADER
--
-- ORDER: functions first (they depend on the tables), then tables.

BEGIN;

DROP FUNCTION IF EXISTS ax_router.reconcile_payment_reservations(integer, text[], text[], boolean);
DROP FUNCTION IF EXISTS ax_router.finalize_payment_reservation(text, text, text, text);
DROP FUNCTION IF EXISTS ax_router.reserve_payment_quota(text, text, text, integer, text, numeric, text, text, text, numeric, numeric, integer, numeric, integer, integer, boolean);

DROP TABLE IF EXISTS ax_router.payment_reservations;
DROP TABLE IF EXISTS ax_router.pilot_wallets;

COMMIT;

-- Verification after rollback (expect 0 rows):
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'ax_router'
--      AND p.proname IN ('reserve_payment_quota','finalize_payment_reservation',
--                        'reconcile_payment_reservations');
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema = 'ax_router'
--      AND table_name IN ('payment_reservations','pilot_wallets');
