// SAAX Protocol — Day 9, Item 2: Self-hosted x402 payment gateway (viem)
//
// Replaces the Nevermined facilitator with a DIRECT Base-Sepolia integration.
// No third-party facilitator. The SAAX Protocol operator controls verification and
// settlement. The full flow:
//
//   402 challenge  ->  PAYMENT-REQUIRED header (base64 JSON) with network,
//                      asset, payTo (seller wallet), amount, facilitator:"self",
//                      scheme:"exact"
//   payment        ->  PAYMENT-SIGNATURE header (base64 JSON) carrying the
//                      EIP-3009 transferWithAuthorization signed by the buyer
//                      over the x402 EIP-712 domain + message
//   verify         ->  EIP-712 typed-data signature recovery (viem
//                      verifyTypedData); binds signer, recipient, amount,
//                      scheme, network, asset, validity window, nonce
//   settle         ->  AFTER routing logic succeeds, broadcast the signed
//                      transferWithAuthorization to Base Sepolia via
//                      wallet.sendRawTransaction using the signed authorization
//                      (seller wallet pays gas); wait for 1 confirmation
//   receipt        ->  PAYMENT-RESPONSE header { transactionHash, status:"settled" }
//
// SELECTION: SAAX_X402_MODE=self (new) vs mock (existing). Default mock keeps the
// existing local-testing lane (no wallet needed). When SAAX_X402_MODE=self, the
// gateway requires the seller wallet (SAAX_SELLER_PRIVATE_KEY) to be provisioned.
//
// SECURITY GATES (payment layer — all inherited and enforced here):
//   - Every field of the signed authorization is type-checked and bound.
//   - The signature must recover to authorization.from (EIP-712 typed-data).
//   - to must equal the seller wallet (payTo), value must equal the required
//     amount (raw 6-dp units), scheme exact, network eip155:84532, asset the
//     Base Sepolia USDC contract.
//   - validAfter/validBefore window is enforced against wall clock.
//   - nonce reuse is rejected via the nonce-bound idempotency store (Item 4).
//   - Nothing in a payment payload is ever executed/evaluated/echoed.
//   - Trade secrets (ranking weights, outcome data, seller key) never leave the
//     process; only plan/transaction metadata is emitted in headers.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  encodeAbiParameters,
  parseAbiParameters,
  verifyTypedData,
  toHex,
  keccak256,
  toBytes,
  hexToBigInt,
  isAddress,
  getAddress,
  fallback,
} = require('viem');
const commitmentStore = require('./commitment-store.js');
const easMod = require('./eas.js');

// ---- Chain / asset constants --------------------------------------------------
// Base Sepolia (caip-2 eip155:84532). USDC contract per Circle's published
// testnet list (developers.circle.com/stablecoins/usdc-contract-addresses):
//   0x036CbD53842c5426634e7929541eC2318f3dCF7e
// ---------------------------------------------------------------------------
// Active chain / asset selection (MAINNET ACTIVATION, Day 14).
// The gateway is chain-selectable via env (defaults: Base Sepolia testnet):
//   SAAX_CHAIN_ID        84532 (Base Sepolia) | 8453 (Base mainnet)
//   SAAX_NETWORK       local | base-sepolia (explicit intent; local EVM uses a DISTINCT
//                        chain ID 31337, never 84532)
//   SAAX_X402_ASSET      USDC contract for the active chain
//   SAAX_RPC_URL         RPC endpoint for the active chain
//   SAAX_NETWORK_CAIP2   caip-2 network id (defaults to eip155:<CHAIN_ID>)
// The exported names BASE_SEPOLIA_* / baseSepolia are LEGACY ALIASES that
// resolve to the ACTIVE chain, so every consumer (route-server, harness,
// rails) follows the .env switch without further edits. Mainnet USDC
// (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) implements EIP-3009; the
// dual-path probe selects transferWithAuthorization automatically.
const BASE_SEPOLIA_CHAIN_ID = 84532;   // legacy name; ACTIVE_CHAIN_ID below is used
const USDC_BASE_SEPOLIA_ADDR = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // legacy testnet USDC
const USDC_MAINNET_BASE_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ACTIVE_CHAIN_ID = Number(process.env.SAAX_CHAIN_ID || 84532);
const ACTIVE_ASSET = String(process.env.SAAX_X402_ASSET || (
  ACTIVE_CHAIN_ID === 8453 ? USDC_MAINNET_BASE_ADDR : USDC_BASE_SEPOLIA_ADDR
)).trim();
const ACTIVE_RPC = String(process.env.SAAX_RPC_URL || (
  ACTIVE_CHAIN_ID === 8453 ? 'https://mainnet.base.org' : 'https://sepolia.base.org'
)).trim();
// Alternate RPCs for the ACTIVE chain. Public RPCs (mainnet.base.org) rate-limit
// burst callers; the settlement path (nonce + gas + send) can trip a 429. Use a
// fallback transport so broadcasts retry through alternates instead of failing.
const ACTIVE_RPC_FALLBACKS = ACTIVE_CHAIN_ID === 8453
  ? ['https://base-rpc.publicnode.com', 'https://base.drpc.org']
  : [];
const ACTIVE_RPCS = [ACTIVE_RPC, ...ACTIVE_RPC_FALLBACKS];
const builtTransport = ACTIVE_RPCS.length > 1
  ? fallback(ACTIVE_RPCS.map(u => http(u)))
  : http(ACTIVE_RPC);
const ACTIVE_NETWORK_CAIP2 = String(
  process.env.SAAX_NETWORK_CAIP2 || ('eip155:' + ACTIVE_CHAIN_ID)
).trim();
// Active chain object (resolves the RPC + native currency per chain).
const baseSepolia = defineChain({
  id: ACTIVE_CHAIN_ID,
  name: ACTIVE_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
  network: ACTIVE_CHAIN_ID === 8453 ? 'base' : 'base-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ACTIVE_RPC] },
  },
  blockExplorers: {
    default: { name: 'BaseScan', url: ACTIVE_CHAIN_ID === 8453 ? 'https://basescan.org' : 'https://base-sepolia.blockscout.com' },
  },
});
// Legacy aliases (exported; consumed by route-server, harness, mpp rail).
const NETWORK_CAIP2_BASE_SEPOLIA = ACTIVE_NETWORK_CAIP2;
const USDC_BASE_SEPOLIA = ACTIVE_ASSET;
const USDC_DECIMALS = 6;
// EIP-712 token domain exposed in accepts[].extra. A standard x402 exact-scheme
// client (mppx / x402 SDK) requires extra.name + extra.version to construct the
// EIP-3009 signature; without them createCredential throws
// "x402 exact EIP-3009 requires token name and version." Base mainnet USDC
// reports name()="USD Coin"; Base Sepolia reports name()="USDC" (version "2"
// on both). assetTransferMethod pins the exact-scheme transfer to EIP-3009.
const ACTIVE_TOKEN_DOMAIN = ACTIVE_CHAIN_ID === 8453
  ? { name: 'USD Coin', version: '2' }
  : { name: 'USDC', version: '2' };
function acceptedExtra() {
  // Wire extra MUST match what clients echo into accepted.extra AND what
  // Circle /verify compares: paymentPayload.accepted.extra ===
  // paymentRequirements.extra. Plain {name, version} (token registry) is the
  // exact contract (proven against Circle /verify: clean extra -> VALID;
  // anything extra/missing -> invalid_payment_requirements).
  return {
    name: ACTIVE_TOKEN_DOMAIN.name,
    version: ACTIVE_TOKEN_DOMAIN.version,
  };
}

// DUAL-PATH (Day 10, mainnet readiness): the settlement signature scheme is
// selected ON-CHAIN per asset+chain — probe the token contract for the
// EIP-3009 transferWithAuthorization function selector:
//   - selector PRESENT -> EIP-3009 path: verify + broadcast a single
//     transferWithAuthorization (e.g. Base MAINNET USDC).
//   - selector ABSENT  -> EIP-2612 path: verify Permit, broadcast permit then
//     transferFrom (e.g. Base SEPOLIA USDC = FiatTokenV2, verified on-chain
//     Day 9 via probe-usdc-state.js + probe-permit-semantics.js).
// Every settlement logs which path was selected, with the selector evidence.
// Default is 'auto' (probe); override with SAAX_X402_SIGNATURE_PATH.
// permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
const PERMIT_SELECTOR = '0xd505accf';
// transferFrom(address from,address to,uint256 value) — spender pulls the funds
const TRANSFER_FROM_SELECTOR = '0x23b872dd';

// ---- EIP-3009 selectors + types (dual-path, Day 10) --------------------------
// The transferWithAuthorization selector is DERIVED from the canonical ABI
// signature at runtime (keccak-256 first 4 bytes) so there is no magic
// constant to drift: EIP-3009
//   transferWithAuthorization(address from,address to,uint256 value,uint256
//     validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)
// The same derivation runs in scripts/probe-signature-path.js and produces the
// evidence logged per settlement.
const { slice } = require('viem');
const TRANSFER_WITH_AUTH_SIG =
  'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)';
const TWA_SELECTOR = slice(keccak256(toHex(TRANSFER_WITH_AUTH_SIG)), 0, 4);

