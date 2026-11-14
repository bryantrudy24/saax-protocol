-- SAAX Protocol — Final Production Reliability Gate (2026-11-07)
-- Startup/scheduled reconciliation for stale pending idempotency rows.
-- =====================================================================
-- Gap (Phase 1): the file-backed durable idempotency store reconciles stale
-- pending rows at startup, but the Supabase/PostgREST production path has NO
-- reconciliation mechanism. A row left 'pending' by a crashed/lost worker
-- stays pending until TTL sweep, and a concurrent identical retry gets 409
-- forever (in-flight) — or, worse, an operator "fix" could delete the row and
-- allow a duplicate payment. This RPC reconciles on the DURABLE record only.
--
-- Outcome policy (matches the file store + docs/reliability-audit/02-*):
--   * Only the CALLER's authoritative evidence decides an outcome:
--       confirmed keys -> 'settled';  failed keys -> 'failed'.
--   * Keys with UNKNOWN evidence are left 'pending' (never replayed, never
--     treated as failure). Expiry/timeout alone is never proof of failure.
--   * Serialized per-key with pg_advisory_xact_lock (same pattern as
--     acquire_idempotency) so concurrent workers cannot reconcile the same
--     row independently; the second sees the first's committed status.
--   * Idempotent across restarts: only 'pending' rows are touched.
--   * No financial action is taken here: this RPC only marks durable DB
--     state; the application decides what a confirmed/failed row means and
--     never auto-replays unknown outcomes.
--
-- Schema note: the LIVE project schema is `ax_router`; the local Docker
-- testbed's reconstructed schema is ALSO `ax_router` (no separate saax_router
-- schema exists in the running stack). The idempotency_keys table has NO
-- updated_at column in either — the RPC updates status only.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS ax_router.reconcile_idempotency(text, integer, boolean, text[], text[]);
--
-- Grants: service-role only (matches idempotency_keys DML).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION ax_router.reconcile_idempotency(
    p_stale_after_seconds integer DEFAULT 60,
    p_limit integer DEFAULT 100,
    p_force_unknown boolean DEFAULT false,
    p_confirmed_keys text[] DEFAULT NULL,
    p_failed_keys text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
    v_stale timestamptz;
    v_row ax_router.idempotency_keys%ROWTYPE;
    v_key_hash bigint;
    v_outcome text;
    v_reconciled integer := 0;
    v_unresolved integer := 0;
    v_notes text[] := '{}';
    v_confirmed text[] := COALESCE(p_confirmed_keys, '{}');
    v_failed text[] := COALESCE(p_failed_keys, '{}');
BEGIN
    v_stale := now() - make_interval(secs => p_stale_after_seconds);

    -- Phase A: caller-supplied confirmation/failure lists (authoritative
    -- evidence from the application: chain check, verifier, etc.).
    FOR v_row IN
        SELECT * FROM ax_router.idempotency_keys
        WHERE key = ANY (v_confirmed) OR key = ANY (v_failed)
        ORDER BY created_at
        LIMIT p_limit
    LOOP
        v_key_hash := ('x' || substr(md5(v_row.key), 1, 16))::bit(64)::bigint;
        PERFORM pg_advisory_xact_lock(v_key_hash);
        SELECT * INTO v_row FROM ax_router.idempotency_keys WHERE key = v_row.key;
        CONTINUE WHEN v_row.key IS NULL OR v_row.status <> 'pending';
        IF v_row.key = ANY (v_confirmed) THEN
            UPDATE ax_router.idempotency_keys SET status='settled'
            WHERE key = v_row.key;
            v_outcome := 'confirmed';
        ELSE
            UPDATE ax_router.idempotency_keys SET status='failed'
            WHERE key = v_row.key;
            v_outcome := 'failed';
        END IF;
        v_reconciled := v_reconciled + 1;
        v_notes := v_notes || format('key %s: -> %s (caller evidence)', left(v_row.key, 24), v_outcome);
    END LOOP;

    -- Phase B: stale-pending scan. Rows older than v_stale, not yet expired.
    -- Default (force_unknown=false): left pending UNRESOLVED — never
    -- resolved by age. force_unknown=true is provided ONLY for the
    -- mock/test lane where nothing was ever broadcast.
    FOR v_row IN
        SELECT * FROM ax_router.idempotency_keys
        WHERE status = 'pending'
          AND created_at < v_stale
          AND expires_at > now()
        ORDER BY created_at
        LIMIT p_limit
    LOOP
        v_key_hash := ('x' || substr(md5(v_row.key), 1, 16))::bit(64)::bigint;
        PERFORM pg_advisory_xact_lock(v_key_hash);
        SELECT * INTO v_row FROM ax_router.idempotency_keys WHERE key = v_row.key;
        CONTINUE WHEN v_row.key IS NULL OR v_row.status <> 'pending';
        IF p_force_unknown THEN
            -- Mark unresolved (status stays pending; the note records it).
            v_notes := v_notes || format('key %s: still pending (unknown; NOT replayed)', left(v_row.key, 24));
            v_unresolved := v_unresolved + 1;
        ELSE
            v_notes := v_notes || format('key %s: pending-stale UNRESOLVED (no evidence; never auto-replay)', left(v_row.key, 24));
            v_unresolved := v_unresolved + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'reconciled', v_reconciled,
        'unresolved', v_unresolved,
        'notes', v_notes,
        'force_unknown', p_force_unknown
    );
END;
$function$;

REVOKE ALL ON FUNCTION ax_router.reconcile_idempotency(integer, integer, boolean, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ax_router.reconcile_idempotency(integer, integer, boolean, text[], text[]) TO service_role;

COMMIT;