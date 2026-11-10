-- SAAX Protocol — Gate D.1: internal-Beta financial limits (atomic shared reservation engine)
--
-- ISOLATED / NOT APPLIED TO PRODUCTION. Additive only: two new tables, three new
-- functions. No existing table, column, grant or policy is altered.
--
-- DESIGN NOTES
--   * Money is INTEGER BASE UNITS (numeric(78,0)) — never floating point. The
--     application converts USD policy to base units with BigInt and passes the
--     integer here; the database never multiplies by a decimal.
--   * Rolling 24h window is computed from created_at, not a calendar day, so
--     there is no midnight boundary to game and no timezone ambiguity (UTC).
--   * EXPOSURE-CONSUMING statuses: RESERVED, CONFIRMED, EXPIRED_UNRESOLVED.
--     Only RELEASED stops consuming budget. An unknown settlement outcome
--     therefore KEEPS consuming exposure — a timeout is never proof of failure.
--   * LOCK ORDER (deadlock prevention): every reservation takes the GLOBAL
--     advisory lock first, then the WALLET advisory lock. The order is fixed and
--     the global lock is a single resource, so no cycle can form. This
--     deliberately serializes reservations across all wallets — at internal-Beta
--     volume (15 tx/day) that cost is irrelevant and the correctness is total.
--   * SECURITY DEFINER with a pinned search_path, mirroring the already-reviewed
--     reconcile_idempotency pattern. EXECUTE is service_role only.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pilot wallet allowlist (manual approval, auditable add/revoke)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ax_router.pilot_wallets (
  wallet      text        PRIMARY KEY,
  status      text        NOT NULL DEFAULT 'approved'
                          CHECK (status IN ('approved', 'revoked')),
  label       text,
  chain_id    integer     NOT NULL DEFAULT 8453,
  added_at    timestamptz NOT NULL DEFAULT now(),
  added_by    text        NOT NULL DEFAULT 'operator',
  revoked_at  timestamptz,
  revoked_by  text,
  note        text
);

COMMENT ON TABLE ax_router.pilot_wallets IS
  'Gate D.1 internal-Beta allowlist. Manual approval per wallet. Revocation is a status change (never a delete) so the audit trail survives.';

