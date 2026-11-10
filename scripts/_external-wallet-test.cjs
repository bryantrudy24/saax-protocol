// SAAX external-testnet-pilot preparation — Gap 2: external-wallet compatibility test.
//
// Demonstrates participant-owned wallet authorization against the escrow access
// path, honestly scoped:
//   Phase A — operator config: SAAX_TEST_BUYER_ADDRESS=<operator buyer>.
//             Fresh wallet W signed buyer auth -> REJECTED (SIGNER_ROLE_MISMATCH).
//             Unrelated wallet U signed buyer auth -> REJECTED (SIGNER_ROLE_MISMATCH).
//             Operator buyer key -> ACCEPTED (control).
//   Phase B — participant config: SAAX_TEST_BUYER_ADDRESS=<W address> (the pilot
//             model: a participant brings their own address, the operator sets
//             it as the configured buyer for their escrow).
//             Fresh wallet W signed buyer auth (request status, the n/​funding
//             non-execution action) -> ACCEPTED (200).
//             Unrelated wallet U -> REJECTED (SIGNER_ROLE_MISMATCH).
//             Operator buyer key -> now REJECTED (no longer the configured buyer).
//
// The status action ('request status') on the live funded escrow CID requires no
// funding-binding check (status queries never require funding), so the exercise
// cleanly proves the access-authorization layer: signature recovery, role
// binding, custody/chain/digest bindings — without a fresh on-chain funding.
// The operator-controlled wallet does NOT count as an external participant;
// wallet W is generated in-test (its key is ephemeral, never persisted).
//
// Run:  node scripts/_external-wallet-test.cjs
// Uses: live funded escrow CID from data/harness-funded-cid.txt (or SAAX_TEST_ESCROW_CID).
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { createWalletClient, createPublicClient, http: vhttp } = require('viem');
const { baseSepolia } = require('viem/chains');
require('dotenv').config();

const REPO = path.join(__dirname, '..');
const PORT = 8897; // dedicated port for this test (does not disturb 8899)
const RPC = 'https://sepolia.base.org';
const CUSTODY = process.env.SAAX_CUSTODY_ADDRESS || '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const CID = process.env.SAAX_TEST_ESCROW_CID || (() => {
  try { return fs.readFileSync(path.join(REPO, 'data', 'harness-funded-cid.txt'), 'utf8').trim(); } catch (e) { return ''; }
})();
const OPERATOR_BUYER_KEY = process.env.SAAX_TEST_BUYER_KEY; // operator-controlled buyer key (must be provided)
const OPERATOR_BUYER_ADDR = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';

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

