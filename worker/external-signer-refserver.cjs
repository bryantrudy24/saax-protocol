// external-signer-refserver.js — Phase D4B SEPARATE-PROCESS SYNTHETIC REFERENCE
// signer server. Holds a SYNTHETIC relayer key in ITS OWN process only.
//
// NOT AN HSM. NOT PRODUCTION KEY CUSTODY. This is a reference implementation
// used to exercise the external-signer interface end-to-end on local EVM
// 31337. The key is passed via env (SAAX_EXTERNAL_SIGNER_KEY, synthetic test
// constant) or --key. The worker/API process never holds it; the server signs
// WITHOUT broadcasting and enforces its own policy before signing.
//
// Transport: JSON-RPC 2.0 over localhost HTTP. Methods:
//   signer_identity -> { address, label }
//   signer_sign { req: { to, data, value, gasLimit, gasPrice, nonce, chainId } }
//     -> { signedBytes, txHash, from, nonce }  (policy-validated, no broadcast)
//
// Access: optional bearer token (SAAX_EXTERNAL_SIGNER_TOKEN). The server binds
// to 127.0.0.1 only. Endpoint/IPC access is restricted to the configured port
// and authenticated when a token is set.
//
// Usage:
//   set SAAX_EXTERNAL_SIGNER_KEY=0x<64hex>& node worker/external-signer-refserver.cjs --port 9090 [--token abc]
//
// Exits 0 cleanly on SIGTERM/SIGINT.

'use strict';

const http = require('node:http');
const { Wallet, keccak256 } = require('ethers');

const KEY = process.env.SAAX_EXTERNAL_SIGNER_KEY;
const PORT = Number(process.argv.find((a, i) => a === '--port' && process.argv[i + 1]) ? process.argv[process.argv.indexOf('--port') + 1] : 9090);
const TOKEN = process.argv.find((a) => a === '--token') ? process.argv[process.argv.indexOf('--token') + 1] : (process.env.SAAX_EXTERNAL_SIGNER_TOKEN || null);
const ALLOWED_CHAIN = Number(process.env.SAAX_EXTERNAL_SIGNER_CHAIN || 31337);
const CUSTODY = (process.env.SAAX_EXTERNAL_SIGNER_CUSTODY || '').toLowerCase();
const MAX_GAS_PRICE = process.env.SAAX_EXTERNAL_SIGNER_MAX_GAS_PRICE || '2000000000';
const MAX_GAS_LIMIT = process.env.SAAX_EXTERNAL_SIGNER_MAX_GAS_LIMIT || '800000';
if (process.env.SAAX_EXEC_MODE !== 'local' || ALLOWED_CHAIN !== 31337 || !TOKEN || TOKEN.length < 32 || !KEY) throw new Error('REFERENCE_SIGNER_REQUIRES_EXPLICIT_LOCAL_31337_KEY_AND_TOKEN');
const { Interface } = require('ethers');
const iface = new Interface(require('./d1-abi.js').loadCustodyAbi());
const actions = new Set((process.env.SAAX_ALLOWED_ACTIONS || 'release,refund').split(','));

const wallet = new Wallet(KEY);

function normAddr(a) { return String(a).toLowerCase(); }