-- ---------------------------------------------------------------------------
-- 2. Payment reservations (one row per authorized payment operation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ax_router.payment_reservations (
  reservation_id  text        PRIMARY KEY,
  idempotency_key text        NOT NULL UNIQUE,
  wallet          text        NOT NULL,
  chain_id        integer     NOT NULL,
  asset           text        NOT NULL,
  amount_units    numeric(78,0) NOT NULL CHECK (amount_units > 0),
  recipient       text        NOT NULL,
  commitment_id   text,
  payload_hash    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'RESERVED'
                              CHECK (status IN ('RESERVED', 'CONFIRMED',
                                                'RELEASE_PENDING', 'RELEASED',
                                                'EXPIRED_UNRESOLVED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  release_reason  text,
  settlement_ref  text
);

CREATE INDEX IF NOT EXISTS payment_reservations_wallet_window_idx
  ON ax_router.payment_reservations (wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_reservations_global_window_idx
  ON ax_router.payment_reservations (created_at DESC);
CREATE INDEX IF NOT EXISTS payment_reservations_status_idx
  ON ax_router.payment_reservations (status, created_at DESC);

COMMENT ON TABLE ax_router.payment_reservations IS
  'Gate D.1 quota reservations. One row per authorized payment operation, bound to the idempotency key. RESERVED/CONFIRMED/EXPIRED_UNRESOLVED consume exposure; only RELEASED does not.';

-- ---------------------------------------------------------------------------
-- 3. Atomic reservation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ax_router.reserve_payment_quota(
  p_reservation_id   text,
  p_idempotency_key  text,
  p_wallet           text,
  p_chain_id         integer,
  p_asset            text,
  p_amount_units     numeric,
  p_recipient        text,
  p_commitment_id    text,
  p_payload_hash     text,
  p_max_single_units numeric,
  p_wallet_max_units numeric,
  p_wallet_max_tx    integer,
  p_global_max_units numeric,
  p_global_max_tx    integer,
  p_window_hours     integer,
  p_enforce_allowlist boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_existing      ax_router.payment_reservations%ROWTYPE;
  v_wallet_spent  numeric;
  v_wallet_tx     integer;
  v_global_spent  numeric;
  v_global_tx     integer;
  v_window        interval;
  v_wallet_ok     boolean;
BEGIN
  -- ---- Input validation (reject malformed / non-positive / ambiguous) ------
  IF p_reservation_id IS NULL OR length(p_reservation_id) = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_reservation_id');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_idempotency_key');
  END IF;
  IF p_wallet IS NULL OR length(p_wallet) = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_wallet');
  END IF;
  IF p_amount_units IS NULL OR p_amount_units <= 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_amount');
  END IF;
  IF p_amount_units <> trunc(p_amount_units) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'non_integer_amount');
  END IF;
  IF p_asset IS NULL OR length(p_asset) = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_asset');
  END IF;
  IF p_recipient IS NULL OR length(p_recipient) = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_recipient');
  END IF;
  IF p_window_hours IS NULL OR p_window_hours <= 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_window');
  END IF;

  v_window := make_interval(hours => p_window_hours);

  -- ---- LOCK ORDER: global first, then wallet (fixed order = no deadlock) ---
  PERFORM pg_advisory_xact_lock(('x' || substr(md5('saax:quota:global'), 1, 16))::bit(64)::bigint);
  PERFORM pg_advisory_xact_lock(('x' || substr(md5('saax:quota:wallet:' || p_wallet), 1, 16))::bit(64)::bigint);

  -- ---- Idempotent replay: same reservation id + same payload -> same answer -
  SELECT * INTO v_existing FROM ax_router.payment_reservations
   WHERE reservation_id = p_reservation_id;
  IF v_existing.reservation_id IS NOT NULL THEN
    IF v_existing.payload_hash <> p_payload_hash THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'reservation_payload_mismatch',
                                'reservation_id', v_existing.reservation_id);
    END IF;
    RETURN jsonb_build_object('allowed', true, 'replay', true,
                              'reservation_id', v_existing.reservation_id,
                              'status', v_existing.status);
  END IF;

  -- Same idempotency key under a DIFFERENT reservation id = conflicting reuse.
  SELECT * INTO v_existing FROM ax_router.payment_reservations
   WHERE idempotency_key = p_idempotency_key;
  IF v_existing.reservation_id IS NOT NULL THEN
    IF v_existing.payload_hash <> p_payload_hash THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'idempotency_key_conflict',
                                'reservation_id', v_existing.reservation_id);
    END IF;
    RETURN jsonb_build_object('allowed', true, 'replay', true,
                              'reservation_id', v_existing.reservation_id,
                              'status', v_existing.status);
  END IF;

  -- ---- Allowlist (only when pilot enforcement is on) ----------------------
  IF p_enforce_allowlist THEN
    SELECT (status = 'approved') INTO v_wallet_ok
      FROM ax_router.pilot_wallets WHERE wallet = p_wallet;
    IF v_wallet_ok IS NULL THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'wallet_not_allowlisted');
    END IF;
    IF v_wallet_ok IS NOT TRUE THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'wallet_revoked');
    END IF;
  END IF;

  -- ---- Single-transaction cap --------------------------------------------
  IF p_amount_units > p_max_single_units THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'single_transaction_cap',
                              'amount_units', p_amount_units,
                              'cap_units', p_max_single_units);
  END IF;

  -- ---- Rolling-window usage (exposure-consuming statuses only) ------------
  SELECT COALESCE(SUM(amount_units), 0), COUNT(*)
    INTO v_wallet_spent, v_wallet_tx
    FROM ax_router.payment_reservations
   WHERE wallet = p_wallet
     AND created_at > now() - v_window
     AND status IN ('RESERVED', 'CONFIRMED', 'EXPIRED_UNRESOLVED');

  SELECT COALESCE(SUM(amount_units), 0), COUNT(*)
    INTO v_global_spent, v_global_tx
    FROM ax_router.payment_reservations
   WHERE created_at > now() - v_window
     AND status IN ('RESERVED', 'CONFIRMED', 'EXPIRED_UNRESOLVED');

  IF v_wallet_spent + p_amount_units > p_wallet_max_units THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'wallet_amount_cap',
                              'wallet_spent_units', v_wallet_spent,
                              'cap_units', p_wallet_max_units);
  END IF;
  IF v_wallet_tx + 1 > p_wallet_max_tx THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'wallet_count_cap',
                              'wallet_tx', v_wallet_tx, 'cap_tx', p_wallet_max_tx);
  END IF;
  IF v_global_spent + p_amount_units > p_global_max_units THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'global_amount_cap',
                              'global_spent_units', v_global_spent,
                              'cap_units', p_global_max_units);
  END IF;
  IF v_global_tx + 1 > p_global_max_tx THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'global_count_cap',
                              'global_tx', v_global_tx, 'cap_tx', p_global_max_tx);
  END IF;

  -- ---- Reserve ------------------------------------------------------------
  INSERT INTO ax_router.payment_reservations
    (reservation_id, idempotency_key, wallet, chain_id, asset, amount_units,
     recipient, commitment_id, payload_hash, status)
  VALUES
    (p_reservation_id, p_idempotency_key, p_wallet, p_chain_id, p_asset,
     p_amount_units, p_recipient, p_commitment_id, p_payload_hash, 'RESERVED');

  RETURN jsonb_build_object(
    'allowed', true, 'replay', false,
    'reservation_id', p_reservation_id, 'status', 'RESERVED',
    'wallet_spent_units', v_wallet_spent + p_amount_units,
    'wallet_tx', v_wallet_tx + 1,
    'global_spent_units', v_global_spent + p_amount_units,
    'global_tx', v_global_tx + 1
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Finalize a reservation (CONFIRMED / RELEASED / EXPIRED_UNRESOLVED)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ax_router.finalize_payment_reservation(
  p_reservation_id text,
  p_status         text,
  p_reason         text DEFAULT NULL,
  p_settlement_ref text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_row ax_router.payment_reservations%ROWTYPE;
BEGIN
  IF p_status NOT IN ('CONFIRMED', 'RELEASE_PENDING', 'RELEASED', 'EXPIRED_UNRESOLVED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_target_status');
  END IF;

  PERFORM pg_advisory_xact_lock(('x' || substr(md5('saax:quota:global'), 1, 16))::bit(64)::bigint);

  SELECT * INTO v_row FROM ax_router.payment_reservations
   WHERE reservation_id = p_reservation_id FOR UPDATE;
  IF v_row.reservation_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reservation_not_found');
  END IF;

  -- Terminal states are immutable: a RELEASED reservation can never be
  -- re-confirmed (that would resurrect spent budget), and a CONFIRMED one can
  -- never be released (that would hide real spend).
  IF v_row.status = 'RELEASED' AND p_status <> 'RELEASED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_released',
                              'status', v_row.status);
  END IF;
  IF v_row.status = 'CONFIRMED' AND p_status = 'RELEASED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_confirmed',
                              'status', v_row.status);
  END IF;

  UPDATE ax_router.payment_reservations
     SET status = p_status,
         updated_at = now(),
         release_reason = COALESCE(p_reason, release_reason),
         settlement_ref = COALESCE(p_settlement_ref, settlement_ref)
   WHERE reservation_id = p_reservation_id;

  RETURN jsonb_build_object('ok', true, 'reservation_id', p_reservation_id,
                            'status', p_status);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Startup reconciliation of stale RESERVED rows
