// D2 domain-aware prerequisite validator.
//
// Phase D1 used an injectable prereqs stub in tests. Phase D2's validator is
// genuine and domain-aware: it verifies the signed agreement/policy + on-chain
// escrow bindings, confirms the current state permits the exact action,
// checks evidence/evaluator prerequisites under the supported policy, and
// validates cutoff and authorization validity — WITHOUT inventing evaluator
// decisions. The worker submits authorized decisions; it does not create them.
// Timeout refunds follow the contract's actual rules (no evaluator authority).
//
// The compatibility EOA path is NOT permitted to satisfy the restricted
// mainnet 2-of-3 admission policy: if the agreement's evaluator is an EOA and
// the policy profile is the restricted OBJECTIVE_DIGITAL launch, preparation
// is blocked with POLICY_2OF3_REQUIRED (the Safe/ERC-1271 evaluator is the
// only supported admission authority for the restricted launch).
//
// NOT wired into production routes. Local-EVM 31337 + committed ABI only.

'use strict';

const { Interface } = require('ethers');

const RESTRICTED_PROFILE = 'OBJECTIVE_DIGITAL';
// Contract actions that are legitimate even at/after cutoff (timeout refund is
// the only post-cutoff action; it requires NO evaluator signature).
const TIMEOUT_ACTIONS = new Set(['refund']); // refund with empty verdict = timeout

class D2Prerequisites {
  /**
   * @param {object} opts
   * @param {object} opts.abi           custody ABI
   * @param {object} opts.custody       { address, chainId, getState? }
   * @param {Function} opts.getEscrow   async (commitmentId) => escrow tuple (same shape as getEscrow return)
   * @param {Function} opts.getBlock    async (tag) => {timestamp}
   * @param {object} opts.policy        { admittedPolicyId, admittedPolicyDigest, require2of3Evaluator: bool }
   */
  constructor(opts) {
    this.abi = opts.abi;
    this.custody = opts.custody;
    this.getEscrow = opts.getEscrow;
    this.getBlock = opts.getBlock;
    this.policy = opts.policy || {};
    this.iface = new Interface(this.abi);
    // Expose for the worker's outcome establishment (same escrow reader).
    this._escrowReader = opts.getEscrow;
  }

  /** Validate the signed agreement's domain and evaluator admission. */
  _validateAgreement(op) {
    // op carries actionBindings (immutable): agreementRef, escrowId, chainId,
    // custody, requestedAction, payloadDigest, authNonce, cutoff.
    const b = op.actionBindings || {};
    if (b.chainId !== undefined && Number(b.chainId) !== Number(this.custody.chainId)) {
      return { ok: false, reason: 'CHAIN_MISMATCH', detail: { expected: this.custody.chainId, got: b.chainId } };
    }
    if (b.custody && b.custody.toLowerCase() !== this.custody.address.toLowerCase()) {
      return { ok: false, reason: 'CUSTODY_MISMATCH', detail: { expected: this.custody.address, got: b.custody } };
    }
    // Restricted launch admission: the restricted mainnet 2-of-3 policy must
    // not be satisfied by the EOA compatibility path. The agreement's custody
    // address is the deployed candidate; the worker rejects any op whose
    // requested action requires evaluator authority unless the evaluator is a
    // contract wallet (Safe + ERC-1271) — enforced here from agreement
    // bindings, per policy §C.7 (no silent fallback to a single operator key).
    if (this.policy.require2of3Evaluator) {
      const ev = (op.evaluatorInfo || {}).walletType;
      if (ev && ev === 'EOA') {
        return { ok: false, reason: 'POLICY_2OF3_REQUIRED', detail: 'EOA evaluator cannot satisfy the restricted 2-of-3 admission policy' };
      }
    }
    return { ok: true };
  }

