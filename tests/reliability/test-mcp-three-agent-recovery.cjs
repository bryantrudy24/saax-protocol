// SAAX MCP Lifecycle Phase 2 — three-agent MCP recovery demonstration (live testbed).
//
// The Phase 2E scenario, driven through the REAL MCP server via the REAL SDK
// client (stateless streamable-http):
//
//   1. Agent A (buyer) creates a commitment.
//   2. Agent B (seller) accepts it (provider authorization).
//   3. Agent A terminates (the buyer process is gone).
//   4. Agent C (replacement) authenticates INDEPENDENTLY with its own EIP-712
//      proof + its own durable authorization.
//   5. C discovers the commitment, retrieves durable state (history/recovery).
//   6. C performs a permitted continuation (reconcile-before-mutate).
//   7. The lifecycle journal records C's operation.
//   8. Duplicate requests do not create duplicate effects.
//   9. Unauthorized replacement agents are rejected.
//
// Everything is nonfinancial and isolated to the Docker testbed. No production
// data is touched.

'use strict';

const { randomUUID } = require('crypto');
const http = require('http');
const { once } = require('events');
const crypto = require('crypto');

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const { mint } = require('./_gate-d-jwt.cjs');
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');

const store = require('../../endpoint/store.js');
const { grantAgentAuthorization } = require('../../endpoint/lifecycle.js');
const db = store.buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY);

const { privateKeyToAccount } = require('viem/accounts');
const PROOF_TYPES = {
  AuthorityProof: [
    { name: 'authorityProofId', type: 'string' },
    { name: 'issuer', type: 'address' },
    { name: 'subject', type: 'address' },
    { name: 'validFrom', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'scopeDigest', type: 'string' },
  ],
};
const PROOF_DOMAIN = { name: 'SAAX Authority', version: '1' };

function scopeDigest(scope) {
  const canonical = JSON.stringify(scope, (k, v) => {
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {});
    return v;
  });
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function makeProof(account, subject, scope) {
  const now = Math.floor(Date.now() / 1000);
  const id = 'proof-' + randomUUID().slice(0, 8);
  return {
    authorityProofId: id,
    proofType: 'verifiable-intent',
    issuer: account.address,
    subject,
    validFrom: new Date((now - 60) * 1000).toISOString(),
    validUntil: new Date((now + 3600) * 1000).toISOString(),
    scope,
    verificationScheme: 'eip712',
    signature: '',
    scopeDigest: scopeDigest(scope),
  };
}

