// D3 execution worker — polls committed work, executes via the D2 pipeline,
// then drains the journal/outbox into REAL journal entries tied to actual
// receipts/events, and can emit a v4 export from persisted records + chain
// evidence.
//
// Discovery: the worker NEVER depends on an in-memory notification. It polls
// work_items (status=PENDING), claims atomically (versioned), prepares +
// broadcasts + reconciles through D2Worker, then writes the journal entry
// from the RECORDED OUTCOME + outbox intent. A journal-write failure after
// chain execution stays recoverable: the outbox row survives with status
// PENDING, the op outcome is recorded, and re-draining writes the journal
// from the recorded outcome — never a second payout, never a fabricated
// entry.
//
// Authority boundaries (mandated):
//   - The worker executes an action ONLY when D2Prerequisites passes:
//     signed agreement/policy, on-chain escrow state permits the exact
//     action, cutoff valid, genuine evaluator/mutual signatures or the
//     timeout rules. It NEVER invents evaluator approval because the buyer
//     requested settlement.
//   - Observer/submitter/action authorizer stay distinct: journal entries
//     carry by = authorizing party, submitter = tx sender (relayer), and the
//     worker's own attestation key — never presented as the actor's key.
//   - Confirmed entries are tied to actual receipts/events (txHash/blockHash
//     from the reconcile outcome; never synthetic).

'use strict';

const { D2Worker } = require('./d2-worker.js');
const { D3Store } = require('./d3-store.js');
const journalWriter = require('../mainnet/design/support/v4-journal-writer');
const { verifyActionArgs, recoverAddress, normalizeSig } = require('./d3-action-auth.js');
const sigs = require('../mainnet/design/support/v4-signatures.js');
const { Interface } = require('ethers');

const ERC1271_MAGIC = '0x1626ba7e';

const { createJournalWriter, CONFIRMED_TRANSITIONS } = journalWriter;

/** Map an access action to its custody contract action (worker-executable). */
function contractActionFor(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'request refund' || a === 'refund') return 'refund';
  if (a === 'initiate dispute' || a === 'raiseDispute') return 'raiseDispute';
  if (a === 'submit verdict' || a === 'release') return 'release';
  if (a === 'resolve dispute' || a === 'resolve') return 'resolve';
  if (a === 'mutual refund' || a === 'mutualRefund') return 'mutualRefund';
  if (a === 'mutual release' || a === 'mutualRelease') return 'mutualRelease';
  return null; // not worker-executable (status/evidence/execute intent-only)
}

/** Map the contract action to its confirmed journal transition. */
function transitionFor(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'refund') return 'refund';
  if (a === 'raiseDispute') return 'dispute';
  if (a === 'release') return 'release';
  if (a === 'resolve') return 'release';
  if (a === 'mutualRefund') return 'mutual-refund';
  if (a === 'mutualRelease') return 'mutual-release';
  return null;
}

class D3Worker extends D2Worker {
  /**
   * @param {object} opts extends D2Worker opts with:
   * @param {object} opts.journal { dir, signerKey, custodyAddress, chainId }
   *        — journal output dir + operator attestation key (synthetic in tests).
   * @param {object} [opts.exportBuilder] async (opId, ctx) => export object —
   *        optional; when absent the worker builds a minimal v4 export from
   *        persisted records + chain evidence (see buildV4Export).
   */
  constructor(opts) {
    super(opts); // D2Worker: D3Store is actually created below
    // D2Worker creates a D2Store; we need the D3 schema. Re-open as D3Store
    // on the SAME file (D3Store extends D2Store — idempotent schema exec).
    try { this.store.close(); } catch { /* noop */ }
    this.store = new D3Store(opts.storePath, { wipe: !!opts.wipeStore });
    this.journal = opts.journal || null;
    this.exportBuilder = opts.exportBuilder || null;
    this._journalWriters = new Map();
    this._seenOutbox = new Set();
  }

