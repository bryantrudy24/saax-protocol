// Gate J.2 - get_supplier_details MCP integration test (real server, stateless).
// Mirrors the proven test-mcp-endpoint-abuse.cjs harness pattern: SAAX_MCP_MODE
// stateless, node:http client (no undici), ephemeral port, clean teardown.
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const { once } = require('events');

process.env.SAAX_MCP_MODE = 'stateless';

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

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const hdrs = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const k of Object.keys(headers)) { if (headers[k] !== undefined && headers[k] !== null) hdrs[k] = headers[k]; }
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: hdrs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

(async () => {
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

  const init = await post(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'j2-supplier', version: '1.0.0' } } });
  assert.strictEqual(init.status, 200, 'initialize 200 (got ' + init.status + ')');
  ok('initialize 200');
  const sid = init.headers['mcp-session-id'];
  ok('initialize sessionless/stateless ok' + (sid ? ' (session issued)' : ''));

  const tl = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': sid });
  const tlFrames = parseSse(tl.body);
  const tlJson = JSON.parse(tlFrames[0]);
  const names = tlJson.result.tools.map((t) => t.name);
  assert.strictEqual(names.length, 26, '26 tools (got ' + names.length + ')');
  ok('26-tool inventory: ' + names.length);
  for (const t of ['get_supplier_details', 'route_request', 'list_capabilities', 'submit_evidence', 'cancel_commitment', 'close_commitment', 'list_disputes', 'resume_commitment']) {
    assert.ok(names.includes(t), 'exposes ' + t);
    ok('exposes ' + t);
  }

  const idx = JSON.parse(require('fs').readFileSync(path.resolve(__dirname, '../../endpoint/mcp-supplier-index.json'), 'utf8'));
  const known = String(idx.suppliers[0].agent_id);
  const call = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_supplier_details', arguments: { supplier_id: known } } }, { 'mcp-session-id': sid });
  const callFrames = parseSse(call.body);
  const callJson = JSON.parse(callFrames[0]);
  const inner = JSON.parse(callJson.result.content[0].text);
  assert.strictEqual(inner.status, 'ok', 'existing supplier ok');
  ok('existing supplier lookup ok (' + inner.supplier.name + ')');
  assert.strictEqual(String(inner.supplier.supplier_id), known, 'supplier_id matches');
  ok('supplier_id matches');

  const miss = await post(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_supplier_details', arguments: { supplier_id: '999999999' } } }, { 'mcp-session-id': sid });
  const missFrames = parseSse(miss.body);
  const missJson = JSON.parse(missFrames[0]);
  const missInner = JSON.parse(missJson.result.content[0].text);
  assert.strictEqual(missInner.status, 'not_found', 'missing supplier not_found');
  ok('missing supplier -> not_found');

  const bad = await post(port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_supplier_details', arguments: { supplier_id: '../../etc/passwd' } } }, { 'mcp-session-id': sid });
  const badFrames = parseSse(bad.body);
  const badJson = JSON.parse(badFrames[0]);
  const badInner = JSON.parse(badJson.result.content[0].text);
  assert.ok(badInner.status === 'not_found' || badInner.status === 'error', 'traversal rejected');
  ok('path-traversal attempt rejected');

  server.close();
  console.log('\nRESULT: supplier-details MCP integration - ' + passed + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });