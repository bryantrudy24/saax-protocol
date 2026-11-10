// D1 execution worker — Phase D1: durable operation acceptance, prerequisite
// validation, account-nonce reservation, transaction signing (NO broadcast),
// durable prepared-transaction storage.
//
// This checkpoint MUST NOT broadcast transactions. There is no broadcast code
// path in this module or anywhere in this package. Phase D2 adds broadcast and
// reconciliation.
//
// Isolated: not wired into production routes, not a migration of the hosted
// service store. Uses worker/d1-store.js (node:sqlite ACID store).

'use strict';

const path = require('node:path');
const { D1Store } = require('./d1-store.js');
const { signTransactionLocal, buildCustodyCalldata } = require('./d1-tx.js');
const { signViaVault } = require('./signing-vault.js');

// ---- supported custody actions (V2 restricted profile) ---------------------
// F3B: refundTimeout is the V3 headless timeout path (no verdict, no
// checkpoint). It is accepted explicitly; V2 lanes never produce it.
const SUPPORTED_ACTIONS = new Set([
  'release', 'refund', 'refundTimeout', 'mutualRelease', 'mutualRefund', 'raiseDispute', 'resolve',
]);

class D1Worker {
  /**
   * @param {object} opts
   * @param {string} opts.storePath absolute path to the sqlite store
   * @param {object} opts.abi SAAXEscrowCustodyV2 artifact ABI (array)
   * @param {object} opts.prereqs
   * @param {Function} opts.prereqs.validatePrerequisites async (op) => {ok, reason?, state?}
   *   — verifies signed agreement/policy, on-chain escrow bindings, current state
   *     permits the exact action, evidence/evaluator prerequisites, cutoff + auth
   *     validity, genuine applicable evaluator or mutual signatures.
   * @param {object} opts.chain { id: number, custody: string, rpc? }
   * @param {Function} opts.nextNonce async (account, chainId) => number
   *   — returns the next unreserved account nonce for the dedicated relayer.
   * @param {object} opts.relayer { account: string, wallet: ethers.Wallet }
   * @param {Function} [opts.signer] sign (wallet, params) => {signedBytes, txHash, nonce}
   *   — default: worker/d1-tx.js signTransactionLocal (never broadcasts).
   *   Injectable so tests can simulate signing/persistence crashes.
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    this.opts = opts;
    this.store = new D1Store(opts.storePath, { wipe: !!opts.wipeStore });
    this.log = opts.logger || { info: () => {}, warn: () => {}, error: () => {} };
    this._locks = new Map();
    this._signer = opts.signer || signTransactionLocal;
    // Phase D4A restricted-signing policy. When set, signing goes through the
    // vault (chain/custody/action/value/fee bounds are enforced) instead of the
    // bare default signer. protection:true additionally seals the signed bytes
    // into a versioned AES-256-GCM envelope before persist (no plaintext at rest).
    this._signingPolicy = opts.signingPolicy || null;
    this._vault = opts.vault || null; // { sealPrepared, openPrepared }
    this._protected = !!opts.protection;
    // Phase D4B external-signer path. When set, signing goes through an
    // EXTERNALLY HELD relayer key (separate process / remote adapter) instead
    // of an in-process relayer key. The worker never holds the external key;
    // `opts.relayer.account` must equal the external signer's identity. The
    // external signer is NOT the evaluator.
    this._externalSigner = opts.externalSigner || null;
    if (this._protected && !this._vault) throw new Error('PROTECTED_WORKER_REQUIRES_VAULT');
    if (this._externalSigner && !this._signingPolicy) throw new Error('EXTERNAL_SIGNER_REQUIRES_WORKER_POLICY');
    if (!SUPPORTED_ACTIONS.has(opts.defaultAction) && opts.defaultAction) {
      throw new Error('unsupported_action:' + opts.defaultAction);
    }
  }

  close() { this.store.close(); }

  // ---- acceptance -----------------------------------------------------------

  /**
   * Atomically record durable operation acceptance.
   * Identical authenticated retries retrieve the same operation; changed payload
   * with the same authorization nonce is rejected.
   */
  accept({ opId, payloadDigest, agreementRef, escrowId, requestedAction, authNonce, authRole, authExpiry }) {
    const chain = this.opts.chain;
    return this.store.acceptOperation({
      opId, payloadDigest, agreementRef, escrowId,
      chainId: chain.id, custodyAddress: chain.custody,
      requestedAction, authNonce, authRole, authExpiry,
    });
  }