  /** Worker-side action-args authorization helpers. The escrow is read
   *  fresh from the chain; signatures are verified exactly as the contract
   *  verifies them (ERC-1271 staticcall for Safe evaluators, ecrecover for
   *  EOA/mutual). Never trusts caller-supplied recoveredSigner metadata. */
  _actionAuthCtx(esc) {
    const { ethers: eth } = require('ethers');
    const D = (fn) => async (p) => {
      // The shared digest helpers take ONE object {commitmentId,
      // commitmentDigest, action, nonce, issuedAt, verifyingContract,
      // chainId} and return a promise (dynamic ethers import).
      try { return await fn({ ...p, verifyingContract: this.opts.chain.custody, chainId: this.opts.chain.id }); }
      catch { return null; }
    };
    // F3B: explicit custody-version selection for the digest helpers. V3 uses
    // the 6-field head-bound typehashes (preSettlementHead in the digest);
    // V2 keeps the legacy 5-field helpers. NEVER inferred from formatVersion.
    const v3 = Number(this.opts.custodyVersion || process.env.SAAX_CUSTODY_VERSION || 0) === 3;
    const digestLib = v3 ? require('./v3-signing-worker.cjs') : sigs;
    return {
      isContractWallet: (addr) => {
        if (!this.provider) return Promise.resolve(false);
        return this.provider.getCode(addr).then((c) => c && c !== '0x').catch(() => false);
      },
      verdictDigest: D(digestLib.verdictDigest),
      mutualDigest: D(digestLib.mutualDigest),
      recoverEoa: (digest, { v, r, s }) => {
        try {
          const { vv, rr, ss } = normalizeSig({ v, r, s });
          if (!rr || !ss) return null;
          const sig = eth.Signature.from({ r: rr, s: ss, v: vv });
          return eth.recoverAddress(digest, sig);
        } catch { return null; }
      },
      verifyContractWallet: async (evaluator, digest, sigBytes) => {
        try {
          const iface = new Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
          const data = iface.encodeFunctionData('isValidSignature', [digest, sigBytes]);
          const res = await this.provider.call({ to: evaluator, data });
          const magic = iface.decodeFunctionResult('isValidSignature', res)[0];
          return { ok: magic === ERC1271_MAGIC, reason: magic === ERC1271_MAGIC ? null : 'ERC_1271_REJECTED' };
        } catch (e) {
          return { ok: false, reason: 'ERC_1271_CALL_FAILED', detail: String(e.message || e).slice(0, 200) };
        }
      },
    };
  }

  /** Verify the persisted actionArgs against the GENUINE on-chain escrow +
   *  the operation's immutable bindings, BEFORE calldata is built. */
  async verifyActionArgsForOp(op, actionArgs) {
    const escrowId = String(op.escrowId || (op.actionBindings && op.actionBindings.escrowId) || '').toLowerCase();
    if (!escrowId) return { ok: false, reason: 'NO_ESCROW_ID' };
    let esc;
    try {
      esc = await this.opts.prereqs.getEscrow(escrowId);
    } catch (e) {
      return { ok: false, reason: 'ESCROW_READ_FAILED', detail: String(e.message || e).slice(0, 200) };
    }
    if (!esc || esc.state === undefined) return { ok: false, reason: 'ESCROW_NOT_FOUND' };
    // Phase D4B closure: the actionArgs that become calldata MUST be bound to
    // the SAME escrow this operation references. The verdict/mutual digest is
    // signed over actionArgs.commitmentId/commitmentDigest and those exact
    // values are encoded into the custody call; a validly-signed verdict over
    // a DIFFERENT escrow would otherwise authorize a call against another
    // escrow's state. Reject BEFORE any calldata build or signing.
    {
      const A = actionArgs || {};
      const lc2 = (x) => String(x || '').toLowerCase();
      const gotCid = lc2(A.commitmentId);
      const gotDigest = lc2(A.commitmentDigest);
      if (!gotCid || gotCid !== lc2(escrowId)) {
        return { ok: false, reason: 'ESCROW_BINDING_MISMATCH', detail: { expectedEscrowId: escrowId, gotCommitmentId: A.commitmentId } };
      }
      if (!gotDigest || gotDigest !== lc2(esc.commitmentDigest || esc.digest)) {
        return { ok: false, reason: 'ESCROW_BINDING_MISMATCH', detail: { expectedEscrowDigest: esc.commitmentDigest || esc.digest, gotCommitmentDigest: A.commitmentDigest } };
      }
    }
    // The access action (what the role signed: 'submit verdict'/'request
    // refund'/...) is the ORIGINAL op row value. The caller may pass the
    // MAPPED contract action in op.requestedAction (as _processWorkItem does
    // with { ...op, requestedAction }), so recover the original from the
    // raw snake_case column when present, else from the camelCase value that
    // was NOT overwritten. The module needs BOTH: the contract action for
    // classification and the access action for the scope cross-check.
    // accessAction is the original value preserved by the caller (see
    // _processWorkItem); fall back to the raw column / camelCase.
    const rawAccessAction = String(op.accessAction || op.requested_action || op.requestedAction || '');
    const passedContractAction = String(op.requestedAction || op.requested_action || '').toLowerCase();
    const mapped = contractActionFor(rawAccessAction);
    // Prefer the explicitly-derived contract action; fall back to the caller's.
    const contractAction = mapped || passedContractAction;
    const originalAccessAction = rawAccessAction;
    const result = await verifyActionArgs(actionArgs || {}, {
      contractAction,
      originalAccessAction,
      escrowId,
      escrow: esc,
      chainId: Number(op.chainId || this.opts.chain.id),
      custody: String(op.custodyAddress || this.opts.chain.custody || '').toLowerCase(),
      expectedChainId: Number(this.opts.chain.id),
      expectedCustody: String(this.opts.chain.custody || '').toLowerCase(),
      // F3B: explicit custody version — V3 head-required checks activate only
      // when the local lane declares V3 (SAAX_CUSTODY_VERSION=3). Unset/2
      // preserves the V2 verdict/mutual behavior exactly.
      custodyVersion: Number(this.opts.custodyVersion || process.env.SAAX_CUSTODY_VERSION || 0),
      accessNonce: op.authNonce,
      accessRole: op.authRole,
      accessAction: originalAccessAction,
      ...this._actionAuthCtx(esc),
    });
    return result;
  }

