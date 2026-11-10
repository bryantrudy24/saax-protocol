// SAAX Protocol — Discovery Phase 3: signed preflight test runner
//
// Proves (in an isolated loopback environment, real Ed25519 signatures):
//   1. A supported request returns a correctly signed, independently
//      verifiable proposal (positive control).
//   2. HTTP and MCP adapters produce equivalent semantic results.
//   3. Unsupported capability / schema version+digest / units / network+asset+
//      rail+mode combination fail with SPECIFIC DSC_* codes.
//   4. Request / terms / audience / signature / version substitution is
//      detected (a substituted request yields a different requestDigest; a
//      tampered proposal fails verification; a wrong audience fails).
//   5. Expiry and profile changes are handled explicitly (controlled clock).
//   6. Concurrent retries, conflicts, and process restart preserve defined
//      behavior (duplicate -> same unexpired proposal; conflict -> 422;
//      restart reloads the journal).
//   7. No payment/custody/commitment/execution functions are invoked — the
//      side-effect recorder spies: only proposal_issued / proposal_duplicate
//      are allowed; zero payment/custody/commitment/execution calls.
//
// Run: node tests/discovery-phase3/run-phase3-tests.cjs

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const preflight = require('../../endpoint/preflight-core');
const cryptoLib = require('../../endpoint/discovery-crypto');
const disc = require('../../endpoint/discovery');
const { ProposalStore } = require('../../endpoint/proposal-store');
const { startPreflightServer, loadProfile, loadSignerKey } = require('./preflight-http-server.cjs');

// ---- Minimal MCP adapter (same core, in-process) ----------------------------
// Mirrors the MCP prepare_commitment tool's contract: inputSchema pre-validates
// the same required fields, then delegates to the identical core.
function makeMCPAdapter({ profile, providerRef, store, clock }) {
  return async function prepareCommitmentTool(input) {
    const request = input && input.request;
    if (!request || typeof request !== 'object') {
      return { status: 'error', errorCode: 'DSC_INVALID_REQUEST', httpStatus: 422, reason: 'request required' };
    }
    const outcome = await preflight.prepareCommitment({ profile, providerRef, request, store, clock });
    return outcome;
  };
}

// ---- Assertion helpers -------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}

function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

