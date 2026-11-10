// GET /mcp streaming (SSE resume) behavior test.
//
// streamable-http: a client that initialized a session opens a GET SSE stream
// (Accept: text/event-stream + Mcp-Session-Id) to receive server-initiated
// notifications / resumption events. This test proves:
//   G1  Plain GET without Accept: text/event-stream -> friendly JSON info (200).
//   G2  GET with Accept: text/event-stream but NO session -> 400/404 (SDK
//       session validation; no session = cannot stream).
//   G3  GET with a VALID session + Accept: text/event-stream -> SSE stream
//       opens (200, content-type text/event-stream) and stays open until the
//       client disconnects; the session remains usable afterward.
//   G4  A long-lived GET on session A does NOT block POSTs on session B
//       (per-session transport isolation — the 60s-timeout cascade is fixed).
import http from 'http';
import handler from '../api/mcp.mjs';

const PORT = 18993;
const server = http.createServer(handler);
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('PASS ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('FAIL ' + n + (d ? ' | ' + d : '')); } };

function post(body, sessionId) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

await new Promise((ok) => server.listen(PORT, ok));
console.log('=== GET /mcp streaming behavior (: ' + PORT + ') ===');

try {
  // G1: plain GET -> info JSON.
  const info = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d, type: res.headers['content-type'] }));
    });
    req.on('error', reject); req.end();
  });
  check('G1 plain GET -> friendly JSON info', info.status === 200 && info.body.includes('streamable-http'), 'status=' + info.status + ' type=' + info.type);

  // G2: GET with SSE accept but no session -> rejected (no session to stream).
  const noSess = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'GET', headers: { accept: 'text/event-stream' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.end();
  });
  check('G2 GET SSE without session rejected', noSess.status === 400 || noSess.status === 404, 'status=' + noSess.status);

  // Set up two sessions.
  const a = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'A', version: '1' } } });
  const sidA = a.headers['mcp-session-id'];
  const b = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'B', version: '1' } } });
  const sidB = b.headers['mcp-session-id'];
  check('G3 sessions A/B established', !!sidA && !!sidB, 'A=' + (sidA || '?') + ' B=' + (sidB || '?'));

  // G3: open a GET SSE stream on session A; it should 200 with event-stream.
  const sseRes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': sidA } }, (res) => {
      resolve({ status: res.statusCode, type: res.headers['content-type'], res });
    });
    req.on('error', reject); req.end();
  });
  check('G3 GET SSE on valid session opens', sseRes.status === 200 && String(sseRes.type || '').includes('text/event-stream'), 'status=' + sseRes.status + ' type=' + sseRes.type);

  // G4: while A's SSE is open, B can still POST (tools/list) without blockage.
  const bList = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, sidB);
  check('G4 B works while A holds an SSE stream', bList.status === 200 && bList.body.includes('route_request'), 'status=' + bList.status);

  // G3b: close A's SSE stream; A session still usable afterward.
  sseRes.res.destroy();
  await new Promise((r) => setTimeout(r, 100));
  const aList = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, sidA);
  check('G3b A session usable after its SSE stream closes', aList.status === 200 && aList.body.includes('route_request'), 'status=' + aList.status);
} finally {
  await new Promise((ok) => server.close(ok));
}

console.log('=== RESULT: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);