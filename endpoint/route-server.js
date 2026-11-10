// SAAX Protocol â€” Day 4/5 + Day 8 + Day 11: Demand Intake Endpoint (mock x402 mode)
//
// HTTP POST /route
//   Accepts:  { capability, budget, deadline }
//   Returns:  x402 v2 payment challenge (402) without a valid payment header,
//             or ranked + ROUTED supplier matches with settlement receipts
//             when a valid payment signature is presented.
//
// DAY 5 â€” PAYMENT ROUTING LOGIC (MOCK MODE)
//   - After ranking, every matched supplier is routed through the decision
//     tree (endpoint/router.js): x402 (payTo + USDC on base/polygon/solana) |
//     mpp (fiat/Stripe-native) | unsupported (excluded from the match list).
//   - x402 suppliers are settled through the mock signing/verification path
//     (endpoint/x402.js, exact scheme for fixed-price, upto for usage-based),
//     returning receipts whose structure matches the documented LIVE receipt
//     structure field-for-field.
//   - MPP suppliers are stubbed: { rail: "mpp", status: "stubbed", reason:
//     "Sprint 1 mock mode" }. mppx is NOT installed; Stripe rails are NOT
//     configured (Day 7+ items).
//   - SAAX_X402_VERIFY_MODE=mock (default) accepts mock signatures; "live" re-
//     verifies the real ECDSA signature (inert until the wallet is connected).
//
// PRE-DAY 5 FIX 1: payment header validation is no longer "accept anything":
//   a PAYMENT-SIGNATURE header (base64 x402 V2 payload) is parsed structurally
//   and verified through the mock branch; the legacy x-x402-mock: mock header
//   is still accepted for compatibility and is also run through verification.
//
// PRE-DAY 5 FIX 2 (flag only, no build): buyer reputation input trusts the
//   x-mock-buyer-rep client header in Sprint 1. Live, it MUST come from a
//   verified source: (a) x402 payment payload signature resolving to an
//   on-chain agent identity, or (b) a signed request from the buyer's wallet.
//   Day 7 checklist item. See daily-logs/day7-wallet-checklist.md.
//
// SECURITY GATE (operator constraint, non-negotiable):
//   All demand request text is UNTRUSTED INPUT. The capability field is
//   sanitized at the HTTP boundary BEFORE any specialist/ranking logic sees
//   it. If sanitization empties the field, the request is rejected (422).
//   Payment payloads are untrusted input: parsed structurally, never executed.
//   Supplier payTo addresses fail format validation -> supplier excluded.
//
// DAY 8 â€” PRE-LIVE SECURITY CONTROLS (see daily-logs/day8-log.md):
//   GATE ORDER (new, strictly earliest-first):
//     1. KILL SWITCH  (endpoint/killswitch.js)   â€” SAAX_KILL_SWITCH / SAAX_KILL_SWITCH_FILE
//        Runs FIRST, before EVERYTHING (idempotency, rate limit, sanitization,
//        signature, on-chain, amount). Live verify + switch ON -> 503 halted.
//        Mock lane stays open (kill switch stops LIVE processing, not mock
//        testing).
//     2. RATE LIMIT   (endpoint/ratelimit.js)    â€” SAAX_RATE_LIMIT_{IP,WALLET}[,_WINDOW]
//        Two-tier sliding window (ip 60/min, wallet 30/min) BEFORE sanitization.
//        429 + Retry-After. No exemptions.
//     3. IDEMPOTENCY  (endpoint/idempotency.js)  â€” Idempotency-Key header or
//        deterministic derived key. verified/settled -> cached response;
//        pending -> 409; different payload hash -> 422. TTL 24h, hourly sweep.
//     4. SANITIZATION (existing gate, unchanged) â€” 422 on empty/injection.
//     5. PAYMENT VERIFICATION (existing x402 path, unchanged).
//     6. BUYER REPUTATION (endpoint/identity.js) â€” live: from the verified x402
//        signer address via IdentityRegistry reverse lookup + ReputationRegistry
//        (Path (a), operator-confirmed); mock: x-mock-buyer-rep header kept as
//        a stand-in. Live mode IGNORES the header. See Â§9/Â§6 of the checklist.
//     7. RANKING -> ROUTING -> SETTLEMENT (unchanged).
//
//   Regression contract (NOT optional): Day 5 unit 26/26, Day 5 E2E 17/17,
//   Day 6 unit 21/21, Day 7 E2E 4/4 must all still pass.
//
// Hosting: local station HTTP server (Vercel reauth pending). Reproduce with:
//   node endpoint/route-server.js            (port 8080 default, SAAX_PORT to override)
//   curl -X POST localhost:8080/route -H "Content-Type: application/json" -d "{\"capability\":\"security scan\",\"budget\":500,\"deadline\":\"2026-10-08\"}"
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JsonRpcProvider, Contract } = require('ethers');

const x402 = require('./x402.js');
const gateway = require('./gateway.js'); // Day 9: self-hosted x402 gateway (SAAX_X402_MODE=self)
// Day 11 (Item 3/4): commitment lifecycle leaf modules (loaded through the
// gateway facade so the rail registry is a single seam â€” see gateway.js).
const commitmentMod = require('./commitment.js');
const requirementMod = require('./requirement.js');
const receiptMod = require('./receipt.js');
const railsMod = require('./rails/index.js');
const railsX402 = require('./rails/x402.js');
const router = require('./router.js');
const settle = require('./settle.js');
const killswitch = require('./killswitch.js');
const ratelimit = require('./ratelimit.js');
const idempotency = require('./idempotency.js');
const identity = require('./identity.js');
const store = require('./store.js');
const subscriptionLookup = require('./subscription-lookup.js');
const outcomeLog = require('./outcome-log.js');
const escrowAccess = require('./escrow-access.js'); // Authenticated action-scoped escrow access (Day 20+)
const escrowMod = require('./escrow.js');
const workerInt = require('./worker-integration.js'); // D3 integrated worker bridge (gated: SAAX_INTEGRATED_WORKER=1)
const pilotLimits = require('./pilot-limits.js'); // Gate D.1: internal-Beta financial limits

// ---- Config (mirrors rank-suppliers.js; single swap point for Day 5) ------
// PORT binding: Railway assigns a dynamic port via PORT and requires the
// server to bind 0.0.0.0 (not localhost). Precedence: PORT (Railway) ->
// SAAX_PORT (local override) -> 8080 (default).
const PORT = Number(process.env.PORT || process.env.SAAX_PORT || 8080);
const HOST = process.env.SAAX_HOST || '0.0.0.0';
const SAAX_PRICE_SCORE_DEFAULT = Number(process.env.SAAX_PRICE_SCORE_DEFAULT || 50);
const SAAX_FRESHNESS_STRATEGY  = process.env.SAAX_FRESHNESS_STRATEGY || 'count_proxy';
const SAAX_CAPABILITY_FLOOR    = Number(process.env.SAAX_CAPABILITY_FLOOR || 0.4);
const RPC = process.env.SAAX_RPC_URL || 'https://base-rpc.publicnode.com';
const REPUTATION_REGISTRY = process.env.SAAX_REPUTATION_REGISTRY || '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

// ---- Day 9: self-hosted gateway mode ----------------------------------------
// SAAX_X402_MODE=self selects the self-hosted x402 gateway (verify + settle
// against Base Sepolia directly). Default mock keeps the existing lane.
const SELF_MODE = gateway.getMode() === 'self';
const INSTANCE_TOKEN = process.pid + ':' + Date.now();
// Branch provenance (Item 4 of the integration milestone): every 402 emission
// site names the branch that emitted it â€” observed, never inferred from the
// response shape. branch=<name> identifies the emitting site.
function diagBranch(branch, req) {
  const line = '[diag] pid=' + process.pid + ' instance=' + INSTANCE_TOKEN +
    ' branch=' + branch +
    ' SELF_MODE=' + (SELF_MODE ? 'true' : 'false') +
    ' getMode=' + gateway.getMode() +
    ' selfModeMatch=' + (SELF_MODE === (gateway.getMode() === 'self') ? 'true' : 'false') +
    ' sigHeader=' + (typeof sigHeader !== 'undefined' && sigHeader ? 'present' : 'absent') +
    ' method=' + (req && req.method || '?') + ' path=' + (req && req.url || '?');
  try { if (typeof log !== 'undefined' && log && typeof log.push === 'function') log.push(line); } catch (_) {}
  console.error(line);
}


// ---- Day 8: persistent store wiring ------------------------------------------
// Supabase when configured (SUPABASE_URL + service key); else in-memory fallback
// (brief's sanctioned route-around; both modules accept an injected client).
let _storeClient = null;
try {
  _storeClient = store.buildStoreClient();
} catch (_) { _storeClient = null; }
if (_storeClient) {
  idempotency.setStoreClient(_storeClient);
  ratelimit.setStoreClient(_storeClient);
  outcomeLog.setStoreClient(_storeClient);
  escrowMod.setStoreClient(_storeClient);
  // Gate D.1: the quota reservation engine shares the same PostgREST client.
  // It is the ONLY financial enforcement authority for pilot limits; when the
  // client is absent the module fails closed (see pilot-limits.evaluate).
  pilotLimits.setStoreClient(_storeClient);
}
// ---- Durable idempotency fallback (reliability audit, F-1/F-2/F-3) ----------
// When Supabase is NOT configured and the store is NOT forced to memory, wire
// the file-backed durable store into the idempotency gate and the gateway
// nonce guard so replay protection survives process restart. Single-writer
// topology: one process/host (local server, Railway single dyno). Multi-
// instance runtimes must configure Supabase (see design doc §5.1).
if (!_storeClient && String(process.env.SAAX_IDEMPOTENCY_STORE || '').toLowerCase() !== 'memory') {
  const { DurableIdempotencyStore } = require('./idempotency-durable.js');
  const durableDir = process.env.SAAX_IDEMPOTENCY_DIR || path.join(__dirname, '..', '.output', 'reliability', 'idempotency');
  try {
    const durableStore = new DurableIdempotencyStore(durableDir);
    idempotency.setDurableStore(durableStore);
    gateway.setNonceStore(durableStore);
    console.error('[reliability] durable idempotency store active at ' + durableDir);
  } catch (e) {
    console.error('[reliability] durable idempotency store init failed (falling back to memory): ' + (e.message || e));
  }
}
// Startup reconciliation: flip stale pending rows per mode. Mock -> failed
// (nothing was broadcast). Self with no chain consult -> left pending with an
// explicit unresolved marker (blocked, never silently retried). Run lazily on
// first handler entry so cold starts AND long-lived servers both reconcile.
let _reconciled = false;
async function reconcileIdempotencyOnce() {
  if (_reconciled) return;
  _reconciled = true;
  // Supabase/PostgREST path: reconcile the DURABLE DB record via the RPC
  // (transactional per-key advisory locks; unknown rows left pending — never
  // auto-replay). Evidence lists are empty here: the application has no
  // authoritative chain evidence at startup for arbitrary pending rows, so
  // this pass ONLY marks unresolved rows; it never resolves by age. Mock
  // lane (nothing broadcast) may force-fail.
  if (_storeClient) {
    try {
      const rec = require('./idempotency-reconcile.js');
      const res = await rec.reconcile({
        client: _storeClient,
        forceUnknown: !SELF_MODE, // mock lane: nothing was broadcast -> safe to fail
      });
      if (res.error) console.error('[reliability] DB idempotency reconciliation skipped: ' + res.error);
    } catch (e) {
      console.error('[reliability] DB idempotency reconciliation error: ' + (e.message || e));
    }
  }
  // File-backed durable store path (no Supabase configured, single-writer).
  const durable = idempotency.getDurableStore();
  if (!durable) return;
  try {
    const res = await durable.reconcilePending({ mode: SELF_MODE ? 'self' : 'mock' });
    if (res.reconciled || res.unresolved) {
      console.error('[reliability] idempotency reconciliation: reconciled=' + res.reconciled + ' unresolved=' + res.unresolved);
      for (const n of res.notes.slice(0, 10)) console.error('[reliability]   ' + n);
    }
  } catch (e) {
    console.error('[reliability] idempotency reconciliation error: ' + (e.message || e));
  }
}
// Test seam: force the idempotency store to in-memory for isolated harness
// runs (SAAX_IDEMPOTENCY_STORE=memory). The Day 9 harness uses this so a
// persistent row from a prior run can never replay a stale cached response
// into a fresh test (security sprint regression fix).
if (String(process.env.SAAX_IDEMPOTENCY_STORE || '').toLowerCase() === 'memory') {
  idempotency.setStoreMode('memory');
  gateway.setNonceStore(null); // memory mode must not persist nonces either
}
const STORE_ACTIVE = !!_storeClient;

// ---- Day 20 Phase 4: escrow-backed mode (test environment only) -------------
// When SAAX_ESCROW_BACKED=1, the settlement path REQUIRES the buyer's payment
// to have funded the custody escrow (verified on-chain) instead of a direct
// transfer. The escrow then holds funds until the agreed evaluator verdict
// releases (seller) or refunds (buyer). The immediate payment path is
// unchanged when the flag is unset. This mode must NOT be enabled in
// production financial behavior without explicit authorization.
const ESCROW_BACKED = String(process.env.SAAX_ESCROW_BACKED || '').trim() === '1';

// ---- Participant bearer-token gate (hosted pilot surface) -------------------
// When SAAX_PILOT_TOKEN is set, every request must present
// `Authorization: Bearer <token>` (constant-time compare). 401 without it,
// 401 on mismatch. The token is NEVER logged. Revocation = rotating the env
// value (read per request). This is a TRANSPORT-level gate for the hosted
// surface; the EIP-712 access authorization + chain/custody checks remain
// the application-level authorization. The gate runs before the kill switch
// so an unauthenticated host probe never reaches any handler.
const PILOT_TOKEN = String(process.env.SAAX_PILOT_TOKEN || '').trim();

function requirePilotToken(req, res, log) {
  if (!PILOT_TOKEN) return true; // gate disabled when unset
  const hdr = String(req.headers['authorization'] || '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  if (!m) {
    log.push('PILOT GATE: missing bearer token -> 401');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'pilot access token required' }));
    return false;
  }
  const given = String(m[1] || '').trim();
  const expected = String(PILOT_TOKEN).trim();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
  if (diff !== 0) {
    log.push('PILOT GATE: bad bearer token -> 401 (token never logged)');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'pilot access token invalid' }));
    return false;
  }
  return true;
}
if (ESCROW_BACKED) {
  console.log('ESCROW MODE ROUTING: access-auth header x-saax-access-auth accepted; payment-signature NOT accepted in escrow mode');
  console.log('ESCROW MODE ROUTING: ledger at ' + escrowAccess.LEDGER_PATH);
  
}

