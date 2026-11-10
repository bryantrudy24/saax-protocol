// SAAX Protocol - Day 19d: Recipient-Policy Negative Tests (T-R1..T-R4)
//
// Verifies the AUTHORITATIVE recipient policy (established from code):
//   - The recipient authorized by a signed payment must equal the recipient
//     ADVERTISED in the payment requirements for THAT PARTICULAR payment
//     (requirements.payTo). The vault is cold storage for manual sweeps only;
//     a global list of known addresses must not substitute for per-payment
//     authorization.
//
// The route-server child runs with CIRCLE_MOCK UNSET and CIRCLE_VERIFY_URL
// pointed at a LOCAL STUB that counts calls and returns isValid:true, so:
//   - a rejection with counter == 0 proves rejection happened BEFORE Circle
//     (structural recipient binding), and
//   - the valid control (counter == 1) proves the stub would accept a payment
//     to the advertised payee (so 0 is decisive, not a broken stub).
//
//   T-R1 correctly signed payment to an UNRELATED address  -> 402, 0 Circle calls
//   T-R2 client-supplied replacement of payment requirements
//         (attacker changes accepted.payTo + the signed auth recipient
//          so a wrong recipient looks advertised)          -> 402, 0 Circle calls
//   T-R3 correctly signed payment TO THE VAULT while the challenge advertises
//         the signer                                      -> 402, 0 Circle calls
//   T-R4 POSITIVE CONTROL: valid payment to the advertised payee (signer)
//                                                         -> 200 settled, exactly 1 call
//
// SAAX_GATEWAY_DRY_RUN=1 keeps settlement simulated (no funds, no chain writes).
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  createWalletClient,
  http: viemHttp,
} = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const gateway = require('../endpoint/gateway.js');

const PORT = Number(process.env.SAAX_TEST_PORT || 8613);
const STUB_PORT = PORT + 50;

let failures = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
};

