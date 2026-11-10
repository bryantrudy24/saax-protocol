// Phase D2 — worker CLI entry used by child-process crash/restart tests.
//
// Usage:
//   node worker/run-d2-worker.cjs <storePath> <chainId> <custodyAddress> <rpcUrl>
//        [--prepare opId payloadDigest escrowId requestedAction bindingsJson]
//        [--broadcast opId]
//        [--reconcile opId]
//        [--reconcile-all]
//        [--exit-after N]   (child-process harness only: exit after finishing)
//
// No production wiring. Loads the committed custody ABI. The relayer key comes
// from the standard hardhat dev key (index 1) — synthetic, PUBLIC test constant,
// never a production secret. Broadcast uses the SAME persisted signed bytes.
// This CLI exists for tests; the D2 worker library is the deliverable.

'use strict';

const path = require('node:path');
const { Wallet, JsonRpcProvider } = require('ethers');
const { D2Worker } = require('./d2-worker.js');
const { loadCustodyAbi } = require('./d1-abi.js');
const { FinalityAdapter } = require('./d2-finality.js');
const { D2Prerequisites } = require('./d2-prereqs.js');
const { assertConfigGates } = require('./config-gates.js');

// Dedicated relayer (hardhat account 7 — public test constant, unused by
// fixtures). Child-process tests pass SAAX_D2_RELAYER_KEY explicitly.
const RELAYER_KEY = process.env.SAAX_D2_RELAYER_KEY || '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';

function usage() {
  console.error('usage: node worker/run-d2-worker.cjs <store> <chainId> <custody> <rpc> [--prepare opId payload escrow action bindingsJson] [--broadcast opId] [--reconcile opId] [--reconcile-all]');
  process.exit(2);
}