// ---- Authenticated action-scoped escrow access: handler ----------------------
// Runs the contract sequence for a request authenticated by x-saax-access-auth:
//   select mode -> authenticate role and action -> validate action-specific
//   custody conditions -> atomically record acceptance and nonce ->
//   execute/reconcile -> return recorded status or result
// Access authorization (permits the operation) is SEPARATE from the release
// verdict (moves escrowed funds, signed by the digest-covered evaluator under
// the deployed custody contract's EIP-712 scheme). This handler never moves
// funds: it authenticates, validates, records acceptance, and â€” for actions
// that are themselves on-chain operations (refund/dispute) â€” records the
// intended external action for the caller to execute through the verdict path.
async function handleEscrowAccess(req, res, log, ctx) {
  const respond = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let artifact = null;
  try {
    const b64 = String(req.headers['x-saax-access-auth'] || '');
    if (!b64) { respond(402, { error: 'escrow-backed mode: x-saax-access-auth header required' }); return; }
    artifact = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) { respond(402, { error: 'escrow-backed mode: malformed x-saax-access-auth: ' + String(e.message || e).slice(0, 120) }); return; }

  // 1. authenticate role and action (8 bindings; signature recovery)
  const auth = escrowAccess.verifyAccessAuthorization(artifact);
  if (!auth.ok) {
    log.push('ESCROW ACCESS REJECT: ' + auth.reason);
    diagBranch('escrow-access-auth-rejected', req);
    respond(401, { error: auth.reason, code: auth.error });
    return;
  }
  const p = artifact.payload;
  log.push('ESCROW ACCESS AUTH: role=' + p.role + ' action=' + p.action + ' nonce=' + p.nonce + ' signer=' + (auth.signer || '').slice(0, 10));

  // Settled commitment identity: the access authorization NAMES the escrow
  // it is authorized for (commitmentDigest == escrowId == the digest bytes32
  // the escrow was funded against). The request's provisional manifest cid
  // may differ (a fresh app issuance derives a new manifest); what matters
  // for escrow access is that the caller's authorization binds the REAL
  // funded escrow on the configured custody. The escrowId from the signed
  // access auth is therefore the settlement identity.
  const manifestCid = String(ctx.manifestCid || '').toLowerCase();
  const authCid = String(p.commitmentDigest || '').toLowerCase();
  const authEscrow = String(p.escrowId || '').toLowerCase();
  if (!authCid || !authEscrow || authCid !== authEscrow) {
    const reason = 'escrow access: commitmentDigest and escrowId must be identical bytes32 digest references (got ' + authCid.slice(0, 14) + ' / ' + authEscrow.slice(0, 14) + ')';
    log.push('ESCROW ACCESS REJECT: ' + reason);
    diagBranch('escrow-access-binding-mismatch', req);
    respond(401, { error: reason });
    return;
  }
  // When the caller provides an explicit commitment override it must equal
  // the access escrowId; otherwise the provisional manifest cid is IGNORED
  // for escrow access (the signed escrowId is authoritative).
  const settleCid = authEscrow;
  if (ctx.saaxCommitmentOverride && String(ctx.saaxCommitmentOverride).toLowerCase() !== authEscrow) {
    const reason = 'escrow access: override ' + String(ctx.saaxCommitmentOverride).slice(0, 14) + ' != access escrowId ' + authEscrow.slice(0, 14);
    log.push('ESCROW ACCESS REJECT: ' + reason);
    respond(401, { error: reason });
    return;
  }
  // Custody + chain must match the access auth bindings.
  const custody = String(process.env.SAAX_CUSTODY_ADDRESS || '').trim().toLowerCase();
  if (!custody || custody !== String(p.custody || '').toLowerCase()) {
    const reason = 'escrow access: custody ' + String(p.custody || 'none').toLowerCase() + ' != configured ' + (custody || 'none');
    log.push('ESCROW ACCESS REJECT: ' + reason);
    respond(401, { error: reason });
    return;
  }

  // 2. validate action-specific custody conditions (funding gate)
  //    Funding is REQUIRED for execution operations (execute, submit evidence,
  //    request refund, initiate dispute, submit verdict, resolve dispute).
  //    Status and recovery queries (request status) NEVER require funding.
  const isExecution = p.action !== 'request status';
  let escrowProof = null;
  try {
    escrowProof = await escrowMod.verifyOnChain(settleCid, { custody });
  } catch (e) {
    log.push('ESCROW ACCESS REJECT: on-chain verify failed: ' + String(e.message || e).slice(0, 120));
    respond(402, { error: 'escrow-backed mode: on-chain verify failed: ' + String(e.message || e).slice(0, 120) });
    return;
  }
  if (!escrowProof.ok) {
    log.push('ESCROW ACCESS REJECT: ' + (escrowProof.reason || escrowProof.error));
    respond(402, { error: 'escrow-backed mode: ' + (escrowProof.reason || escrowProof.error || 'verify failed') });
    return;
  }
  const esc = escrowProof.escrow;
  if (isExecution) {
    // Parties + digest + amount + asset must match the AGREEMENT â€” the
    // signed manifest's terms (buyer/seller/amount/currency resolved to the
    // escrow asset), NOT request-supplied identities or operator config
    // alone. The on-chain escrow's digest is already the manifest hash
    // (settleCid == digest == escrowId), binding the escrow to the manifest.
    const agr = ctx.agreement || {};
    const dr = escrowAccess.verifyFundingBindings(esc, {
      digest: settleCid,
      buyer: agr.buyer,
      seller: agr.seller,
      evaluator: escrowAccess.roleAddrFor('evaluator'),
      amount: agr.amount,
      asset: escrowAccess.assetAddressFor(agr.currency),
    });
    if (!dr.ok) {
      log.push('ESCROW ACCESS REJECT (funding bindings): ' + dr.reason);
      respond(402, { error: 'escrow-backed mode: ' + dr.reason });
      return;
    }
    // Role-scoped signer binding: the recovered access signer must be the
    // on-chain escrow party that owns the action's role. A buyer-scoped
    // action requires signer == escrow.buyer (and == agreement buyer via the
    // check above); seller/evaluator actions require their own party. A
    // configured buyer address alone is NOT sufficient â€” the escrow's own
    // buyer must match the signer.
    const roleParty = { buyer: esc.buyer, seller: esc.seller, evaluator: esc.evaluator }[p.role];
    if (roleParty && String(roleParty).toLowerCase() !== String(auth.signer).toLowerCase()) {
      const reason = 'escrow-backed mode: access signer ' + String(auth.signer).slice(0, 10) + ' != on-chain escrow ' + p.role + ' ' + String(roleParty).slice(0, 10);
      log.push('ESCROW ACCESS REJECT (signer/escrow party): ' + reason);
      respond(402, { error: reason });
      return;
    }
    if (!escrowProof.funded || esc.state === 'released' || esc.state === 'refunded' || esc.state === 'timed_out') {
      const reason = 'escrow-backed mode: escrow not funded/terminal (state=' + esc.state + ') for execution action ' + p.action + ' â€” status queries do not require funding';
      log.push('ESCROW ACCESS REJECT: ' + reason);
      diagBranch('escrow-access-unfunded', req);
      respond(402, { error: reason });
      return;
    }
  }

  // 3. atomically record acceptance + nonce (durable; idempotent retry)
  // D3 INTEGRATED MODE (SAAX_INTEGRATED_WORKER=1): the acceptance is ONE
  // transaction in the shared SQLite store (operation + work item + journal
  // outbox intent). The hosted lane (env unset) keeps the JSON ledger path
  // below — byte-identical behavior. The actionArgs (verdict/commitment
  // parameters for the custody call) come from the request BODY, NOT the
  // signed access auth (the auth stays 8 fields); authority to EXECUTE comes
  // solely from the contract path (2-of-3 Safe for release/refund, timeout
  // rules for timeout refund, buyer/seller for dispute) validated by the
  // worker's D2Prerequisites — never from the body.
  let integratedReqBody = null;
  try {
    if (ctx.reqBody) {
      const parsedBody = typeof ctx.reqBody === 'string' ? JSON.parse(ctx.reqBody) : ctx.reqBody;
      if (parsedBody && parsedBody.actionArgs) integratedReqBody = { actionArgs: parsedBody.actionArgs, exportArtifacts: parsedBody.exportArtifacts || null };
    }
  } catch (_) { integratedReqBody = null; }
  if (workerInt.enabled() && integratedReqBody && integratedReqBody.actionArgs) {
    const integ = workerInt.acceptIntegrated(p, {
      recoveredSigner: auth.signer,
      manifestCid: settleCid,
      chainId: p.chainId,
      action: p.action,
      payloadDigest: escrowAccess.payloadHash(p),
      relayerAccount: String(process.env.SAAX_D2_RELAYER_ADDRESS || '').trim().toLowerCase(),
      workRequired: true,
      actionArgs: integratedReqBody.actionArgs,
      exportArtifacts: integratedReqBody.exportArtifacts,
      // The outbox intent carries the CONFIRMED transition the worker must
      // journal after execution (never 'intent' for an executable action —
      // the intent entry is recorded separately at acceptance). Derived from
      // the action here so the outbox intent is exact.
      journalTransition: { 'submit verdict': 'release', 'request refund': 'refund', 'initiate dispute': 'dispute', 'resolve dispute': 'release', release: 'release', refund: 'refund' }[p.action] || 'intent',
    });
    if (!integ.ok) {
      log.push('ESCROW ACCESS INTEGRATED REJECT: ' + integ.reason);
      respond(409, { error: integ.reason, code: integ.reason });
      return;
    }
    if (integ.idempotent) {
      log.push('ESCROW ACCESS INTEGRATED RETRY (idempotent): nonce ' + p.nonce + ' -> op ' + integ.opId);
      respond(200, { ok: true, idempotent: true, operation: integ.opId, status: integ.op.status, work: !!integ.work, outbox: !!integ.outbox });
      return;
    }
    log.push('ESCROW ACCESS INTEGRATED ACCEPTED: nonce ' + p.nonce + ' -> op ' + integ.opId + ' action=' + p.action);
    respond(200, { ok: true, mode: 'escrow-access-integrated', operation: integ.opId, action: p.action, escrow: esc, status: 'accepted', note: 'durably accepted in ONE transaction; worker executes on-chain action and reconciles' });
    return;
  }
  const accept = escrowAccess.acceptOperation(p, { action: p.action, manifestCid: settleCid, chainId: p.chainId, recoveredSigner: auth.signer });
  if (accept.duplicate) {
    log.push('ESCROW ACCESS DUPLICATE: ' + accept.reason);
    respond(409, { error: accept.reason, code: 'DUPLICATE' });
    return;
  }
  if (accept.conflict) {
    log.push('ESCROW ACCESS CONFLICT: ' + accept.reason);
    respond(409, { error: accept.reason });
    return;
  }
  if (accept.idempotent && accept.recorded) {
    log.push('ESCROW ACCESS RETRY (idempotent): nonce ' + p.nonce + ' returns recorded result, external effect NOT repeated');
    respond(200, { ok: true, idempotent: true, recorded: accept.recorded });
    return;
  }
  log.push('ESCROW ACCESS ACCEPTED (durable, nonce consumed): nonce=' + p.nonce + ' action=' + p.action + ' status=' + (accept.recorded && accept.recorded.status));

  // 4. reconcile/return â€” for on-chain financial actions (refund/dispute/
  //    verdict) the caller executes the external effect through the verdict
  //    path and then reconciles; status/dry operations return here.
  if (p.action === 'request status') {
    respond(200, { ok: true, mode: 'escrow-access', escrow: esc, fundingTx: esc.fundTx, fundingBlock: esc.fundBlock, accepted: accept.recorded, status: 'recorded' });
    return;
  }
  // Execution actions are recorded as accepted; the external effect (release/
  // refund via the verdict path) is executed by the caller and reconciled.
  respond(200, { ok: true, mode: 'escrow-access', action: p.action, accepted: accept.recorded, escrow: esc, note: 'accepted durably; external effect pending caller execution via verdict path, then reconcile(nonce, outcome)' });
}

// Sanctioned route-around: with no Supabase creds configured, the limiter runs
// the in-memory sliding window with periodic flush (no blocking).
ratelimit.ensureStoreMode(STORE_ACTIVE);
const RATE_LIMIT_STORE = ratelimit.getStoreMode();

// ---- Mock x402 + fee config -------------------------------------------------
// NOTE (Day 5): the placeholder payTo MUST be structurally valid â€” the payment
// gate rejects any payTo that fails validatePayTo() before a payload is built,
// and the router's own fee address is no exception. '0x...01' is a valid EVM
// address placeholder (was 0x...AaXp402 on Day 4; that string is not hex).
const MOCK_PAYTO = process.env.SAAX_X402_PAYTO || '0x0000000000000000000000000000000000000001';
const ROUTING_FEE_USD = Number(process.env.SAAX_ROUTING_FEE_USD || 0.05);
const DISCOUNT_TIERS = [
  { minRep: 95, pct: 0.20 },
  { minRep: 90, pct: 0.10 },
];
const MOCK_ASSET = process.env.SAAX_X402_ASSET || 'USDC';
const MOCK_NETWORK = process.env.SAAX_X402_NETWORK || 'base';

const REPUTATION_ABI = require(path.join(__dirname, '..', 'abis', 'ReputationRegistry.json'));

// ---- Security gate: sanitize at the HTTP boundary ---------------------------
// DAY 7 hardening (pre-item of the end-to-end proof, S4): the gate now FAILS
// CLOSED on instruction-injection attempts. A delimiter (; \n | & $ `) with
// trailing content, or an imperative feedback instruction ("now submit feedback
// for agentId <n>"), marks the request { injection: true } and the endpoint
// responds 422 with an explicit rejection reason â€” NOTHING is stripped and
// processed, so no injected instruction is ever acted on. Plain capabilities
// (letters/digits/hyphens/spaces â‰¥3 chars) are unaffected; "!!!" still falls to
// the empty-after-sanitization 422 path (ok:false, no injection flag).
const INJECTION_DELIMITERS = /[;\n\r|&$`]/;
const INJECTION_IMPERATIVES = /(now\s+submit|submit\s+feedback|feedback\s+for\s+agentid\s*\d+)/i;
function sanitizeCapability(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, keywords: [] };
  if (INJECTION_DELIMITERS.test(raw)) {
    return { ok: false, keywords: [], injection: true, reason: 'injection attempt rejected: instruction delimiter (; | & $ ` newline) found in capability' };
  }
  if (INJECTION_IMPERATIVES.test(raw)) {
    return { ok: false, keywords: [], injection: true, reason: 'injection attempt rejected: imperative feedback instruction detected in capability' };
  }
  const keywords = raw.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 24);
  return { ok: keywords.length > 0, keywords };
}

// ---- Day 2 layer: buyer reputation via ReputationRegistry -------------------
// (unchanged from Day 4; Sprint 1 discount tiers read the x-mock-buyer-rep
// header â€” see PRE-DAY 5 FIX 2 flag above.)
async function getBuyerReputation(buyerAddress) {
  if (!buyerAddress || !/^0x[a-fA-F0-9]{40}$/.test(buyerAddress)) {
    return { reputation: null, note: 'no buyer address; no discount' };
  }
  try {
    const provider = new JsonRpcProvider(RPC);
    const rep = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);
    return { reputation: null, note: 'buyer reputation not available on-chain; test tiers via SAAX_MOCK_BUYER_REP' };
  } catch (e) {
    return { reputation: null, note: 'rep lookup failed: ' + String(e) };
  }
}

