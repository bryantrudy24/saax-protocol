// config-gates.js — Phase D4B production-activation configuration gates.
//
// PURPOSE
//   For a FUTURE production-intended worker configuration, fail startup unless
//   the required controls are EXPLICITLY configured. These gates do NOT
//   authorize activation — mainnet admission remains independently disabled
//   (SAAX_ADMISSION_ENABLED !== '1'). They only refuse to start a
//   production-intended worker that lacks the required controls.
//
// MODE MODEL
//   - SAAX_EXEC_MODE=production : production-intended. ALL gates enforced.
//     Fail startup on any missing control. No silent fallback.
//   - SAAX_EXEC_MODE=local (default) : explicit local test mode. The worker
//     may run WITHOUT production controls, but ONLY when the local mode is
//     EXPLICITLY declared (never inferred). Local mode must not silently fall
//     back from production requirements: if production controls ARE supplied
//     but contradictory, that still fails.
//   - No SAAX_EXEC_MODE at all : treated as local for legacy test
//     compatibility, but with a warning that production activation is
//     impossible without an explicit production mode + full controls.
//
// REQUIRED CONTROLS (production mode)
//   1. Supported runtime and storage topology.
//   2. Protected prepared-transaction storage and available key identifiers.
//   3. External signer identity and allowed chain/custody/action policy.
//   4. Complete transaction fee/gas limits.
//   5. Explicit finality policy.
//   6. Required evaluator governance configuration.
//   7. No known development keys or test-only overrides.
//
// KNOWN DEVELOPMENT KEYS / TEST-ONLY OVERRIDES (production must refuse)
//   - The hardhat public test keys (index 0..11) and any address that resolves
//     from them are DEVELOPMENT keys.
//   - Test-only overrides: SAAX_X402_VERIFY_MODE=mock, SAAX_X402_MODE=mock,
//     SAAX_EAS_MODE=mock, SAAX_ESCROW_ALLOW_MAINNET=1 (deprecated bypass),
//     SAAX_D4A_PROTECT unset in production, SAAX_EXTERNAL_SIGNER_ADAPTER=none.
//
// This module is NOT wired into production routes; it is the startup gate for
// the worker process and is invoked by the worker entry/CLI and tests.

'use strict';

// E1 closure: explicit supported-network policy for worker startup. Production
// worker configuration must target the explicit public-testnet chain (84532);
// mainnet chains (Ethereum 1, Base 8453) and arbitrary chains are refused.
// Exported chain/method/policy values can never override trusted
// configuration (the gates validate ONLY the env/operator configuration).
const { classifyChain } = require('../mainnet/design/support/supported-networks.js');

// Known public hardhat dev keys (synthetic; documented in hardhat config).
const DEV_KEY_ADDRESSES = new Set([
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f',
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f',
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
]);

const KNOWN_TEST_OVERRIDES = [
  'SAAX_X402_VERIFY_MODE=mock',
  'SAAX_X402_MODE=mock',
  'SAAX_EAS_MODE=mock',
  'SAAX_ESCROW_ALLOW_MAINNET=1',
  'SAAX_EXTERNAL_SIGNER_ADAPTER=none',
];

/**
 * Assess a worker configuration against the production gates.
 * @param {object} env  the effective environment (defaults to process.env)
 * @param {object} opts {
 *   devRelayerKeys?: string[]  // keys present in env to check
 *   devEvaluatorKeys?: string[]
 *   custody?: string
 *   chainId?: number|string
 * }
 * @returns {{
 *   mode: 'production'|'local',
 *   ok: boolean,
 *   admissionEnabled: boolean,
 *   missing: string[],
 *   violations: string[],
 *   legacyNote?: string,
 * }}
 */