async function main(argv) {
  const [storePath, chainIdRaw, custody, rpc] = argv.slice(2, 6);
  if (!storePath || !chainIdRaw || !custody || !rpc) usage();
  const chainId = Number(chainIdRaw);
  // Phase D4B startup control: the worker entry FAILS CLOSED on a
  // production-intended configuration that lacks the required controls.
  // Explicit SAAX_EXEC_MODE=local (the test harness mode) is the ONLY
  // escape hatch, and it is never inferred — see config-gates.js.
  try {
    assertConfigGates(process.env, {
      devRelayerKeys: [process.env.SAAX_D2_RELAYER_KEY, process.env.SAAX_PREPARED_KEY].filter(Boolean),
      devEvaluatorKeys: [process.env.SAAX_EVALUATOR_PRIVATE_KEY].filter(Boolean),
      custody,
      chainId,
    });
  } catch (e) {
    console.error('D2RESULT ' + JSON.stringify({ fatal: 'PRODUCTION_CONFIG_GATES_FAILED', missing: (e.details && e.details.missing) || [], violations: (e.details && e.details.violations) || [] }));
    process.exit(1);
  }
  // E1 closure: runtime finality configuration seam. The selected finality
  // POLICY and METHOD are trusted configuration carried from launcher startup
  // through worker construction — read from the operator env, never from an
  // export. Defaults preserve the existing behavior: local-confirmations
  // (chain 31337) + bounded-ancestry. The FinalityAdapter's explicit
  // supported-network gate validates the chain: mainnet (1, 8453) and
  // arbitrary chains fail closed at construction.
  const finalityPolicy = String(process.env.SAAX_FINALITY_POLICY || 'local-confirmations').trim();
  const finalityMethod = String(process.env.SAAX_FINALITY_METHOD || 'bounded-ancestry').trim();
  // Unknown method fails closed BEFORE any wallet/provider/worker construction
  // (trusted config, never export-owned; validated at the launcher seam).
  if (finalityMethod !== 'bounded-ancestry' && finalityMethod !== 'trusted-rpc') {
    console.error('D2RESULT ' + JSON.stringify({ fatal: 'FINALITY_METHOD_UNSUPPORTED:' + finalityMethod }));
    process.exit(1);
  }
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const wallet = new Wallet(RELAYER_KEY, provider);
  const abi = loadCustodyAbi();

  // nextNonce: chain-aware (D2). The D1 default constructor takes opts.nextNonce;
  // D2 overrides with nextNonceFor.
  const worker = new D2Worker({
    storePath, abi, chain: { id: chainId, custody },
    prereqs: new D2Prerequisites({
      abi, custody: { address: custody, chainId },
      getEscrow: async (cid) => {
        const { Contract } = require('ethers');
        const c = new Contract(custody, abi, provider);
        const e = await c.getEscrow(cid);
        return {
          state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline,
          buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token,
          evaluator: e.evaluator, commitmentDigest: e.commitmentDigest,
        };
      },
      getBlock: async (tag) => provider.getBlock(tag),
      policy: { require2of3Evaluator: false },
    }),
    nextNonce: async (account, chain) => worker2.nextNonceFor(account, chain),
    relayer: { account: wallet.address, wallet },
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
  });
  let worker2 = worker;

  const out = (obj) => { console.log('D2RESULT ' + JSON.stringify(obj)); };

  for (let i = 6; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--prepare') {
      const opId = argv[i + 1], payloadDigest = argv[i + 2], escrowId = argv[i + 3], requestedAction = argv[i + 4], bindings = JSON.parse(argv[i + 5]);
      i += 5;
      const r = await worker.prepare({
        opId, payloadDigest, agreementRef: bindings.agreementRef || 'agreement-v4-1', escrowId, requestedAction,
        authNonce: bindings.authNonce || 'n1', authRole: bindings.authRole || 'evaluator',
        authExpiry: bindings.authExpiry || Date.now() + 60000,
        actionArgs: bindings.actionArgs || {},
        bindings,
      });
      out({ cmd: 'prepare', opId, ok: r.ok, status: r.status, reason: r.reason, nonce: r.tx ? r.tx.nonce : null, txHash: r.tx ? r.tx.txHash : null });
    } else if (a === '--broadcast') {
      const opId = argv[i + 1]; i += 1;
      const r = await worker.broadcastPrepared(opId);
      out({ cmd: 'broadcast', opId, ok: r.ok, status: r.status, reason: r.reason, attempt: r.attempt, txHash: r.txHash, nonce: r.nonce });
    } else if (a === '--reconcile') {
      const opId = argv[i + 1]; i += 1;
      const r = await worker.reconcileOutcome(opId, { allowRebroadcast: argv.includes('--allow-rebroadcast') });
      out({ cmd: 'reconcile', opId, ok: r.ok, status: r.status, reason: r.reason, attempt: r.attempt, outcome: r.outcome && r.outcome.evidence ? { result: r.outcome.status, state: r.outcome.evidence.escrowState, events: r.outcome.evidence.events } : null });
    } else if (a === '--reconcile-all') {
      const r = await worker.reconcileAll();
      out({ cmd: 'reconcileAll', results: r });
    } else if (a === '--exit-after') {
      const n = Number(argv[i + 1]); i += 1;
      out({ cmd: 'exitAfter', n });
      break;
    } else if (a === '--probe-finality') {
      // E1 closure diagnostic: print the runtime finality configuration that
      // ACTUALLY propagated from launcher startup into the constructed worker.
      out({
        cmd: 'probeFinality',
        chainId,
        finalityMethod: worker.finalityMethod,
        policyMode: worker.finality && worker.finality.policy && worker.finality.policy.mode,
        policyLabel: worker.finality && worker.finality.policy && worker.finality.policy.label,
        localOnly: !!(worker.finality && worker.finality.isLocalOnly),
        trustedRpcBound: !!worker.trustedRpcFinality,
      });
    } else if (a === '--recover') {
      const r = worker.recoverWork();
      out({ cmd: 'recover', accepted: r.accepted, prepared: r.prepared, supervised: r.supervised });
    }
  }
  worker.close();
  process.exit(0);
}

main(process.argv).catch((e) => { console.error('D2RESULT ' + JSON.stringify({ fatal: e.message, stack: e.stack })); process.exit(1); });