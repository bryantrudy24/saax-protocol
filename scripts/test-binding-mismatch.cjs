// FOCUSED binding-mismatch test (authorization binding fix).
// Proves: for buyer-scoped actions, the recovered access signer must match the
// agreement-authorized buyer AND the on-chain escrow buyer. A configured buyer
// address alone is insufficient. Rejection occurs BEFORE durable acceptance.
// Does NOT rerun the broad battery — only the binding cases.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createWalletClient, createPublicClient } = require('viem');
const vhttp = require('viem').http;
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');
require('dotenv').config({ path: '.env' });

const RPC = 'https://sepolia.base.org';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const PORT = Number(process.env.SAAX_BIND_TEST_PORT || 8897);
const LEDGER = path.join(__dirname, '..', 'data', 'test-binding-ledger.json');
try { fs.unlinkSync(LEDGER); } catch (e) {}
process.env.SAAX_ESCROW_LEDGER = LEDGER;

const escrows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'binding-test-escrows.json'), 'utf8'));
const VALID_CID = escrows.valid.CID;
const MISMATCH_CID = escrows.mismatch.CID;

const BUYER_KEY = process.env.SAAX_TEST_BUYER_KEY;
const SELLER_KEY = process.env.SAAX_SELLER_PRIVATE_KEY;
const EVALUATOR_KEY = process.env.SAAX_SIGNER_PRIVATE_KEY;
const BUYER = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';

const ACCESS_DOMAIN = { name: 'SAAX Escrow Access', version: '1', chainId: BigInt(84532), verifyingContract: '0x0000000000000000000000000000000000000000' };
const ACCESS_TYPES = {
  EscrowAccess: [
    { name: 'role', type: 'string' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'escrowId', type: 'bytes32' },
    { name: 'custody', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
};

function signAccessAuth(key, role, action, nonce, opts) {
  opts = opts || {};
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain: baseSepolia, transport: vhttp(RPC) });
  const payload = {
    role,
    commitmentDigest: opts.digest || VALID_CID,
    escrowId: opts.escrowId || VALID_CID,
    custody: CUSTODY,
    chainId: '84532',
    action,
    nonce: String(nonce),
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
  };
  return client.signTypedData({
    domain: ACCESS_DOMAIN, types: ACCESS_TYPES, primaryType: 'EscrowAccess',
    message: {
      role, commitmentDigest: payload.commitmentDigest, escrowId: payload.escrowId,
      custody: CUSTODY, chainId: BigInt(84532), action, nonce: BigInt(nonce), expiry: BigInt(payload.expiry),
    },
  }).then(sig => {
    const v = parseInt(sig.slice(130, 132), 16);
    return { payload, signature: { v, r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) } };
  });
}

function post(port, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

let child = null;
function spawnServer() {
  child = spawn(process.execPath, ['endpoint/route-server.js'], {
    env: Object.assign({}, process.env, {
      SAAX_ESCROW_BACKED: '1', SAAX_X402_MODE: 'self', SAAX_X402_VERIFY_MODE: 'live',
      SAAX_RPC_URL: RPC, SAAX_CHAIN_ID: '84532', SAAX_CUSTODY_ADDRESS: CUSTODY,
      SAAX_ESCROW_LEDGER: LEDGER, PORT: String(PORT), SAAX_IDEMPOTENCY_STORE: 'memory',
      SAAX_TEST_BUYER_ADDRESS: BUYER,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server boot timeout')), 15000);
    const poll = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (res) => { clearTimeout(t); resolve(); });
      req.on('error', () => setTimeout(poll, 250));
    };
    poll();
  });
}
function killServer() { if (child) { try { child.kill(); } catch (e) {} child = null; } }

function ledgerNonces() {
  try { const d = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); return Object.keys(d.operations || {}); } catch (e) { return []; }
}

