// SAAX Discovery Phase 4 — Supabase-backed proposal store (deployment path).
//
// Drop-in for endpoint/proposal-store.js with the SAME persist() interface,
// backed by ax_router.proposals + the atomic proposal_persist RPC. The unique
// (client_nonce) constraint is the cross-instance decision point: identical
// retries get the SAME proposal; a reused nonce with a different digest is a
// conflict (DSC_NONCE_CONFLICT) detected by the caller comparing digests.
//
// Safe on Vercel's ephemeral multi-instance runtime (no local filesystem).

'use strict';

class SupabaseProposalStore {
  constructor(cfg) {
    if (!cfg || !cfg.supabaseUrl || !cfg.serviceRoleKey) {
      throw new Error('SupabaseProposalStore requires supabaseUrl + serviceRoleKey');
    }
    this.base = String(cfg.supabaseUrl).trim().replace(/\/+$/, '');
    this.key = cfg.serviceRoleKey;
    this.schema = cfg.schema || 'public';
    this.fetchImpl = cfg.fetchImpl || ((...a) => fetch(...a));
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
    let proposal = null;
    if (row.signed_payload) {
      try { proposal = typeof row.signed_payload === 'string' ? JSON.parse(row.signed_payload) : row.signed_payload; } catch (_) { /* ignore */ }
    }
    return {
      proposalId: row.proposal_id,
      nonce: row.client_nonce,
      requestDigest: row.request_digest,
      profileVersion: row.profile_version,
      schema: row.schema || null,
      issuedAt: row.issued_at,
      expires: row.expires_at,
      status: row.status,
      signedPayload: proposal,
    };
  }

  /**
   * persist(record) — same contract as ProposalStore.persist:
   * record: { proposalId, nonce, requestDigest, signedPayload, profileVersion,
   *           schema, issuedAt, expires, status, signature, scope }
   * Returns { ok:true, duplicate:false } | { ok:true, duplicate:true, proposal } |
   *   { ok:false, status:'conflict' } | { ok:false, status:'store_error', reason }
   */
  async persist(record) {
    try {
      const out = await this._rpc('discovery_proposal_persist', {
        p_proposal_id: record.proposalId,
        p_client_nonce: record.nonce,
        p_request_digest: record.requestDigest,
        p_signed_payload: record.signedPayload || record.signed_proposal || {},
        p_profile_version: record.profileVersion || null,
        p_schema_id: record.schema && record.schema.id || null,
        p_schema_version: record.schema && record.schema.version || null,
        p_schema_digest: record.schema && record.schema.digest || null,
        p_issued_at: record.issuedAt || new Date().toISOString(),
        p_expires_at: record.expires || new Date(Date.now() + 3600 * 1000).toISOString(),
        p_status: record.status || 'proposed',
      });
      if (!out || !out.proposal_id) return { ok: false, status: 'store_error', reason: 'proposal_persist returned no row' };
      if (out.created === false) {
        // Existing row: same nonce. Same digest -> duplicate (same proposal);
        // different digest -> conflict.
        if (out.request_digest !== record.requestDigest) {
          return { ok: false, status: 'conflict', reason: 'concurrent request with the same nonce' };
        }
        const prop = this._normalize(out);
        return { ok: true, duplicate: true, proposal: prop.signedPayload || null };
      }
      return { ok: true, duplicate: false };
    } catch (e) {
      return { ok: false, status: 'store_error', reason: (e && e.message) || String(e) };
    }
  }
}

module.exports = { SupabaseProposalStore };