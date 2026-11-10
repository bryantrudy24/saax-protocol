// D3 worker CLI — local service integration runner.
//
// Startup:
//   node worker/run-d3-worker.cjs <store> <chainId> <custody> <rpc> \
//        [--prepare-op opId] [--once] [--loop] [--drain] [--export opId] [--exit-after N]
//
// Shutdown: SIGINT/Ctrl-C stops gracefully after the current work item
// (documented; `--exit-after N` also available for child-process tests).
//
// Discovery is POLLING ONLY — the worker never depends on an in-memory
// notification. `--once` processes exactly one batch of committed PENDING
// work; `--loop` repeats until no PENDING work remains (bounded).
//
// Journal config comes from the environment (SAAX_JOURNAL_DIR,
// SAAX_JOURNAL_SIGNER_KEY). The relayer key is the dedicated synthetic
// hardhat account key (SAAX_D2_RELAYER_KEY, default account 7 — public test
// constant). Never a production secret.
//
// No production wiring. The D3 worker executes ONLY actions whose
// prerequisites pass (D2Prerequisites) — it never invents evaluator approval.

'use strict';

const path = require('node:path');
const { Wallet, JsonRpcProvider } = require('ethers');
const { D3Worker } = require('./d3-worker.js');
const { loadCustodyAbi } = require('./d1-abi.js');
const { FinalityAdapter } = require('./d2-finality.js');
const { D2Prerequisites } = require('./d2-prereqs.js');
const { assertConfigGates } = require('./config-gates.js');

const RELAYER_KEY = process.env.SAAX_D2_RELAYER_KEY || '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';

function usage() {
  console.error('usage: node worker/run-d3-worker.cjs <store> <chainId> <custody> <rpc> [--once] [--loop] [--drain] [--export opId] [--recover] [--exit-after N]');
  process.exit(2);
}