--    NEVER invents settlement evidence. Without authoritative evidence a stale
--    reservation becomes EXPIRED_UNRESOLVED, which STILL consumes exposure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ax_router.reconcile_payment_reservations(
  p_stale_minutes  integer DEFAULT 60,
  p_confirmed_ids  text[]  DEFAULT ARRAY[]::text[],
  p_failed_ids     text[]  DEFAULT ARRAY[]::text[],
  p_force_unknown  boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_confirmed integer := 0;
  v_released  integer := 0;
  v_unresolved integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(('x' || substr(md5('saax:quota:global'), 1, 16))::bit(64)::bigint);

  -- Authoritative evidence: settled on chain -> CONFIRMED (keeps consuming).
  IF array_length(p_confirmed_ids, 1) IS NOT NULL THEN
    UPDATE ax_router.payment_reservations
       SET status = 'CONFIRMED', updated_at = now(),
           release_reason = 'reconciled: authoritative settlement evidence'
     WHERE reservation_id = ANY(p_confirmed_ids) AND status = 'RESERVED';
    GET DIAGNOSTICS v_confirmed = ROW_COUNT;
  END IF;

  -- Authoritative evidence: provably never settled -> RELEASED (frees budget).
  IF array_length(p_failed_ids, 1) IS NOT NULL THEN
    UPDATE ax_router.payment_reservations
       SET status = 'RELEASED', updated_at = now(),
           release_reason = 'reconciled: authoritative non-settlement evidence'
     WHERE reservation_id = ANY(p_failed_ids) AND status = 'RESERVED';
    GET DIAGNOSTICS v_released = ROW_COUNT;
  END IF;

  -- No evidence: stale RESERVED -> EXPIRED_UNRESOLVED (STILL consumes budget).
  UPDATE ax_router.payment_reservations
     SET status = 'EXPIRED_UNRESOLVED', updated_at = now(),
         release_reason = 'stale reservation: outcome unknown, exposure retained'
   WHERE status = 'RESERVED'
     AND created_at < now() - make_interval(mins => p_stale_minutes);
  GET DIAGNOSTICS v_unresolved = ROW_COUNT;

  RETURN jsonb_build_object('confirmed', v_confirmed, 'released', v_released,
                            'unresolved', v_unresolved,
                            'force_unknown', p_force_unknown);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Privileges — service_role only (mirrors reconcile_idempotency)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION ax_router.reserve_payment_quota(text,text,text,integer,text,numeric,text,text,text,numeric,numeric,integer,numeric,integer,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.finalize_payment_reservation(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.reconcile_payment_reservations(integer,text[],text[],boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ax_router.reserve_payment_quota(text,text,text,integer,text,numeric,text,text,text,numeric,numeric,integer,numeric,integer,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.finalize_payment_reservation(text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.reconcile_payment_reservations(integer,text[],text[],boolean) TO service_role;

-- Tables: service_role only. RLS enabled with no policies = deny-all for
-- non-BYPASSRLS roles (same posture as idempotency_keys).
ALTER TABLE ax_router.pilot_wallets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ax_router.payment_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE ax_router.pilot_wallets        FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.payment_reservations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE ax_router.pilot_wallets        TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE ax_router.payment_reservations TO service_role;

-- PostgREST schema-cache refresh: the new tables/functions must be visible to
-- the API immediately (mirrors the previously-reviewed migration pattern).
NOTIFY pgrst, 'reload schema';

COMMIT;
