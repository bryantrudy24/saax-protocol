-- SAAX Protocol — MCP Lifecycle Phase 4: Dispute Governance + Evidence Verification Columns
-- Additive migration. Isolated testbed only. NOT for production without separate approval.
--
-- Adds:
--   1. ax_router.commitment_disputes          — durable, attributable dispute records
--   2. ax_router.raise_dispute(...)           — authorized dispute initiation (buyer/provider/evaluator per canonical edges)
--   3. ax_router.resolve_dispute(...)         — evaluator-only resolution into canonical nonfinancial outcomes
--   4. ax_router.list_disputes(...)           — commitment-scoped dispute history (authorized read)
--   5. commitment_evidence.verification_policy_version / verifier_identity /
--      verification_timestamp                — durable attribution of the verification decision
--
--   Canonical disputed edges (spec/lifecycle.md §2):
--     evidence_submitted -> disputed   (party disputes)
--     fulfilled          -> disputed   (post-fulfillment dispute)
--     settled            -> disputed   (settlement disputed — BLOCKED here: financial)
--     disputed -> executing | recovering | fulfilled | failed | settled
--     (settled outcome from dispute BLOCKED: requires settlement rail execution)
--
--   Dispute resolution NEVER triggers a financial transfer. The 'settled'
--   outcome is intentionally omitted; only nonfinancial outcomes are exposed.
--
--   Grants: service_role SELECT-only on the table, EXECUTE-only on the RPCs.
--   RLS deny-all for anon/authenticated. No direct DML grants to any role.

BEGIN;

-- 1. Evidence verification attribution columns (Phase 4C)
ALTER TABLE ax_router.commitment_evidence
  ADD COLUMN IF NOT EXISTS verification_policy_version text,
  ADD COLUMN IF NOT EXISTS verifier_identity text,
  ADD COLUMN IF NOT EXISTS verification_timestamp timestamptz;

COMMENT ON COLUMN ax_router.commitment_evidence.verification_policy_version IS
  'Version of the evidence-verification policy that produced this verdict (Phase 4C).';
COMMENT ON COLUMN ax_router.commitment_evidence.verifier_identity IS
  'Verified principal (recovered EIP-712 signer) of the evaluator who recorded the verdict.';
COMMENT ON COLUMN ax_router.commitment_evidence.verification_timestamp IS
  'When the verification decision was durably recorded.';

-- 2. Dispute table
CREATE TABLE IF NOT EXISTS ax_router.commitment_disputes (
  dispute_id       text PRIMARY KEY,
  commitment_id    text NOT NULL REFERENCES ax_router.commitments(commitment_id) ON DELETE RESTRICT,
  raised_by_agent  text NOT NULL,
  raised_by_principal text NOT NULL,
  reason           text NOT NULL,
  evidence_refs    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  resolution       text,
  resolved_by_agent   text,
  resolved_by_principal text,
  resolved_at      timestamptz,
  idempotency_ref  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commitment_id, idempotency_ref)
);

COMMENT ON TABLE ax_router.commitment_disputes IS
  'Durable, attributable dispute records. INSERT/UPDATE restricted to SECURITY DEFINER RPCs; no direct DML grants to any role except owner.';

ALTER TABLE ax_router.commitment_disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ax_router.commitment_disputes FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.commitment_disputes FROM service_role;
GRANT SELECT ON TABLE ax_router.commitment_disputes TO service_role;

DROP POLICY IF EXISTS deny_all_commitment_disputes ON ax_router.commitment_disputes;
CREATE POLICY deny_all_commitment_disputes
  ON ax_router.commitment_disputes FOR ALL TO public USING (false);

