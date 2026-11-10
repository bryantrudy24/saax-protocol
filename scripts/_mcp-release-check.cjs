#!/usr/bin/env node
// Release check: MCP initialize + tools/list on the production endpoint.
// Proves MCP functionality (not merely HTTP 200).
const U = 'https://saax-protocol.com/mcp';
const SID = 'run-' + Date.now();
const H = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-session-id': SID,
};
async function call(method, params) {
  const r = await fetch(U, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const t = await r.text();
  const m = t.match(/data: (.*)/);
  return m ? JSON.parse(m[1]) : { raw: t };
}
(async () => {
  const init = await call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'release-check', version: '1.0' },
  });
  console.log('INIT serverInfo:', JSON.stringify(init.result && init.result.serverInfo));
  const list = await call('tools/list', {});
  const tools = (list.result && list.result.tools || []).map((x) => x.name);
  console.log('TOOL COUNT:', tools.length);
  console.log('has prepare_commitment:', tools.includes('prepare_commitment'));
  console.log('has accept_commitment:', tools.includes('accept_commitment'));
  console.log('ALL TOOLS:', tools.join(', '));
  const ping = await call('ping', {});
  console.log('PING ok:', !!(ping.result && ping.result === undefined || ping.result === null));
})();