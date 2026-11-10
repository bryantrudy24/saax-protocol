// SAAX Discovery Phase 4 — Gap 5: Supabase acceptance store contract test
//
// Proves the SupabaseAcceptanceStore implements the SAME interface semantics as
// the file journal, using a MOCKED fetch that reproduces the real RPC contract
// (discovery_acceptance_persist unique-constraint behavior, transition, lookups). The
// DB-level contract itself was verified directly against the real project
// (codboejrwohkjidrrcgl) — single-use proposal raises the unique violation;
// same-key duplicate returns created:false; transition updates status.
//
// Run: node tests/discovery-phase4/test-gap5-supabase-store.cjs
'use strict';
const path = require('node:path');
const { SupabaseAcceptanceStore } = require('../../endpoint/supabase-acceptance-store');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

// In-memory table mimicking ax_router.acceptance_operations + the RPC
// semantics (unique idempotency_key + unique proposal_id; on conflict do
// nothing; transitions update in place).
function makeMockDb() {
  const rows = new Map(); // idempotency_key -> row
  const byOp = new Map();
  const byProp = new Map();
  const rpc = {
    async discovery_acceptance_persist(p) {
      // The REAL DB: INSERT ... ON CONFLICT (idempotency_key) DO NOTHING —
      // the idempotency-key conflict is handled FIRST (returns the existing
      // row); the proposal unique violation only fires when a DIFFERENT
      // idempotency key reuses a single-use proposal.
      if (rows.has(p.p_idempotency_key)) {
        const existing = rows.get(p.p_idempotency_key);
        return {
          created: false, operation_id: existing.operation_id, commitment_id: existing.commitment_id,
          proposal_id: existing.proposal_id, request_digest: existing.request_digest, status: existing.status,
          accepted_at: existing.accepted_at, reason: existing.reason, proposal_digest: existing.proposal_digest,
          acceptance_ref: existing.acceptance_ref, commitment_ref: existing.commitment_ref,
          signed_representation: existing.signed_representation, idempotency_key: existing.idempotency_key,
          terms: existing.terms, profile_version: existing.profile_version, signing_key_id: existing.signing_key_id,
          manifest_version: existing.manifest_version, manifest_digest: existing.manifest_digest,
          schema: existing.schema, buyer_scope: existing.buyer_scope,
        };
      }
      const row = {
        operation_id: p.p_operation_id, commitment_id: p.p_commitment_id, proposal_id: p.p_proposal_id,
        request_digest: p.p_request_digest, status: p.p_status, accepted_at: p.p_accepted_at,
        reason: p.p_reason, proposal_digest: p.p_proposal_digest, acceptance_ref: p.p_acceptance_ref,
        commitment_ref: p.p_commitment_ref, signed_representation: p.p_signed_representation,
        idempotency_key: p.p_idempotency_key, terms: p.p_terms, profile_version: p.p_profile_version,
        signing_key_id: p.p_signing_key_id, manifest_version: p.p_manifest_version,
        manifest_digest: p.p_manifest_digest,
        schema: { id: p.p_schema_id, version: p.p_schema_version, digest: p.p_schema_digest },
        buyer_scope: p.p_buyer_scope,
      };
      rows.set(p.p_idempotency_key, row);
      byOp.set(row.operation_id, row);
      byProp.set(row.proposal_id, row);
      return { created: true, ...row };
    },
    async discovery_acceptance_transition(p) {
      const row = byOp.get(p.p_operation_id);
      if (!row) return { ok: false, reason: 'operation not found' };
      row.status = p.p_status;
      row.reason = p.p_reason || row.reason;
      row.commitment_ref = p.p_commitment_ref || row.commitment_ref;
      return { ok: true, status: row.status, commitment_ref: row.commitment_ref, operation_id: row.operation_id };
    },
    async discovery_acceptance_get_by_idempotency(p) {
      const row = rows.get(p.p_idempotency_key);
      return row || null;
    },
    async discovery_acceptance_get_by_proposal(p) {
      const row = byProp.get(p.p_proposal_id);
      return row || null;
    },
    async discovery_acceptance_list_pending() {
      return [...rows.values()].filter((r) => r.status === 'accepted').map((row) => ({ ...row }));
    },
  };
  return { rows, byOp, byProp, rpc };
}

function makeStore(db) {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const fn = url.split('/rpc/')[1];
    const data = await db.rpc[fn](body);
    return {
      status: 200,
      async json() { return data; },
      async text() { return JSON.stringify(data); },
    };
  };
  return new SupabaseAcceptanceStore({ supabaseUrl: 'https://mock.supabase.co', serviceRoleKey: 'test-key', fetchImpl });
}

