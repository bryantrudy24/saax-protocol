// D3 endpoint -> worker integration bridge.
//
// The escrow access handler (route-server.js) keeps ALL its authorization and
// admission checks (pilot transport auth, signed access authorization,
// agreement + on-chain party/term bindings via verifyOnChain +
// verifyFundingBindings, chain/custody checks, action-specific authority and
// deadlines, supported profile/admission restrictions). What THIS module
// replaces is ONLY the write boundary: instead of persistLedger() (JSON file +
// atomic rename), integrated mode performs ONE atomic SQLite transaction
// (worker/d3-store.js acceptIntegrated) that persists the operation + work
// item + journal/outbox intent together.
//
// Gate: SAAX_INTEGRATED_WORKER=1. When unset (the hosted lane), this module
// is not loaded and the JSON ledger path is byte-identical to before.
//
// DESIGN DISCIPLINE:
//   - The endpoint does NOT reserve nonces. It creates work; the worker owns
//     the dedicated relayer account and reserves nonces durably at prepare.
//   - Access authorization is SEPARATE from evaluator/mutual settlement
//     authorization: the worker never generates evaluator approval because
//     the buyer requested settlement. It only executes actions whose
//     prerequisites (signed agreement/policy + on-chain state + cutoff +
//     genuine evaluator/mutual signatures or timeout rules) pass (D2Prereqs).
//   - A caller-controlled user ID, configured buyer address, or valid
//     transport token alone is NOT sufficient: the handler's existing checks
//     (signature recovery to the role's configured address AND the on-chain
//     escrow party, funding bindings vs the agreement) run BEFORE this write.

'use strict';

const path = require('node:path');
const { opIdFromNonce } = require('../worker/d3-store.js');

// Resolve the store path the same way the worker CLI does; the endpoint and
// worker share the SAME sqlite file so the handoff is the store itself.
function storePath() {
  return process.env.SAAX_WORKER_STORE
    || path.join(__dirname, '..', 'data', 'worker-store.sqlite');
}

let _store = null;

function store() {
  if (_store) return _store;
  const { D3Store } = require('../worker/d3-store.js');
  const fs = require('node:fs');
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // The endpoint and the worker open the SAME sqlite file (one host, one
  // writer at a time serialized by the WAL + busy_timeout). The endpoint only
  // writes ACCEPTANCE rows inside a transaction and never reserves nonces, so
  // concurrent endpoint/worker access is safe. The store survives the worker
  // being unavailable: acceptance commits first, the worker resumes later.
  _store = new D3Store(p);
  return _store;
}

function enabled() {
  return String(process.env.SAAX_INTEGRATED_WORKER || '').trim() === '1';
}

/**
 * Integrated acceptance (single atomic transaction).
 * @param {object} p — the access auth payload (validated by the caller)
 * @param {object} ctx — { recoveredSigner, manifestCid, chainId, action }
 * @returns {object} { ok, opId, op, work?, outbox?, idempotent?, conflict?, reason? }
 */
function acceptIntegrated(p, ctx) {
  const s = store();
  // The canonical payload digest must cover the request's EXECUTION content
  // (the actionArgs the worker will execute), not just the access-auth
  // fields — a changed payload under the same nonce must be rejected even
  // when the access auth's 8 fields are unchanged.
  const sha256 = (v) => require('node:crypto').createHash('sha256').update(String(v), 'utf8').digest('hex');
  const payloadDigest = 'sha256:' + sha256(JSON.stringify({
    access: ctx.payloadDigest || (String(p.nonce) + ':' + String(p.action)),
    actionArgs: ctx.actionArgs || null,
  }));
  const journalIntent = {
    transition: ctx.journalTransition || 'intent',
    role: p.role,
    contractAction: p.action,
    resultingState: ctx.terminalState || 'Accepted',
    kind: 'intent',
    authorization: { kind: 'access-auth', nonce: p.nonce, signer: ctx.recoveredSigner || null },
  };
  const res = s.acceptIntegrated({
    nonce: String(p.nonce),
    payloadDigest,
    role: p.role,
    action: p.action,
    commitmentDigest: String(p.commitmentDigest || '').toLowerCase(),
    escrowId: String(p.escrowId || '').toLowerCase(),
    custody: String(p.custody || '').toLowerCase(),
    chainId: Number(p.chainId) || 0,
    expiry: String(p.expiry || '0'),
    agreementRef: ctx.manifestCid || '',
    authExpiry: Number(p.expiry) || 0,
    relayerAccount: ctx.relayerAccount || '',
    workRequired: !!ctx.workRequired,
    actionArgs: ctx.actionArgs || null,
    exportArtifacts: ctx.exportArtifacts || null,
    journalIntent,
  });
  if (!res.ok) return res;
  return {
    ok: true,
    opId: res.op.op_id,
    op: res.op,
    work: res.work,
    outbox: res.outbox,
    idempotent: res.idempotent,
  };
}

/** Status/recovery access: terminal-state + recovery read WITHOUT execution. */
function lookupOperation(opIdOrNonce, { byNonce = false } = {}) {
  const s = store();
  if (byNonce) {
    // Nonce -> opId mapping requires the payload digest; the store indexes by
    // op_id only. For recovery access we offer a status query by nonce that
    // lists candidate ops (the operation carries auth_nonce).
    const ops = s.listOperations();
    const hit = ops.find((o) => String(o.authNonce) === String(opIdOrNonce));
    return hit ? { ok: true, op: hit, work: s.getWork(hit.op_id), outbox: s.getOutbox(hit.op_id) } : { ok: false, reason: 'NO_OPERATION' };
  }
  const op = s.getOperation(String(opIdOrNonce));
  if (!op) return { ok: false, reason: 'NO_OPERATION' };
  return { ok: true, op, work: s.getWork(op.op_id), outbox: s.getOutbox(op.op_id) };
}

module.exports = { enabled, storePath, acceptIntegrated, lookupOperation, opIdFromNonce };