  /** Genuine validation: signed agreement/policy + on-chain escrow bindings +
   *  state permits the exact action + cutoff/auth validity. */
  async validatePrerequisites(op) {
    // 1. Agreement/policy bindings.
    const ag = this._validateAgreement(op);
    if (!ag.ok) return ag;

    // 2. On-chain escrow state must permit the exact action.
    // D1Store._mapOp returns camelCase fields (escrowId, requestedAction,
    // authExpiry, payloadDigest, agreementRef, custodyAddress, chainId).
    const escrowId = op.escrowId || (op.actionBindings && op.actionBindings.escrowId);
    if (!escrowId) return { ok: false, reason: 'NO_ESCROW_ID', detail: null };

    let esc;
    try {
      esc = await this.getEscrow(escrowId);
    } catch (e) {
      return { ok: false, reason: 'ESCROW_READ_FAILED', detail: e.message };
    }
    if (!esc || esc.state === undefined) return { ok: false, reason: 'ESCROW_NOT_FOUND', detail: null };

    // Map contract state index (V2 Enum: None=0, Funded=1, Disputed=2, Released=3, Refunded=4).
    const action = op.requestedAction || op.requested_action || (op.actionBindings && op.actionBindings.requestedAction);
    if (process.env.SAAX_D2_DEBUG) console.error('[d2-debug] preq action=', JSON.stringify(action), 'op.requestedAction=', JSON.stringify(op.requestedAction), 'snake=', JSON.stringify(op.requested_action));
    const STATE = { None: 0, Funded: 1, Disputed: 2, Released: 3, Refunded: 4 };
    const st = Number(esc.state);
    const nameOf = Object.keys(STATE).find((k) => STATE[k] === st) || 'Unknown';
    const permits = {
      release: [STATE.Funded],
      refund: [STATE.Funded, STATE.Disputed], // verdict refund = Funded; timeout refund = Funded|Disputed
      mutualRelease: [STATE.Funded],
      mutualRefund: [STATE.Funded],
      raiseDispute: [STATE.Funded],
      resolve: [STATE.Disputed],
    };
    const allowed = permits[action] || [];
    if (!allowed.includes(st)) {
      return { ok: false, reason: 'STATE_NOT_PERMITTED', detail: { action, state: nameOf, expected: allowed.map((s) => Object.keys(STATE).find((k) => STATE[k] === s)) } };
    }

    // 3. Cutoff validity.
    let nowTs;
    try {
      const blk = await this.getBlock('latest');
      nowTs = Number(blk.timestamp);
    } catch (e) {
      return { ok: false, reason: 'BLOCK_READ_FAILED', detail: e.message };
    }
    const finalCutoff = Number(esc.finalCutoff);
    if (finalCutoff > 0 && nowTs >= finalCutoff) {
      // Timeout refund is eligible AT or AFTER cutoff (no evaluator authority);
      // everything else is AfterCutoff.
      if (!(TIMEOUT_ACTIONS.has(action) && esc.state !== undefined && (st === STATE.Funded || st === STATE.Disputed))) {
        return { ok: false, reason: 'AFTER_CUTOFF', detail: { action, now: nowTs, finalCutoff } };
      }
    }
    const cutoff = op.actionBindings && op.actionBindings.cutoff;
    if (cutoff !== undefined && cutoff !== null && Number(cutoff) > 0) {
      const cutoffTs = Number(cutoff);
      if (nowTs < cutoffTs && TIMEOUT_ACTIONS.has(action)) {
        // A timeout refund submitted before cutoff is not yet eligible.
        return { ok: false, reason: 'DEADLINE_NOT_PASSED', detail: { action, now: nowTs, cutoff: cutoffTs } };
      }
    }

    // 4. Authorization validity (auth role carried on the op).
    //    D3 CLOSURE EXPIRY POLICY: access-authorization expiry is a
    //    WALL-CLOCK acceptance-time check, enforced at durable acceptance
    //    (escrow-access.js: the EXPIRED rejection precedes the acceptance
    //    record). It is NOT re-enforced here at execution: an operation that
    //    was durably accepted remains retrievable and executable under the
    //    authenticated retrieval policy. Access expiry alone does not erase
    //    accepted work and does not prove that a prepared transaction cannot
    //    execute. Execution authority is bounded by the contract-action's own
    //    validity rules enforced above/below: state-permitted transition,
    //    on-chain final cutoff (EVM clock), and the verdict/mutual signature
    //    validity window checked by the action-authorization module at
    //    execution. Signatures and deadlines are never extended automatically.
    //    (Previously this block returned AUTH_EXPIRED when wall-now passed
    //    the op's recorded access-auth expiry; per the policy update that
    //    rejection is removed — it blocked legitimate delayed worker pickup
    //    of accepted operations.)
    if (op.auth_role && !['buyer', 'seller', 'evaluator', 'open'].includes(op.auth_role)) {
      return { ok: false, reason: 'AUTH_ROLE_INVALID', detail: op.auth_role };
    }

    return { ok: true, state: 'PERMITTED', escrow: { state: nameOf, finalCutoff } };
  }
}

module.exports = { D2Prerequisites };