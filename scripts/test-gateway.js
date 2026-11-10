// SAAX Protocol â€” Day 9, Item 5: Self-hosted x402 gateway end-to-end test harness
//
// Simulates the full buyer flow against a spawned route-server in SELF mode:
//   402 challenge -> EIP-3009 signature -> verify -> routing -> settle -> receipt
//
// Modes:
//   - Default: SAAX_GATEWAY_DRY_RUN=1 â€” settlement broadcasts are simulated
//     (dryrun_ txHash); verifies the ENTIRE pipeline with zero real funds.
//   - SAAX_GATEWAY_DRY_RUN unset + funded wallets: real broadcast to Base Sepolia
//     (testnet USDC only; seller must hold ETH for gas, buyer testnet USDC).
//
// Scenarios (brief):
//   T1  402 challenge without payment header â€” correct PAYMENT-REQUIRED header
//   T2  Valid EIP-3009 authorization -> routing executes + settle broadcasts
//       + PAYMENT-RESPONSE receipt header
//   T3  Replay the SAME signature = same nonce -> rejected/cached, NO double charge
//   T4  Invalid signature (wrong signer) -> 402, no routing
//   T5  Expired authorization (validBefore in the past) -> 402, no routing
//   T6  Nonce-bound idempotency: same nonce under a FRESH request key still
//       collides (replay-safe key derivation, Item 4)
//   T7  Day 8 rate limit: 61 requests/min -> 61st returns 429 BEFORE verification
//   T8  Day 8 kill switch: SAAX_KILL_SWITCH=true -> 503, zero RPC calls
//   T9  Buyer reputation: signer recovery from the payment signature resolves
//       (mock-registry offline path when no on-chain identity)
//
// Each step logs: 402 -> token/signature -> verify -> routing -> settle -> receipt.
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  createPublicClient,
  createWalletClient,
  http: viemHttp,
  verifyTypedData,
  keccak256,
  toHex,
} = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
// Load .env BEFORE requiring the gateway: the gateway bakes ACTIVE_CHAIN_ID /
// ACTIVE_ASSET from process.env at require time. If we require it first, the
// module freezes at Sepolia defaults even when SAAX_CHAIN_ID=8453 is in .env,
// and every domain/signature built against the local gateway object mismatches
// the (correctly mainnet-wired) server child.
const gateway = require('../endpoint/gateway.js');

const PORT = Number(process.env.SAAX_TEST_PORT || 8611);
const USE_DRY_RUN = process.env.SAAX_GATEWAY_DRY_RUN !== '0'; // default dry-run
const SHOW_BUYER = process.argv.includes('--show-buyer-address');

let failures = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
};

