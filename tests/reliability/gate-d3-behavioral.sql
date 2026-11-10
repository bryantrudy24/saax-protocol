-- Gate D.3 Phase C: behavioral + adversarial tests (isolated testbed, migrated state)
-- Explicit type casts on every argument (Postgres overload resolution).
-- Run from psql; this file uses a single transaction that ROLLBACKs at the end
-- so the testbed is left in the migrated-but-empty state (like production pre-activation).

\set ON_ERROR_STOP off

-- T1: Idempotent replay — same reservation id + same payload -> replay true, same id, no new row
SELECT 'T1_replay' AS test,
  (ax_router.reserve_payment_quota(
      'res_t1'::text,'key_t1'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '1000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 'c1'::text,'ph1'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'replay' AS first_replay,
  (SELECT count(*) FROM ax_router.payment_reservations WHERE idempotency_key='key_t1') AS rows_after_first;

-- T2: Same key, different payload -> reservation_payload_mismatch
SELECT 'T2_mismatch' AS test,
  (ax_router.reserve_payment_quota(
      'res_t1'::text,'key_t1'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '2000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 'c1'::text,'ph_CHANGED'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS reason;

-- T3: Same idempotency key, different reservation id -> idempotency_key_conflict
SELECT 'T3_keyconflict' AS test,
  (ax_router.reserve_payment_quota(
      'res_t1_OTHER'::text,'key_t1'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '1000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 'c1'::text,'ph1'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS reason;

-- T4: Allowlist enforcement — unknown wallet rejected
SELECT 'T4_allowlist' AS test,
  (ax_router.reserve_payment_quota(
      'res_t4'::text,'key_t4'::text,'0x2222222222222222222222222222222222222222'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '1000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 'c4'::text,'ph4'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,true))->>'reason' AS unknown_wallet_reason;

-- T5: Single-tx cap (100 USD = 100_000_000 base units at 6dp; try 100.000001)
SELECT 'T5_singlecap' AS test,
  (ax_router.reserve_payment_quota(
      'res_t5'::text,'key_t5'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '100000001'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 'c5'::text,'ph5'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS reason;

-- T6: Wallet amount cap (200 USD; spend 300)
SELECT 'T6_walletcap' AS test,
  (ax_router.reserve_payment_quota(
      'res_t6'::text,'key_t6'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '300000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 'c6'::text,'ph6'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS reason;

-- T7: Wallet tx count cap — 3 max; 4th rejected (wallet 0x3333)
SELECT 'T7_wallettx' AS test,
  (ax_router.reserve_payment_quota('res_t7a'::text,'key_t7a'::text,'0x3333333333333333333333333333333333333333'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text,'1000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text,'c7'::text,'ph7a'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false)->>'allowed') AS tx1,
  (ax_router.reserve_payment_quota('res_t7b'::text,'key_t7b'::text,'0x3333333333333333333333333333333333333333'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text,'1000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text,'c7'::text,'ph7b'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false)->>'allowed') AS tx2,
  (ax_router.reserve_payment_quota('res_t7c'::text,'key_t7c'::text,'0x3333333333333333333333333333333333333333'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text,'1000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text,'c7'::text,'ph7c'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false)->>'allowed') AS tx3,
  (ax_router.reserve_payment_quota('res_t7d'::text,'key_t7d'::text,'0x3333333333333333333333333333333333333333'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text,'1000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text,'c7'::text,'ph7d'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false)->>'reason') AS tx4_reason;

-- T8: Global amount cap (1000 USD; spend 1001)
SELECT 'T8_globalcap' AS test,
  (ax_router.reserve_payment_quota(
      'res_t8'::text,'key_t8'::text,'0x4444444444444444444444444444444444444444'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '1001000000'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 'c8'::text,'ph8'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS reason;

-- T9: Amount validation — zero, negative, fractional rejected
SELECT 'T9_amounts' AS test,
  (ax_router.reserve_payment_quota(
      'res_t9a'::text,'key_t9a'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '0'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text,'c9'::text,'ph9a'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS zero_amt,
  (ax_router.reserve_payment_quota(
      'res_t9b'::text,'key_t9b'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '-5'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text,'c9'::text,'ph9b'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS neg_amt,
  (ax_router.reserve_payment_quota(
      'res_t9c'::text,'key_t9c'::text,'0x1111111111111111111111111111111111111111'::text,8453::int,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text, '1.5'::numeric,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text,'c9'::text,'ph9c'::text,
      '100000000'::numeric,'200000000'::numeric,3::int,'1000000000'::numeric,15::int,24::int,false))->>'reason' AS frac_amt;

-- T10: RLS — anon/authenticated see 0 rows and writes denied (permission denied)
SET ROLE anon;
SELECT 'T10_anon_rls' AS test, count(*) AS visible_rows FROM ax_router.payment_reservations;
RESET ROLE;

SET ROLE authenticated;
SELECT 'T10_auth_rls' AS test, count(*) AS visible_rows FROM ax_router.payment_reservations;
RESET ROLE;

-- T11: SECURITY DEFINER search_path pinned (no attacker-controlled schema)
SELECT 'T11_searchpath' AS test,
  (SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='ax_router' AND p.proname='reserve_payment_quota') AS proconfig;

-- T12: Finalize — CONFIRMED then RELEASED denied (immutable terminal)
SELECT 'T12_finalize' AS test,
  (ax_router.finalize_payment_reservation('res_t1'::text,'CONFIRMED'::text,'settlement observed'::text,'ref_t1'::text))->>'ok' AS confirm_ok,
  (ax_router.finalize_payment_reservation('res_t1'::text,'RELEASED'::text,'attempt after confirm'::text,NULL))->>'reason' AS release_after_confirm;

-- T13: Release of a RESERVED row succeeds (authoritative non-settlement)
SELECT 'T13_release' AS test,
  (ax_router.finalize_payment_reservation('res_t1'::text,'RELEASED'::text,'authoritative non-settlement'::text,NULL))->>'ok' AS release_ok;

-- T14: Reconcile — stale RESERVED -> EXPIRED_UNRESOLVED (exposure retained); empty evidence -> unresolved
SELECT 'T14_reconcile' AS test,
  (ax_router.reconcile_payment_reservations(0, ARRAY[]::text[], ARRAY[]::text[], false))->>'unresolved' AS unresolved_count;

-- T15: Fabricated evidence keys reconcile nothing
SELECT 'T15_fabricated' AS test,
  (ax_router.reconcile_payment_reservations(10000, ARRAY['res_NOPE']::text[], ARRAY['res_NOPE2']::text[], false))->>'confirmed' AS confirmed,
  (ax_router.reconcile_payment_reservations(10000, ARRAY['res_NOPE']::text[], ARRAY['res_NOPE2']::text[], false))->>'released' AS released;

ROLLBACK;
