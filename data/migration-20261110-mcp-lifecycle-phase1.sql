-- SAAX Protocol — MCP Lifecycle Phase 1: Security & Governance Foundation (v2 — Gate B hardened)
--
-- Gate B (isolated implementation only — NOT applied to production).
--
-- This migration SUPERSEDES the v1 draft (data/migration-20261110-mcp-lifecycle-phase1.sql).
-- v2 hardens the four Gate B security requirements:
--
--   A. INDEPENDENT AGENT IDENTITY
--      - The transition RPC requires p_verified_principal: an independently
--        verified principal identifier (e.g. recovered EIP-712 signer address)
--        computed by the application layer from cryptographic proof. The RPC
--        accepts a transition only when an agent_authorizations row binds
--        (agent_id, principal_identity) to this commitment+role AND the row
--        is unrevoked, unexpired, and in scope. Supplying another agent's
--        agent_id is never sufficient: the verified principal must match the
--        registry binding.
--
--   B. REVOCATION & EXPIRATION
--      - grant_agent_authorization / revoke_agent_authorization RPCs with
--        durable authorization_events audit records.
--        * No self-grant: the first registry rows are operator-provisioned
--          (owner/authority). Grants are issued by an active 'authority' or
--          'system' authorization holder for the SAME commitment (or system
--          service scope).
--        * Revoke: self-revoke allowed (the grantee proves its own
--          principal) OR authority/system revoke for the same commitment.
--        * The transition RPC re-reads the authorization row FOR UPDATE so a
--          concurrent revoke serializes before it and a revoked caller fails
--          AUTH_REVOKED on every subsequent protected operation.
--
--   C. COMPLETE IDEMPOTENCY BINDING
--      - commitment_events.op_fingerprint: canonical sha256 over
--        (commitment_id, from_state, to_state, requested_action,
--        verified_principal, agent_id, actor_role, authority_ref,
--        evidence_ref). Same ref + different fingerprint -> hard
--        IDEM_FINGERPRINT_CONFLICT before any state is disclosed.
--      - Replay (same ref + same fingerprint) skips version/terminal/
--        transition re-checks (the operation already happened) but STILL
--        requires the current caller to pass the full authorization check —
--        a revoked/expired caller can never retrieve a replayed outcome.
--
--   D. EVENT LEDGER & PRIVILEGES
--      - service_role: SELECT on tables, EXECUTE on RPCs only.
--      - Direct INSERT into commitment_events / agent_authorizations /
--        authorization_events is NOT granted to service_role — writes occur
--        exclusively through the SECURITY DEFINER RPCs (owner).
--      - No role receives UPDATE/DELETE on the ledger or registry.
--      - RLS enabled; deny-all FOR ALL TO public on all three tables.
--
-- STATE MACHINE: unchanged v1 edge set — 39 edges, exactly the canonical
-- spec/lifecycle.md §2 table (verified against the spec on 2026-11-10).
--
-- ADDITIVE ONLY vs production: no existing table/column/grant/policy/flag is
-- altered; no historical commitment is rewritten (legacy rows keep state and
-- get version=1 via DEFAULT).
--
-- FAIL-CLOSED: any invalid transition, stale version, missing/revoked/expired
-- authorization, principal mismatch, fingerprint conflict, or persistence
-- error raises. State change and event insert occur in ONE transaction.

BEGIN;

-- ===========================================================================
-- 1. Optimistic-concurrency version column (additive; DEFAULT 1 for legacy)
-- ===========================================================================
ALTER TABLE ax_router.commitments
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- ===========================================================================
-- 2. Append-only commitment event ledger (v2: + op_fingerprint)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ax_router.commitment_events (
  event_id          text        PRIMARY KEY,
  commitment_id     text        NOT NULL REFERENCES ax_router.commitments(commitment_id) ON DELETE RESTRICT,
  from_state        text        NOT NULL,
  to_state          text        NOT NULL,
  requested_action  text        NOT NULL,
  actor_identity    text        NOT NULL,
  actor_role        text        NOT NULL,
  authority_ref     text,
  event_timestamp   timestamptz NOT NULL DEFAULT now(),
  state_version     integer     NOT NULL,
  idempotency_ref   text        NOT NULL,
  evidence_ref      text,
  op_fingerprint    text        NOT NULL DEFAULT ''
);