// EIP-712 typed-data types for the EIP-3009 TransferWithAuthorization struct.
// Domain is the standard token EIP-712 domain (name/version/chainId/
// verifyingContract) — the same domain used for EIP-2612 Permit on the same
// contract. NOTE: the EIP-3009 struct nonce is bytes32, unlike the EIP-2612
// uint256 counter — both are validated and signed exactly per their spec.
const EIP3009_TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// ---- Signature-path selection config ------------------------------------------
// SAAX_X402_SIGNATURE_PATH: 'auto' (default; on-chain probe per asset+chain,
// cached) | 'eip3009' (force transferWithAuthorization path) | 'eip2612'
// (force permit path). The force flags exist so MAINNET activation can pin
// the EIP-3009 path without waiting on a probe, and so tests can exercise
// either branch deterministically. Never auto-probe mainnet without the
// override documented in day7-wallet-checklist.md §mainnet.
const PATH_ENV = 'SAAX_X402_SIGNATURE_PATH';
const PATH_TTL_MS = Number(process.env.SAAX_SIGNATURE_PATH_TTL_SECONDS || 600) * 1000;
const _pathCache = new Map(); // key asset|chainId -> { path, evidence, ts }

// ---- Mode selection ------------------------------------------------------------
// SAAX_X402_MODE: 'mock' (default) | 'self' (self-hosted gateway).
function getMode() {
  return String(process.env.SAAX_X402_MODE || 'mock').trim().toLowerCase();
}
function setMode(m) { process.env.SAAX_X402_MODE = m; }
const MODE = getMode();

// ---- Config ---------------------------------------------------------------------
// Hot wallet + cold vault architecture (Day 13):
//   - SIGNER  (SAAX_SIGNER_PRIVATE_KEY / SAAX_SIGNER_ADDRESS) = HOT wallet.
//     Broadcasts settlement transactions (permit, transferFrom,
//     transferWithAuthorization) and pays gas. Holds minimal balance.
//   - VAULT   (SAAX_VAULT_ADDRESS) = COLD storage. NEVER the direct settlement
//     recipient nor an authorized payee for any buyer payment (Day 19d);
//     funded only by post-settlement manual sweeps from the signer. Operator's
//     Ledger-derived address; never holds a key in this process.
//   - SELLER  (SAAX_SELLER_*) = LEGACY. Retained for backward compatibility
//     and diagnostics only; no longer used in the settlement path.
const SELLER_KEY_ENV = 'SAAX_SELLER_PRIVATE_KEY';
const SELLER_ADDR_ENV = 'SAAX_SELLER_ADDRESS';
const SIGNER_KEY_ENV = 'SAAX_SIGNER_PRIVATE_KEY';
const SIGNER_ADDR_ENV = 'SAAX_SIGNER_ADDRESS';
const VAULT_ADDR_ENV = 'SAAX_VAULT_ADDRESS';
const DEFAULT_FEE_USD = Number(process.env.SAAX_ROUTING_FEE_USD || 0.05);
const DEFAULT_MSAAX_TIMEOUT_SECONDS = 60;

let _viemProbe = null; // memoized { publicClient, walletClient } after first use

function loadSellerKey() {
  const k = String(process.env[SELLER_KEY_ENV] || '').trim();
  if (!k) return null;
  return k.startsWith('0x') ? k : '0x' + k;
}

function getSellerAddress() {
  const addr = String(process.env[SELLER_ADDR_ENV] || '').trim();
  if (addr && isAddress(addr)) return getAddress(addr);
  return null;
}

// ---- Hot wallet (Signer) loaders ----
function loadSignerKey() {
  const k = String(process.env[SIGNER_KEY_ENV] || '').trim();
  if (!k) return null;
  return k.startsWith('0x') ? k : '0x' + k;
}

function getSignerAddress() {
  const addr = String(process.env[SIGNER_ADDR_ENV] || '').trim();
  if (addr && isAddress(addr)) return getAddress(addr);
  return null;
}

// ---- Cold storage (Vault) loader ----
function getVaultAddress() {
  const addr = String(process.env[VAULT_ADDR_ENV] || '').trim();
  if (addr && isAddress(addr)) return getAddress(addr);
  return null;
}

// Day 15 (Option B): the OPERATIVE payee is the signer (hot wallet) whose key
// exists in the environment. The vault remains configured as cold storage but
// is never the advertised payTo nor the direct settlement recipient. This
// accessor is the single source of truth for the advertised payee across the
// challenge, the accepts[0].payTo field, and the settlement destination, so
// the live challenge and the Circle seller proof always agree on payTo.
function getOperativePayee() {
  return getSignerAddress() || getVaultAddress() || getSellerAddress() || null;
}

// Public + wallet clients (created lazily; the wallet client pays gas for the
// transferWithAuthorization broadcast �?� mandatory in EIP-3009: the 'to' holder
// submits the signed authorization). The broadcaster is the HOT SIGNER wallet
// (SAAX_SIGNER_PRIVATE_KEY), not the seller. The seller key is legacy.
function clients() {
  if (_viemProbe) return _viemProbe;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: builtTransport });
  let walletClient = null;
  const key = loadSignerKey() || loadSellerKey(); // signer (hot) preferred; seller legacy fallback
  if (key) {
    const { privateKeyToAccount } = require('viem/accounts');
    const account = privateKeyToAccount(key);
    walletClient = createWalletClient({ account, chain: baseSepolia, transport: builtTransport });
  }
  _viemProbe = { publicClient, walletClient, account: walletClient ? walletClient.account : null };
  return _viemProbe;
}

// ---- Dual-path on-chain probe (Day 10) ----------------------------------------
// Probe the token contract's CODE for the transferWithAuthorization function
// selector (0xe3ee160e — derived from the EIP-3009 9-arg ABI signature above)
// — the EIP-3009 entry point. Returns the selected path
// + the selector evidence. Cached per asset|chainId for PATH_TTL_MS.
async function probeSignaturePath({ asset, chainId, force }) {
  const key = String(asset || USDC_BASE_SEPOLIA).toLowerCase() + '|' + String(chainId || BASE_SEPOLIA_CHAIN_ID);
  const cached = _pathCache.get(key);
  if (cached && !force && Date.now() - cached.ts < PATH_TTL_MS) return { path: cached.path, evidence: cached.evidence, cached: true };

  // If the token was explicitly pinned by the operator (env override), honor
  // it WITHOUT an RPC probe (mainnet privacy: no premature mainnet reads).
  const pinned = String(process.env[PATH_ENV] || '').trim().toLowerCase();
  if (pinned === 'eip3009') {
    const ev = { method: 'env', selector: TWA_SELECTOR, source: 'SAAX_X402_SIGNATURE_PATH=eip3009 (operator pin)', found: true };
    _pathCache.set(key, { path: 'eip3009', evidence: ev, ts: Date.now() });
    return { path: 'eip3009', evidence: ev, cached: false };
  }
  if (pinned === 'eip2612') {
    const ev = { method: 'env', selector: PERMIT_SELECTOR, source: 'SAAX_X402_SIGNATURE_PATH=eip2612 (operator pin)', found: true };
    _pathCache.set(key, { path: 'eip2612', evidence: ev, ts: Date.now() });
    return { path: 'eip2612', evidence: ev, cached: false };
  }

  // On-chain probe: read the contract code and search for the selector bytes.
  const { publicClient } = clients();
  const addr = asset || USDC_BASE_SEPOLIA;
  const code = await publicClient.getCode({ address: addr });
  const hex = code ? code.toLowerCase() : '0x';
  const selectorHex = TWA_SELECTOR.toLowerCase().slice(2);
  // Proxy-aware: ERC-1967 proxies keep the implementation logic at a separate
  // address (implementation()), so the proxy's own code never contains the
  // EIP-3009 selector. Detect the implementation (EIP-1967 slot first, then
  // implementation() call) and scan ITS code for the selector.
  const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  let scanHex = hex;
  let implAddr = null;
  let implDetected = false;
  try {
    const slotVal = await publicClient.getStorageAt({ address: addr, slot: EIP1967_IMPL_SLOT });
    if (slotVal && slotVal !== '0x' && BigInt(slotVal) !== 0n) {
      // Storage slot holds the implementation address right-aligned in 32 bytes
      implAddr = '0x' + slotVal.slice(-40);
      implDetected = true;
    }
  } catch (e) { /* slot read failed — try implementation() */ }
  if (!implAddr) {
    try {
      implAddr = await publicClient.readContract({
        address: addr,
        abi: [{ name: 'implementation', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }],
        functionName: 'implementation',
      });
      implDetected = true;
    } catch (e) { /* not a proxy */ }
  }
  if (implAddr) {
    try {
      const implCode = await publicClient.getCode({ address: implAddr });
      if (implCode) scanHex = implCode.toLowerCase();
    } catch (e) { /* keep proxy hex */ }
  }
  const found = scanHex.includes(selectorHex);
  const evidence = {
    method: 'onchain',
    selector: TWA_SELECTOR,
    selectorHex,
    asset: addr,
    chainId: chainId || ACTIVE_CHAIN_ID,
    codeBytes: scanHex.length > 2 ? (scanHex.length - 2) / 2 : 0,
    proxyImpl: implAddr ? String(implAddr).toLowerCase() : null,
    implDetected,
    found,
    source: implDetected
      ? (found
        ? 'eth_getCode(proxy ' + addr + ') -> implementation ' + implAddr + ' contains transferWithAuthorization selector'
        : 'eth_getCode(proxy ' + addr + ') -> implementation ' + implAddr + ' does NOT contain transferWithAuthorization selector -> EIP-2612 (permit) fallback')
      : (found
        ? 'eth_getCode contains transferWithAuthorization selector'
        : 'eth_getCode does NOT contain transferWithAuthorization selector -> EIP-2612 (permit) fallback'),
  };
  const path = found ? 'eip3009' : 'eip2612';
  _pathCache.set(key, { path, evidence, ts: Date.now() });
  return { path, evidence, cached: false };
}