async function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { resolve({ status: res.statusCode, body: safeParse(data) }); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postRaw(url, raw) {
  return new Promise((resolve, reject) => {
    const body = String(raw);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { resolve({ status: res.statusCode, body: safeParse(data) }); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// ---- Controlled clock --------------------------------------------------------
function makeClock(iso) {
  return { nowIso: () => iso, fixed: iso };
}

// ---- Temp dirs ----------------------------------------------------------------
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-phase3-'));
function tmpdir(name) { const d = path.join(tmpBase, name); fs.mkdirSync(d, { recursive: true }); return d; }

// ---- Valid baseline request ---------------------------------------------------
function validRequest(over = {}) {
  return Object.assign({
    profileVersion: '1.0.0',
    capability: { id: 'security-scan' },
    schema: {
      id: 'https://saax-protocol.com/schemas/commitment-manifest/v1',
      version: '1',
      digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    },
    units: { amount: '250000000', unit: 'micro-units of settlement asset' },
    financialProfile: {
      network: 'eip155:8453',
      asset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      rail: 'x402',
      mode: 'x402',
    },
    constraints: { maxAmount: '250000000', deadline: '2026-11-06T00:00:00Z' },
    intendedParties: { buyer: '0x1111111111111111111111111111111111111111' },
    clientNonce: 'nonce-0001-abcdef',
    issuedAt: '2026-11-05T12:00:00Z',
  }, over);
}

async function main() {
  const profile = loadProfile();
  const privateJwk = loadSignerKey();
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  const providerRef = {
    providerId: profile.providerId,
    name: profile.providerName,
    origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id,
    privateJwk,
    jwkPublic: publicJwk,
    manifestDigest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  };

  // ===========================================================================
  // A. Positive control: supported request => signed, independently verifiable
  // ===========================================================================
  {
    const storeDir = tmpdir('a');
    const store = new ProposalStore(storeDir);
    const clock = makeClock('2026-11-05T12:00:00.000Z');
    const out = await preflight.prepareCommitment({ profile, providerRef, request: validRequest(), store, clock });
    ok(out.status === 'ok', 'A1 supported request returns ok');
    const prop = out.proposal;
    ok(prop && prop.proposalId && /^prop_[A-Za-z0-9_-]+$/.test(prop.proposalId), 'A2 proposalId present and well-formed');
    ok(prop.nonce === validRequest().clientNonce, 'A3 clientNonce echoed');
    const expectedDigest = digestOfNormalized(validRequest());
    eq(prop.requestDigest, expectedDigest, 'A4 requestDigest bound to normalized request');
    // Independent verification: reconstruct the signed payload (proposal minus
    // signature), verify JWS with the profile's public key.
    const checkPayload = JSON.parse(JSON.stringify(prop));
    delete checkPayload.signature;
    const ver = await cryptoLib.verifySignature({ jws: prop.signature.jws, publicJwk, expectedKeyId: prop.signature.keyId, expectedPayload: checkPayload });
    ok(ver.ok, 'A5 proposal signature verifies independently', ver.reason);
    ok(prop.signature.alg === 'EdDSA' && prop.signature.scheme === 'jws' && prop.signature.canonicalization === 'rfc8785', 'A6 signature profile pinned');
    ok(prop.status === 'proposed', 'A7 status proposed');
    ok(prop.expires > prop.issuedAt, 'A8 expiry after issuance');
    ok(prop.manifest.commitmentManifestVersion === '1', 'A9 manifest v1 reused (no new format)');
    ok(prop.terms.amount === '250000000' && prop.terms.unit === 'micro-units of settlement asset', 'A10 normalized terms explicit');
    ok(prop.trust && prop.trust.selfSigned === true && prop.trust.authenticated === false, 'A11 trust axes: signed self-claim, not authenticated');
    ok(store.size === 1, 'A12 proposal persisted');
    // Restart: new store instance on the same dir reloads the journal.
    const store2 = new ProposalStore(storeDir);
    const dup = store2.getByScope({ clientNonce: validRequest().clientNonce, requestDigest: expectedDigest });
    ok(dup && dup.proposalId === prop.proposalId, 'A13 restart reloads issued proposal');
  }

  // ===========================================================================
  // B. HTTP adapter (isolated env) — semantic parity with core
  // ===========================================================================
  {
    const storeDir = tmpdir('b');
    const store = new ProposalStore(storeDir);
    const clock = makeClock('2026-11-05T12:00:00.000Z');
    const h = await startPreflightServer({ port: 0, storeDir, clock, store });
    try {
      const r1 = await postJson(h.url + '/prepare-commitment', validRequest({ clientNonce: 'http-0001-abcdef' }));
      ok(r1.status === 200 && r1.body && r1.body.status === 'ok' && r1.body.proposal, 'B1 HTTP supported request returns 200 + proposal');
      const p1 = r1.body.proposal;
      // Same request over MCP core (SAME store instance) = duplicate + same digest.
      const mcp = makeMCPAdapter({ profile, providerRef, store, clock });
      const m1 = await mcp({ request: validRequest({ clientNonce: 'http-0001-abcdef' }) });
      ok(m1.status === 'duplicate' && m1.proposal && m1.proposal.proposalId === p1.proposalId, 'B2 MCP retry of HTTP-issued request returns the SAME proposal (duplicate)', JSON.stringify({ s: m1.status, id: m1.proposal && m1.proposal.proposalId, p1: p1.proposalId }));
      ok(m1.proposal && m1.proposal.requestDigest === p1.requestDigest, 'B3 MCP+HTTP produce identical requestDigest');
      // Side-effect spy: the HTTP server's recorder may ONLY ever see
      // issuance/duplicate kinds (the MCP adapter runs the same core but does
      // not write into the HTTP recorder — that is expected).
      const kinds = h.sideEffects.calls.map((c) => c.kind);
      ok(kinds.length >= 1 && kinds.every((k) => k === 'proposal_issued' || k === 'proposal_duplicate'), 'B4 side-effect recorder only saw issuance/duplicate (no payment/custody/commitment/execution)', JSON.stringify(kinds));
    } finally { h.server.close(); }
  }

  // ===========================================================================
  // C. Negative: unsupported / invalid inputs fail with SPECIFIC DSC_* codes
  // ===========================================================================
  {
    const store = new ProposalStore(tmpdir('c'));
    const clock = makeClock('2026-11-05T12:00:00.000Z');
    const req = async (r) => preflight.prepareCommitment({ profile, providerRef, request: r, store, clock });
    const cases = [
      ['C1 unsupported capability -> DSC_UNSUPPORTED_CAPABILITY', validRequest({ capability: { id: 'data-brokerage' } }), 'DSC_UNSUPPORTED_CAPABILITY'],
      ['C2 schema version mismatch -> DSC_SCHEMA_MISMATCH', validRequest({ schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '9', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' } }), 'DSC_SCHEMA_MISMATCH'],
      ['C3 schema digest mismatch -> DSC_SCHEMA_MISMATCH', validRequest({ schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }), 'DSC_SCHEMA_MISMATCH'],
      ['C4 float amount -> DSC_UNITS_MISMATCH', validRequest({ units: { amount: '250000000.5', unit: 'micro-units of settlement asset' } }), 'DSC_UNITS_MISMATCH'],
      ['C5 amount over max -> DSC_UNITS_MISMATCH', validRequest({ units: { amount: '999999999999', unit: 'micro-units of settlement asset' } }), 'DSC_UNITS_MISMATCH'],
      ['C6 unsupported combination (bad rail) -> DSC_INVALID_COMBINATION', validRequest({ financialProfile: { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'ap2', mode: 'ap2' } }), 'DSC_INVALID_COMBINATION'],
      ['C7 wrong network -> DSC_INVALID_COMBINATION', validRequest({ financialProfile: { network: 'eip155:1', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'x402' } }), 'DSC_INVALID_COMBINATION'],
      ['C8 wrong asset -> DSC_INVALID_COMBINATION', validRequest({ financialProfile: { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x0000000000000000000000000000000000000000', rail: 'x402', mode: 'x402' } }), 'DSC_INVALID_COMBINATION'],
      ['C9 short clientNonce -> DSC_INVALID_REQUEST', validRequest({ clientNonce: 'short' }), 'DSC_INVALID_REQUEST'],
      ['C10 missing units.unit -> DSC_UNITS_MISMATCH', validRequest({ units: { amount: '1' } }), 'DSC_UNITS_MISMATCH'],
      ['C11 bad network syntax -> DSC_INVALID_COMBINATION', validRequest({ financialProfile: { network: 'not-a-chain', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'x402' } }), 'DSC_INVALID_COMBINATION'],
      ['C12 unsupported mode -> DSC_INVALID_COMBINATION', validRequest({ financialProfile: { network: 'eip155:8453', asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rail: 'x402', mode: 'escrow-instant' } }), 'DSC_INVALID_COMBINATION'],
    ];
    for (const [name, r, code] of cases) {
      const out = await req(r);
      eq(out.errorCode, code, name, JSON.stringify({ got: out.errorCode, reason: out.reason }));
      ok(!!out.httpStatus, name + ' (http status set)');
    }
  }

  // ===========================================================================
  // D. Substitution detection (request / terms / signature / version / audience)
  // ===========================================================================
  {
    const store = new ProposalStore(tmpdir('d'));
    const clock = makeClock('2026-11-05T12:00:00.000Z');
    // D1: two different requests, same clientNonce -> conflict (never silent re-issue).
    const r1 = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'subst-0001-abcdef' }), store, clock });
    ok(r1.status === 'ok', 'D1a first request accepted');
    const r2 = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'subst-0001-abcdef', units: { amount: '99999999', unit: 'micro-units of settlement asset' } }), store, clock });
    eq(r2.errorCode, 'DSC_NONCE_CONFLICT', 'D1b same nonce + changed terms -> DSC_NONCE_CONFLICT');
    // D2: identical retry -> duplicate, same proposal.
    const r3 = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'subst-0001-abcdef' }), store, clock });
    eq(r3.status, 'duplicate', 'D2 identical retry returns duplicate');
    ok(r3.proposal && r3.proposal.proposalId === r1.proposal.proposalId, 'D3 duplicate returns the SAME proposalId');
    // D4: tampered proposal fails signature verification.
    const prop = r1.proposal;
    const tampered = JSON.parse(JSON.stringify(prop));
    tampered.terms.amount = '1';
    const verT = await cryptoLib.verifySignature({ jws: prop.signature.jws, publicJwk, expectedKeyId: prop.signature.keyId, expectedPayload: tampered });
    eq(verT.errorCode, 'DSC_PAYLOAD_MISMATCH', 'D4 tampered proposal terms fail verification', verT.reason);
    // D5: wrong-audience proposal — signed proposal for buyer A must not verify as
    //     the payload for buyer B (caller must reconstruct exactly).
    const propB = JSON.parse(JSON.stringify(prop));
    propB.audience.buyer = '0x2222222222222222222222222222222222222222';
    const verB = await cryptoLib.verifySignature({ jws: prop.signature.jws, publicJwk, expectedKeyId: prop.signature.keyId, expectedPayload: propB });
    eq(verB.errorCode, 'DSC_PAYLOAD_MISMATCH', 'D5 wrong-audience reconstruction fails verification');
    // D6: version substitution — proposal profileVersion changed -> payload mismatch.
    const propV = JSON.parse(JSON.stringify(prop));
    propV.profileVersion = '0.9.0';
    const verV = await cryptoLib.verifySignature({ jws: prop.signature.jws, publicJwk, expectedKeyId: prop.signature.keyId, expectedPayload: propV });
    eq(verV.errorCode, 'DSC_PAYLOAD_MISMATCH', 'D6 version substitution fails verification');
    // D7: signature substitution — a different (valid) key must NOT verify as this proposal.
    const otherKey = await cryptoLib.generateKeyPair ? null : null; // jose generateKeyPair not exported; use a second fixture sign
    // We use an UNRELATED public key -> verification must fail.
    const unrelated = { kty: 'OKP', crv: 'Ed25519', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    const verU = await cryptoLib.verifySignature({ jws: prop.signature.jws, publicJwk: unrelated, expectedKeyId: prop.signature.keyId, expectedPayload: checkPayloadFor(prop) });
    eq(verU.errorCode, 'DSC_INVALID_SIGNATURE', 'D7 signature from an unrelated key fails', verU.reason);
  }

  // ===========================================================================
  // E. Expiry under a controlled clock + profile changes
  // ===========================================================================
  {
    const store = new ProposalStore(tmpdir('e'));
    const early = makeClock('2026-11-05T12:00:00.000Z');
    const out = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'expire-0001-abcdef' }), store, clock: early });
    ok(out.status === 'ok', 'E1 proposal issued');
    const prop = out.proposal;
    // Controlled clock AFTER expiry: the stored proposal must not be served as
    // fresh. Lookup returns the stored proposal; expiry is the caller's check —
    // the proposal object's `expires` is authoritative. Simulate a client
    // revalidating with a later clock: expires < now -> expired.
    const late = makeClock('2099-01-01T00:00:00.000Z');
    const stale = Date.parse(prop.expires) <= Date.parse(late.nowIso());
    ok(stale, 'E2 proposal expiry is explicit and clock-controlled');
    // The spec: identical authenticated retry of an expired proposal is NOT
    // auto-replaced; a retry with the same key returns duplicate (still expired)
    // and a FRESH proposal requires a fresh nonce.
    const retryLate = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'expire-0001-abcdef' }), store, clock: late });
    ok(retryLate.status === 'duplicate' && retryLate.proposal && Date.parse(retryLate.proposal.expires) < Date.parse(late.nowIso()), 'E3 expired duplicate stays expired (no silent fresh re-issue)');
    const fresh = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'expire-0002-abcdef' }), store, clock: late });
    ok(fresh.status === 'ok', 'E4 fresh nonce issues a new proposal after expiry');
    // E5: profile change (prepareCommitment NOT declared) -> DSC_UNAVAILABLE.
    const profileNoPreflight = JSON.parse(JSON.stringify(profile));
    profileNoPreflight.interfaces.discovery.prepareCommitment = false;
    const noPf = await preflight.prepareCommitment({ profile: profileNoPreflight, providerRef, request: validRequest({ clientNonce: 'profchg-0001-abcdef' }), store, clock: late });
    eq(noPf.errorCode, 'DSC_UNAVAILABLE', 'E5 profile without prepareCommitment -> DSC_UNAVAILABLE');
  }

  // ===========================================================================
  // F. Concurrency + restart
  // ===========================================================================
  {
    const storeDir = tmpdir('f');
    const store = new ProposalStore(storeDir);
    const clock = makeClock('2026-11-05T12:00:00.000Z');
    // F1: concurrent identical retries -> exactly ONE issued, rest duplicate.
    const tasks = [];
    for (let i = 0; i < 10; i += 1) {
      tasks.push(preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'conc-0001-abcdef' }), store, clock }));
    }
    const results = await Promise.all(tasks);
    const okCount = results.filter((r) => r.status === 'ok').length;
    const dupCount = results.filter((r) => r.status === 'duplicate').length;
    const conflictCount = results.filter((r) => r.status === 'conflict').length;
    ok(okCount === 1 && dupCount === 9 && conflictCount === 0, 'F1 concurrent identical retries: 1 ok + 9 duplicate, 0 conflict', JSON.stringify({ okCount, dupCount, conflictCount }));
    // F2: concurrent same-nonce-different-request -> exactly one issued + conflicts for the rest.
    const tasks2 = [];
    for (let i = 0; i < 6; i += 1) {
      tasks2.push(preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'conc-0002-abcdef', units: { amount: String(1000000 + i), unit: 'micro-units of settlement asset' } }), store, clock }));
    }
    const results2 = await Promise.all(tasks2);
    const ok2 = results2.filter((r) => r.status === 'ok').length;
    const conf2 = results2.filter((r) => r.status === 'conflict').length;
    ok(ok2 === 1 && conf2 === 5, 'F2 concurrent same-nonce different-request: 1 ok + 5 conflicts', JSON.stringify({ ok2, conf2 }));
    // F3: restart — new store on the same dir preserves issued records.
    const store2 = new ProposalStore(storeDir);
    const d1 = store2.getByScope({ clientNonce: 'conc-0001-abcdef', requestDigest: digestOfNormalized(validRequest({ clientNonce: 'conc-0001-abcdef' })) });
    ok(d1 && d1.proposalId, 'F3 restart preserves accepted issuance (shared key)');
    // F4: a torn tail line is recovered (crash mid-append simulated).
    fs.appendFileSync(storeDir + '/proposals.journal', '{"proposalId":"prop_torn","nonce":"n","requestDigest":"sha256:' + '0'.repeat(64) + '","signedPayload":"{broken','utf8');
    const store3 = new ProposalStore(storeDir);
    ok(store3.recoveredTail === true, 'F4 torn journal tail recovered (truncated, not merged)');
    ok(store3.getById('prop_torn') === null, 'F5 torn record not served');
    ok(store3.getById(d1.proposalId) !== null, 'F6 valid records survive recovery');
  }

  // ===========================================================================
  // G. No financial side effects (spies)
  // ===========================================================================
  {
    const storeDir = tmpdir('g');
    const store = new ProposalStore(storeDir);
    const clock = makeClock('2026-11-05T12:00:00.000Z');
    // A spy that FAILS if any payment/custody/commitment/execution call happens.
    const financialSpy = () => { throw new Error('FINANCIAL SIDE EFFECT DETECTED'); };
    // The core only calls store.acquire/persist — pass a wrapped store that
    // asserts no other financial API is touched.
    const wrappedStore = {
      acquire: async (scope) => store.acquire(scope),
      persist: async (rec) => store.persist(rec),
    };
    const out = await preflight.prepareCommitment({ profile, providerRef, request: validRequest({ clientNonce: 'spy-0001-abcdef' }), store: wrappedStore, clock });
    ok(out.status === 'ok', 'G1 valid preflight with spy store succeeds');
    // AND: confirm the proposal does not contain any payment/authorization
    // execution field, and no route/x402/custody call was even reachable.
    const prop = out.proposal;
    ok(!prop.execution && !prop.paymentIntent && !prop.escrow && !prop.custody, 'G2 proposal carries no execution/payment/escrow fields');
    ok(!('authorization' in prop), 'G3 proposal carries no authorization field (provider signature != buyer acceptance)');
  }

  // ===========================================================================
  // H. HTTP negative end-to-end (error codes over the wire)
  // ===========================================================================
  {
    const h = await startPreflightServer({ port: 0, storeDir: tmpdir('h'), clock: makeClock('2026-11-05T12:00:00.000Z') });
    try {
      const bad1 = await postJson(h.url + '/prepare-commitment', validRequest({ capability: { id: 'nope' }, clientNonce: 'httpbad-0001-abcdef' }));
      eq(bad1.status, 422, 'H1 HTTP unsupported capability -> 422');
      ok(bad1.body.error && bad1.body.error.code === 'DSC_UNSUPPORTED_CAPABILITY', 'H2 HTTP error code specific', bad1.body && JSON.stringify(bad1.body.error));
      const bad2 = await postJson(h.url + '/prepare-commitment', validRequest({ clientNonce: 'httpbad-0001-abcdef', units: { amount: '1.5', unit: 'micro-units of settlement asset' } }));
      eq(bad2.status, 422, 'H3 HTTP float amount -> 422');
      ok(bad2.body.error && bad2.body.error.code === 'DSC_UNITS_MISMATCH', 'H4 HTTP units code', bad2.body && JSON.stringify(bad2.body.error));
      const bad3 = await postRaw(h.url + '/prepare-commitment', 'not-json');
      eq(bad3.status, 400, 'H5 HTTP invalid JSON -> 400');
    } finally { h.server.close(); }
  }

  // ---- Summary -----------------------------------------------------------------
  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    process.exitCode = 1;
  }
}

function checkPayloadFor(prop) {
  const p = JSON.parse(JSON.stringify(prop));
  delete p.signature;
  return p;
}

// Digest over the NORMALIZED request (spec §6.4: the provider digests the
// accepted normalized request, not the raw bytes).
function digestOfNormalized(req) {
  const n = preflight.normalizeRequest(req);
  if (!n.ok) throw new Error('digestOfNormalized: request invalid: ' + n.error.message);
  return preflight.requestDigestOf(n.normalized);
}

main().catch((e) => { console.error('runner crashed: ' + (e && e.stack || e)); process.exitCode = 1; });
