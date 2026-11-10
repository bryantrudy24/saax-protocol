// SAAX Protocol — commitment persistence adapter (CJS).
//
// Persists commitments issued by gateway.commitmentFlow.issueFromPayload into
// the Supabase ax_router.commitments table via the upsert_commitment RPC.
//
// Design notes:
//  - Mirrors endpoint/store.js's PostgREST client pattern (schema-scoped
//    requests via Accept-Profile/Content-Profile, SUPABASE_URL + anon key).
//    store.js uses the 'saax_router' schema by default; the commitments RPCs
//    live there and are granted EXECUTE to anon, so the anon key suffices for
//    BOTH writes (upsert) and reads (lookups).
//  - Reliability remediation (F-4, approved): persistence is now STRICT and
//    is awaited by the caller BEFORE the payment challenge is presented. A
//    commitment that is not durably persisted must not be presented as
//    successful creation, and a lost response must never produce a duplicate
//    commitment. Reconcile-before-respond is achieved by a DETERMINISTIC
//    commitment ID (derived from the request scope) + lookup-by-id: a retry
//    after a lost response re-derives the same ID, looks it up, and either
//    reuses the existing row or re-upserts the same row (PK-atomic, no
//    duplicate). `persistCommitment` now returns an explicit {ok, status,
//    error, recovered, existing} result instead of swallowing failures.
const STORE_BASE_URL = (process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || '').trim();
const STORE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY || '';
const SCHEMA = 'ax_router';

// Domain-separated deterministic commitment-ID derivation (reconcile-before-
// respond, F-4). The scope is the same identity the idempotency gate uses
// (buyer + capability + budget + deadline + nonce + extra), so an identical
// retry re-derives the SAME commitment ID and can reconcile to the existing
// row instead of issuing a duplicate. The "saax:commitment:v1" namespace
// keeps these IDs disjoint from idempotency-key hashes (`der:`) and nonce
// keys (`nonce:`), so no identifier class can collide with another.
const crypto = require('crypto');
function deterministicCommitmentId(scope) {
  const material = 'saax:commitment:v1:' + String(scope || '').replace(/^der:/, '');
  return '0x' + crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}
function commitmentScopeFromKey(idempotencyKey) {
  // The gateway passes the exact key the gate used (client-supplied or
  // derived). Reuse it verbatim inside the namespace so the reconcile is
  // stable across retries.
  return String(idempotencyKey || '');
}

// Minimal schema-scoped PostgREST client (same shape store.js builds).
function buildClient() {
  const base = String(STORE_BASE_URL).trim().replace(/\/+$/, '');
  const isPlatform = /supabase\.co/i.test(base);
  const PREFIX = isPlatform ? '/rest/v1' : '';
  const headers = {
    apikey: STORE_KEY,
    Authorization: 'Bearer ' + STORE_KEY,
    'Accept-Profile': SCHEMA,
    'Content-Profile': SCHEMA,
    'Content-Type': 'application/json',
  };
  return {
    async rpc(fn, params) {
      const res = await fetch(base + PREFIX + '/rpc/' + fn, {
        method: 'POST',
        headers,
        body: JSON.stringify(params || {}),
      });
      if (res.status >= 400) {
        const txt = (await res.text()).slice(0, 300);
        return { data: null, error: new Error('RPC ' + fn + ' -> ' + res.status + ' ' + txt) };
      }
      const body = await res.json();
      return { data: body, error: null };
    },
  };
}

function isConfigured() {
  return !!(STORE_BASE_URL && STORE_KEY);
}

