-- SAAX Final Production Reliability Gate — LOCAL TESTBED FIXTURE
-- Adds the commitment persistence + lookup RPCs to the LOCAL Docker
-- PostgREST stack (ax_router DB) so the settlement-integrity regression
-- suite can satisfy the F-4 strict-persistence path against a REAL durable
-- store. This mirrors the LIVE Supabase project's RPCs (which exist there).
-- TEST-ONLY: this file is a testbed fixture for the local Docker stack; the
-- live project already has these functions. It is NOT applied to production.
-- =====================================================================
BEGIN;

CREATE OR REPLACE FUNCTION ax_router.upsert_commitment(
    p_commitment_id text,
    p_state text,
    p_capability text,
    p_buyer_email text,
    p_terms jsonb,
    p_authority_ref text,
    p_evidence_refs jsonb,
    p_settlement_ref text,
    p_manifest_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
    v_out jsonb;
BEGIN
    INSERT INTO ax_router.commitments (
        commitment_id, state, capability, buyer_email, terms, authority_ref,
        evidence_refs, settlement_ref, manifest_hash, created_at, updated_at
    ) VALUES (
        p_commitment_id,
        COALESCE(p_state, 'issued'),
        p_capability,
        p_buyer_email,
        COALESCE(p_terms, '{}'::jsonb),
        p_authority_ref,
        COALESCE(p_evidence_refs, '[]'::jsonb),
        p_settlement_ref,
        p_manifest_hash,
        now(), now()
    )
    ON CONFLICT (commitment_id) DO UPDATE SET
        state = EXCLUDED.state,
        capability = EXCLUDED.capability,
        buyer_email = EXCLUDED.buyer_email,
        terms = EXCLUDED.terms,
        authority_ref = EXCLUDED.authority_ref,
        evidence_refs = EXCLUDED.evidence_refs,
        settlement_ref = EXCLUDED.settlement_ref,
        manifest_hash = EXCLUDED.manifest_hash,
        updated_at = now()
    RETURNING jsonb_build_object(
        'commitment_id', commitment_id,
        'state', state,
        'created_at', created_at
    ) INTO v_out;
    RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION ax_router.upsert_commitment(text, text, text, text, jsonb, text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ax_router.upsert_commitment(text, text, text, text, jsonb, text, jsonb, text, text) TO service_role, anon, authenticated;

CREATE OR REPLACE FUNCTION ax_router.lookup_commitment_by_id(p_commitment_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
    v_row ax_router.commitments%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM ax_router.commitments WHERE commitment_id = p_commitment_id;
    IF v_row.commitment_id IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN jsonb_build_object(
        'commitment_id', v_row.commitment_id,
        'state', v_row.state,
        'capability', v_row.capability,
        'buyer_email', v_row.buyer_email,
        'terms', v_row.terms,
        'authority_ref', v_row.authority_ref,
        'evidence_refs', v_row.evidence_refs,
        'settlement_ref', v_row.settlement_ref,
        'manifest_hash', v_row.manifest_hash,
        'created_at', v_row.created_at
    );
END;
$function$;

REVOKE ALL ON FUNCTION ax_router.lookup_commitment_by_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ax_router.lookup_commitment_by_id(text) TO service_role, anon, authenticated;

COMMIT;