  // ---- preparation ------------------------------------------------------------

  /**
   * Prepare one operation end-to-end (accept -> validate -> reserve nonce -> sign
   * -> persist PREPARED). Returns the durable record. NEVER broadcasts.
   *
   * @param {object} params { opId, payloadDigest, agreementRef, escrowId, requestedAction, authNonce, authRole, authExpiry, actionArgs, bindings }
   */
  async prepare(opParams) {
    const { opId, requestedAction, actionArgs, bindings } = opParams;
    const acceptRes = this.accept(opParams);
    if (!acceptRes.ok) return acceptRes; // conflict / changed payload
    // Identical authenticated retry: if the operation is already PREPARED, return
    // the existing durable state — never prepare a second conflicting action.
    if (acceptRes.op.status === 'PREPARED') {
      const prep = this.store.getPrepared(opId);
      return { ok: true, idempotent: true, status: 'PREPARED', tx: prep ? { txHash: prep.tx_hash, nonce: prep.nonce, destination: prep.destination } : null, opId };
    }
    return this._prepareAccepted(acceptRes.op, { requestedAction, actionArgs, bindings });
  }

  /** Prepare an already-accepted operation (worker resume path). */
  async _prepareAccepted(op, { requestedAction, actionArgs, bindings }) {
    const chain = this.opts.chain;
    if (!SUPPORTED_ACTIONS.has(requestedAction)) {
      return { ok: false, reason: 'UNSUPPORTED_ACTION', opId: op.op_id };
    }

    // 1. Prerequisite validation (fail closed)
    const pr = await this.opts.prereqs.validatePrerequisites(op);
    if (!pr.ok) {
      return { ok: false, reason: pr.reason || 'PREREQUISITE_FAILED', detail: pr.detail || null, opId: op.op_id };
    }
    if (pr.state && pr.state !== 'PERMITTED') {
      return { ok: false, reason: 'STATE_NOT_PERMITTED', detail: pr.state, opId: op.op_id };
    }

    // 2. Construct calldata
    let calldata;
    try {
      calldata = buildCustodyCalldata(this.opts.abi, requestedAction, actionArgs, this.opts.custodyVersion || Number(process.env.SAAX_CUSTODY_VERSION || 0));
    } catch (e) {
      return { ok: false, reason: 'CALldATA_BUILD_FAILED', detail: e.message, opId: op.op_id };
    }

    const relayer = this.opts.relayer;

    // 3. Reserve a unique account nonce — SERIALIZED per relayer account.
    //    The per-account mutex is held across reserve->sign->persist so two
    //    workers cannot interleave nonce reservation for the same account.
    //    Cross-process, the store's UNIQUE nonce_reservations constraint is the
    //    final arbiter: a reservation conflict is a TRANSIENT race, so the
    //    worker refetches the next nonce and retries a bounded number of times.
    //    A lease alone cannot revoke a signed transaction; the reservation is
    //    the nonce-authority enforcement layer (see worker-plan doc).
    const releaseLock = await this._accountLock(relayer.account);
    try {
      const MAX_NONCE_RETRIES = this.opts.maxNonceRetries || 3;
      let nonce = await this.opts.nextNonce(relayer.account, chain.id);
      let res = this.store.reserveNonce({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id });
      let retried = 0;
      while (!res.ok && retried < MAX_NONCE_RETRIES) {
        nonce = await this.opts.nextNonce(relayer.account, chain.id);
        res = this.store.reserveNonce({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id });
        retried += 1;
      }
      if (!res.ok) {
        // Never silently recycle: record the stalled reservation and obligation.
        this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: res.reason + ':' + (res.existing ? res.existing.opId : '?') });
        return { ok: false, reason: res.reason, detail: res.existing || null, opId: op.op_id };
      }