// Persist a commitment row. Strict: this is awaited by route-server BEFORE a
// payment challenge is presented (F-4). Returns an explicit result:
//   { ok:true, data, recovered:false }                          fresh insert/upsert
//   { ok:true, data, recovered:true, existing:true }            row already present (reconcile)
//   { ok:false, error, retryable:true|false }                   failure; caller must NOT
//                                                               present a payment challenge
// Ambiguous DB outcomes (network error mid-write) set retryable:true and the
// caller responds 503 with guidance to retry — the deterministic ID + PK
// upsert guarantee the retry reconciles instead of duplicating.
async function persistCommitment({ commitmentId, state, capability, buyerEmail, terms, authorityRef, evidenceRefs, settlementRef, manifestHash }) {
  if (!isConfigured()) {
    return { ok: false, retryable: false, error: 'commitment persistence unavailable: SUPABASE_URL/SUPABASE_ANON_KEY not configured' };
  }
  try {
    const client = buildClient();
    const { data, error } = await client.rpc('upsert_commitment', {
      p_commitment_id: commitmentId,
      p_state: state || 'issued',
      p_capability: capability,
      p_buyer_email: buyerEmail,
      p_terms: terms || {},
      p_authority_ref: authorityRef,
      p_evidence_refs: (evidenceRefs && evidenceRefs.length) ? evidenceRefs : [],
      p_settlement_ref: settlementRef,
      p_manifest_hash: manifestHash,
    });
    if (error) throw error;
    return { ok: true, data, recovered: false };
  } catch (e) {
    console.error('[commitment-store] upsert_commitment failed:', e.message);
    return { ok: false, retryable: true, error: e.message };
  }
}

// Look up a commitment row by ID (reconcile-before-respond, F-4). Non-throwing
//   { ok:true, row }    found (row is the commitment record or null)
//   { ok:false, error } lookup itself failed (store unavailable) — caller
//                       treats as UNKNOWN and fails closed with retry guidance.
async function lookupCommitmentById(commitmentId) {
  if (!isConfigured()) {
    return { ok: false, error: 'commitment lookup unavailable: SUPABASE_URL/SUPABASE_ANON_KEY not configured' };
  }
  try {
    const client = buildClient();
    const { data, error } = await client.rpc('lookup_commitment_by_id', { p_commitment_id: commitmentId });
    if (error) throw error;
    const row = Array.isArray(data) && data.length > 0 ? data[0] : (data || null);
    return { ok: true, row };
  } catch (e) {
    console.error('[commitment-store] lookup_commitment_by_id failed:', e.message);
    return { ok: false, retryable: true, error: e.message };
  }
}

// Persist the settlement linkage on an already-issued commitment row.
//
// upsert_commitment is a FULL-COLUMN upsert: on conflict it overwrites every
// column with the passed values. A partial re-upsert would wipe the row's
// other fields (state, terms, buyer_email, ...). So this replays the complete
// issuance record with settlementRef added — the safe, additive form.
async function persistSettlementRef({ commitmentId, state, capability, buyerEmail, terms, authorityRef, evidenceRefs, settlementRef, manifestHash }) {
  if (!isConfigured()) return { ok: false, error: 'commitment persistence skipped: SUPABASE_URL/SUPABASE_ANON_KEY not configured' };
  if (!commitmentId || !settlementRef) return { ok: false, error: 'commitmentId and settlementRef are required' };
  try {
    const client = buildClient();
    const { data, error } = await client.rpc('upsert_commitment', {
      p_commitment_id: commitmentId,
      p_state: state || 'issued',
      p_capability: capability,
      p_buyer_email: buyerEmail,
      p_terms: terms || {},
      p_authority_ref: authorityRef,
      p_evidence_refs: (evidenceRefs && evidenceRefs.length) ? evidenceRefs : [],
      p_settlement_ref: typeof settlementRef === 'string' ? settlementRef : JSON.stringify(settlementRef),
      p_manifest_hash: manifestHash,
    });
    if (error) throw error;
    return { ok: true, data };
  } catch (e) {
    console.error('[commitment-store] persistSettlementRef failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  persistCommitment,
  persistSettlementRef,
  lookupCommitmentById,
  deterministicCommitmentId,
  commitmentScopeFromKey,
  isConfigured,
  SCHEMA,
};