-- 3. raise_dispute — authorized dispute initiation
CREATE OR REPLACE FUNCTION ax_router.raise_dispute(
  p_commitment_id text,
  p_dispute_id   text,
  p_agent_id     text,
  p_verified_principal text,
  p_reason       text,
  p_evidence_refs jsonb,
  p_idempotency_ref text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $$
DECLARE
  v_commit record;
  v_auth record;
  v_exists text;
BEGIN
  IF p_commitment_id = '' OR p_dispute_id = '' OR p_agent_id = '' OR p_verified_principal = '' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_BAD_REQUEST: commitmentId, disputeId, agentId, and verifiedPrincipal are required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 8 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_BAD_REQUEST: reason must be at least 8 characters';
  END IF;

  -- Idempotency: same (commitment, ref) returns the original dispute.
  SELECT dispute_id INTO v_exists FROM ax_router.commitment_disputes
   WHERE commitment_id = p_commitment_id AND idempotency_ref = p_idempotency_ref;
  IF v_exists IS NOT NULL THEN
    RETURN jsonb_build_object('status','replayed','dispute_id',v_exists);
  END IF;

  -- Load commitment (locked).
  SELECT * INTO v_commit FROM ax_router.commitments
   WHERE commitment_id = p_commitment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ST_UNKNOWN_COMMITMENT';
  END IF;

  -- Dispute only from active states where the canonical map permits it:
  -- evidence_submitted->disputed, fulfilled->disputed.
  IF v_commit.state NOT IN ('evidence_submitted','fulfilled') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_INVALID_STATE: disputes may only be raised from evidence_submitted or fulfilled (current=' || v_commit.state || ')';
  END IF;

  -- Caller must hold a durable non-revoked, unexpired authorization on the commitment.
  SELECT * INTO v_auth FROM ax_router.agent_authorizations
   WHERE agent_id = p_agent_id
     AND commitment_id = p_commitment_id
     AND revoked_at IS NULL
     AND valid_from <= now()
     AND valid_until > now()
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='AUTH_MISSING_AUTHORIZATION: no active authorization for agent ' || p_agent_id || ' / principal ' || p_verified_principal;
  END IF;
  -- Principal binding: the recovered signer must match the authorization's principal.
  IF lower(v_auth.principal_identity) <> lower(p_verified_principal) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUTH_PRINCIPAL_MISMATCH';
  END IF;

  INSERT INTO ax_router.commitment_disputes
    (dispute_id, commitment_id, raised_by_agent, raised_by_principal, reason,
     evidence_refs, status, idempotency_ref)
  VALUES
    (p_dispute_id, p_commitment_id, p_agent_id, p_verified_principal, p_reason,
     coalesce(p_evidence_refs,'[]'::jsonb), 'open', p_idempotency_ref)
  ON CONFLICT (commitment_id, idempotency_ref) DO NOTHING
  RETURNING dispute_id INTO v_exists;

  -- Concurrent same-ref raise: another transaction won the insert. Return the
  -- durable winner as a replay (idempotent semantics, no second effect).
  IF v_exists IS NULL THEN
    SELECT dispute_id INTO v_exists FROM ax_router.commitment_disputes
     WHERE commitment_id = p_commitment_id AND idempotency_ref = p_idempotency_ref;
    IF v_exists IS NOT NULL THEN
      RETURN jsonb_build_object('status','replayed','dispute_id',v_exists);
    END IF;
  END IF;

  -- Transition the commitment to disputed through the canonical engine.
  -- (The transition RPC validates the edge + records the lifecycle event.)
  PERFORM ax_router.transition_commitment(
    p_commitment_id, v_commit.state, 'disputed', 'raise_dispute',
    p_agent_id, v_auth.principal_identity, v_auth.role,
    'dispute:' || p_dispute_id, 'dispute:' || p_dispute_id,
    null, v_commit.version);

  RETURN jsonb_build_object('status','raised','dispute_id',p_dispute_id,'commitment_state','disputed');
END;
$$;

-- 4. resolve_dispute — evaluator-only, nonfinancial outcomes
CREATE OR REPLACE FUNCTION ax_router.resolve_dispute(
  p_dispute_id text,
  p_outcome text,
  p_agent_id text,
  p_verified_principal text,
  p_reason text,
  p_idempotency_ref text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $$
DECLARE
  v_disp record;
  v_auth record;
  v_commit record;
  v_to_state text;
BEGIN
  -- Outcomes map: only nonfinancial canonical resolutions are allowed.
  -- disputed->executing (continue), disputed->recovering (rework), disputed->fulfilled (satisfied), disputed->failed (against).
  CASE p_outcome
    WHEN 'continue'  THEN v_to_state := 'executing';
    WHEN 'rework'    THEN v_to_state := 'recovering';
    WHEN 'satisfied' THEN v_to_state := 'fulfilled';
    WHEN 'against'   THEN v_to_state := 'failed';
    ELSE RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_BAD_OUTCOME: continue|rework|satisfied|against only';
  END CASE;

  SELECT * INTO v_disp FROM ax_router.commitment_disputes
   WHERE dispute_id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_UNKNOWN_DISPUTE';
  END IF;
  IF v_disp.status <> 'open' THEN
    IF v_disp.status = 'resolved' THEN
      IF v_disp.resolution = p_outcome THEN
        RETURN jsonb_build_object('status','replayed','dispute_id',p_dispute_id,'resolution',v_disp.resolution);
      END IF;
      RAISE EXCEPTION USING ERRCODE='P0001',
        MESSAGE='DISP_RESOLVED_CONFLICT: dispute already resolved to ' || v_disp.resolution || ' (requested ' || p_outcome || ')';
    END IF;
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_ALREADY_RESOLVED';
  END IF;

  -- Caller must hold EVALUATOR authorization on the commitment.
  SELECT * INTO v_auth FROM ax_router.agent_authorizations
   WHERE agent_id = p_agent_id
     AND commitment_id = v_disp.commitment_id
     AND role = 'evaluator'
     AND revoked_at IS NULL
     AND valid_from <= now()
     AND valid_until > now()
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='AUTH_MISSING_AUTHORIZATION: no active evaluator authorization for agent ' || p_agent_id || ' / principal ' || p_verified_principal;
  END IF;
  IF lower(v_auth.principal_identity) <> lower(p_verified_principal) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUTH_PRINCIPAL_MISMATCH';
  END IF;

  SELECT * INTO v_commit FROM ax_router.commitments
   WHERE commitment_id = v_disp.commitment_id FOR UPDATE;
  IF NOT FOUND OR v_commit.state <> 'disputed' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_NOT_DISPUTED: commitment is not in disputed state (current=' || coalesce(v_commit.state,'missing') || ')';
  END IF;

  UPDATE ax_router.commitment_disputes SET
    status = 'resolved',
    resolution = p_outcome,
    resolved_by_agent = p_agent_id,
    resolved_by_principal = p_verified_principal,
    resolved_at = now(),
    updated_at = now()
  WHERE dispute_id = p_dispute_id;

  -- Canonical transition disputed->v_to_state (validated by transition_commitment).
  -- Idempotency ref is deterministic per (dispute, outcome) so a safe retry
  -- of the same resolution replays instead of fingerprint-conflicting.
  PERFORM ax_router.transition_commitment(
    v_disp.commitment_id, 'disputed', v_to_state, 'resolve_dispute',
    p_agent_id, v_auth.principal_identity, v_auth.role,
    'dispute-resolution:' || p_dispute_id, 'resolve:' || p_dispute_id || ':' || v_to_state,
    null, v_commit.version);

  RETURN jsonb_build_object('status','resolved','dispute_id',p_dispute_id,'outcome',p_outcome,'commitment_state',v_to_state);
END;
$$;

-- 5. list_disputes — commitment-scoped authorized read
CREATE OR REPLACE FUNCTION ax_router.list_disputes(
  p_commitment_id text,
  p_agent_id text,
  p_verified_principal text,
  p_status text,
  p_limit integer,
  p_offset integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $$
DECLARE
  v_auth record;
  v_rows jsonb;
BEGIN
  IF p_commitment_id = '' OR p_agent_id = '' OR p_verified_principal = '' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISP_BAD_REQUEST: commitmentId, agentId, verifiedPrincipal required';
  END IF;
  SELECT * INTO v_auth FROM ax_router.agent_authorizations
   WHERE agent_id = p_agent_id
     AND commitment_id = p_commitment_id
     AND revoked_at IS NULL
     AND valid_from <= now()
     AND valid_until > now()
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='AUTH_MISSING_AUTHORIZATION: no active authorization for agent ' || p_agent_id || ' on commitment ' || p_commitment_id;
  END IF;
  IF lower(v_auth.principal_identity) <> lower(p_verified_principal) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUTH_PRINCIPAL_MISMATCH';
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(d) ORDER BY d.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT dispute_id, commitment_id, raised_by_agent, raised_by_principal,
                 reason, evidence_refs, status, resolution,
                 resolved_by_agent, resolved_by_principal, resolved_at, created_at
            FROM ax_router.commitment_disputes d
           WHERE d.commitment_id = p_commitment_id
             AND (p_status IS NULL OR d.status = p_status)
           ORDER BY d.created_at DESC
           LIMIT GREATEST(1, least(coalesce(p_limit,50), 200))
           OFFSET GREATEST(0, coalesce(p_offset,0))) d;

  RETURN jsonb_build_object('disputes', v_rows);
END;
$$;

-- 6. Grants (least privilege)
REVOKE ALL ON FUNCTION ax_router.raise_dispute(text,text,text,text,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.resolve_dispute(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.list_disputes(text,text,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ax_router.raise_dispute(text,text,text,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.resolve_dispute(text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.list_disputes(text,text,text,text,integer,integer) TO service_role;

-- 7. Evidence verification attribution defaults for the Phase 3 verify RPC
--    (verify_evidence will now store the policy version + verifier identity.)
ALTER TABLE ax_router.commitment_evidence
  ADD COLUMN IF NOT EXISTS verification_policy text;

NOTIFY pgrst, 'reload schema';
COMMIT;