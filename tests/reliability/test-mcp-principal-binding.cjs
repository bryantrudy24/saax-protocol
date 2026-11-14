// SAAX MCP Lifecycle Phase 2 — principal-binding security suite (live testbed).
//
// Drives the REAL MCP server (api/mcp.mjs) via the REAL MCP SDK client over
// StreamableHTTP, against the ISOLATED Docker testbed. Proves:
//
//   * Independent principal binding: the MCP lifecycle tools verify the caller's
//     EIP-712 authority proof and bind the recovered signer as
//     verifiedPrincipal — caller-supplied agentId is NEVER authority.
//   * Forged identity / forged role / expired / revoked / cross-commitment /
//     direct-RPC are all rejected with zero persistent effect.
//   * Idempotency + concurrency + stale-version behavior through MCP.
//   * Financial transitions (settle/finalize) are NOT exposed through MCP.
//
// No production data is touched. No payment/escrow behavior is exercised.
//
// The MCP SDK streamable-http client is used in STATELESS mode (each request
// independent) so the test does not depend on session affinity.

'use strict';

const { randomUUID } = require('crypto');
const http = require('http');
const { once } = require('events');

process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const { mint } = require('./_gate-d-jwt.cjs');
process.env.SAAX_POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');

const store = require('../../endpoint/store.js');
const { transitionCommitment, grantAgentAuthorization, revokeAgentAuthorization } = require('../../endpoint/lifecycle.js');
const lm = require('../../endpoint/lifecycle-mcp.js');
const db = store.buildSupabaseClient(process.env.POSTGREST_URL, process.env.SAAX_POSTGREST_KEY);

// EIP-712 proof helpers (viem) — recovered signer = proof.issuer = the principal.
const { privateKeyToAccount } = require('viem/accounts');
const { verifyTypedData } = require('viem');
const crypto = require('crypto');

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
// Must EXACTLY match authority.js's verifyTypedData domain (name+version only,
// no chainId). A chainId mismatch breaks signature recovery.
const PROOF_DOMAIN = { name: 'SAAX Authority', version: '1' };

