-- Rail-neutral receipt lookup: commitment_id linked to a txHash via settlement_ref->'txHash'.
-- Reads the EXISTING commitments store. Additive; no settlement path changes.
create or replace function ax_router.lookup_receipt_by_txhash(p_txhash text)
returns table (
  commitment_id text,
  state text,
  capability text,
  buyer_email text,
  terms jsonb,
  authority_ref text,
  evidence_refs jsonb,
  settlement_ref text,
  manifest_hash text,
  created_at timestamptz
)
language sql
security definer
as $$
  select commitment_id, state, capability, buyer_email, terms, authority_ref, evidence_refs, settlement_ref, manifest_hash, created_at
  from ax_router.commitments
  where settlement_ref is not null
    and settlement_ref::jsonb->>'txHash' = p_txhash
  order by created_at desc
  limit 1;
$$;
grant execute on function ax_router.lookup_receipt_by_txhash(text) to anon, authenticated;