  /** Archive the authenticated artifacts (signed agreement, authorizations,
   *  anchor, evidence) onto the operation so the integrated export can retain
   *  them — never reconstructed, never borrowed from another lifecycle. */
  static archiveArtifacts(store, opId, artifacts) {
    if (!artifacts) return { ok: true };
    try {
      store.db.prepare('ALTER TABLE operations ADD COLUMN export_artifacts TEXT').run();
    } catch { /* already exists */ }
    store.db.prepare('UPDATE operations SET export_artifacts=? WHERE op_id=?').run(JSON.stringify(artifacts), opId);
    return { ok: true };
  }

  _journalWriter(commitmentId, manifestHash, chainId, custodyAddress) {
    const key = String(commitmentId).toLowerCase() + '|' + String(chainId) + '|' + String(custodyAddress).toLowerCase();
    if (!this._journalWriters.has(key)) {
      const w = createJournalWriter({ chainId, custodyAddress, commitmentId, manifestHash });
      // Restore existing journal for this commitment if one exists on disk.
      if (this.journal && this.journal.dir) {
        const fs = require('node:fs');
        const p = require('node:path').join(this.journal.dir, String(commitmentId).toLowerCase() + '.json');
        if (fs.existsSync(p)) {
          try { w.restore(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch (e) {
            this.log.warn('[d3] journal restore refused for ' + String(commitmentId).slice(0, 14) + ': ' + e.message);
          }
        }
      }
      this._journalWriters.set(key, w);
    }
    return this._journalWriters.get(key);
  }

  /**
   * F3B — freeze the authenticated journal checkpoint (current tail hash) for
   * a commitment. The head is the tail BEFORE any settlement entry: it is read
   * from the durable journal (restored from disk when present, else the writer
   * root). It never depends on the settlement entry itself, its own future
   * authorization, the signed transaction, or the receipt — a NONCIRCULAR
   * boundary. Returns bytes32 (0x00..00 when no journal exists yet — which a
   * V3 evaluator/mutual settlement rejects via NO_CHECKPOINT).
   * @param {string} commitmentId
   * @returns {string} frozen head hex (32 bytes)
   */
  _freezeCheckpoint(commitmentId, manifestHash) {
    const mh = manifestHash || '';
    if (!mh || !/^0x[0-9a-fA-F]{64}$/.test(mh)) return '0x' + '00'.repeat(32);
    const jw = this.journal && this.journal.dir
      ? this._journalWriter(commitmentId, mh, Number(this.opts.chain.id), this.opts.chain.custody)
      : null;
    if (!jw) return '0x' + '00'.repeat(32);
    try {
      const snap = jw.snapshot();
      const tail = snap && snap.tailHash ? snap.tailHash : null;
      // A journal with events has an authenticated tail; a fresh writer
      // returns the root (genesis). Both are deterministic and non-circular.
      return tail || snap.root || '0x' + '00'.repeat(32);
    } catch (e) {
      return '0x' + '00'.repeat(32);
    }
  }

  /**
   * F3B — ensure the journal carries the authenticated pre-settlement prefix
   * (issue entry) before any checkpoint is frozen. A V3 evaluator/mutual
   * settlement must freeze a REAL pre-settlement tail — the zero head is
   * rejected by the contract and by this worker. Idempotent: if the journal
   * already has the issue entry (or any entry), this is a no-op — the existing
   * tail is authoritative (never append a second issue, never rewrite history).
   * @param {string} commitmentId
   * @param {object} op - durable operation row (for manifest/buyer identity)
   * @returns {boolean} true if a non-zero pre-settlement tail is available
   */
  async _ensureJournalPrefix(commitmentId, op) {
    if (!this.journal || !this.journal.dir || !this.journal.signerKey) return false;
    // The authenticated manifestHash comes from the same durable source the
    // outbox drain uses (ob.manifest_hash) — never an empty/inferred value.
    const ob = op && op.op_id ? this.store.getOutbox(op.op_id) : null;
    const manifestHash = (ob && ob.manifest_hash) || (op && op.manifestHash) || '';
    if (!manifestHash || !/^0x[0-9a-fA-F]{64}$/.test(manifestHash)) return false;
    const jw = this._journalWriter(commitmentId, manifestHash, Number(this.opts.chain.id), this.opts.chain.custody);
    const snap = jw.snapshot();
    if (snap && snap.events && snap.events.length > 0) {
      // Existing journal tail is the authoritative pre-settlement boundary.
      return !!snap.tailHash && snap.tailHash !== '0x' + '00'.repeat(32);
    }
    // Fresh journal: append the authenticated issue entry (buyer-authorized,
    // the commitment binding). This is the genesis of the authenticated
    // boundary the settlement will commit. It does NOT depend on the
    // settlement entry, its tx hash, or its receipt — non-circular.
    const fs = require('node:fs');
    const p = require('node:path').join(this.journal.dir, String(commitmentId).toLowerCase() + '.json');
    try {
      const signerWallet = new (require('ethers').Wallet)(this.journal.signerKey);
      const buyerAddr = this.opts.chain && this.opts.chain.buyer
        ? this.opts.chain.buyer
        : (op && op.buyerAddress);
      if (!buyerAddr) return false; // cannot authenticate issue without buyer identity
      await jw.append({
        transition: 'issue',
        role: 'buyer',
        by: buyerAddr,
        contractAction: 'issue',
        resultingState: 'Issued',
        at: new Date().toISOString(),
        observed: false,
        signerWallets: [signerWallet],
        recoveredSigner: buyerAddr,
        submitter: this.opts.relayer.account,
        txHash: null,
        blockHash: null,
        authorization: { kind: 'issue-record', opId: commitmentId, note: 'authenticated issue entry (commitment binding); settlement head freezes this tail' },
      });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(jw.snapshot(), null, 2), 'utf8');
      fs.renameSync(tmp, p);
      return true;
    } catch (e) {
      this.log.warn('[d3] journal issue-prefix append failed for ' + String(commitmentId).slice(0, 14) + ': ' + e.message);
      return false;
    }
  }

  /**
   * One work cycle: claim PENDING work, execute through the D2 pipeline, then
   * drain the outbox. Returns per-op results. Never blocks waiting on a
   * notification — polls committed work.
   */
  async processOnce({ exportAfter = true, rpc } = {}) {
    // First reconcile any SUPERVISED attempts (broadcast but not yet final)
    // — the worker discovers these by polling the durable attempt table, not
    // by an in-memory notification. A reorg-recheck or lost response leaves
    // an attempt SUBMISSION_UNCERTAIN/INCLUDED; the next cycle settles it.
    const supervised = await this.reconcileAll();
    const work = this.store.listWork(['PENDING']);
    const results = [];
    for (const w of work) {
      const res = await this._processWorkItem(w, { exportAfter, rpc });
      results.push(res);
    }
    // Drain any pending outbox rows whose ops are already terminal (worker
    // crash after chain execution but before journal write).
    const drain = await this.drainOutbox({ rpc });
    return { processed: results, drained: drain, supervised };
  }

  /** Loop until no PENDING work remains (bounded). */
  async processLoop({ maxIterations = 100, exportAfter = true, rpc } = {}) {
    const all = [];
    for (let i = 0; i < maxIterations; i += 1) {
      const r = await this.processOnce({ exportAfter, rpc });
      all.push(r);
      if (r.processed.length === 0 && r.drained.length === 0) break;
    }
    return all;
  }

  async _processWorkItem(w, { exportAfter, rpc }) {
    const op = this.store.getOperation(w.op_id);
    if (!op) {
      this.store.updateWorkStatus(w.op_id, 'FAILED');
      return { opId: w.op_id, ok: false, reason: 'NO_OPERATION' };
    }
    // Outcome already established (an earlier poll reconciled this op):
    // never re-broadcast — a re-broadcast of the same bytes against an
    // already-terminal escrow would revert (WrongState) and could look like
    // a second payout attempt. Mark the work RECONCILED and let the outbox
    // drain write the journal from the recorded outcome.
    const existingAttempts = this.store.getAttempts(w.op_id) || [];
    const lastExisting = existingAttempts[existingAttempts.length - 1];
    if (lastExisting && (lastExisting.status === 'FINALIZED' || lastExisting.status === 'REVERTED')) {
      this.store.updateWorkStatus(w.op_id, 'RECONCILED');
      const drainRes = await this.drainOutbox({ rpc });
      return { opId: w.op_id, ok: true, status: lastExisting.status, alreadyFinal: true, action: op.requestedAction || op.requested_action, drain: drainRes.filter((d) => d.opId === w.op_id) };
    }
    let actionArgs = this.store.getOperationActionArgs(w.op_id) || {};
    const requestedAction = contractActionFor(op.requestedAction || op.requested_action);
    if (!requestedAction) {
      // Not worker-executable (status/evidence/intent-only requests): mark the
      // work RECONCILED so the poll loop does NOT reprocess it forever. The
      // outbox intent for these was recorded at acceptance; nothing on-chain
      // executes.
      this.store.updateWorkStatus(w.op_id, 'RECONCILED');
      return { opId: w.op_id, ok: true, reason: 'NO_ONCHAIN_ACTION', action: op.requestedAction || op.requested_action };
    }

    // 1. Claim atomically.
    const claim = this.store.claimWork(w.op_id, w.version);
    if (!claim.ok) return { opId: w.op_id, ok: false, reason: claim.reason };

    try {
      // D3 CLOSURE: authorize the actionArgs BEFORE any calldata build. The
      // worker must not trust the persisted body args — it independently
      // verifies the verdict/mutual signatures against the on-chain escrow
      // and the operation bindings. A substituted/omitted evaluator or
      // mutual authorization is rejected HERE (worker rejection; the op is
      // marked FAILED — never executed, never broadcast).
      // requestAction here is the mapped CONTRACT action; the original
      // ACCESS action must survive the spread so the module can cross-check
      // the action's scope (getOperation returns only camelCase
      // requestedAction — the overwrite above would destroy it).
      const argAuth = await this.verifyActionArgsForOp({ ...op, requestedAction, accessAction: op.requestedAction || op.requested_action }, actionArgs);
      if (!argAuth.ok) {
        this.store.updateWorkStatus(w.op_id, 'FAILED');
        return { opId: w.op_id, ok: false, reason: 'ACTION_ARGS_UNAUTHORIZED', detail: { reason: argAuth.reason, detail: argAuth.detail || null }, action: requestedAction };
      }
      // ---- F3B: freeze the pre-settlement checkpoint (journal tail) BEFORE
      // ---- prepare/broadcast. The frozen head must equal the head the
      // ---- authorization was signed over (actionArgs.preSettlementHead); a
      // ---- mismatch means the authorization and the recorded boundary
      // ---- disagree — reject rather than sign a different outcome. On the
      // ---- timeout path (V3 refundTimeout) no head is expected: the journal
      // ---- keeps its ordinary entries but the contract records the headless
      // ---- outcome (no fabricated HeadCommitted).
      const v3 = Number(this.opts.custodyVersion || process.env.SAAX_CUSTODY_VERSION || 0) === 3;
      const emptySig = !actionArgs.sigBytes || actionArgs.sigBytes === '0x' || actionArgs.sigBytes === '0x0';
      const emptyRs = (!actionArgs.r || actionArgs.r === '0x' + '00'.repeat(32)) && (!actionArgs.s || actionArgs.s === '0x' + '00'.repeat(32)) && (actionArgs.v === 0 || actionArgs.v === undefined || actionArgs.v === '0');
      const timeoutLike = requestedAction === 'refundTimeout' || (requestedAction === 'refund' && emptySig && emptyRs);
      // F3B: obtain the authenticated checkpoint (ensure the pre-settlement
      // journal prefix exists, then freeze its current tail). The frozen head
      // is the tail BEFORE any settlement entry — it never depends on the
      // settlement tx, hash, or receipt.
      if (v3 && !timeoutLike && this.journal && this.journal.dir) {
        await this._ensureJournalPrefix(op.escrowId, op);
      }
      const tmoOb = this.store.getOutbox(w.op_id);
      const tmoManifest = (tmoOb && tmoOb.manifest_hash) || (op && op.manifestHash) || '';
      const frozenHead = this._freezeCheckpoint(op.escrowId, tmoManifest);
      const signedHead = actionArgs.preSettlementHead || null;
      const zeroHead = (x) => !x || x === '0x' + '00'.repeat(32) || /^0x0+$/.test(String(x));
      if (v3 && !timeoutLike) {
        if (zeroHead(frozenHead)) {
          this.store.updateWorkStatus(w.op_id, 'FAILED');
          return { opId: w.op_id, ok: false, reason: 'NO_CHECKPOINT', detail: 'V3 evaluator/mutual settlement requires a frozen journal checkpoint before broadcast', action: requestedAction };
        }
        if (zeroHead(signedHead)) {
          this.store.updateWorkStatus(w.op_id, 'FAILED');
          return { opId: w.op_id, ok: false, reason: 'V3_HEAD_UNSIGNED', detail: 'V3 authorization must carry the preSettlementHead it authorizes', action: requestedAction };
        }
        if (String(frozenHead).toLowerCase() !== String(signedHead).toLowerCase()) {
          this.store.updateWorkStatus(w.op_id, 'FAILED');
          return { opId: w.op_id, ok: false, reason: 'CHECKPOINT_MISMATCH', detail: { frozen: frozenHead, signed: signedHead }, action: requestedAction };
        }
        // Bind the frozen head into the actionArgs so the calldata carry the
        // SAME checkpoint the authorization covered.
        actionArgs = { ...actionArgs, preSettlementHead: frozenHead };
      } else if (v3 && timeoutLike) {
        // Headless timeout: reject a caller-supplied head (false checkpoint).
        if (!zeroHead(signedHead)) {
          this.store.updateWorkStatus(w.op_id, 'FAILED');
          return { opId: w.op_id, ok: false, reason: 'FALSE_CHECKPOINT_ON_TIMEOUT', detail: 'timeout refund is headless; a submitted checkpoint is rejected', action: requestedAction };
        }
        actionArgs = { ...actionArgs, preSettlementHead: undefined };
      }
      // 2. Prepare the ALREADY-ACCEPTED op (single-tx acceptance means the
      //    work row IS the durable record; do NOT re-run accept with a
      //    different action — that would conflict). _prepareAccepted runs
      //    D1+D2: prereqs, nonce reservation, sign, durable persist.
      //    The op ROW carries the ACCESS action ('submit verdict'); the
      //    prereqs validator keys on requestedAction — pass the CONTRACT
      //    action so state/cutoff checks see 'release' (the escrow state
      //    permits release from Funded). The original access action stays in
      //    the bindings for the journal.
      const opForPrepare = { ...op, requestedAction };
      if (process.env.SAAX_D3_DEBUG) console.error('[d3-debug] opForPrepare requestedAction=', JSON.stringify(opForPrepare.requestedAction));
      const prep = await this._prepareAccepted(opForPrepare, {
        requestedAction,
        actionArgs,
        bindings: {
          agreementRef: op.agreementRef || op.agreement_ref,
          escrowId: op.escrowId,
          chainId: this.opts.chain.id,
          custody: this.opts.chain.custody,
          requestedAction,
          payloadDigest: op.payloadDigest || op.payload_digest,
          authNonce: op.authNonce || op.auth_nonce,
          authRole: op.authRole || op.auth_role,
          authExpiry: op.authExpiry || op.auth_expiry,
          cutoff: null,
        },
      });
      if (!prep.ok) {
        this.store.updateWorkStatus(w.op_id, 'FAILED');
        return { opId: w.op_id, ok: false, reason: prep.reason || 'PREPARE_FAILED', detail: prep.detail || null, action: requestedAction };
      }
      this.store.updateWorkStatus(w.op_id, 'PREPARED');

      // 3. Broadcast + reconcile through the D2 pipeline.
      const bc = await this.broadcastPrepared(w.op_id);
      if (!bc.ok && bc.reason !== 'SUBMISSION_UNCERTAIN') {
        this.store.updateWorkStatus(w.op_id, 'BLOCKED');
        return { opId: w.op_id, ok: false, reason: bc.reason, detail: bc.detail || null, action: requestedAction };
      }
      this.store.updateWorkStatus(w.op_id, 'BROADCAST');

      const rec = await this.reconcileOutcome(w.op_id, { allowRebroadcast: false });
      if (!rec.ok && rec.status !== 'FINALIZED' && rec.status !== 'FINALIZED_EXTERNAL' && rec.status !== 'FINALIZED_AFTER_REORG') {
        // Not yet final — stays supervised; a later cycle re-reconciles.
        return { opId: w.op_id, ok: false, reason: rec.reason || 'NOT_FINAL', status: rec.status, action: requestedAction, pending: true };
      }

      // 4. Mark work RECONCILED + drain the outbox. Outcome evidence is real
      //    (receipt/events/escrow state); the outbox intent tells us which
      //    journal transition to confirm.
      this.store.updateWorkStatus(w.op_id, 'RECONCILED');
      const drainRes = await this.drainOutbox({ rpc });
      if (exportAfter && this.journal) {
        try {
          const exp = await this.buildV4Export(w.op_id, { rpc });
          return { opId: w.op_id, ok: true, status: rec.status, outcome: rec.outcome ? rec.outcome.evidence : null, action: requestedAction, export: exp, drain: drainRes.filter((d) => d.opId === w.op_id) };
        } catch (e) {
          return { opId: w.op_id, ok: true, status: rec.status, outcome: rec.outcome ? rec.outcome.evidence : null, action: requestedAction, exportError: e.message, drain: drainRes.filter((d) => d.opId === w.op_id) };
        }
      }
      return { opId: w.op_id, ok: true, status: rec.status, outcome: rec.outcome ? rec.outcome.evidence : null, action: requestedAction, drain: drainRes.filter((d) => d.opId === w.op_id) };
    } catch (e) {
      this.log.error('[d3] work item failed op=' + w.op_id + ': ' + e.message);
      return { opId: w.op_id, ok: false, reason: 'WORK_FAILED', detail: e.message, action: requestedAction };
    }
  }

  /**
   * Drain pending outbox rows into REAL journal entries tied to actual
   * receipts/events. Reads the op's recorded outcome (attempt FINALIZED) and
   * the outbox intent; writes the confirmed journal entry with by =
   * authorizing party, submitter = relayer account, tx/block refs from the
   * attempt evidence. Idempotent: a completed outbox row is skipped; the
   * journal writer's eventId dedup rejects a re-drain of the same event.
   */
  async drainOutbox({ rpc } = {}) {
    const pending = this.store.listOutbox(['PENDING']);
    const results = [];
    for (const ob of pending) {
      if (this._seenOutbox.has(ob.id)) continue;
      this._seenOutbox.add(ob.id);
      const op = this.store.getOperation(ob.op_id);
      const attempts = this.store.getAttempts(ob.op_id);
      const last = attempts[attempts.length - 1];
      const terminal = last && (last.status === 'FINALIZED' || last.status === 'REVERTED' || last.status === 'BLOCKED');
      if (!terminal) {
        results.push({ opId: ob.op_id, status: 'PENDING_OUTCOME', note: 'op not terminal; journal deferred until reconcile establishes the outcome' });
        continue;
      }
      if (last.status === 'REVERTED') {
        this.store.markOutboxFailed(ob.op_id, 'attempt reverted — no custody success to journal');
        results.push({ opId: ob.op_id, status: 'REVERTED_NO_JOURNAL', reason: 'reverted receipt consumes nonce; no custody success' });
        continue;
      }
      if (last.status === 'BLOCKED') {
        this.store.markOutboxFailed(ob.op_id, 'attempt blocked — journal deferred (no fabricated entry)');
        results.push({ opId: ob.op_id, status: 'BLOCKED_NO_JOURNAL', reason: 'blocked attempt; surfaced as incident; no fabricated entry' });
        continue;
      }

      const outcome = last.outcome ? (typeof last.outcome === 'string' ? JSON.parse(last.outcome) : last.outcome) : {};
      const intent = (() => { try { return JSON.parse(ob.intent_json); } catch { return {}; } })();
      const action = contractActionFor(op.requestedAction || op.requested_action);
      // Distinguish a TIMEOUT refund (no verdict — contract rule, role 'open')
      // from an EVALUATOR refund (verdict-authorized). Never conflate them:
      // the timeout path has NO evaluator authority and the journal must say
      // 'timeout-refund', not 'refund'.
      let transition = intent.transition || transitionFor(action) || 'intent';
      let isTimeoutRefund = transition === 'timeout-refund';
      if (!isTimeoutRefund && action === 'refund' && transition === 'refund') {
        const args = this.store.getOperationActionArgs(ob.op_id) || {};
        const emptyVerdict = !args.sigBytes || args.sigBytes === '0x' || args.sigBytes === '0x0';
        isTimeoutRefund = emptyVerdict;
        if (isTimeoutRefund) transition = 'timeout-refund';
      }

      // Journal writer requires role/authorizing-by. From the OP record:
      //   override? The op row carries auth_role (the access role). The
      //   authorizing party for an executed action is the actor from the
      //   contract path — for evaluator actions the Safe; for timeout refund
      //   the open rule; for dispute the buyer|seller. We record by = the
      //   contract-recognized authorizer when known; otherwise by = the access
      //   auth signer (already validated at acceptance).
      const role = isTimeoutRefund ? 'open' : (op.authRole === 'evaluator' ? 'evaluator' : (op.authRole === 'seller' ? 'seller' : 'buyer'));
      // by = the AUTHORIZING party for the transition. For evaluator
      // release/refund that is the escrow's evaluator (the contract accepted
      // its authorization); for timeout refund the contract rules apply with
      // the beneficiary fixed by the contract. Read the escrow from the chain
      // so by reflects the actual agreed authority — never tx.from (the
      // relayer/submitter), never the operator key.
      const byAuthorizer = isTimeoutRefund
        ? this.opts.relayer.account // timeout: contract rule, no authorizing party; submitter recorded as by with role 'open'
        : await this._authorizingPartyFor(ob, op, transition, outcome);

      if (!this.journal || !this.journal.dir || !this.journal.signerKey) {
        // No journal configured — mark complete (recording gap surfaced in
        // results, not fabricated).
        this.store.markOutboxComplete(ob.op_id);
        results.push({ opId: ob.op_id, status: 'COMPLETE_NO_JOURNAL', note: 'journal not configured; outbox drained without writing entries' });
        continue;
      }

      try {
        const jw = this._journalWriter(ob.commitment_id, ob.manifest_hash, ob.chain_id, ob.custody_address);
        const signerWallet = new (require('ethers').Wallet)(this.journal.signerKey);
        const entry = await jw.append({
          transition,
          role,
          by: byAuthorizer,
          contractAction: op.requestedAction || op.requested_action,
          resultingState: outcome.escrowState !== undefined ? ('State' + outcome.escrowState) : 'Confirmed',
          at: new Date().toISOString(),
          observed: true,
          signerWallets: [signerWallet],
          recoveredSigner: byAuthorizer,
          submitter: this.opts.relayer.account,
          txHash: outcome.txHash || last.tx_hash,
          blockHash: outcome.blockHash || null,
          authorization: { kind: 'worker-executed', opId: ob.op_id, relayer: this.opts.relayer.account, note: 'confirmed from actual receipt/event evidence; journal entry attested by operator key, not the actor key' },
        });
        // Persist journal + mark outbox COMPLETE atomically as a pair (write
        // journal first; if the journal write fails the outbox stays PENDING
        // and re-drain recovers WITHOUT re-execution).
        const fs = require('node:fs');
        const p = require('node:path').join(this.journal.dir, String(ob.commitment_id).toLowerCase() + '.json');
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(jw.snapshot(), null, 2), 'utf8');
        fs.renameSync(tmp, p);
        this.store.markOutboxComplete(ob.op_id);
        results.push({ opId: ob.op_id, status: 'JOURNALED', transition, entryHash: entry.entryHash });
      } catch (e) {
        // Journal write failed AFTER chain execution: outbox stays PENDING.
        // Recovery re-drains from the recorded outcome — never re-executes.
        this.log.error('[d3] outbox drain journal write failed op=' + ob.op_id + ': ' + e.message);
        results.push({ opId: ob.op_id, status: 'JOURNAL_WRITE_FAILED', reason: e.message, recoverable: true });
      }
    }
    return results;
  }