-- Upgrade path for the v1 testbed draft (which lacked op_fingerprint).
ALTER TABLE ax_router.commitment_events
  ADD COLUMN IF NOT EXISTS op_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS commitment_events_idem_uq
  ON ax_router.commitment_events (commitment_id, idempotency_ref);

CREATE INDEX IF NOT EXISTS commitment_events_commitment_idx
  ON ax_router.commitment_events (commitment_id, event_timestamp);
CREATE INDEX IF NOT EXISTS commitment_events_state_idx
  ON ax_router.commitment_events (to_state);
CREATE INDEX IF NOT EXISTS commitment_events_fp_idx
  ON ax_router.commitment_events (commitment_id, op_fingerprint);

COMMENT ON TABLE ax_router.commitment_events IS
  'Append-only lifecycle event ledger. Rows are inserted only by transition_commitment (SECURITY DEFINER). No INSERT/UPDATE/DELETE grants exist for any role except owner. op_fingerprint canonically binds each idempotency ref to one logical operation. Postgres does not make this independently tamper-proof; protections are (a) no DML grants, (b) INSERT restricted to the RPC/owner, (c) event-chain auditability.';

-- ===========================================================================
-- 3. Durable agent-authorization registry (v2: + principal binding)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ax_router.agent_authorizations (
  authz_id          text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id          text        NOT NULL,
  principal_identity text       NOT NULL,
  commitment_id     text,
  role              text        NOT NULL CHECK (role IN
                    ('buyer','provider','evaluator','authority','system')),
  scope             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_until       timestamptz NOT NULL,
  revoked_at        timestamptz,
  revoked_by        text,
  delegation_ref    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_authz_scoped_uq UNIQUE (agent_id, commitment_id, role),
  CONSTRAINT agent_authz_principal_ck CHECK (
    principal_identity IS NOT NULL AND length(principal_identity) BETWEEN 2 AND 512
  )
);

-- Idempotent constraint refresh: CREATE TABLE IF NOT EXISTS does not alter an
-- existing table, so re-application (or upgrade from a prior draft) must
-- explicitly replace the principal-length CHECK.
ALTER TABLE ax_router.agent_authorizations
  DROP CONSTRAINT IF EXISTS agent_authz_principal_ck;
ALTER TABLE ax_router.agent_authorizations
  ADD CONSTRAINT agent_authz_principal_ck CHECK (
    principal_identity IS NOT NULL AND length(principal_identity) BETWEEN 2 AND 512
  );

CREATE UNIQUE INDEX IF NOT EXISTS agent_authz_service_uq
  ON ax_router.agent_authorizations (agent_id, role)
  WHERE commitment_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_authz_commitment_idx
  ON ax_router.agent_authorizations (commitment_id);
CREATE INDEX IF NOT EXISTS agent_authz_principal_idx
  ON ax_router.agent_authorizations (principal_identity);

COMMENT ON TABLE ax_router.agent_authorizations IS
  'Durable authorization registry binding an agent identity to a verified principal, commitment-scoped role, expiry, revocation, and scope. Replacement agents NEVER inherit another agent''s authorization: a new row (or explicit delegation_ref) is required, and each row binds the agent to the principal proven by the caller''s cryptographic proof.';

-- ===========================================================================
-- 4. Authorization audit ledger (INSERT-only; no grants to any role)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ax_router.authorization_events (
  event_id        text PRIMARY KEY,
  authz_id        text,
  agent_id        text NOT NULL,
  principal_identity text NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN
                  ('grant','revoke','expire','scope_change','transfer','other')),
  commitment_id   text,
  role            text,
  actor_agent     text NOT NULL,
  actor_role      text,
  reason          text,
  idempotency_ref text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authorization_events_authz_idx
  ON ax_router.authorization_events (authz_id);
CREATE INDEX IF NOT EXISTS authorization_events_agent_idx
  ON ax_router.authorization_events (agent_id, occurred_at);

COMMENT ON TABLE ax_router.authorization_events IS
  'Authorization audit trail. INSERT-only; no grants to any role (owner may insert via security-definer functions only). Records grant and revoke operations with actor attribution.';