async function main(argv) {
  const [storePath, chainIdRaw, custody, rpc] = argv.slice(2, 6);
  if (!storePath || !chainIdRaw || !custody || !rpc) usage();
  const chainId = Number(chainIdRaw);
  // Phase D4B closure: the D3 integrated worker entry FAILS CLOSED on a
  // production-intended configuration that lacks the required controls,
  // exactly like run-d2-worker.cjs. This runs BEFORE any store open,
  // signature, or broadcast. Explicit SAAX_EXEC_MODE=local (the test
  // harness mode) is the ONLY escape hatch and is never inferred.
  try {
    assertConfigGates(process.env, {
      devRelayerKeys: [process.env.SAAX_D2_RELAYER_KEY, process.env.SAAX_PREPARED_KEY].filter(Boolean),
      devEvaluatorKeys: [process.env.SAAX_EVALUATOR_PRIVATE_KEY].filter(Boolean),
      custody,
      chainId,
    });
  } catch (e) {
    console.error('D3RESULT ' + JSON.stringify({ fatal: 'PRODUCTION_CONFIG_GATES_FAILED', missing: (e.details && e.details.missing) || [], violations: (e.details && e.details.violations) || [] }));
    process.exit(1);
  }
  // E1 closure: runtime finality configuration seam (same as run-d2-worker).
  // POLICY and METHOD are trusted configuration from launcher startup into
  // worker construction. FinalityAdapter's explicit supported-network gate
  // validates chainId: mainnet (1, 8453) and arbitrary chains fail closed.
  const finalityPolicy = String(process.env.SAAX_FINALITY_POLICY || 'local-confirmations').trim();
  const finalityMethod = String(process.env.SAAX_FINALITY_METHOD || 'bounded-ancestry').trim();
  // Unknown method fails closed BEFORE any wallet/provider/worker construction.
  if (finalityMethod !== 'bounded-ancestry' && finalityMethod !== 'trusted-rpc') {
    console.error('D3RESULT ' + JSON.stringify({ fatal: 'FINALITY_METHOD_UNSUPPORTED:' + finalityMethod }));
    process.exit(1);
  }
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const wallet = new Wallet(RELAYER_KEY, provider);
  const abi = loadCustodyAbi();
  const acct = wallet.address;

  const worker = new D3Worker({
    storePath, abi, chain: { id: chainId, custody },
    custodyVersion: Number(process.env.SAAX_CUSTODY_VERSION || 0),
    prereqs: new D2Prerequisites({
      abi, custody: { address: custody, chainId },
      getEscrow: async (cid) => {
        const { Contract } = require('ethers');
        const c = new Contract(custody, abi, provider);
        const e = await c.getEscrow(cid);
        return {
          state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline,
          buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token,
          evaluator: e.evaluator,
          // The contract's getEscrow returns (id, digest, token, ...). The
          // action-auth module compares esc.digest to the op's escrowId —
          // which IS the escrow's commitment id (the map key). Expose the
          // key as digest for that comparison; commitmentDigest carries the
          // funded digest for D2 prereq checks.
          id: e.id,
          digest: e.id,
          commitmentDigest: e.digest,
        };
      },
      getBlock: async (tag) => provider.getBlock(tag),
      policy: { require2of3Evaluator: false },
    }),
    nextNonce: async (account, chain) => worker.nextNonceFor(account, chain),
    relayer: { account: acct, wallet },
    provider,
    finalityMethod,
    finality: new FinalityAdapter({
      getBlock: async (tag) => provider.getBlock(tag),
      getReceipt: async (h) => provider.getTransactionReceipt(h),
      chainId,
      policy: finalityPolicy,
      confirmations: 1,
    }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    maxNonceRetries: 3,
    // Phase D4A: restricted signing + at-rest protection (env-driven).
    // SAAX_D4A_PROTECT=1 turns on the envelope path; the prepared key must be
    // supplied (SAAX_PREPARED_KEY hex 32 bytes, or SAAX_PREPARED_KEY_FILE).
    protection: process.env.SAAX_D4A_PROTECT === '1',
    vault: (process.env.SAAX_D4A_PROTECT === '1') ? require('./prepared-vault.js') : null,
    signingPolicy: (process.env.SAAX_D4A_PROTECT === '1') ? {
      abi,
      allowedActions: new Set(['release', 'refund', 'mutualRelease', 'mutualRefund', 'raiseDispute', 'resolve']),
      allowedChainId: chainId,
      custody,
      maxGasPrice: '2000000000', // bound above configured gasPrice (1 gwei)
      maxGasLimit: '800000',     // bound above configured gasLimit (400k)
    } : null,
    journal: process.env.SAAX_JOURNAL_DIR ? {
      dir: process.env.SAAX_JOURNAL_DIR,
      signerKey: process.env.SAAX_JOURNAL_SIGNER_KEY || RELAYER_KEY,
      chainId, custodyAddress: custody,
    } : null,
    logger: { info: (...a) => console.log('[d3]', ...a), warn: (...a) => console.warn('[d3]', ...a), error: (...a) => console.error('[d3]', ...a) },
  });

  const out = (obj) => { console.log('D3RESULT ' + JSON.stringify(obj)); };

  let prepareOp = null, exportOp = null, once = false, loop = false, drain = false, recover = false, exitAfter = null, broadcastOp = null, reconcileOp = null, probeFinality = false;
  for (let i = 6; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--prepare-op') { prepareOp = argv[i + 1]; i += 1; }
    else if (a === '--export') { exportOp = argv[i + 1]; i += 1; }
    else if (a === '--broadcast') { broadcastOp = argv[i + 1]; i += 1; }
    else if (a === '--reconcile') { reconcileOp = argv[i + 1]; i += 1; }
    else if (a === '--once') { once = true; }
    else if (a === '--loop') { loop = true; }
    else if (a === '--drain') { drain = true; }
    else if (a === '--recover') { recover = true; }
    else if (a === '--probe-finality') { probeFinality = true; }
    else if (a === '--exit-after') { exitAfter = Number(argv[i + 1]); i += 1; }
  }

  if (probeFinality) {
    // E1 closure diagnostic: the runtime finality configuration that ACTUALLY
    // propagated from launcher startup into the constructed D3 worker.
    out({
      cmd: 'probeFinality',
      chainId,
      finalityMethod: worker.finalityMethod,
      policyMode: worker.finality && worker.finality.policy && worker.finality.policy.mode,
      policyLabel: worker.finality && worker.finality.policy && worker.finality.policy.label,
      localOnly: !!(worker.finality && worker.finality.isLocalOnly),
      trustedRpcBound: !!worker.trustedRpcFinality,
    });
    worker.close();
    process.exit(0);
  }

  if (prepareOp) {
    const op = worker.store.getOperation(prepareOp);
    if (!op) { out({ cmd: 'prepare', ok: false, reason: 'NO_OPERATION', opId: prepareOp }); }
    else {
      const actionArgs = worker.store.getOperationActionArgs(prepareOp);
      const { contractActionFor } = require('./d3-worker.js');
      const requestedAction = contractActionFor(op.requestedAction || op.requested_action);
      const r = await worker._prepareAccepted({ ...op, requestedAction }, {
        requestedAction, actionArgs,
        bindings: { agreementRef: op.agreementRef || op.agreement_ref, escrowId: op.escrowId, chainId, custody, requestedAction, payloadDigest: op.payloadDigest, authNonce: op.authNonce, authRole: op.authRole, authExpiry: op.authExpiry, cutoff: null },
      });
      out({ cmd: 'prepare', opId: prepareOp, ok: r.ok, status: r.status, reason: r.reason, nonce: r.tx ? r.tx.nonce : null, txHash: r.tx ? r.tx.txHash : null });
    }
  } else if (broadcastOp) {
    const r = await worker.broadcastPrepared(broadcastOp);
    out({ cmd: 'broadcast', opId: broadcastOp, ok: r.ok, status: r.status, reason: r.reason, attempt: r.attempt, txHash: r.txHash, nonce: r.nonce });
  } else if (reconcileOp) {
    const r = await worker.reconcileOutcome(reconcileOp, { allowRebroadcast: false });
    out({ cmd: 'reconcile', opId: reconcileOp, ok: r.ok, status: r.status, reason: r.reason, attempt: r.attempt, outcome: r.outcome && r.outcome.evidence ? { result: r.outcome.status, state: r.outcome.evidence.escrowState, events: r.outcome.evidence.events } : null });
  } else if (exportOp) {
    try {
      const exp = await worker.buildV4Export(exportOp);
      if (process.env.SAAX_D3_EXPORT_DIR) {
        const fs = require('node:fs');
        const dir = process.env.SAAX_D3_EXPORT_DIR;
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, 'export-' + String(exportOp).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
        fs.writeFileSync(p, JSON.stringify(exp, null, 2));
        out({ cmd: 'export', opId: exportOp, ok: true, exportPath: p });
      } else {
        out({ cmd: 'export', opId: exportOp, ok: true, exportPath: null, export: exp });
      }
    } catch (e) {
      out({ cmd: 'export', opId: exportOp, ok: false, reason: e.message });
    }
  } else if (drain) {
    const r = await worker.drainOutbox();
    out({ cmd: 'drain', results: r });
  } else if (recover) {
    out({ cmd: 'recover', recovery: worker.recoverWork() });
  } else if (once || loop) {
    const r = loop
      ? await worker.processLoop({ maxIterations: exitAfter || 100 })
      : await worker.processOnce();
    out({ cmd: loop ? 'loop' : 'once', results: r });
  } else {
    usage();
  }

  worker.close();
  process.exit(0);
}

main(process.argv).catch((e) => { console.error('D3RESULT ' + JSON.stringify({ fatal: e.message, stack: e.stack })); process.exit(1); });