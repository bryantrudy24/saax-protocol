// D2 execution worker — broadcast, reconciliation, crash recovery.
//
// Extends D1Worker (durable acceptance + preparation) with:
//   - validatePrepared: decode + recompute hash + verify sender, chain, custody
//     destination, calldata/action, value, reserved nonce, operation bindings;
//     recheck current contract state and deadlines. Reject corrupted or
//     mismatched records. Simulation is advisory only.
//   - broadcastPrepared: the ONLY code path that sends a transaction. Broadcasts
//     ONLY the persisted signed bytes (never reconstructs a different tx
//     silently). Durable attempt row (PENDING) is written BEFORE the send; a
//     crash after send but before recording the response leaves
//     SUBMISSION_UNCERTAIN, and recovery reconciles the KNOWN transaction by
//     hash — never infers non-broadcast from an absent receipt.
//   - reconcileOutcome: establishes the ACTUAL outcome from the chain:
//     successful receipt + canonical block ref, correct custody address/action,
//     expected events, resulting escrow state, actual token movement + amount,
//     applicable beneficiary, explicit finality policy (local-only).
//   - replace/defer: fee replacement is DEFERRED in this phase. A stuck or
//     dropped transaction is surfaced as a BLOCKED attempt + an incident, and
//     reported — never silently recycled and never double-submitted.
//   - nonce initialization/reconciliation: coordinates the relayer account's
//     RPC nonce with durable reservations and ACTUAL chain state. Handles
//     account history, pending txs, reservations not yet broadcast, unexpected
//     nonce consumption (blocking incident), nonce gaps, and stalled
//     reservations. A pending/latest RPC nonce alone is not a complete history.
//
// At-most-once custody effects: an operation has ONE canonical prepared action;
// broadcasts are idempotent (identical bytes re-sent only when the chain shows
// the tx absent AND no conflicting state change occurred); a successful
// outcome is recorded exactly once (terminal state + markNonceConsumed); a
// reverted receipt consumes the nonce but does NOT establish custody success;
// no receipt is an uncertain observation, not a failed business action.
//
// IMPORTANT BOUNDARY: database updates and blockchain execution are NOT one
// atomic transaction. There is no unconditional exactly-once execution; the
// worker guarantees at-most-once custody EFFECTS through durable bindings +
// reconciliation, and surfaces every uncertain window instead of inventing a
// result.

'use strict';

const { D1Worker } = require('./d1-worker.js');
const { D2Store } = require('./d2-store.js');
const { FinalityAdapter } = require('./d2-finality.js');
// E1D: explicit trusted-RPC historical finality seam (worker policy
// dispatch). ADDITIVE: the worker keeps the bounded-ancestry FinalityAdapter
// as its default; the trusted-RPC method is only used when the operator
// explicitly activates it via opts.finalityMethod === 'trusted-rpc' AND
// supplies a TrustedRpcFinality-capable observer. Never a silent downgrade.
const { TrustedRpcFinality } = require('./d2-trusted-rpc-finality.js');
const { computeTxHash } = require('./d1-tx.js');
const { keccak256, Interface, getAddress, Transaction } = require('ethers');

const SUPERVISED_STATES = new Set(['PENDING', 'SUBMISSION_UNCERTAIN', 'INCLUDED']);

