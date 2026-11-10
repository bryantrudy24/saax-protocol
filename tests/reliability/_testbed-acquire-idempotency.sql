-- Gate D testbed: ax_router.acquire_idempotency matching PRODUCTION exactly.
--
-- Why this file exists: the repo's dump/schema.sql predates the saax_router ->
-- ax_router rename, so its acquire_idempotency body still hardcodes
-- saax_router.idempotency_keys. After the rename that body raises
-- "relation saax_router.idempotency_keys does not exist", the RPC errors, and
-- the mock lane fails OPEN (endpoint/idempotency.js -> 503 -> mock continues).
-- Production's function body correctly references ax_router (verified read-only
-- via pg_get_functiondef on the live project), so this file reproduces the
-- PRODUCTION definition in the isolated testbed. Testbed only.
CREATE OR REPLACE FUNCTION ax_router.acquire_idempotency(p_key text, p_payload_hash text, p_ttl_hours integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    row ax_router.idempotency_keys%ROWTYPE;
    key_hash bigint;
    outcome jsonb;
BEGIN
    -- Hash the key down to a stable bigint for the advisory lock (64-bit).
    key_hash := ('x' || substr(md5(p_key), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(key_hash);
    -- Lock already held in-flight. Now read under the lock:
    SELECT * INTO row FROM ax_router.idempotency_keys WHERE key = p_key;
    IF row.key IS NULL THEN
        INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at)
        VALUES (p_key, 'pending', p_payload_hash, now(), now() + make_interval(hours => p_ttl_hours));
        RETURN jsonb_build_object('conflict', false, 'status', 'pending');
    END IF;
    -- Key exists. Enforce the payload-hash rule (same key + different payload
    -- hash = 422 protocol violation).
    IF row.payload_hash IS NOT NULL AND row.payload_hash <> p_payload_hash THEN
        RAISE EXCEPTION 'payload hash mismatch: idempotency key reused for a different request';
    END IF;
    IF row.status = 'pending' THEN
        RETURN jsonb_build_object('conflict', true, 'status', 'pending');
    END IF;
    -- verified | settled | failed -> return the row for the cached response
    RETURN jsonb_build_object(
        'conflict', true,
        'status', row.status,
        'response_status', row.response_status,
        'response_body', row.response_body
    );
END;
$function$;

REVOKE ALL ON FUNCTION ax_router.acquire_idempotency(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ax_router.acquire_idempotency(text, text, integer) TO service_role;
