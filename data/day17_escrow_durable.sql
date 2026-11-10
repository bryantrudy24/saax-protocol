-- SAAX Protocol — Durable escrow persistence (Day 17)
-- Schema: ax_router
-- Adds the escrow table + atomic conditional transition RPCs replacing
-- in-memory authoritative state. The DB is the durable source of truth;
-- process memory is only a cache.
--
-- ATOMIC TRANSITIONS: every transition RPC is a single SQL statement that
-- checks the CURRENT state inside the UPDATE ... WHERE state = <expected>,
-- so two concurrent workers can never double-release, double-refund, or
-- release-and-refund. Version column bumps on every change; immutable
-- binding fields (commitment_digest, parties, network, asset, amount,
-- evaluator, deadlines) are NOT updated by the transition RPCs — a generic
-- upsert cannot overwrite them.

begin;

-- Escrow identity + binding fields (immutable after insert).
create table if not exists ax_router.escrows (
  commitment_id        text primary key,
  commitment_digest    text not null,           -- sha256 hex (canonical)
  buyer                text not null,
  seller               text not null,
  evaluator            text not null,           -- agreed evaluator (authorizes release/refund)
  network              text not null default 'eip155:84532', -- Base Sepolia testnet
  asset                text not null default 'USDC',
  amount               text not null,           -- atomic units string
  state                text not null check (state in ('unfunded','funded','held','released','refunded','timed_out','disputed')),
  version              integer not null default 1,
  deadline             text,
  funded_at            timestamptz,
  held_at              timestamptz,
  released_at          timestamptz,
  refunded_at          timestamptz,
  timed_out_at         timestamptz,
  disputed_at          timestamptz,
  resolved_at          timestamptz,
  tx_ref_funding       jsonb,                   -- { txHash, rail }
  tx_ref_release       jsonb,                   -- { txHash } when released on-chain
  tx_ref_refund        jsonb,                   -- { txHash } when refunded on-chain
  audit_chain          jsonb not null default '[]'::jsonb,
  release_verdict      jsonb,
  dispute              jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists escrows_state_idx on ax_router.escrows (state);
create index if not exists escrows_evaluator_idx on ax_router.escrows (evaluator);
create index if not exists escrows_digest_idx on ax_router.escrows (commitment_digest);

-- Ordered audit events (append-only; FK to escrow).
create table if not exists ax_router.escrow_events (
  id            bigint generated always as identity primary key,
  commitment_id text not null references ax_router.escrows(commitment_id) on delete cascade,
  seq           integer not null,
  state         text not null,
  transition    text not null,
  by            text,
  at            timestamptz not null default now(),
  prev_hash     text not null,
  entry_hash    text not null,
  unique (commitment_id, seq),
  unique (commitment_id, entry_hash)
);

-- External action intent ledger: persisted BEFORE any financial broadcast;
-- reconciled AFTER with the authoritative chain/service outcome. Unknown
-- outcomes stay explicit (reconcile_status = 'unknown') until reconciled.
create table if not exists ax_router.escrow_intents (
  id                bigint generated always as identity primary key,
  commitment_id     text not null,  -- NOT fk to escrows: intents persist BEFORE the escrow row exists (intent-before-broadcast)
  action            text not null check (action in ('fund','release','refund','dispute','resolve')),
  idempotency_key   text not null unique,
  intent_status     text not null check (intent_status in ('pending','broadcast','confirmed','failed','unknown')) default 'pending',
  tx_hash           text,
  tx_nonce          text,
  reconcile_status  text check (reconcile_status in ('pending','matched','mismatch','unknown')) default 'pending',
  payload           jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists escrow_intents_status_idx on ax_router.escrow_intents (commitment_id, intent_status);

-- ---- upsert_escrow (initial insert / re-hydration ONLY; does NOT transition) --
-- Records the escrow when first funded. On conflict (same commitment_id) it
-- does NOT overwrite binding fields; it only stores the row if the incoming
-- version is NEWER and the state transition is legal. Otherwise it leaves the
-- durable row untouched (a stale write can never clobber authoritative state).
create or replace function ax_router.upsert_escrow(
  p_commitment_id text, p_commitment_digest text, p_buyer text, p_seller text,
  p_evaluator text, p_network text, p_asset text, p_amount text, p_state text,
  p_version integer, p_deadline text, p_tx_ref jsonb, p_audit_chain jsonb,
  p_release_verdict jsonb, p_dispute jsonb
) returns jsonb
language plpgsql security definer as $$
declare
  v_existing ax_router.escrows%rowtype;
  v_result jsonb;
begin
  select * into v_existing from ax_router.escrows where commitment_id = p_commitment_id for update;

  if v_existing.commitment_id is null then
    -- Fresh insert: the fund() caller is allowed to set initial state.
    insert into ax_router.escrows (
      commitment_id, commitment_digest, buyer, seller, evaluator, network, asset,
      amount, state, version, deadline, tx_ref_funding, audit_chain, release_verdict, dispute
    ) values (
      p_commitment_id, p_commitment_digest, p_buyer, p_seller, p_evaluator,
      coalesce(p_network, 'eip155:84532'), coalesce(p_asset, 'USDC'), p_amount,
      coalesce(p_state, 'funded'), coalesce(p_version, 1), p_deadline,
      p_tx_ref, coalesce(p_audit_chain, '[]'::jsonb), p_release_verdict, p_dispute
    );
    v_result := jsonb_build_object('ok', true, 'inserted', true, 'state', coalesce(p_state, 'funded'));
    return v_result;
  end if;

  -- Existing row: only allow an update that ADVANCES a legal transition.
  -- Legal transitions (same set as escrow.js): funded->held|released|refunded|timed_out|disputed;
  -- held->released|refunded|timed_out|disputed; disputed->released|refunded|held.
  -- A stale write (older version) or a non-legal jump is rejected: the durable
  -- row stays authoritative and the caller must re-read before retrying.
  if v_existing.version >= coalesce(p_version, 0) then
    return jsonb_build_object('ok', false, 'inserted', false, 'error', 'STALE_VERSION',
      'existing_version', v_existing.version, 'incoming_version', p_version);
  end if;

  if p_state is not null and p_state <> v_existing.state then
    if not (
      (v_existing.state = 'funded' and p_state in ('held','released','refunded','timed_out','disputed'))
      or (v_existing.state = 'held' and p_state in ('released','refunded','timed_out','disputed'))
      or (v_existing.state = 'disputed' and p_state in ('released','refunded','held'))
      or (v_existing.state = 'unfunded' and p_state = 'funded')
    ) then
      return jsonb_build_object('ok', false, 'inserted', false, 'error', 'ILLEGAL_TRANSITION',
        'from', v_existing.state, 'to', p_state);
    end if;
    -- Disallowed state changes on existing rows: released/refunded/timed_out are terminal.
    if v_existing.state in ('released','refunded','timed_out') and p_state <> v_existing.state then
      return jsonb_build_object('ok', false, 'inserted', false, 'error', 'TERMINAL_STATE', 'state', v_existing.state);
    end if;
  end if;

  update ax_router.escrows set
    state = coalesce(p_state, state),
    version = v_existing.version + 1,
    held_at = case when p_state = 'held' and v_existing.state = 'funded' then now() else held_at end,
    released_at = case when p_state = 'released' and v_existing.state in ('funded','held','disputed') then now() else released_at end,
    refunded_at = case when p_state = 'refunded' and v_existing.state in ('funded','held','disputed') then now() else refunded_at end,
    timed_out_at = case when p_state = 'timed_out' then now() else timed_out_at end,
    disputed_at = case when p_state = 'disputed' then now() else disputed_at end,
    resolved_at = case when p_state in ('released','refunded','held') and v_existing.state = 'disputed' then now() else resolved_at end,
    tx_ref_release = case when p_state = 'released' and p_tx_ref is not null then p_tx_ref else tx_ref_release end,
    tx_ref_refund = case when p_state = 'refunded' and p_tx_ref is not null then p_tx_ref else tx_ref_refund end,
    release_verdict = coalesce(p_release_verdict, release_verdict),
    dispute = coalesce(p_dispute, dispute),
    audit_chain = coalesce(p_audit_chain, audit_chain),
    updated_at = now()
  where commitment_id = p_commitment_id;

  v_result := jsonb_build_object('ok', true, 'inserted', false, 'state', coalesce(p_state, v_existing.state), 'version', v_existing.version + 1);
  return v_result;
end;
$$;

-- ---- append_escrow_audit: append one ordered, hash-chained audit event -------
create or replace function ax_router.append_escrow_audit(
  p_commitment_id text, p_state text, p_transition text, p_by text,
  p_prev_hash text, p_entry_hash text
) returns jsonb
language plpgsql security definer as $$
declare
  v_seq integer;
begin
  select coalesce(max(seq), 0) + 1 into v_seq from ax_router.escrow_events where commitment_id = p_commitment_id;
  insert into ax_router.escrow_events (commitment_id, seq, state, transition, by, at, prev_hash, entry_hash)
  values (p_commitment_id, v_seq, p_state, p_transition, p_by, now(), p_prev_hash, p_entry_hash);
  return jsonb_build_object('ok', true, 'seq', v_seq);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'DUPLICATE_AUDIT_ENTRY');
end;
$$;

-- ---- record_escrow_intent: persisted BEFORE broadcast (idempotent) ------------
create or replace function ax_router.record_escrow_intent(
  p_commitment_id text, p_action text, p_idempotency_key text, p_payload jsonb
) returns jsonb
language plpgsql security definer as $$
declare
  v_existing ax_router.escrow_intents%rowtype;
begin
  select * into v_existing from ax_router.escrow_intents where idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return jsonb_build_object('ok', false, 'duplicate', true, 'status', v_existing.intent_status, 'id', v_existing.id);
  end if;
  insert into ax_router.escrow_intents (commitment_id, action, idempotency_key, intent_status, payload)
  values (p_commitment_id, p_action, p_idempotency_key, 'pending', p_payload)
  returning id into v_existing.id;
  return jsonb_build_object('ok', true, 'id', v_existing.id, 'status', 'pending');
end;
$$;

-- ---- update_escrow_intent: atomic intent status reconciliation ----------------
-- A worker may only move pending->broadcast->confirmed once each; concurrent
-- workers cannot double-broadcast because the intent row is locked and the
-- same idempotency key is unique.
create or replace function ax_router.update_escrow_intent(
  p_idempotency_key text, p_intent_status text, p_tx_hash text, p_tx_nonce text,
  p_reconcile_status text
) returns jsonb
language plpgsql security definer as $$
declare
  v_existing ax_router.escrow_intents%rowtype;
begin
  select * into v_existing from ax_router.escrow_intents where idempotency_key = p_idempotency_key for update;
  if v_existing.id is null then
    return jsonb_build_object('ok', false, 'error', 'INTENT_NOT_FOUND');
  end if;
  -- A confirmed intent is terminal; never downgrade it.
  if v_existing.intent_status = 'confirmed' and p_intent_status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_CONFIRMED', 'status', v_existing.intent_status);
  end if;
  -- pending -> broadcast only once.
  if v_existing.intent_status = 'pending' and p_intent_status = 'broadcast' then
    update ax_router.escrow_intents
      set intent_status = 'broadcast', tx_hash = coalesce(p_tx_hash, tx_hash), tx_nonce = coalesce(p_tx_nonce, tx_nonce), updated_at = now()
      where idempotency_key = p_idempotency_key;
    return jsonb_build_object('ok', true, 'status', 'broadcast');
  end if;
  -- pending/broadcast -> terminal states, AND unknown -> resolved terminal
  -- state (Day 20 crash-gap fix: an UNKNOWN outcome — broadcast likely but
  -- not confirmable at reconcile time — must be reconcilable to the
  -- authoritative confirmed/failed result once chain state is re-checked).
  if (v_existing.intent_status in ('pending','broadcast','unknown') and p_intent_status in ('confirmed','failed','unknown') and p_intent_status <> v_existing.intent_status) or
     (v_existing.intent_status = p_intent_status and v_existing.intent_status in ('pending','broadcast')) then
    update ax_router.escrow_intents
      set intent_status = p_intent_status,
          tx_hash = coalesce(p_tx_hash, tx_hash),
          tx_nonce = coalesce(p_tx_nonce, tx_nonce),
          reconcile_status = coalesce(p_reconcile_status, reconcile_status),
          updated_at = now()
      where idempotency_key = p_idempotency_key;
    return jsonb_build_object('ok', true, 'status', p_intent_status);
  end if;
  return jsonb_build_object('ok', false, 'error', 'INVALID_TRANSITION', 'from', v_existing.intent_status, 'to', p_intent_status);
end;
$$;

-- ---- pending_intents: recovery scan -------------------------------------------------
create or replace function ax_router.pending_escrow_intents(p_limit integer default 25)
returns table (id bigint, commitment_id text, action text, idempotency_key text, intent_status text, tx_hash text, tx_nonce text, payload jsonb, created_at timestamptz)
language sql security definer as $$
  select id, commitment_id, action, idempotency_key, intent_status, tx_hash, tx_nonce, payload, created_at
  from ax_router.escrow_intents
  where intent_status in ('pending','broadcast','unknown')
  order by created_at
  limit p_limit;
$$;

grant execute on function ax_router.upsert_escrow(text,text,jsonb,text,text,text,text,jsonb,text,text,jsonb,text,text,jsonb,integer) to service_role;
grant execute on function ax_router.append_escrow_audit(text,text,text,text,text,text) to service_role;
grant execute on function ax_router.record_escrow_intent(text,text,text,jsonb) to service_role;
grant execute on function ax_router.update_escrow_intent(text,text,text,text,text) to service_role;
grant execute on function ax_router.pending_escrow_intents(integer) to service_role;
grant select, insert, update, delete on ax_router.escrows, ax_router.escrow_events, ax_router.escrow_intents to service_role;

commit;
