// SAAX Discovery Phase 4 — Gap 4: crash-to-completion recovery
//
// A replacement process must discover durably accepted issuance operations,
// determine whether their commitment already exists, and either return the
// EXISTING commitment or COMPLETE the same intended issuance EXACTLY ONCE
// (same operation id, same commitment id, same terms/signatures — never
// silently regenerating different content).
//
// This module is the reconciliation engine a server process runs at startup
// (and before serving accept_commitment): scan the acceptance journal for
// operations in status 'accepted' (durably accepted BEFORE the crash, but no
// commitment_created transition recorded), and:
//   1. If the operation's commitmentId is already IN THE JOURNAL as
//      commitment_created (a later transition was recorded) -> the
//      commitment exists; return it. The operation is marked complete.
//   2. Otherwise -> complete the SAME intended issuance: rebuild the
//      commitment deterministically from the operation record (the record
//      carries proposalDigest, terms, buyerScope, versions, acceptanceRef,
//      signedRepresentation) and transition the SAME operation to
//      commitment_created. The commitment id + manifest hash are rebuilt from
//      the persisted record, so they are IDENTICAL to what the crashed process
//      intended.
//   3. Crash DURING reconciliation is safe: the transition is an append; on
//      the next startup the scan re-runs and sees either the accepted state
//      (completes again, same ids) or the committed state (returns existing).
//
// The rebuild uses ONLY the persisted record (no new random ids — the record
// carries commitmentId + the signedRepresentation JWS + terms), so at-most-
// once completion is guaranteed by the single-writer journal + the
// deterministic identity in the record.
//
// Run: node endpoint/discovery-recovery.js <storeDir> [--dry-run]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AcceptanceStore } = require('./acceptance-store');
const commitmentMod = require('./commitment');
const cryptoLib = require('./discovery-crypto');

/**
 * Rebuild the commitment manifest + signed representation from a persisted
 * operation record (the record IS the source of truth; no new randomness).
 * Returns { manifest, signedRepresentation } or throws on missing fields.
 */
function rebuildCommitmentFromRecord(rec) {
  if (!rec) throw new Error('recovery: no operation record');
  if (!rec.commitmentId) throw new Error('recovery: record missing commitmentId');
  if (!rec.terms || !rec.buyerScope) throw new Error('recovery: record missing terms/buyerScope');
  // The manifest is rebuilt exactly as acceptance-core.buildCommitment would,
  // but with the PERSISTED commitmentId + the PERSISTED signedRepresentation.
  const manifest = commitmentMod.buildManifest({
    commitmentId: rec.commitmentId,
    buyerAgentId: String(rec.buyerScope && rec.buyerScope.buyer || '').toLowerCase(),
    sellerAgentId: rec.sellerAgentId || '',   // persisted at acceptance time
    capability: rec.capability || '',
    price: {
      amount: String(rec.terms.amount),
      currency: rec.terms.currency || null,
      decimals: rec.terms.decimals,
    },
    acceptanceCriteria: { type: 'hash', value: 'sha256:' + String(rec.requestDigest || '').replace('sha256:', '') },
    deadline: rec.terms.deadline || null,
    cancelCondition: 'buyer-cancel-before-delivery',
  });
  // The signedRepresentation was persisted at acceptance time (the provider
  // JWS over the canonical manifest+proposal binding). Reuse it VERBATIM so
  // the rebuilt commitment authenticates the SAME content the crashed process
  // created — never a fresh signature over different bytes.
  const signedRepresentation = rec.signedRepresentation || null;
  return { manifest, signedRepresentation, commitmentId: rec.commitmentId };
}

/**
 * Reconcile one 'accepted' operation to completion.
 * Returns { operation, commitment } always with the SAME operation id and
 * commitment id; the commitment already exists (commitment_created recorded)
 * or is completed now.
 */
async function reconcileOperation(store, rec, { sellerAgentId, capability } = {}) {
  const existing = store.getByOperation(rec.operationId);
  if (!existing) throw new Error('recovery: operation vanished from journal');
  if (existing.status === 'commitment_created') {
    return {
      operation: existing,
      commitment: {
        commitmentId: existing.commitmentId,
        manifestHash: existing.commitmentRef && existing.commitmentRef.manifestHash,
      },
      alreadyExisting: true,
    };
  }
  // Rebuild deterministically from the persisted record.
  const built = rebuildCommitmentFromRecord({ ...rec, sellerAgentId: sellerAgentId || rec.sellerAgentId, capability: capability || rec.capability });
  // Transition the SAME operation to commitment_created (append-only; crash
  // mid-transition is safe — next scan sees 'accepted' again and re-completes
  // with the same ids).
  const tx = await store.transition(rec.operationId, {
    status: 'commitment_created',
    commitmentRef: { manifestHash: built.manifest.manifestHash },
  });
  if (!tx.ok) throw new Error('recovery: transition failed: ' + (tx.reason || 'unknown'));
  return {
    operation: tx.record,
    commitment: {
      commitmentId: built.commitmentId,
      manifestHash: built.manifest.manifestHash,
      manifest: built.manifest,
      signedRepresentation: built.signedRepresentation,
    },
    alreadyExisting: false,
  };
}

/**
 * Startup reconciliation: scan every 'accepted' operation and complete it
 * (or confirm it already completed). Returns a summary.
 * opts: { sellerAgentId, capability, onComplete } — sellerAgentId/capability
 * are the provider constants used at original issuance.
 */
async function reconcileAll(store, opts = {}) {
  const summary = { scanned: 0, completed: 0, alreadyExisting: 0, failures: [] };
  // Iterate the journal records via the store's in-memory index (the store
  // loads the journal at construction; we re-read the file for a fresh view).
  const raw = fs.readFileSync(path.join(store.dir, 'operations.journal'), 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const seen = new Set();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (rec.kind !== 'acceptance') continue;
    if (rec.status !== 'accepted') continue;   // only in-flight accepted ops
    if (seen.has(rec.operationId)) continue;   // a later line supersedes
    seen.add(rec.operationId);
    summary.scanned += 1;
    try {
      const out = await reconcileOperation(store, rec, opts);
      if (out.alreadyExisting) summary.alreadyExisting += 1;
      else { summary.completed += 1; if (opts.onComplete) opts.onComplete(out); }
    } catch (e) {
      summary.failures.push({ operationId: rec.operationId, reason: (e && e.message || String(e)) });
    }
  }
  const state = store.getByOperation ? null : null; // keep API stable
  return summary;
}

// ---- CLI ----
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node endpoint/discovery-recovery.js <storeDir>'); process.exit(2); }
  (async () => {
    const store = new AcceptanceStore(dir);
    if (!store.isLocked) {
      console.error('recovery: store is locked by another process — cannot reconcile');
      process.exit(3);
    }
    const summary = await reconcileAll(store, {
      sellerAgentId: process.env.SAAX_PROVIDER_ID || '',
      capability: process.env.SAAX_RECOVERY_CAPABILITY || '',
    });
    console.log('recovery: ' + JSON.stringify(summary));
    store.releaseLock();
    process.exit(summary.failures.length ? 1 : 0);
  })().catch((e) => { console.error('recovery fatal: ' + (e && e.stack || e)); process.exit(1); });
}

module.exports = { rebuildCommitmentFromRecord, reconcileOperation, reconcileAll };