// Resolve the signature path for an asset (env pin first, else cached probe,
// else live probe). Logger-friendly; never throws on probe failure (falls
// back to EIP-2612 with the probe error in evidence — the conservative path).
async function getSignaturePath({ asset, chainId, force } = {}) {
  try {
    const r = await probeSignaturePath({ asset, chainId, force });
    return { path: r.path, evidence: r.evidence, cached: !!r.cached };
  } catch (e) {
    return {
      path: 'eip2612',
      evidence: { method: 'probe-failed', selector: PERMIT_SELECTOR, source: 'probe error: ' + String(e.message || e).slice(0, 160) + '; conservative EIP-2612 fallback' },
      cached: false,
    };
  }
}

// Short human-readable evidence for log lines (per-settlement path log).
function pathEvidenceForAsset({ asset, chainId } = {}) {
  const key = String(asset || USDC_BASE_SEPOLIA).toLowerCase() + '|' + String(chainId || BASE_SEPOLIA_CHAIN_ID);
  const cached = _pathCache.get(key);
  if (!cached) return { path: 'unknown', evidence: null };
  return { path: cached.path, evidence: cached.evidence };
}

// ---- EIP-712 domain + types for the x402 EIP-3009 authorization ----------------
// The domain is the standard EIP-2612/EIP-3009 token domain (chainId, verifying
// contract, name, version). Parameters verified ON-CHAIN via
// scripts/probe-usdc-domain.js: name "USDC", symbol "USDC", decimals 6,
// version "2", and the EIP-712 DOMAIN_SEPARATOR matches the local keccak
// reconstruction (match: YES). The message is the transferWithAuthorization
// struct per EIP-3009 (from, to, value, validAfter, validBefore, nonce).
//
// The exact EIP-712 recovery is done with viem's verifyTypedData, which
// reconstructs the digest exactly as the token contract's
// DOMAIN_SEPARATOR + transferWithAuthorization would.
//
// CRITICAL (Day 14 mainnet): the EIP-712 domain must match the token's REAL
// on-chain name/version — Base mainnet USDC reports name()="USD Coin" while
// the old hardcoded default was "USDC". Signing/verifying under the wrong name
// produces a valid-looking off-chain verify (both sides use the same wrong
// domain) but the CHAIN recomputes the digest with the real domain and reverts
// with "FiatTokenV2: invalid signature". Resolve name()/version() from the
// chain (cached) and only fall back to the legacy defaults if the reads fail.
const _domainCache = new Map();
async function resolveDomainMeta(assetAddress, chainId) {
  const key = String(assetAddress || USDC_BASE_SEPOLIA).toLowerCase() + '|' + String(chainId || ACTIVE_CHAIN_ID);
  if (_domainCache.has(key)) return _domainCache.get(key);
  const meta = { name: 'USDC', version: '2' }; // legacy fallback
  try {
    const { publicClient } = clients();
    const [name, version] = await Promise.all([
      publicClient.readContract({ address: assetAddress || USDC_BASE_SEPOLIA, abi: [{ name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }], functionName: 'name' }).catch(() => ''),
      publicClient.readContract({ address: assetAddress || USDC_BASE_SEPOLIA, abi: [{ name: 'version', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }], functionName: 'version' }).catch(() => ''),
    ]);
    if (name) meta.name = name;
    if (version) meta.version = version;
  } catch (_) { /* keep fallback */ }
  _domainCache.set(key, meta);
  return meta;
}
async function domainFor(assetAddress, chainId, tokenName, tokenVersion) {
  const resolved = (tokenName && tokenVersion)
    ? { name: tokenName, version: tokenVersion }
    : await resolveDomainMeta(assetAddress, chainId);
  return {
    name: tokenName || resolved.name,
    version: tokenVersion || resolved.version,
    chainId: chainId || ACTIVE_CHAIN_ID,
    verifyingContract: assetAddress || USDC_BASE_SEPOLIA,
  };
}

// FiatTokenV2 EIP-2612 Permit struct — verified ON-CHAIN via
// PERMIT_TYPEHASH = keccak("Permit(address owner,address spender,uint256
// value,uint256 nonce,uint256 deadline)") == 0x6e71edae... (probe-permit-semantics.js).
// Base Sepolia USDC is FiatTokenV2 (permit-only); EIP-3009 selectors are absent.
const EIP3009_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// ---- Wells: parse + validate the PAYMENT-SIGNATURE header ----------------------
// Header carries base64 JSON { version: 2, resource, accepted, payload:
// { signature, authorization: {...} } } — the wire shape from x402 v2 (same
// structural contract x402.js uses, extended with the EIP-3009 fields).
function parsePaymentSignatureHeader(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return { ok: false, payload: null, reason: 'missing PAYMENT-SIGNATURE header' };
  let decoded;
  try { decoded = Buffer.from(raw, 'base64').toString('utf8'); }
  catch (_) { return { ok: false, payload: null, reason: 'header is not valid base64' }; }
  let obj;
  try { obj = JSON.parse(decoded); }
  catch (_) { return { ok: false, payload: null, reason: 'header does not decode to JSON' }; }
  return { ok: true, payload: obj, reason: null };
}

