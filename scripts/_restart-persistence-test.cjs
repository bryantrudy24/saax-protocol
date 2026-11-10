// SAAX external-testnet-pilot preparation — Gap 3: persistence-boundary restart test.
//
// Proves, at the escrow-access acceptance boundary:
//   1. An accepted operation is DURABLE (JSON file, atomic rename) — the record
//      survives a server restart.
//   2. An identical authenticated retry after restart returns the RECORDED
//      result (idempotent) — the external effect is NOT repeated.
//   3. A changed payload under the SAME nonce after restart is REJECTED
//      (conflict) — the nonce was consumed at durable acceptance.
//   4. A restart cannot cause duplicate execution — the same nonce cannot be
//      re-accepted (and thus the execute/release path cannot be re-triggered),
//      because the ledger row is durable and the retry returns idempotent.
//
// Uses a dedicated ledger file and port so the live instance (8899) is not
// disturbed. Status action ('request status') needs no new funding.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http: vhttp } = require('viem');
const { baseSepolia } = require('viem/chains');
require('dotenv').config();

const REPO = path.join(__dirname, '..');
const PORT = 8896;
const RPC = 'https://sepolia.base.org';
const CUSTODY = process.env.SAAX_CUSTODY_ADDRESS || '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const CID = process.env.SAAX_TEST_ESCROW_CID || (() => {
  try { return fs.readFileSync(path.join(REPO, 'data', 'harness-funded-cid.txt'), 'utf8').trim(); } catch (e) { return ''; }
})();
const LEDGER = path.join(REPO, 'data', 'test-restart-ledger.json');
const BUYER_KEY = process.env.SAAX_TEST_BUYER_KEY;
const BUYER_ADDR = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';

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

async function signAccess(client, role, action, nonce) {
  const payload = { role, commitmentDigest: CID, escrowId: CID, custody: CUSTODY, chainId: '84532', action, nonce: String(nonce), expiry: String(Math.floor(Date.now() / 1000) + 3600) };
  const sig = await client.signTypedData({
    domain: ACCESS_DOMAIN, types: ACCESS_TYPES, primaryType: 'EscrowAccess',
    message: {
      role, commitmentDigest: CID, escrowId: CID, custody: CUSTODY,
      chainId: BigInt(84532), action, nonce: BigInt(nonce), expiry: BigInt(payload.expiry),
    },
  });
  return { payload, signature: { v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) } };
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

async function startServer(opts) {
  opts = opts || {};
  if (!opts.keepLedger) { try { fs.unlinkSync(LEDGER); } catch (e) {} }
  const env = Object.assign({}, process.env, {
    SAAX_CHAIN_ID: '84532', SAAX_ESCROW_BACKED: '1', SAAX_CUSTODY_ADDRESS: CUSTODY,
    SAAX_EAS_MODE: 'live', SAAX_RPC_URL: RPC, SAAX_X402_MODE: 'self', SAAX_HOST: '127.0.0.1',
    SAAX_PORT: String(PORT), SAAX_ESCROW_LEDGER: LEDGER, SAAX_TEST_BUYER_ADDRESS: BUYER_ADDR,
  });
  const child = spawn('node', ['endpoint/route-server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const r = await post(PORT, { capability: 'x', budget: 1 }); if (r) break; } catch (e) {}
  }
  return { child, out };
}

async function stopServer(srv) { srv.child.kill(); await sleep(700); }

async function main() {
  if (!CID) { console.log('FAIL no CID'); process.exit(1); }
  if (!BUYER_KEY) { console.log('FAIL buyer key missing'); process.exit(1); }
  const account = privateKeyToAccount(BUYER_KEY);
  const client = createWalletClient({ account, chain: baseSepolia, transport: vhttp(RPC) });
  console.log('Gap-3 persistence restart test — escrow ' + CID);

  // ---- Phase 1: accept durably ----------------------------------------------
  let srv = await startServer();
  const nonce = 77001;
  const auth = await signAccess(client, 'buyer', 'request status', nonce);
  const header = { 'x-saax-access-auth': Buffer.from(JSON.stringify(auth)).toString('base64') };
  const r1 = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, header);
  record('P1 accepted durably (fresh nonce)', r1.status === 200 && r1.body && r1.body.accepted && r1.body.accepted.status === 'accepted', 'status=' + r1.status + ' ' + JSON.stringify(r1.body || {}).slice(0, 130));
  const ledgerAfterAccept = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  record('P1b ledger row persisted (atomic file)', !!ledgerAfterAccept.operations[String(nonce)] && ledgerAfterAccept.operations[String(nonce)].status === 'accepted', 'nonce=' + nonce + ' status=' + (ledgerAfterAccept.operations[String(nonce)] || {}).status);
  await stopServer(srv);

  // ---- Phase 2: restart with the SAME ledger (KEEP the ledger file) ---------
  srv = await startServer({ keepLedger: true });

  // identical retry after restart -> idempotent, recorded result, no re-accept
  const r2 = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, header);
  record('P2 identical retry after restart returns recorded result (idempotent, no re-execute)', r2.status === 200 && r2.body && r2.body.idempotent === true && r2.body.recorded && r2.body.recorded.nonce === String(nonce), 'status=' + r2.status + ' ' + JSON.stringify(r2.body || {}).slice(0, 200));
  // changed payload under SAME nonce -> conflict (same action, different escrowId
  // = different payloadHash; still a valid signature; status action needs no
  // funding so it reaches the acceptance layer where the nonce conflict is hit)
  const authChanged = await signAccess(client, 'buyer', 'request status', nonce); // SAME nonce
  // different payloadHash requires a VALID signature over the changed fields:
  // re-sign the same nonce with a different escrowId (status action, no funding)
  const diffEscrow = '0x' + '77'.repeat(32);
  const authChanged2 = await client.signTypedData({
    domain: ACCESS_DOMAIN, types: ACCESS_TYPES, primaryType: 'EscrowAccess',
    message: {
      role: 'buyer', commitmentDigest: diffEscrow, escrowId: diffEscrow, custody: CUSTODY,
      chainId: BigInt(84532), action: 'request status', nonce: BigInt(nonce), expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    },
  });
  const sigC = authChanged2;
  const finalChanged = {
    payload: { role: 'buyer', commitmentDigest: diffEscrow, escrowId: diffEscrow, custody: CUSTODY, chainId: '84532', action: 'request status', nonce: String(nonce), expiry: String(Math.floor(Date.now() / 1000) + 3600) },
    signature: { v: parseInt(sigC.slice(130, 132), 16), r: '0x' + sigC.slice(2, 66), s: '0x' + sigC.slice(66, 130) },
  };
  const r3 = await post(PORT, { capability: 'data pipeline', deadline: '2026-12-01T00:00:00Z' }, { 'x-saax-access-auth': Buffer.from(JSON.stringify(finalChanged)).toString('base64') });
  record('P3 changed payload same nonce rejected (conflict)', r3.status === 409 || (r3.body && (r3.body.error || '').includes('conflict')), 'status=' + r3.status + ' ' + JSON.stringify(r3.body || {}).slice(0, 200));
  // ledger still has the record with status accepted (not re-executed)
  const ledgerAfterRestart = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  record('P4 ledger intact after restart, status accepted', ledgerAfterRestart.operations[String(nonce)] && ledgerAfterRestart.operations[String(nonce)].status === 'accepted', 'status=' + (ledgerAfterRestart.operations[String(nonce)] || {}).status);

  await stopServer(srv);
  console.log('\nRESULT: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR ' + (e && e.stack || e)); process.exit(1); });