function policyCheck(req) {
  // Wallet-style requests may omit `type`/`from`; infer the type from the
  // fee fields (maxFeePerGas -> EIP-1559, gasPrice -> legacy) and default
  // `from` to THIS signer's own identity. The checks below still enforce the
  // configured identity, and the caller re-verifies the recovered sender
  // before any broadcast.
  const normalized = require('./transaction-intent.js').normalizeIntent({ type: req.type ?? (req.maxFeePerGas != null ? 2 : req.gasPrice != null ? 0 : 2), from: req.from ?? wallet.address.toLowerCase(), ...req });
  req = normalized;
  const action = iface.parseTransaction({data:req.data});
  if (!action || !actions.has(action.name)) return {ok:false,code:'EXTERNAL_SIGNER_POLICY_REJECTED:ACTION'};
  if (req.from !== wallet.address.toLowerCase()) return {ok:false,code:'EXTERNAL_SIGNER_WRONG_KEY'};
  // Fail closed: every enforced field must match.
  if (Number(req.chainId) !== ALLOWED_CHAIN) return { ok: false, code: 'EXTERNAL_SIGNER_POLICY_REJECTED:CHAIN', detail: { allowed: ALLOWED_CHAIN, got: req.chainId } };
  if (!CUSTODY || !req.to || normAddr(req.to) !== CUSTODY) return { ok: false, code: 'EXTERNAL_SIGNER_POLICY_REJECTED:DEST', detail: { custody: CUSTODY, got: req.to } };
  if (req.value !== 0n && req.value !== 0 && req.value !== '0') return { ok: false, code: 'EXTERNAL_SIGNER_POLICY_REJECTED:VALUE', detail: String(req.value) };
  const gp = BigInt(req.gasPrice || req.maxFeePerGas || 0);
  const gl = BigInt(req.gasLimit || 0);
  if (gp > BigInt(MAX_GAS_PRICE)) return { ok: false, code: 'EXTERNAL_SIGNER_POLICY_REJECTED:GASPRICE', detail: { max: MAX_GAS_PRICE, got: gp.toString() } };
  if (gl > BigInt(MAX_GAS_LIMIT)) return { ok: false, code: 'EXTERNAL_SIGNER_POLICY_REJECTED:GASLIMIT', detail: { max: MAX_GAS_LIMIT, got: gl.toString() } };
  if (gl <= 0n) return { ok: false, code: 'EXTERNAL_SIGNER_POLICY_REJECTED:GASLIMIT_REQUIRED' };
  return { ok: true };
}

async function handleSign(req) {
  const p = policyCheck(req);
  if (!p.ok) return { error: { code: p.code, message: p.code, data: p.detail } };
  // policyCheck already normalized (type/from inferred, bounds enforced);
  // re-normalizing the RAW request here would lose those defaults. Build the
  // sign payload from the SAME validated normalized request.
  const tx = { ...require('./transaction-intent.js').normalizeIntent({ type: req.type ?? (req.maxFeePerGas != null ? 2 : req.gasPrice != null ? 0 : 2), from: req.from ?? wallet.address.toLowerCase(), ...req }) };
  delete tx.from;
  const signedBytes = await wallet.signTransaction(tx);
  const raw = signedBytes.startsWith('0x') ? signedBytes.slice(2) : signedBytes;
  const txHash = keccak256(Buffer.from(raw, 'hex'));
  return { result: { signedBytes, txHash, from: wallet.address.toLowerCase(), nonce: Number(req.nonce) } };
}

const server = http.createServer(async (req, res) => {
  if (TOKEN) {
    const auth = req.headers.authorization || '';
    // constant-time-ish compare (length + timing not critical for ref server,
    // but we avoid leaking the token in logs and require exact match)
    const want = 'Bearer ' + TOKEN;
    const okTok = auth.length === want.length && require('node:crypto').timingSafeEqual(Buffer.from(auth), Buffer.from(want));
    if (!okTok) { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } })); return; }
  }
  let body = '';
  for await (const part of req) { body += part; if (body.length > 131072) { res.writeHead(413); res.end(); return; } }
  let q;
  try { q = JSON.parse(body); } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: { code: 'BAD_REQUEST' } })); return; }
  let out;
  try {
    if (q.method === 'signer_identity') out = { result: { address: wallet.address.toLowerCase(), label: 'synthetic-reference-signer' } };
    else if (q.method === 'signer_sign') out = await handleSign(q.params.req || {});
    else out = { error: { code: 'METHOD_NOT_FOUND', message: q.method } };
  } catch (e) {
    out = { error: { code: 'EXTERNAL_SIGNER_INTERNAL', message: String(e && e.message || e) } };
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...out }));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('ref-signer listening on 127.0.0.1:' + PORT + ' address=' + wallet.address.toLowerCase() + '\n');
});

function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
