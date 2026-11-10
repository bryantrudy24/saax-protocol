// SAAX Phase 3A — Hardhat config (LOCAL TEST ONLY).
// Compiles the Phase 3A custody candidate with solc 0.8.26 in viaIR mode
// (the candidate's deep stack requires viaIR — see test-custody-v2.cjs).
// The hardhat network is a local in-process EVM on a DISTINCT local chain ID
// (31337) so local test signatures can never be mistaken for Base Sepolia
// (84532) signatures. NOT used for any deployment, fork, or live-chain access.
// Use the lockfile-pinned local compiler, not an ambient/downloaded cache.
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion !== '0.8.26') return runSuper();
  const longVersion = require('solc').version();
  if (!longVersion.startsWith('0.8.26+commit.8a97fa7a')) throw new Error('unexpected local solc version');
  return { compilerPath: require.resolve('solc/soljson.js'), isSolcJs: true, version: solcVersion, longVersion };
});
module.exports = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'paris',
    },
  },
  networks: {
    hardhat: {
      // Local EVM chain ID: 31337, ALWAYS (distinct local identity per
      // chain-identity resolution d1eb4c6d). The local EVM must never present
      // itself as 84532 (Base Sepolia). The v4 manifest schema and signature
      // domains accept 31337 for local-test context, so no escape hatch to
      // 84532 is needed — local tests run on 31337 and the deployed surface
      // uses Railway env (84532), never this file.
      chainId: 31337,
      blockGasLimit: 30000000,
    },
  },
  paths: {
    sources: './contracts',
    tests: './scripts',
    artifacts: './build/hardhat-artifacts',
  },
};