(async () => {
  const results = [];
  const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail); };
  try {
    await spawnServer();

    // 1. VALID CONTROL: configured buyer signs buyer-action 'execute' against the
    //    VALID escrow (on-chain buyer == configured buyer == signer) -> accepted.
    const a1 = await signAccessAuth(BUYER_KEY, 'buyer', 'execute', 91001, { digest: VALID_CID, escrowId: VALID_CID });
    const hdr1 = { 'x-saax-access-auth': Buffer.from(JSON.stringify(a1)).toString('base64') };
    const r1 = await post(PORT, '/route', { capability: 'security scan', deadline: '2026-10-08' }, hdr1);
    const acceptedOk = r1.status === 200 && r1.body && r1.body.ok === true;
    record('binding-valid-control', acceptedOk, 'buyer-auth vs valid escrow -> ' + r1.status + ' ' + JSON.stringify(r1.body || {}).slice(0, 120));

    // 2. MISMATCH TEST: configured buyer signs against the MISMATCH escrow
    //    (on-chain buyer 0x1111... != configured buyer == signer).
    //    Must be REJECTED (402) BEFORE durable acceptance.
    const a2 = await signAccessAuth(BUYER_KEY, 'buyer', 'execute', 91002, { digest: MISMATCH_CID, escrowId: MISMATCH_CID });
    const hdr2 = { 'x-saax-access-auth': Buffer.from(JSON.stringify(a2)).toString('base64') };
    const r2 = await post(PORT, '/route', { capability: 'security scan', deadline: '2026-10-08' }, hdr2);
    const rejBefore = r2.status === 402 && !(r2.body && r2.body.ok === true);
    const noncesAfter = ledgerNonces();
    const noAccept = !noncesAfter.includes('91002');
    const reason = String((r2.body && r2.body.error) || r2.raw || '').slice(0, 160);
    record('binding-mismatch-rejected', rejBefore, 'buyer-auth vs mismatch escrow -> ' + r2.status + ' reason: ' + reason);
    record('binding-mismatch-no-acceptance', noAccept, 'nonce 91002 NOT durably accepted (ledger nonces: ' + noncesAfter.join(',') + ')');

    // 3. SELLER boundary preserved: seller 'request status' on VALID escrow -> 200
    //    (status path must NOT be gated on the funding/party check).
    const a3 = await signAccessAuth(SELLER_KEY, 'seller', 'request status', 91003, { digest: VALID_CID, escrowId: VALID_CID });
    const r3 = await post(PORT, '/route', { capability: 'security scan', deadline: '2026-10-08' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(a3)).toString('base64') });
    record('binding-seller-status-preserved', r3.status === 200, 'seller status on valid escrow -> ' + r3.status);

    // 4. EVALUATOR boundary preserved: evaluator 'submit verdict' on VALID escrow
    //    (on-chain evaluator == configured evaluator == signer) -> accepted.
    const a4 = await signAccessAuth(EVALUATOR_KEY, 'evaluator', 'submit verdict', 91004, { digest: VALID_CID, escrowId: VALID_CID });
    const r4 = await post(PORT, '/route', { capability: 'security scan', deadline: '2026-10-08' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(a4)).toString('base64') });
    record('binding-evaluator-boundary-preserved', r4.status === 200, 'evaluator verdict on valid escrow -> ' + r4.status + ' ' + JSON.stringify(r4.body || {}).slice(0, 100));

    // 5. Seller signing a BUYER action against the VALID escrow -> 401 (role
    //    boundary intact: seller key is not the configured buyer).
    const a5 = await signAccessAuth(SELLER_KEY, 'buyer', 'execute', 91005, { digest: VALID_CID, escrowId: VALID_CID });
    const r5 = await post(PORT, '/route', { capability: 'security scan', deadline: '2026-10-08' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(a5)).toString('base64') });
    record('binding-seller-cannot-act-as-buyer', r5.status === 401, 'seller key signed as buyer -> ' + r5.status);

    const failed = results.filter(r => !r.pass);
    console.log('\n==== RESULT: ' + (results.length - failed.length) + '/' + results.length + ' PASS ====');
    process.exitCode = failed.length ? 1 : 0;
    // Explicit exit: the spawned server's stdio pipes keep the parent's event
    // loop alive after killServer() on Windows; exit deterministically so the
    // run reports its real result instead of hanging at the shell timeout.
    process.exit(process.exitCode || 0);
  } finally {
    killServer();
  }
})().catch(e => { console.error('TEST HARNESS FAIL', e.message); killServer(); process.exit(1); });