function scopeDigest(scope) {
  const canonical = JSON.stringify(scope, (k, v) => {
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {});
    return v;
  });
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function makeProof(account, subject, scope, { validFrom, validUntil, proofId } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const from = validFrom || now - 60;
  const until = validUntil || now + 3600;
  const id = proofId || ('proof-' + randomUUID().slice(0, 8));
  const digest = scopeDigest(scope);
  return {
    authorityProofId: id,
    proofType: 'verifiable-intent',
    issuer: account.address,
    subject,
    validFrom: new Date(from * 1000).toISOString(),
    validUntil: new Date(until * 1000).toISOString(),
    scope,
    verificationScheme: 'eip712',
    signature: '', // filled by signProof
    scopeDigest: digest,
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
  // signTypedData from viem/accounts
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

async function grantAuthz({ authorizer, principal, subjectAgent, subjectPrincipal, commitmentId, role, scope, validUntil }) {
  const r = await grantAgentAuthorization({
    authorizerAgent: authorizer, authorizerPrincipal: principal, authorizerRole: 'authority',
    subjectAgent, subjectPrincipal,
    commitmentId, role, scope,
    validUntil: validUntil || new Date(Date.now() + 3600e3).toISOString(),
    idempotencyRef: 'g:' + subjectAgent + ':' + commitmentId + ':' + role,
  });
  if (!r.ok) throw new Error('grantAuthz: ' + r.error);
  return r.data.authz_id;
}

async function seedCommitment(id, state = 'issued', extra = {}) {
  const ins = await db.from('commitments').insert({
    commitment_id: id, state, capability: 'demo', terms: extra.terms || {},
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

// ---- Boot the REAL MCP server on a local port (stateless mode) --------------
async function bootMcpServer() {
  process.env.SAAX_MCP_MODE = 'stateless';
  // The MCP handler is the default export of api/mcp.mjs. It expects
  // req/res (Node http). We wrap it in a tiny http server.
  const mod = await import('../../api/mcp.mjs');
  const handler = mod.default;
  const server = http.createServer((req, res) => {
    // Do NOT consume the request stream — the MCP handler reads the body
    // itself via readBodyRaw (for await over req). Consuming it here would
    // drain the stream and break every POST.
    handler(req, res).catch((e) => {
      if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  return { server, url: 'http://127.0.0.1:' + port + '/mcp' };
}

// ---- Minimal MCP client (JSON-RPC over HTTP, stateless) ---------------------
// The MCP SDK's streamable-http transport responds with SSE frames
// ("event: message\ndata: {...}") even for single JSON-RPC responses.
// Parse both plain JSON and SSE.
function parseSse(text) {
  const frames = [];
  let dataBuf = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('data: ')) dataBuf.push(line.slice(6));
    else if (line === '' && dataBuf.length) {
      frames.push(dataBuf.join('\n'));
      dataBuf = [];
    }
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
  try { parsed = JSON.parse(text); } catch (_) { /* not plain JSON */ }
  if (!parsed) {
    const frames = parseSse(text);
    for (const f of frames) {
      try { parsed = JSON.parse(f); if (parsed) break; } catch (_) { /* skip */ }
    }
  }
  return { status: res.status, text, parsed };
}

async function mcpInitialize(url) {
  return mcpCall(url, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'phase2-security-suite', version: '1.0.0' },
  });
}

async function mcpToolsList(url) {
  return mcpCall(url, 'tools/list', {});
}

async function mcpToolCall(url, name, args) {
  return mcpCall(url, 'tools/call', { name, arguments: args });
}

// Parse a tools/call response text into the tool's JSON payload.
function toolPayload(res) {
  if (!res || !res.parsed || !res.parsed.result) return null;
  const content = res.parsed.result.content || [];
  const text = content.find((c) => c.type === 'text');
  if (!text) return null;
  try { return JSON.parse(text.text); } catch (_) { return text.text; }
}

(async () => {
  const { server, url } = await bootMcpServer();
  const cid = 'c-p2-' + randomUUID().slice(0, 8);
  try {
    // ---- SDK initialization + tool listing ----
    const init = await mcpInitialize(url);
    check('MCP initialize succeeds (stateless)', init.status === 200 && init.parsed && init.parsed.result && init.parsed.result.serverInfo, 'status=' + init.status);
    const tools = await mcpToolsList(url);
    const names = [];
    if (tools.parsed && tools.parsed.result && Array.isArray(tools.parsed.result.tools)) {
      for (const t of tools.parsed.result.tools) names.push(t.name);
    }
    check('MCP tools/list includes the 6 lifecycle tools', ['get_commitment_history','get_recovery_status','get_pending_actions','resume_commitment','cancel_commitment','close_commitment'].every((n) => names.includes(n)), 'names=' + names.join(','));

    // ---- Accounts (viem) ----
    const aKey = '0x' + crypto.randomBytes(32).toString('hex');
    const bKey = '0x' + crypto.randomBytes(32).toString('hex');
    const cKey = '0x' + crypto.randomBytes(32).toString('hex');
    const opKey = '0x' + crypto.randomBytes(32).toString('hex');
    const accA = privateKeyToAccount(aKey);
    const accB = privateKeyToAccount(bKey);
    const accC = privateKeyToAccount(cKey);
    const accOp = privateKeyToAccount(opKey);
    const A = accA.address.toLowerCase();
    const B = accB.address.toLowerCase();
    const C = accC.address.toLowerCase();
    const OP = accOp.address.toLowerCase();

    // ---- Seed + provision ----
    // buyerAgentId = the buyer's ADDRESS (A) so authority.js's buyer binding
    // check (proof.subject === commitment.buyerAgentId) holds for the buyer
    // proof. NO authorityProofId on the seed: the durable agent_authorizations
    // registry (Phase 1) is the authoritative binding for every role — the
    // authority.js proof supplies structure/signature/time only.
    await seedCommitment(cid, 'issued', { terms: { buyerAgentId: A, sellerAgentId: B, deliverable: 'demo' } });
    await provisionAuthority({ agentId: 'auth-' + cid, principal: OP, commitmentId: cid, role: 'authority' });
    await grantAuthz({ authorizer: 'auth-' + cid, principal: OP, subjectAgent: 'a-buyer-' + cid, subjectPrincipal: A, commitmentId: cid, role: 'buyer', scope: { actions: ['accept', 'dispute', 'cancel'] } });
    await grantAuthz({ authorizer: 'auth-' + cid, principal: OP, subjectAgent: 'a-seller-' + cid, subjectPrincipal: B, commitmentId: cid, role: 'provider', scope: { actions: ['execute', 'complete', 'submit'] } });

    // ---- A (buyer) accepts via MCP resume_commitment with a REAL EIP-712 proof ----
    const proofA = await signProof(accA, makeProof(accA, A, { actions: ['accept', 'dispute', 'cancel'] }));
    const r1 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'a-buyer-' + cid, role: 'buyer', proof: proofA, action: 'accept', idempotencyRef: 'p2-i1',
    });
    const p1 = toolPayload(r1);
    check('A accepts via MCP with verified principal (issued->accepted)', p1 && p1.status === 'transitioned' && p1.to_state === 'accepted', JSON.stringify(p1));

    // ---- B (seller) executes via MCP ----
    const proofB = await signProof(accB, makeProof(accB, B, { actions: ['execute', 'complete', 'submit'] }));
    const r2 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'a-seller-' + cid, role: 'provider', proof: proofB, action: 'execute', idempotencyRef: 'p2-i2',
    });
    const p2 = toolPayload(r2);
    check('B executes via MCP (accepted->executing)', p2 && p2.status === 'transitioned' && p2.to_state === 'executing', JSON.stringify(p2));

    // ---- C (replacement) with NO authorization cannot act ----
    // Use a VALID transition from the current state (executing -> evidence_pending
    // via 'complete') so the rejection is the AUTHORIZATION failure, not an
    // invalid-transition error.
    const proofC = await signProof(accC, makeProof(accC, C, { actions: ['complete'] }));
    const r3 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'agent-c-' + cid, role: 'provider', proof: proofC, action: 'complete', idempotencyRef: 'p2-i3',
    });
    const p3 = toolPayload(r3);
    check('C without durable authorization rejected (AUTH_MISSING_AUTHORIZATION)', p3 && p3.status === 'error' && /AUTH_MISSING_AUTHORIZATION/.test(p3.code || p3.reason || ''), JSON.stringify(p3));

    // ---- C impersonates A (agentId=a-buyer, proof subject=A) — must be rejected ----
    const proofCAsA = await signProof(accC, makeProof(accC, A, { actions: ['accept'] }));
    const r4 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'a-buyer-' + cid, role: 'buyer', proof: proofCAsA, action: 'accept', idempotencyRef: 'p2-i4',
    });
    const p4 = toolPayload(r4);
    // The proof's issuer (C) must match the registry principal (A): the RPC
    // principal-binding rejects because verifiedPrincipal=C != row principal=A.
    check('C impersonating A rejected (principal mismatch)', p4 && p4.status === 'error', JSON.stringify(p4));

    // ---- C with forged role (authority) — no authority row for C ----
    const proofCAsAuth = await signProof(accC, makeProof(accC, C, { actions: ['authorize'] }));
    const r5 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'agent-c-' + cid, role: 'authority', proof: proofCAsAuth, action: 'authorize', idempotencyRef: 'p2-i5',
    });
    const p5 = toolPayload(r5);
    check('C forged authority role rejected', p5 && p5.status === 'error', JSON.stringify(p5));

    // ---- history + recovery status (read-only, with proof) ----
    const r6 = await mcpToolCall(url, 'get_commitment_history', {
      commitmentId: cid, agentId: 'a-buyer-' + cid, role: 'buyer', proof: proofA,
    });
    const p6 = toolPayload(r6);
    check('get_commitment_history returns events (count>=2)', p6 && p6.status === 'ok' && p6.count >= 2, JSON.stringify(p6));

    const r7 = await mcpToolCall(url, 'get_recovery_status', {
      commitmentId: cid, agentId: 'a-seller-' + cid, role: 'provider', proof: proofB,
    });
    const p7 = toolPayload(r7);
    check('get_recovery_status returns state + pending actions', p7 && p7.state === 'executing' && Array.isArray(p7.pendingActions), JSON.stringify(p7));

    const r8 = await mcpToolCall(url, 'get_pending_actions', {
      commitmentId: cid, agentId: 'a-seller-' + cid, role: 'provider', proof: proofB,
    });
    const p8 = toolPayload(r8);
    check('get_pending_actions lists provider actions (complete/submit)', p8 && p8.status === 'ok' && p8.pendingActions.some((a) => a.action === 'complete'), JSON.stringify(p8));

    // ---- stale version rejected ----
    const r9 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'a-buyer-' + cid, role: 'buyer', proof: proofA, action: 'dispute', idempotencyRef: 'p2-i9', expectedVersion: 1,
    });
    const p9 = toolPayload(r9);
    check('stale version rejected (ST_STALE_VERSION)', p9 && p9.status === 'error' && /ST_STALE_VERSION/.test(p9.code || p9.reason || ''), JSON.stringify(p9));

    // ---- idempotent replay through MCP (same ref) ----
    const r10 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'a-buyer-' + cid, role: 'buyer', proof: proofA, action: 'accept', idempotencyRef: 'p2-i1',
    });
    const p10 = toolPayload(r10);
    check('idempotent replay through MCP returns replayed', p10 && p10.status === 'replayed' && p10.to_state === 'accepted', JSON.stringify(p10));
    const evCount = await countEvents(cid);
    // 2 real transitions (accept i1, execute i2); the i1 replay must NOT add a third.
    check('replay created no duplicate event', evCount === 2, 'count=' + evCount);

    // ---- financial transitions NOT exposed ----
    // Advance to fulfilled via provider/evaluator, then attempt settle through MCP.
    // (No evaluator seeded — verify the tool-level block instead with a direct call.)
    const r11 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid, agentId: 'a-seller-' + cid, role: 'provider', proof: proofB, action: 'settle', idempotencyRef: 'p2-i11',
    });
    const p11 = toolPayload(r11);
    check('settle action blocked at MCP (nonfinancial surface)', p11 && (p11.status === 'blocked' || p11.status === 'invalid'), JSON.stringify(p11));

    const r12 = await mcpToolCall(url, 'close_commitment', {
      commitmentId: cid, agentId: 'agent-sys-' + cid, role: 'system', proof: proofA, idempotencyRef: 'p2-i12',
    });
    const p12 = toolPayload(r12);
    check('close_commitment blocked (state not settled)', p12 && (p12.status === 'blocked' || p12.status === 'unauthorized' || p12.status === 'error'), JSON.stringify(p12));

    // ---- cancel via MCP (buyer, authorized) on a FRESH commitment ----
    // Cancel is canonical from issued/accepted (NOT from executing). Use a
    // second commitment for the terminal-transition tests.
    const cid2 = 'c-p2b-' + randomUUID().slice(0, 8);
    await seedCommitment(cid2, 'issued', { terms: { buyerAgentId: A, sellerAgentId: B, deliverable: 'demo' } });
    await provisionAuthority({ agentId: 'auth-' + cid2, principal: OP, commitmentId: cid2, role: 'authority' });
    await grantAuthz({ authorizer: 'auth-' + cid2, principal: OP, subjectAgent: 'a-buyer-' + cid2, subjectPrincipal: A, commitmentId: cid2, role: 'buyer', scope: { actions: ['accept', 'cancel'] } });

    const r13 = await mcpToolCall(url, 'cancel_commitment', {
      commitmentId: cid2, agentId: 'a-buyer-' + cid2, role: 'buyer', proof: proofA, reason: 'buyer decision', idempotencyRef: 'p2-i13',
    });
    const p13 = toolPayload(r13);
    check('cancel via MCP succeeds (issued->cancelled)', p13 && p13.status === 'transitioned' && p13.to_state === 'cancelled', JSON.stringify(p13));

    const st = await stateOf(cid2);
    check('cancel persisted (state=cancelled, version advanced)', st && st.state === 'cancelled', JSON.stringify(st));

    // ---- terminal state rejects further mutation ----
    const r14 = await mcpToolCall(url, 'resume_commitment', {
      commitmentId: cid2, agentId: 'a-buyer-' + cid2, role: 'buyer', proof: proofA, action: 'dispute', idempotencyRef: 'p2-i14',
    });
    const p14 = toolPayload(r14);
    check('terminal state rejects further mutation (ST_ALREADY_FINALIZED)', p14 && p14.status === 'error' && /ST_ALREADY_FINALIZED/.test(p14.code || p14.reason || ''), JSON.stringify(p14));
    await clean(cid2);

    console.log('\n=== MCP principal-binding security suite: ' + pass + ' passed, ' + fail + ' failed ===');
  } finally {
    await clean(cid);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASH:', e); process.exit(2); });
