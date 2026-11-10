// SAAX Protocol - Escrow chain guard stubbed tests (no live RPC)
//
// Proves verifyOnChain's chain gate enforces the testnet-only policy:
//   - The guard reads the RPC-resolved chain (eth_chainId), not configuration.
//   - 84532 (Base Sepolia) passes the gate and proceeds to custody resolution.
//   - 8453 (Base mainnet) is refused with UNSUPPORTED_CHAIN.
//   - Any other unsupported chain (e.g. 1) is refused with UNSUPPORTED_CHAIN.
//   - SAAX_ESCROW_ALLOW_MAINNET no longer overrides the guard (flag has no effect).
//   - On an unsupported chain no downstream financial action is reached: no
//     transaction-building call, no signing call, no writeContract simulation,
//     and no contract read (getEscrow).
//
// Method: the module requires 'ethers' by reference. We swap the installed
// JsonRpcProvider class for a stub that (a) answers eth_chainId from the test
// case and (b) counts every network/contract method that would constitute a
// financial action. No live RPC is used.
'use strict';

delete process.env.SAAX_RPC_URL;
delete process.env.SAAX_CHAIN_ID;

const path = require('path');
const Module = require('module');

const results = [];
let passed = 0;
let failed = 0;

function record(name, ok, detail) {
  if (ok) { passed++; results.push({ name, ok, detail }); console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; results.push({ name, ok, detail }); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); process.exitCode = 1; }
}

// ---- Stub provider that answers eth_chainId and counts further calls -------
function makeProvider(chainIdHex) {
  const calls = [];
  const handler = {
    get(_t, prop) {
      if (prop === 'send') {
        return async (method, params) => {
          calls.push({ method, params });
          if (method === 'eth_chainId') return chainIdHex;
          throw new Error('unexpected RPC method in stub: ' + method);
        };
      }
      if (prop === 'getNetwork') {
        return async () => { calls.push({ method: 'getNetwork', params: undefined }); return { chainId: parseInt(chainIdHex, 16) }; };
      }
      if (prop === 'getLogs') {
        return async () => { calls.push({ method: 'getLogs', params: undefined }); return []; };
      }
      return undefined;
    },
    has(_t, prop) { return ['send', 'getNetwork', 'getLogs'].includes(prop); },
  };
  return { __calls: calls, provider: new Proxy({}, handler) };
}

// Swap the installed JsonRpcProvider for the stub via a require hook.
function loadEscrowWithStub(maker) {
  const modules = {};
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'ethers') return request; // never resolve the real ethers
    return origResolve.call(this, request, ...rest);
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'ethers') {
      if (!modules.ethers) {
        const fake = { JsonRpcProvider: maker, Contract: function () {}, getAddress: (a) => a, getDefaultProvider: () => null };
        modules.ethers = fake;
      }
      return modules.ethers;
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../endpoint/escrow.js')];
    return require('../endpoint/escrow.js');
  } finally {
    Module._resolveFilename = origResolve;
    Module._load = origLoad;
  }
}