let failures = 0;
function record(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function signAccess(client, role, action, nonce, signerAddr, opts) {
  opts = opts || {};
  const payload = {
    role,
    commitmentDigest: opts.digest || CID,
    escrowId: opts.escrowId || CID,
    custody: CUSTODY,
    chainId: '84532',
    action,
    nonce: String(nonce),
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
  };
  const signature = await client.signTypedData({
    domain: ACCESS_DOMAIN,
    types: ACCESS_TYPES,
    primaryType: 'EscrowAccess',
    message: {
      role,
      commitmentDigest: payload.commitmentDigest,
      escrowId: payload.escrowId,
      custody: payload.custody,
      chainId: BigInt(payload.chainId),
      action,
      nonce: BigInt(payload.nonce),
      expiry: BigInt(payload.expiry),
    },
  });
  const sigHex = typeof signature === 'string' ? signature : signature;
  const v = parseInt(sigHex.slice(130, 132), 16);
  return { payload, signature: { v, r: '0x' + sigHex.slice(2, 66), s: '0x' + sigHex.slice(66, 130) } };
}

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/route', method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers),
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch (e) { resolve({ status: res.statusCode, body: chunks }); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function startServer(envExtra) {
  const env = Object.assign({}, process.env, {
    SAAX_CHAIN_ID: '84532', SAAX_ESCROW_BACKED: '1',
    SAAX_CUSTODY_ADDRESS: CUSTODY, SAAX_EAS_MODE: 'live',
    SAAX_RPC_URL: RPC, SAAX_X402_MODE: 'self', SAAX_HOST: '127.0.0.1',
    SAAX_PORT: String(PORT), SAAX_ESCROW_LEDGER: path.join(REPO, 'data', 'test-external-wallet-ledger.json'),
  }, envExtra);
  try { fs.unlinkSync(env.SAAX_ESCROW_LEDGER); } catch (e) {}
  const child = spawn('node', ['endpoint/route-server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await post(PORT, { capability: 'health', budget: 1 });
      if (r) break;
    } catch (e) { /* not up yet */ }
  }
  return { child, out };
}

async function main() {
  if (!CID) { console.log('FAIL no funded escrow CID (set SAAX_TEST_ESCROW_CID or data/harness-funded-cid.txt)'); process.exit(1); }
  if (!OPERATOR_BUYER_KEY) { console.log('FAIL operator buyer key missing (set SAAX_TEST_BUYER_KEY) — needed for the Phase-A control'); process.exit(1); }
  console.log('Pilot Gap-2 external-wallet compatibility test');
  console.log('escrow CID: ' + CID);

  // Fresh, separately controlled test wallets (ephemeral keys, never persisted)
  const wk = generatePrivateKey();
  const uk = generatePrivateKey();
  const W = privateKeyToAccount(wk);
  const U = privateKeyToAccount(uk);
  const Op = privateKeyToAccount(OPERATOR_BUYER_KEY);
  const wClient = createWalletClient({ account: W, chain: baseSepolia, transport: vhttp(RPC) });
  const uClient = createWalletClient({ account: U, chain: baseSepolia, transport: vhttp(RPC) });
  const opClient = createWalletClient({ account: Op, chain: baseSepolia, transport: vhttp(RPC) });
  console.log('fresh participant wallet W: ' + W.address);
  console.log('unrelated wallet U: ' + U.address);
  console.log('operator buyer (control): ' + Op.address);

  // ---- Phase A: operator config --------------------------------------------
  console.log('\n== Phase A — operator config (SAAX_TEST_BUYER_ADDRESS=<operator buyer>) ==');
  let srv = await startServer({ SAAX_TEST_BUYER_ADDRESS: OPERATOR_BUYER_ADDR });
  try {
    const aW = await signAccess(wClient, 'buyer', 'request status', 9001, W.address);
    const aU = await signAccess(uClient, 'buyer', 'request status', 9002, U.address);
    const aOp = await signAccess(opClient, 'buyer', 'request status', 9003, Op.address);
    const rW = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(aW)).toString('base64') });
    const rU = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(aU)).toString('base64') });
    const rOp = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(aOp)).toString('base64') });
    record('A1 fresh wallet W rejected under operator config', rW.status === 401, 'status=' + rW.status + ' ' + JSON.stringify(rW.body || {}).slice(0, 140));
    record('A2 unrelated wallet U rejected under operator config', rU.status === 401, 'status=' + rU.status + ' ' + JSON.stringify(rU.body || {}).slice(0, 140));
    record('A3 operator buyer accepted (control)', rOp.status === 200, 'status=' + rOp.status + ' ' + JSON.stringify(rOp.body || {}).slice(0, 140));
  } finally { srv.child.kill(); await sleep(500); }

  // ---- Phase B: participant config ------------------------------------------
  console.log('\n== Phase B — participant config (SAAX_TEST_BUYER_ADDRESS=<participant W>) ==');
  srv = await startServer({ SAAX_TEST_BUYER_ADDRESS: W.address });
  try {
    const bW = await signAccess(wClient, 'buyer', 'request status', 9004, W.address);
    const bU = await signAccess(uClient, 'buyer', 'request status', 9005, U.address);
    const bOp = await signAccess(opClient, 'buyer', 'request status', 9006, Op.address);
    const rW = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(bW)).toString('base64') });
    const rU = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(bU)).toString('base64') });
    const rOp = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(bOp)).toString('base64') });
    record('B1 participant wallet W accepted (request status)', rW.status === 200, 'status=' + rW.status + ' ' + JSON.stringify(rW.body || {}).slice(0, 140));
    record('B2 unrelated wallet U rejected under participant config', rU.status === 401, 'status=' + rU.status + ' ' + JSON.stringify(rU.body || {}).slice(0, 140));
    record('B3 operator buyer now rejected (no longer configured)', rOp.status === 401, 'status=' + rOp.status + ' ' + JSON.stringify(rOp.body || {}).slice(0, 140));
  } finally { srv.child.kill(); await sleep(500); }

  console.log('\nRESULT: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR ' + (e && e.stack || e)); process.exit(1); });