  /** Resolve the AUTHORIZING party for a transition from the on-chain escrow
   *  (the party the contract accepted authorization from) — the journal's
   *  `by` must be the authorizer, never the relayer submitter and never the
   *  operator attestation key. Falls back to the custody address only when
   *  the escrow read fails (surfaced, not fabricated). */
  async _authorizingPartyFor(ob, op, transition, outcome) {
    try {
      const esc = await this.getEscrow(op.escrowId);
      if (esc && esc.evaluator) {
        if (transition === 'release' || transition === 'refund') return esc.evaluator;
      }
      if (esc && esc.buyer && transition === 'dispute') return esc.buyer;
    } catch { /* fall through to custody */ }
    return op.custodyAddress;
  }

  /**
   * Build a v4 export from PERSISTED RECORDS + chain evidence — never a
   * separately reconstructed success fixture. The op row carries the
   * agreement reference; the attempt carries the actual receipt/events/escrow
   * state; the outbox intent carries the journal transition. When a full
   * agreement object is not available in the store, the exporter surface
   * covers what persisted records can truthfully claim and marks the rest
   * explicitly as not-certified.
   */
  async buildV4Export(opId, { rpc } = {}) {
    const op = this.store.getOperation(opId);
    if (!op) throw new Error('NO_OPERATION');
    const attempts = this.store.getAttempts(opId);
    const last = attempts[attempts.length - 1] || null;
    const outcome = last && last.outcome ? (typeof last.outcome === 'string' ? JSON.parse(last.outcome) : last.outcome) : null;
    if (!outcome) throw new Error('NO_OUTCOME_EVIDENCE');
    const intent = (() => {
      const ob = this.store.getOutbox(opId);
      if (!ob) return {};
      try { return JSON.parse(ob.intent_json); } catch { return {}; }
    })();

    // D3 CLOSURE: the complete service-generated export RETAINS the actual
    // authenticated artifacts persisted at acceptance (signed v4 agreement +
    // authorizations + genuine EAS anchor + fulfillment evidence). Never
    // reconstructed, never borrowed from another lifecycle. When an artifact
    // was not retained, it is emitted as null (honest INCOMPLETE/not
    // certified — the verifier reports the gap rather than a pass).
    let artifacts = null;
    try {
      const raw = this.store.getOperationArtifacts ? this.store.getOperationArtifacts(opId) : null;
      if (raw) artifacts = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { artifacts = null; }

    const agreement = (artifacts && artifacts.agreement) ? artifacts.agreement : {
      commitmentId: op.escrowId,
      manifestVersion: 4,
      profile: 'OBJECTIVE_DIGITAL',
      custody: { chainId: op.chainId, custodyAddress: op.custodyAddress, principal: '0' },
      policy: { version: 'saax-custody-policy-v1', digest: null },
      consents: {},
      // No signed agreement was retained — the export contains exactly what
      // the records can prove; the verifier reports the remainder
      // INCOMPLETE/not-certified rather than fabricate it.
    };

    const exp = {
      formatVersion: 4,
      agreement,
      commitmentDigest: (agreement && (agreement.manifestHash || agreement.signatureHex)) ? (artifacts.commitmentDigest || agreement.commitmentDigest || '0x' + '00'.repeat(32)) : '0x' + '00'.repeat(32),
      authorizations: (artifacts && artifacts.authorizations) ? artifacts.authorizations : [],
      lifecycleProfile: intent.kind === 'intent' ? 'issue' : 'full',
      lifecycle: outcome.txHash ? {
        funding: (artifacts && artifacts.lifecycle && artifacts.lifecycle.funding) ? artifacts.lifecycle.funding : { txHash: null, blockHash: null },
        settlement: { txHash: outcome.txHash, blockHash: outcome.blockHash || null },
      } : undefined,
      finality: { mode: 'local-synthetic' },
      journal: this._journalSnapshot(op.escrowId),
      anchor: (artifacts && artifacts.anchor) ? artifacts.anchor : null,
      evidence: (artifacts && artifacts.evidence) ? artifacts.evidence : null,
    };
    return exp;
  }

  _journalSnapshot(commitmentId) {
    for (const w of this._journalWriters.values()) {
      const snap = w.snapshot();
      if (String(snap.commitmentId).toLowerCase() === String(commitmentId).toLowerCase()) return snap;
    }
    const fs = require('node:fs');
    if (this.journal && this.journal.dir) {
      const p = require('node:path').join(this.journal.dir, String(commitmentId).toLowerCase() + '.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    return null;
  }

  /** Recovery: extend D2 to include PENDING work + PENDING outbox. */
  recoverWork() {
    const base = super.recoverWork();
    const work = this.store.listWork(['PENDING', 'CLAIMED', 'PREPARED', 'BROADCAST']);
    const outbox = this.store.listOutbox(['PENDING']);
    return { ...base, work: work.map((w) => w.op_id), outbox: outbox.map((o) => o.op_id) };
  }
}

module.exports = { D3Worker, contractActionFor, transitionFor };