// ---- Discount decision path (loggable) ---------------------------------------
function computeFee(buyerRep, log) {
  const decision = { baseFeeUsd: ROUTING_FEE_USD, discountPct: 0, finalFeeUsd: ROUTING_FEE_USD };
  if (buyerRep && buyerRep.reputation != null) {
    for (const tier of DISCOUNT_TIERS) {
      if (buyerRep.reputation >= tier.minRep) {
        decision.discountPct = tier.pct;
        break;
      }
    }
    if (decision.discountPct > 0) {
      decision.finalFeeUsd = Math.round(ROUTING_FEE_USD * (1 - decision.discountPct) * 1e6) / 1e6;
      decision.log = `buyer rep ${buyerRep.reputation} >= ${decision.discountPct === 0.2 ? 95 : 90} -> ${Math.round(decision.discountPct * 100)}% off`;
    } else {
      decision.log = `buyer rep ${buyerRep.reputation} below 90 -> no discount`;
    }
  } else {
    decision.log = buyerRep && buyerRep.note ? buyerRep.note : 'no buyer reputation data -> no discount';
  }
  if (log) log.push(decision.log);
  return decision;
}

// ---- x402 v2 challenge ---------------------------------------------------------
function buildChallenge() {
  return {
    error: '402 Payment Required',
    x402Version: 2,
    scheme: 'x402',
    network: MOCK_NETWORK,
    resource: {
      url: 'urn:saax-protocol:route:v1',
      description: 'SAAX route',
      mimeType: 'application/json',
    },
    accepts: [{
      scheme: 'exact',
      network: MOCK_NETWORK,
      amount: String(Math.round(ROUTING_FEE_USD * 10 ** 6)), // token atomic units (USDC 6 decimals): 0.05 USDC = "50000"
      maxAmountRequired: ROUTING_FEE_USD,
      payTo: MOCK_PAYTO,
      asset: MOCK_ASSET,
      resource: 'urn:saax-protocol:route:v1',
      schemes: ['exact', 'upto'], // Day 5: fixed-price (exact) + usage-based (upto)
      maxTimeoutSeconds: 300,
      description: 'SAAX route',
      extra: gateway.acceptedExtra(),
    }],
    extensions: {
      bazaar: {
        schema: {
          properties: {
            input: {
              properties: {
                body: {
                  type: 'object',
                  properties: {
                    capability: { type: 'string', description: 'The capability requested (e.g. security scan).' },
                    budget: { type: 'number', description: 'Maximum budget in USD the caller is willing to pay.' },
                  },
                  required: ['capability'],
                },
              },
            },
            output: {
              properties: {
                example: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    matches: { type: 'array' },
                  },
                },
              },
            },
          },
        },
      },
    },

  };
}

// ---- SELF-mode x402 v2 challenge (x402scan probe contract, Day 15 patch) ------
// The discovery/registration probe reads the served 402 BODY (accepts[]), not
// just the PAYMENT-REQUIRED header. In SELF mode the challenge must therefore
// carry the self-shape values in its accepts[] entry - scheme x402, amount in
// token atomic units, caip-2 network eip155:8453, Base mainnet USDC, and the
// configured payee (vault, then seller). gateway.buildChallenge() emits these at
// the top level with no accepts[] array, so the probe branches that answer
// unauthenticated discovery requests must build the self shape themselves,
// identical to the main SELF branch in handleRoute (line ~847). The payee,
// network, asset, and amount are the SAME values as the header - declared in
// accepts[] so the runtime checker sees them.
function selfChallenge() {
  return {
    error: '402 Payment Required',
    x402Version: 2,
    scheme: 'x402',
    network: gateway.NETWORK_CAIP2_BASE_SEPOLIA, // eip155:8453 (Base mainnet) with SAAX_CHAIN_ID=8453
    resource: {
      url: 'urn:saax-protocol:route:v1',
      description: 'SAAX route',
      mimeType: 'application/json',
    },
    accepts: [{
      scheme: 'exact',
      method: 'x402',
      network: gateway.NETWORK_CAIP2_BASE_SEPOLIA,
      asset: gateway.USDC_BASE_SEPOLIA,           // Base mainnet USDC with SAAX_CHAIN_ID=8453
      amount: gateway.rawUnits(ROUTING_FEE_USD),  // token atomic units: 0.05 USDC = "50000"
      maxAmountRequired: ROUTING_FEE_USD,
      payTo: gateway.getOperativePayee() || MOCK_PAYTO,
      resource: 'urn:saax-protocol:route:v1',
      schemes: ['exact', 'upto'],
      maxTimeoutSeconds: 300,
      description: 'SAAX route',
      extra: gateway.acceptedExtra(),
    }],
    extensions: {
      bazaar: {
        schema: {
          properties: {
            input: {
              properties: {
                body: {
                  type: 'object',
                  properties: {
                    capability: { type: 'string', description: 'The capability requested (e.g. security scan).' },
                    budget: { type: 'number', description: 'Maximum budget in USD the caller is willing to pay.' },
                  },
                  required: ['capability'],
                },
              },
            },
            output: {
              properties: {
                example: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    matches: { type: 'array' },
                  },
                },
              },
            },
          },
        },
      },
    },

  };
}
function selfChallengeHeaders() {
  return {
    [gateway.HEADERS.PAYMENT_REQUIRED]: gateway.buildPaymentRequiredHeader({
      amountRaw: gateway.rawUnits(ROUTING_FEE_USD),
      network: gateway.NETWORK_CAIP2_BASE_SEPOLIA,
      asset: gateway.USDC_BASE_SEPOLIA,
      payTo: gateway.getOperativePayee() || MOCK_PAYTO,
      facilitator: 'self',
      scheme: 'exact',
      resource: 'urn:saax-protocol:route:v1',
    }),
  };
}

// ---- x402scan discovery (Day 15): serve the committed OpenAPI document -------
// The x402 discovery scanner probes the origin for /openapi.json before
// indexing /route (a missing document surfaces as L3_NOT_FOUND). This is a
// discovery contract only: it describes the /route endpoint's request/response
// shape. It never describes the commitment layer, the settlement-to-store
// linkage, or any rail other than x402. The document lives at
// landing/openapi.json (tracked, blob 931673a0) and is served byte-identical.
// Railway runs `node endpoint/route-server.js` from the repo root, so the
// relative path (one level up, then landing/) resolves inside the deployment.
const OPENAPI_PATH = path.join(__dirname, '..', 'landing', 'openapi.json');
function serveOpenapi(req, res) {
  try {
    const content = fs.readFileSync(OPENAPI_PATH, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(content, 'utf8'),
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'openapi document unavailable', reason: String(e.message || e).slice(0, 200) }));
  }
}

// ---- Favicon (x402scan FAVICON_MISSING, Day 15) -----------------------
// Serves the SAAX favicon from the same origin so discovery scanners that
// fetch /favicon.ico from the origin root find it. The asset lives in the
// repo at landing/assets/favicon.ico and is tracked; Railway runs from the
// repo root so the relative path resolves inside the deployment.
const FAVICON_PATH = path.join(__dirname, '..', 'landing', 'assets', 'favicon.ico');
function serveFavicon(req, res) {
  try {
    const content = fs.readFileSync(FAVICON_PATH);
    res.writeHead(200, {
      'Content-Type': 'image/x-icon',
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'favicon unavailable' }));
  }
}


// ---- Payload validation --------------------------------------------------------
function parsePayload(body) {
  let raw;
  try { raw = JSON.parse(body); }
  catch (_) { return { error: 'invalid json' }; }
  if (!raw || typeof raw !== 'object') return { error: 'body must be a JSON object' };
  const capability = raw.capability || '';
  const budget = raw.budget;
  const deadline = raw.deadline;
  const subscriptionEmail = raw.subscriptionEmail;
  if (typeof capability !== 'string') return { error: 'capability must be a string' };
  // Demand request fields are sanitized at the HTTP boundary (security sprint
  // Item 2). budget must be a finite number or numeric string (or absent);
  // deadline must be a valid ISO/YYYY-MM-DD date or a numeric timestamp (or
  // absent). Anything else -> 422, before any ranking/idempotency logic sees it.
  if (budget !== undefined && budget !== null) {
    const isNum = (typeof budget === 'number' && Number.isFinite(budget)) ||
      (typeof budget === 'string' && /^\d+(\.\d+)?$/.test(budget.trim()));
    if (!isNum) return { error: 'budget must be a finite number' };
  }
  if (deadline !== undefined && deadline !== null) {
    const isDate = typeof deadline === 'string' && (
      /^\d{4}-\d{2}-\d{2}$/.test(deadline) ||
      !isNaN(Date.parse(deadline))
    );
    const isTs = (typeof deadline === 'number' && Number.isFinite(deadline)) ||
      (typeof deadline === 'string' && /^\d{10,13}$/.test(deadline.trim()));
    if (!isDate && !isTs) return { error: 'deadline must be a valid date or timestamp' };
  }
  return { capability, budget, deadline, subscriptionEmail };
}

// ---- Ranking (imports Day 3 engine; sanitization is re-applied inside) ------
const { buildRanker } = require(path.join(__dirname, '..', 'scripts', 'rank-suppliers.js'));

function loadLocal() {
  // Data directory is excluded from Vercel deploys (.vercelignore: data/) and
  // the endpoint/ JSON mirrors are not always present inside the serverless
  // /var/task snapshot. The definitive shipped fallback is the MCP supplier
  // index (endpoint/mcp-supplier-index.json) â€” PROVEN to ship (the /mcp
  // function reads it on every deploy).
  //
  // IMPORTANT: only the AGENTS file may fall back to the supplier index. The
  // reputation and leaderboard files have NO shipped fallback; when absent
  // they default to [] (buildRanker tolerates missing reputation â†’ score 0).
  // Never let those fall through to mcp-supplier-index.json â€” its object
  // shape ({suppliers:[...]}) is not iterable and crashes loadLocal.
  let agents = null;
  try {
    agents = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agents-day1-named.json'), 'utf8'));
  } catch (_) {
    try {
      agents = JSON.parse(fs.readFileSync(path.join(__dirname, 'agents-day1-named.json'), 'utf8'));
    } catch (__) {
      agents = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-supplier-index.json'), 'utf8')).suppliers;
    }
  }
  let rep = [];
  for (const rel of ['reputation-day3.json', 'reputation-day2.json']) {
    for (const base of [path.join(__dirname, '..', 'data'), __dirname]) {
      try { rep = JSON.parse(fs.readFileSync(path.join(base, rel), 'utf8')); break; } catch (_) {}
    }
    if (rep.length) break;
  }
  const repMap = {};
  for (const r of (Array.isArray(rep) ? rep : Object.values(rep))) repMap[r.agent_id] = r;
  let leaderboard = [];
  for (const base of [path.join(__dirname, '..', 'data'), __dirname]) {
    try { leaderboard = JSON.parse(fs.readFileSync(path.join(base, 'leaderboard-suppliers-day3.json'), 'utf8')); break; } catch (_) {}
  }
  if (!Array.isArray(leaderboard)) leaderboard = [];
  for (const agent of leaderboard) {
    if (agent.reputation_probe && !repMap[agent.agent_id]) {
      repMap[agent.agent_id] = { agent_id: agent.agent_id, clients: agent.reputation_probe.clients || 0, count: agent.reputation_probe.count || 0, avgX100: agent.reputation_probe.avgX100 };
    }
  }
  return { agents, repMap, leaderboard };
}

const state = loadLocal();
const ranker = buildRanker({ agents: state.agents, repMap: state.repMap, leaderboard: state.leaderboard });
const registrations = router.loadRegistrations();

// ---- Day 11 (Item 3): register the x402 rail once ----------------------------
// The rail registry is the settlement-method-neutral seam: x402 is registered
// now; mpp/entitlement stubs exist with complete interfaces but are NOT
// registered (registration is the operator's explicit opt-in for a live rail).
try {
  railsMod.register('x402', railsX402);
} catch (e) {
  console.error('rails.register(x402) failed: ' + (e.message || e));
}

// ---- Day 12 (Item 3): register the MPP rail once -----------------------------
// MPP is the second registered settlement rail: the mppx-backed implementation
// (endpoint/rails/mpp.js). When mppx is installed this registers the live rail
// so the dual-challenge gateway advertises both x402 and MPP; a missing mppx
// (or a broken install) degrades to x402-only rather than crashing the server.
if (!railsMod.resolve('mpp')) {
  try {
    // eslint-disable-next-line global-require
    const railsMpp = require('./rails/mpp.js');
    railsMod.register('mpp', railsMpp);
    let mppxVersion = '?';
    try { mppxVersion = require('mppx/package.json').version; } catch (e) { /* exports map blocks the subpath; fall back to a static read */ }
    console.error('rails.register(mpp) OK â€” MPP rail live (mppx ' + mppxVersion + ')');
  } catch (e) {
    console.error('rails.register(mpp) failed (x402-only mode): ' + (e.message || e));
  }
}

// ---- Server ----------------------------------------------------------------------
// Redact the Authorization header from any request object before logging
// (defense in depth: never echo bearer tokens into logs).
function redactAuthHeader(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = Object.assign({}, headers);
  if ('authorization' in out) out.authorization = '[REDACTED]';
  return out;
}

function clientIp(req) {
  // Only trust X-Forwarded-For when a trusted proxy is explicitly configured
  // (SAAX_TRUST_PROXY=true). Otherwise a client can spoof the header to rotate
  // identities and bypass the per-IP rate limit (security sprint Item 3).
  if (process.env.SAAX_TRUST_PROXY === 'true' || process.env.SAAX_TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

// Wallet address from the x402 payload (or legacy mock header), used for the
// per-wallet rate-limit tier AND for reputation resolution.
function walletFromReq(req) {
  const legacy = (req.headers['x-x402-mock'] || '').trim();
  if (legacy === 'mock') {
    return process.env.SAAX_X402_MOCK_FROM || '0x0000000000000000000000000000000000000001';
  }
  const sig = (req.headers['payment-signature'] || '').trim();
  if (!sig) return null;
  const parsed = (gateway.getMode() === 'self' ? gateway : x402).parsePaymentSignatureHeader(sig);
  if (!parsed.ok || !parsed.payload || !parsed.payload.payload) return null;
  const auth = parsed.payload.payload.authorization || {};
  return String(auth.from || '').toLowerCase() || null;
}

async function handleRoute(req, res, body) {
  const log = [];

  // Reliability audit (F-2): reconcile stale pending idempotency rows once per
  // process before serving. Mock mode flips stale pending -> failed; self mode
  // without chain consult leaves them blocked with recovery:'unresolved'.
  await reconcileIdempotencyOnce();

  // Participant bearer-token gate (hosted pilot surface): runs before every
  // other gate. When SAAX_PILOT_TOKEN is set, a valid Bearer token is
  // required; the token value is never logged.
  if (!requirePilotToken(req, res, log)) return;

  // ---- DAY 8 GATES (earliest-first; the kill switch is THE first gate) -------
  // 1. KILL SWITCH â€” before BODY PARSING, before idempotency, before rate
  //    limiting, before sanitization, before signature/on-chain/amount. Live
  //    verify + switch ON -> 503 halted; mock lane stays open (kill switch
  //    stops live processing, not mock testing). A halted server answers 503
  //    even to a malformed body â€” no request content is processed or echoed.
  const verifyModeNow = x402.getVerifyMode();
  // Day 9: in self mode settlement is REAL (broadcast to Base Sepolia) â€” the
  // kill switch must treat it as live, not as the mock testing lane.
  const ksMode = SELF_MODE ? 'live' : verifyModeNow;
  const ks = killswitch.requireKillSwitch(ksMode);
  if (!ks.ok) {
    log.push('KILL SWITCH: ' + JSON.stringify(ks.body) + ' (verify mode=' + verifyModeNow + ', gateway mode=' + gateway.getMode() + ')');
    res.writeHead(ks.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ks.body));
    return;
  }
  if (ks.note) log.push(ks.note);

  // x402scan probe short-circuit (Day 15): an unauthenticated request with an
  // EMPTY or MALFORMED body â€” the shape a discovery scanner sends â€” is answered
  // with the bare 402 challenge, not a 400. There is no capability to commit
  // against, so no commitment is issued; the bare buildChallenge() carries the
  // payment requirement (payTo, asset, network, amount) exactly as the first
  // hop of any handshake does. A request WITH a payment signature is unaffected
  // (it proceeds to the normal parse + verification path below). A valid JSON
  // body WITHOUT a payment signature also proceeds (it enters the governed
  // commitment flow and receives the commitment-bound 402).
  const probeHasPayment = !!(req.headers['payment-signature'] || req.headers['x-x402-mock'] === 'mock');
  const probeBodyEmpty = !body || !String(body).replace(/^\s+|\s+$/g, '');
  let probeBodyParseable = false;
  try { probeBodyParseable = !!JSON.parse(body); } catch (_) { probeBodyParseable = false; }
  const probeIsMalformedProbe = !probeHasPayment && (probeBodyEmpty || !probeBodyParseable);
  if (probeIsMalformedProbe) {
    log.push('PROBE: unauthenticated empty/malformed body -> bare 402 challenge (x402scan handshake)');
    // SELF mode serves the self-shape challenge (accepts[] carries eip155:8453,
    // mainnet USDC, configured payee, amount in atomic units); mock mode keeps
    // the legacy mock shape. The header is always emitted in SELF mode.
    const probeChallenge = SELF_MODE ? selfChallenge() : buildChallenge();
    probeChallenge.accepts[0].maxAmountRequired = ROUTING_FEE_USD;
    const probeHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };
    if (SELF_MODE) Object.assign(probeHeaders, selfChallengeHeaders());
    diagBranch('probe-handshake', req);
    res.writeHead(402, probeHeaders);
    res.end(JSON.stringify(probeChallenge));
    return;
  }

  // Body parse happens AFTER the kill switch (the emergency brake must never
  // have to wait on request parsing). budget/deadline are sanitized at the
  // HTTP boundary here, before any ranking/idempotency logic sees them
  // (security sprint Item 2: demand request fields sanitized; empty or
  // injection-containing fields return 422). Note (Day 15): a MALFORMED body
  // with a payment signature still falls through to parsePayload below and
  // yields a 400 â€” a signed payment must present a well-formed demand body.
  const payload = parsePayload(body);
  if (payload.error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: payload.error }));
    return;
  }

  // 2. RATE LIMIT â€” two-tier sliding window BEFORE sanitization and payment
  //    verification. 429 + Retry-After. No exemptions (the operator's own
  //    test wallet obeys; raise the limit, never exempt).
  const ipNow = clientIp(req);
  const walletNow = walletFromReq(req);
  const rl = await ratelimit.checkAndRecord(ipNow, walletNow);
  if (!rl.ok) {
    log.push('RATE LIMIT: ' + rl.limitType + ' tier exceeded (' + rl.counts[rl.limitType] + ' in window) -> 429, retry-after ' + rl.retryAfterSeconds);
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfterSeconds) });
    res.end(JSON.stringify({
      error: 'too many requests',
      limitType: rl.limitType,
      retryAfterSeconds: rl.retryAfterSeconds,
      limit: ratelimit.limitsFor(rl.limitType).limit,
    }));
    return;
  }
  if (rl.errors && rl.errors.length) log.push('RATE LIMIT store warning (fail-open): ' + rl.errors.join('; '));

  // 2b. BUYER IDENTITY (optional) â€” the `subscriptionEmail` body field.
  //     Validated HERE (after rate limiting, before idempotency) so the lookup
  //     is rate-limited and no idempotency key is acquired for a request that
  //     is about to be rejected. A supplied email is checked against the
  //     subscriptions table via lookup_subscription â€” the SAME RPC the premium
  //     gating uses. Valid + active -> the email is carried into commitment
  //     issuance (stored as buyer_email, so list_commitments can resolve it).
  //     Present but unresolvable -> 400 invalid_subscription_email, and NO
  //     commitment is issued. Absent -> unchanged behavior (buyer_email NULL).
  //     The 402 challenge, security gate, ranking and response shape are
  //     untouched.
  let verifiedSubscriptionEmail = null;
  if (payload.subscriptionEmail !== undefined && payload.subscriptionEmail !== null && payload.subscriptionEmail !== '') {
    const rawEmail = typeof payload.subscriptionEmail === 'string' ? payload.subscriptionEmail.trim() : '';
    let activeSub = null;
    try {
      if (rawEmail) activeSub = await subscriptionLookup.lookupActiveSubscription(rawEmail);
    } catch (e) {
      // Lookup unavailable: fail closed. Do not issue a commitment under an
      // identity we could not verify (mirrors the 'does not resolve' contract).
      log.push('BUYER IDENTITY: subscription lookup failed (' + e.message + ') -> 400');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_subscription_email' }));
      return;
    }
    if (!rawEmail || !activeSub) {
      log.push('BUYER IDENTITY: subscriptionEmail ' + JSON.stringify(payload.subscriptionEmail) + ' -> no active subscription -> 400');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_subscription_email' }));
      return;
    }
    verifiedSubscriptionEmail = rawEmail;
    log.push('BUYER IDENTITY: subscriptionEmail ' + rawEmail + ' resolved to an active subscription');
  }

  // 3. IDEMPOTENCY â€” key from header or derived deterministic key; checked
  //    BEFORE payment verification. verified/settled -> cached response,
  //    pending -> 409, payload-hash mismatch -> 422.
  //
  //    IMPORTANT (Day 8 fix): a request with NO payment signature (bare 402
  //    challenge probe) has nothing to duplicate â€” acquiring a key for it would
  //    poison the key with a 'pending' row that never settles and 409s the next
  //    legitimate attempt. The idempotency gate therefore only activates when a
  //    payment header (or legacy mock header) is PRESENT. This preserves the
  //    brief's ordering (idempotency BEFORE verification) while keeping the
  //    challenge path idempotency-neutral.
  const hasPaymentHeader = !!(req.headers['payment-signature'] || req.headers['x-x402-mock'] === 'mock');
  // FINAL RELIABILITY GATE (Phase 2 — production storage enforcement):
  // In live (SELF) mode, financial processing MUST NOT proceed when the
  // idempotency store is not durable (in-memory process-local Map = replay
  // protection dies with the process; a missing/broken store = fail-closed
  // rejection). A challenge probe (no payment header) is idempotency-neutral
  // and stays available. Mock mode is a no-financial-effect development lane
  // and is intentionally unaffected.
  if (hasPaymentHeader) {
    if (SELF_MODE && !idempotency.isDurableActive()) {
      log.push('FINAL GATE: SELF mode + non-durable store -> 503 (fail-closed; no financial processing)');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporarily unavailable', retryable: true, reason: 'required durable payment store is not available; no payment was initiated' }));
      return;
    }
    // Store unavailable during the gate (503 path): fail CLOSED in SELF mode.
    // The 503 returned by idempotencyGate below is no longer a warning — it
    // aborts the request so an unknown prior outcome is never re-processed.
  }
  // Day 9 (Item 4): in self mode the idempotency key is bound to the EIP-3009
  // nonce â€” hash(nonce) â€” so a re-presented signed authorization under ANY
  // request identifier collides with the settled/pending row (replay-safe).
  // The nonce is extracted from the payment header BEFORE the idempotency gate.
  let nonceBoundKeyOverride = null;
  if (SELF_MODE && req.headers['payment-signature']) {
    const parsedNonce = gateway.parsePaymentSignatureHeader(req.headers['payment-signature']);
    if (parsedNonce.ok && parsedNonce.payload && parsedNonce.payload.payload &&
        parsedNonce.payload.payload.authorization && parsedNonce.payload.payload.authorization.nonce) {
      nonceBoundKeyOverride = gateway.nonceIdempotencyKey(parsedNonce.payload.payload.authorization.nonce);
    }
  }
  const idemCtx = {
    payload,
    buyerAddress: walletNow,
    nonce: (payload.deadline ? String(payload.deadline) : '') + ':' + (payload.budget === undefined ? '' : String(payload.budget)),
    // Fee-affecting input: the mock buyer-rep header changes the response fee,
    // so it must be part of the derived-key identity (regression fix â€” without
    // it, a rep-bearing retry would replay a no-rep cached response).
    extra: req.headers['x-mock-buyer-rep'] ? String(req.headers['x-mock-buyer-rep']).trim() : '',
  };
  let idem = { ok: true, key: null, fresh: false, derived: false };
  if (hasPaymentHeader) {
    // Day 9 (Item 4): when a nonce-bound key was derived above, it OVERRIDES
    // the client-supplied/derived key so replay protection is anchored to the
    // EIP-3009 nonce, not to an attacker-supplied header. Pass it via a
    // synthetic header the gate prefers (nonce-bound keys are authoritative in
    // self mode â€” see gateway.nonceIdempotencyKey).
    if (nonceBoundKeyOverride) {
      idem = await idempotency.idempotencyGate({
        ...req,
        headers: { ...req.headers, 'idempotency-key': nonceBoundKeyOverride },
      }, idemCtx);
      idem.derived = true; // nonce-bound keys are server-derived, not client-supplied
    } else {
      idem = await idempotency.idempotencyGate(req, idemCtx);
    }
  } else {
    log.push('IDEMPOTENCY: no payment header -> challenge probe, idempotency-neutral');
  }
  if (!idem.ok) {
    if (idem.status === 409) {
      log.push('IDEMPOTENCY: key ' + idem.key + ' in flight -> 409');
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'conflict', idempotencyKey: idem.key, reason: idem.reason || 'request with this idempotency key is still in flight' }));
      return;
    }
    if (idem.status === 422) {
      log.push('IDEMPOTENCY: key ' + idem.key + ' payload hash mismatch -> 422');
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unprocessable', idempotencyKey: idem.key, reason: idem.reason || 'idempotency key reused with a different payload' }));
      return;
    }
    if (idem.status === 503) {
      // Store unavailable -> FAIL CLOSED (final reliability gate): an unknown
      // prior outcome must never be silently re-processed, and new financial
      // operations must not proceed when the store that prevents duplicates
      // is down. Mock mode (no financial effect) stays open for development.
      if (SELF_MODE) {
        log.push('IDEMPOTENCY store unavailable (fail-closed): ' + (idem.reason || ''));
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporarily unavailable', retryable: true, reason: (idem.reason || 'idempotency store unavailable') + '; no payment was initiated' }));
        return;
      }
      log.push('IDEMPOTENCY store unavailable (mock lane, fail-open): ' + (idem.reason || ''));
    } else if (idem.cached) {
      log.push('IDEMPOTENCY: key ' + idem.key + ' replayed -> cached response ' + idem.cached.status);
      res.writeHead(idem.cached.status || 200, { 'Content-Type': 'application/json' });
      res.end(idem.cached.body || JSON.stringify({ status: 'ok', replay: true, idempotencyKey: idem.key }));
      return;
    } else {
      log.push('IDEMPOTENCY: unexpected gate result for ' + idem.key + ' -> ' + JSON.stringify(idem));
    }
  }
  const idemKeyNow = idem.key || null;
  if (idem.fresh) log.push('IDEMPOTENCY: fresh key ' + idemKeyNow + (idem.derived ? ' (derived deterministically)' : ' (client-supplied)'));

  // SECURITY GATE: sanitize capability at the boundary. Reject if empty OR if
  // an injection attempt is detected (Day 7: fail closed, nothing stripped and
  // processed â€” see sanitizeCapability).
  const sanitized = sanitizeCapability(payload.capability);
  if (sanitized.injection) {
    log.push('SECURITY GATE: ' + sanitized.reason + ' -> 422');
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'security gate: ' + sanitized.reason }));
    return;
  }
  if (!sanitized.ok) {
    log.push('SECURITY GATE: capability field empty after sanitization -> 422');
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'capability field empty after sanitization' }));
    return;
  }

  // ---- DAY 11 (Item 4): GOVERNED COMMITMENT FLOW ---------------------------
  // The commitment (Trade Manifest) is issued BEFORE any payment challenge.
  // It binds the TERMS (capability, price, acceptance criteria, deadline,
  // cancel condition) and carries NO rail, NO credential, NO settlement
  // reference â€” the settlement method S that realises the neutral requirement
  // R is resolved at execution time (IETF draft, R/S separation; x402 is no
  // longer mandatory). All Day 8 controls above (kill switch -> rate limit ->
  // idempotency -> sanitization) remain in force and in the same order.
  //
  // buyer: from the verified payment signature when present, else the legacy
  // mock header, else a per-request placeholder. seller: the router's fee
  // address (the commitment is issued for the DEMAND â€” the seller wallet is
  // resolved at settlement time from the rail).
  // Escrow mode: the buyer identity comes from the AUTHENTICATED access
  // authorization (the signer of the EIP-712 access auth with role=buyer), so
  // the signed agreement's buyerAgentId is the verified caller â€” never a
  // payment-derived placeholder (escrow mode has no payment signature).
  let commitmentBuyer = null;
  if (ESCROW_BACKED) {
    const accessAuthHdr = req.headers['x-saax-access-auth'] || '';
    if (accessAuthHdr) {
      try {
        const art = JSON.parse(Buffer.from(accessAuthHdr, 'base64').toString('utf8'));
        const a = escrowAccess.verifyAccessAuthorization(art);
        // Only a BUYER-role auth defines the agreement buyer. A seller or
        // evaluator signing (their own actions) must never rebind the
        // agreement buyer to their address â€” the buyer is the party who
        // funded the escrow (the configured buyer role owner).
        if (a.ok && a.signer && String(art.payload && art.payload.role) === 'buyer') commitmentBuyer = String(a.signer).toLowerCase();
      } catch (e) { /* unverifiable auth resolves later in handleEscrowAccess */ }
    }
  }
  if (!commitmentBuyer) {
    commitmentBuyer = walletFromReq(req);
  }
  if (!commitmentBuyer && ESCROW_BACKED) {
    // The agreement buyer is the party who FUNDED the escrow â€” the configured
    // buyer role owner (SAAX_TEST_BUYER_ADDRESS). Never a payment placeholder:
    // escrow mode has no payment signature, and seller/evaluator-initiated
    // actions must still bind the agreement to the real escrow buyer.
    commitmentBuyer = String(process.env.SAAX_TEST_BUYER_ADDRESS || '').toLowerCase() || '0x0000000000000000000000000000000000000001';
  }
  commitmentBuyer = commitmentBuyer || (process.env.SAAX_X402_MOCK_FROM || '0x0000000000000000000000000000000000000001').toLowerCase();
  // Day 14 (Item 1): provided commitment ID from the payment payload
  // (extensions.saax_commitment_id). Read AFTER the payment branch assigns
  // paymentPayload = parsed.payload; the demand-phase payload is NOT the
  // payment payload and must never be dereferenced for this field here.
  let saaxCommitmentOverride = null;
  let commitmentFlowCtx = null;
  try {
    commitmentFlowCtx = await gateway.commitmentFlow.issueFromPayload({
      buyer: commitmentBuyer,
      // F-4 reconcile-before-respond: the deterministic commitment ID MUST
      // derive from THIS request's idempotency key (the same identity the
      // gate used), so identical retries re-derive the SAME commitment row
      // and DISTINCT payments get DISTINCT commitments. Without this, every
      // request maps to one constant ID (hash of the empty scope) — the
      // second legitimate payment for a buyer is rejected as a consumed
      // requirement replay, or worse reconciles to the wrong row.
      idempotencyKey: idemKeyNow,
      // Escrow mode: the agreement seller is the ESCROW-FLOW SUPPLIER (the
      // party who receives the escrowed funds, SAAX_SELLER_ADDRESS). The
      // operative payee (signer/hot wallet) is the direct-x402 payment
      // destination â€” a DIFFERENT role. Binding the agreement seller to the
      // escrow seller makes the signature-verified agreement match the
      // on-chain escrow party (funding-binding check compares like to like).
      seller: ESCROW_BACKED ? (gateway.getSellerAddress() || gateway.getOperativePayee() || MOCK_PAYTO) : (SELF_MODE ? (gateway.getOperativePayee() || MOCK_PAYTO) : MOCK_PAYTO),
      capability: payload.capability,
      deadline: payload.deadline || '2026-10-05T12:00:00Z',
      amountRaw: String(x402.rawUnits(ROUTING_FEE_USD)),
      currency: 'USDC',
      buyerEmail: verifiedSubscriptionEmail,
    });
    log.push('COMMITMENT: issued manifest ' + commitmentFlowCtx.manifest.commitmentId + ' (manifestHash=' + commitmentFlowCtx.manifest.manifestHash + ', R.eta=' + commitmentFlowCtx.requirement.eta + ')');
    // Reliability remediation (F-4): commitment persistence is STRICT.
    // We never present a payment challenge (and never return 200) for a
    // commitment that was not durably recorded. An ambiguous DB outcome is
    // surfaced as 503 with an explicit retryable error — the deterministic
    // commitment ID + PK upsert guarantee the retry reconciles to the SAME
    // row instead of duplicating (reconcile-before-respond).
    if (commitmentFlowCtx.persist && commitmentFlowCtx.persist.ok !== true) {      // Fail-closed: also release the idempotency key as failed (retryable)
      // so a same-key retry after the store heals is not stuck at 409 forever.
      // No payment challenge was presented, so nothing financial was broadcast.
      if (idemKeyNow) { try { await idempotency.markFailed(idemKeyNow, 503, JSON.stringify({ error: 'commitment persistence failed', retryable: true })); } catch (_) {} }

      const perr = commitmentFlowCtx.persist;
      log.push('COMMITMENT PERSIST FAILED (fail-closed): ' + (perr.error || 'unknown'));
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'commitment persistence failed', retryable: perr.retryable !== false, reason: String(perr.error || '').slice(0, 300) }));
      return;
    }
    log.push('COMMITMENT: durable row confirmed for ' + commitmentFlowCtx.manifest.commitmentId);
  } catch (e) {
    // A commitment that cannot be issued fails CLOSED (500) â€” no payment
    // challenge is ever presented without a governing commitment.
    log.push('COMMITMENT FAILED: ' + (e.message || e));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'commitment issuance failed', reason: String(e.message || e).slice(0, 300) }));
    return;
  }

  // Payment signature present? (Day 5: PAYMENT-SIGNATURE base64 header, or the
  // legacy x-x402-mock: mock header). Both run through the verification path.

  // ---- AUTHENTICATED ACTION-SCOPED ESCROW ACCESS (explicit mode routing) ----
  // In escrow-backed mode the settlement path is selected EXPLICITLY by the
  // request shape, never inferred from a payment signature:
  //   - x-saax-access-auth present -> prefunded escrow access path
  //   - payment-signature present  -> REJECTED (escrow mode does not accept a
  //     direct-payment authorization; no additional direct charge is required
  //     or accepted on top of the funded escrow)
  //   - neither -> the request proceeds to the normal challenge flow (a
  //     pre-funded access request without authorization is rejected).
  if (ESCROW_BACKED) {
    const accessAuthHdr = req.headers['x-saax-access-auth'] || '';
    if (accessAuthHdr) {
      // Explicit prefunded-escrow access path â€” the contract sequence runs
      // here, bypassing the direct-payment gates entirely (Test 1: no
      // payment-signature required; a payment-signature alongside is
      // rejected above).
      const ctx = { manifestCid: '0x' + String(commitmentFlowCtx.manifest.manifestHash || '').replace('sha256:', '').slice(0, 64), saaxCommitmentOverride, agreement: { buyer: String((commitmentFlowCtx.manifest.buyerAgentId) || '').toLowerCase(), seller: String((commitmentFlowCtx.manifest.sellerAgentId) || '').toLowerCase(), amount: String((commitmentFlowCtx.manifest.price && commitmentFlowCtx.manifest.price.amount) || ''), currency: String((commitmentFlowCtx.manifest.price && commitmentFlowCtx.manifest.price.currency) || 'USDC') }, reqBody: body };
      await handleEscrowAccess(req, res, log, ctx);
      return;
    }
    const paySigHdr = req.headers['payment-signature'] || '';
    if (paySigHdr && !accessAuthHdr) {
      // Escrow mode: a direct-payment authorization is NOT accepted. Reject
      // without processing the payment (no direct charge path exists here).
      const reason = 'escrow-backed mode: direct-payment authorization (payment-signature) is not accepted; present x-saax-access-auth instead';
      log.push('ESCROW MODE REJECT: ' + reason);
      diagBranch('escrow-mode-direct-payment-rejected', req);
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: reason }));
      return;
    }
  }

  const sigHeader = req.headers['payment-signature'] || '';
  const legacyMock = req.headers['x-x402-mock'] || '';
  let paymentVerified = false;
  let paymentMode = null;
  // Option A: true when the gateway verified the payment in-path (self OR
  // circle). Evaluated at USE time (function), because paymentVerified is
  // assigned later in the verification branches. The settlement/replay/
  // reputation lifecycle runs for either verifier; 'mpp' and 'mock' are
  // separate rails with their own paths.
  const verifiedByGateway = () => paymentVerified && (paymentMode === 'self' || paymentMode === 'circle');
  let paymentPayload = null;
  let paymentRejectReason = null;

  // ---- DAY 12 (Item 3): MPP credential detection ----------------------------
  // The dual-challenge gateway accepts EITHER credential format:
  //   x402:  PAYMENT-SIGNATURE header (existing branch below)
  //   MPP:   Authorization: Payment <base64url JSON credential>
  // MPP credentials are routed to the mpp rail's validate() against the
  // neutral requirement R (the same R every rail realises). The x402 branch
  // remains fully intact for PAYMENT-SIGNATURE (and the x-x402-mock compat).
  const authzHeader = req.headers['authorization'] || '';
  let mppCredential = null;
  if (!paymentVerified && railsMod.resolve('mpp') && authzHeader && /^payment\s/i.test(authzHeader)) {
    const railsMpp = railsMod.resolve('mpp');
    mppCredential = railsMpp.parseCredentialHeader(authzHeader);
    if (!mppCredential) {
      paymentRejectReason = 'Malformed MPP credential (Authorization: Payment)';
      log.push('MPP credential malformed: ' + paymentRejectReason);
    } else {
      // Validate against the requirement R (which carries amt/cur/payee). In
      // the commitment flow, R is the neutral requirement; otherwise we build
      // a synthetic one from the route fee defaults (same shape as x402).
      const R = (commitmentFlowCtx && commitmentFlowCtx.requirement) || {
        amt: gateway.rawUnits(ROUTING_FEE_USD),
        cur: 'USDC',
        payee: gateway.getOperativePayee() || MOCK_PAYTO,
        scheme: 'Payment',
        eta: 'eta_' + Date.now(),
        t_exp: new Date(Date.now() + 120000).toISOString(),
      };
      try {
        const ok = await railsMpp.validate(mppCredential, R);
        if (ok === true) {
          paymentVerified = true;
          paymentMode = 'mpp';
          paymentPayload = mppCredential;
          log.push('MPP credential verified through mpp rail (challenge=' + (mppCredential.challenge && mppCredential.challenge.id || '?') + ')');
        } else {
          paymentRejectReason = 'MPP credential validation failed';
          log.push('MPP credential rejected: ' + paymentRejectReason);
        }
      } catch (verr) {
        paymentRejectReason = 'MPP credential validation error: ' + String(verr.message || verr).slice(0, 160);
        log.push('MPP credential validation error: ' + paymentRejectReason);
      }
    }
  }

  if (!paymentVerified && legacyMock === 'mock') {
    paymentVerified = true;
    paymentMode = 'mock';
    log.push('legacy x-x402-mock header accepted (compat; verified=true in mock mode)');
  } else if (!paymentVerified && gateway.getMode() === 'self' && sigHeader) {
    // ---- DAY 9 SELF-HOSTED GATEWAY BRANCH (SAAX_X402_MODE=self) --------------
    // Full EIP-712/EIP-3009 verification via viem against Base Sepolia. The
    // seller wallet must be provisioned (SAAX_SELLER_PRIVATE_KEY/ADDRESS); the
    // challenge is built from the gateway (network eip155:84532, USDC Base
    // Sepolia, payTo seller wallet, scheme exact, facilitator self).
    const parsed = gateway.parsePaymentSignatureHeader(sigHeader);
    if (!parsed.ok) {
      paymentRejectReason = parsed.reason;
      log.push('payment signature malformed (self): ' + parsed.reason);
    } else {
      const reqForVerify = {
        scheme: 'exact',
        usd: ROUTING_FEE_USD,
        amount: gateway.rawUnits(ROUTING_FEE_USD),
        asset: gateway.USDC_BASE_SEPOLIA,
        network: gateway.NETWORK_CAIP2_BASE_SEPOLIA,
        networkName: gateway.NETWORK_CAIP2_BASE_SEPOLIA === 'eip155:8453' ? 'base' : 'base-sepolia',
        payTo: gateway.getOperativePayee() || MOCK_PAYTO,
        maxTimeoutSeconds: 60,
      };
      // Day 15 (Item 4): replace SAAX's own self-verification with Circle's
      // external verifier. Every payment payload is sent to Circle's /verify
      // (keyless trial, seller-proof auth). Circle's verdict is returned â€”
      // NOT SAAX's own. FAIL-CLOSED: if Circle is unreachable or returns an
      // error, the payment fails. There is no fallback to the gateway's
      // self-verification on the live path.
      const circleRequirements = {
        scheme: reqForVerify.scheme,
        network: reqForVerify.network,
        amount: reqForVerify.amount,
        asset: reqForVerify.asset,
        payTo: reqForVerify.payTo,
        maxTimeoutSeconds: reqForVerify.maxTimeoutSeconds,
        extra: gateway.acceptedExtra(),
      };
      // Option A (Day 15 closeout): SAAX's structural checks run BEFORE the
      // Circle call. verifyAuthorization re-exposed from the gateway performs
      // EIP-712 signer recovery (recovered == authorization.from), validity
      // window (validAfter past, validBefore future), amount/scheme/network/
      // asset match, and the payee binding. On failure -> 402 with the reason,
      // Circle is NOT called. On success -> Circle /verify confirms externally.
      const structural = await gateway.verifyAuthorization(parsed.payload, circleRequirements);
      if (!structural.verified) {
        paymentRejectReason = structural.reason || 'structural_verification_failed';
        log.push('PAYMENT-SIGNATURE rejected by SAAX structural checks (before Circle): ' + paymentRejectReason);
      } else {
      try {
        const v = await gateway.circleVerifyPayment(parsed.payload, circleRequirements);
        if (v.verified) {
          paymentVerified = true;
          paymentMode = 'circle';
          paymentPayload = parsed.payload;
          log.push('PAYMENT-SIGNATURE verified through Circle /verify (payer=' + (v.payer || '?') + ')');
        } else {
          paymentRejectReason = v.invalidReason || v.reason || 'circle_invalid';
          log.push('PAYMENT-SIGNATURE rejected by Circle /verify: ' + paymentRejectReason);
        }
      } catch (e) {
        // Fail-closed: Circle unreachable/erroring rejects the payment.
        paymentRejectReason = String(e.message || e).slice(0, 200);
        log.push('PAYMENT-SIGNATURE verification failed (Circle, fail-closed): ' + paymentRejectReason);
      }
      }
    }
  } else if (!paymentVerified && sigHeader) {
    const parsed = x402.parsePaymentSignatureHeader(sigHeader);
    if (!parsed.ok) {
      paymentRejectReason = parsed.reason;
      log.push('payment signature malformed: ' + parsed.reason);
    } else {
      // Build a synthetic requirement (fee + route defaults) to verify against.
      const reqForVerify = {
        scheme: 'exact',
        amount: x402.rawUnits(ROUTING_FEE_USD),
        asset: x402.USDC_ADDRESS[MOCK_NETWORK],
        networkName: MOCK_NETWORK,
        network: x402.NETWORK_CAIP2[MOCK_NETWORK],
        payTo: MOCK_PAYTO,
        maxTimeoutSeconds: 60,
      };
      const v = x402.verifyPaymentPayload(parsed.payload, reqForVerify);
      if (v.verified) {
        paymentVerified = true;
        paymentMode = v.mode;
        paymentPayload = parsed.payload;
        log.push('PAYMENT-SIGNATURE verified through ' + v.mode + ' branch');
      } else {
        paymentRejectReason = v.reason;
        log.push('PAYMENT-SIGNATURE rejected: ' + v.reason);
      }
    }
  }

  // Day 14 (Item 1): read the provided commitment ID from the verified
  // payment payload (extensions.saax_commitment_id). Verified payload only â€”
  // an unverified or malformed payload never reaches this point.
  if (paymentPayload && paymentPayload.extensions && paymentPayload.extensions.saax_commitment_id) {
    saaxCommitmentOverride = String(paymentPayload.extensions.saax_commitment_id);
    log.push('COMMITMENT: extensions.saax_commitment_id present -> ' + saaxCommitmentOverride);
  }

  if (!paymentVerified) {
    // A payment header was present but verification failed: mark the idempotency
    // key FAILED (terminal/retryable) so it never lingers as a poison 'pending'
    // row. A failed prior attempt with the same key is retryable (gate logic).
    if (idemKeyNow && idem.fresh) {
      const challengeBody = buildChallenge();
      challengeBody.accepts[0].maxAmountRequired = ROUTING_FEE_USD;
      if (paymentRejectReason) challengeBody.rejectReason = paymentRejectReason;
      await idempotency.markFailed(idemKeyNow, 402, JSON.stringify(challengeBody));
      log.push('IDEMPOTENCY: key ' + idemKeyNow + ' marked failed (payment rejected 402)');
    }
    log.push('no valid payment signature -> 402 challenge');

    const selfModeMatch = SELF_MODE === (gateway.getMode() === 'self');
    log.push('[diag] pid=' + process.pid + ' instance=' + INSTANCE_TOKEN +
      ' SELF_MODE=' + (SELF_MODE ? 'true' : 'false') +
      ' getMode=' + gateway.getMode() +
      ' selfModeMatch=' + (selfModeMatch ? 'true' : 'false') +
      ' sigHeader=' + (sigHeader ? 'present' : 'absent') +
      ' method=' + req.method + ' path=' + (req.url || ''));
    console.error('[diag] pid=' + process.pid + ' instance=' + INSTANCE_TOKEN +
      ' SELF_MODE=' + (SELF_MODE ? 'true' : 'false') +
      ' getMode=' + gateway.getMode() +
      ' selfModeMatch=' + (selfModeMatch ? 'true' : 'false') +
      ' sigHeader=' + (sigHeader ? 'present' : 'absent') +
      ' method=' + req.method + ' path=' + (req.url || ''));

    let challenge, headers = { 'Content-Type': 'application/json' };
    if (SELF_MODE) {
      // Day 9 (Item 2): self-hosted challenge â€” PAYMENT-REQUIRED header carries
      // base64 JSON: { network: eip155:84532, asset: USDC Base Sepolia,
      //   payTo: seller wallet, amount: routing fee raw units, facilitator: 'self',
      //   scheme: 'exact' }.
      challenge = selfChallenge();
      // (helper selfChallenge()) - same shape; see comment above the helper.
      headers[gateway.HEADERS.PAYMENT_REQUIRED] = gateway.buildPaymentRequiredHeader({
        amountRaw: gateway.rawUnits(ROUTING_FEE_USD),
        network: gateway.NETWORK_CAIP2_BASE_SEPOLIA,
        asset: gateway.USDC_BASE_SEPOLIA,
        payTo: gateway.getOperativePayee() || MOCK_PAYTO,
        facilitator: 'self',
        scheme: 'exact',
        resource: 'urn:saax-protocol:route:v1',
      });
    } else {
      challenge = buildChallenge();
      challenge.accepts[0].maxAmountRequired = ROUTING_FEE_USD;
      if (paymentRejectReason) challenge.rejectReason = paymentRejectReason;
    }
    if (paymentRejectReason && !challenge.rejectReason) challenge.rejectReason = paymentRejectReason;

    // ---- DAY 11 (Item 4): bind the 402 to the governing commitment ---------
    // The payment challenge ALWAYS references the issued commitment and its
    // neutral requirement R. This is the R/S separation on the wire: the
    // challenge declares the requirement; the settlement method (S) that
    // realises it is chosen by the buyer when they present a credential.
    if (commitmentFlowCtx) {
      challenge.commitment = {
        commitmentId: commitmentFlowCtx.manifest.commitmentId,
        manifestHash: commitmentFlowCtx.manifest.manifestHash,
        // EAS anchor (when issued): the schema UID + deterministic attestation
        // UID binding the manifest digest on Base. Independent verifiers can
        // resolve the anchor without trusting SAAX's DB.
        ...(commitmentFlowCtx.anchor ? {
          anchor: {
            schemaUid: commitmentFlowCtx.anchor.schemaUid,
            uid: commitmentFlowCtx.anchor.uid,
            chainId: commitmentFlowCtx.anchor.chainId,
            mode: commitmentFlowCtx.anchor.mode,
          },
        } : {}),
      };
      challenge.requirement = {
        amt: commitmentFlowCtx.requirement.amt,
        cur: commitmentFlowCtx.requirement.cur,
        payee: commitmentFlowCtx.requirement.payee,
        eta: commitmentFlowCtx.requirement.eta,
        scheme: commitmentFlowCtx.requirement.scheme,
        t_exp: commitmentFlowCtx.requirement.t_exp,
      };
      // MPP is NOT advertised in the accepts array. The MPP rail is registered
      // but not production-ready (no MPP_SECRET_KEY configured; the entry it
      // would push - {scheme:'mpp'} - is not a valid payment scheme and carries
      // no network/asset/amount). A single valid x402 exact entry is sufficient
      // for a standard client to construct a payment. (Commander conclusion,
      // Item 0: never point MPP at Base Sepolia in production; absent
      // production-readiness, remove it from the live accepts array.)
    }
    // ---- DAY 12 (Item 3): MPP challenge emission ----------------------------
    // When the MPP rail is registered, emit the MPP challenge in the
    // WWW-Authenticate: Payment header alongside the x402 PAYMENT-REQUIRED
    // header. Per the mppx compatibility pattern: "the server emits both MPP
    // and x402 Challenges, accepts either Credential format, and returns the
    // matching Receipt header." The buyer chooses the rail by the credential
    // format they present on retry.
    if (railsMod.resolve('mpp')) {
      const R = (commitmentFlowCtx && commitmentFlowCtx.requirement) || {
        amt: gateway.rawUnits(ROUTING_FEE_USD),
        cur: 'USDC',
        payee: gateway.getOperativePayee() || MOCK_PAYTO,
        scheme: 'Payment',
        eta: 'eta_' + Date.now(),
        t_exp: new Date(Date.now() + 120000).toISOString(),
      };
      try {
        const railsMpp = railsMod.resolve('mpp');
        const mppChallenge = await railsMpp.realise(R);
        const wwwAuth = railsMpp.emitChallengeHeader(mppChallenge);
        // MPP advertises the challenge in WWW-Authenticate; x402 keeps
        // PAYMENT-REQUIRED. Both headers present = dual challenge.
        headers['WWW-Authenticate'] = wwwAuth;
        log.push('MPP challenge emitted (WWW-Authenticate: Payment, challenge=' + (mppChallenge.id || '?') + ')');
      } catch (mpperr) {
        // MPP challenge generation failure must NOT break the x402 challenge:
        // degrade to x402-only for this request and log.
        log.push('MPP challenge emission failed (x402-only for this request): ' + String(mpperr.message || mpperr).slice(0, 160));
      }
    }
    diagBranch((paymentRejectReason ? (SELF_MODE ? 'self-rejection' : 'generic-fallback-rejection') : 'self-discovery'), req);
    res.writeHead(402, headers);
    res.end(JSON.stringify(challenge));
    return;
  }
  // Payment verified: mark the key 'verified' (brief state machine) â€” the final
  // settle happens at response time (markSettled below).
  if (idemKeyNow && idem.fresh) {
    await idempotency.markVerified(idemKeyNow);
    log.push('IDEMPOTENCY: key ' + idemKeyNow + ' verified (payment accepted)');
  }

  // ---- DAY 9 (Item 4): nonce replay guard -----------------------------------
  // A verified EIP-3009 authorization whose nonce has ALREADY been settled
  // must be rejected BEFORE routing (no duplicate charge, no duplicate work).
  // The nonce-bound idempotency key above makes the HTTP-layer replay safe;
  // this in-process guard is defense in depth against a nonce reused across
  // DIFFERENT idempotency keys (the attacker's fresh-key trick).
  if (SELF_MODE && verifiedByGateway() && paymentPayload &&
      paymentPayload.payload && paymentPayload.payload.authorization) {
    const authNonce = paymentPayload.payload.authorization.nonce;
    const prior = gateway.getNonce(authNonce);
    if (prior && prior.status === 'settled') {
      log.push('DAY 9 NONCE GUARD: nonce ' + authNonce + ' already settled -> 402 rejected (no duplicate charge)');
      paymentRejectReason = 'nonce already settled (replay rejected)';
      const nonceGuardChallenge = { error: '402 Payment Required', rejectReason: paymentRejectReason };
      if (commitmentFlowCtx) {
        nonceGuardChallenge.commitment = { commitmentId: commitmentFlowCtx.manifest.commitmentId, manifestHash: commitmentFlowCtx.manifest.manifestHash };
        nonceGuardChallenge.requirement = {
          amt: commitmentFlowCtx.requirement.amt, cur: commitmentFlowCtx.requirement.cur,
          payee: commitmentFlowCtx.requirement.payee, eta: commitmentFlowCtx.requirement.eta,
          scheme: commitmentFlowCtx.requirement.scheme, t_exp: commitmentFlowCtx.requirement.t_exp,
        };
      }
    diagBranch('nonce-guard-replay', req);
      res.writeHead(402, { 'Content-Type': 'application/json', [gateway.HEADERS.PAYMENT_REQUIRED]: gateway.buildPaymentRequiredHeader({
        amountRaw: gateway.rawUnits(ROUTING_FEE_USD),
        network: gateway.NETWORK_CAIP2_BASE_SEPOLIA,
        asset: gateway.USDC_BASE_SEPOLIA,
        payTo: gateway.getOperativePayee() || MOCK_PAYTO,
        facilitator: 'self',
        scheme: 'exact',
      }) });
      res.end(JSON.stringify(nonceGuardChallenge));
      return;
    }
    if (prior && prior.status === 'pending') {
      log.push('DAY 9 NONCE GUARD: nonce ' + authNonce + ' in flight -> 409');
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'conflict', reason: 'authorization nonce is still being processed' }));
      return;
    }
    gateway.setNonce(authNonce, 'pending');
  }

  // ---- GATE D.1: INTERNAL-BETA FINANCIAL LIMITS ----------------------------
  // Placement is deliberate: AFTER the idempotency gate (an identical retry
  // replays the cached response and never reaches here), AFTER payment
  // verification (the payer identity is cryptographically established, not
  // caller-asserted), and BEFORE any settlement or broadcast. A rejected quota
  // therefore authorizes nothing and moves no funds.
  //
  // The wallet is the VERIFIED payer recovered from the payment authorization —
  // never a header or body field. When enforcement is off (the default) this
  // block is a no-op and existing behavior is unchanged.
  let pilotReservation = null;
  if (pilotLimits.isEnforcing()) {
    const authz = (paymentPayload && paymentPayload.payload && paymentPayload.payload.authorization) || {};
    // PILOT PAYER RESOLUTION: the payer is the SIGNATURE-derived address
    // whenever a signature exists. Only the mock lane (no signature, no
    // financial effect) falls back to its own mock buyer identity — a
    // caller-supplied string is never treated as authenticated where money
    // can move, and SELF mode with no signature fails closed.
    const verifiedPayer = authz.from
      ? String(authz.from).toLowerCase()
      : (SELF_MODE ? null : (walletFromReq(req) || null));
    const pilotAsset = SELF_MODE ? gateway.USDC_BASE_SEPOLIA : x402.USDC_ADDRESS[MOCK_NETWORK];
    const pilotChainId = SELF_MODE
      ? Number(process.env.SAAX_CHAIN_ID || 84532)
      : (MOCK_NETWORK === 'base' ? 8453 : 137);
    const pilotRecipient = authz.to ? String(authz.to) : (gateway.getOperativePayee() || MOCK_PAYTO);
    const pilotAmount = authz.value ? String(authz.value) : String(x402.rawUnits(ROUTING_FEE_USD));

    const quota = await pilotLimits.evaluate({
      idempotencyKey: idemKeyNow,
      wallet: verifiedPayer,
      chainId: pilotChainId,
      asset: pilotAsset,
      amountUnits: pilotAmount,
      recipient: pilotRecipient,
      commitmentId: commitmentFlowCtx ? commitmentFlowCtx.manifest.commitmentId : null,
    });

    if (!quota.ok) {
      // FAIL CLOSED. No payment challenge is presented, nothing is broadcast,
      // and the idempotency key is released as failed so a legitimate retry
      // after the operator resolves the condition is not stuck at 409.
      // ---- Gate D.2: HTTP error semantics ---------------------------------
      // Distinguish the failure class so callers can act correctly:
      //   403 Forbidden — the wallet is not authorized for the pilot
      //                   (not allowlisted / revoked / explicitly prohibited).
      //   429 Too Many Requests — a configured amount or count quota is
      //                   exceeded; retryAfter is set only when the quota
      //                   window makes a retry provably safe (window expiry),
      //                   otherwise the header is omitted rather than guessed.
      //   503 Service Unavailable — the limit store is unreachable or the
      //                   reservation outcome is unknown; fail closed, retryable.
      //   422 Unprocessable — malformed/unsupported request parameters that
      //                   fail local validation (never a server condition).
      // Every rejection is issued BEFORE any payment authorization or
      // broadcast, and the response body never includes wallet, amount,
      // recipient or settlement data.
      const quotaReason = String(quota.reason || 'quota_rejected');
      const QUOTA_CLASS = {
        // 422 — locally-validated malformed input
        invalid_chain_id: 422, invalid_asset_address: 422, unsupported_asset: 422,
        invalid_wallet_address: 422, invalid_recipient: 422, missing_idempotency_key: 422,
        malformed_amount: 422, non_integer_amount: 422, non_positive_amount: 422,
        amount_overflow: 422, empty_amount: 422, invalid_decimals: 422,
        too_many_decimals: 422, invalid_policy_configuration: 422,
        // 403 — authorization
        wallet_not_allowlisted: 403, wallet_revoked: 403,
        // 429 — quota
        single_transaction_cap: 429, wallet_amount_cap: 429, wallet_count_cap: 429,
        global_amount_cap: 429, global_count_cap: 429,
        // 503 — fail closed (unknown/absent store)
        limit_store_unavailable: 503, limit_store_invalid_response: 503,
        reservation_payload_mismatch: 409, idempotency_key_conflict: 409,
      };
      const status = QUOTA_CLASS[quotaReason] || 403;
      const retryable = status === 503;
      if (idemKeyNow && idem.fresh) {
        try { await idempotency.markFailed(idemKeyNow, status, JSON.stringify({ error: 'pilot_limit_rejected', reason: quota.reason })); } catch (_) {}
      }
      log.push('PILOT LIMITS: rejected (' + quotaReason + ') -> ' + status + ', no payment authorized');
      const body = {
        error: 'pilot_limit_rejected',
        reason: quotaReason,
        retryable,
      };
      const respHeaders = { 'Content-Type': 'application/json' };
      // Retry-After is only set when provably safe: the 24h reservation window
      // rolls; the wallet/global windows expire at now()+windowHours. We do NOT
      // claim a precise retry point for other classes (403/422/503) because it
      // depends on operator action, not time.
      if (status === 429) {
        // Gate D.3 Phase D: a fixed windowHours*3600 Retry-After is wrong for
        // a rolling window. Estimate the earliest safe retry from the OLDEST
        // exposure-consuming reservation in the binding scope (created_at +
        // window). Unresolved reservations keep consuming exposure, so the
        // estimate is a conservative LOWER BOUND; when it cannot be established
        // safely the header is OMITTED (never guess a retry point).
        const ra = await pilotLimits.computeRetryAfter({
          reason: quotaReason,
          wallet: verifiedPayer,
          chainId: pilotChainId,
        });
        if (ra && ra.estimateSeconds) {
          respHeaders['Retry-After'] = String(ra.estimateSeconds);
        }
      }
      res.writeHead(status, respHeaders);
      res.end(JSON.stringify({
        ...body,
      }));
      return;
    }
    pilotReservation = quota.reservationId || null;
    log.push('PILOT LIMITS: ' + quota.reason + ' reservation=' + pilotReservation);
  }

  // Valid payment: run the ranking engine (demand text already sanitized).
  const result = ranker(payload.capability, { topN: 5 });


  // ---- DAY 8, ITEM 4: buyer reputation from the x402 signature (live) -------
  // Mock mode keeps the x-mock-buyer-rep header as a stand-in for testing.
  // LIVE mode IGNORES the header entirely: reputation derives from the verified
  // signer address (authorization.from) via IdentityRegistry reverse lookup +
  // ReputationRegistry (Path (a), operator-confirmed).
  const mockBuyerRep = req.headers['x-mock-buyer-rep'];
  const liveModeNow = String(verifyModeNow).toLowerCase() === 'live';
  const selfModeNow = SELF_MODE && verifiedByGateway();
  let buyerRep = { reputation: null, note: 'no buyer address; no discount' };
  let repLog = null;
  if (liveModeNow || selfModeNow) {
    // Sanitization-gated: the payload was already structurally verified above
    // (paymentVerified true). Recover signer from the verified payload.
    const auth = (paymentPayload && paymentPayload.payload && paymentPayload.payload.authorization) || {};
    const buyer = String(auth.from || '').toLowerCase();
    if (buyer) {
      const resolved = await identity.resolveReputationFromSignature(paymentPayload, {
        recoveredAddress: buyer, // x402 verification already bound recovered == from
        mode: selfModeNow ? 'self' : verifyModeNow,
      });
      if (!resolved.ok) {
        // 401: recovered signer != authorization.from (signature invalid/tampered)
        log.push('REPUTATION: signer mismatch -> 401');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', reason: resolved.reason }));
        return;
      }
      buyerRep = resolved.buyerRep;
      repLog = resolved.log;
    }
  } else {
    if (mockBuyerRep && !isNaN(Number(mockBuyerRep))) {
      const m = identity.reputationFromMockHeader(mockBuyerRep);
      if (m) {
        buyerRep = m.buyerRep;
        repLog = m.log;
      }
    } else if (req.headers['x-buyer-address']) {
      buyerRep = getBuyerReputation(req.headers['x-buyer-address']);
    }
  }
  const fee = computeFee(buyerRep, log);
  // ---- SPRINT 2, ITEM 1: outcome logging â€” every ranked result inserts a
  // row into saax_router.ranking_outcomes (weights_used snapshot + shrinkage
  // flag + per-component scores for tuning analysis). request_id is the
  // idempotency key when present, else a deterministic per-run id. Rows are
  // never exposed in API responses (trade-secret posture).
  if (result && result.status === 'ok') {
    const outcomeRow = {
      request_id: (idemKeyNow && idemKeyNow.slice(0, 120)) || ('req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)),
      capability: payload.capability,
      supplier_ids: result.candidates.map(c => String(c.agent_id)),
      supplier_scores: result.candidates.map(c => c.score),
      selected_supplier: result.candidates[0] ? String(result.candidates[0].agent_id) : null,
      weights_used: result.weights_used || {},
      shrinkage_applied: !!result.shrinkage_applied,
      component_scores: {
        rows: result.candidates.map(c => ({
          agent_id: String(c.agent_id),
          reputation: c.components ? c.components.reputation : null,
          freshness: c.components ? c.components.freshness : null,
          price: c.components ? c.components.price : null,
          category: c.category || null,
          feedback_count: c.feedback_count || 0,
          shrunken: c.shrinkage ? true : false,
        })),
      },
      routing_fee_usd: fee ? fee.finalFeeUsd || fee.baseFeeUsd : null,
      settlement_rail: null, // resolved at settlement observation time
    };
    await outcomeLog.logOutcome(outcomeRow);
    log.push('OUTCOME LOG: ranking result logged (request_id=' + outcomeRow.request_id + ', suppliers=' + outcomeRow.supplier_ids.length + ', shrinkage=' + outcomeRow.shrinkage_applied + ')');
  }
  if (repLog) log.push('REPUTATION: ' + JSON.stringify(repLog));
  if (liveModeNow && mockBuyerRep && !isNaN(Number(mockBuyerRep))) {
    log.push('REPUTATION: x-mock-buyer-rep header IGNORED in live mode (source=signature only)');
  }

  if (result.status !== 'ok') {
    const respBody = JSON.stringify({
      status: result.status,
      capability: payload.capability,
      budget: payload.budget,
      deadline: payload.deadline,
      fee,
      payment: { mode: paymentMode, verified: paymentVerified },
    ...(escrowProofOut ? { escrow: escrowProofOut } : {}),
      ...(result.status === 'no_match' ? { reason: result.reason } : {}),
    }, null, 2);
    if (idemKeyNow && idem.fresh) {
      await idempotency.markSettled(idemKeyNow, 200, respBody);
      log.push('IDEMPOTENCY: key ' + idemKeyNow + ' marked settled (cached response)');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(respBody);
    return;
  }

  // DAY 5: route every matched supplier -> exclude unsupported -> settle.
  const { routed, excluded, decisionLog } = router.routeMatches(result.candidates, payload.capability, registrations);
  const { settlements } = settle.runPayments(routed, excluded, payload.capability);
  const allDecisions = [...decisionLog, ...log];

  // ---- DAY 9 (Item 2): SELF-HOSTED SETTLEMENT ------------------------------
  // After routing logic succeeds, broadcast the buyer's signed EIP-3009
  // transferWithAuthorization to Base Sepolia. The seller wallet (authorization
  // 'to' holder) pays gas for the broadcast. Wait for 1 confirmation, then
  // return a PAYMENT-RESPONSE header { transactionHash, status: "settled" }.
  // On broadcast failure: mark the nonce failed, return 502 (no partial
  // charge: the funds never move if the broadcast reverts).
  let selfSettlement = null;
  let selfSettlementError = null;
  // ---- DAY 11 (Item 4): consume the requirement nonce on gate commit -------
  // Exactly one R is issued per commitment; the eta nonce is CONSUMED on
  // successful gate commit and never becomes fresh again. A replay of the
  // same nonce (same R) is rejected by consumeNonce -> ok:false.
  let nonceConsumed = null;
  if (commitmentFlowCtx && commitmentFlowCtx.requirement) {
    nonceConsumed = gateway.commitmentFlow.consumeRequirement(commitmentFlowCtx.requirement);
    if (!nonceConsumed.ok) {
      log.push('COMMITMENT: requirement nonce rejected on gate commit (' + nonceConsumed.reason + ') -> 409');
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'conflict', reason: 'requirement nonce already consumed (replay rejected)' }));
      return;
    }
    log.push('COMMITMENT: requirement eta ' + commitmentFlowCtx.requirement.eta + ' consumed (single-use)');
  }

  if (SELF_MODE && verifiedByGateway() && paymentPayload) {
    try {
      const auth = paymentPayload.payload.authorization;
      const sig = paymentPayload.payload.signature;
      // ---- Day 20 Phase 4: escrow-backed settlement (test env, SAAX_ESCROW_BACKED=1) --
      // Replaces the immediate direct transfer: the buyer must have ALREADY funded
      // the custody escrow for this commitment (verified via the escrow record
      // bound to the payment). No direct transfer occurs; the custody holds the
      // funds until the agreed evaluator verdict releases/refunds.
      if (ESCROW_BACKED) {
        // The escrow's on-chain identity is the commitment DIGEST bytes32
        // (0x<manifestHash-hex>), not the application v3-... id. This keeps
        // the verifier's binding (verdict.commitmentId ==
        // digestBytes32(export.commitmentDigest) == on-chain cid) exactly
        // satisfiable: the escrow is keyed by the digest, so the export,
        // the verdict, and the chain all agree on the same identity. An
        // explicit extension (saax_commitment_id) overrides when provided.
        const manifestCid = '0x' + String(commitmentFlowCtx.manifest.manifestHash || '').replace('sha256:', '').slice(0, 64);
        const settleCommitmentId = saaxCommitmentOverride || manifestCid;
        // Day 20 Phase 4: funding proof comes from the ACTUAL custody contract,
        // never from the in-memory escrow ledger or a database flag. The contract
        // read returns the escrow's funding state, digest, buyer, seller,
        // evaluator, token, amount, and deadlines. An on-chain escrow that is not
        // bound to THIS commitment (digest/parties/amount) is rejected.
        let escrowProof;
        try {
          escrowProof = await escrowMod.verifyOnChain(settleCommitmentId, {
            custody: process.env.SAAX_CUSTODY_ADDRESS || '',
            // F3B: explicit custody version dispatch (LOCAL TEST ONLY). The
            // escrow module selects V1/V2/V3 by validated chain/lane identity
            // from SAAX_CUSTODY_VERSION — NEVER from formatVersion. Unset on
            // the hosted lane keeps the legacy V1 artifact path.
            custodyVersion: process.env.SAAX_CUSTODY_VERSION || '',
          });
        } catch (e) {
          paymentRejectReason = 'escrow-backed mode: on-chain verify failed (' + String(e.message || e).slice(0, 120) + ')';
          log.push('ESCROW-BACKED REJECT: ' + paymentRejectReason);
          await idempotency.markFailed(idemKeyNow, 402, JSON.stringify({ error: paymentRejectReason }));
    diagBranch('escrow-rejection', req);
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: paymentRejectReason }));
          return;
        }
        if (!escrowProof.ok) {
          paymentRejectReason = 'escrow-backed mode: ' + (escrowProof.reason || escrowProof.error || 'verify failed');
          log.push('ESCROW-BACKED REJECT: ' + paymentRejectReason);
    diagBranch('escrow-rejection', req);
          await idempotency.markFailed(idemKeyNow, 402, JSON.stringify({ error: paymentRejectReason }));
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: paymentRejectReason }));
          return;
        }
        if (escrowProof.escrow.state === 'released' || escrowProof.escrow.state === 'refunded' || escrowProof.escrow.state === 'timed_out') {
          paymentRejectReason = 'escrow-backed mode: escrow already terminal (' + escrowProof.escrow.state + ') for commitment ' + settleCommitmentId;
    diagBranch('escrow-rejection', req);
          log.push('ESCROW-BACKED REJECT: ' + paymentRejectReason);
          await idempotency.markFailed(idemKeyNow, 402, JSON.stringify({ error: paymentRejectReason }));
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: paymentRejectReason }));
          return;
        }
        if (!escrowProof.funded) {
    diagBranch('escrow-rejection', req);
          paymentRejectReason = 'escrow-backed mode: escrow not funded on-chain (state=' + escrowProof.escrow.state + ') for commitment ' + settleCommitmentId;
          log.push('ESCROW-BACKED REJECT: ' + paymentRejectReason);
          await idempotency.markFailed(idemKeyNow, 402, JSON.stringify({ error: paymentRejectReason }));
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: paymentRejectReason }));
          return;
        }
        selfSettlement = {
          txHash: escrowProof.escrow.fundTx || null,
          status: 'escrow-funded',
          escrowCommitmentId: settleCommitmentId,
          escrowState: escrowProof.escrow.state,
          escrowAmount: escrowProof.escrow.amount,
          escrowAsset: escrowProof.escrow.token,
          escrowCustody: escrowProof.custody,
          escrowDigest: escrowProof.escrow.digest,
          escrowBuyer: escrowProof.escrow.buyer,
          escrowSeller: escrowProof.escrow.seller,
          escrowEvaluator: escrowProof.escrow.evaluator,
          escrowDeadline: escrowProof.escrow.deadline,
        };
        log.push('ESCROW-BACKED SETTLEMENT: commitment=' + settleCommitmentId +
          ' escrow=' + escrowProof.escrow.state + ' amount=' + escrowProof.escrow.amount + ' token=' + escrowProof.escrow.token +
          ' custody=' + escrowProof.custody + ' digest=' + String(escrowProof.escrow.digest).slice(0, 18) + '...');
        const linkageResult = await gateway.commitmentFlow.persistSettlementRef(
          { commitmentId: settleCommitmentId },
          { txHash: escrowProof.escrow.fundTx || '', rail: 'x402-escrow' },
          settleCommitmentId
        );
        log.push('ESCROW-BACKED LINKAGE: persisted settlement_ref ' + (linkageResult && !linkageResult.ok ? '(store error: ' + linkageResult.error + ')' : '(ok)'));
      } else {
      selfSettlement = await gateway.settleAuthorization(auth, sig);
      gateway.setNonce(auth.nonce, 'settled', selfSettlement);
      log.push('DAY 9 SETTLEMENT: broadcast ' + selfSettlement.txHash + ' status=' + selfSettlement.status +
        ' signaturePath=' + (selfSettlement.signaturePath || 'eip2612') +
        (selfSettlement.pathEvidence ? ' evidence=' + (selfSettlement.pathEvidence.selector || '') + (selfSettlement.pathEvidence.found ? ' (eip3009 selector present)' : ' (no eip3009 selector -> eip2612)') : '') +
        (selfSettlement.dryRun ? ' (DRY RUN â€” no real tx broadcast)' : ' block=' + selfSettlement.blockNumber));
      // Day 14 (Item 1): additive post-broadcast linkage write. The on-chain
      // settlement just confirmed; bind its REAL txHash to the commitment row.
      // Keyed on the provided saax ID (extensions.saax_commitment_id) when
      // present, else the issued manifest ID. This is a write AFTER the
      // success path â€” the broadcast, signature verification, facilitator call
      // and settlement amount are untouched. A persistence failure is logged
      // and never alters the response contract.
      const settleCommitmentId = saaxCommitmentOverride || commitmentFlowCtx.manifest.commitmentId;
      const linkageResult = await gateway.commitmentFlow.persistSettlementRef(
        { commitmentId: settleCommitmentId },
        { txHash: selfSettlement.txHash, rail: 'x402' },
        settleCommitmentId
      );
      log.push('SETTLEMENT LINKAGE: persisted settlement_ref txHash=' + selfSettlement.txHash +
        ' rail=x402 commitment=' + settleCommitmentId +
        (linkageResult && !linkageResult.ok ? ' (store error: ' + linkageResult.error + ')' : ' (ok)'));
      // ---- Day 16 (Capability 2): escrow funding on confirmed settlement ----
      // Additive post-settlement side effect: bind the escrow to the SAME
      // canonical digest the EAS anchor certifies (manifest.manifestHash) and
      // the confirmed on-chain txHash. A funding failure is logged and NEVER
      // alters the settlement response contract (the payment already moved;
      // the escrow record is durable history of the protected funds).
      try {
        const escrowRes = escrowMod.fund({
          commitmentId: settleCommitmentId,
          commitmentDigest: commitmentFlowCtx.manifest.manifestHash,
          amount: String(commitmentFlowCtx.manifest.price.amount || 0),
          asset: commitmentFlowCtx.manifest.price.currency || 'USDC',
          txRef: { txHash: selfSettlement.txHash, rail: 'x402' },
        });
        log.push('ESCROW: funded commitment=' + settleCommitmentId +
          ' state=' + (escrowRes && escrowRes.escrow ? escrowRes.escrow.state : escrowRes.error || '?') +
          ' txHash=' + selfSettlement.txHash);
      } catch (e) {
        log.push('ESCROW FUND WARNING (non-fatal): ' + String(e.message || e).slice(0, 200));
      }
      } // end else (immediate settlement path)
    } catch (e) {
      selfSettlementError = String(e.message || e);
      if (paymentPayload.payload.authorization) {
        gateway.setNonce(paymentPayload.payload.authorization.nonce, 'failed');
      }
      log.push('DAY 9 SETTLEMENT FAILED: ' + selfSettlementError);
      // Gate D.1: a broadcast that provably failed is authoritative evidence
      // that the operation cannot settle, so the reserved exposure is released.
      // (A TIMEOUT is not this case — it leaves the reservation consuming
      // budget until reconciliation establishes the real outcome.)
      if (pilotReservation) {
        try { await pilotLimits.release(pilotReservation, 'settlement broadcast failed'); } catch (_) {}
      }
      if (idemKeyNow && idem.fresh) {
        await idempotency.markFailed(idemKeyNow, 502, JSON.stringify({ error: 'settlement failed' }));
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'settlement failed', reason: selfSettlementError.slice(0, 300) }));
      return;
    }
  }

  // ---- DAY 12 (Item 3/4): MPP settlement ------------------------------------
  // When the buyer presented an MPP credential (Authorization: Payment), the
  // gateway settles via the mpp rail's settle() â€” which calls mppx's
  // broadcastCredential and our custom dual-path settler â€” and records the
  // rail reference for the Spend Receipt. The MPP receipt header (Payment-
  // Receipt) is emitted on the final response; x402 keeps PAYMENT-RESPONSE.
  let mppSettlement = null;
  let mppSettlementError = null;
  if (paymentMode === 'mpp' && mppCredential && railsMod.resolve('mpp')) {
    try {
      const railsMpp = railsMod.resolve('mpp');
      const railRef = await railsMpp.settle(mppCredential);
      mppSettlement = {
        reference: railRef,
        status: 'settled',
        method: 'mpp',
      };
      log.push('MPP SETTLEMENT: railReference=' + railRef + ' status=settled (method=mpp)');
    } catch (e) {
      mppSettlementError = String(e.message || e);
      log.push('MPP SETTLEMENT FAILED: ' + mppSettlementError);
      if (idemKeyNow && idem.fresh) {
        await idempotency.markFailed(idemKeyNow, 502, JSON.stringify({ error: 'mpp settlement failed' }));
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mpp settlement failed', reason: mppSettlementError.slice(0, 300) }));
      return;
    }
  }

  // ---- DAY 11 (Item 4/5): Spend Receipt binding settlement -> commitment ----
  // The receipt carries ONLY the public railReference (transaction identifier)
  // â€” never the credential, signature, or authorization (non-leakage rule).
  // Built from the rail's settle() output (x402 mock receipts, or the
  // self-hosted gateway settlement txHash).
  let spendReceipt = null;
  if (commitmentFlowCtx) {
    const primarySettlement = (settlements && settlements.find(s => s && s.status === 'settled')) || null;
    const txRef = {
      payer: commitmentBuyer,
      payee: commitmentFlowCtx.requirement.payee,
      amount: primarySettlement ? String(primarySettlement.amount || commitmentFlowCtx.requirement.amt) : commitmentFlowCtx.requirement.amt,
      currency: primarySettlement && primarySettlement.asset ? String(primarySettlement.asset) : commitmentFlowCtx.requirement.cur,
      // DAY 12: rail-agnostic binding â€” x402 settlements bind the txHash, MPP
      // settlements bind the MPP railReference. Both are public transaction
      // identifiers; the credential never appears in the receipt.
      rail: (mppSettlement && 'mpp') || ((selfSettlement && SELF_MODE) ? 'x402' : (primarySettlement && primarySettlement.rail) || 'x402'),
      railReference: (mppSettlement && mppSettlement.reference) || (selfSettlement && selfSettlement.txHash) || (primarySettlement && primarySettlement.txHash) || null,
    };
    spendReceipt = gateway.commitmentFlow.buildSpendReceipt({
      manifest: commitmentFlowCtx.manifest,
      R: commitmentFlowCtx.requirement,
      txRef,
    });
    log.push('RECEIPT: spend receipt ' + spendReceipt.receiptId + ' rail=' + spendReceipt.rail +
      ' railReference=' + spendReceipt.railReference + ' noManifest=' + spendReceipt.noManifest);
  }

  const matches = routed.map(sup => {
    const s = settlements.find(x => x.agentId === sup.agent_id);
    return {
      agent_id: sup.agent_id,
      name: sup.name,
      match: sup.match,
      score: sup.score,
      payTo: sup.payTo,
      selectedRail: sup.selectedRail,
      railDetail: sup.railDetail,
      settlement: s || null,
    };
  });

  const escrowProofOut = (selfSettlement && selfSettlement.escrowCommitmentId) ? {
    mode: 'escrow-backed',
    commitmentId: selfSettlement.escrowCommitmentId,
    digest: selfSettlement.escrowDigest || null,
    custody: selfSettlement.escrowCustody || null,
    amount: selfSettlement.escrowAmount || null,
    asset: selfSettlement.escrowAsset || null,
    buyer: selfSettlement.escrowBuyer || null,
    seller: selfSettlement.escrowSeller || null,
    evaluator: selfSettlement.escrowEvaluator || null,
    deadline: selfSettlement.escrowDeadline || null,
    state: selfSettlement.escrowState || null,
    fundTransactionHash: selfSettlement.txHash || null,
    verifiedOnChain: true,
  } : null;
  const respBody = JSON.stringify({
    status: 'ok',
    capability: payload.capability,
    budget: payload.budget,
    deadline: payload.deadline,
    payment: { mode: paymentMode, verified: paymentVerified },
    ...(escrowProofOut ? { escrow: escrowProofOut } : {}),
    ...(spendReceipt ? {
      commitment: {
        commitmentId: spendReceipt.commitmentId,
        manifestHash: spendReceipt.manifestHash,
        receiptId: spendReceipt.receiptId,
        rail: spendReceipt.rail,
        railReference: spendReceipt.railReference,
        settledAt: spendReceipt.settledAt,
      },
      // The full receipt object (noManifest + COSE signature) rides the
      // response for audit; the rail credential NEVER appears anywhere.
      spendReceipt,
    } : {}),
    fee: { baseUsd: fee.baseFeeUsd, discountPct: fee.discountPct, finalUsd: fee.finalFeeUsd, decision: fee.log },
    reputation: repLog,
    matches,
    excluded: excluded.map(e => ({ agent_id: e.agent_id, name: e.name, excludedReason: e.excludedReason })),
    decisionLog: allDecisions,
  }, null, 2);
  if (idemKeyNow && idem.fresh) {
    await idempotency.markSettled(idemKeyNow, 200, respBody);
    log.push('IDEMPOTENCY: key ' + idemKeyNow + ' marked settled (cached response)');
  }
  // Gate D.1: settlement observed -> CONFIRMED. A confirmed reservation keeps
  // consuming its window budget (real money moved); it is never released.
  if (pilotReservation) {
    const settleRef = (selfSettlement && selfSettlement.txHash) ||
      (mppSettlement && (mppSettlement.txHash || mppSettlement.reference)) || null;
    try { await pilotLimits.confirm(pilotReservation, settleRef); log.push('PILOT LIMITS: reservation confirmed ' + pilotReservation); } catch (_) {}
  }
  const respHeaders = { 'Content-Type': 'application/json' };
  if (selfSettlement) {
    // Item 2 receipt: PAYMENT-RESPONSE header with the on-chain settlement.
    respHeaders[gateway.HEADERS.PAYMENT_RESPONSE] = Buffer.from(JSON.stringify({
      transactionHash: selfSettlement.txHash,
      status: selfSettlement.escrowCommitmentId ? 'escrow-funded' : 'settled',
      ...(selfSettlement.escrowCommitmentId ? { escrowMode: 'escrow-backed', escrowCommitmentId: selfSettlement.escrowCommitmentId, escrowCustody: selfSettlement.escrowCustody || null, escrowState: selfSettlement.escrowState || null, escrowAmount: selfSettlement.escrowAmount || null, escrowAsset: selfSettlement.escrowAsset || null, escrowDigest: selfSettlement.escrowDigest || null, fundingTransactionHash: selfSettlement.txHash || null } : {}),
      ...(selfSettlement.dryRun ? { dryRun: true } : {}),
    })).toString('base64');
  }
  // DAY 12 (Item 3): MPP receipt header â€” Payment-Receipt, the MPP counterpart
  // to x402's PAYMENT-RESPONSE. Returns the rail reference (public tx id) only;
  // the credential never appears in any header or body.
  if (mppSettlement && railsMod.resolve('mpp')) {
    const railsMpp = railsMod.resolve('mpp');
    respHeaders['Payment-Receipt'] = railsMpp.buildReceiptHeader({
      method: 'mpp',
      status: 'success',
      reference: mppSettlement.reference,
      chainId: gateway.ACTIVE_CHAIN_ID || gateway.BASE_SEPOLIA_CHAIN_ID,
    });
  }
  res.writeHead(200, respHeaders);
  res.end(respBody);
}

