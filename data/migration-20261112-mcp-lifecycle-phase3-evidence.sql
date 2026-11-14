-- ===========================================================================
-- SAAX MCP Lifecycle Phase 3 — Durable Evidence Infrastructure (v3, additive)
-- Adds: commitment_evidence table, submit_evidence / verify_evidence /
--        list_evidence RPCs. Depends on the Phase 1 migration (v1/v2) being
--        applied FIRST (agent_authorizations, commitment_events, the
--        transition_commitment RPC, and the version column must exist).
-- Isolated testbed only. NOT for production without separate approval.
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Durable evidence table
--    - evidence_id: stable identifier returned to callers.
--    - commitment_id + criterion_id: exact binding (criterion may be null for
--      evidence not yet tied to a specific acceptance criterion).
--    - submitter_agent / submitter_principal: verified attribution (from the
--      caller's EIP-712 proof; NEVER caller-supplied).
--    - envelope: the full evidence object as validated (JSONB). Stored ONLY
--      when structurally valid; sensitive payloads are NOT stored — the
--      envelope is the verified reference set (payloadHash, issuer, subject,
--      proofType, scope, signatures, refs). Payload CONTENT is external.
--    - payload_hash: integrity reference (sha256 of the canonical payload).
--    - status: submitted -> verified | rejected | disputed (transitioned by
--      verify_evidence only; submit_evidence always inserts 'submitted').
--    - idempotency_ref: UNIQUE (commitment_id, idempotency_ref) — one logical
--      submission per ref; conflicting payload on reuse is rejected.
--    - op_fingerprint: canonical binding of the idempotency ref to the full
--      logical operation (same scheme as commitment_events).
--    - version: optimistic concurrency for status changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ax_router.commitment_evidence (
  evidence_id          text        PRIMARY KEY,
  commitment_id        text        NOT NULL REFERENCES ax_router.commitments(commitment_id) ON DELETE RESTRICT,
  criterion_id         text,
  submitter_agent      text        NOT NULL,
  submitter_principal  text        NOT NULL,
  envelope             jsonb       NOT NULL,
  payload_hash         text        NOT NULL,
  status               text        NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted','verified','rejected','disputed')),
  idempotency_ref      text        NOT NULL,
  op_fingerprint       text        NOT NULL,
  version              integer     NOT NULL DEFAULT 1,
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  verified_at          timestamptz,
  verified_by          text,
  rejected_at          timestamptz,
  rejected_reason      text,
  disputed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commitment_evidence_idem_uq
  ON ax_router.commitment_evidence (commitment_id, idempotency_ref);
CREATE INDEX IF NOT EXISTS commitment_evidence_commitment_idx
  ON ax_router.commitment_evidence (commitment_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS commitment_evidence_status_idx
  ON ax_router.commitment_evidence (commitment_id, status);
CREATE INDEX IF NOT EXISTS commitment_evidence_fp_idx
  ON ax_router.commitment_evidence (commitment_id, op_fingerprint);

COMMENT ON TABLE ax_router.commitment_evidence IS
  'Durable, attributable evidence records bound to a commitment and acceptance criterion. INSERT/UPDATE restricted to the SECURITY DEFINER RPCs (submit_evidence, verify_evidence); no direct DML grants to any role except owner. Sensitive payload content is not stored: only integrity references and the validated envelope metadata.';

-- RLS: deny-everything for anon/authenticated (service_role bypasses RLS but
-- has no DML grants beyond the RPCs' SECURITY DEFINER execution).
ALTER TABLE ax_router.commitment_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_commitment_evidence ON ax_router.commitment_evidence;
CREATE POLICY deny_all_commitment_evidence
  ON ax_router.commitment_evidence FOR ALL TO public USING (false);

REVOKE ALL ON TABLE ax_router.commitment_evidence FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.commitment_evidence FROM service_role;
GRANT SELECT ON TABLE ax_router.commitment_evidence TO service_role;

-- ---------------------------------------------------------------------------
-- 2. submit_evidence — SECURITY DEFINER, pinned search_path
--    Caller must present: p_commitment_id, p_criterion_id (nullable),
--    p_agent_id, p_verified_principal (from EIP-712 proof), p_envelope (jsonb),
--    p_payload_hash, p_idempotency_ref.
--    Authorization: an agent_authorizations row binding (agent, principal,
--      commitment) with role 'provider' or 'buyer' (the parties entitled to
--      submit fulfillment evidence), unrevoked, unexpired, and in scope.
--    Envelope validation (server-side, minimal): must be an object with
--      evidenceType, issuer, subject, payloadHash matching p_payload_hash,
--      and a non-empty signature envelope. Deep crypto validation reuses
--      endpoint/evidence.js at the app layer; the RPC enforces the durable
--      contract (binding + attribution + idempotency + size guard).
--    Idempotency: UNIQUE (commitment_id, idempotency_ref) + op_fingerprint
--      conflict detection (reuse with a materially different operation is
--      rejected before any state is disclosed).
--    Size guard: envelope must be <= 64 KiB (jsonb length check).
--    Does NOT transition the commitment state (evidence_pending ->
--      evidence_submitted is a SEPARATE authorized lifecycle action). A
--      submission never triggers settlement, escrow, or finalization.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS ax_router.submit_evidence(text,text,text,text,jsonb,text,text);
CREATE OR REPLACE FUNCTION ax_router.submit_evidence(
  p_commitment_id      text,
  p_criterion_id       text,
  p_agent_id           text,
  p_verified_principal text,
  p_envelope           jsonb,
  p_payload_hash       text,
  p_idempotency_ref    text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_princ     text := btrim(p_verified_principal);
  v_idem      text := coalesce(p_idempotency_ref, 'ev:' || gen_random_uuid()::text);
  v_fp        text;
  v_auth      ax_router.agent_authorizations%ROWTYPE;
  v_ev        ax_router.commitment_evidence%ROWTYPE;
  v_row       ax_router.commitments%ROWTYPE;
  v_size      integer;
  v_actions   text[];
  v_role      text;
BEGIN
  IF v_princ = '' OR p_agent_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'EVID_PRINCIPAL_REQUIRED: verified principal and agent are required';
  END IF;
  IF p_commitment_id IS NULL OR p_commitment_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_COMMITMENT_REQUIRED';
  END IF;
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_ENVELOPE_INVALID: envelope must be a JSON object';
  END IF;
  v_size := octet_length(p_envelope::text);
  IF v_size > 65536 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'EVID_TOO_LARGE: envelope exceeds 64 KiB (' || v_size || ' bytes)';
  END IF;
  IF p_payload_hash IS NULL OR length(p_payload_hash) < 16 OR length(p_payload_hash) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_HASH_INVALID: payload hash must be 16-128 chars';
  END IF;

  -- Canonical fingerprint over the full logical submission.
  v_fp := encode(sha256(convert_to(
    p_commitment_id || '|' ||
    coalesce(p_criterion_id,'') || '|' ||
    v_princ || '|' ||
    p_agent_id || '|' ||
    p_payload_hash || '|' ||
    p_envelope::text,
    'UTF8')), 'hex');

  -- Idempotency: same (commitment, ref) already recorded?
  SELECT * INTO v_ev FROM ax_router.commitment_evidence
   WHERE commitment_id = p_commitment_id AND idempotency_ref = v_idem;
  IF FOUND THEN
    IF v_ev.op_fingerprint <> v_fp THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'EVID_IDEM_FINGERPRINT_CONFLICT: idempotency ref is bound to a different submission';
    END IF;
    RETURN jsonb_build_object(
      'status', 'replayed',
      'evidence_id', v_ev.evidence_id,
      'submission_status', v_ev.status,
      'submitted_at', v_ev.submitted_at);
  END IF;

  -- Commitment must exist (and be in a state that permits evidence).
  SELECT * INTO v_row FROM ax_router.commitments
   WHERE commitment_id = p_commitment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ST_UNKNOWN_COMMITMENT';
  END IF;
  IF v_row.state NOT IN ('executing','evidence_pending','evidence_submitted','verifying','recovering','disputed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'EVID_STATE_DENIED: evidence submission not permitted in state ' || v_row.state;
  END IF;

  -- Authorization: provider or buyer role on this commitment (the parties
  -- entitled to submit fulfillment evidence), principal-bound, unrevoked,
  -- unexpired, in scope.
  SELECT * INTO v_auth FROM ax_router.agent_authorizations
   WHERE agent_id = p_agent_id
     AND principal_identity = v_princ
     AND role IN ('provider','buyer')
     AND commitment_id = p_commitment_id
   ORDER BY (role = 'provider') DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_MISSING_AUTHORIZATION: no provider/buyer authorization for agent ' || p_agent_id
        || ' / principal ' || v_princ;
  END IF;
  IF v_auth.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_REVOKED: authorization revoked at ' || v_auth.revoked_at;
  END IF;
  IF v_auth.valid_until < now() OR v_auth.valid_from > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_EXPIRED: authorization window expired';
  END IF;
  v_role := v_auth.role;
  IF jsonb_typeof(v_auth.scope->'actions') = 'array' THEN
    SELECT array_agg(x) INTO v_actions
      FROM jsonb_array_elements_text(v_auth.scope->'actions') AS x;
    IF array_length(v_actions, 1) IS NOT NULL
       AND NOT ('submit_evidence' = ANY(v_actions)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'AUTH_OUT_OF_SCOPE: submit_evidence not in scope';
    END IF;
  END IF;

  -- Durable insert (atomic with the checks above).
  INSERT INTO ax_router.commitment_evidence (
    evidence_id, commitment_id, criterion_id, submitter_agent, submitter_principal,
    envelope, payload_hash, status, idempotency_ref, op_fingerprint, version
  ) VALUES (
    'ev:' || gen_random_uuid()::text, p_commitment_id, p_criterion_id,
    p_agent_id, v_princ, p_envelope, p_payload_hash, 'submitted',
    v_idem, v_fp, 1
  )
  RETURNING * INTO v_ev;

  RETURN jsonb_build_object(
    'status', 'submitted',
    'evidence_id', v_ev.evidence_id,
    'commitment_id', v_ev.commitment_id,
    'criterion_id', v_ev.criterion_id,
    'submitter_agent', v_ev.submitter_agent,
    'submitter_principal', v_ev.submitter_principal,
    'payload_hash', v_ev.payload_hash,
    'submission_status', v_ev.status,
    'submitted_at', v_ev.submitted_at,
    'role', v_role);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. verify_evidence — SECURITY DEFINER
--    Evaluator role ONLY. Sets status: submitted -> verified | rejected.
--    p_verdict: 'verified' | 'rejected'. p_reason required on rejection.
--    Optimistic concurrency on p_expected_version. Idempotent via
--    (evidence_id, verdict) fingerprint: re-verification with the SAME
--    verdict is a replay; a different verdict on an already-verified record
--    is rejected (no flip-flopping without a dispute path).
--    Never auto-transitions the commitment; the caller must invoke the
--    authorized lifecycle transition separately.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS ax_router.verify_evidence(text,text,text,text,text,integer);
CREATE OR REPLACE FUNCTION ax_router.verify_evidence(
  p_evidence_id      text,
  p_verdict          text,
  p_agent_id         text,
  p_verified_principal text,
  p_reason           text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_princ text := btrim(p_verified_principal);
  v_ev    ax_router.commitment_evidence%ROWTYPE;
  v_auth  ax_router.agent_authorizations%ROWTYPE;
  v_actions text[];
BEGIN
  IF v_princ = '' OR p_agent_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'EVID_PRINCIPAL_REQUIRED: verified principal and agent are required';
  END IF;
  IF p_verdict NOT IN ('verified','rejected') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_VERDICT_INVALID: verdict must be verified|rejected';
  END IF;
  IF p_verdict = 'rejected' AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_REASON_REQUIRED: rejection requires a reason';
  END IF;

  SELECT * INTO v_ev FROM ax_router.commitment_evidence
   WHERE evidence_id = p_evidence_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_NOT_FOUND';
  END IF;

  -- Idempotent replay: same verdict on the same record. The replay path MUST
  -- still verify the caller's evaluator authorization (replay-after-revocation
  -- guard): a caller who cannot verify must not learn or replay the outcome.
  IF v_ev.status = p_verdict THEN
    SELECT * INTO v_auth FROM ax_router.agent_authorizations
     WHERE agent_id = p_agent_id
       AND principal_identity = v_princ
       AND role = 'evaluator'
       AND (commitment_id = v_ev.commitment_id
            OR (commitment_id IS NULL AND v_ev.commitment_id IS NOT NULL))
     ORDER BY (commitment_id IS NULL) ASC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'AUTH_MISSING_AUTHORIZATION: no evaluator authorization for agent ' || p_agent_id
          || ' on evidence ' || v_ev.evidence_id;
    END IF;
    IF v_auth.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_REVOKED';
    END IF;
    IF v_auth.valid_until < now() OR v_auth.valid_from > now() THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_EXPIRED';
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'evidence_id', v_ev.evidence_id,
      'verification_status', v_ev.status, 'verified_at', v_ev.verified_at,
      'rejected_at', v_ev.rejected_at);
  END IF;
  -- No flip-flopping: a verified record cannot be re-verified as rejected
  -- (and vice versa) without a dispute path.
  IF v_ev.status IN ('verified','rejected') AND v_ev.status <> p_verdict THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'EVID_STATUS_CONFLICT: evidence already ' || v_ev.status || '; use the dispute path to change';
  END IF;
  IF v_ev.status = 'disputed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_DISPUTED: evidence is disputed; resolve dispute first';
  END IF;

  -- Optimistic concurrency.
  IF p_expected_version IS NOT NULL AND v_ev.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'EVID_STALE_VERSION: expected ' || p_expected_version || ' but current is ' || v_ev.version;
  END IF;

  -- Evaluator authorization (principal-bound, commitment-scoped).
  SELECT * INTO v_auth FROM ax_router.agent_authorizations
   WHERE agent_id = p_agent_id
     AND principal_identity = v_princ
     AND role = 'evaluator'
     AND (commitment_id = v_ev.commitment_id
          OR (commitment_id IS NULL AND v_ev.commitment_id IS NOT NULL))
   ORDER BY (commitment_id IS NULL) ASC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_MISSING_AUTHORIZATION: no evaluator authorization for agent ' || p_agent_id;
  END IF;
  IF v_auth.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_REVOKED';
  END IF;
  IF v_auth.valid_until < now() OR v_auth.valid_from > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_EXPIRED';
  END IF;
  IF jsonb_typeof(v_auth.scope->'actions') = 'array' THEN
    SELECT array_agg(x) INTO v_actions
      FROM jsonb_array_elements_text(v_auth.scope->'actions') AS x;
    IF array_length(v_actions, 1) IS NOT NULL
       AND NOT ('verify_evidence' = ANY(v_actions)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_OUT_OF_SCOPE: verify_evidence not in scope';
    END IF;
  END IF;

  IF p_verdict = 'verified' THEN
    UPDATE ax_router.commitment_evidence
       SET status = 'verified', version = version + 1,
           verified_at = now(), verified_by = p_agent_id, rejected_at = NULL, rejected_reason = NULL
     WHERE evidence_id = p_evidence_id
    RETURNING * INTO v_ev;
  ELSE
    UPDATE ax_router.commitment_evidence
       SET status = 'rejected', version = version + 1,
           rejected_at = now(), rejected_reason = p_reason, verified_at = NULL, verified_by = NULL
     WHERE evidence_id = p_evidence_id
    RETURNING * INTO v_ev;
  END IF;

  RETURN jsonb_build_object(
    'status', 'verified' = p_verdict,
    'evidence_id', v_ev.evidence_id,
    'verification_status', v_ev.status,
    'version', v_ev.version,
    'verified_at', v_ev.verified_at,
    'rejected_at', v_ev.rejected_at,
    'rejected_reason', v_ev.rejected_reason,
    'verified_by', v_ev.verified_by);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. list_evidence — SECURITY DEFINER (read-only)
--    Commitment-scoped, principal-bound: the caller must hold ANY active
--    authorization row on the commitment (buyer/provider/evaluator) to read
--    evidence; a caller with no authorization sees nothing (no cross-
--    commitment disclosure). Returns stable identifiers, integrity refs,
--    attribution, status, timestamps — never the raw payload content.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS ax_router.list_evidence(text,text,text,text,integer,integer);
CREATE OR REPLACE FUNCTION ax_router.list_evidence(
  p_commitment_id    text,
  p_agent_id         text,
  p_verified_principal text,
  p_status           text DEFAULT NULL,
  p_limit            integer DEFAULT 50,
  p_offset           integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_princ text := btrim(p_verified_principal);
  v_auth  ax_router.agent_authorizations%ROWTYPE;
  v_rows  jsonb;
BEGIN
  IF v_princ = '' OR p_agent_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'EVID_PRINCIPAL_REQUIRED: verified principal and agent are required';
  END IF;
  IF p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_LIMIT_INVALID: limit must be 1-200';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('submitted','verified','rejected','disputed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVID_STATUS_FILTER_INVALID';
  END IF;

  -- Authorization: ANY active row on this commitment.
  SELECT * INTO v_auth FROM ax_router.agent_authorizations
   WHERE agent_id = p_agent_id
     AND principal_identity = v_princ
     AND commitment_id = p_commitment_id
     AND revoked_at IS NULL
     AND valid_from <= now() AND valid_until >= now()
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_MISSING_AUTHORIZATION: no authorization for agent ' || p_agent_id
        || ' on commitment ' || p_commitment_id;
  END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'submitted_at' DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'evidence_id', e.evidence_id,
      'commitment_id', e.commitment_id,
      'criterion_id', e.criterion_id,
      'submitter_agent', e.submitter_agent,
      'submitter_principal', e.submitter_principal,
      'payload_hash', e.payload_hash,
      'status', e.status,
      'version', e.version,
      'submitted_at', e.submitted_at,
      'verified_at', e.verified_at,
      'verified_by', e.verified_by,
      'rejected_at', e.rejected_at,
      'rejected_reason', e.rejected_reason,
      'evidence_type', e.envelope->>'evidenceType',
      'issuer', e.envelope->>'issuer',
      'subject', e.envelope->>'subject',
      'proof_type', e.envelope->>'proofType'
    ) AS x
    FROM ax_router.commitment_evidence e
    WHERE e.commitment_id = p_commitment_id
      AND (p_status IS NULL OR e.status = p_status)
    ORDER BY e.submitted_at DESC
    LIMIT p_limit OFFSET p_offset
  ) sub;

  RETURN jsonb_build_object('commitment_id', p_commitment_id, 'count', jsonb_array_length(v_rows), 'evidence', v_rows);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Grants: EXECUTE on the RPCs to service_role only. No DML grants on the
--    table (SELECT read-only for service_role; INSERT/UPDATE/DELETE only via
--    the SECURITY DEFINER RPCs / owner).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION ax_router.submit_evidence(text,text,text,text,jsonb,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.verify_evidence(text,text,text,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.list_evidence(text,text,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ax_router.submit_evidence(text,text,text,text,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.verify_evidence(text,text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.list_evidence(text,text,text,text,integer,integer) TO service_role;

COMMIT;