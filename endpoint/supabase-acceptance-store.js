// SAAX Discovery Phase 4 — Supabase-backed acceptance store (deployment path).
//
// Drop-in replacement for endpoint/acceptance-store.js with the SAME interface
// (persistAcceptance / transition / getByOperation / getByIdempotency /
// getByProposal / size / isLocked / releaseLock) but backed by the durable
// transactional database (ax_router.acceptance_operations + atomic RPCs).
//
// WHY THIS IS THE DEPLOYMENT PATH (not the fs journal):
//   - The fs journal + single-writer lock is correct on ONE host with a real
//     filesystem, but Vercel runs EPHEMERAL multi-instance serverless: no
//     persistent volume, multiple concurrent instances. A local lock file is
//     meaningless across instances.
//   - Postgres transactional idempotency is the cross-instance decision point:
//     the UNIQUE (idempotency_key) constraint makes at most one 'accepted'
//     operation per scope even under concurrent instances; the UNIQUE
//     (proposal_id) enforces single-use proposals (DSC_PROPOSAL_REUSED).
//   - Crash-to-completion recovery is the SAME as the journal path: after a
//     crash, a replacement process lists 'accepted' operations
//     (acceptance_list_pending) and completes or reconciles each one.
//
// The core (acceptance-core.js) receives this store unchanged — it only calls
// the interface methods. The store is constructed with the Supabase service
// role key (server-side ONLY; never in client bundles).
//
// Availability posture: if the DB is unreachable the store returns explicit
// 'store_error' results (DSC_UNAVAILABLE) — it NEVER falls back to local
// journal semantics that would break cross-instance guarantees.

'use strict';

class SupabaseAcceptanceStore {
  /**
   * @param {{ supabaseUrl: string, serviceRoleKey: string, schema?: string }} cfg
   *   Optional `fetchImpl` for test injection.
   */
  constructor(cfg) {
    if (!cfg || !cfg.supabaseUrl || !cfg.serviceRoleKey) {
      throw new Error('SupabaseAcceptanceStore requires supabaseUrl + serviceRoleKey');
    }
    this.base = String(cfg.supabaseUrl).trim().replace(/\/+$/, '');
    this.key = cfg.serviceRoleKey;
    this.schema = cfg.schema || 'public';
    this.fetchImpl = cfg.fetchImpl || ((...a) => fetch(...a));
    this._records = new Map(); // operationId -> normalized record (cache)
    this.size = 0;
    this.isLocked = true; // DB store has no file lock; atomicity is in the RPC
    this.lockError = null;
    this.recoveredStaleLock = false;
    this.recoveredTail = false;
  }