-- ===========================================================================
-- 4b. operator_secrets — one-way credential hash for operator-gated actions
--      The plaintext secret lives ONLY in the operator's environment (Vercel
--      secret / console), never in code or logs. The database stores only
--      sha256. Seeding is an owner/psql action (single row, key
--      'authority_operator'). service_role gets SELECT only — it can verify
--      but not modify the hash.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ax_router.operator_secrets (
  secret_key  text PRIMARY KEY,
  secret_hash text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ax_router.operator_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ax_router.operator_secrets FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.operator_secrets FROM service_role;
GRANT SELECT ON TABLE ax_router.operator_secrets TO service_role;
DROP POLICY IF EXISTS deny_all_operator_secrets ON ax_router.operator_secrets;
CREATE POLICY deny_all_operator_secrets
  ON ax_router.operator_secrets FOR ALL TO public USING (false);

-- ===========================================================================
-- 5. transition_commitment v2 — SECURITY DEFINER, pinned search_path
-- ===========================================================================
DROP FUNCTION IF EXISTS ax_router.transition_commitment(text,text,text,text,text,text,text,text,text,text,integer);
CREATE OR REPLACE FUNCTION ax_router.transition_commitment(
  p_commitment_id    text,
  p_from_state       text,
  p_to_state         text,
  p_requested_action text,
  p_agent_id         text,
  p_verified_principal text,
  p_actor_role       text,
  p_authority_ref    text DEFAULT NULL,
  p_idempotency_ref  text DEFAULT NULL,
  p_evidence_ref     text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_row        ax_router.commitments%ROWTYPE;
  v_auth       ax_router.agent_authorizations%ROWTYPE;
  v_event      ax_router.commitment_events%ROWTYPE;
  v_idem       text;
  v_fp         text;
  v_role       text := lower(p_actor_role);
  v_actions    text[];
  v_princ      text := btrim(p_verified_principal);
  v_allowed    boolean := false;
BEGIN
  IF v_princ = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_PRINCIPAL_REQUIRED: verified principal must not be empty';
  END IF;
  v_idem := coalesce(p_idempotency_ref, 'manual:' || gen_random_uuid()::text);

  -- Canonical fingerprint over the FULL logical operation. Excludes only
  -- p_expected_version and the idempotency_ref itself.
  v_fp := encode(sha256(
    convert_to(
      p_commitment_id || '|' ||
      coalesce(p_from_state,'') || '|' ||
      p_to_state || '|' ||
      coalesce(p_requested_action,'') || '|' ||
      v_princ || '|' ||
      p_agent_id || '|' ||
      v_role || '|' ||
      coalesce(p_authority_ref,'') || '|' ||
      coalesce(p_evidence_ref,''),
      'UTF8')), 'hex');

  -- 0. Load commitment first (unknown → ST_UNKNOWN_COMMITMENT 41004).
  SELECT * INTO v_row FROM ax_router.commitments
   WHERE commitment_id = p_commitment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ST_UNKNOWN_COMMITMENT';
  END IF;

  -- 0b. Idempotency: same (commitment, idempotency_ref) already recorded?
  SELECT * INTO v_event FROM ax_router.commitment_events
   WHERE commitment_id = p_commitment_id AND idempotency_ref = v_idem;
  IF FOUND THEN
    -- Hard binding: same ref MUST be the same logical operation. A mismatch
    -- is rejected BEFORE any further state is disclosed.
    IF v_event.op_fingerprint <> v_fp THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'IDEM_FINGERPRINT_CONFLICT: idempotency ref is bound to a different operation';
    END IF;
    -- REPLAY PATH: the operation already happened. Skip version/terminal/
    -- transition re-checks, but REQUIRE the current caller to pass the full
    -- authorization check (replay-after-revocation guard) using the role
    -- recorded on the original event.
    SELECT * INTO v_auth FROM ax_router.agent_authorizations
     WHERE agent_id = p_agent_id
       AND role = v_event.actor_role
       AND principal_identity = v_princ
       AND (commitment_id = p_commitment_id
            OR (commitment_id IS NULL AND v_event.actor_role = 'system'))
     ORDER BY (commitment_id IS NULL) ASC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'AUTH_MISSING_AUTHORIZATION: no ' || v_event.actor_role || ' authorization for agent ' || p_agent_id
          || ' / principal ' || v_princ;
    END IF;
    IF v_auth.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'AUTH_REVOKED: authorization revoked at ' || v_auth.revoked_at;
    END IF;
    IF v_auth.valid_until < now() OR v_auth.valid_from > now() THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'AUTH_EXPIRED: authorization window [' || v_auth.valid_from || ',' || v_auth.valid_until || ']';
    END IF;
    IF jsonb_typeof(v_auth.scope->'actions') = 'array' THEN
      SELECT array_agg(x) INTO v_actions
        FROM jsonb_array_elements_text(v_auth.scope->'actions') AS x;
      IF array_length(v_actions, 1) IS NOT NULL
         AND NOT (v_event.requested_action = ANY(v_actions)) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'AUTH_OUT_OF_SCOPE: action ' || v_event.requested_action || ' not in scope';
      END IF;
    END IF;
    RETURN jsonb_build_object(
      'status', 'replayed',
      'event_id', v_event.event_id,
      'from_state', v_event.from_state,
      'to_state', v_event.to_state,
      'state_version', v_event.state_version);
  END IF;

  -- 2. Optimistic concurrency: caller must observe the version it planned on.
  IF p_expected_version IS NOT NULL AND v_row.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'ST_STALE_VERSION: expected ' || p_expected_version
        || ' but current version is ' || v_row.version;
  END IF;

  -- 3. Terminal-state guard.
  IF v_row.state IN ('finalized','cancelled','expired','failed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'ST_ALREADY_FINALIZED: state=' || v_row.state;
  END IF;

  -- 4. Enforce canonical transition (spec/lifecycle.md §2 — 39 edges).
  v_allowed :=
    (v_row.state = 'issued'              AND p_to_state IN ('authority_validated','accepted','cancelled','expired')) OR
    (v_row.state = 'authority_validated' AND p_to_state IN ('accepted','failed','expired')) OR
    (v_row.state = 'accepted'            AND p_to_state IN ('executing','in_flight','cancelled','expired')) OR
    (v_row.state = 'in_flight'           AND p_to_state IN ('executing','failed','expired')) OR
    (v_row.state = 'executing'           AND p_to_state IN ('evidence_pending','recovering','failed','expired')) OR
    (v_row.state = 'evidence_pending'    AND p_to_state IN ('evidence_submitted','recovering','failed')) OR
    (v_row.state = 'evidence_submitted'  AND p_to_state IN ('verifying','disputed')) OR
    (v_row.state = 'verifying'           AND p_to_state IN ('fulfilled','recovering','failed')) OR
    (v_row.state = 'fulfilled'           AND p_to_state IN ('settled','disputed')) OR
    (v_row.state = 'recovering'          AND p_to_state IN ('executing','evidence_pending','failed','fulfilled')) OR
    (v_row.state = 'disputed'            AND p_to_state IN ('executing','recovering','fulfilled','failed','settled')) OR
    (v_row.state = 'settled'             AND p_to_state IN ('finalized','disputed'));

  IF NOT v_allowed THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'ST_INVALID_TRANSITION: ' || v_row.state || ' -> ' || p_to_state;
  END IF;

  -- 5. Role requirement per (from,to) — unchanged from v1.
  IF NOT (
    (p_to_state IN ('accepted','cancelled','disputed') AND v_role = 'buyer') OR
    (p_to_state = 'authority_validated' AND v_role = 'authority') OR
    (p_to_state IN ('executing','in_flight','evidence_pending','evidence_submitted') AND v_role = 'provider') OR
    (p_to_state IN ('verifying','fulfilled') AND v_role = 'evaluator') OR
    (v_row.state = 'disputed' AND p_to_state IN ('executing','recovering','fulfilled','failed','settled') AND v_role = 'evaluator') OR
    ((p_to_state IN ('expired','failed','recovering','settled','finalized')) AND v_role = 'system') OR
    (v_row.state = 'recovering' AND p_to_state IN ('executing','evidence_pending') AND v_role = 'provider') OR
    (v_row.state = 'recovering' AND p_to_state = 'fulfilled' AND v_role = 'evaluator')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_ROLE_DENIED: role ' || v_role || ' cannot perform ' || p_to_state;
  END IF;

  -- 6. Durable authorization check — ROW LOCK (FOR UPDATE) so a concurrent
  --    revoke serializes; PRINCIPAL BINDING: p_verified_principal must equal
  --    the row's principal_identity. agent_id alone is never sufficient.
  SELECT * INTO v_auth FROM ax_router.agent_authorizations
   WHERE agent_id = p_agent_id
     AND role = v_role
     AND principal_identity = v_princ
     AND (commitment_id = p_commitment_id
          OR (commitment_id IS NULL AND v_role = 'system'))
   ORDER BY (commitment_id IS NULL) ASC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_MISSING_AUTHORIZATION: no ' || v_role || ' authorization for agent ' || p_agent_id
        || ' / principal ' || v_princ;
  END IF;
  IF v_auth.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_REVOKED: authorization revoked at ' || v_auth.revoked_at;
  END IF;
  IF v_auth.valid_until < now() OR v_auth.valid_from > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_EXPIRED: authorization window [' || v_auth.valid_from || ',' || v_auth.valid_until || ']';
  END IF;
  IF jsonb_typeof(v_auth.scope->'actions') = 'array' THEN
    SELECT array_agg(x) INTO v_actions
      FROM jsonb_array_elements_text(v_auth.scope->'actions') AS x;
    IF array_length(v_actions, 1) IS NOT NULL
       AND NOT (p_requested_action = ANY(v_actions)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'AUTH_OUT_OF_SCOPE: action ' || p_requested_action || ' not in scope';
    END IF;
  END IF;

  -- 7. Atomic transition: bump version, write event (same transaction).
  UPDATE ax_router.commitments
     SET state = p_to_state,
         version = v_row.version + 1,
         updated_at = now()
   WHERE commitment_id = p_commitment_id;

  INSERT INTO ax_router.commitment_events
    (event_id, commitment_id, from_state, to_state, requested_action,
     actor_identity, actor_role, authority_ref, event_timestamp,
     state_version, idempotency_ref, evidence_ref, op_fingerprint)
  VALUES
    ((p_commitment_id || ':' || v_idem), p_commitment_id,
     v_row.state, p_to_state, p_requested_action,
     v_princ, v_role, p_authority_ref, now(),
     v_row.version + 1, v_idem, p_evidence_ref, v_fp);

  RETURN jsonb_build_object(
    'status', 'transitioned',
    'commitment_id', p_commitment_id,
    'from_state', v_row.state,
    'to_state', p_to_state,
    'state_version', v_row.version + 1,
    'event_id', (p_commitment_id || ':' || v_idem));
END;
$function$;

-- ===========================================================================
-- 6. grant_agent_authorization — SECURITY DEFINER
-- ===========================================================================
CREATE OR REPLACE FUNCTION ax_router.grant_agent_authorization(
  p_authorizer_agent     text,
  p_authorizer_principal text,
  p_authorizer_role      text,
  p_subject_agent        text,
  p_subject_principal    text,
  p_commitment_id        text,
  p_role                 text,
  p_scope                jsonb DEFAULT '{}'::jsonb,
  p_valid_from           timestamptz DEFAULT now(),
  p_valid_until          timestamptz DEFAULT NULL,
  p_idempotency_ref      text DEFAULT NULL,
  p_delegation_ref       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_authz_id   text;
  v_authorizer ax_router.agent_authorizations%ROWTYPE;
  v_role       text := lower(p_role);
  v_valid      timestamptz := coalesce(p_valid_until, now() + interval '30 days');
  v_princ      text := btrim(p_subject_principal);
  v_event_id   text;
BEGIN
  IF v_role = 'system' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_SYSTEM_GRANT_DENIED: system-scope grants are operator-provisioned only';
  END IF;
  IF p_commitment_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_SYSTEM_GRANT_DENIED: service-scope grants are operator-provisioned only';
  END IF;
  IF v_princ = '' OR btrim(p_authorizer_principal) = '' OR p_subject_agent = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_BAD_REQUEST: subject/authorizer agent and principal are required';
  END IF;
  IF v_valid <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_BAD_REQUEST: valid_until must be in the future';
  END IF;
  IF v_role NOT IN ('buyer','provider','evaluator','authority') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_BAD_REQUEST: grantable roles are buyer|provider|evaluator|authority';
  END IF;

  -- Authorizer must hold an unrevoked, unexpired 'authority' or 'system'
  -- authorization for the SAME commitment (or service-scope 'system').
  -- No self-grant: without commitment-participant columns, an unrestricted
  -- self-grant would let any agent claim any role on any commitment.
  -- First-row provisioning is an operator/authority action (matching SAAX's
  -- manual-approval model for pilot wallets).
  SELECT * INTO v_authorizer FROM ax_router.agent_authorizations
   WHERE agent_id = p_authorizer_agent
     AND principal_identity = btrim(p_authorizer_principal)
     AND ( (commitment_id = p_commitment_id AND role IN ('authority','system'))
           OR (commitment_id IS NULL AND role = 'system') )
     AND revoked_at IS NULL AND valid_until > now() AND valid_from <= now()
   LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_GRANT_DENIED: authorizer lacks authority/system authorization for commitment';
  END IF;

  INSERT INTO ax_router.agent_authorizations
    (agent_id, principal_identity, commitment_id, role, scope,
     valid_from, valid_until, delegation_ref)
  VALUES
    (p_subject_agent, v_princ, p_commitment_id, v_role, coalesce(p_scope,'{}'::jsonb),
     coalesce(p_valid_from, now()), v_valid, coalesce(p_delegation_ref, p_idempotency_ref))
  ON CONFLICT (agent_id, commitment_id, role) DO UPDATE
    SET scope = EXCLUDED.scope,
        valid_from = EXCLUDED.valid_from,
        valid_until = EXCLUDED.valid_until,
        revoked_at = NULL,
        revoked_by = NULL,
        delegation_ref = EXCLUDED.delegation_ref
  RETURNING authz_id INTO v_authz_id;

  -- Idempotent grant event: a re-grant with the SAME idempotency_ref (same
  -- logical provisioning operation) must not emit a duplicate audit row.
  v_event_id := 'ga:' || coalesce(p_idempotency_ref, gen_random_uuid()::text);
  PERFORM 1 FROM ax_router.authorization_events
   WHERE event_id = v_event_id AND authz_id = v_authz_id AND event_type = 'grant';
  IF NOT FOUND THEN
    INSERT INTO ax_router.authorization_events
      (event_id, authz_id, agent_id, principal_identity, event_type,
       commitment_id, role, actor_agent, actor_role, reason, idempotency_ref)
    VALUES
      (v_event_id,
       v_authz_id, p_subject_agent, v_princ, 'grant',
       p_commitment_id, v_role, p_authorizer_agent, lower(p_authorizer_role),
       'granted by ' || p_authorizer_agent, coalesce(p_idempotency_ref, gen_random_uuid()::text));
  END IF;

  RETURN jsonb_build_object('status','granted','authz_id',v_authz_id);
END;
$function$;

-- ===========================================================================
-- 7. revoke_agent_authorization — SECURITY DEFINER
-- ===========================================================================
CREATE OR REPLACE FUNCTION ax_router.revoke_agent_authorization(
  p_authorizer_agent     text,
  p_authorizer_principal text,
  p_authorizer_role      text,
  p_authz_id             text,
  p_reason               text DEFAULT 'revoked',
  p_idempotency_ref      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_authz      ax_router.agent_authorizations%ROWTYPE;
  v_authorizer ax_router.agent_authorizations%ROWTYPE;
  v_princ      text := btrim(p_authorizer_principal);
  v_idem       text := coalesce(p_idempotency_ref, 'rev:' || gen_random_uuid()::text);
BEGIN
  SELECT * INTO v_authz FROM ax_router.agent_authorizations
   WHERE authz_id = p_authz_id
   LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_UNKNOWN_AUTHORIZATION';
  END IF;

  IF v_authz.agent_id = p_authorizer_agent AND v_authz.principal_identity = v_princ THEN
    NULL; -- self-revoke allowed
  ELSE
    SELECT * INTO v_authorizer FROM ax_router.agent_authorizations
     WHERE agent_id = p_authorizer_agent
       AND principal_identity = v_princ
       AND ( (commitment_id = v_authz.commitment_id AND role IN ('authority','system'))
             OR (commitment_id IS NULL AND role = 'system') )
       AND revoked_at IS NULL AND valid_until > now() AND valid_from <= now()
     LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'AUTH_REVOKE_DENIED: caller has no authority to revoke this authorization';
    END IF;
  END IF;

  IF v_authz.revoked_at IS NOT NULL THEN
    PERFORM 1 FROM ax_router.authorization_events
     WHERE idempotency_ref = v_idem AND authz_id = v_authz.authz_id AND event_type = 'revoke';
    IF FOUND THEN
      RETURN jsonb_build_object('status','replayed','authz_id',v_authz.authz_id,'revoked_at',v_authz.revoked_at);
    END IF;
    RETURN jsonb_build_object('status','already_revoked','authz_id',v_authz.authz_id,'revoked_at',v_authz.revoked_at);
  END IF;

  UPDATE ax_router.agent_authorizations
     SET revoked_at = now(), revoked_by = p_authorizer_agent
   WHERE authz_id = v_authz.authz_id;

  INSERT INTO ax_router.authorization_events
    (event_id, authz_id, agent_id, principal_identity, event_type,
     commitment_id, role, actor_agent, actor_role, reason, idempotency_ref)
  VALUES
    (('rv:' || v_idem || ':' || v_authz.authz_id), v_authz.authz_id, v_authz.agent_id, v_authz.principal_identity,
     'revoke', v_authz.commitment_id, v_authz.role,
     p_authorizer_agent, lower(p_authorizer_role), p_reason, v_idem);

  RETURN jsonb_build_object('status','revoked','authz_id',v_authz.authz_id,'revoked_at',now());
END;
$function$;

-- ===========================================================================
-- 7b. provision_authority — SECURITY DEFINER (operator bootstrap)
--      First-row provisioning for the SAAX manual-approval model. Grants the
--      caller's OWN identity an 'authority' (or 'system') authorization for a
--      commitment (or service scope). Intended to be called ONCE per
--      commitment by the operator's verified principal; afterwards, all
--      buyer/provider/evaluator rows flow through grant_agent_authorization
--      (which itself requires an active authority/system authorizer).
--      p_operator_token is a call-time gate: the APPLICATION must supply a
--      server-side secret (compare via constant-time) so a plain service-role
--      holder cannot self-provision authority. Defaults NULL => denied.
-- ===========================================================================
CREATE OR REPLACE FUNCTION ax_router.provision_authority(
  p_agent_id             text,
  p_verified_principal   text,
  p_commitment_id        text DEFAULT NULL,
  p_role                 text DEFAULT 'authority',
  p_scope                jsonb DEFAULT '{}'::jsonb,
  p_valid_until          timestamptz DEFAULT NULL,
  p_operator_token       text DEFAULT NULL,
  p_idempotency_ref      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ax_router, public
AS $function$
DECLARE
  v_authz_id text;
  v_role     text := lower(p_role);
  v_valid    timestamptz := coalesce(p_valid_until, now() + interval '30 days');
  v_princ    text := btrim(p_verified_principal);
  v_hash     text;
  v_event_id text;
BEGIN
  IF v_princ = '' OR p_agent_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_BAD_REQUEST: agent and principal are required';
  END IF;
  IF v_role NOT IN ('authority','system') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'AUTH_BAD_REQUEST: provision_authority accepts authority|system only';
  END IF;
  IF v_valid <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_BAD_REQUEST: valid_until must be in the future';
  END IF;

  -- Operator gate: compare sha256(secret) against the stored hash. The
  -- plaintext secret is held only in the operator's environment; the DB
  -- stores a one-way hash (operator_secrets row seeded by owner/psql).
  -- Equality over SHA-256 digests is standard for this purpose; the app
  -- layer must additionally enforce that only the gateway may call this.
  IF p_operator_token IS NULL OR length(p_operator_token) < 16 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_OPERATOR_TOKEN_REQUIRED';
  END IF;
  SELECT secret_hash INTO v_hash FROM ax_router.operator_secrets
   WHERE secret_key = 'authority_operator';
  IF NOT FOUND OR encode(sha256(convert_to(p_operator_token,'UTF8')), 'hex') <> v_hash THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTH_OPERATOR_TOKEN_INVALID';
  END IF;

  INSERT INTO ax_router.agent_authorizations
    (agent_id, principal_identity, commitment_id, role, scope,
     valid_from, valid_until, delegation_ref)
  VALUES
    (p_agent_id, v_princ, p_commitment_id, v_role, coalesce(p_scope,'{}'::jsonb),
     now(), v_valid, 'operator-provisioned:' || coalesce(p_idempotency_ref,'bootstrap'))
  ON CONFLICT (agent_id, commitment_id, role) DO UPDATE
    SET scope = EXCLUDED.scope,
        valid_until = EXCLUDED.valid_until,
        revoked_at = NULL,
        revoked_by = NULL
  RETURNING authz_id INTO v_authz_id;

  v_event_id := 'pv:' || coalesce(p_idempotency_ref, gen_random_uuid()::text);
  PERFORM 1 FROM ax_router.authorization_events
   WHERE event_id = v_event_id AND authz_id = v_authz_id AND event_type = 'grant';
  IF NOT FOUND THEN
    INSERT INTO ax_router.authorization_events
      (event_id, authz_id, agent_id, principal_identity, event_type,
       commitment_id, role, actor_agent, actor_role, reason, idempotency_ref)
    VALUES
      (v_event_id,
       v_authz_id, p_agent_id, v_princ, 'grant',
       p_commitment_id, v_role, p_agent_id, 'operator',
       'operator-provisioned authority', coalesce(p_idempotency_ref, gen_random_uuid()::text));
  END IF;

  RETURN jsonb_build_object('status','provisioned','authz_id',v_authz_id);
END;
$function$;

-- ===========================================================================
-- 8. Privileges — service_role only; SELECT+EXECUTE; NO table DML
-- ===========================================================================
REVOKE ALL ON FUNCTION ax_router.transition_commitment(text,text,text,text,text,text,text,text,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.grant_agent_authorization(text,text,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.revoke_agent_authorization(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ax_router.provision_authority(text,text,text,text,jsonb,timestamptz,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ax_router.transition_commitment(text,text,text,text,text,text,text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.grant_agent_authorization(text,text,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.revoke_agent_authorization(text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION ax_router.provision_authority(text,text,text,text,jsonb,timestamptz,text,text) TO service_role;

-- Event ledger: service_role SELECT only. NO INSERT/UPDATE/DELETE.
ALTER TABLE ax_router.commitment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ax_router.commitment_events FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.commitment_events FROM service_role;
GRANT SELECT ON TABLE ax_router.commitment_events TO service_role;

-- Agent registry: service_role SELECT only. NO INSERT/UPDATE/DELETE.
ALTER TABLE ax_router.agent_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ax_router.agent_authorizations FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.agent_authorizations FROM service_role;
GRANT SELECT ON TABLE ax_router.agent_authorizations TO service_role;

-- Authorization audit ledger: service_role SELECT only. NO INSERT/UPDATE/DELETE.
ALTER TABLE ax_router.authorization_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ax_router.authorization_events FROM PUBLIC;
REVOKE ALL ON TABLE ax_router.authorization_events FROM service_role;
GRANT SELECT ON TABLE ax_router.authorization_events TO service_role;

-- RLS policies: deny-everything for public/anon/authenticated (the SECURITY
-- DEFINER functions bypass RLS as owner). service_role reads via its
-- BYPASSRLS attribute + SELECT grant.
DROP POLICY IF EXISTS deny_all_commitment_events ON ax_router.commitment_events;
CREATE POLICY deny_all_commitment_events
  ON ax_router.commitment_events FOR ALL TO public USING (false);
DROP POLICY IF EXISTS deny_all_agent_authorizations ON ax_router.agent_authorizations;
CREATE POLICY deny_all_agent_authorizations
  ON ax_router.agent_authorizations FOR ALL TO public USING (false);
DROP POLICY IF EXISTS deny_all_authorization_events ON ax_router.authorization_events;
CREATE POLICY deny_all_authorization_events
  ON ax_router.authorization_events FOR ALL TO public USING (false);

-- PostgREST schema-cache refresh.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK (documented; run ONLY in isolated/test environments unless
-- separately approved for production):
--
--   DROP FUNCTION IF EXISTS ax_router.revoke_agent_authorization(text,text,text,text,text,text);
--   DROP FUNCTION IF EXISTS ax_router.grant_agent_authorization(text,text,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text);
--   DROP FUNCTION IF EXISTS ax_router.transition_commitment(text,text,text,text,text,text,text,text,text,text,integer);
--   DROP TABLE IF EXISTS ax_router.authorization_events;
--   DROP TABLE IF EXISTS ax_router.agent_authorizations;
--   DROP TABLE IF EXISTS ax_router.commitment_events;
--   ALTER TABLE ax_router.commitments DROP COLUMN IF EXISTS version;
--
-- Forward-recovery note: if commitment_events / authorization_events have
-- accrued rows at rollback time, dropping the tables destroys audit evidence.
-- Preferred forward path: keep tables, REVOKE EXECUTE on the RPCs to halt new
-- transitions/grants, reconcile states, and only then re-apply or drop.
-- ---------------------------------------------------------------------------