function request(method, port, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, method, path: pathname, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await request('GET', port, '/health', {}, null);
      if (r.status === 200) return true;
    } catch (_) { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// Local Circle /verify stub with a call counter. Returns isValid:true so any
// call made would be accepted and counted - decisive for proving rejection
// happens BEFORE Circle.
let circleCalls = 0;
function startStub() {
  const server = http.createServer((req, res) => {
    circleCalls++;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ isValid: true, payer: '0x0000000000000000000000000000000000000000', invalidReason: null }));
    });
  });
  return new Promise(resolve => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

// ---- Signing helpers (mirror the main suite; both signature paths) ----
let ACTIVE_SIG_PATH = 'eip2612';

async function resolveActivePath() {
  const info = await gateway.getSignaturePath({ asset: gateway.USDC_BASE_SEPOLIA, chainId: gateway.BASE_SEPOLIA_CHAIN_ID });
  ACTIVE_SIG_PATH = String(process.env.SAAX_X402_SIGNATURE_PATH || '').toLowerCase() === 'eip3009' ? 'eip3009' : info.path;
}

function eip2612Message(buyerAccount, recipient, valueRaw, { validAfter, validBefore, nonce }) {
  return {
    owner: buyerAccount.address.toLowerCase(),
    spender: recipient.toLowerCase(),
    value: BigInt(valueRaw),
    nonce: BigInt(nonce),
    deadline: BigInt(validBefore),
  };
}

function eip3009Message(buyerAccount, recipient, valueRaw, { validAfter, validBefore, nonce }) {
  return {
    from: buyerAccount.address.toLowerCase(),
    to: recipient.toLowerCase(),
    value: BigInt(valueRaw),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };
}

async function signAuthorization(buyerAccount, recipientAddress, valueRaw, domain, { validAfter, validBefore, nonce }) {
  const wallet = createWalletClient({ account: buyerAccount, chain: gateway.baseSepolia, transport: viemHttp() });
  if (ACTIVE_SIG_PATH === 'eip3009') {
    const message = eip3009Message(buyerAccount, recipientAddress, valueRaw, { validAfter, validBefore, nonce });
    const signature = await wallet.signTypedData({ domain, types: gateway.EIP3009_TRANSFER_TYPES, primaryType: 'TransferWithAuthorization', message });
    return { message, signature };
  }
  const message = eip2612Message(buyerAccount, recipientAddress, valueRaw, { validAfter, validBefore, nonce });
  const signature = await wallet.signTypedData({ domain, types: gateway.EIP3009_TYPES, primaryType: 'Permit', message });
  return { message, signature };
}

// Map the signed message back to the x402 wire authorization shape.
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

function buildPaymentSignaturePayload({ signature, authorization, acceptedOverrides }) {
  const accepted = Object.assign({
    scheme: 'exact',
    network: gateway.NETWORK_CAIP2_BASE_SEPOLIA,
    amount: String(authorization.value),
    asset: gateway.USDC_BASE_SEPOLIA,
    payTo: authorization.to,
    maxTimeoutSeconds: 60,
  }, acceptedOverrides || {});
  const payload = {
    x402Version: 2,
    resource: { url: 'urn:saax-protocol:route:v1', description: 'SAAX Protocol demand routing', mimeType: 'application/json' },
    accepted,
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

(async () => {
  console.log('========== SAAX Protocol - DAY 19d: RECIPIENT-POLICY NEGATIVE TESTS ==========');
  const signerAddress = gateway.getSignerAddress() || gateway.getVaultAddress() || gateway.getSellerAddress();
  const vaultAddress = gateway.getVaultAddress();
  const buyerAccount = privateKeyToAccount(process.env.SAAX_TEST_BUYER_KEY);
  const amountRaw = gateway.rawUnits(0.05);
  const domain = await gateway.domainFor();
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ capability: 'data-annotation', deadline: '2026-10-05T12:00:00Z' });

  await resolveActivePath();
  console.log('active signature path: ' + ACTIVE_SIG_PATH);
  console.log('advertised payee (signer):', signerAddress);
  console.log('vault (cold storage):', vaultAddress);

  // Spawn the route-server child WITHOUT CIRCLE_MOCK and with CIRCLE_VERIFY_URL -> stub.
  const env = {
    ...process.env,
    SAAX_PORT: String(PORT),
    SAAX_X402_MODE: 'self',
    SAAX_GATEWAY_DRY_RUN: '1',
    SAAX_RATE_LIMIT_STORE: 'memory',
    SAAX_IDEMPOTENCY_STORE: 'memory',
  };
  delete env.CIRCLE_MOCK;
  env.CIRCLE_VERIFY_URL = 'http://127.0.0.1:' + STUB_PORT + '/facilitator';

  const stub = await startStub();
  const child = spawn(process.execPath, [path.join('endpoint', 'route-server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', c => { try { fs.appendFileSync(path.join(__dirname, '..', 'daily-logs', 'day19d-recipient-server.log'), String(c)); } catch (_) {} });
  child.stderr.on('data', c => { try { fs.appendFileSync(path.join(__dirname, '..', 'daily-logs', 'day19d-recipient-stderr.log'), String(c)); } catch (_) {} });

  try {
    const up = await waitForServer(PORT);
    check('recipient-policy server came up', up, String(up));
    if (!up) { console.log('  server did not come up; aborting'); }
    else {
      let nonceCounter = 0;
      const nextNonce = () => {
        if (ACTIVE_SIG_PATH === 'eip3009') return '0x' + crypto.randomBytes(32).toString('hex');
        return String(++nonceCounter);
      };

      // ---- T-R1: correctly signed payment to an UNRELATED address --------------
      console.log('\n== T-R1: signed payment to unrelated address -> 402 before Circle ==');
      const unrelated = privateKeyToAccount(generatePrivateKey()).address;
      const r1Nonce = nextNonce();
      const authR1 = await signAuthorization(buyerAccount, unrelated, amountRaw, domain, { validAfter: now - 60, validBefore: now + 3600, nonce: r1Nonce });
      const authR1Wire = wireAuth(authR1.message, now - 60, now + 3600);
      const sigR1 = buildPaymentSignaturePayload({ signature: authR1.signature, authorization: authR1Wire });
      circleCalls = 0;
      const r1 = await request('POST', PORT, '/route', { 'Content-Type': 'application/json', 'payment-signature': sigR1 }, body);
      const j1 = JSON.parse(r1.body);
      console.log('  HTTP ' + r1.status + ' rejectReason=' + (j1.rejectReason || 'n/a') + ' circleCalls=' + circleCalls);
      check('T-R1 returns 402', r1.status === 402, String(r1.status));
      check('T-R1 rejection names recipient binding', /recipient|payee|payTo/i.test(j1.rejectReason || ''), j1.rejectReason);
      check('T-R1 zero Circle calls (rejected before Circle)', circleCalls === 0, String(circleCalls));
      check('T-R1 no payment-success response', !(r1.headers && r1.headers['payment-response']), r1.headers && r1.headers['payment-response'] ? 'present' : 'absent');
      check('T-R1 no routing executed', !j1.matches, JSON.stringify(j1).slice(0, 120));

      // ---- T-R2: client-supplied replacement of payment requirements -----------
      // Attacker signs a payment to the UNRELATED address, then also rewrites
      // accepted.payTo (to their own address) so the payload looks self-
      // consistent. The server compares against ITS OWN advertised requirements
      // (payTo = operative payee = signer), so this must still be rejected.
      console.log('\n== T-R2: client-supplied requirements replacement -> 402 before Circle ==');
      const attacker2 = privateKeyToAccount(generatePrivateKey());
      const r2Nonce = nextNonce();
      const authR2 = await signAuthorization(attacker2, attacker2.address, amountRaw, domain, { validAfter: now - 60, validBefore: now + 3600, nonce: r2Nonce });
      const authR2Wire = wireAuth(authR2.message, now - 60, now + 3600);
      // The client rewrites accepted.payTo to match ITS OWN signed recipient.
      const sigR2 = buildPaymentSignaturePayload({
        signature: authR2.signature,
        authorization: Object.assign({}, authR2Wire, { from: buyerAccount.address.toLowerCase() }),
        acceptedOverrides: { payTo: attacker2.address.toLowerCase() },
      });
      circleCalls = 0;
      const r2 = await request('POST', PORT, '/route', { 'Content-Type': 'application/json', 'payment-signature': sigR2 }, body);
      const j2 = JSON.parse(r2.body);
      console.log('  HTTP ' + r2.status + ' rejectReason=' + (j2.rejectReason || 'n/a') + ' circleCalls=' + circleCalls);
      check('T-R2 returns 402', r2.status === 402, String(r2.status));
      check('T-R2 rejection names recipient binding (server requirements win)', /recipient|payee|payTo|signature/i.test(j2.rejectReason || ''), j2.rejectReason);
      check('T-R2 zero Circle calls (rejected before Circle)', circleCalls === 0, String(circleCalls));
      check('T-R2 no payment-success response', !(r2.headers && r2.headers['payment-response']), 'absent');

      // ---- T-R3: correctly signed payment TO THE VAULT --------------------------
      // Challenge advertises the signer; a payment directed to the vault (cold
      // storage) is NOT authorized for this particular payment.
      console.log('\n== T-R3: signed payment to the vault (not advertised) -> 402 before Circle ==');
      if (vaultAddress && String(vaultAddress).toLowerCase() !== String(signerAddress || '').toLowerCase()) {
        const r3Nonce = nextNonce();
        const authR3 = await signAuthorization(buyerAccount, vaultAddress, amountRaw, domain, { validAfter: now - 60, validBefore: now + 3600, nonce: r3Nonce });
        const authR3Wire = wireAuth(authR3.message, now - 60, now + 3600);
        const sigR3 = buildPaymentSignaturePayload({ signature: authR3.signature, authorization: authR3Wire });
        circleCalls = 0;
        const r3 = await request('POST', PORT, '/route', { 'Content-Type': 'application/json', 'payment-signature': sigR3 }, body);
        const j3 = JSON.parse(r3.body);
        console.log('  HTTP ' + r3.status + ' rejectReason=' + (j3.rejectReason || 'n/a') + ' circleCalls=' + circleCalls);
        check('T-R3 returns 402', r3.status === 402, String(r3.status));
        check('T-R3 rejection names recipient binding (vault not authorized)', /recipient|payee|payTo/i.test(j3.rejectReason || ''), j3.rejectReason);
        check('T-R3 zero Circle calls (rejected before Circle)', circleCalls === 0, String(circleCalls));
        check('T-R3 no payment-success response', !(r3.headers && r3.headers['payment-response']), 'absent');
      } else {
        console.log('  SKIP: vault unset or equals signer (no distinct vault to test)');
        check('T-R3 skipped (vault unset/equal - not a distinct recipient)', true, 'skip');
      }

      // ---- T-R4: POSITIVE CONTROL - valid payment to the advertised payee -------
      console.log('\n== T-R4 (control): valid payment to advertised payee -> 200 + Circle called ==');
      const r4Nonce = nextNonce();
      const authR4 = await signAuthorization(buyerAccount, signerAddress, amountRaw, domain, { validAfter: now - 60, validBefore: now + 3600, nonce: r4Nonce });
      const authR4Wire = wireAuth(authR4.message, now - 60, now + 3600);
      const sigR4 = buildPaymentSignaturePayload({ signature: authR4.signature, authorization: authR4Wire });
      circleCalls = 0;
      const r4 = await request('POST', PORT, '/route', { 'Content-Type': 'application/json', 'payment-signature': sigR4 }, body);
      const j4 = JSON.parse(r4.body);
      const pr4 = r4.headers && r4.headers['payment-response'];
      console.log('  HTTP ' + r4.status + ' mode=' + (j4.payment && j4.payment.mode) + ' circleCalls=' + circleCalls);
      // The control proves the STUB counts: a payment to the advertised payee
      // reaches Circle (exactly 1 call) and is accepted. Routing to an actual
      // supplier (status:ok + PAYMENT-RESPONSE) depends on the store having a
      // matching supplier for this capability in this standalone environment,
      // which is orthogonal to recipient policy - so we assert the verification
      // contract, not the supplier-match leg.
      check('T-R4 control reaches Circle path (200)', r4.status === 200, String(r4.status));
      check('T-R4 control verified via Circle path', j4.payment && j4.payment.mode === 'circle' && j4.payment.verified === true, JSON.stringify(j4.payment));
      check('T-R4 Circle called exactly once (stub counts)', circleCalls === 1, String(circleCalls));
      check('T-R4 no rejection reason (accepted through Circle)', !j4.rejectReason, j4.rejectReason || 'none');
    }
  } finally {
    child.kill();
    stub.close();
  }

  console.log('\n' + (failures === 0 ? 'ALL RECIPIENT-POLICY TESTS PASSED' : failures + ' RECIPIENT-POLICY TEST(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('RECIPIENT-POLICY HARNESS CRASHED: ' + e); console.error(e.stack || ''); process.exit(2); });