function request(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: PORT, method, path: pathname, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await request('GET', '/health', {}, null);
      if (r.status === 200) return;
    } catch (_) { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

// ---- Sign an EIP-2612 Permit (FiatTokenV2) over the REAL gateway domain ----
// Base Sepolia USDC is FiatTokenV2 (permit-only, verified on-chain). The
// x402 wire authorization maps to the Permit struct: from=owner, to=spender
// (seller), value, nonce (uint256 counter), validBefore=deadline. validAfter
// is enforced server-side as the start-of-validity wall clock.
// Active signature path (Day 14 mainnet): resolved once up-front from the
// gateway's dual-path probe/pin. eip3009 = Base MAINNET USDC
// (transferWithAuthorization, bytes32 nonce, to=vault); eip2612 = Base
// Sepolia FiatTokenV2 (Permit, uint256 counter).
let ACTIVE_SIG_PATH = 'eip2612';

// EIP-2612 Permit message (FiatTokenV2-style). from=owner, to=spender (the
// signer/broadcaster), nonce = uint256 counter, validBefore=deadline.
function eip2612Message(buyerAccount, signerAddress, valueRaw, { validAfter, validBefore, nonce }) {
  return {
    owner: buyerAccount.address.toLowerCase(),
    spender: signerAddress.toLowerCase(),
    value: BigInt(valueRaw),
    nonce: BigInt(nonce),
    deadline: BigInt(validBefore),
  };
}

// EIP-3009 TransferWithAuthorization message (Base MAINNET USDC). from =
// buyer, to = VAULT (the direct transfer destination), nonce = bytes32 hex,
// validAfter/validBefore are signed fields.
function eip3009Message(buyerAccount, vaultAddress, valueRaw, { validAfter, validBefore, nonce }) {
  return {
    from: buyerAccount.address.toLowerCase(),
    to: vaultAddress.toLowerCase(),
    value: BigInt(valueRaw),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce, // bytes32 hex (0x + 64 hex)
  };
}

async function signAuthorization(buyerAccount, recipientAddress, valueRaw, domain, { validAfter, validBefore, nonce }) {
  const wallet = createWalletClient({ account: buyerAccount, chain: gateway.baseSepolia, transport: viemHttp() });
  if (ACTIVE_SIG_PATH === 'eip3009') {
    const message = eip3009Message(buyerAccount, recipientAddress, valueRaw, { validAfter, validBefore, nonce });
    const signature = await wallet.signTypedData({
      domain,
      types: gateway.EIP3009_TRANSFER_TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
    });
    return { message, signature };
  }
  const message = eip2612Message(buyerAccount, recipientAddress, valueRaw, { validAfter, validBefore, nonce });
  const signature = await wallet.signTypedData({
    domain,
    types: gateway.EIP3009_TYPES,
    primaryType: 'Permit',
    message,
  });
  return { message, signature };
}

function buildPaymentSignaturePayload({ signature, authorization }) {
  const payload = {
    x402Version: 2,
    resource: { url: 'urn:saax-protocol:route:v1', description: 'SAAX Protocol demand routing', mimeType: 'application/json' },
    accepted: {
      scheme: 'exact',
      network: gateway.NETWORK_CAIP2_BASE_SEPOLIA,
      amount: String(authorization.value),
      asset: gateway.USDC_BASE_SEPOLIA,
      payTo: authorization.to,
      maxTimeoutSeconds: 60,
    },
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// Map a signed Permit message back to the x402 wire authorization shape the
// gateway expects: { from=owner, to=spender, value, validAfter, validBefore,
// nonce (uint256 counter as decimal string) }.
function wireAuth(message, validAfter, validBefore) {
  if (ACTIVE_SIG_PATH === 'eip3009') {
    return {
      from: message.from,
      to: message.to,
      value: String(message.value),
      validAfter: String(message.validAfter),
      validBefore: String(message.validBefore),
      nonce: message.nonce,
    };
  }
  return {
    from: message.owner,
    to: message.spender,
    value: String(message.value),
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce: String(message.nonce),
  };
}

function decodeGatewayReceipt(headerValue) {
  if (!headerValue) return null;
  try { return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')); }
  catch (_) { return null; }
}

(async () => {
  console.log('========== SAAX Protocol â€” DAY 14: SELF-HOSTED x402 GATEWAY E2E ==========');
  console.log('mode: ' + (USE_DRY_RUN ? 'DRY RUN (no real broadcast; SAAX_GATEWAY_DRY_RUN=1)' : 'LIVE BROADCAST (USDC; wallets must be funded)'));
  console.log('active chain id:', gateway.BASE_SEPOLIA_CHAIN_ID, '(SAAX_CHAIN_ID=' + (process.env.SAAX_CHAIN_ID || '84532 (default testnet)') + ')');
  console.log('active asset:', gateway.USDC_BASE_SEPOLIA);
  console.log('active network:', gateway.NETWORK_CAIP2_BASE_SEPOLIA);
  console.log('signer address (hot wallet, broadcasts):', gateway.getSignerAddress() || '(none â€” check .env SAAX_SIGNER_ADDRESS)');
  console.log('vault address (cold storage, receives):', gateway.getVaultAddress() || '(none â€” check .env SAAX_VAULT_ADDRESS)');
  console.log('signer key loaded:', !!gateway.loadSignerKey());
  const domain = await gateway.domainFor();
  // Resolve the active signature path (dual-path probe/pin) BEFORE scenarios.
  try {
    const pathInfo = await gateway.getSignaturePath({ asset: gateway.USDC_BASE_SEPOLIA, chainId: gateway.BASE_SEPOLIA_CHAIN_ID });
    ACTIVE_SIG_PATH = pathInfo.path;
    console.log('signature path:', ACTIVE_SIG_PATH, '(' + (pathInfo.evidence && pathInfo.evidence.source || '') + ')');
  } catch (e) {
    console.log('WARN could not resolve signature path (default eip2612): ' + String(e.message || e).slice(0, 80));
  }

  // ---- Buyer (test-only) -----------------------------------------------------
  // Stable buyer: reuse SAAX_TEST_BUYER_KEY (env or .env) when present so a funded
  // address persists across runs. Default: fresh random key (dry-run only).
  const buyerPk = process.env.SAAX_TEST_BUYER_KEY || generatePrivateKey();
  const buyerAccount = privateKeyToAccount(buyerPk);
  if (SHOW_BUYER) {
    if (!process.env.SAAX_TEST_BUYER_KEY) {
      // No stable key yet: mint one, persist it, and print the fundable address.
      const key = generatePrivateKey();
      fs.appendFileSync(path.join(__dirname, '..', '.env'), '\nSAAX_TEST_BUYER_KEY=' + key + '\n');
      const acc = privateKeyToAccount(key);
      console.log('generated new test buyer key -> saved to .env as SAAX_TEST_BUYER_KEY');
      console.log('buyer address (stable, fund this):', acc.address);
    } else {
      console.log('buyer address (stable, fund this):', buyerAccount.address);
    }
    process.exit(0);
  }
  console.log('buyer (test-only) address:', buyerAccount.address);

  // ---- Spawn the server in SELF mode ----------------------------------------
  const env = {
    ...process.env,
    SAAX_PORT: String(PORT),
    SAAX_X402_MODE: 'self',
    SAAX_GATEWAY_DRY_RUN: USE_DRY_RUN ? '1' : '0',
    SAAX_RATE_LIMIT_STORE: 'memory',
    SAAX_IDEMPOTENCY_STORE: 'memory', // isolate each test run from persistent rows
  };
  const child = spawn(process.execPath, [path.join('endpoint', 'route-server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = path.join(__dirname, '..', 'daily-logs', 'day9-live-server.log');
  child.stdout.on('data', c => { try { fs.appendFileSync(serverLog, String(c)); } catch (_) {} });
  const stderrLog = path.join(__dirname, '..', 'daily-logs', 'day9-settle-stderr.log');
  child.stderr.on('data', c => { try { fs.appendFileSync(stderrLog, String(c)); } catch (_) {} });

  // Option B (Day 15 closeout): the operative payee is the SIGNER. The
  // vault stays configured as cold storage (manual sweeps), never the direct
  // settlement recipient. Both signature paths sign `to` = signer.
  const signerAddress = gateway.getSignerAddress() || gateway.getVaultAddress() || gateway.getSellerAddress();
  const vaultAddress = gateway.getVaultAddress();
  const authRecipient = signerAddress; // Option B: operative payee = signer (both signature paths)
  const amountRaw = gateway.rawUnits(0.05); // $0.05 USDC, 6 dp
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ capability: 'security scan', budget: 500, deadline: '2026-10-08' });

  // ---- EIP-2612 permit nonce counter (live mode) --------------------------
  // The buyer's on-chain nonces[owner] increments by 1 per successful permit.
  // In live mode the T2/T6/T9 permits must use the CURRENT counter, so read it
  // from the chain at start and increment per signed permit. Dry-run mode can
  // use arbitrary values (no chain state).
  let permitNonceCounter = 0;
  if (!USE_DRY_RUN && ACTIVE_SIG_PATH !== 'eip3009') {
    try {
      const { createPublicClient } = require('viem');
      const pub = createPublicClient({ chain: gateway.baseSepolia, transport: viemHttp() });
      const abi = [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
      const n = await pub.readContract({ address: gateway.USDC_BASE_SEPOLIA, abi, functionName: 'nonces', args: [buyerAccount.address] });
      permitNonceCounter = Number(n);
      console.log('buyer permit nonce starts at:', permitNonceCounter);
    } catch (e) {
      console.log('WARN could not read on-chain permit nonce (using 0): ' + (e.message || e).slice(0, 80));
    }
  }
  // Path-aware nonce source: eip3009 = fresh random bytes32 per settlement
  // (EIP-3009 uses a random 32-byte nonce, not a counter); eip2612 = counter.
  const nextPermitNonce = () => {
    if (ACTIVE_SIG_PATH === 'eip3009') return '0x' + crypto.randomBytes(32).toString('hex');
    return permitNonceCounter++;
  };

  try {
    await waitForServer();
    console.log('endpoint up on :' + PORT + ' (SAAX_X402_MODE=self, signer=' + signerAddress + ')');

    // ======================================================================
    // T1 â€” 402 challenge without payment header
    // ======================================================================
    console.log('\n== T1: no payment header -> 402 challenge with PAYMENT-REQUIRED ==');
    const c1 = await request('POST', '/route', { 'Content-Type': 'application/json' }, body);
    const prHeader = c1.headers && c1.headers['payment-required'];
    const prDecoded = decodeGatewayReceipt(prHeader);
    console.log('  HTTP ' + c1.status + ' payment-required header present: ' + !!prHeader);
    check('T1 returns 402', c1.status === 402, String(c1.status));
    check('T1 PAYMENT-REQUIRED header present', !!prHeader, prHeader ? prHeader.slice(0, 60) + '...' : 'missing');
    check('T1 header decodes to challenge JSON', !!prDecoded, prDecoded ? JSON.stringify(prDecoded).slice(0, 100) : 'n/a');
    check('T1 network = ' + gateway.NETWORK_CAIP2_BASE_SEPOLIA, prDecoded && prDecoded.network === gateway.NETWORK_CAIP2_BASE_SEPOLIA, prDecoded && prDecoded.network);
    check('T1 asset = Base Sepolia USDC', prDecoded && String(prDecoded.asset).toLowerCase() === gateway.USDC_BASE_SEPOLIA.toLowerCase(), prDecoded && prDecoded.asset);
    check('T1 payTo = signer (operative payee)', prDecoded && String(prDecoded.payTo).toLowerCase() === String(signerAddress || '').toLowerCase(), prDecoded && prDecoded.payTo);
    check('T1 amount = routing fee 50000', prDecoded && String(prDecoded.amount) === amountRaw, prDecoded && prDecoded.amount);
    check('T1 facilitator = self', prDecoded && prDecoded.facilitator === 'self', prDecoded && prDecoded.facilitator);
    check('T1 scheme = exact', prDecoded && prDecoded.scheme === 'exact', prDecoded && prDecoded.scheme);

    // ======================================================================
    // T2 â€” valid EIP-3009 authorization -> verify -> route -> settle -> receipt
    // ======================================================================
    console.log('\n== T2: valid signature -> verify -> routing -> settle -> receipt ==');
    // EIP-2612 nonce counter: read from chain (live) or a fresh counter
    // (dry-run). Increments by 1 per permit so each settle consumes exactly
    // one unused on-chain nonce.
    const t2Nonce = nextPermitNonce();
    const auth2 = await signAuthorization(buyerAccount, authRecipient, amountRaw, domain, {
      validAfter: now - 60,
      validBefore: now + 3600,
      nonce: t2Nonce,
    });
    const sig2 = buildPaymentSignaturePayload({ signature: auth2.signature, authorization: wireAuth(auth2.message, now - 60, now + 3600) });
    const t2 = await request('POST', '/route', { 'Content-Type': 'application/json', 'payment-signature': sig2 }, body);
    const j2 = JSON.parse(t2.body);
    const pr2 = t2.headers && t2.headers['payment-response'];
    const pr2Decoded = decodeGatewayReceipt(pr2);
    console.log('  HTTP ' + t2.status + ' status=' + j2.status + ' mode=' + (j2.payment && j2.payment.mode));
    if (t2.status === 502 && j2.reason) console.log('  T2 SETTLEMENT ERROR reason: ' + j2.reason);
    console.log('  payment-response header: ' + (pr2 ? pr2.slice(0, 80) + '...' : 'missing'));
    if (pr2Decoded) console.log('  receipt: txHash=' + pr2Decoded.transactionHash + ' status=' + pr2Decoded.status + (pr2Decoded.dryRun ? ' (dryrun)' : ''));
    check('T2 payment verified mode=circle', j2.payment && j2.payment.mode === 'circle' && j2.payment.verified === true, JSON.stringify(j2.payment));
    check('T2 routing executed (200 ok)', t2.status === 200 && j2.status === 'ok', String(t2.status));
    check('T2 matches returned', Array.isArray(j2.matches) && j2.matches.length > 0, String(j2.matches && j2.matches.length));
    check('T2 PAYMENT-RESPONSE header present', !!pr2, 'missing');
    check('T2 receipt status settled', pr2Decoded && pr2Decoded.status === 'settled', pr2Decoded && pr2Decoded.status);
    check('T2 receipt txHash present' + (USE_DRY_RUN ? ' (dryrun_)' : ''), pr2Decoded && !!pr2Decoded.transactionHash, pr2Decoded && pr2Decoded.transactionHash);
    if (USE_DRY_RUN) {
      check('T2 dry-run marker (no real broadcast)', pr2Decoded && pr2Decoded.dryRun === true, String(pr2Decoded && pr2Decoded.dryRun));
    }

    // ======================================================================
    // T3 â€” replay the SAME signature (same nonce) -> no duplicate charge
    // ======================================================================
    console.log('\n== T3: replay same signature -> no double charge ==');
    const t3 = await request('POST', '/route', { 'Content-Type': 'application/json', 'payment-signature': sig2 }, body);
    const j3 = JSON.parse(t3.body);
    const pr3 = t3.headers && t3.headers['payment-response'];
    const pr3d = decodeGatewayReceipt(pr3);
    console.log('  HTTP ' + t3.status + ' body==' + (t3.body === t2.body ? 'IDENTICAL_TO_ORIGINAL' : 'DIFFERENT') + ' payment-response=' + (pr3d ? pr3d.transactionHash : 'NONE'));
    // The replay-safe contract (Item 4 + Day 8 idempotency): a re-presented
    // signature must EITHER be rejected (409) OR answered with the CACHED
    // response â€” the body identical to the original and NO new settlement
    // header (no fresh txHash). A fresh 200 with a new settlement = FAIL.
    const t3IsCachedReplay = t3.status === 200 && t3.body === t2.body && !pr3d;
    const t3IsConflict = t3.status === 409;
    check('T3 replay rejected or cached (409 or identical cached body)', t3IsConflict || t3IsCachedReplay, t3.status + ' / cached=' + t3IsCachedReplay);
    check('T3 no double settlement (no fresh PAYMENT-RESPONSE)', !pr3d || (pr3d && pr3d.transactionHash && t3IsCachedReplay), pr3d ? pr3d.transactionHash : 'none');

    // ======================================================================
    // T4 â€” invalid signature (wrong signer) -> 402, no routing
    // ======================================================================
    console.log('\n== T4: invalid signature -> 402, no routing ==');
    const attackerPk = generatePrivateKey();
    const attackerAccount = privateKeyToAccount(attackerPk);
    // Unique per run (nextPermitNonce: bytes32 hex on eip3009, counter on
    // eip2612) so the idempotency key never collides across runs. T4 NEVER
    // settles (rejected pre-settlement), so any value is fine as long as it
    // differs from every prior run's T4 nonce �?" otherwise a stale settled row
    // from a poisoned earlier run replays 200.
    const t4Nonce = nextPermitNonce();
    const auth4Bad = await signAuthorization(attackerAccount, authRecipient, amountRaw, domain, {
      validAfter: now - 60, validBefore: now + 3600, nonce: t4Nonce,
    });
    // Tamper: keep the buyer's 'from' but sign with the attacker key -> recovery
    // yields attacker, not authorization.from.
    // Map the attacker-signed Permit to wire shape, then LIE about from=owner:
    // the recovered signer (attacker) != authorization.from (buyer) -> reject.
    const tampered = {
      ...wireAuth(auth4Bad.message, now - 60, now + 3600),
      from: buyerAccount.address, // lie about the sender
    };
    const sig4 = buildPaymentSignaturePayload({ signature: auth4Bad.signature, authorization: tampered });
    const t4 = await request('POST', '/route', { 'Content-Type': 'application/json', 'payment-signature': sig4 }, body);
    const j4 = JSON.parse(t4.body);
    console.log('  HTTP ' + t4.status + ' rejectReason=' + (j4.rejectReason || 'n/a'));
    check('T4 returns 402', t4.status === 402, String(t4.status));
    check('T4 no routing executed', !j4.matches, JSON.stringify(j4).slice(0, 120));
    check('T4 rejection reason surfaced', /signature|verify|recover/i.test(j4.rejectReason || ''), j4.rejectReason);

    // ======================================================================
    // T5 â€” expired authorization -> 402, no routing
    // ======================================================================
    console.log('\n== T5: expired authorization -> 402, no routing ==');
    // T5 never settles (expired auth is rejected pre-settlement), so it must
    // NOT consume the live EIP-2612 counter on the eip2612 path (nextPermitNonce
    // handles that: it only increments the counter on eip2612; on eip3009 it
    // returns a fresh random bytes32 that never reaches the chain — the expiry
    // check rejects it first).
    const t5Nonce = nextPermitNonce();
    const auth5 = await signAuthorization(buyerAccount, authRecipient, amountRaw, domain, {
      validAfter: now - 3600,          // 1h ago
      validBefore: now - 60,           // expired 60s ago (deadline in the past)
      nonce: t5Nonce,
    });
    const sig5 = buildPaymentSignaturePayload({ signature: auth5.signature, authorization: wireAuth(auth5.message, now - 3600, now - 60) });
    const t5 = await request('POST', '/route', { 'Content-Type': 'application/json', 'payment-signature': sig5 }, body);
    const j5 = JSON.parse(t5.body);
    console.log('  HTTP ' + t5.status + ' rejectReason=' + (j5.rejectReason || 'n/a'));
    check('T5 returns 402', t5.status === 402, String(t5.status));
    check('T5 no routing', !j5.matches, JSON.stringify(j5).slice(0, 120));
    check('T5 expired reason surfaced', /expired/i.test(j5.rejectReason || ''), j5.rejectReason);

    // ======================================================================
    // T6 â€” nonce-bound idempotency: fresh request key, SAME nonce -> replay-safe
    // ======================================================================
    console.log('\n== T6: fresh request key + same nonce -> replay-safe (Item 4) ==');
    // First use the nonce under key A (fresh payment), then re-present the SAME
    // signed authorization under key B -> the nonce guard must reject (or the
    // idempotency layer keyed on hash(nonce) must catch it). No double charge.
    const t6Nonce = nextPermitNonce();
    const auth6 = await signAuthorization(buyerAccount, authRecipient, amountRaw, domain, {
      validAfter: now - 60, validBefore: now + 3600, nonce: t6Nonce,
    });
    const sig6 = buildPaymentSignaturePayload({ signature: auth6.signature, authorization: wireAuth(auth6.message, now - 60, now + 3600) });
    const t6a = await request('POST', '/route', { 'Content-Type': 'application/json', 'payment-signature': sig6, 'idempotency-key': 't6-key-a' }, body);
    console.log('  request A (key t6-key-a) -> HTTP ' + t6a.status);
    const t6b = await request('POST', '/route', { 'Content-Type': 'application/json', 'payment-signature': sig6, 'idempotency-key': 't6-key-b' }, body);
    console.log('  request B (key t6-key-b, SAME nonce) -> HTTP ' + t6b.status + ' body==' + (t6a.body === t6b.body ? 'IDENTICAL_TO_A' : 'DIFFERENT'));
    const pr6b = t6b.headers && t6b.headers['payment-response'];
    const pr6bd = decodeGatewayReceipt(pr6b);
    // The nonce-bound idempotency key (Item 4) must make the SAME nonce collide
    // even under DIFFERENT client idempotency keys: B is a cached replay of A
    // (identical body, no new settlement) or a 409.
    const t6bCached = t6b.status === 200 && t6b.body === t6a.body && !pr6bd;
    check('T6 request A processed (200 ok)', t6a.status === 200, String(t6a.status));
    check('T6 request B rejected or cached (409 / identical cached body)', t6b.status === 409 || t6bCached, String(t6b.status) + ' / cached=' + t6bCached);
    // If B returned 200 with a settlement, it MUST be the same txHash (cached).
    if (t6b.status === 200 && pr6bd && pr6bd.transactionHash) {
      const pr6ad = decodeGatewayReceipt(t6a.headers && t6a.headers['payment-response']);
      check('T6 no double settlement (same txHash)', pr6ad && pr6ad.transactionHash === pr6bd.transactionHash, pr6ad && pr6ad.transactionHash + ' vs ' + pr6bd.transactionHash);
    }

    // ======================================================================
    // T7 â€” Day 8 rate limit: 61/min -> 429 BEFORE verification
    // ======================================================================
    console.log('\n== T7: Day 8 rate limit (61/min) -> 61st returns 429 ==');
    // Use a headerless (402-challenge) request â€” the challenge path is
    // idempotency-neutral and rate-limited at the boundary; 61 hits in a burst
    // must trip the IP tier before payment verification.
    const before = Date.now();
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      lastStatus = (await request('POST', '/route', { 'Content-Type': 'application/json' }, body)).status;
      if (lastStatus === 429) break;
    }
    const elapsed = Date.now() - before;
    console.log('  burst -> first 429 at request ' + (lastStatus === 429 ? '<=61' : 'none') + ' (' + elapsed + 'ms)');
    check('T7 429 before 61+ requests (within window)', lastStatus === 429, String(lastStatus));
    // NOTE: the IP tier may be shared with prior requests from this test's IP.
    // The module-level limit (60/min) is asserted precisely in test-day8-item2.js;
    // here we assert the boundary fires 429, which is the control contract.

    // ======================================================================
    // T8 â€” Day 8 kill switch: 503, zero RPC calls
    // ======================================================================
    console.log('\n== T8: Day 8 kill switch (SAAX_KILL_SWITCH=true) -> 503, zero broadcast ==');
    const ksChild = spawn(process.execPath, [path.join('endpoint', 'route-server.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...env, SAAX_PORT: String(PORT + 1), SAAX_KILL_SWITCH: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ksChild.stdout.on('data', () => {});
    ksChild.stderr.on('data', () => {});
    // Wait for the second server on PORT+1
    let ksUp = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await new Promise((resolve, reject) => {
          const req = http.request({ host: 'localhost', port: PORT + 1, path: '/health', method: 'GET' }, res => { let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
          req.on('error', reject); req.end();
        });
        if (r.status === 200) { ksUp = true; break; }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ksUp) { console.log('FAIL  T8 second server did not come up'); failures++; }
    else {
      const t8 = await new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port: PORT + 1, path: '/route', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
        req.on('error', reject); req.write(body); req.end();
      });
      const j8 = JSON.parse(t8.body);
      console.log('  HTTP ' + t8.status + ' body=' + t8.body.slice(0, 100));
      check('T8 503 halted', t8.status === 503, String(t8.status));
      check('T8 reason operator_kill_switch', j8.reason === 'operator_kill_switch', j8.reason);
      // Zero broadcast: no PAYMENT-REQUIRED/PROCESSING happened; the kill switch
      // fired at gate 1 (before any chain interaction).
      check('T8 no payment header on halt response', !t8.headers['payment-required'], 'none');
    }
    ksChild.kill();

    // ======================================================================
    // T9 â€” Buyer reputation: signer recovery resolves
    // ======================================================================
    console.log('\n== T9: buyer reputation from signer recovery ==');
    // T7 exhausted the IP rate window (61 requests), so T9 runs against its OWN
    // server instance on PORT+2 with a clean window. In self mode the reputation
    // path resolves from authorization.from via the identity module. Offline
    // (no RPC identity), an unknown signer resolves to rep 0 / no discount â€”
    // the control that matters: the recovery is bound to the VERIFIED signer,
    // not a spoofable header.
    const repChild = spawn(process.execPath, [path.join('endpoint', 'route-server.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...env, SAAX_PORT: String(PORT + 2) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    repChild.stdout.on('data', () => {});
    repChild.stderr.on('data', () => {});
    let repUp = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await new Promise((resolve, reject) => {
          const req = http.request({ host: 'localhost', port: PORT + 2, path: '/health', method: 'GET' }, res => { let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode })); });
          req.on('error', reject); req.end();
        });
        if (r.status === 200) { repUp = true; break; }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!repUp) { console.log('FAIL  T9 reputation server did not come up'); failures++; }
    else {
      const t9Nonce = nextPermitNonce();
      const auth9 = await signAuthorization(buyerAccount, authRecipient, amountRaw, domain, {
        validAfter: now - 60, validBefore: now + 3600, nonce: t9Nonce,
      });
      const sig9 = buildPaymentSignaturePayload({ signature: auth9.signature, authorization: wireAuth(auth9.message, now - 60, now + 3600) });
      const t9 = await new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port: PORT + 2, path: '/route', method: 'POST', headers: { 'Content-Type': 'application/json', 'payment-signature': sig9 } }, res => { let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
          req.on('error', reject); req.write(body); req.end();
          });
        if (t9.status === 502) {
          try { const rj = JSON.parse(t9.body); console.log('  T9 SETTLEMENT ERROR reason: ' + (rj.reason || t9.body.slice(0, 200))); } catch (_) { console.log('  T9 502 body: ' + t9.body.slice(0, 200)); }
      }
      const j9 = JSON.parse(t9.body);
      console.log('  HTTP ' + t9.status + ' reputation=' + JSON.stringify(j9.reputation || null) + ' fee=' + JSON.stringify(j9.fee || null));
      check('T9 payment verified circle', t9.status === 200 && j9.payment && j9.payment.mode === 'circle', String(t9.status));
      // The fee decision logged the reputation resolution (rep 0 for unknown
      // signer â€” no agent registered for the buyer's fresh wallet).
      check('T9 reputation resolved from signer (not header)', /reputation|signature|agent/i.test(j9.decisionLog ? j9.decisionLog.join(' ') : ''), (j9.decisionLog || []).slice(-3).join(' | '));
      check('T9 mock header ignored in self mode (no 20% discount)', !j9.fee || j9.fee.discountPct === 0, JSON.stringify(j9.fee));
    }
    repChild.kill();

    // ======================================================================
    // T10 â€” Day 10 dual-path: on-chain signature-path detection
    // ======================================================================
    console.log('\n== T10: Day 10 dual-path detection (EIP-3009 vs EIP-2612) ==');
    // Resolve the signature path exactly as the gateway does (env pin or
    // on-chain probe). Assert: a valid path is selected and it carries
    // selector evidence. On Base Sepolia USDC this MUST be eip2612 (the
    // selector is absent from the FiatTokenV2 code â€” verified by probe).
    const pathInfo = await gateway.getSignaturePath({ asset: gateway.USDC_BASE_SEPOLIA, chainId: gateway.BASE_SEPOLIA_CHAIN_ID });
    console.log('  selected path: ' + pathInfo.path + (pathInfo.cached ? ' (cached)' : '') + ' cached=' + pathInfo.cached);
    console.log('  evidence: ' + JSON.stringify(pathInfo.evidence));
    check('T10 path selected is eip3009 or eip2612', pathInfo.path === 'eip3009' || pathInfo.path === 'eip2612', pathInfo.path);
    check('T10 selector evidence present', !!(pathInfo.evidence && pathInfo.evidence.selector), pathInfo.evidence && pathInfo.evidence.selector);
    // The testnet contract is FiatTokenV2 (no EIP-3009 selector); assert the
    // testnet path is EIP-2612 so the regression contract (testnet unchanged)
    // is explicit and the mainnet path selection logic is documented.
    const want2612 = String(process.env.SAAX_X402_SIGNATURE_PATH || '').toLowerCase() !== 'eip3009';
    // Key the expectation off the ACTIVE chain (NETWORK_CAIP2_BASE_SEPOLIA is the
    // active alias: eip155:84532 on testnet, eip155:8453 on mainnet). The legacy
    // BASE_SEPOLIA_CHAIN_ID constant is always 84532 and must not drive this.
    const activeIsTestnet = gateway.NETWORK_CAIP2_BASE_SEPOLIA === 'eip155:84532';
    check('T10 active chain selects consistent path', activeIsTestnet ? (want2612 ? pathInfo.path === 'eip2612' : true) : (pathInfo.path === 'eip3009' || pathInfo.path === 'eip2612'),
      'path=' + pathInfo.path + ' (testnet FiatTokenV2 expected eip2612 unless pinned; mainnet expected eip3009)');
    check('T10 evidence records selector presence', pathInfo.evidence && typeof pathInfo.evidence.found === 'boolean',
      'found=' + (pathInfo.evidence && pathInfo.evidence.found));

  // ======================================================================
  // T11 — FAIL-CLOSED: Circle /verify unreachable -> 402, NO fallback to
  // SAAX's own self-verification (Option A closeout).
  // ======================================================================
  console.log('\n== T11: Circle unreachable -> payment fails closed (402, no self-verify fallback) ==');
  const t11Port = PORT + 3;
  const t11Env = {
    ...process.env,
    SAAX_PORT: String(t11Port),
    SAAX_X402_MODE: 'self',
    SAAX_GATEWAY_DRY_RUN: USE_DRY_RUN ? '1' : '0',
    SAAX_RATE_LIMIT_STORE: 'memory',
    SAAX_IDEMPOTENCY_STORE: 'memory',
  };
  // Explicitly UNSET the mock (the parent run may have set it) and point the
  // verifier at an unreachable host: port 9 (discard) refuses connections.
  delete t11Env.CIRCLE_MOCK;
  t11Env.CIRCLE_VERIFY_URL = 'http://127.0.0.1:9/facilitator';
  const t11Child = spawn(process.execPath, [path.join('endpoint', 'route-server.js')], {
    cwd: path.join(__dirname, '..'),
    env: t11Env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t11Child.stdout.on('data', c => { try { fs.appendFileSync(path.join(__dirname, '..', 'daily-logs', 'day9-live-server.log'), String(c)); } catch (_) {} });
  t11Child.stderr.on('data', c => { try { fs.appendFileSync(path.join(__dirname, '..', 'daily-logs', 'day9-settle-stderr.log'), String(c)); } catch (_) {} });
  try {
    // Wait for the server to accept connections (poll /health or a bare POST).
    let t11Up = false;
    for (let i = 0; i < 60; i++) {
      try {
        const up = await new Promise((resolve, reject) => {
          const req = http.request({ host: 'localhost', port: t11Port, path: '/health', method: 'GET' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', reject); req.setTimeout(400, () => { req.destroy(); reject(new Error('timeout')); }); req.end();
        });
        if (up) { t11Up = true; break; }
      } catch (_) { /* not up yet */ }
      await new Promise(r => setTimeout(r, 400));
    }
    check('T11 fail-closed server came up', t11Up, String(t11Up));
    if (!t11Up) { console.log('  T11 server did not come up; skipping assertion'); }
    else {
      // Sign a STRUCTURALLY VALID payment (same flow as T2) so the ONLY thing
      // that can reject it is the unreachable Circle verifier.
      const t11Now = Math.floor(Date.now() / 1000);
      const t11Nonce = ACTIVE_SIG_PATH === 'eip2612'
        ? String(await gateway.readNonce(buyerAccount.address, gateway.USDC_BASE_SEPOLIA, gateway.BASE_SEPOLIA_CHAIN_ID))
        : '0x' + 'ab'.repeat(32);
      const auth11 = await signAuthorization(buyerAccount, signerAddress, amountRaw, domain, {
        validAfter: t11Now - 60,
        validBefore: t11Now + 3600,
        nonce: t11Nonce,
      });
      const sig11 = buildPaymentSignaturePayload({ signature: auth11.signature, authorization: wireAuth(auth11.message, t11Now - 60, t11Now + 3600) });
      const t11 = await new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port: t11Port, path: '/route', method: 'POST', headers: { 'Content-Type': 'application/json', 'payment-signature': sig11 } }, res => { let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
        req.on('error', reject); req.write(body); req.end();
      });
      let t11j = null; try { t11j = JSON.parse(t11.body); } catch (_) {}
      console.log('  HTTP ' + t11.status + ' rejectReason=' + (t11j && t11j.rejectReason || t11.body.slice(0, 120)));
      // FAIL-CLOSED: must NOT be 200. Circle unreachable -> 402, no fallback.
      check('T11 Circle unreachable -> NOT 200 (fail closed)', t11.status !== 200, String(t11.status));
      check('T11 Circle unreachable -> 402', t11.status === 402, String(t11.status));
      check('T11 rejectReason names Circle/unreachable', t11j && /circle|unreachable|fail.?closed/i.test(String(t11j.rejectReason || '')), t11j && t11j.rejectReason);
      check('T11 no fallback to self-verification (no PAYMENT-RESPONSE)', !(t11.headers && t11.headers['payment-response']), t11.headers && t11.headers['payment-response'] ? 'present' : 'absent');
    }
  } finally {
    t11Child.kill();
  }

  } finally {
    child.kill();
  }

  console.log('\n' + (failures === 0 ? 'ALL DAY 9 GATEWAY TESTS PASSED' : failures + ' DAY 9 GATEWAY TEST(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('DAY 9 HARNESS CRASHED: ' + e); console.error(e.stack); process.exit(2); });
