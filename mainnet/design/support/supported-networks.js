// supported-networks.js — repository-owned explicit supported-network policy
// for finality adapters, worker startup/configuration, the v4 candidate
// verifier, and admission controls.
//
// PURPOSE (E1 closure):
//   SAAX's target mainnet is Base chain 8453. Ethereum chain 1 is a SEPARATE
//   unsupported mainnet. Finality support must be restricted by an EXPLICIT
//   supported-network policy — never by assuming "not chain 1" means testnet.
//   A chain is supported for a finality policy class ONLY when it is on the
//   explicit allowlist for that class; anything else (including chain 8453,
//   chain 1, and arbitrary chains) is rejected.
//
// POLICY CLASSES (explicit):
//   - 'local'            : chain 31337 only. Local synthetic confirmations.
//                          local-confirmations policy; NEVER public finality.
//   - 'public-testnet'   : chain 84532 (Base Sepolia) ONLY. Configured
//                          public-testnet op-stack-safe/op-stack-finalized
//                          finality checks are permitted.
//   - 'mainnet'          : chains 1 and 8453 are RECOGNIZED mainnets and are
//                          EXPLICITLY BLOCKED for finality in this checkpoint
//                          (FINALITY_MAINNET_NOT_ACTIVATED / UNSUPPORTED_NETWORK).
//   - 'unsupported'      : any other chain. Rejected.
//
// CHAIN ID CONSTANTS (documented, never exported-owned):
const CHAIN_LOCAL_TEST = 31337;      // local EVM / hardhat (explicit local-test-only)
const CHAIN_BASE_SEPOLIA = 84532;    // Base public testnet (configured public checks)
const CHAIN_ETHEREUM = 1;            // Ethereum mainnet — separate unsupported mainnet
const CHAIN_BASE_MAINNET = 8453;     // SAAX target mainnet — BLOCKED under current authorization

const LOCAL_TEST_CHAINS = new Set([CHAIN_LOCAL_TEST]);
const PUBLIC_TESTNET_CHAINS = new Set([CHAIN_BASE_SEPOLIA]);
const MAINNET_CHAINS = new Set([CHAIN_ETHEREUM, CHAIN_BASE_MAINNET]);
// Every chain the repository recognizes at all (for error-message precision).
const KNOWN_CHAINS = new Set([...LOCAL_TEST_CHAINS, ...PUBLIC_TESTNET_CHAINS, ...MAINNET_CHAINS]);

/**
 * Classify a chain id into a policy class.
 * @param {number|string} chainId
 * @returns {'local'|'public-testnet'|'mainnet'|'unsupported'}
 */
function classifyChain(chainId) {
  const n = Number(chainId);
  if (LOCAL_TEST_CHAINS.has(n)) return 'local';
  if (PUBLIC_TESTNET_CHAINS.has(n)) return 'public-testnet';
  if (MAINNET_CHAINS.has(n)) return 'mainnet';
  return 'unsupported';
}

/**
 * Assert a chain is supported for the given finality policy surface.
 * Fail-closed: unknown chain or unsupported combination throws with a precise
 * reason. Used by constructor/startup paths so an unsupported network can
 * NEVER reach a finality observation.
 *
 * @param {number|string} chainId
 * @param {object} opts
 * @param {string} [opts.surface] name for the error message (adapter/worker/verifier)
 * @param {boolean} [opts.allowPublicTests] when true, permit public-testnet
 *   chains for op-stack-* policies (operator/trusted configuration).
 * @throws Error with one of:
 *   FINALITY_NETWORK_UNSUPPORTED:<chain> (not a recognized chain)
 *   FINALITY_MAINNET_NOT_ACTIVATED:<chain> (recognized mainnet, blocked)
 */
function assertSupportedNetwork(chainId, opts = {}) {
  const n = Number(chainId);
  const surface = opts.surface || 'finality';
  const cls = classifyChain(n);
  if (cls === 'mainnet') {
    throw new Error('FINALITY_MAINNET_NOT_ACTIVATED:' + n + (surface ? ':' + surface : ''));
  }
  if (cls === 'unsupported') {
    throw new Error('FINALITY_NETWORK_UNSUPPORTED:' + n + (surface ? ':' + surface : ''));
  }
  return cls;
}

/**
 * Public policy (op-stack-safe / op-stack-finalized) chain gate: returns the
 * policy class only when the chain is permitted to run public checks.
 * - chain 31337 -> 'local'      (local-synthetic only; PUBLIC_NOT_ACTIVATED elsewhere)
 * - chain 84532 -> 'public-testnet' (configured public checks permitted)
 * - mainnet / unsupported -> throws (FINALITY_MAINNET_NOT_ACTIVATED /
 *   FINALITY_NETWORK_UNSUPPORTED)
 */
function assertPublicFinalityChain(chainId, opts = {}) {
  const n = Number(chainId);
  const surface = opts.surface || 'finality';
  const cls = classifyChain(n);
  if (cls === 'mainnet') {
    throw new Error('FINALITY_MAINNET_NOT_ACTIVATED:' + n + (surface ? ':' + surface : ''));
  }
  if (cls === 'unsupported') {
    throw new Error('FINALITY_NETWORK_UNSUPPORTED:' + n + (surface ? ':' + surface : ''));
  }
  // 'local' chain with a public policy: the caller decides whether that is a
  // downgrade (refused by the adapter's own local gate). Return the class so
  // the caller can produce the precise reason.
  return cls;
}

/**
 * Local-synthetic policy (local-confirmations) chain gate: chain 31337 ONLY.
 * @throws FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337:chain=<n>
 */
function assertLocalConfirmationsChain(chainId, opts = {}) {
  const n = Number(chainId);
  const surface = opts.surface || 'finality';
  if (classifyChain(n) !== 'local') {
    throw new Error('FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337:chain=' + n + (surface ? ':' + surface : ''));
  }
  return 'local';
}

module.exports = {
  CHAIN_LOCAL_TEST,
  CHAIN_BASE_SEPOLIA,
  CHAIN_ETHEREUM,
  CHAIN_BASE_MAINNET,
  LOCAL_TEST_CHAINS,
  PUBLIC_TESTNET_CHAINS,
  MAINNET_CHAINS,
  KNOWN_CHAINS,
  classifyChain,
  assertSupportedNetwork,
  assertPublicFinalityChain,
  assertLocalConfirmationsChain,
};