  async _rpc(fn, params) {
    const url = this.base + '/rest/v1/rpc/' + fn;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: this.key,
        Authorization: 'Bearer ' + this.key,
        'Accept-Profile': this.schema,
        'Content-Profile': this.schema,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params || {}),
    });
    if (res.status >= 400) {
      const txt = (await res.text()).slice(0, 300);
      const e = new Error('RPC ' + fn + ' -> ' + res.status + ' ' + txt);
      e.code = 'DSC_STORE_ERROR';
      throw e;
    }
    return res.json();
  }

  _normalize(row) {
    if (!row) return null;
    return {
      kind: 'acceptance',
      operationId: row.operation_id,
      commitmentId: row.commitment_id,
      proposalId: row.proposal_id,
      requestDigest: row.request_digest,
      clientNonce: row.client_nonce,
      acceptedAt: row.accepted_at,
      status: row.status,
      reason: row.reason || undefined,
      profileVersion: row.profile_version,
      signingKeyId: row.signing_key_id,
      manifestVersion: row.manifest_version,
      manifestDigest: row.manifest_digest,
      schema: row.schema || (row.schema_id ? { id: row.schema_id, version: row.schema_version, digest: row.schema_digest } : null),
      buyerScope: row.buyer_scope || {},
      proposalDigest: row.proposal_digest,
      acceptanceRef: row.acceptance_ref || null,
      commitmentRef: row.commitment_ref || null,
      signedRepresentation: row.signed_representation || null,
      idempotencyKey: row.idempotency_key,
      terms: row.terms || {},
    };
  }

  /**
   * Atomic persist — the DB unique constraint is the single decision point.
   * record: same shape as AcceptanceStore.persistAcceptance expects.
   * Returns { ok:true, duplicate:false } | { ok:true, duplicate:true, record } |
   *   { ok:false, status:'reused_proposal', reason } (proposal single-use) |
   *   { ok:false, status:'store_error', reason }
   */
  async persistAcceptance(record) {
    const schema = record.schema || {};
    try {
      // Single-use proposal check: the DB unique(proposal_id) would raise a
      // constraint violation on the second insert; we surface it explicitly.
      // IMPORTANT: this only applies when a DIFFERENT idempotency key reuses a
      // single-use proposal. The SAME key re-persisting the same proposal is a
      // DUPLICATE (handled by the idempotency conflict path), never a reuse.
      const existingProp = await this.getByProposal(record.proposalId);
      if (existingProp && existingProp.operationId !== record.operationId && existingProp.idempotencyKey !== record.idempotencyKey) {
        return { ok: false, status: 'reused_proposal', reason: 'proposal already accepted under operation ' + existingProp.operationId + ' (single-use)' };
      }
      const out = await this._rpc('discovery_acceptance_persist', {
        p_operation_id: record.operationId,
        p_commitment_id: record.commitmentId,
        p_proposal_id: record.proposalId,
        p_request_digest: record.requestDigest,
        p_client_nonce: record.clientNonce || record.nonce || '',
        p_accepted_at: record.acceptedAt || new Date().toISOString(),
        p_status: record.status || 'accepted',
        p_reason: record.reason || null,
        p_profile_version: record.profileVersion || null,
        p_signing_key_id: record.signingKeyId || null,
        p_manifest_version: record.manifestVersion || null,
        p_manifest_digest: record.manifestDigest || null,
        p_schema_id: schema.id || null,
        p_schema_version: schema.version || null,
        p_schema_digest: schema.digest || null,
        p_buyer_scope: record.buyerScope || {},
        p_proposal_digest: record.proposalDigest || null,
        p_acceptance_ref: record.acceptanceRef || null,
        p_commitment_ref: record.commitmentRef || null,
        p_signed_representation: record.signedRepresentation || null,
        p_idempotency_key: record.idempotencyKey,
        p_terms: record.terms || {},
      });
      const row = out && out.operation_id ? out : null;
      if (!row) return { ok: false, status: 'store_error', reason: 'acceptance_persist returned no row' };
      const norm = this._normalize(row);
      this._records.set(norm.operationId, norm);
      this.size = this._records.size;
      if (out.created === false) {
        // Existing row: same key. Conflict = different request digest.
        if (norm.requestDigest !== record.requestDigest) {
          return { ok: false, status: 'conflict', reason: 'idempotencyKey reused with a different request digest' };
        }
        return { ok: true, duplicate: true, record: norm };
      }
      return { ok: true, duplicate: false };
    } catch (e) {
      // Unique violation on proposal_id (another operation won the race).
      if (e && /acceptance_operations_proposal_id_key|duplicate key/.test(String(e.message))) {
        return { ok: false, status: 'reused_proposal', reason: 'proposal already accepted (single-use)' };
      }
      if (e && /acceptance_operations_idempotency_key_key|duplicate key/.test(String(e.message))) {
        const existing = await this.getByIdempotency(record.idempotencyKey, record.requestDigest);
        if (existing) return { ok: true, duplicate: true, record: existing };
        return { ok: false, status: 'conflict', reason: 'idempotencyKey reused with a different request digest' };
      }
      return { ok: false, status: 'store_error', reason: (e && e.message) || String(e) };
    }
  }

  async transition(operationId, patch) {
    try {
      const out = await this._rpc('discovery_acceptance_transition', {
        p_operation_id: operationId,
        p_status: patch.status,
        p_reason: patch.reason || null,
        p_commitment_ref: patch.commitmentRef || null,
      });
      if (!out || out.ok === false) return { ok: false, reason: (out && out.reason) || 'operation not found' };
      const existing = this._records.get(operationId);
      if (existing) {
        existing.status = out.status;
        existing.commitmentRef = out.commitment_ref || existing.commitmentRef;
        this._records.set(operationId, existing);
      }
      return { ok: true, record: existing ? existing : { operationId, status: out.status, commitmentRef: out.commitment_ref || null } };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    }
  }

  async getByOperation(operationId) {
    if (this._records.has(operationId)) return this._records.get(operationId);
    try {
      const out = await this._rpc('discovery_acceptance_get_by_idempotency', { p_idempotency_key: operationId });
      const norm = this._normalize(out);
      if (norm) this._records.set(norm.operationId, norm);
      return norm || null;
    } catch (_) { return null; }
  }

  async getByIdempotency(key, digest) {
    try {
      const out = await this._rpc('discovery_acceptance_get_by_idempotency', { p_idempotency_key: key });
      const norm = this._normalize(out);
      if (!norm) return null;
      if (digest !== undefined && norm.requestDigest !== digest) return null; // conflict scope
      if (norm) this._records.set(norm.operationId, norm);
      return norm || null;
    } catch (_) { return null; }
  }

  async getByProposal(proposalId) {
    try {
      const out = await this._rpc('discovery_acceptance_get_by_proposal', { p_proposal_id: proposalId });
      const norm = this._normalize(out);
      if (norm) this._records.set(norm.operationId, norm);
      return norm || null;
    } catch (_) { return null; }
  }

  async listPending() {
    try {
      const out = await this._rpc('discovery_acceptance_list_pending', {});
      const rows = Array.isArray(out) ? out : (out && out.data ? out.data : []);
      return rows.map((r) => this._normalize(r)).filter(Boolean);
    } catch (_) { return []; }
  }

  // No file lock to release; kept for interface parity.
  releaseLock() { this.isLocked = false; }
}

module.exports = { SupabaseAcceptanceStore };