(async () => {
  console.log('--- Escrow chain guard (stubbed RPC) ---');

  // Helper: install stub, load module under test, run one verifyOnChain call.
  async function runCase(chainId, hex, env, opts) {
    const hole = {};
    const factory = function () {
      const stub = makeProvider(hex);
      hole.stub = stub;
      return stub.provider;
    };
    const escrow = loadEscrowWithStub(factory);
    try {
      const res = await escrow.verifyOnChain('0x' + '11'.repeat(32), opts);
      return { res, calls: hole.stub ? hole.stub.__calls : [] };
    } finally { /* stub captured in hole */ }
  }

  // CASE 1: RPC returns 84532 -> guard passes, proceeds past the gate.
  {
    const { res, calls } = await runCase(84532, '0x14a34', undefined, { custody: '0x' + 'aa'.repeat(20) });
    // Proceeds: WITHOUT the OPTIONAL opts.custody it returns NO_CUSTODY (not UNSUPPORTED_CHAIN)
    const { res: noCustody, calls: noCustodyCalls } = await runCase(84532, '0x14a34', undefined, {});
    const passGate = noCustody && noCustody.error === 'NO_CUSTODY';
    const onlyChainId = noCustodyCalls.length === 1 && noCustodyCalls[0].method === 'eth_chainId';
    record('rpc 84532: guard passes, proceeds past chain gate (NO_CUSTODY, not UNSUPPORTED_CHAIN)', passGate === true, JSON.stringify(noCustody));
    record('rpc 84532: exactly one RPC call (eth_chainId) before custody refusal', onlyChainId === true, JSON.stringify(noCustodyCalls));
  }

  // CASE 2: RPC returns 8453 -> refused with the exact shape and reason text.
  {
    const { res, calls } = await runCase(8453, '0x2105', undefined, {});
    const ok = res && res.ok === false && res.error === 'UNSUPPORTED_CHAIN' &&
      res.reason === 'escrow-backed mode is testnet-only (chain 8453, expected 84532)';
    const onlyChainId = calls.length === 1 && calls[0].method === 'eth_chainId';
    record('rpc 8453: guard refuses with UNSUPPORTED_CHAIN and exact reason', ok === true, JSON.stringify(res));
    record('rpc 8453: guard stops after eth_chainId; no getNetwork/getLogs call', onlyChainId === true, JSON.stringify(calls));
  }

  // CASE 3: RPC returns chain 1 -> refused with same error shape naming chain 1.
  {
    const { res, calls } = await runCase(1, '0x1', undefined, {});
    const ok = res && res.ok === false && res.error === 'UNSUPPORTED_CHAIN' &&
      res.reason === 'escrow-backed mode is testnet-only (chain 1, expected 84532)';
    const onlyChainId = calls.length === 1 && calls[0].method === 'eth_chainId';
    record('rpc 1: unsupported chain refused with same shape naming chain', ok === true, JSON.stringify(res));
    record('rpc 1: guard stops after eth_chainId (no further RPC)', onlyChainId === true, JSON.stringify(calls));
  }

  // CASE 4: RPC returns 8453 with SAAX_ESCROW_ALLOW_MAINNET=1 -> still refused.
  {
    process.env.SAAX_ESCROW_ALLOW_MAINNET = '1';
    const { res, calls } = await runCase(8453, '0x2105', { SAAX_ESCROW_ALLOW_MAINNET: '1' }, {});
    const ok = res && res.ok === false && res.error === 'UNSUPPORTED_CHAIN';
    const onlyChainId = calls.length === 1 && calls[0].method === 'eth_chainId';
    record('rpc 8453 + SAAX_ESCROW_ALLOW_MAINNET=1: flag does not override (still refused)', ok === true, JSON.stringify(res));
    record('rpc 8453 + flag: same guard path (only eth_chainId called)', onlyChainId === true, JSON.stringify(calls));
    delete process.env.SAAX_ESCROW_ALLOW_MAINNET;
  }

  // CASE 5: RPC returns 8453 -> no downstream financial action is reached.
  {
    const { res, calls } = await runCase(8453, '0x2105', undefined, { custody: '0x' + 'aa'.repeat(20) });
    const ok = res && res.ok === false && res.error === 'UNSUPPORTED_CHAIN';
    // No financial action: the ONLY RPC interaction is eth_chainId. No
    // getLogs (event scan), no Contract.getEscrow read, no transaction
    // building, no signing, no writeContract simulation — all of those would
    // surface as additional recorded stub calls or a READ_FAILED outcome.
    const onlyChainId = calls.length === 1 && calls[0].method === 'eth_chainId';
    const noFinancialAction = ok === true && onlyChainId === true;
    record('rpc 8453: no financial action (only eth_chainId called; no getEscrow/getLogs/signing/write)', noFinancialAction === true,
      'res=' + JSON.stringify(res) + ' calls=' + JSON.stringify(calls));
  }

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILURES: ' + results.filter(r => !r.ok).map(r => r.name).join(' | ')); }
  process.exitCode = failed ? 1 : 0;
})();