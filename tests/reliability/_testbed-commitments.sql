-- Gate D testbed: ax_router.commitments mirroring the production schema.
-- Column types/order and indexes read from the live project (read-only
-- information_schema / pg_indexes queries) so the isolated testbed reproduces
-- production shape. Testbed only — never applied to production.
CREATE TABLE IF NOT EXISTS ax_router.commitments (
  commitment_id text PRIMARY KEY,
  state         text,
  capability    text,
  buyer_email   text,
  terms         jsonb,
  authority_ref text,
  evidence_refs jsonb,
  settlement_ref text,
  manifest_hash text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commitments_buyer_email_idx ON ax_router.commitments (buyer_email);
CREATE INDEX IF NOT EXISTS commitments_state_idx ON ax_router.commitments (state);