// Build the PAYMENT-REQUIRED header value (base64 JSON) — x402 v2 challenge.
function buildPaymentRequiredHeader({ amountRaw, network, asset, payTo, facilitator, scheme, resource }) {
  // v2 challenge (x402scan registry compatibility): the header payload must
  // declare x402Version: 2 and carry the same accepts[] entry the JSON body
  // carries, so a parser that reads the header first (and chokes on a v1-style
  // flat payload before it ever parses the body) sees a valid x402 v2 response.
  // The flat convenience fields (network/asset/amount/payTo/facilitator/scheme)
  // are retained for backward compatibility with the gateway test contract.
  const accepts = [{
    scheme: 'exact',
    method: 'x402',
    network,
    asset,
    amount: String(amountRaw),
    maxAmountRequired: Number((Number(amountRaw) / Math.pow(10, USDC_DECIMALS)).toFixed(USDC_DECIMALS)),
    payTo,
    resource: { url: resource || 'urn:saax-protocol:route:v1', description: 'SAAX route', mimeType: 'application/json' },
    maxTimeoutSeconds: DEFAULT_MSAAX_TIMEOUT_SECONDS,
    schemes: ['exact', 'upto'],
    extra: acceptedExtra(),
  }];
  const challenge = {
    x402Version: 2,
    network,
    asset,
    amount: String(amountRaw),
    payTo,
    facilitator: facilitator || 'self',
    scheme: scheme || 'exact',
    resource: { url: resource || 'urn:saax-protocol:route:v1', description: 'SAAX route', mimeType: 'application/json' },
    maxTimeoutSeconds: DEFAULT_MSAAX_TIMEOUT_SECONDS,
    accepts,
    extensions: {
      bazaar: {
        schema: {
          properties: {
            input: {
              properties: {
                body: {
                  type: 'object',
                  properties: {
                    capability: { type: 'string', description: 'The capability requested (e.g. security scan).' },
                    budget: { type: 'number', description: 'Maximum budget in USD the caller is willing to pay.' },
                  },
                  required: ['capability'],
                },
              },
            },
            output: {
              properties: {
                example: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    matches: { type: 'array' },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  return Buffer.from(JSON.stringify(challenge)).toString('base64');
}

// ---- Structural validation of the decoded payload ------------------------------
function structurallyValid(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload is not an object' };
  if (payload.version !== undefined && payload.version !== 2 && String(payload.version) !== '2') {
    // tolerate x402Version key too; require 2
    const v = payload.x402Version !== undefined ? payload.x402Version : payload.version;
    if (String(v) !== '2') return { ok: false, reason: 'x402 version must be 2' };
  }
  const accepted = payload.accepted;
  if (!accepted || typeof accepted !== 'object') return { ok: false, reason: 'missing accepted' };
  if (accepted.scheme !== 'exact') return { ok: false, reason: 'scheme must be exact (fixed price)' };
  if (accepted.amount === undefined || accepted.amount === null || !/^\d+$/.test(String(accepted.amount))) {
    return { ok: false, reason: 'accepted.amount must be a numeric string' };
  }
  if (!accepted.asset) return { ok: false, reason: 'missing asset' };
  if (!accepted.network) return { ok: false, reason: 'missing network' };
  if (!accepted.payTo) return { ok: false, reason: 'missing payTo' };
  const p = payload.payload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'missing payload' };
  if (!p.signature || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return { ok: false, reason: 'signature must be 65-byte hex' };
  const auth = p.authorization;
  if (!auth || typeof auth !== 'object') return { ok: false, reason: 'missing authorization' };
  if (!auth.from || !/^0x[a-fA-F0-9]{40}$/.test(auth.from)) return { ok: false, reason: 'authorization.from must be an address' };
  return { ok: true, reason: null };
}

// ---- EIP-712 verification -------------------------------------------------------
// Returns { verified, reason, recoveredAddress, authorization } and NEVER throws
// on a bad signature (returns verified:false with the reason).
async function verifyAuthorization(payload, requirements) {
  const structural = structurallyValid(payload);
  if (!structural.ok) return { verified: false, reason: structural.reason };

  const accepted = payload.accepted;
  const p = payload.payload;
  const auth = p.authorization;

  // ---- Type + range checks on the EIP-3009/EIP-2612 authorization fields
  // (security sprint Item 2). Every field is verified as a typed, bounded
  // value BEFORE it is used in BigInt construction or the EIP-712 digest;
  // anything malformed is rejected here with an explicit reason (never
  // allowed to surface as a confusing verify exception or reach calldata).
  const NUM_STR = /^\d+$/;                 // non-negative integer string
  const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
  if (typeof auth.from !== 'string' || !ADDR_RE.test(auth.from)) {
    return { verified: false, reason: 'authorization.from must be an address' };
  }
  if (auth.to === undefined || auth.to === null || typeof auth.to !== 'string' || !ADDR_RE.test(auth.to)) {
    return { verified: false, reason: 'authorization.to must be an address' };
  }
  if (auth.value === undefined || auth.value === null || !NUM_STR.test(String(auth.value))) {
    return { verified: false, reason: 'authorization.value must be a non-negative integer string' };
  }
  if (auth.validAfter === undefined || auth.validAfter === null ||
      !NUM_STR.test(String(auth.validAfter))) {
    return { verified: false, reason: 'authorization.validAfter must be a non-negative integer string' };
  }
  if (auth.validBefore === undefined || auth.validBefore === null ||
      !NUM_STR.test(String(auth.validBefore))) {
    return { verified: false, reason: 'authorization.validBefore must be a non-negative integer string' };
  }
  // nonce format is PATH-DEPENDENT: EIP-2612 counter = decimal string,
  // EIP-3009 = bytes32 hex. Presence is checked here; the format + range is
  // validated after the signature path is resolved (Day 10 dual-path).
  if (auth.nonce === undefined || auth.nonce === null) {
    return { verified: false, reason: 'authorization.nonce is required' };
  }
  // Range-safety: the EIP-2612 value and the validity window must be sane
  // (reject absurd magnitudes before they reach BigInt/calldata).
  if (String(auth.value).length > 30) {
    return { verified: false, reason: 'authorization.value out of safe range' };
  }
  const va = Number(auth.validAfter), vb = Number(auth.validBefore);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(va) || !Number.isSafeInteger(vb)) {
    return { verified: false, reason: 'authorization validity window out of safe range' };
  }
  if (va > nowSec + 86400) {
    return { verified: false, reason: 'authorization validAfter too far in the future' };
  }
  if (vb > nowSec + 30 * 86400) {
    return { verified: false, reason: 'authorization validBefore too far in the future (max 30 days)' };
  }

  // DUAL-PATH (Day 10): the signed typed-data struct depends on the token's
  // signature scheme, resolved via the on-chain probe (selector evidence) or
  // the operator pin. Both paths use the SAME EIP-712 token domain; only the
  // primary type + message shape + nonce encoding differ.
  //
  //   EIP-3009 path (transferWithAuthorization — e.g. mainnet USDC):
  //     authorization.from        -> struct.from   (the buyer/signer)
  //     authorization.to          -> struct.to     (the seller/gateway)
  //     authorization.value       -> struct.value
  //     authorization.validAfter  -> struct.validAfter
  //     authorization.validBefore -> struct.validBefore
  //     authorization.nonce       -> struct.nonce  (bytes32 hex)
  //
  //   EIP-2612 path (permit — Base Sepolia USDC = FiatTokenV2):
  //     authorization.from        -> permit.owner   (the buyer/signer)
  //     authorization.to          -> permit.spender (the seller/gateway)
  //     authorization.value       -> permit.value
  //     authorization.nonce       -> permit.nonce   (uint256 counter)
  //     authorization.validBefore -> permit.deadline
  //     validAfter enforced locally (start-of-validity, not in the struct).
  const from = String(auth.from || '').toLowerCase();
  const to = String(auth.to || '').toLowerCase();
  // RECIPIENT POLICY (Day 19d, verified from code): the recipient authorized by
  // the signed payment must be the recipient ADVERTISED in the payment
  // requirements for THIS particular payment (requirements.payTo). The vault is
  // cold storage for post-settlement manual sweeps ONLY - it is never an
  // authorized recipient for a direct buyer payment, and a global list of known
  // addresses (vault/signer/seller) must not substitute for per-payment
  // authorization. The signer is the advertised payee in the live path
  // (getOperativePayee() is signer-first), so it is covered by requirements.payTo.
  // Fallback to the legacy seller address ONLY when no payTo was supplied
  // (offline/standalone callers that historically omitted it).
  const expectedToSet = [requirements.payTo]
    .filter(Boolean).map(a => String(a).toLowerCase());
  const expectedTo = expectedToSet.length ? expectedToSet : [String(getSellerAddress() || '').toLowerCase()];
  if (!/^0x[a-f0-9]{40}$/.test(from)) return { verified: false, reason: 'authorization.from must be an address' };
  if (!/^0x[a-f0-9]{40}$/.test(to)) return { verified: false, reason: 'authorization.to must be an address' };
  if (expectedTo.length && !expectedTo.includes(to)) return { verified: false, reason: 'recipient binding violated: to != advertised payee (requirements.payTo)' };
  if (String(to).toLowerCase() === String(from).toLowerCase()) return { verified: false, reason: 'self-transfer forbidden' };

  // Resolve the signature path for this asset+chain (probe/pin; cached).
  const chainId = parseChainId(accepted.network);
  const pathResult = await getSignaturePath({ asset: accepted.asset, chainId });
  const sigPath = pathResult.path;
  let recovered = null;         // recovered signer (== authorization.from when verified)
  let lastPathEvidence = null;  // selector evidence for the per-settlement log

  if (sigPath === 'eip3009') {
    // ---- EIP-3009 (transferWithAuthorization) verification ------------------
    // nonce is bytes32: must be a 0x + 64 hex string. validAfter/validBefore
    // are part of the signed struct (unlike EIP-2612 where validAfter is
    // local-only) — both are already numeric-string validated above; the
    // struct carries validAfter directly.
    if (!/^0x[a-fA-F0-9]{64}$/.test(String(auth.nonce))) {
      return { verified: false, reason: 'authorization.nonce must be a bytes32 hex string (EIP-3009)' };
    }
    const twaMsg = {
      from,
      to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce, // bytes32 (hex string → viem encodes directly)
    };
    try {
      const ok = await verifyTypedData({
        address: from,
        types: EIP3009_TRANSFER_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: twaMsg,
        domain: await domainFor(accepted.asset, chainId),
        signature: p.signature,
      });
      if (!ok) return { verified: false, reason: 'signature does not verify for authorization.from (EIP-3009)' };
    } catch (e) {
      return { verified: false, reason: 'signature verification failed (EIP-3009): ' + String(e.message || e).slice(0, 160) };
    }
    recovered = from;
    // Path evidence for the per-settlement log.
    lastPathEvidence = pathResult.evidence;
  } else {
    // ---- EIP-2612 (permit) verification — the Base Sepolia path -------------
    if (!NUM_STR.test(String(auth.nonce))) {
      return { verified: false, reason: 'authorization.nonce must be a non-negative integer string (EIP-2612 counter)' };
    }
    const permitMsg = {
      owner: from,
      spender: to,
      value: BigInt(auth.value),
      nonce: BigInt(auth.nonce),          // EIP-2612 counter (uint256)
      deadline: BigInt(auth.validBefore), // permit deadline = validBefore
    };
    try {
      const ok = await verifyTypedData({
        address: from,
        types: EIP3009_TYPES,
        primaryType: 'Permit',
        message: permitMsg,
        domain: await domainFor(accepted.asset, chainId),
        signature: p.signature,
      });
      if (!ok) return { verified: false, reason: 'signature does not verify for authorization.from' };
    } catch (e) {
      return { verified: false, reason: 'signature verification failed: ' + String(e.message || e).slice(0, 160) };
    }
    recovered = from;
    // Path evidence for the per-settlement log.
    lastPathEvidence = pathResult.evidence;
  }

  // 2. Amount binding — value must equal the required raw amount (checked as
  //    string equality on the validated numeric string; no coercion surprises).
  const requiredAmount = String(requirements.amount || (requirements.usd ? rawUnits(requirements.usd) : ''));
  if (!requiredAmount) return { verified: false, reason: 'no required amount supplied' };
  if (String(auth.value) !== requiredAmount) {
    return { verified: false, reason: 'value mismatch: authorization.value ' + auth.value + ' != required ' + requiredAmount };
  }

  // 3. Scheme/network/asset binding.
  if (accepted.scheme !== 'exact') return { verified: false, reason: 'scheme must be exact' };
  if (String(accepted.network) !== String(requirements.network)) {
    return { verified: false, reason: 'network mismatch: ' + accepted.network + ' != ' + requirements.network };
  }
  if (String(accepted.asset).toLowerCase() !== String(requirements.asset).toLowerCase()) {
    return { verified: false, reason: 'asset mismatch: ' + accepted.asset + ' != ' + requirements.asset };
  }

  // 4. Validity window — validAfter <= now < deadline (wall clock, seconds).
  const now = Math.floor(Date.now() / 1000);
  const validAfter = Number(auth.validAfter);
  const deadline = Number(auth.validBefore);
  if (!Number.isFinite(validAfter) || !Number.isFinite(deadline)) {
    return { verified: false, reason: 'authorization validity window malformed' };
  }
  if (validAfter > deadline) return { verified: false, reason: 'authorization window inverted (validAfter > validBefore)' };
  if (now < validAfter) return { verified: false, reason: 'authorization not yet valid (validAfter in future)' };
  if (now >= deadline) return { verified: false, reason: 'authorization expired (validBefore passed)' };

  // 5. Nonce format re-check (path-aware). EIP-2612 = decimal counter;
  //    EIP-3009 = bytes32 hex (already validated in the path branch above).
  if (sigPath === 'eip2612') {
    if (!NUM_STR.test(String(auth.nonce))) {
      return { verified: false, reason: 'authorization.nonce must be a non-negative integer (EIP-2612 counter)' };
    }
  }

  return { verified: true, reason: null, recoveredAddress: recovered, authorization: auth, signaturePath: sigPath, pathEvidence: lastPathEvidence };
}

// ---- Nonce hash -> idempotency key (Item 4) ------------------------------------
// Deterministic, replay-safe: the same nonce always maps to the same key, so a
// re-presented signed authorization under a fresh request identifier collides
// with the settled/pending row and cannot double-charge.
function nonceIdempotencyKey(nonce) {
  const raw = String(nonce || '').toLowerCase();
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  return 'nnonce:' + digest;
}

// ---- Settlement ----------------------------------------------------------------
// Broadcast the signed transferWithAuthorization to Base Sepolia. The SELLER
// wallet (authorization.to) submits and pays gas (EIP-3009).
// Wait for 1 confirmation after the tx is mined.
async function settleAuthorization(auth, signature, { confirmations = 1 } = {}) {
  // ---- Untrusted-field revalidation (security sprint Item 4). The settlement
  // path re-checks EVERY field immediately before broadcast, independent of
  // the verification layer, so a caller that skips verify (or a race between
  // verify and settle) can never broadcast a tampered authorization. The
  // seller can only ever be induced to pay gas for the exact verified permit
  // + transferFrom of the verified amount to itself — no arbitrary approvals
  // or third-party recipients (gas-abuse prevention).
  const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
  const NUM_STR = /^\d+$/;
  if (!auth || typeof auth !== 'object') throw new Error('settlement: missing authorization');
  if (typeof auth.from !== 'string' || !ADDR_RE.test(auth.from)) throw new Error('settlement: from must be an address');
  if (typeof auth.to !== 'string' || !ADDR_RE.test(auth.to)) throw new Error('settlement: to must be an address');
  if (!NUM_STR.test(String(auth.value)) || String(auth.value).length > 30) throw new Error('settlement: value must be a bounded non-negative integer string');
  if (!NUM_STR.test(String(auth.validBefore))) throw new Error('settlement: validBefore must be a non-negative integer string');
  if (!NUM_STR.test(String(auth.validAfter))) throw new Error('settlement: validAfter must be a non-negative integer string');
  // nonce format is PATH-DEPENDENT: EIP-2612 decimal counter vs EIP-3009
  // bytes32 hex. Validate per the resolved signature path below (Day 10).
  // Hot wallet + cold vault (Day 13): the authorized recipient set is the
  // VAULT (EIP-3009 direct transfer destination) and the SIGNER (EIP-2612
  // permit spender / broadcaster). The Vault is pinned as the transferFrom
  // pull destination in the 2612 calldata, so USDC always lands in cold
  // storage regardless of which address broadcasts.
  const vault = getVaultAddress();
  const signer = getSignerAddress();
  const authorizedTo = [vault, signer].filter(Boolean).map(a => a.toLowerCase());
  if (authorizedTo.length && !authorizedTo.includes(String(auth.to).toLowerCase())) {
    throw new Error('settlement: recipient is not an authorized wallet (to != vault/signer)');
  }
  if (String(auth.from).toLowerCase() === String(auth.to).toLowerCase()) {
    throw new Error('settlement: self-transfer forbidden');
  }
  const vb = Number(auth.validBefore), va = Number(auth.validAfter);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(va) || !Number.isSafeInteger(vb)) throw new Error('settlement: validity window out of range');
  if (va > vb) throw new Error('settlement: validity window inverted');
  if (now < va) throw new Error('settlement: authorization not yet valid');
  if (now >= vb) throw new Error('settlement: authorization expired');

  // Test seam (Item 5 harness, no-funds mode): SAAX_GATEWAY_DRY_RUN=1 returns a
  // marked synthetic receipt WITHOUT touching the chain. The dry-run marker in
  // the txHash ('dryrun_') makes it unambiguous in logs that no real tx was
  // broadcast. The real broadcast path below is untouched by this flag.
  if (process.env.SAAX_GATEWAY_DRY_RUN === '1') {
    return {
      txHash: 'dryrun_' + crypto.randomUUID(),
      blockNumber: '0',
      status: 'settled',
      dryRun: true,
    };
  }
  const { publicClient, walletClient, account } = clients();
  if (!walletClient || !account) {
    throw new Error('self-hosted settlement requires SAAX_SIGNER_PRIVATE_KEY (signer wallet pays gas)');
  }

  // ---- Dual-path settlement dispatch (Day 10) -----------------------------
  // Resolve the signature path (probe/pin; cached). EIP-3009 (selector
  // present): a SINGLE transferWithAuthorization broadcast moves the funds.
  // EIP-2612 (selector absent — Base Sepolia FiatTokenV2): permit +
  // transferFrom, the tested Day 9 rail. The path + selector evidence rides
  // on the receipt and is logged per settlement.
  const sigPath = (await getSignaturePath({ asset: USDC_BASE_SEPOLIA, chainId: ACTIVE_CHAIN_ID })).path;
  const pathInfo = await getSignaturePath({ asset: USDC_BASE_SEPOLIA, chainId: ACTIVE_CHAIN_ID });
  if (sigPath === 'eip3009') {
    if (!/^0x[a-fA-F0-9]{64}$/.test(String(auth.nonce))) {
      throw new Error('settlement: nonce must be a bytes32 hex string (EIP-3009)');
    }
    const r = await settleEip3009(auth, signature, { confirmations });
    r.signaturePath = 'eip3009';
    r.pathEvidence = pathInfo.evidence;
    return r;
  }
  // EIP-2612 (permit + transferFrom)
  if (!NUM_STR.test(String(auth.nonce)) || String(auth.nonce).length > 30) {
    throw new Error('settlement: nonce must be a bounded non-negative integer string (EIP-2612 counter)');
  }
  const r = await settleEip2612(auth, signature, { confirmations });
  r.signaturePath = 'eip2612';
  r.pathEvidence = pathInfo.evidence;
  return r;
}

// ---- EIP-2612 settlement: broadcast the signed Permit, then transferFrom ----
// Base Sepolia FiatTokenV2 rail (Day 9 tested). The seller wallet pays gas for
// both steps. Returns { txHash, permitTxHash, blockNumber, status }.
async function settleEip2612(auth, signature, { confirmations = 1 } = {}) {
  const { publicClient, walletClient, account } = clients();
  if (!walletClient || !account) {
    throw new Error('self-hosted settlement requires SAAX_SIGNER_PRIVATE_KEY (signer wallet pays gas)');
  }
  const owner = String(auth.from).toLowerCase();   // permit.owner / transferFrom.from
  const spender = String(auth.to).toLowerCase();   // permit.spender == the signer (broadcaster)
  // Day 15 (Option B): settlement destination is the SIGNER (hot wallet) —
  // the transferFrom `to` argument below resolves to the signer so USDC lands
  // in the signer's wallet. The vault stays configured as cold storage and is
  // funded by manual sweeps from the signer; it is never the direct
  // settlement recipient in this process.
  const vaultDest = (getSignerAddress() || '').toLowerCase() || spender;
  const valueRaw = auth.value;
  const deadline = auth.validBefore;

  // Step 1 — broadcast the signed Permit (owner authorizes spender). EIP-2612
  // permits may be submitted by ANYONE (the spender pays gas), which fits the
  // self-hosted model: the seller wallet pays gas for both steps.
  // FiatTokenV2 permit(owner,spender,value,deadline,v,r,s) — 8 args, NO nonce:
  // the contract reads nonces[owner] from storage. The EIP-712 SIGNED struct
  // includes nonce (Permit(owner,spender,value,nonce,deadline)); the CALDATA
  // does not.
  const permitCalldata = encodeAbiParameters(
    parseAbiParameters('address,address,uint256,uint256,uint8,bytes32,bytes32'),
    [
      owner,
      spender,
      BigInt(valueRaw),
      BigInt(deadline),
      parseInt(signature.slice(130, 132), 16), // v
      ('0x' + signature.slice(2, 66)),         // r
      ('0x' + signature.slice(66, 130)),       // s
    ]
  );

  const permitTxData = PERMIT_SELECTOR + permitCalldata.slice(2);
  const permitReq = await walletClient.prepareTransactionRequest({
    account,
    to: USDC_BASE_SEPOLIA,
    data: permitTxData,
    chain: baseSepolia,
  });
  let permitTxHash;
  try {
    permitTxHash = await walletClient.sendTransaction(permitReq);
  } catch (e) {
    throw new Error('permit broadcast failed: ' + String(e.message || e).slice(0, 200));
  }
  // Wait for permit confirmation (1 block).
  let permitReceipt = null;
  for (let i = 0; i < 40; i++) {
    try {
      permitReceipt = await publicClient.getTransactionReceipt({ hash: permitTxHash });
      if (permitReceipt && permitReceipt.blockNumber) break;
    } catch (_) { /* not mined yet */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!permitReceipt || !permitReceipt.blockNumber) {
    throw new Error('permit submitted but not confirmed in time: ' + permitTxHash);
  }
  if (permitReceipt.status !== 'success') {
    throw new Error('permit transaction reverted: ' + permitTxHash);
  }

    // Step 2 — transferFrom(owner, spender, value): the spender (seller) pulls
    // the permitted amount into its own wallet. Same gas payer (seller).
  // HARDENING (Day 9 live): the RPC node may serve a slightly stale allowance
  // view right after the permit confirms (eventual consistency). Poll
  // allowance[owner][spender] until it is >= value (or timeout), then send the
  // transferFrom. This eliminates the intermittent "transfer amount exceeds
  // allowance" estimate failure seen when broadcast followed confirm too fast.
  const allowAbi = [{ name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  let allowanceReady = false;
  for (let i = 0; i < 12; i++) {
    try {
      const allow = await publicClient.readContract({ address: USDC_BASE_SEPOLIA, abi: allowAbi, functionName: 'allowance', args: [owner, spender] });
      if (allow >= BigInt(valueRaw)) { allowanceReady = true; break; }
    } catch (_) { /* retry */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!allowanceReady) {
    throw new Error('settlement allowance not visible after permit broadcast (permit allowed=' + allowanceReady + '); aborting before transferFrom');
  }
  const pullCalldata = encodeAbiParameters(
    parseAbiParameters('address,address,uint256'),
    [owner, vaultDest, BigInt(valueRaw)]
  );
  const pullTxData = TRANSFER_FROM_SELECTOR + pullCalldata.slice(2);
  const pullReq = await walletClient.prepareTransactionRequest({
    account,
    to: USDC_BASE_SEPOLIA,
    data: pullTxData,
    chain: baseSepolia,
  });
  let pullTxHash;
  try {
    pullTxHash = await walletClient.sendTransaction(pullReq);
  } catch (e) {
    throw new Error('transferFrom broadcast failed: ' + String(e.message || e).slice(0, 200));
  }
  // Wait for transferFrom confirmation.
  let pullReceipt = null;
  for (let i = 0; i < 40; i++) {
    try {
      pullReceipt = await publicClient.getTransactionReceipt({ hash: pullTxHash });
      if (pullReceipt && pullReceipt.blockNumber) break;
    } catch (_) { /* not mined yet */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!pullReceipt || !pullReceipt.blockNumber) {
    throw new Error('transferFrom submitted but not confirmed in time: ' + pullTxHash);
  }
  if (pullReceipt.status !== 'success') {
    throw new Error('transferFrom transaction reverted: ' + pullTxHash);
  }
  // Return the transferFrom tx hash as THE settlement receipt (the funds moved
  // in this transaction); the permit's hash is recorded as permitTxHash.
  return {
    txHash: pullTxHash,
    permitTxHash,
    blockNumber: String(pullReceipt.blockNumber),
    status: 'settled',
  };
}

// ---- EIP-3009 settlement: broadcast transferWithAuthorization (single tx) ----
// EIP-3009: the 'to' holder (seller) submits the signed authorization and pays
// gas; the transfer moves from->to directly (no allowance step). Returns
// { txHash, blockNumber, status }.
async function settleEip3009(auth, signature, { confirmations = 1 } = {}) {
  const { publicClient, walletClient, account } = clients();
  if (!walletClient || !account) {
    throw new Error('self-hosted settlement requires SAAX_SIGNER_PRIVATE_KEY (signer wallet pays gas)');
  }
  const owner = String(auth.from).toLowerCase();
  const spender = String(auth.to).toLowerCase();
  const valueRaw = auth.value;
  // transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)
  const calldata = encodeAbiParameters(
    parseAbiParameters('address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32'),
    [
      owner,
      spender,
      BigInt(valueRaw),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,                              // bytes32 hex (already validated)
      parseInt(signature.slice(130, 132), 16), // v
      ('0x' + signature.slice(2, 66)),         // r
      ('0x' + signature.slice(66, 130)),       // s
    ]
  );
  const txData = TWA_SELECTOR + calldata.slice(2);
  const req = await walletClient.prepareTransactionRequest({
    account,
    to: USDC_BASE_SEPOLIA,
    data: txData,
    chain: baseSepolia,
  });
  let txHash;
  try {
    txHash = await walletClient.sendTransaction(req);
  } catch (e) {
    throw new Error('transferWithAuthorization broadcast failed: ' + String(e.message || e).slice(0, 200));
  }
  let receipt = null;
  for (let i = 0; i < 40; i++) {
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt && receipt.blockNumber) break;
    } catch (_) { /* not mined yet */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!receipt || !receipt.blockNumber) {
    throw new Error('transferWithAuthorization submitted but not confirmed in time: ' + txHash);
  }
  if (receipt.status !== 'success') {
    throw new Error('transferWithAuthorization transaction reverted: ' + txHash);
  }
  return {
    txHash,
    blockNumber: String(receipt.blockNumber),
    status: 'settled',
  };
}

// ---- Challenge constructor (PAYMENT-REQUIRED) ----------------------------------
function buildChallenge({ amountUsd, payTo, network, asset }) {
  const amountRaw = rawUnits(amountUsd === undefined ? DEFAULT_FEE_USD : amountUsd);
  // Day 15 (Option B): the challenge advertises the SIGNER as payTo (the
  // payee). The vault stays configured as cold storage but is never the
  // advertised payee nor the direct settlement recipient. Falls back to the
  // signer address (whose key exists in the environment) and then seller.
  const signer = getSignerAddress() || '';
  const vault = payTo || signer;
  const net = network || NETWORK_CAIP2_BASE_SEPOLIA;
  const ass = asset || USDC_BASE_SEPOLIA;
  return {
    error: '402 Payment Required',
    x402Version: 2,
    scheme: 'x402',
    network: net,
    asset: ass,
    payTo: vault,
    amount: amountRaw,
    facilitator: 'self',
    scheme: 'exact',
    maxTimeoutSeconds: DEFAULT_MSAAX_TIMEOUT_SECONDS,
    resource: {
      url: 'urn:saax-protocol:route:v1',
      description: 'SAAX route',
      mimeType: 'application/json',
    },
    accepts: [{
      scheme: 'exact',
      method: 'x402',
      network: net,
      asset: ass,
      amount: amountRaw,
      maxAmountRequired: Number((Number(amountRaw) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS)),
      payTo: vault,
      resource: 'urn:saax-protocol:route:v1',
      schemes: ['exact', 'upto'],
      maxTimeoutSeconds: DEFAULT_MSAAX_TIMEOUT_SECONDS,
      description: 'SAAX route',
      extra: acceptedExtra(),
    }],
  };
}

// Fee helper (same API as x402.rawUnits).
function rawUnits(usdAmount) {
  return String(Math.round(Number(usdAmount) * 10 ** USDC_DECIMALS));
}

// ---- Nonce storage for the gateway (in-process fallback + injected store) ------
// The gateway keeps its own nonce->{status,response} map so replay protection
// works even when the PostgREST store is not configured (test/offline mode).
const nonceStore = new Map(); // nonceLower -> { status: 'settled'|'pending'|'failed', response?... }
// ---- Durable nonce backing (reliability audit) ------------------------------
// The in-process Map above is the fast path; a durable store (file-backed in
// the no-Supabase fallback) is the restart-safe authority. setNonce() writes
// through to both; getNonce() prefers the durable record when it exists so a
// settled nonce is still rejected after a process restart (F-3). The wire
// guard semantics are unchanged. Single-writer topology — see the design doc.
let _durableNonceStore = null;
function setNonceStore(store) { _durableNonceStore = store; }
function getNonceStore() { return _durableNonceStore; }
// Bound the in-process nonce map (memory-DoS guard, security sprint Item 4):
// cap the number of retained entries and evict the oldest settled/failed ones
// beyond that. Pending entries are never evicted (they are in-flight), but a
// settled entry older than the cap is safe to drop — its replay protection is
// already durably enforced by the nonce-bound idempotency store.
const NONCE_STORE_MAX = 100000;
function setNonce(nonce, status, response) {
  if (nonceStore.size >= NONCE_STORE_MAX && !nonceStore.has(String(nonce).toLowerCase())) {
    const oldest = nonceStore.keys().next().value;
    nonceStore.delete(oldest);
  }
  const key = String(nonce).toLowerCase();
  const record = { status, response: response || null };
  nonceStore.set(key, record);
  if (_durableNonceStore) {
    try {
      _durableNonceStore.update('nonce:' + key, status, null, null, { nonce: key, status, response: response || null });
    } catch (_) { /* durable write failure is logged by the store layer; fast path still works */ }
  }
}
function getNonce(nonce) {
  const key = String(nonce).toLowerCase();
  const fast = nonceStore.get(key);
  if (fast) return fast;
  if (_durableNonceStore) {
    const row = _durableNonceStore.get('nonce:' + key);
    if (row && row.meta && row.meta.status) {
      return { status: row.meta.status, response: row.meta.response || null, recovered: true };
    }
  }
  return null;
}
function clearNonces() { nonceStore.clear(); }

// ---- Header names (documented contract) ----------------------------------------
const HEADERS = {
  PAYMENT_REQUIRED: 'payment-required',
  PAYMENT_SIGNATURE: 'payment-signature',
  PAYMENT_RESPONSE: 'payment-response',
};

function parseChainId(network) {
  const m = /^eip155:(\d+)$/.exec(String(network || ''));
  return m ? Number(m[1]) : ACTIVE_CHAIN_ID;
}

// ============================================================================
// DAY 11, ITEM 4 — RAIL-AGNOSTIC COMMITMENT LIFECYCLE WIRING
// ----------------------------------------------------------------------------
// The gateway now issues a GOVERENED COMMITMENT (Trade Manifest) BEFORE any
// payment challenge, and a SETTLEMENT-METHOD-NEUTRAL requirement R derived
// from it. The settlement method S that realises R is resolved at execution
// time through the rail registry — x402 is no longer mandatory.
//
//   request -> manifest (commitment) -> R (neutral) -> 402 (x402 + mpp
//   challenges) -> credential -> rail.validate(R) -> route -> rail.settle()
//   -> Spend Receipt (commitment <-> railReference)
//
// The modules below are leaf modules (no require-back into gateway.js), so
// this wiring cannot create a circular-require trap.
const commitmentMod = require('./commitment.js');
const requirementMod = require('./requirement.js');
const receiptMod = require('./receipt.js');
const railsMod = require('./rails/index.js');

// Commitment-flow facade consumed by route-server.js. Also proves the schema,
// R issuance, registry and receipt modules load and expose their interfaces.
let _commitmentPersistPending = Promise.resolve();

const commitmentFlow = {
  // Issue the governed commitment from a demand payload, then issue exactly
  // one settlement-method-neutral requirement R derived from it.
  async issueFromPayload({ buyer, seller, capability, deadline, amountRaw, currency, buyerEmail, commitmentIdOverride, idempotencyKey }) {
    const manifest = commitmentMod.buildManifest({
      commitmentId: commitmentIdOverride || commitmentStore.deterministicCommitmentId(commitmentStore.commitmentScopeFromKey(idempotencyKey || '')),
      buyerAgentId: buyer,
      sellerAgentId: seller,
      capability,
      price: { amount: String(amountRaw), currency: currency || 'USDC', decimals: 6 },
      acceptanceCriteria: { type: 'hash', value: 'sha256:saax-protocol-phase1' },
      deadline,
      cancelCondition: 'buyer-cancel-before-delivery',
    });
    const R = requirementMod.issueRequirement({
      commitmentId: manifest.commitmentId,
      payee: seller,
      amt: String(manifest.price.amount),
      cur: manifest.price.currency,
      ttlSeconds: 300,
    });
    // Enforce the manifest binding at ISSUE time too: R must carry exactly the
    // manifest's amount + currency (critical rule: a spend bound to a manifest
    // is denied when amount or currency differs).
    const binding = commitmentMod.checkSpendBinding(manifest, { amount: R.amt, currency: R.cur });
    if (!binding.ok) {
      throw new Error('commitment flow: R diverged from manifest: ' + binding.reason);
    }
    // EAS anchor: bind the canonical manifest digest to a deterministic,
    // independently-verifiable attestation on Base. MOCK-SAFE by default
    // (SAAX_EAS_MODE=mock -> derives UID, no network write); live mode
    // broadcasts the EAS attest transaction. The anchor is ADDITIVE: an EAS
    // failure must never change the issuance return contract, so it is
    // caught and surfaced as `anchorError` (routing proceeds exactly as
    // before). The anchor record is carried in terms.anchor so the receipt
    // and the independent verifier can resolve it without trusting the DB.
    let anchor = null;
    let anchorError = null;
    try {
      // Synchronous deterministic anchor (mock mode) — never blocks issuance
      // and never performs a network write unless SAAX_EAS_MODE=live (then the
      // live broadcast is handled separately by the caller's EAS flow).
      anchor = easMod.buildAnchorRecord({
        commitmentId: manifest.commitmentId,
        commitmentDigest: manifest.manifestHash, // canonical digest of the signed manifest
        parties: JSON.stringify({ buyer: manifest.buyerAgentId, seller: manifest.sellerAgentId }),
        requestedOutcome: JSON.stringify({ description: manifest.capability, category: 'capability' }),
        providerObligation: JSON.stringify({ description: manifest.capability }),
        commercialTerms: JSON.stringify(manifest.price || {}),
        paymentTerms: JSON.stringify({ amount: String(manifest.price.amount), currency: manifest.price.currency, asset: null }),
        acceptanceCriteria: JSON.stringify([manifest.acceptanceCriteria || {}]),
        deadline: manifest.deadline,
        failureConditions: JSON.stringify([{ condition: 'provider_obligation_unfulfilled' }]),
        recoveryPolicy: JSON.stringify({ maxRetries: 0, refundOnFailure: false }),
        refundsCompensation: JSON.stringify({}),
        lifecycleState: 'issued',
      });
    } catch (e) {
      anchorError = String(e.message || e).slice(0, 200);
    }
    // Persist the commitment to Supabase — STRICT and awaited (F-4). A
    // commitment that is not durably recorded must NOT be presented as
    // successful creation: the result is returned as `persist` and
    // route-server fails closed when ok !== true. The deterministic ID +
    // PK upsert make the retry reconcile to the SAME row (no duplicate).
    let persist = { ok: false, retryable: false, error: "persistence not attempted" };
    try {
      persist = await commitmentStore.persistCommitment({
        commitmentId: manifest.commitmentId,
        state: 'issued',
        capability: manifest.capability,
        buyerEmail: buyerEmail || null,
        terms: {
          price: manifest.price,
          deadline: manifest.deadline,
          acceptanceCriteria: manifest.acceptanceCriteria,
          cancelCondition: manifest.cancelCondition,
          buyerAgentId: manifest.buyerAgentId,
          sellerAgentId: manifest.sellerAgentId,
          ...(anchor ? { anchor } : {}),
        },
        authorityRef: null,
        evidenceRefs: [],
        settlementRef: null,
        manifestHash: manifest.manifestHash,
      });
    } catch (e) {
      persist = { ok: false, retryable: true, error: "persistence threw: " + String(e.message || e).slice(0, 200) };
    }

    // Keep the issued record so a later additive write can replay the FULL
    // row (upsert_commitment overwrites every column on conflict).
    _issuedRecord = {
      commitmentId: manifest.commitmentId, state: 'issued', capability: manifest.capability,
      buyerEmail: buyerEmail || null,
      terms: { price: manifest.price, deadline: manifest.deadline, acceptanceCriteria: manifest.acceptanceCriteria, cancelCondition: manifest.cancelCondition, buyerAgentId: manifest.buyerAgentId, sellerAgentId: manifest.sellerAgentId, ...(anchor ? { anchor } : {}) },
      authorityRef: null, evidenceRefs: [], manifestHash: manifest.manifestHash,
    };

    return { manifest, requirement: R, anchor, anchorError, persist };
  },

  // Persist the post-settlement linkage (additive, full-row replay).
  // Returns the store result; never throws — the response contract of the
  // settlement path is unchanged.
  async persistSettlementRef(manifest, txRef, targetCommitmentId) {
    if (!manifest || !txRef || !txRef.txHash) return { ok: false, error: 'manifest and txHash are required' };
    const rec = _issuedRecord || null;
    if (!rec) return { ok: false, error: 'no issued record retained for ' + manifest.commitmentId };
    const writeId = targetCommitmentId || rec.commitmentId;
    try {
      const result = await commitmentStore.persistSettlementRef({
        commitmentId: writeId, state: rec.state, capability: rec.capability,
        buyerEmail: rec.buyerEmail, terms: rec.terms, authorityRef: rec.authorityRef,
        evidenceRefs: rec.evidenceRefs, manifestHash: rec.manifestHash,
        settlementRef: { txHash: txRef.txHash, rail: txRef.rail || 'x402' },
      });
      if (result && !result.ok) {
        console.error('[commitment-flow] persistSettlementRef store error:', result.error);
      }
      return result;
    } catch (e) {
      console.error('[commitment-flow] persistSettlementRef error (non-fatal):', e.message);
      return { ok: false, error: e.message };
    }
  },

  // Consume the R nonce on successful gate commit (single-use, replay-rejected).
  consumeRequirement(R) {
    if (!R || !R.eta) return { ok: false, reason: 'no requirement eta provided' };
    return requirementMod.consumeNonce(R.eta);
  },

  requirementStatus(nonce) { return requirementMod.nonceStatus(nonce); },

  // Build the Spend Receipt binding the settlement (railReference) to the
  // commitment. NEVER receives the credential — only the public tx reference.
  buildSpendReceipt({ manifest, R, txRef, settledAt }) {
    const shape = {
      commitmentId: (manifest && manifest.commitmentId) || (R && R.commitmentId) || '',
      manifestHash: (manifest && manifest.manifestHash) || null,
      payer: txRef && txRef.payer,
      payee: (txRef && txRef.payee) || (R && R.payee),
      amount: (txRef && txRef.amount) || (R && R.amt) || '',
      currency: (txRef && txRef.currency) || (R && R.cur) || '',
      rail: (txRef && txRef.rail) || 'x402',
      railReference: txRef && txRef.railReference,
      settledAt: settledAt || new Date().toISOString(),
      noManifest: !manifest, // spend not bound to a verified manifest -> true
    };
    return receiptMod.buildReceipt(shape);
  },
};

// ---- Circle Facilitator Service: keyless-trial seller proof (Day 15) ---------
// Circle's keyless trial authenticates with a seller proof: an EIP-712
// signature from the key controlling payTo, sent as the
// `Facilitator-Seller-Proof` header (base64url envelope). No API key is
// required for /verify on the keyless trial path. The proof binds the request
// to a specific purpose and body; `purpose` must match the route ("verify")
// and `network`/`payTo` must equal the request body's
// paymentRequirements.network/payTo or Circle returns HTTP 401.
// Spec: developers.circle.com/facilitator-service/sign-seller-proof
const CIRCLE_FACILITATOR_BASE = process.env.CIRCLE_VERIFY_URL || 'https://api.circle.com/v1/facilitator';
const SELLER_PROOF_DOMAIN_NAME = 'Circle Facilitator Seller Request';
const SELLER_PROOF_DOMAIN_VERSION = '1';
const SELLER_PROOF_TTL_SECONDS = 300; // expiresAt <= issuedAt + 5min (spec)

// Build the EIP-712 SellerRequest signature + base64url envelope that proves
// control of payTo to Facilitator Service. The private key is
// SAAX_SIGNER_PRIVATE_KEY (the signer/hot wallet — the operative payee).
// Returns { header, envelope, signed } or throws.
async function buildSellerProof({
  purpose = 'verify',        // 'verify' | 'settle' | 'status'
  method = 'POST',           // uppercase HTTP method of the request
  bodyHash,                  // keccak256(toBytes(body)); GET hashes empty bytes
  network,                   // CAIP-2, e.g. 'eip155:8453' (Base mainnet)
  payTo,                     // the operative payee (signer) — must equal paymentRequirements.payTo
  nonce,                     // optional bytes32 hex; defaults to random 32 bytes
  issuedAt,                  // optional unix seconds; defaults to now
  expiresAt,                 // optional unix seconds; defaults to issuedAt + 300
}) {
  const key = loadSignerKey() || loadSellerKey();
  if (!key) {
    throw new Error('seller proof requires SAAX_SIGNER_PRIVATE_KEY (signer key controlling payTo)');
  }
  if (!network) throw new Error('seller proof requires network (CAIP-2)');
  if (!payTo || !isAddress(payTo)) throw new Error('seller proof requires a valid payTo address');
  const chainId = Number(String(network).split(':')[1]);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error('seller proof: cannot derive chainId from network ' + network);
  }
  const { privateKeyToAccount } = require('viem/accounts');
  const account = privateKeyToAccount(key);
  if (String(account.address).toLowerCase() !== String(payTo).toLowerCase()) {
    // Fail closed: signing with a key that does not control the advertised
    // payTo would produce a proof Circle rejects with HTTP 401. Never do that.
    throw new Error(
      'seller proof key mismatch: signer ' + account.address + ' != payTo ' + payTo
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const issued = issuedAt || now;
  const expires = expiresAt || (issued + SELLER_PROOF_TTL_SECONDS);
  const nonceHex = nonce || toHex(crypto.randomBytes(32));
  const digest = bodyHash || keccak256(toBytes(''));
  const domain = {
    name: SELLER_PROOF_DOMAIN_NAME,
    version: SELLER_PROOF_DOMAIN_VERSION,
    chainId,
  };
  const types = {
    SellerRequest: [
      { name: 'purpose', type: 'string' },
      { name: 'method', type: 'string' },
      { name: 'bodyHash', type: 'bytes32' },
      { name: 'network', type: 'string' },
      { name: 'payTo', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'issuedAt', type: 'uint64' },
      { name: 'expiresAt', type: 'uint64' },
    ],
  };
  const message = {
    purpose,
    method,
    bodyHash: digest,
    network,
    payTo: getAddress(payTo),
    nonce: nonceHex,
    issuedAt: BigInt(issued),
    expiresAt: BigInt(expires),
  };
  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: 'SellerRequest',
    message,
  });
  const envelope = {
    version: 1,
    signature,
    network: message.network,
    payTo: message.payTo,
    nonce: message.nonce,
    issuedAt: Number(message.issuedAt),
    expiresAt: Number(message.expiresAt),
  };
  const header = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  return { header, envelope, signed: true };
}

// Call Circle's /verify endpoint with the keyless-trial seller proof and
// return Circle's verdict verbatim. FAIL-CLOSED: any error (network, timeout,
// HTTP 4xx/5xx, malformed body) rejects the payment — SAAX never falls back
// to its own self-verification. The gateway's verifyAuthorization is retained
// for offline/self tests only; the live payment path uses this client.
async function circleVerifyPayment(paymentPayload, paymentRequirements) {
  // CIRCLE_MOCK (Option A, fail-closed seam): short-circuits ONLY the Circle
  // network call. The caller (route-server) runs SAAX's structural checks
  // (verifyAuthorization) BEFORE invoking this, so a structurally invalid
  // payload never reaches the mock. The mock fabricates acceptance only for
  // a payload that already passed SAAX's own checks. LIVE PATH (flag unset)
  // calls Circle /verify and fails closed on any error.
  if (process.env.CIRCLE_MOCK === '1') {
    return {
      verified: true,
      reason: null,
      payer: (paymentPayload && paymentPayload.authorization && paymentPayload.authorization.from) || null,
      invalidReason: null,
      verifier: 'circle-mock',
    };
  }
  const body = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };
  const rawBody = JSON.stringify(body);
  const proof = await buildSellerProof({
    purpose: 'verify',
    method: 'POST',
    bodyHash: keccak256(toBytes(rawBody)),
    network: (paymentRequirements && paymentRequirements.network) || ACTIVE_NETWORK_CAIP2,
    payTo: (paymentRequirements && paymentRequirements.payTo) || getOperativePayee(),
  });
  let res;
  try {
    res = await fetch(CIRCLE_FACILITATOR_BASE + '/x402/verify', {
      method: 'POST',
      headers: {
        'Facilitator-Seller-Proof': proof.header,
        'Content-Type': 'application/json',
      },
      body: rawBody,
    });
  } catch (e) {
    throw new Error('circle /verify unreachable (fail-closed): ' + String(e.message || e).slice(0, 200));
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json).slice(0, 300) : text.slice(0, 300);
    throw new Error('circle /verify HTTP ' + res.status + ' (fail-closed): ' + detail);
  }
  if (!json || typeof json.isValid !== 'boolean') {
    throw new Error('circle /verify malformed response (fail-closed): ' + text.slice(0, 300));
  }
  return {
    verified: json.isValid,
    reason: json.isValid ? null : (json.invalidReason || 'circle_invalid'),
    payer: json.payer || null,
    invalidReason: json.invalidReason || null,
    verifier: 'circle',
  };
}

module.exports = {
  /** Await the most recent issuance persistence (serverless durability). */
  awaitCommitmentPersistence() {
    return _commitmentPersistPending;
  },
  commitmentFlow,
  commitmentMod,
  requirementMod,
  receiptMod,
  railsMod,
  MODE,
  ACTIVE_CHAIN_ID,
  ACTIVE_ASSET,
  ACTIVE_TOKEN_DOMAIN,
  acceptedExtra,
  BASE_SEPOLIA_CHAIN_ID,
  NETWORK_CAIP2_BASE_SEPOLIA,
  USDC_BASE_SEPOLIA,
  USDC_DECIMALS,
  PERMIT_SELECTOR,
  TRANSFER_FROM_SELECTOR,
  TRANSFER_WITH_AUTH_SIG,
  TWA_SELECTOR,
  EIP3009_TYPES,
  EIP3009_TRANSFER_TYPES,
  PATH_ENV,
  probeSignaturePath,
  getSignaturePath,
  pathEvidenceForAsset,
  SELLER_KEY_ENV,
  SELLER_ADDR_ENV,
  SIGNER_KEY_ENV,
  SIGNER_ADDR_ENV,
  VAULT_ADDR_ENV,
  DEFAULT_FEE_USD,
  DEFAULT_MSAAX_TIMEOUT_SECONDS,
  getMode,
  setMode,
  loadSellerKey,
  getSellerAddress,
  loadSignerKey,
  getSignerAddress,
  getVaultAddress,
  getOperativePayee,
  buildSellerProof,
  circleVerifyPayment,
  clients,
  domainFor,
  EIP3009_TYPES,
  parsePaymentSignatureHeader,
  buildPaymentRequiredHeader,
  buildChallenge,
  structurallyValid,
  verifyAuthorization,
  nonceIdempotencyKey,
  settleAuthorization,
  rawUnits,
  nonceStore,
  setNonce,
  setNonceStore,
  getNonceStore,
  getNonce,
  clearNonces,
  HEADERS,
  parseChainId,
  baseSepolia,
};