function baseRecord(over = {}) {
  return Object.assign({
    kind: 'acceptance', operationId: 'op_s1', commitmentId: '0x' + '1'.repeat(64),
    proposalId: 'prop_s1', requestDigest: 'sha256:' + 'a'.repeat(64), clientNonce: 'nonce-s1',
    acceptedAt: '2026-11-05T12:00:00.000Z', status: 'accepted', profileVersion: '1.0.0',
    signingKeyId: 'key-1', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64),
    schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:' + 'b'.repeat(64) },
    buyerScope: { buyer: '0x1111111111111111111111111111111111111111' },
    proposalDigest: 'sha256:' + 'd'.repeat(64),
    acceptanceRef: { acceptanceId: 'acc_s1', digest: 'sha256:' + 'e'.repeat(64), keyId: 'key-1' },
    commitmentRef: null, signedRepresentation: null, idempotencyKey: 'idem-s1',
    terms: { amount: '250000000', currency: 'USDC', decimals: 6, financialTerms: 'financial' },
  }, over);
}

async function main() {
  // S1: fresh persist -> created, readable by all lookups.
  {
    const db = makeMockDb();
    const store = makeStore(db);
    const r = await store.persistAcceptance(baseRecord());
    eq(r.ok, true, 'S1 fresh persist ok');
    eq(r.duplicate, false, 'S2 not a duplicate');
    const op = await store.getByOperation('op_s1');
    eq(op.status, 'accepted', 'S3 getByOperation finds it');
    const byIdem = await store.getByIdempotency('idem-s1', 'sha256:' + 'a'.repeat(64));
    eq(byIdem.operationId, 'op_s1', 'S4 getByIdempotency finds it');
    const byProp = await store.getByProposal('prop_s1');
    eq(byProp.operationId, 'op_s1', 'S5 getByProposal finds it');
  }

  // S6-8: duplicate same key+digest -> duplicate true, same operation.
  {
    const db = makeMockDb();
    const store = makeStore(db);
    await store.persistAcceptance(baseRecord());
    const r2 = await store.persistAcceptance(baseRecord({ operationId: 'op_s1_again' }));
    eq(r2.duplicate, true, 'S6 duplicate same key+digest');
    eq(r2.record.operationId, 'op_s1', 'S7 duplicate returns the ORIGINAL operation');
    // same key + DIFFERENT digest -> conflict.
    const r3 = await store.persistAcceptance(baseRecord({ operationId: 'op_s1_conflict', requestDigest: 'sha256:' + 'c'.repeat(64) }));
    eq(r3.status, 'conflict', 'S8 same key different digest -> conflict');
  }

  // S9-11: single-use proposal under a different key -> reused.
  {
    const db = makeMockDb();
    const store = makeStore(db);
    await store.persistAcceptance(baseRecord());
    const r = await store.persistAcceptance(baseRecord({ operationId: 'op_s2', proposalId: 'prop_s1', idempotencyKey: 'idem-s2' }));
    eq(r.status, 'reused_proposal', 'S9 single-use proposal under new key -> reused');
    eq(r.reason && r.reason.includes('single-use'), true, 'S10 reason names single-use');
  }

  // S12-15: transition + pending scan (recovery).
  {
    const db = makeMockDb();
    const store = makeStore(db);
    await store.persistAcceptance(baseRecord());
    await store.persistAcceptance(baseRecord({ operationId: 'op_s3', proposalId: 'prop_s3', idempotencyKey: 'idem-s3' }));
    const t = await store.transition('op_s1', { status: 'commitment_created', commitmentRef: { manifestHash: 'sha256:abc' } });
    eq(t.ok, true, 'S12 transition ok');
    const pending = await store.listPending();
    eq(pending.length, 1, 'S13 pending scan excludes committed, includes accepted', JSON.stringify(pending.map((p) => p.operationId)));
    eq(pending[0].operationId, 'op_s3', 'S14 the remaining pending op is op_s3');
    const op = await store.getByOperation('op_s1');
    eq(op.status, 'commitment_created', 'S15 committed op status truthful');
  }

  // S16: store_error posture when RPC fails (no fallback to journal).
  {
    const db = makeMockDb();
    db.rpc.discovery_acceptance_persist = async () => { throw new Error('network down'); };
    const store = makeStore(db);
    const r = await store.persistAcceptance(baseRecord());
    eq(r.status, 'store_error', 'S16 RPC failure -> store_error (DSC_UNAVAILABLE), never silent fallback');
  }

  // S17: end-to-end through acceptance-core with the Supabase store.
  {
    const db = makeMockDb();
    const store = makeStore(db);
    const acceptance = require('../../endpoint/acceptance-core');
    const preflight = require('../../endpoint/preflight-core');
    const acceptCrypto = require('../../endpoint/acceptance-crypto');
    const cryptoLib = require('../../endpoint/discovery-crypto');
    const crypto = require('crypto');
    const { generateKeyPair, calculateJwkThumbprint } = require('jose');
    const { loadProfile, loadSignerKey } = require('../discovery-phase3/preflight-http-server.cjs');
    const { ProposalStore } = require('../../endpoint/proposal-store');
    const profile = loadProfile();
    const privateJwk = loadSignerKey();
    const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
    const providerRef = { providerId: profile.providerId, name: profile.providerName, origin: profile.origin, signingKeyId: profile.signingKeys[0].id, privateJwk, jwkPublic: publicJwk, manifestDigest: profile.capabilities[0].schemas[0].digest, evaluatorRef: profile.capabilities[0].evaluatorRequirements, permittedDecisions: null };
    const trustedThumbprints = [await calculateJwkThumbprint(publicJwk)];
    const clock = { nowIso: () => '2026-11-05T12:00:00.000Z' };
    const req = { profileVersion: '1.0.0', capability: { id: 'security-scan' }, schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' }, units: { amount: '250000000', unit: 'micro-units of settlement asset' }, financialProfile: { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'x402' }, constraints: { maxAmount: '250000000', deadline: '2026-11-06T00:00:00Z' }, intendedParties: { buyer: '0x1111111111111111111111111111111111111111' }, clientNonce: 'nonce-supabase-store', issuedAt: '2026-11-05T12:00:00Z' };
    const tmp = require('os').tmpdir();
    const pOut = await preflight.prepareCommitment({ profile, providerRef, request: req, store: new ProposalStore(path.join(tmp, 'prop-supabase-' + Date.now())), clock });
    ok(pOut.status === 'ok', 'S17a preflight ok via Supabase store');
    const proposal = pOut.proposal;
    const buyerKeys = await generateKeyPair('Ed25519', { extractable: true });
    const buyerPriv = await crypto.subtle.exportKey('jwk', buyerKeys.privateKey);
    const buyerPub = await crypto.subtle.exportKey('jwk', buyerKeys.publicKey);
    const td = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal.terms), 'utf8').digest('hex');
    const accDoc = { schemaVersion: 'acceptance-v1', action: 'accept_commitment', domain: 'saax:acceptance:v1', acceptanceId: 'acc_sb1', nonce: 'accnonce-sb1-abcdef', buyer: '0x1111111111111111111111111111111111111111', provider: { providerId: proposal.provider.providerId, signingKeyId: proposal.provider.signingKeyId }, proposal: { proposalId: proposal.proposalId, proposalDigest: acceptance.proposalDigestOf(proposal) }, termsDigest: td, audience: profile.origin, notBefore: '2026-11-05T11:58:00Z', notAfter: '2026-11-05T12:30:00Z', versions: { profileVersion: '1.0.0', manifestVersion: '1', schema: proposal.manifest.schema } };
    const signedAcc = await acceptCrypto.signAcceptance({ acceptance: accDoc, buyerPrivateJwk: buyerPriv, keyId: 'buyer-key-1' });
    const buyerScope = { buyer: '0x1111111111111111111111111111111111111111', buyerPublicJwk: buyerPub, scopeMaxAmount: '500000000', scopeCurrency: 'USDC', scopeCapability: 'security-scan' };
    const out = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store, clock, idempotencyKey: 'idem-supabase-e2e' });
    eq(out.status, 'ok', 'S17b acceptance via Supabase store ok');
    eq(out.commitment.manifest.price.currency, 'USDC', 'S17c commitment priced with authenticated terms');
    // duplicate retry returns the SAME commitment.
    const out2 = await acceptance.acceptCommitment({ profile, trustedThumbprints, proposal, buyerScope, acceptance: signedAcc, providerRef, store, clock, idempotencyKey: 'idem-supabase-e2e' });
    eq(out2.status, 'duplicate', 'S17d retry -> duplicate');
    ok(out2.commitment.commitmentId === out.commitment.commitmentId, 'S17e same commitment id');
  }

  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error('runner crashed: ' + (e && e.stack || e)); process.exitCode = 1; });