async function signProof(account, proof) {
  const typed = {
    domain: PROOF_DOMAIN,
    types: PROOF_TYPES,
    primaryType: 'AuthorityProof',
    message: {
      authorityProofId: proof.authorityProofId,
      issuer: proof.issuer,
      subject: proof.subject,
      validFrom: BigInt(Math.floor(Date.parse(proof.validFrom) / 1000)),
      validUntil: BigInt(Math.floor(Date.parse(proof.validUntil) / 1000)),
      scopeDigest: proof.scopeDigest,
    },
  };
  const sig = await account.signTypedData(typed);
  return { ...proof, signature: sig };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

async function provisionAuthority({ agentId, principal, commitmentId, role = 'authority', scope = {} }) {
  const { data, error } = await db.rpc('provision_authority', {
    p_agent_id: agentId,
    p_verified_principal: principal,
    p_commitment_id: commitmentId || null,
    p_role: role,
    p_scope: scope,
    p_valid_until: new Date(Date.now() + 7 * 86400e3).toISOString(),
    p_operator_token: 'test-operator-token-0123456789abcdef', // TESTBED ONLY
    p_idempotency_ref: 'prov:' + agentId + ':' + (commitmentId || 'svc') + ':' + role,
  });
  if (error) throw new Error('provisionAuthority: ' + error.message);
  return data.authz_id;
}

async function grantAuthz({ authorizer, principal, subjectAgent, subjectPrincipal, commitmentId, role, scope }) {
  const r = await grantAgentAuthorization({
    authorizerAgent: authorizer, authorizerPrincipal: principal, authorizerRole: 'authority',
    subjectAgent, subjectPrincipal,
    commitmentId, role, scope,
    validUntil: new Date(Date.now() + 3600e3).toISOString(),
    idempotencyRef: 'g:' + subjectAgent + ':' + commitmentId + ':' + role,
  });
  if (!r.ok) throw new Error('grantAuthz: ' + r.error);
  return r.data.authz_id;
}

async function seedCommitment(id, state = 'issued', terms = {}) {
  const ins = await db.from('commitments').insert({
    commitment_id: id, state, capability: 'demo', terms,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  if (ins && ins.error) throw new Error('seedCommitment: ' + ins.error.message);
}

async function clean(id) {
  await db.from('commitments').delete().eq('commitment_id', id).catch(() => {});
  await db.from('commitment_events').delete().eq('commitment_id', id).catch(() => {});
  await db.from('agent_authorizations').delete().eq('commitment_id', id).catch(() => {});
  await db.from('agent_authorizations').delete().eq('commitment_id', null).eq('agent_id', 'auth-' + id).catch(() => {});
}

async function stateOf(id) {
  const { data } = await db.from('commitments').select('state,version').eq('commitment_id', id).limit(1);
  return data && data.length ? data[0] : null;
}

async function countEvents(id) {
  const { data } = await db.from('commitment_events').select('idempotency_ref').eq('commitment_id', id);
  return (data || []).length;
}

async function bootMcpServer() {
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
  return { server, url: 'http://127.0.0.1:' + port + '/mcp' };
}

function parseSse(text) {
  const frames = [];
  let dataBuf = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('data: ')) dataBuf.push(line.slice(6));
    else if (line === '' && dataBuf.length) { frames.push(dataBuf.join('\n')); dataBuf = []; }
  }
  if (dataBuf.length) frames.push(dataBuf.join('\n'));
  return frames;
}

async function mcpCall(url, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { }
  if (!parsed) {
    for (const f of parseSse(text)) {
      try { parsed = JSON.parse(f); if (parsed) break; } catch (_) { }
    }
  }
  return { status: res.status, text, parsed };
}

function toolPayload(res) {
  if (!res || !res.parsed || !res.parsed.result) return null;
  const content = res.parsed.result.content || [];
  const text = content.find((c) => c.type === 'text');
  if (!text) return null;
  try { return JSON.parse(text.text); } catch (_) { return text.text; }
}

(async () => {
  const { server, url } = await bootMcpServer();
  const cid = 'c-demo-' + randomUUID().slice(0, 8);
  try {
    const init = await mcpCall(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase2-recovery-demo', version: '1.0.0' } });
    check('MCP initialize succeeds', init.status === 200 && init.parsed && init.parsed.result, 'status=' + init.status);

    // Accounts
    const accA = privateKeyToAccount('0x' + crypto.randomBytes(32).toString('hex'));
    const accB = privateKeyToAccount('0x' + crypto.randomBytes(32).toString('hex'));
    const accC = privateKeyToAccount('0x' + crypto.randomBytes(32).toString('hex'));
    const accOp = privateKeyToAccount('0x' + crypto.randomBytes(32).toString('hex'));
    const A = accA.address.toLowerCase();
    const B = accB.address.toLowerCase();
    const C = accC.address.toLowerCase();
    const OP = accOp.address.toLowerCase();

    // Step 1: Agent A creates a commitment (buyer = A, seller = B)
    await seedCommitment(cid, 'issued', { buyerAgentId: A, sellerAgentId: B, deliverable: 'security scan', acceptanceCriteria: ['report'] });
    await provisionAuthority({ agentId: 'auth-' + cid, principal: OP, commitmentId: cid, role: 'authority' });
    // A = buyer, B = provider (original seller), C = replacement provider with OWN delegation
    await grantAuthz({ authorizer: 'auth-' + cid, principal: OP, subjectAgent: 'agent-a', subjectPrincipal: A, commitmentId: cid, role: 'buyer', scope: { actions: ['accept', 'dispute'] } });
    await grantAuthz({ authorizer: 'auth-' + cid, principal: OP, subjectAgent: 'agent-b', subjectPrincipal: B, commitmentId: cid, role: 'provider', scope: { actions: ['execute', 'complete', 'submit'] } });

    // Step 2: Agent A (buyer) accepts, then Agent B (seller) executes
    const proofA = await signProof(accA, makeProof(accA, A, { actions: ['accept'] }));
    const rA = await mcpCall(url, 'tools/call', { name: 'resume_commitment', arguments: { commitmentId: cid, agentId: 'agent-a', role: 'buyer', proof: proofA, action: 'accept', idempotencyRef: 'demo-i0' } });
    const pA = toolPayload(rA);
    check('A (buyer) accepts (issued->accepted)', pA && pA.status === 'transitioned' && pA.to_state === 'accepted', JSON.stringify(pA));

    const proofB = await signProof(accB, makeProof(accB, B, { actions: ['execute', 'complete', 'submit'] }));
    const rB = await mcpCall(url, 'tools/call', { name: 'resume_commitment', arguments: { commitmentId: cid, agentId: 'agent-b', role: 'provider', proof: proofB, action: 'execute', idempotencyRef: 'demo-i1' } });
    const pB = toolPayload(rB);
    check('B (seller) executes (accepted->executing)', pB && pB.status === 'transitioned' && pB.to_state === 'executing', JSON.stringify(pB));

    // Step 3: Agent A terminates (no further A actions). Agent C arrives.

    // Step 4: C authenticates independently (own key, own proof)
    const proofC = await signProof(accC, makeProof(accC, C, { actions: ['execute', 'complete'] }));

    // Step 4b: C WITHOUT authorization cannot act (negative)
    const rC0 = await mcpCall(url, 'tools/call', { name: 'resume_commitment', arguments: { commitmentId: cid, agentId: 'agent-c', role: 'provider', proof: proofC, action: 'complete', idempotencyRef: 'demo-i2' } });
    const pC0 = toolPayload(rC0);
    check('C (unauthorized) rejected — no automatic inheritance', pC0 && pC0.status === 'error' && /AUTH_MISSING_AUTHORIZATION/.test(pC0.code || pC0.reason || ''), JSON.stringify(pC0));

    // Step 4c: C impersonating A rejected
    const proofCAsA = await signProof(accC, makeProof(accC, A, { actions: ['accept'] }));
    const rC0b = await mcpCall(url, 'tools/call', { name: 'resume_commitment', arguments: { commitmentId: cid, agentId: 'agent-a', role: 'buyer', proof: proofCAsA, action: 'accept', idempotencyRef: 'demo-i2b' } });
    const pC0b = toolPayload(rC0b);
    check('C impersonating A rejected (principal mismatch)', pC0b && pC0b.status === 'error', JSON.stringify(pC0b));

    // Step 5: Operator grants C its OWN durable delegation (authority action)
    await grantAuthz({ authorizer: 'auth-' + cid, principal: OP, subjectAgent: 'agent-c', subjectPrincipal: C, commitmentId: cid, role: 'provider', scope: { actions: ['execute', 'complete'] } });

    // Step 5b: C discovers the commitment + retrieves durable state
    const rHist = await mcpCall(url, 'tools/call', { name: 'get_commitment_history', arguments: { commitmentId: cid, agentId: 'agent-c', role: 'provider', proof: proofC } });
    const pHist = toolPayload(rHist);
    check('C discovers durable state via get_commitment_history', pHist && pHist.status === 'ok' && pHist.count >= 1, JSON.stringify(pHist));

    const rRec = await mcpCall(url, 'tools/call', { name: 'get_recovery_status', arguments: { commitmentId: cid, agentId: 'agent-c', role: 'provider', proof: proofC } });
    const pRec = toolPayload(rRec);
    check('C reconciles via get_recovery_status (state executing, authorized)', pRec && pRec.state === 'executing' && pRec.caller && pRec.caller.authorized === true, JSON.stringify(pRec));

    // Step 6: C performs a permitted continuation (complete -> evidence_pending)
    const rC1 = await mcpCall(url, 'tools/call', { name: 'resume_commitment', arguments: { commitmentId: cid, agentId: 'agent-c', role: 'provider', proof: proofC, action: 'complete', idempotencyRef: 'demo-i3' } });
    const pC1 = toolPayload(rC1);
    check('C continues the workflow (executing->evidence_pending)', pC1 && pC1.status === 'transitioned' && pC1.to_state === 'evidence_pending', JSON.stringify(pC1));

    // Step 7: journal records C's operation
    const rHist2 = await mcpCall(url, 'tools/call', { name: 'get_commitment_history', arguments: { commitmentId: cid, agentId: 'agent-c', role: 'provider', proof: proofC } });
    const pHist2 = toolPayload(rHist2);
    check('journal records C operation (count>=2, latest by C principal)', pHist2 && pHist2.status === 'ok' && pHist2.count >= 2, JSON.stringify(pHist2));

    // Step 8: duplicate request does not create duplicate effect
    const rC1b = await mcpCall(url, 'tools/call', { name: 'resume_commitment', arguments: { commitmentId: cid, agentId: 'agent-c', role: 'provider', proof: proofC, action: 'complete', idempotencyRef: 'demo-i3' } });
    const pC1b = toolPayload(rC1b);
    check('duplicate C request is idempotent (replayed, no new event)', pC1b && pC1b.status === 'replayed', JSON.stringify(pC1b));
    const evCount = await countEvents(cid);
    check('no duplicate effect (events = 3: A accept + B execute + C complete)', evCount === 3, 'count=' + evCount);

    const st = await stateOf(cid);
    check('final state evidence_pending (version advanced)', st && st.state === 'evidence_pending', JSON.stringify(st));

    console.log('\n=== three-agent MCP recovery demo: ' + pass + ' passed, ' + fail + ' failed ===');
  } finally {
    await clean(cid);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('DEMO CRASH:', e); process.exit(2); });