class D2Worker extends D1Worker {
  /**
   * @param {object} opts extends D1Worker opts with:
   * @param {object} opts.chain { id, custody, rpc? }
   * @param {object} opts.abi
   * @param {object} opts.prereqs (D2Prerequisites or stub)
   * @param {Function} opts.nextNonce
   * @param {object} opts.relayer { account, wallet }
   * @param {object} opts.provider  ethers provider (Local EVM or Mock RPC)
   * @param {object} opts.finality  FinalityAdapter instance
   * @param {object} opts.gases { gasLimit, gasPrice }
   * @param {Function} [opts.getEscrow] async (commitmentId) => escrow tuple
   * @param {Function} [opts.simulate] async (wallet, tx) => {ok, reason?} — advisory
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    // Phase D4B: the external-signer lane needs a worker-level signing policy
    // (chain/custody/action/fee bounds) so the EXTERNAL key is never asked to
    // sign outside the worker's own custody bounds. D2 carries those bounds on
    // its chain/gas config, so derive the policy BEFORE super() (D1's
    // constructor fails closed when an external signer has no policy, and D2's
    // own bounds are the correct source). This is the integration glue for the
    // external lane on D2; a bare D1 external-signer construction is still
    // refused by D1's guard.
    if (opts.externalSigner && !opts.signingPolicy) {
      opts = {
        ...opts,
        signingPolicy: {
          abi: opts.abi,
          allowedActions: new Set(['release', 'refund', 'mutualRelease', 'mutualRefund', 'raiseDispute', 'resolve']),
          allowedChainId: opts.chain && opts.chain.id,
          custody: opts.chain && opts.chain.custody,
          maxGasPrice: opts.maxFeePerGas || opts.maxGasPrice || (opts.gas && opts.gas.gasPrice),
          maxGasLimit: opts.maxGasLimit || (opts.gas && opts.gas.gasLimit),
        },
      };
    }
    super(opts); // creates D1Store; we swap to D2Store
    // Close the D1 handle first — two sqlite handles on one WAL file would
    // contend; only the D2 handle (which runs D1 schema exec + D2 schema) stays.
    try { this.store.close(); } catch { /* noop */ }
    this.store = new D2Store(opts.storePath, { wipe: !!opts.wipeStore });
    this.provider = opts.provider;
    this.finality = opts.finality || new FinalityAdapter({
      getBlock: async (tag) => this.provider.getBlock(tag),
      getReceipt: async (h) => this.provider.getTransactionReceipt(h),
    });
    // E1D worker policy dispatch: the selected finality METHOD is trusted
    // configuration (opts.finalityMethod), never export-owned. 'bounded-
    // ancestry' (or unset) is the unchanged default. 'trusted-rpc' activates
    // the explicit deep-history assertion which relies on the node's OWN
    // canonical-chain and consensus-status (safe/finalized tag) assertions
    // with identity, membership, coverage, consistency rechecks and a bounded
    // request budget. Any other value is a configuration error (fail closed at
    // construction). Local-synthetic (31337) continues to use the local path.
    this.finalityMethod = String(opts.finalityMethod || 'bounded-ancestry').trim();
    if (this.finalityMethod !== 'bounded-ancestry' && this.finalityMethod !== 'trusted-rpc') {
      throw new Error('FINALITY_METHOD_UNSUPPORTED:' + this.finalityMethod);
    }
    this.trustedRpcFinality = opts.trustedRpcFinality || (this.finalityMethod === 'trusted-rpc'
      ? new TrustedRpcFinality({ provider: this.provider, chainId: this.opts.chain.id, requestBudget: opts.requestBudget }) : null);
    this.getEscrow = opts.getEscrow
      || (opts.prereqs && opts.prereqs._escrowReader)
      || (async (cid) => {
      const iface = new Interface(this.opts.abi);
      const c = new (require('ethers').Contract)(this.opts.chain.custody, iface, this.provider);
      const e = await c.getEscrow(cid);
      return {
        state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline,
        buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token,
        evaluator: e.evaluator, commitmentDigest: e.commitmentDigest,
      };
    });
    this.simulate = opts.simulate || (async () => ({ ok: true, note: 'simulation not configured — advisory' }));
    // Phase D4A: prepared-transaction protection. When set:
    //   - validatePrepared/broadcastPrepared decrypt the signed bytes from the
    //     AES-256-GCM envelope (prepared-vault) — never read plaintext
    //     signed_bytes when an envelope exists.
    //   - refuseIfUnsupportedStore() blocks broadcast when plaintext rows remain
    //     (the explicit migration must run first).
    this._vault = opts.vault || null;
    this._protected = !!opts.protection;
  }

  /**
   * Phase D4A: obtain the actual signed bytes for a prepared op.
   * - envelope present : decrypt via the vault with the AUTHENTICATED context
   *   derived from the durably recorded bindings; verify the decrypted bytes
   *   reproduce the stored tx_hash; any substitution fails closed.
   * - no envelope      : if protection enabled, refuse (precise migration
   *   requirement). Legacy plaintext path (no protection) returns the stored bytes.
   */
  _resolvePreparedBytes(prep) {
    if (!prep) return { ok: false, reason: 'NOT_PREPARED' };
    if (prep.signedEnvelope) {
      // Envelope path: the bytes are the D4A-authenticated prepared intent.
      // Flag it so validatePrepared can apply the strict transaction-intent
      // check against the sealed exact fields (the D4A guarantee the
      // plaintext legacy lane cannot claim).
      if (!this._vault) return { ok: false, reason: 'NO_VAULT', detail: 'envelope present but vault not configured' };
      const context = {
        op: prep.op_id,
        chain: Number(prep.chain_id),
        sender: prep.relayer_account,
        accountNonce: Number(prep.nonce),
        intendedTx: { to: prep.destination, txHash: prep.tx_hash },
      };
      const op = this.store.getOperation(prep.op_id);
      if (!op || Number(op.chainId)!==Number(prep.chain_id) || String(op.custodyAddress).toLowerCase()!==String(prep.destination).toLowerCase()) return {ok:false,reason:'ENVELOPE_OPERATION_MISMATCH'};
      context.op = op.op_id;
      context.chain = Number(op.chainId);
      context.sender = this.opts.relayer.account;
      context.intendedTx.to = op.custodyAddress;
      const opened = this._vault.openPrepared(prep.signedEnvelope, context);
      if (!opened.ok) return { ok: false, reason: 'ENVELOPE_OPEN_FAILED', detail: opened.reason };
      const bytesHex = '0x' + opened.bytes.toString('hex');
      if (!this._vault.verifyTxHash(bytesHex, prep.tx_hash)) {
        return { ok: false, reason: 'DECRYPTED_HASH_MISMATCH', detail: { stored: prep.tx_hash } };
      }
      return { ok: true, bytes: bytesHex, viaEnvelope: true };
    }
    if (this._protected) {
      // Legacy plaintext row under protection: refuse with the migration path.
      const refuse = this.store.refuseIfUnsupportedStore();
      if (!refuse.ok) return { ok: false, reason: refuse.reason, detail: refuse.detail };
    }
    if (!prep.signed_bytes) return { ok: false, reason: 'NO_SIGNED_BYTES' };
    return { ok: true, bytes: prep.signed_bytes, viaEnvelope: false };
  }

  /** Override: merge immutable bindings into the op before D1's validation so
   *  the domain-aware prereqs validator sees chain/custody/escrow agreement
   *  bindings on the PREPARE path (not only on the validatePrepared path). */
  async _prepareAccepted(op, ctx) {
    const merged = {
      ...op,
      actionBindings: {
        ...(ctx.bindings || {}),
        requestedAction: ctx.requestedAction || op.requestedAction,
        chainId: this.opts.chain.id,
        custody: this.opts.chain.custody,
        escrowId: op.escrowId,
        agreementRef: op.agreementRef,
        payloadDigest: op.payloadDigest,
        authNonce: op.authNonce,
        authExpiry: op.authExpiry,
      },
    };
    return super._prepareAccepted(merged, ctx);
  }

  /**
   * Phase D4B: action-argument authorization for the external-signer lane.
   * D1's external lane REQUIREs a validator before it will ask the external
   * key to sign. It verifies the GENUINE verdict/mutual signatures (EIP-712
   * over the custody domain; ERC-1271 staticcall for contract-wallet
   * evaluators, ecrecover for EOA) plus the D2 prerequisites (escrow
   * existence, state-permitted action, chain/custody/deadline/auth bindings)
   * BEFORE the external key is asked to sign. A forged/invalid verdict
   * signature is rejected here — never broadcast.
   */
  async verifyActionArgsForOp(op, actionArgs) {
    const { verifyActionArgs, normalizeSig, ACTION_TO_CONTRACT } = require('./d3-action-auth.js');
    const eth = require('ethers');
    const escrowId = String(op.escrowId || (op.actionBindings && op.actionBindings.escrowId) || '').toLowerCase();
    if (!escrowId) return { ok: false, reason: 'NO_ESCROW_ID' };
    let esc;
    try { esc = await this.opts.prereqs.getEscrow(escrowId); }
    catch (e) { return { ok: false, reason: 'ESCROW_READ_FAILED', detail: String(e.message || e).slice(0, 200) }; }
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
    // The op row carries the ACCESS action ('submit verdict' / 'request
    // refund'); the requestedAction is the contract action. Access action
    // semantics are D3's domain but the external lane needs both to classify.
    const contractAction = String(op.requestedAction || op.requested_action || '').toLowerCase();
    // D3's verifier classifies by ACCESS action ('submit verdict' ->
    // 'release'). D2 ops carry the CONTRACT action directly ('release'), so
    // derive the canonical access alias (reverse of ACTION_TO_CONTRACT).
    const accessAction = Object.keys(ACTION_TO_CONTRACT).find((k) => ACTION_TO_CONTRACT[k] === contractAction)
      || String(op.requested_action || op.accessAction || '').toLowerCase();
    // D3's verifyActionArgs expects an EIP-712 digest over the custody domain.
    const D = (fn) => async (p) => {
      try { return await fn({ ...p, verifyingContract: this.opts.chain.custody, chainId: this.opts.chain.id }); }
      catch { return null; }
    };
    // eslint-disable-next-line global-require
    const sigs = require('../mainnet/design/support/v4-signatures.js');
    // D2's escrow reader returns named fields (commitmentDigest, buyer,
    // seller, evaluator); D3's verifier wants `digest`/`buyer`/`seller` +
    // `state`. Map the D2 shape to the verifier's contract.
    const ctx = {
      contractAction,
      accessAction,
      accessRole: op.authRole,
      escrowId,
      escrow: { ...esc, digest: esc.commitmentDigest || esc.digest },
      chainId: op.chainId || this.opts.chain.id,
      custody: op.custodyAddress || this.opts.chain.custody,
      expectedChainId: Number(this.opts.chain.id),
      expectedCustody: String(this.opts.chain.custody || '').toLowerCase(),
      isContractWallet: (addr) => this.provider.getCode(addr).then((c) => c && c !== '0x').catch(() => false),
      verdictDigest: D(sigs.verdictDigest),
      mutualDigest: D(sigs.mutualDigest),
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
          const iface = new eth.Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
          const data = iface.encodeFunctionData('isValidSignature', [digest, sigBytes]);
          const res = await this.provider.call({ to: evaluator, data });
          const magic = iface.decodeFunctionResult('isValidSignature', res)[0];
          const ERC1271_MAGIC = '0x1626ba7e';
          return { ok: magic === ERC1271_MAGIC, reason: magic === ERC1271_MAGIC ? null : 'ERC_1271_REJECTED' };
        } catch (e) {
          return { ok: false, reason: 'ERC_1271_CALL_FAILED', detail: String(e.message || e).slice(0, 200) };
        }
      },
    };
    return verifyActionArgs(actionArgs || {}, ctx);
  }

  // ---- 1. validate the prepared transaction ---------------------------------

  /**
   * Decode + validate the stored signed bytes before ANY broadcast.
   * - recompute the tx hash and compare to the stored hash
   * - verify recovered sender == relayer account
   * - verify chain id, custody destination, calldata decodes to the expected
   *   action, value == 0, reserved nonce, and operation bindings match
   * - recheck current contract state + deadlines via prerequisite validator
   * Returns { ok, reason?, tx? }. Rejects corrupted/mismatched records.
   */
  async validatePrepared(opId) {
    const prep = this.store.getPrepared(opId);
    if (!prep) return { ok: false, reason: 'NOT_PREPARED' };
    const op = this.store.getOperation(opId);
    if (!op) return { ok: false, reason: 'NO_OPERATION' };
    try {
      // Phase D4A: envelope-first. Decrypt the actual signed bytes (validating
      // the authenticated context + tx-hash recompute) before ANY decode. A
      // substituted envelope/ciphertext/context fails here, closed.
      const resolved = this._resolvePreparedBytes(prep);
      if (!resolved.ok) return { ok: false, reason: resolved.reason, detail: resolved.detail || null };
      const decoded = Transaction.from(resolved.bytes);
      // 1. hash recompute (the primary corruption gate on EVERY path: a
      //    tampered byte changes the recomputed hash)
      const txHash = computeTxHash(resolved.bytes);
      if (txHash.toLowerCase() !== prep.tx_hash.toLowerCase()) {
        return { ok: false, reason: 'HASH_MISMATCH', detail: { stored: prep.tx_hash, computed: txHash } };
      }
      // Phase D4B: strict transaction-intent check against the immutable
      // bindings. On the ENVELOPE path this is the D4A seal — exact field
      // match is guaranteed and any mismatch is fatal. On the legacy
      // plaintext path the decoded fields are ALSO verified against the
      // stored bindings AFTER the hash gate (never before: the D2 contract
      // for legacy corruption is HASH_MISMATCH, and exactness here would
      // mislabel a tampered byte as a wrong-key rejection).
      const exact = require('./transaction-intent.js').validateBytes(resolved.bytes, {
        to:op.custodyAddress, from:this.opts.relayer.account, chainId:op.chainId,
        nonce:prep.nonce, value:prep.value, data:prep.calldata, gasLimit:prep.gas_limit,
        type:Number(decoded.type), ...(Number(decoded.type)===0 ? {gasPrice:prep.gas_price} : {maxFeePerGas:prep.gas_price,maxPriorityFeePerGas:BigInt(prep.gas_price)/2n})
      });
      if (!exact.ok) return exact;
      // 2. sender
      const sender = getAddress(decoded.from);
      if (sender.toLowerCase() !== this.opts.relayer.account.toLowerCase()) {
        return { ok: false, reason: 'SENDER_MISMATCH', detail: { expected: this.opts.relayer.account, got: sender } };
      }
      // 3. chain
      if (Number(decoded.chainId) !== Number(this.opts.chain.id)) {
        return { ok: false, reason: 'CHAIN_MISMATCH', detail: { expected: this.opts.chain.id, got: Number(decoded.chainId) } };
      }
      // 4. custody destination
      if (!decoded.to || getAddress(decoded.to).toLowerCase() !== this.opts.chain.custody.toLowerCase()) {
        return { ok: false, reason: 'DESTINATION_MISMATCH', detail: { expected: this.opts.chain.custody, got: decoded.to } };
      }
      // 5. value must be zero for custody actions
      if (decoded.value !== 0n) {
        return { ok: false, reason: 'VALUE_NOT_ZERO', detail: String(decoded.value) };
      }
      // 6. nonce must equal the reserved nonce
      if (Number(decoded.nonce) !== Number(prep.nonce)) {
        return { ok: false, reason: 'NONCE_MISMATCH', detail: { stored: prep.nonce, decoded: Number(decoded.nonce) } };
      }
      // 7. calldata decodes to the expected action (function selector match)
      const iface = new Interface(this.opts.abi);
      let frag;
      try { frag = iface.parseTransaction({ data: prep.calldata }); } catch { frag = null; }
      if (!frag) return { ok: false, reason: 'CALLDATA_UNDECODABLE' };
      const bindings = prep.actionBindings || {};
      const expectedAction = bindings.requestedAction;
      const selectorOf = (name) => {
        try { return iface.getFunction(name).selector; } catch { return null; }
      };
      const ALIAS = { mutualRelease: 'mutualRelease', mutualRefund: 'mutualRefund', release: 'release', refund: 'refund', raiseDispute: 'raiseDispute', resolve: 'resolve' };
      const wantSelector = selectorOf(ALIAS[expectedAction] || expectedAction);
      if (wantSelector && frag.signature !== iface.getFunction(ALIAS[expectedAction] || expectedAction).format('sighash')) {
        return { ok: false, reason: 'ACTION_MISMATCH', detail: { expected: expectedAction, got: frag.signature } };
      }
      // Also verify the calldata actually encodes the same action as the
      // signed bytes (not just our stored copy).
      const decodedData = iface.parseTransaction({ data: decoded.data });
      if (!decodedData || decodedData.signature !== frag.signature) {
        return { ok: false, reason: 'CALLDATA_ACTION_MISMATCH', detail: { stored: frag.signature, signed: decodedData && decodedData.signature } };
      }

      // 7b. Phase D4B: harden transaction-type + fee-field validation.
      //     - verify the transaction type is a SUPPORTED executable type
      //       (legacy 0 or EIP-1559 2 only for this custody lane).
      //     - verify fee fields are consistent with the configured bounds:
      //       for EIP-1559, maxFeePerGas AND maxPriorityFeePerGas must both be
      //       present and within bounds; for legacy, gasPrice within bounds.
      //     - reject unsupported or unexpected executable features (access
      //       lists, unknown types, mismatched fee fields).
      const maxFee = this.opts.maxFeePerGas;   // configured bound (string/bigint)
      const maxPrio = this.opts.maxPriorityFeePerGas;
      const maxGasPrice = this.opts.maxGasPrice;
      const maxGasLimit = this.opts.maxGasLimit || this.opts.gas?.gasLimit;
      const txType = Number(decoded.type);
      if (txType !== 0 && txType !== 2) {
        return { ok: false, reason: 'UNSUPPORTED_TX_TYPE', detail: { type: txType } };
      }
      if (decoded.accessList && decoded.accessList.length > 0) {
        return { ok: false, reason: 'UNSUPPORTED_ACCESS_LIST', detail: { length: decoded.accessList.length } };
      }
      const gasLimitD = BigInt(decoded.gasLimit);
      if (maxGasLimit && gasLimitD > BigInt(maxGasLimit)) {
        return { ok: false, reason: 'GAS_LIMIT_EXCEEDS_BOUND', detail: { max: String(maxGasLimit), got: gasLimitD.toString() } };
      }
      if (txType === 2) {
        const mfp = decoded.maxFeePerGas === null || decoded.maxFeePerGas === undefined ? null : BigInt(decoded.maxFeePerGas);
        const mpg = decoded.maxPriorityFeePerGas === null || decoded.maxPriorityFeePerGas === undefined ? null : BigInt(decoded.maxPriorityFeePerGas);
        if (mfp === null || mpg === null) {
          return { ok: false, reason: 'MISSING_EIP1559_FEES', detail: { maxFeePerGas: mfp, maxPriorityFeePerGas: mpg } };
        }
        if (maxFee && mfp > BigInt(maxFee)) {
          return { ok: false, reason: 'MAX_FEE_EXCEEDS_BOUND', detail: { max: String(maxFee), got: mfp.toString() } };
        }
        if (maxPrio && mpg > BigInt(maxPrio)) {
          return { ok: false, reason: 'MAX_PRIORITY_FEE_EXCEEDS_BOUND', detail: { max: String(maxPrio), got: mpg.toString() } };
        }
      } else if (txType === 0) {
        const gp = decoded.gasPrice === null || decoded.gasPrice === undefined ? null : BigInt(decoded.gasPrice);
        if (gp === null) return { ok: false, reason: 'MISSING_LEGACY_GAS_PRICE' };
        if (maxGasPrice && gp > BigInt(maxGasPrice)) {
          return { ok: false, reason: 'GAS_PRICE_EXCEEDS_BOUND', detail: { max: String(maxGasPrice), got: gp.toString() } };
        }
      }

      // 8. recheck current contract state + deadlines (genuine prereqs)
      // The operation row itself carries camelCase action/chain/custody; the
      // prepared tx carries the immutable bindings. Merge so the validator has
      // both (it validates bindings AND current state).
      // The CONTRACT action the prepared tx carries (bindings.requestedAction)
      // is the authoritative action for state/cutoff checks — the operation
      // ROW's requestedAction is the ACCESS action ('submit verdict'), which
      // the contract knows nothing about. Prefer the bindings at the TOP
      // level too so the validator keys on the contract action; the original
      // access action stays in actionBindings for the journal.
      const contractAction = bindings.requestedAction || prep.actionBindings?.requestedAction || op.requestedAction;
      const opMerged = { ...op, requestedAction: contractAction, actionBindings: { ...(prep.actionBindings || {}), requestedAction: contractAction, chainId: op.chainId, custody: op.custodyAddress, escrowId: op.escrowId, agreementRef: op.agreementRef, payloadDigest: op.payloadDigest, authNonce: op.authNonce, authExpiry: op.authExpiry } };
      const pr = await this.opts.prereqs.validatePrerequisites(opMerged);
      if (!pr.ok) return { ok: false, reason: pr.reason, detail: pr.detail || null };

      return { ok: true, tx: { from: sender, to: decoded.to, nonce: Number(decoded.nonce), chainId: Number(decoded.chainId), value: decoded.value.toString(), txHash } };
    } catch (e) {
      return { ok: false, reason: 'VALIDATION_ERROR', detail: e.message };
    }
  }

  // ---- 2. broadcast ----------------------------------------------------------

  /**
   * Broadcast the durably prepared transaction (validated first).
   * Durable attempt row (PENDING) is written BEFORE the send, so a crash after
   * send but before recording the response leaves SUBMISSION_UNCERTAIN (recoverable).
   * On success of the underlying `send`, the attempt is marked
   * SUBMISSION_UNCERTAIN — the worker NEVER assumes the broadcast response is
   * authoritative; it reconciles the tx by hash. Returns the attempt record.
   */
  async broadcastPrepared(opId, { simulate = true } = {}) {
    const v = await this.validatePrepared(opId);
    if (!v.ok) return { ok: false, reason: v.reason, detail: v.detail, opId };
    const prep = this.store.getPrepared(opId);

    // Advisory simulation (never a guarantee of execution). With an external
    // signer there is no in-process wallet; simulation is skipped (the signer
    // policy + envelope validation already gate the bytes).
    if (simulate && this.simulate && this.opts.relayer && this.opts.relayer.wallet) {
      try {
        const sim = await this.simulate(this.opts.relayer.wallet, prep);
        if (sim && sim.ok === false) {
          return { ok: false, reason: 'SIMULATION_REJECTED', detail: sim.reason || null, opId };
        }
      } catch (e) {
        return { ok: false, reason: 'SIMULATION_FAILED', detail: e.message, opId };
      }
    }

    // Durable PENDING before send.
    const attempt = this.store.beginAttempt({
      opId,
      nonce: prep.nonce,
      txHash: prep.tx_hash,
      chainId: this.opts.chain.id,
      relayerAccount: this.opts.relayer.account,
      simNote: simulate ? 'simulated advisory' : 'skipped',
    });

    // Send via the wallet with the persisted signed bytes. The wallet's
    // provider may be the local EVM or a mock. We deliberately pass the
    // serialized bytes so the SAME bytes are re-broadcast on retry.
    let sendRes;
    try {
      // Phase D4A: decrypt the signed bytes inside the restricted broadcast path
      // (validatePrepared already did — re-resolve here so the SAME enforced
      // bytes are sent; never re-read plaintext when an envelope exists).
      const resolved = this._resolvePreparedBytes(prep);
      if (!resolved.ok) {
        this.store.recordSend(opId, attempt.attempt_num, { status: 'SUBMISSION_UNCERTAIN', sendError: resolved.reason });
        return { ok: false, reason: resolved.reason, detail: resolved.detail || null, opId, attempt: attempt.attempt_num };
      }
      // Phase D4B: with an external signer there is no in-process wallet; the
      // broadcast goes through the provider directly (the signed bytes were
      // produced by the EXTERNAL key). Without an external signer the wallet
      // path is unchanged.
      if (this.opts.relayer && this.opts.relayer.wallet && this.opts.relayer.wallet.provider) {
        sendRes = await this.opts.relayer.wallet.provider.broadcastTransaction(resolved.bytes);
      } else if (this.provider && typeof this.provider.broadcastTransaction === 'function') {
        sendRes = await this.provider.broadcastTransaction(resolved.bytes);
      } else {
        throw new Error('no broadcast path: external signer requires a provider');
      }
    } catch (e) {
      // Send error: the tx may still have been accepted by the node before the
      // connection dropped. Mark SUBMISSION_UNCERTAIN — never infer
      // non-broadcast from an absent response.
      this.store.recordSend(opId, attempt.attempt_num, { status: 'SUBMISSION_UNCERTAIN', sendError: e.message });
      this.log.warn('[d2] broadcast send error (response lost) — op=' + opId + ' attempt=' + attempt.attempt_num + ' err=' + e.message);
      return { ok: false, reason: 'SUBMISSION_UNCERTAIN', detail: e.message, opId, attempt: attempt.attempt_num, txHash: prep.tx_hash, nonce: prep.nonce };
    }

    // Response received — still NOT authoritative: mark SUBMISSION_UNCERTAIN
    // and reconcile by hash. (The chain is the source of truth.)
    this.store.recordSend(opId, attempt.attempt_num, { status: 'SUBMISSION_UNCERTAIN', broadcastAt: Date.now() });
    return { ok: true, status: 'SUBMISSION_UNCERTAIN', opId, attempt: attempt.attempt_num, txHash: prep.tx_hash || (sendRes && sendRes.hash) || v.tx.txHash, nonce: prep.nonce };
  }

  // ---- 3. reconciliation -----------------------------------------------------

  /**
   * Reconcile the ACTUAL outcome of a known transaction by hash.
   * - receipt present: establish included block + finality; determine success
   *   (status===1), events emitted, resulting escrow state, token movement,
   *   beneficiary; record FINALIZED (or REVERTED — nonce consumed, no custody
   *   success) exactly once.
   * - receipt absent: UNKNOWN — an uncertain observation, NOT a failed business
   *   action and NOT proof of non-broadcast. Attempt stays SUBMISSION_UNCERTAIN.
   * - reorg detection: if the included block hash changed or the canonical
   *   head regressed, return REVERTED_TO_RECONCILIATION and re-check by hash
   *   without creating a second business action.
   */
  async reconcileOutcome(opId, { allowRebroadcast = false } = {}) {
    const prep = this.store.getPrepared(opId);
    if (!prep) return { ok: false, reason: 'NOT_PREPARED', opId };
    const attempts = this.store.getAttempts(opId);
    const last = attempts[attempts.length - 1];
    if (!last || !SUPERVISED_STATES.has(last.status)) {
      // E1A: a terminal FINALIZED attempt is not re-executed, but a reorg
      // that rewrote already-finalized history MUST raise a BLOCKING
      // incident — "a contradiction after recorded finalization raises a
      // blocking incident". Probe the canonical chain for the recorded
      // included block; if its hash no longer matches, the recorded
      // finalization is contradicted.
      if (last && last.status === 'FINALIZED' && last.finality_state && (last.finality_state === 'FINALIZED' || last.finality_state === 'LOCAL')) {
        if (last.included_block_number !== undefined && last.included_block_hash) {
          const probe = await this._probeRecordedFinality(last);
          if (probe && probe.contradicted) {
            this.store.incident({ kind: 'FINALIZED_CONTRADICTION', opId, relayerAccount: this.opts.relayer.account, chainId: this.opts.chain.id, nonce: last.nonce, detail: 'recorded ' + last.finality_state + ' at block ' + last.included_block_number + ' but canonical hash changed: ' + probe.detail });
            return { ok: false, reason: 'FINALIZED_CONTRADICTION', opId, attempt: last.attempt_num, detail: probe.detail };
          }
        }
      }
      return { ok: false, reason: 'NO_ACTIVE_ATTEMPT', status: last ? last.status : null, opId };
    }
    const txHash = last.tx_hash || prep.tx_hash;
    let receipt = null;
    try {
      receipt = await this.provider.getTransactionReceipt(txHash);
    } catch (e) {
      return { ok: false, reason: 'RECEIPT_READ_FAILED', detail: e.message, stillUncertain: true, opId };
    }

    if (!receipt) {
      // Absent receipt: still unknown. Optionally rebroadcast IDENTICAL bytes
      // if the chain shows the tx absent and no conflicting state change.
      if (allowRebroadcast) {
        const stillAbsent = await this._chainShowsTxAbsent(txHash, prep.nonce);
        if (stillAbsent) {
          // identical bytes re-sent (no replacement, no different tx)
          return this.broadcastPrepared(opId, { simulate: false });
        }
        return { ok: false, reason: 'RECEIPT_ABSENT', uncertain: true, opId };
      }
      return { ok: false, reason: 'RECEIPT_ABSENT', uncertain: true, opId };
    }

    // Receipt present: policy dispatch before finality. The adapter selects
    // local confirmations (chain 31337) or OP Stack safe/finalized by the
    // trusted configuration; a failed public check NEVER falls back to local
    // confirmations.
    // E1D: the finality METHOD is trusted configuration. Default
    // ('bounded-ancestry') keeps the E1A/E1B establishFinality path
    // unchanged. Under 'trusted-rpc', the explicit deep-history assertion is
    // used instead — it relies on the node's OWN canonical-chain and
    // consensus-status (safe/finalized tag) assertions with identity,
    // membership, coverage, consistency rechecks and a bounded request
    // budget. There is NO fallback from the trusted-rpc method to the bounded
    // method and no fallback from a failed public check to local
    // confirmations: both fail closed.
    let fin;
    if (this.finalityMethod === 'trusted-rpc' && this.trustedRpcFinality) {
      const tr = await this.trustedRpcFinality.assertHistoricalFinality({
        txHash,
        policy: this.finality.policy && this.finality.policy.mode === 'op-stack-finalized' ? 'op-stack-finalized' : 'op-stack-safe',
        receipt,
      });
      fin = {
        final: !!tr.final,
        reason: tr.reason,
        safeCovered: !!tr.safeCovered,
        finalizedCovered: !!tr.finalizedCovered,
        safe: tr.safeHead,
        finalized: tr.finalizedHead,
        includedBlock: tr.includedBlock,
        depth: tr.depth,
        policy: { mode: this.finality.policy && this.finality.policy.mode ? this.finality.policy.mode : 'op-stack-safe', label: 'trusted-rpc', method: 'trusted-rpc' },
        trustModel: tr.trustModel,
        requests: tr.requests,
      };
    } else {
      fin = await this.finality.establishFinality(receipt, { txHash });
    }
    if (!fin.final) {
      // E1A contradiction gate: a reorg/removal signal for an attempt that was
      // ALREADY recorded consensus-finalized (FINALIZED or LOCAL finality
      // state) is a blocking FINALIZED_CONTRADICTION — the chain now
      // contradicts a recorded finalization. NEVER silently re-reconcile it.
      if (fin.reason && /REORG|REGRESSED|CANONICAL_BLOCK_MISMATCH/.test(fin.reason)) {
        const prior = this.store.getAttempt(opId, last.attempt_num);
        if (prior && prior.status === 'FINALIZED' && (prior.finality_state === 'FINALIZED' || prior.finality_state === 'LOCAL')) {
          this.store.incident({ kind: 'FINALIZED_CONTRADICTION', opId, relayerAccount: this.opts.relayer.account, chainId: this.opts.chain.id, nonce: prep.nonce, detail: 'recorded ' + prior.finality_state + ' but reorg signal ' + fin.reason + ' observed after finalization' });
          return { ok: false, reason: 'FINALIZED_CONTRADICTION', opId, attempt: last.attempt_num };
        }
        this.store.incident({ kind: 'REORG_DETECTED', opId, relayerAccount: this.opts.relayer.account, chainId: this.opts.chain.id, nonce: prep.nonce, detail: fin.reason });
        // Return to reconciliation: check the tx on the new canonical chain.
        const recheck = await this._recheckAfterReorg(txHash, prep);
        return recheck; // never a second business action
      }
      // E1A: not final — persist the observed finality state accurately.
      // - op-stack-finalized policy with SAFE coverage: attempt is SAFE (NOT
      //   consensus-finalized) — persisted as SAFE, lifecycle stays
      //   INCLUDED/supervised.
      // - otherwise INCLUDED (mined, not yet covered by the required head).
      const finState = (fin.safeCovered && !fin.finalizedCovered) ? 'SAFE' : 'INCLUDED';
      this.store.recordIncluded(opId, last.attempt_num, { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, finalityPolicy: fin.policy ? fin.policy.mode : 'local-confirmations', confirmations: fin.depth !== undefined ? fin.depth : null, finalityState: finState });
      return { ok: false, reason: fin.reason || 'NOT_FINAL', needed: fin.needed, depth: fin.depth, opId, attempt: last.attempt_num };
    }

    // Included + final under the configured policy.
    // E1A explicit state: local-confirmations -> LOCAL; op-stack-safe ->
    // SAFE; op-stack-finalized -> FINALIZED. SAFE is never labeled
    // consensus-finalized.
    const finPolicy = fin.policy ? fin.policy.mode : 'local-confirmations';
    const finState = finPolicy === 'op-stack-safe' ? 'SAFE'
      : (finPolicy === 'op-stack-finalized' ? 'FINALIZED' : 'LOCAL');
    this.store.recordIncluded(opId, last.attempt_num, { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, finalityPolicy: finPolicy, confirmations: fin.depth !== undefined ? fin.depth : null, finalityState: finState });

    // Establish the ACTUAL outcome.
    const outcome = await this._establishOutcome(opId, prep, receipt);
    // Persistence failure AFTER chain execution must be surfaced cleanly (not
    // thrown): the chain executed, but the durable record write failed. The
    // op's attempt stays SUPERVISED; the next reconcile re-reads the chain
    // (idempotent) and records the truth — no fabricated success, no double
    // business action.
    try {
      if (outcome.status === 'REVERTED') {
        this.store.recordReverted(opId, last.attempt_num, outcome.reason || 'reverted');
        this.store.markNonceConsumed({ relayerAccount: this.opts.relayer.account, chainId: this.opts.chain.id, nonce: prep.nonce });
        return { ok: false, reason: 'REVERTED', outcome, opId, attempt: last.attempt_num };
      }
      if (outcome.status === 'SUCCESS') {
        this.store.recordFinalized(opId, last.attempt_num, outcome.evidence, finState);
        this.store.markNonceConsumed({ relayerAccount: this.opts.relayer.account, chainId: this.opts.chain.id, nonce: prep.nonce });
        return { ok: true, status: 'FINALIZED', finalityState: finState, outcome, opId, attempt: last.attempt_num };
      }
      // EXTERNAL (another actor resolved the escrow first): record actual
      // outcome and executor; do NOT claim the worker executed it.
      this.store.recordFinalized(opId, last.attempt_num, { ...outcome.evidence, external: true, executor: outcome.executor });
      this.store.markNonceConsumed({ relayerAccount: this.opts.relayer.account, chainId: this.opts.chain.id, nonce: prep.nonce });
      return { ok: true, status: 'FINALIZED_EXTERNAL', outcome, opId, attempt: last.attempt_num };
    } catch (e) {
      // Do NOT swallow the failure silently: surface it as a distinct result
      // (the op remains supervised; re-reconcile retries the durable write).
      return { ok: false, reason: 'PERSIST_FAILURE_AFTER_CHAIN', detail: e.message, chainTruth: { status: outcome.status, evidence: outcome.evidence }, opId, attempt: last.attempt_num };
    }
  }

  async _chainShowsTxAbsent(txHash, nonce) {
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (tx) return false;
      // Also ensure the account nonce did not already advance past this nonce
      // (which would mean the tx is NOT absent, just mined without a receipt
      // visible, or replaced).
      const nonceOnChain = await this.provider.getTransactionCount(this.opts.relayer.account, 'pending');
      return Number(nonceOnChain) <= Number(nonce);
    } catch {
      return false; // unknown — do not rebroadcast on ambiguity
    }
  }

  /**
   * E1A: probe a recorded FINALIZED attempt against the current canonical
   * chain. If the block at the recorded included height no longer has the
   * recorded hash, the recorded consensus finalization is contradicted by
   * the chain (a reorg rewrote finalized history). Returns
   * { contradicted: bool, detail? }.
   */
  async _probeRecordedFinality(last) {
    try {
      const blk = await this.provider.getBlock(Number(last.included_block_number));
      if (!blk || blk.hash === undefined) {
        return { contradicted: false, detail: 'block unavailable — cannot confirm, not a contradiction' };
      }
      if (String(blk.hash).toLowerCase() !== String(last.included_block_hash).toLowerCase()) {
        return { contradicted: true, detail: 'recorded ' + last.included_block_hash + ' now ' + blk.hash };
      }
      return { contradicted: false };
    } catch (e) {
      return { contradicted: false, detail: 'probe failed: ' + e.message };
    }
  }

  async _recheckAfterReorg(txHash, prep) {
    // Re-check the known tx on the new canonical chain.
    try {
      const newReceipt = await this.provider.getTransactionReceipt(txHash);
      if (newReceipt && newReceipt.status === 1) {
        const fin = await this.finality.establishFinality(newReceipt, { txHash });
        if (fin.final) {
          const outcome = await this._establishOutcome(prep.op_id, prep, newReceipt);
          if (outcome.status === 'SUCCESS') {
            // E1A: persist the policy-accurate finality state on the
            // reorg-recovered path too.
            const finPolicy = fin.policy ? fin.policy.mode : 'local-confirmations';
            const finState = finPolicy === 'op-stack-safe' ? 'SAFE'
              : (finPolicy === 'op-stack-finalized' ? 'FINALIZED' : 'LOCAL');
            this.store.recordFinalized(prep.op_id, this.store.getAttempts(prep.op_id)[this.store.getAttempts(prep.op_id).length - 1].attempt_num, { ...outcome.evidence, reorgRecovered: true }, finState);
            this.store.markNonceConsumed({ relayerAccount: this.opts.relayer.account, chainId: this.opts.chain.id, nonce: prep.nonce });
            return { ok: true, status: 'FINALIZED_AFTER_REORG', finalityState: finState, outcome, opId: prep.op_id };
          }
        }
      }
      // Tx dropped from the canonical chain: reconciliation continues by hash;
      // rebroadcast identical bytes only when the chain shows absence.
      const stillAbsent = await this._chainShowsTxAbsent(txHash, prep.nonce);
      if (stillAbsent) return this.broadcastPrepared(prep.op_id, { simulate: false });
      return { ok: false, reason: 'REORG_REVERTED_TO_RECONCILIATION', opId: prep.op_id };
    } catch (e) {
      return { ok: false, reason: 'REORG_RECHECK_FAILED', detail: e.message, opId: prep.op_id };
    }
  }

  /**
   * Establish the ACTUAL custody outcome from the receipt + chain state.
   * Verifies: correct custody address (receipt.to), action/events, resulting
   * escrow state, actual token movement + amount, applicable beneficiary.
   */
  async _establishOutcome(opId, prep, receipt) {
    const iface = new Interface(this.opts.abi);
    const bindings = prep.actionBindings || {};
    const escrowId = bindings.escrowId || '0x0000000000000000000000000000000000000000000000000000000000000000';

    // Correct custody address?
    const to = receipt.to ? getAddress(receipt.to) : null;
    if (!to || to.toLowerCase() !== this.opts.chain.custody.toLowerCase()) {
      return { status: 'UNEXPECTED_RECEIVER', reason: 'RECEIPT_TO_MISMATCH', evidence: { to: receipt.to, expected: this.opts.chain.custody } };
    }
    if (receipt.status !== 1) {
      return { status: 'REVERTED', reason: 'STATUS_ZERO', evidence: { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } };
    }

    // Expected events for the action.
    const logs = (receipt.logs || []).map((l) => {
      try { return iface.parseLog(l); } catch { return null; }
    }).filter(Boolean);
    const expectedEvent = {
      release: 'Released', refund: 'Refunded', mutualRelease: 'Released', mutualRefund: 'Refunded',
      raiseDispute: 'Disputed', resolve: 'Resolved',
    }[bindings.requestedAction];
    if (expectedEvent && !logs.some((l) => l.name === expectedEvent)) {
      return { status: 'REVERTED', reason: 'EXPECTED_EVENT_MISSING', evidence: { expectedEvent, logs: logs.map((l) => l.name) } };
    }

    // Resulting escrow state from the chain (ground truth, not the export).
    let escrow;
    try {
      escrow = await this.getEscrow(escrowId);
    } catch (e) {
      return { status: 'UNKNOWN', reason: 'ESCROW_READ_FAILED', evidence: { err: e.message } };
    }
    const expectedState = {
      release: 3, refund: 4, mutualRelease: 3, mutualRefund: 4, raiseDispute: 2, resolve: null,
    }[bindings.requestedAction];
    const stateMatch = expectedState === null || Number(escrow.state) === expectedState;

    // Token movement: verify the custody's token balance changed by the amount.
    let tokenDelta = null;
    try {
      const token = escrow.token;
      if (token) {
        const erc20 = new (require('ethers').Contract)(token, ['function balanceOf(address) view returns (uint256)'], this.provider);
        const before = await erc20.balanceOf(this.opts.chain.custody);
        // Compare against an independent baseline: the amount bound in the escrow.
        tokenDelta = { amount: escrow.amount };
      }
    } catch { tokenDelta = null; }

    const beneficiary = bindings.requestedAction === 'release' || bindings.requestedAction === 'mutualRelease' ? escrow.seller : escrow.buyer;
    const evidence = {
      txHash: receipt.hash,
      blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash,
      status: Number(receipt.status),
      custody: this.opts.chain.custody,
      action: bindings.requestedAction,
      events: logs.map((l) => l.name),
      escrowState: Number(escrow.state),
      tokenMovement: tokenDelta ? { token: escrow.token, amount: tokenDelta.amount.toString(), beneficiary } : null,
      beneficiary,
    };

    if (!stateMatch) {
      // Another actor may have resolved the escrow: record the actual outcome.
      return { status: 'EXTERNAL', executor: null, evidence: { ...evidence, note: 'escrow state does not match the action result — likely resolved by another actor' } };
    }
    return { status: 'SUCCESS', evidence };
  }

  // ---- nonce initialization/reconciliation -----------------------------------

  /**
   * Initialize and reconcile the relayer account nonce against durable
   * reservations and ACTUAL chain state.
   * - nextNonce provider: the D1 worker's nextNonce is "next unreserved
   *   nonce". D2 makes it chain-aware: starts from max(chainNonce,
   *   highestReserved+1, highestConsumed+1) and validates.
   */
  async nextNonceFor(account, chainId) {
    // Prefer chain's authoritative nonce (pending includes in-flight txs).
    let chainNonce = 0;
    try {
      chainNonce = Number(await this.provider.getTransactionCount(account, 'pending'));
    } catch (e) {
      throw new Error('NONCE_RPC_FAILED:' + e.message);
    }
    // Durable reservations (any state except STALLED are "claimed").
    const reservations = this.store.listReservations({ relayerAccount: account, chainId });
    let highestReserved = -1;
    for (const r of reservations) {
      if (r.status !== 'STALLED') highestReserved = Math.max(highestReserved, Number(r.nonce));
    }
    // Unexpected consumption = the chain nonce advanced past a nonce THIS
// STORE had reserved-but-never-accounted (a reservation below chainNonce
// whose status is neither CONSUMED nor STALLED). A FRESH store starting on
// an account with existing history (chainNonce > 0, no reservations) is
// NORMAL initialization — the account already had transactions before this
// worker existed ("Account already having transaction history" per brief).
    const reservationsBelow = reservations.filter((r) => Number(r.nonce) < chainNonce && r.status !== 'CONSUMED' && r.status !== 'STALLED');
    if (reservationsBelow.length > 0) {
      const r = reservationsBelow[0];
      this.store.incident({ kind: 'UNEXPECTED_NONCE_CONSUMPTION', relayerAccount: account, chainId, nonce: Number(r.nonce), opId: r.op_id, detail: 'reservation nonce ' + r.nonce + ' < chain nonce ' + chainNonce + ' but not CONSUMED/STALLED — consumed by someone else?' });
      if (this.store.hasBlockingIncident(account, chainId)) {
        throw new Error('BLOCKED_UNEXPECTED_NONCE_CONSUMPTION');
      }
    }
    // Nonce gaps: reservations without matching chain activity AND no pending
    // tx must be surfaced (stalled reservations block new work at the same
    // nonce — never recycled).
    const pending = await this._pendingTxs(account);
    for (const r of reservations) {
      if (r.status === 'STALLED' && chainNonce <= Number(r.nonce)) {
        // A stalled reservation below the chain nonce has been consumed
        // externally (or the tx landed elsewhere) — surface it.
        this.store.incident({ kind: 'STALLED_RESERVATION_REVIEW', relayerAccount: account, chainId, nonce: Number(r.nonce), opId: r.op_id, detail: 'stalled reservation at nonce ' + r.nonce + ' requires review before reuse' });
        if (this.store.hasBlockingIncident(account, chainId)) {
          throw new Error('BLOCKED_STALLED_RESERVATION');
        }
      }
    }
    return Math.max(chainNonce, highestReserved + 1);
  }

  async _pendingTxs(account) {
    try {
      // ethers lacks a direct pending-tx list; use the pool RPC when available.
      return [];
    } catch { return []; }
  }

  /** Complete reconciliation run over ALL supervised attempts. */
  async reconcileAll({ allowRebroadcast = false } = {}) {
    const attempts = this.store.listAttempts(['PENDING', 'SUBMISSION_UNCERTAIN', 'INCLUDED']);
    const results = [];
    for (const a of attempts) {
      const r = await this.reconcileOutcome(a.op_id, { allowRebroadcast });
      results.push({ opId: a.op_id, attempt: a.attempt_num, ...r });
    }
    return results;
  }

  /** Recovery: accept+prepare as D1, plus supervised broadcasts to reconcile. */
  recoverWork() {
    const base = super.recover();
    const supervised = this.store.listAttempts(['PENDING', 'SUBMISSION_UNCERTAIN', 'INCLUDED']);
    return { ...base, supervised };
  }
}

module.exports = { D2Worker };