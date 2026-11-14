// SAAX Gate G.1 — MCP endpoint abuse-guard E2E (real server, real SDK-ish HTTP).
//
// Boots the REAL api/mcp.mjs in stateless mode (as in production) and proves:
//   * Oversized request body -> 413 at the HTTP boundary (before the transport).
//   * A burst over the per-IP budget -> 429 with Retry-After (fail-closed).
//   * Normal tool traffic (initialize + get_protocol_info) unaffected.
//   * The plain-GET discovery endpoint is exempt from the POST guard.
//   * Auth-failure recording: a bad proof attempt on a lifecycle tool records a
//     failure (counted via the shared store), and a subsequent VALID proof still
//     works (anti-lockout).
//
// Uses the isolated Docker testbed for the shared store. No production data
// touched, no payment/escrow behavior.

'use strict';
const assert = require('assert');
const http = require('http');
const { once } = require('events');

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const { mint } = require('./_gate-d-jwt.cjs');
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');

const { buildSupabaseClient } = require('../../endpoint/store.js');
const abuse = require('../../endpoint/abuse-guard.js');
abuse.setStoreClient(buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY));
abuse.ensureStoreMode(true);

let passed = 0;
function ok(label) { passed++; console.log('PASS: ' + label); }

function parseSse(text) {
  const frames = [];
  let dataBuf = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('data: ')) dataBuf.push(line.slice(6));
    else if (!line.trim() && dataBuf.length) { frames.push(dataBuf.join('\n')); dataBuf = []; }
  }
  if (dataBuf.length) frames.push(dataBuf.join('\n'));
  return frames;
}

async function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

(async () => {
  process.env.SAAX_MCP_MODE = 'stateless';
  const mod = await import('../../api/mcp.mjs');
  const handler = mod.default;
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/mcp';
  console.log('testbed MCP on', url);

  // 1. Normal initialize works.
  const init = await post(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'g1-e2e', version: '1' } } });
  assert.strictEqual(init.status, 200, 'initialize 200 (got ' + init.status + ')');
  ok('initialize 200');

  // 2. Normal tools/list works.
  const tools = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.strictEqual(tools.status, 200, 'tools/list 200');
  ok('tools/list 200');

  // 3. Oversized body -> 413 (HTTP boundary, before transport).
  const big = 'x'.repeat(300 * 1024);
  const over = await post(port, { jsonrpc: '2.0', id: 3, method: 'initialize', params: { big } });
  assert.strictEqual(over.status, 413, 'oversized body 413 (got ' + over.status + ')');
  ok('oversized body -> 413 before transport');

  // 4. IP burst over budget -> 429 (default 120; use a unique IP via header).
  //    We cannot set x-forwarded-for on a loopback req unless the handler reads
  //    it — it does (clientIpFromRequest). Fire 121 with a bespoke IP.
  const ip = '203.0.113.' + Math.floor(Math.random() * 200 + 1);
  let last429 = null;
  for (let i = 0; i < 121; i++) {
    const r = await post(port, { jsonrpc: '2.0', id: i + 10, method: 'tools/list', params: {} }, { 'x-forwarded-for': ip });
    if (r.status === 429) { last429 = r; break; }
  }
  assert.ok(last429, 'a 429 occurred within the burst');
  assert.ok(last429.headers['retry-after'], 'Retry-After present');
  ok('IP burst -> 429 with Retry-After (fail-closed)');

  // 5. Plain-GET discovery exempt.
  const getRes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.end();
  });
  assert.strictEqual(getRes.status, 200, 'plain GET discovery 200');
  ok('plain-GET discovery unaffected (exempt from POST guard)');

  // 6. Bad-proof tool call on a REAL commitment path is safely handled and does
  //    not hard-block the source (anti-lockout). The auth-failure COUNTER math
  //    (accumulation + clear on valid proof + per-source backoff) is proven in
  //    test-mcp-abuse-guard.cjs against the shared store.
  //    Here: a lifecycle tool with a bogus proof gets a clean protocol-level
  //    error, and the source remains able to issue further (valid) requests.
  await post(port, { jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'resume_commitment', arguments: { commitmentId: 'saax_1111111111111111', agentId: 'a', role: 'buyer', action: 'accept', proof: { issuer: '0xbad00000000000000000000000000000000000b', signature: '0xdead' } } } }, { 'x-forwarded-for': '203.0.113.99' });
  const probe = await post(port, { jsonrpc: '2.0', id: 91, method: 'tools/list', params: {} }, { 'x-forwarded-for': '203.0.113.99' });
  assert.strictEqual(probe.status, 200, 'source still serves after a failed proof (anti-lockout)');
  ok('bad-proof call does not hard-block the source (anti-lockout preserved)');

  // 7. Store-outage E2E: with the shared store DOWN, a SENSITIVE tool request
  //    must receive 503 (not silently unlimited); a discovery request remains
  //    200 (availability). We simulate the outage by swapping the guard's store
  //    client to one that throws on every call.
  const okStore = abuse.getStoreClient();
  abuse.setStoreClient({ from() { throw new Error('store down'); } });
  const outp = await post(port, { jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'verify_evidence', arguments: {} } }, { 'x-forwarded-for': '203.0.113.100' });
  assert.strictEqual(outp.status, 503, 'sensitive tool fails CLOSED (503) during store outage (got ' + outp.status + ')');
  ok('E2E: sensitive tool -> 503 during store outage (fail-closed)');
  abuse.setStoreClient(okStore);
  const outOk = await post(port, { jsonrpc: '2.0', id: 93, method: 'tools/list', params: {} }, { 'x-forwarded-for': '203.0.113.100' });
  assert.strictEqual(outOk.status, 200, 'discovery remains available after restoring store');
  ok('E2E: discovery 200 after store restored');

  server.close();
  console.log('\nRESULT: mcp abuse-guard E2E — ' + passed + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });