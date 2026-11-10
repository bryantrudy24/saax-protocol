// SAAX Protocol — Discovery Phase 4: signed preflight + commitment-acceptance HTTP server (isolated test env)
//
// Extends the Phase-3 isolated preflight server with the Phase-4
// commitment-acceptance operation (`POST /accept-commitment`) using the SAME
// core (`endpoint/acceptance-core.js`) as the MCP adapter. This is a
// TEST/isolated server: plain HTTP on 127.0.0.1 with an explicit localhost
// exception, a controlled injectable clock, and NO financial side effects
// (sideEffectRecorder allows tests to spy).
//
// The signed profile it serves is the Phase-3 fixture
// (spec/examples/discovery/profile-phase3-unsigned.json, real Ed25519 signature).

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const preflight = require('../../endpoint/preflight-core');
const acceptance = require('../../endpoint/acceptance-core');
const { ProposalStore } = require('../../endpoint/proposal-store');
const { AcceptanceStore } = require('../../endpoint/acceptance-store');

const ROOT = path.resolve(__dirname, '..', '..');

function loadProfile() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/examples/discovery/profile-phase3-unsigned.json'), 'utf8'));
}

function loadSignerKey() {
  // Throwaway example key (committed fixture, explicitly NOT a real secret).
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/examples/discovery/keys/example-private.jwk.json'), 'utf8'));
}

class PreflightSideEffectRecorder {
  constructor() {
    this.calls = [];
  }
  record(kind, detail) {
    this.calls.push({ kind, detail, at: new Date().toISOString() });
  }
  get total() { return this.calls.length; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Start the isolated discovery server (preflight + acceptance).
 * opts: { port, storeDir, clock?, signerKey?, profile?, sideEffects?,
 *         acceptanceStoreDir?, buyerRegistry?, trustedThumbprints? }
 * Returns { server, url, store, acceptanceStore, sideEffects, providerRef, profile }
 */
async function startPreflightServer(opts = {}) {
  const profile = opts.profile || loadProfile();
  const privateJwk = opts.signerKey || loadSignerKey();
  const store = opts.store || new ProposalStore(opts.storeDir || path.join(ROOT, '.output/.phase3-proposals'));
  const sideEffects = opts.sideEffects || new PreflightSideEffectRecorder();
  const acceptanceStore = opts.acceptanceStore || new AcceptanceStore(opts.acceptanceStoreDir || path.join(ROOT, '.output/.phase4-acceptances'));

  const providerRef = {
    providerId: profile.providerId,
    name: profile.providerName,
    origin: profile.origin,
    signingKeyId: profile.signingKeys[0].id,
    privateJwk,
    jwkPublic: { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x },
    manifestDigest: null // set below from the profile's commitment-manifest schema digest
  };
  const manSchema = profile.capabilities[0].schemas.find((s) => s.purpose === 'commitment-manifest');
  providerRef.manifestDigest = manSchema ? manSchema.digest : 'sha256:' + '0'.repeat(64) + 'placeholder';
  // Authenticated evaluator + permitted-decision authority (from the profile,
  // signed in the commitment representation wrapper).
  const cap = profile.capabilities[0];
  providerRef.evaluatorRef = (cap && cap.evaluatorRequirements) || null;
  providerRef.permittedDecisions = (cap && cap.permittedDecisions) || null;

  // Trust: configured provider thumbprints (injectable; the fixture key's
  // thumbprint is the default anchor).
  const { calculateJwkThumbprint } = require('jose');
  const _defaultThumb = calculateJwkThumbprint(providerRef.jwkPublic).catch(() => '');
  const trustedThumbprints = opts.trustedThumbprints
    ? opts.trustedThumbprints
    : [await _defaultThumb];

  // Buyer registry: { [buyerAddress]: { publicJwk, scopeMaxAmount, scopeCurrency,
  // scopeCapability } } — Phase-4 configured-buyer path (mirrors trusted-key).
  // The server exposes an injectable registry so tests can register keys.
  const buyerRegistry = opts.buyerRegistry || {};
  function buyerScopeFor(address) {
    const a = String(address || '').toLowerCase();
    const reg = buyerRegistry[a];
    if (!reg) return null;
    return {
      buyer: a,
      buyerPublicJwk: reg.publicJwk,
      scopeMaxAmount: reg.scopeMaxAmount,
      scopeCurrency: reg.scopeCurrency,
      scopeCapability: reg.scopeCapability,
    };
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { status: 'ok' });
    }
    if (req.method === 'POST' && (req.url === '/prepare-commitment' || req.url === '/accept-commitment')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 256 * 1024) { body = body.slice(0, 256 * 1024); } });
      req.on('end', async () => {
        if (body.length > 256 * 1024) return json(res, 413, { error: { code: 'DSC_UNAVAILABLE', status: 413, message: 'request too large' } });
        let request;
        try { request = JSON.parse(body); } catch (e) {
          return json(res, 400, { error: { code: 'DSC_INVALID_REQUEST', status: 400, message: 'invalid JSON body' } });
        }
        if (req.url === '/prepare-commitment') {
          const outcome = await preflight.prepareCommitment({ profile, providerRef, request, store, clock: opts.clock || null });
          if (outcome.status === 'ok') {
            sideEffects.record('proposal_issued', { proposalId: outcome.proposal.proposalId });
            return json(res, 200, { status: 'ok', proposal: outcome.proposal });
          }
          if (outcome.status === 'duplicate') {
            sideEffects.record('proposal_duplicate', { proposalId: outcome.proposal && outcome.proposal.proposalId });
            return json(res, 200, { status: 'duplicate', proposal: outcome.proposal });
          }
          if (outcome.status === 'conflict') {
            return json(res, 422, { status: 'conflict', error: { code: outcome.errorCode, status: 422, message: outcome.reason } });
          }
          const httpStatus = outcome.httpStatus || 422;
          return json(res, httpStatus, { status: 'error', error: { code: outcome.errorCode, status: httpStatus, message: outcome.reason } });
        }
        // /accept-commitment
        if (!request.proposal || !request.acceptance) {
          return json(res, 422, { error: { code: 'DSC_INVALID_REQUEST', status: 422, message: 'proposal and acceptance required' } });
        }
        const spec = request.proposal;
        const acceptanceReq = request.acceptance;
        const idempotencyKey = request.idempotencyKey;
        const buyerAddr = (acceptanceReq && acceptanceReq.buyer) || (spec.audience && spec.audience.buyer);
        const buyerScope = buyerScopeFor(buyerAddr);
        if (!buyerScope) {
          return json(res, 401, { error: { code: 'DSC_UNAUTHORIZED', status: 401, message: 'buyer not registered' } });
        }
        const outcome = await acceptance.acceptCommitment({
          profile,
          trustedThumbprints,
          proposal: spec,
          buyerScope,
          acceptance: acceptanceReq,
          providerRef,
          store: acceptanceStore,
          clock: opts.clock || null,
          idempotencyKey,
        });
        if (outcome.status === 'ok' || outcome.status === 'duplicate') {
          const kind = outcome.status === 'ok' ? 'commitment_created' : 'commitment_duplicate';
          sideEffects.record(kind, { operationId: outcome.operation && outcome.operation.operationId, commitmentId: outcome.commitment && outcome.commitment.commitmentId });
          return json(res, outcome.status === 'ok' ? 201 : 200, {
            status: outcome.status,
            operation: outcome.operation,
            commitment: outcome.commitment,
            proposal: outcome.proposal || null,
            acceptance: outcome.acceptance || null,
          });
        }
        if (outcome.status === 'reused_proposal') {
          return json(res, 409, { status: 'reused_proposal', error: { code: outcome.errorCode, status: 409, message: outcome.reason } });
        }
        if (outcome.status === 'conflict') {
          return json(res, 422, { status: 'conflict', error: { code: outcome.errorCode, status: 422, message: outcome.reason } });
        }
        const httpStatus = outcome.httpStatus || 422;
        return json(res, httpStatus, { status: 'rejected', error: { code: outcome.errorCode, status: httpStatus, message: outcome.reason } });
      });
      return;
    }
    json(res, 404, { error: { code: 'DSC_UNRESOLVED', status: 404, message: 'not found' } });
  });

  await new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    url: 'http://127.0.0.1:' + port,
    store,
    acceptanceStore,
    sideEffects,
    providerRef,
    profile,
    buyerRegistry,
  };
}

module.exports = { startPreflightServer, PreflightSideEffectRecorder, loadProfile, loadSignerKey };