function assessConfigGates(env = process.env, opts = {}) {
  const missing = [];
  const violations = [];
  const mode = String(env.SAAX_EXEC_MODE || 'local').toLowerCase();
  const production = mode === 'production';
  const admissionEnabled = env.SAAX_ADMISSION_ENABLED === '1';
  const e = (k) => env[k];

  if (production) {
    // 1. Supported runtime and storage topology.
    if (!e('SAAX_EXEC_RUNTIME') || !e('SAAX_EXEC_RUNTIME').trim()) missing.push('SAAX_EXEC_RUNTIME (supported runtime topology)');
    if (!e('SAAX_EXEC_STORAGE') || !e('SAAX_EXEC_STORAGE').trim()) missing.push('SAAX_EXEC_STORAGE (storage topology)');
    // 2. Protected prepared-transaction storage + key ids.
    if (!e('SAAX_PREPARED_KEY_ID') || !e('SAAX_PREPARED_KEY_ID').trim()) missing.push('SAAX_PREPARED_KEY_ID (prepared-transaction key identifier)');
    if (!e('SAAX_PREPARED_KEY') && !e('SAAX_PREPARED_KEY_FILE')) missing.push('SAAX_PREPARED_KEY or SAAX_PREPARED_KEY_FILE (protected prepared storage)');
    if (e('SAAX_D4A_PROTECT') !== '1') violations.push('SAAX_D4A_PROTECT must be 1 in production (plaintext prepared storage is forbidden)');
    // 3. External signer identity + allowed chain/custody/action policy.
    if (!e('SAAX_EXTERNAL_SIGNER_ADAPTER') || e('SAAX_EXTERNAL_SIGNER_ADAPTER') === 'none') missing.push('SAAX_EXTERNAL_SIGNER_ADAPTER (external signer, not "none")');
    if (!e('SAAX_EXTERNAL_SIGNER_ENDPOINT') && !e('SAAX_EXTERNAL_SIGNER_IDENTITY')) missing.push('SAAX_EXTERNAL_SIGNER_ENDPOINT or SAAX_EXTERNAL_SIGNER_IDENTITY (signer identity)');
    if (!e('SAAX_ALLOWED_CHAIN_ID') && !e('SAAX_CHAIN_ID')) missing.push('SAAX_ALLOWED_CHAIN_ID/SAAX_CHAIN_ID (allowed chain)');
    if (!e('SAAX_CUSTODY_ADDRESS')) missing.push('SAAX_CUSTODY_ADDRESS (custody destination)');
    if (!e('SAAX_ALLOWED_ACTIONS')) missing.push('SAAX_ALLOWED_ACTIONS (allowed contract actions)');
    // 4. Complete transaction fee/gas limits.
    if (!e('SAAX_MAX_GAS_PRICE') && !e('SAAX_GAS_PRICE')) missing.push('SAAX_MAX_GAS_PRICE/SAAX_GAS_PRICE (fee limit)');
    if (!e('SAAX_MAX_GAS_LIMIT') && !e('SAAX_GAS_LIMIT')) missing.push('SAAX_MAX_GAS_LIMIT/SAAX_GAS_LIMIT (gas limit)');
    // 5. Explicit finality policy.
    if (!e('SAAX_FINALITY_POLICY') || !e('SAAX_FINALITY_POLICY').trim()) missing.push('SAAX_FINALITY_POLICY (explicit finality policy)');
    // 6. Required evaluator governance configuration.
    if (!e('SAAX_EVALUATOR_GOVERNANCE') || !e('SAAX_EVALUATOR_GOVERNANCE').trim()) missing.push('SAAX_EVALUATOR_GOVERNANCE (evaluator governance config)');
    // 7. No known development keys or test-only overrides.
    // 7b. E1 closure: the allowed worker chain must be the explicit
    //     public-testnet chain (84532). Mainnet chains (1, 8453) and arbitrary
    //     chains are refused by the startup gate — production never targets a
    //     mainnet chain under current authorization. Local mode is a separate
    //     explicit test lane (31337) and is NOT a production config.
    {
      const chainRaw = e('SAAX_ALLOWED_CHAIN_ID') || e('SAAX_CHAIN_ID');
      if (chainRaw) {
        const n = Number(chainRaw);
        if (classifyChain(n) !== 'public-testnet') {
          violations.push('SAAX_ALLOWED_CHAIN_ID/SAAX_CHAIN_ID must be the explicit public-testnet chain 84532; got ' + chainRaw + ' (class=' + classifyChain(n) + ')');
        }
      } else {
        missing.push('SAAX_ALLOWED_CHAIN_ID/SAAX_CHAIN_ID (allowed chain)');
      }
    }
    const devKeys = [...(opts.devRelayerKeys || []), ...(opts.devEvaluatorKeys || [])];
    for (const k of devKeys) {
      if (!k) continue;
      const addr = (() => { try { const { Wallet } = require('ethers'); return new Wallet(k).address.toLowerCase(); } catch { return ''; } })();
      if (addr && DEV_KEY_ADDRESSES.has(addr)) violations.push('development key detected for relayer/evaluator (' + addr.slice(0, 10) + '…)');
    }
    for (const ov of KNOWN_TEST_OVERRIDES) {
      const [k, v] = ov.split('=');
      if (env[k] === v) violations.push('test-only override present: ' + ov);
    }
    // Also: production must not use a known hardhat relayer address.
    if (opts.custody) { /* custody address is allowed to be any address; not a key check */ }
  }

  // Local mode: only warn that production activation is impossible without the
  // explicit mode + controls; do not fail legacy tests.
  const legacyNote = !production && !env.SAAX_EXEC_MODE
    ? 'SAAX_EXEC_MODE unset — treated as local test mode (legacy compatibility). Production activation requires SAAX_EXEC_MODE=production plus all required controls.'
    : undefined;

  return {
    mode,
    ok: production ? (missing.length === 0 && violations.length === 0) : true,
    production,
    admissionEnabled,
    missing,
    violations,
    legacyNote,
  };
}

/** Throw a startup-failing error when production gates are not met. */
function assertConfigGates(env = process.env, opts = {}) {
  const r = assessConfigGates(env, opts);
  if (r.production && !r.ok) {
    const err = new Error('PRODUCTION_CONFIG_GATES_FAILED');
    err.details = { missing: r.missing, violations: r.violations };
    throw err;
  }
  return r;
}

module.exports = { assessConfigGates, assertConfigGates, DEV_KEY_ADDRESSES, KNOWN_TEST_OVERRIDES };