function startServer() {
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ---- x402scan probe methods (Day 15) --------------------------------
  // GET /openapi.json serves the committed discovery document (4a).
  // GET /favicon.ico (x402scan FAVICON_MISSING advisory).
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/favicon.ico') {
    serveFavicon(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/openapi.json') {
    serveOpenapi(req, res);
    return;
  }
  // OPTIONS /route: answer CORS + preflight with a valid x402 bearer challenge
  // (4c). Returns 402, not 405, so discovery scanners that preflight before
  // POST see the payment requirement. CORS headers included for browser
  // preflight.
  if (req.method === 'OPTIONS' && url.pathname === '/route') {
    const optionsChallenge = SELF_MODE ? selfChallenge() : buildChallenge();
    optionsChallenge.accepts[0].maxAmountRequired = ROUTING_FEE_USD;
    const optionsHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Payment-Signature, Authorization, Idempotency-Key, X-X402-Mock, X-Mock-Buyer-Rep',
      'Access-Control-Max-Age': '86400',
    };
    if (SELF_MODE) Object.assign(optionsHeaders, selfChallengeHeaders());
    diagBranch('options-method', req);
    res.writeHead(402, optionsHeaders);
    res.end(JSON.stringify(optionsChallenge));
    return;
  }
  // HEAD /route: same 402 challenge headers as GET, no body (4c).
  if (req.method === 'HEAD' && url.pathname === '/route') {
    const headChallenge = SELF_MODE ? selfChallenge() : buildChallenge();
    headChallenge.accepts[0].maxAmountRequired = ROUTING_FEE_USD;
    const headHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };
    if (SELF_MODE) Object.assign(headHeaders, selfChallengeHeaders());
    diagBranch('head-method', req);
    res.writeHead(402, headHeaders);
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/route') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => handleRoute(req, res, body));
  } else if (url.pathname === '/route' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
    // 2a â€” method coverage: GET/PUT/PATCH/DELETE on /route answer the same
    // x402 challenge as POST, so discovery probes on any verb see the
    // payment requirement instead of a 404/405. Additive to request dispatch;
    // the settlement path, commitment layer, and challenge shape are unchanged.
    const methodChallenge = SELF_MODE ? selfChallenge() : buildChallenge();
    methodChallenge.accepts[0].maxAmountRequired = ROUTING_FEE_USD;
    const methodHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    };
    if (SELF_MODE) Object.assign(methodHeaders, selfChallengeHeaders());
    diagBranch('other-method', req);
    res.writeHead(402, methodHeaders);
    // GET/PUT/PATCH/DELETE all carry the body challenge (only HEAD, handled
    // separately above, is headers-only by nature).
    res.end(JSON.stringify(methodChallenge));
  } else if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      mode: SELF_MODE ? 'self' : 'mock',
      verifyMode: SELF_MODE ? 'self' : x402.VERIFY_MODE,
      x402Mode: gateway.getMode(),
      seller: SELF_MODE ? (gateway.getOperativePayee() || null) : null,
      killSwitch: killswitch.isKillSwitchOn(),
      store: STORE_ACTIVE ? 'supabase' : 'in-memory',
      rateLimitStore: RATE_LIMIT_STORE,
      rails: railsMod.list(), // Day 11: registered settlement rails (x402)
      port: PORT,
      at: new Date().toISOString(),
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, HOST, () => {
  const effectiveMode = SELF_MODE ? 'self' : x402.VERIFY_MODE;
  console.log(`SAAX Protocol route endpoint (mode=${effectiveMode}, verify=${SELF_MODE ? 'self' : x402.VERIFY_MODE}, escrowBacked=${ESCROW_BACKED ? '1' : '0'}, chain=${String(process.env.SAAX_CHAIN_ID || 'not-set')})`);
  console.log(`POST http://${HOST}:${PORT}/route (bound ${HOST}, localhost-only when HOST=127.0.0.1)`);
  console.log(`fee: ${ROUTING_FEE_USD} USDC | payTo: ${SELF_MODE ? (gateway.getOperativePayee() || MOCK_PAYTO) : MOCK_PAYTO} | floor: ${SAAX_CAPABILITY_FLOOR}`);
  console.log(`SAAX_PRICE_SCORE_DEFAULT=${SAAX_PRICE_SCORE_DEFAULT} | SAAX_FRESHNESS_STRATEGY=${SAAX_FRESHNESS_STRATEGY}`);
  console.log(`GATES: killSwitch=${killswitch.isKillSwitchOn()} | store=${STORE_ACTIVE ? 'supabase' : 'in-memory'} | rateLimitStore=${RATE_LIMIT_STORE}`);

});
}  // end startServer
// ---- Day 8: hourly TTL sweep (in-process fallback; Supabase side also sweeps
// via the pg_cron job). Started only when the store client is live.
if (require.main === module && STORE_ACTIVE) {
  const sweepIdem = () => idempotency.sweepExpired().catch(() => {});
  const sweepRl = () => ratelimit.sweepExpired().catch(() => {});
  setInterval(sweepIdem, idempotency.SWEEP_INTERVAL_MS).unref();
  setInterval(sweepRl, ratelimit.SWEEP_INTERVAL_MS).unref();
}

module.exports = {
  buildChallenge,
  computeFee,
  sanitizeCapability,
  parsePayload,
  handleRoute,
  router,
  settle,
  x402,
  killswitch,
  ratelimit,
  idempotency,
  identity,
  store,
  STORE_ACTIVE,
  clientIp,
  walletFromReq,
  // Day 11: commitment lifecycle modules (for tests/harness)
  commitmentMod,
  requirementMod,
  receiptMod,
  railsMod,
};
// Start the listener when this file is the entry point (node route-server.js)
// OR when the process is NOT a Vercel function. Vercel sets VERCEL=1; importing
// api/route.mjs (which uses handleRoute directly) must not open a socket.
// Local test harnesses that import this module (require side-effect) keep the
// legacy start-on-import behavior because VERCEL is unset there.
if (require.main === module || process.env.VERCEL !== "1") startServer();