      // Sign WITHOUT broadcasting.
      let signed;
      try {
        const fallbackGas = this.opts.gas || { gasLimit: '200000', gasPrice: '1000000000' };
        const gasLimit = bindings.gasLimit || fallbackGas.gasLimit;
        const gasPrice = bindings.gasPrice || fallbackGas.gasPrice;
        if (this._externalSigner) {
          // Phase D4B external-signer path: obtain signed bytes from an
          // EXTERNALLY HELD relayer key (separate process / remote adapter),
          // then INDEPENDENTLY re-validate the returned bytes against the
          // immutable prepared intent before sealing. The worker never holds
          // the external key; `relayer.account` is the external signer's
          // identity (verified via getSignerIdentity). Policy validation
          // happens inside the external signer AND here (ExternalSigner.
          // validateSignedBytes fails closed on wrong key / tampered bytes /
          // mismatched intent). The external signer is NOT the evaluator:
          // evaluator approval remains the Safe/ERC-1271 mechanism.
          let extRes;
          // intent is immutable prepared intent; declared OUTSIDE the try so the
          // post-catch independent validation can reference it (scope fix).
          const intent = require('./transaction-intent.js').normalizeIntent({ to: chain.custody, chainId: chain.id, value: 0n, data: calldata, nonce, from: relayer.account, gasLimit, type: 2, maxFeePerGas: gasPrice, maxPriorityFeePerGas: BigInt(gasPrice)/2n });
          try {
            const policy = this._signingPolicy;
            const action = require('./signing-vault.js').decodeAction(this.opts.abi, calldata);
            if (Number(chain.id)!==Number(policy.allowedChainId) || chain.custody.toLowerCase()!==String(policy.custody).toLowerCase() || !policy.allowedActions?.has(action) || !policy.maxGasPrice || !policy.maxGasLimit || BigInt(gasPrice)>BigInt(policy.maxGasPrice) || BigInt(gasLimit)>BigInt(policy.maxGasLimit)) throw Object.assign(new Error('worker signing policy rejected'),{code:'POLICY_REJECTED'});
            if (typeof this.verifyActionArgsForOp !== 'function') throw Object.assign(new Error('external lane requires action authorization validator'),{code:'POLICY_REJECTED'});
            const approval = await this.verifyActionArgsForOp(op, actionArgs);
            // Surface the SPECIFIC authorization reason (e.g. VERDICT_SIG_AMBIGUOUS,
            // EVALUATOR_MISMATCH, BAD_VERDICT_SIG) so the failure is diagnosable,
            // not a generic unauthorized. Fail closed either way.
            if (!approval.ok) return {ok:false,reason:approval.reason || 'ACTION_ARGS_UNAUTHORIZED',detail:{ code: 'ACTION_ARGS_UNAUTHORIZED', reason: approval.reason },opId:op.op_id};
            const signReq = { ...intent };
            // 1. identity check (fail closed if the provider answers a
            //    different key than the configured relayer account)
            const ident = await this._externalSigner.getSignerIdentity();
            if (!ident || String(ident.address).toLowerCase() !== String(relayer.account).toLowerCase()) {
              throw Object.assign(new Error('external signer identity mismatch: expected ' + relayer.account + ' got ' + (ident && ident.address)), { code: 'EXTERNAL_SIGNER_WRONG_KEY' });
            }
            // 2. sign (external signer enforces its own policy; no broadcast)
            extRes = await this._externalSigner.signTransaction(signReq);
          } catch (e) {
            const code = e && e.code ? e.code : 'EXTERNAL_SIGNER_INTERNAL';
            this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'EXTERNAL_SIGNER:' + code + ':' + (e && e.message || e) });
            return { ok: false, reason: 'EXTERNAL_SIGNER_' + code, detail: (e && e.message) || code, opId: op.op_id };
          }
          if (!extRes || extRes.ok === false) {
            const code = (extRes && extRes.reason) || 'EXTERNAL_SIGNER_INTERNAL';
            this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'EXTERNAL_SIGNER_REJECTED:' + code });
            return { ok: false, reason: 'EXTERNAL_SIGNER_REJECTED', detail: code, opId: op.op_id };
          }
          // 3. independent recovery/validation of the returned signed bytes
          const { ExternalSigner } = require('./external-signer.js');
          const valid = ExternalSigner.validateSignedBytes(extRes.signedBytes, intent);
          if (!valid.ok) {
            this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'EXTERNAL_SIGNER_INVALID:' + valid.reason });
            return { ok: false, reason: 'EXTERNAL_SIGNER_INVALID', detail: valid.reason, opId: op.op_id };
          }
          if (valid.from && String(valid.from).toLowerCase() !== String(relayer.account).toLowerCase()) {
            this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'EXTERNAL_SIGNER_WRONG_SIGNER' });
            return { ok: false, reason: 'EXTERNAL_SIGNER_WRONG_SIGNER', detail: { expected: relayer.account, got: valid.from }, opId: op.op_id };
          }
          signed = { signedBytes: extRes.signedBytes, txHash: valid.txHash, nonce };
        } else if (this._signingPolicy) {
          // Phase D4A restricted path: enforce chain/custody/action/value/fee
          // bounds and the operation binding before signing.
          const vaultRes = await signViaVault(
            { opId: op.op_id, to: chain.custody, data: calldata, value: 0n, gasLimit, gasPrice, nonce, chainId: chain.id },
            { ...this._signingPolicy, expectedOpId: op.op_id, signer: relayer }
          );
          if (!vaultRes.ok) {
            this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'VAULT_REJECTED:' + vaultRes.reason });
            return { ok: false, reason: 'VAULT_REJECTED', detail: vaultRes.reason, opId: op.op_id };
          }
          signed = { signedBytes: vaultRes.signedBytes, txHash: vaultRes.txHash, nonce: vaultRes.nonce };
        } else {
          signed = await this._signer(relayer.wallet, {
            to: chain.custody,
            data: calldata,
            value: 0n,
            gasLimit,
            gasPrice,
            nonce,
            chainId: chain.id,
          });
        }
      } catch (e) {
        // Safe signing/persistence failure handling: never broadcast, never leave
        // a half-written record. Record stalled; operation stays ACCEPTED for retry.
        this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'SIGN_FAILED:' + e.message });
        return { ok: false, reason: 'SIGN_FAILED', detail: e.message, opId: op.op_id };
      }

      // Phase D4A: seal the signed bytes into a versioned AES-256-GCM envelope
      // (authenticated context = operation/chain/sender/accountNonce/intendedTx)
      // BEFORE persist. No plaintext signed bytes reach the store when protected.
      let signedEnvelope = null;
      if (this._protected && this._vault) {
        try {
          signedEnvelope = this._vault.sealPrepared(signed.signedBytes, {
            op: op.op_id,
            chain: chain.id,
            sender: relayer.account,
            accountNonce: Number(signed.nonce),
            intendedTx: { to: chain.custody, txHash: signed.txHash },
          });
        } catch (e) {
          this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'SEAL_FAILED:' + e.message });
          return { ok: false, reason: 'SEAL_FAILED', detail: e.message, opId: op.op_id };
        }
      }

      // 4. Persist the prepared tx DURABLY, atomically with the versioned claim.
      let persist;
      try {
        persist = this.store.persistPrepared({
          opId: op.op_id,
          destination: chain.custody,
          calldata,
          value: '0',
          gasLimit: String(bindings.gasLimit || this.opts.gas?.gasLimit || '200000'),
          gasPrice: String(bindings.gasPrice || this.opts.gas?.gasPrice || '1000000000'),
          nonce: signed.nonce,
          relayerAccount: relayer.account,
          chainId: chain.id,
          signedBytes: signedEnvelope ? null : signed.signedBytes,
          signedEnvelope,
          txHash: signed.txHash,
          actionBindings: {
            agreementRef: op.agreementRef,
            escrowId: op.escrowId,
            chainId: chain.id,
            custody: chain.custody,
            requestedAction,
            payloadDigest: op.payloadDigest,
            authNonce: op.authNonce,
            cutoff: bindings.cutoff || null,
          },
        });
      } catch (e) {
        // Persistence failure must fail closed: no broadcast, op stays ACCEPTED,
        // stalled reservation recorded (nonce NOT recycled).
        this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'PERSIST_FAILED:' + e.message });
        return { ok: false, reason: 'PERSIST_FAILED', detail: e.message, opId: op.op_id };
      }
      if (!persist.ok) {
        this.store.recordStalled({ relayerAccount: relayer.account, chainId: chain.id, nonce, opId: op.op_id, reason: 'PERSIST_FAILED' });
        return { ok: false, reason: 'PERSIST_FAILED', detail: null, opId: op.op_id };
      }

      // 5. Mark PREPARED only after persistence succeeded (atomic versioned claim).
      const claim = this.store.claimOperation(op.op_id, op.version);
      if (!claim.ok) {
        // Someone else claimed between our read and write: fail closed, do not
        // leave a second conflicting prepared action.
        return { ok: false, reason: claim.reason, detail: claim, opId: op.op_id };
      }
      this.store.markNoncePrepared({ relayerAccount: relayer.account, chainId: chain.id, nonce: signed.nonce });

      // Never return signed bytes upward beyond this boundary.
      return {
        ok: true,
        opId: op.op_id,
        status: 'PREPARED',
        tx: { txHash: signed.txHash, nonce: signed.nonce, destination: chain.custody },
      };
    } finally {
      releaseLock();
    }
  }

  // ---- recovery --------------------------------------------------------------

  /**
   * Recover accepted + prepared work after restart. Returns:
   * - accepted ops still needing preparation
   * - prepared txs restored from durable storage (exact stored hash/bytes)
   */
  recover() {
    const accepted = this.store.listOperations('ACCEPTED');
    const prepared = this.store.listPrepared();
    // For each prepared op, restore the exact stored record (hash/bytes are not
    // returned, only existence + hash — signed bytes stay in the store).
    const restored = prepared.map((p) => ({
      opId: p.opId,
      nonce: p.nonce,
      txHash: p.txHash,
      destination: p.destination,
      chainId: p.chainId,
    }));
    return { accepted: accepted.map((o) => o.op_id), prepared: restored };
  }

  // ---- per-account serialization ---------------------------------------------
  // Phase D1: serialized preparation per relayer account. A simple in-process
  // mutex; cross-process serialization is enforced by the store's UNIQUE
  // nonce_reservations constraint (tested in the concurrency suite).
  async _accountLock(account) {
    const prev = this._locks.get(account) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    this._locks.set(account, prev.then(() => next));
    await prev;
    return () => { release(); };
  }

  _releaseAccountLock(account) {
    // The release function returned by _accountLock handles unlock; this method
    // is kept for symmetry/documentation. A worker that dies mid-prepare leaves
    // the in-process lock held, but cross-process safety is enforced by the
    // store's UNIQUE nonce_reservations constraint regardless.
  }
}

module.exports = { D1Worker, SUPPORTED_ACTIONS };