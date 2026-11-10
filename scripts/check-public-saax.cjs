'use strict';
// Read-only protocol checks: no creation, prepare, accept, settlement or custody.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = (process.argv[2] || 'https://saax-protocol.com').replace(/\/$/, '');
const out = process.argv[3] || '.output-public-check.json';
async function get(route) {
  const r = await fetch(base + route, { signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch (_) { body = { text: text.slice(0,1000) }; }
  return { status: r.status, body };
}
async function mcp(body) {
  const r = await fetch(base + '/mcp', { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const text = await r.text(); let data;
  try { data = JSON.parse(text); } catch (_) { const lines = text.split('\n').filter(l => l.startsWith('data:'));
    data = JSON.parse(lines[lines.length - 1].slice(5).trim()); }
  return { status: r.status, body: data };
}
async function main() {
  const checks = { base, checkedAt: new Date().toISOString() };
  checks.profile = await get('/.well-known/saax.json');
  const p = checks.profile.body;
  const local = JSON.parse(fs.readFileSync(path.join(__dirname, '../spec/examples/discovery/profile-live-signed.json')));
  const pin = local.signingKeys[0];
  const parts = p.signature.jws.split('.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  checks.profileSignature = header.alg === 'EdDSA' && header.kid === pin.id &&
    crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: pin.jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  checks.profilePreserved = p.signature.jws === local.signature.jws;
  checks.mcpInitialize = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'saax-readonly-release-check', version: '1.0' } } });
  checks.mcpTools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  checks.toolNames = (checks.mcpTools.body.result && checks.mcpTools.body.result.tools || []).map(t => t.name);
  checks.ping = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
  checks.protocolInfo = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_protocol_info', arguments: {} } });
  checks.receipt = await get('/receipt?txHash=0x7ac2efe8c440762c21aacab2d8fc055b0195a3685b6c8a6ab475077fc4b94e75&rail=x402');
  const options = await fetch(base + '/route', { method: 'OPTIONS', signal: AbortSignal.timeout(15000) });
  checks.routeOptions = { status: options.status, allow: options.headers.get('access-control-allow-methods') };
  checks.pass = checks.profile.status === 200 && checks.profileSignature && checks.profilePreserved &&
    !!checks.mcpInitialize.body.result && checks.toolNames.includes('prepare_commitment') &&
    checks.toolNames.includes('accept_commitment') && !!checks.ping.body.result && !!checks.protocolInfo.body.result;
  fs.writeFileSync(out, JSON.stringify(checks, null, 2) + '\n');
  console.log(JSON.stringify({ base, pass: checks.pass, toolNames: checks.toolNames, receipt: checks.receipt,
    profileSignature: checks.profileSignature, profilePreserved: checks.profilePreserved }, null, 2));
  if (!checks.pass) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
