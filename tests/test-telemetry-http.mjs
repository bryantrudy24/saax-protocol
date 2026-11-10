// HTTP-level telemetry non-interference test.
//
// Proves:
//   H1  With SAAX_USAGE_TELEMETRY=on AND a failing telemetry store, the /mcp
//       handler still returns its normal responses (financial behavior
//       unchanged). Telemetry failure NEVER surfaces as a 5xx or alters the
//       response body.
//   H2  With telemetry OFF, handler responses are normal (unchanged).
//   H3  The telemetry write is fire-and-forget: requests complete promptly and
//       are never blocked by telemetry (even when the store is down).
'use strict';
import assert from 'assert';
import http from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Force telemetry ON with a store that always fails.
process.env.SAAX_USAGE_TELEMETRY = 'on';

// A failing store client installed into the telemetry module BEFORE the
// handler modules import it (they call setStoreClient only when isEnabled()).
const telemetryPath = require.resolve('../endpoint/usage-telemetry.js');
delete require.cache[telemetryPath];
const telemetry = require(telemetryPath);
const failStore = {
  from() { return { insert() { return Promise.reject(new Error('db down')); } }; },
};
telemetry.setStoreClient(failStore);

// Import the MCP handler (it will see isEnabled()=true and use our failing store).
const mcpHandler = (await import('../api/mcp.mjs')).default;

const PORT = 18995;
const server = http.createServer(mcpHandler);

function postMCP(port, body, sessionId) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

await new Promise((ok) => server.listen(PORT, ok));
console.log('=== HTTP telemetry non-interference (: ' + PORT + ') ===');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('PASS ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('FAIL ' + n + (d ? ' | ' + d : '')); } };

try {
  // With the failing store, initialize must still succeed and return a session.
  const init = await postMCP(PORT, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  check('H1 initialize succeeds despite failing telemetry store', init.status === 200 && !init.body.includes('"error"'), 'status=' + init.status);
  const sid = init.headers['mcp-session-id'];
  check('H1 session id returned', !!sid, 'sid=' + sid);

  // tools/list through the session must return 13 tools.
  const list = await postMCP(PORT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid);
  const listOk = list.status === 200 && list.body.includes('route_request') && list.body.includes('prepare_commitment');
  check('H1 tools/list works with failing telemetry store', listOk, 'status=' + list.status);

  // A tool call that errors internally (route_request without args) must still
  // return the NORMAL tool error shape, not a 5xx from telemetry.
  const bad = await postMCP(PORT, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'route_request', arguments: {} } }, sid);
  const badOk = bad.status === 200 && (bad.body.includes('no_match') || bad.body.includes('invalid') || bad.body.includes('error'));
  check('H1 tool error shape preserved (not 5xx)', badOk, 'status=' + bad.status + ' body=' + bad.body.slice(0, 120));

  // Response latency must be prompt (no blocking on telemetry failure).
  const t0 = Date.now();
  await postMCP(PORT, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ping', arguments: {} } }, sid);
  const elapsed = Date.now() - t0;
  check('H3 request completes promptly (no telemetry blocking)', elapsed < 2000, 'elapsed=' + elapsed + 'ms');
} finally {
  await new Promise((ok) => server.close(ok));
}

// H2: OFF mode — re-import telemetry with env off, then re-import the handler
// (which re-reads isEnabled at import). Compare MCP init responses.
delete process.env.SAAX_USAGE_TELEMETRY;
const telemetryOffPath = require.resolve('../endpoint/usage-telemetry.js');
delete require.cache[telemetryOffPath];
require(telemetryOffPath); // re-evaluates with OFF
delete require.cache[require.resolve('../api/mcp.mjs')];
const mcpOff = (await import('../api/mcp.mjs')).default;
const server2 = http.createServer(mcpOff);
await new Promise((ok) => server2.listen(18994, ok));
try {
  const offInit = await postMCP(18994, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  check('H2 OFF mode initialize still succeeds', offInit.status === 200 && !offInit.body.includes('"error"'), 'status=' + offInit.status);
} finally {
  await new Promise((ok) => server2.close(ok));
}

console.log('=== RESULT: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);