// SAAX Protocol — Authenticated Action-Scoped Escrow Access (escrow-access.js)
//
// Implements the contract sequence for the PREFUNDED ESCROW path:
//   select mode -> authenticate role and action -> validate action-specific
//   custody conditions -> atomically record acceptance and nonce ->
//   execute/reconcile -> return recorded status or result
//
// The escrow path requires an ACCESS AUTHORIZATION, never a direct-payment
// signature. The access authorization is an EIP-712 signature by the ROLE that
// OWNS the requested action. It binds EIGHT fields:
//   1. role identity (the signer's address)
//   2. commitment digest (the digest-covered escrow identity bytes32)
//   3. escrow ID (the on-chain escrow identity)
//   4. custody address (the escrow custody contract)
//   5. chain ID (84532 only — Base Sepolia)
//   6. requested action
//   7. nonce (replay protection)
//   8. expiry (authorization validity window)
//
// Role-to-action map (the only action set the server accepts):
//   buyer:     execute, submit evidence, request status, request refund, initiate dispute
//   seller:    submit fulfillment evidence, request status
//   evaluator: submit verdict, resolve dispute
//
// The access authorization PERMITS the operation. It does NOT permit movement
// of escrowed funds. Fund movement requires the RELEASE VERDICT, signed
// separately by the digest-covered evaluator under the deployed custody
// contract's EIP-712 scheme (SAAXEscrowCustodyV1 EscrowVerdict). See route-
// server.js for the verdict path; this module handles access only.
//
// DURABLE ACCEPTANCE: an operation is durably accepted when its record is
// persisted keyed by the access nonce with the payload hash and intended
// external action, in a single atomic write. THE NONCE IS CONSUMED AT THAT
// POINT — by durable acceptance, never by external execution. The crash gap
// between acceptance and external execution is handled by reconciliation: a
// replacement worker that finds an accepted-but-unresolved record determines
// whether the external effect occurred (chain read), records the outcome, and
// does NOT repeat the effect. A consumed nonce means the operation was
// durably accepted, not that the external effect succeeded.
//
// RETRY SEMANTICS:
//   same nonce + same payload hash   -> return the recorded result (no re-execute)
//   same nonce + different payload   -> conflict (409)
//   same payload + different nonce   -> duplicate (409)
//
// The ledger is a local JSON file (atomic rename write). No database
// credentials are required; the file is the durable acceptance store.
//
// RECORDING-LAYER DISCIPLINE (chain-evidence records):
//   NO SYNTHETIC VALUES in chain-evidence records. A value that stands for a
//   chain-derived fact must BE the chain-derived value (read from the chain),
//   never a placeholder or a fixture constant. The 480 disputeAt and the
//   placeholder txHash 0xabab...ab (access ledger nonce 6001) are the same
//   class of defect: a synthetic stand-in for an on-chain fact. When a
//   correction is made, preserve the original record (marked as placeholder),
//   add the real chain-derived value, and link the correction to the receipt.

const fs = require('fs');
const path = require('path');
const { keccak256Bytes, keccak256Hex, eip712Hash, recoverSignerFromSig } = require('../verifier/crypto.js');

// ---- Role-to-action map (explicit, immutable in code) -----------------------
const ROLE_ACTIONS = {
  buyer: ['execute', 'submit evidence', 'request status', 'request refund', 'initiate dispute'],
  seller: ['submit fulfillment evidence', 'request status'],
  evaluator: ['submit verdict', 'resolve dispute'],
};
const ROLES = Object.keys(ROLE_ACTIONS);

// ---- EIP-712 domain + struct for the ACCESS AUTHORIZATION -------------------
// This is the application's access-auth scheme (distinct from the custody
// contract's release-verdict scheme). The verifier never sees this struct; it
// is an application-level gate that keeps execution operations tied to the
// role that owns them.
const ACCESS_DOMAIN = {
  name: 'SAAX Escrow Access',
  version: '1',
  // env-driven so the LOCAL integrated configuration (chain 31337) can be
  // tested; the hosted default (env unset) remains 84532 (Base Sepolia)
  // byte-identical to the committed baseline.
  chainId: Number(process.env.SAAX_ACCESS_CHAIN_ID || 84532),
  // verifyingContract is NOT the custody address here: the access auth binds
  // custody as a *field*, so the same signed artifact can be validated against
  // the exact custody the escrow lives on without re-signing per contract.
  verifyingContract: '0x0000000000000000000000000000000000000000',
};
const ACCESS_TYPES = {
  EscrowAccess: [
    { name: 'role', type: 'string' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'escrowId', type: 'bytes32' },
    { name: 'custody', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
};

// ---- Role-address map (application config) ----------------------------------
// The digest-covered evaluator for the escrow flow is the operational signer
// (SAAX_SIGNER_ADDRESS) — the key the escrow was funded with as evaluator.
// Buyer and seller are the application's configured party addresses.
function roleAddrFor(role) {
  const env = process.env;
  switch (role) {
    case 'buyer': return env.SAAX_TEST_BUYER_ADDRESS || '';
    case 'seller': return env.SAAX_SELLER_ADDRESS || '';
    case 'evaluator': return env.SAAX_SIGNER_ADDRESS || '';
    default: return '';
  }
}

// ---- Asset address mapping (currency symbol -> escrow asset token) -----------
// The on-chain escrow records the asset as the token ADDRESS (USDC on Base
// Sepolia); the agreement/manifest records the CURRENCY SYMBOL. This map
// resolves the agreement's currency to the escrow asset address so the
// funding-binding check compares addresses, never symbols.
const ASSET_ADDRESSES = {
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
function assetAddressFor(currency) {
  const sym = String(currency || '').toUpperCase();
  const override = process.env.SAAX_ASSET_USDC || '';
  if (sym === 'USDC' && /^0x[0-9a-fA-F]{40}$/.test(override)) return override.trim().toLowerCase();
  return ASSET_ADDRESSES[sym] || null;
}

// ---- Durable acceptance ledger ----------------------------------------------
const LEDGER_PATH = process.env.SAAX_ESCROW_LEDGER || path.join(__dirname, '..', 'data', 'escrow-access-ledger.json');
let _ledgerCache = null;

function loadLedger() {
  if (_ledgerCache) return _ledgerCache;
  try {
    _ledgerCache = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch (e) {
    _ledgerCache = { operations: {} };
  }
  return _ledgerCache;
}

function persistLedger(ledger) {
  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = LEDGER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmp, LEDGER_PATH); // atomic on same volume
  _ledgerCache = ledger;
}

function sha256hex(str) {
  return require('crypto').createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function payloadHash(payload) {
  // Stable canonical hash of the operation request (action + bindings that
  // are NOT the nonce — the nonce is the key). Two requests with the same
  // nonce and the same payload hash are the identical operation.
  const canonical = JSON.stringify({
    role: payload.role,
    commitmentDigest: String(payload.commitmentDigest || '').toLowerCase(),
    escrowId: String(payload.escrowId || '').toLowerCase(),
    custody: String(payload.custody || '').toLowerCase(),
    chainId: String(payload.chainId || ''),
    action: String(payload.action || ''),
    expiry: String(payload.expiry || ''),
  });
  return sha256hex(canonical);
}

// ---- Access authorization verification --------------------------------------
function verifyAccessAuthorization(artifact) {
  // artifact = { payload: {role, commitmentDigest, escrowId, custody, chainId,
  //             action, nonce, expiry}, signature: {v,r,s} }
  const res = { ok: false, reason: null, error: null };
  try {
    if (!artifact || !artifact.payload || !artifact.signature) {
      res.reason = 'access authorization missing payload or signature'; res.error = 'MISSING'; return res;
    }
    const p = artifact.payload;
    for (const f of ['role', 'commitmentDigest', 'escrowId', 'custody', 'chainId', 'action', 'nonce', 'expiry']) {
      if (p[f] === undefined || p[f] === null || p[f] === '') {
        res.reason = 'access authorization missing binding field: ' + f; res.error = 'MISSING_FIELD'; return res;
      }
    }
    // 1. role identity — the signature must recover to the role the action requires
    const role = String(p.role);
    if (!ROLES.includes(role)) { res.reason = 'unknown role ' + role; res.error = 'UNKNOWN_ROLE'; return res; }
    // 2. action within the role's permitted set
    if (!ROLE_ACTIONS[role].includes(String(p.action))) {
      res.reason = 'action "' + p.action + '" not within role ' + role + ' permitted set [' + ROLE_ACTIONS[role].join(', ') + ']';
      res.error = 'FORBIDDEN_ACTION'; return res;
    }
    // 3. chain — Base Sepolia only
    const allowedChain = String(process.env.SAAX_ACCESS_CHAIN_ID || '84532');
    if (String(p.chainId) !== allowedChain) {
      res.reason = 'access authorization chainId ' + p.chainId + ' != ' + allowedChain + ' (allowed chain only)'; res.error = 'BAD_CHAIN'; return res;
    }
    // 4. expiry — must be in the future
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(p.expiry) <= BigInt(now)) {
      res.reason = 'access authorization expired (expiry ' + p.expiry + ' <= now ' + now + ')'; res.error = 'EXPIRED'; return res;
    }
    // 5. nonce must be a positive integer
    if (!/^[0-9]+$/.test(String(p.nonce))) { res.reason = 'access nonce invalid'; res.error = 'BAD_NONCE'; return res; }
    // 6. signature recovery — over the full 8-field struct
    const sig = artifact.signature;
    if (!(sig && sig.v && sig.r && sig.s)) { res.reason = 'access authorization signature incomplete'; res.error = 'BAD_SIG'; return res; }
    const msgHash = eip712Hash(ACCESS_DOMAIN, ACCESS_TYPES, 'EscrowAccess', {
      role,
      commitmentDigest: p.commitmentDigest,
      escrowId: p.escrowId,
      custody: p.custody,
      chainId: BigInt(p.chainId),
      action: String(p.action),
      nonce: BigInt(p.nonce),
      expiry: BigInt(p.expiry),
    });
    const signer = recoverSignerFromSig(msgHash, sig);
    if (!signer) { res.reason = 'access authorization signature recovery failed'; res.error = 'BAD_SIG'; return res; }
    res.signer = signer.toLowerCase();
    res.recoveredSigner = signer.toLowerCase();
    // The artifact's declared role must match the signer AND the signer must be
    // the configured address that OWNS that role. The role-address map comes
    // from the application environment; a signature by an address that is not
    // the role's configured owner is rejected even if recovery succeeds.
    const roleAddr = String(roleAddrFor(role) || '').toLowerCase();
    if (!roleAddr) { res.reason = 'no configured address for role ' + role; res.error = 'NO_ROLE_ADDR'; return res; }
    if (signer.toLowerCase() !== roleAddr) {
      res.reason = 'access authorization signer ' + signer.slice(0, 10) + ' != configured ' + role + ' address ' + roleAddr.slice(0, 10);
      res.error = 'SIGNER_ROLE_MISMATCH';
      return res;
    }
    res.ok = true;
    return res;
  } catch (e) {
    res.reason = 'access authorization verification error: ' + String(e.message || e).slice(0, 200);
    res.error = 'VERIFY_ERROR';
    return res;
  }
}

// ---- Durable acceptance + nonce consumption ----------------------------------
// Consumes the nonce ATOMICALLY with durable acceptance. The operation record
// is keyed by nonce and stores the payload hash + intended action. If the
// nonce is already consumed:
//   - same payload hash -> return the recorded result (idempotent retry)
//   - different payload  -> conflict
function acceptOperation(payload, payloadData) {
  const nonce = String(payload.nonce);
  const ph = payloadHash(payload);
  const now = Math.floor(Date.now() / 1000);
  const ledger = loadLedger();
  const existing = ledger.operations[nonce];
  // Duplicate detection: the SAME operation (role + action + digest + escrow +
  // custody + chain) submitted under a DIFFERENT nonce is a duplicate — the
  // caller re-requested the same external operation under a new nonce instead
  // of retrying the same nonce. Rejected per the retry semantics contract.
  if (!existing && payload.role && payload.action && payload.commitmentDigest) {
    const sameOp = Object.values(ledger.operations).find((r) =>
      r.role === payload.role &&
      r.action === payload.action &&
      String(r.commitmentDigest).toLowerCase() === String(payload.commitmentDigest).toLowerCase() &&
      String(r.escrowId).toLowerCase() === String(payload.escrowId).toLowerCase() &&
      String(r.custody).toLowerCase() === String(payload.custody || '').toLowerCase() &&
      String(r.chainId) === String(payload.chainId) &&
      String(r.nonce) !== nonce);
    if (sameOp) {
      return { ok: false, duplicate: true, reason: 'duplicate operation: same action/digest/escrow already accepted under nonce ' + sameOp.nonce + ' (use that nonce to retry; a new nonce for the same payload is a duplicate)' };
    }
  }
  if (existing) {
    if (existing.payloadHash === ph && existing.role === payload.role) {
      return { ok: false, idempotent: true, recorded: existing, reason: 'nonce already accepted with identical payload (retry returns recorded result)' };
    }
    return { ok: false, conflict: true, reason: 'nonce ' + nonce + ' already consumed with a DIFFERENT payload (conflict)' };
  }
  const record = {
    nonce,
    payloadHash: ph,
    role: payload.role,
    action: payload.action,
    commitmentDigest: String(payload.commitmentDigest).toLowerCase(),
    escrowId: String(payload.escrowId).toLowerCase(),
    custody: String(payload.custody).toLowerCase(),
    chainId: String(payload.chainId),
    expiry: String(payload.expiry),
    status: 'accepted',       // durably accepted; external effect NOT yet confirmed
    acceptedAt: now,
    externalEffect: null,     // set by reconcile: { occurred, txHash, state, at }
    result: payloadData || null,
  };
  ledger.operations[nonce] = record;
  persistLedger(ledger);
  // Phase A journal hook (env-gated; inert unless SAAX_ESCROW_JOURNAL_DIR is
  // set). INTENT entry: acceptOperation records ACCEPTED INTENT — not
  // confirmed funding/dispute/release/refund. The recovered access-auth
  // signer is the authorizing party; the journal entry is attested by the
  // operator journal key (SAAX_JOURNAL_SIGNER_KEY) with authorization
  // evidence. The endpoint's attestation never substitutes for the actor's
  // authorization. An 'intent' entry cannot satisfy a confirmed lifecycle
  // transition. Errors are surfaced (console), never fabricated as an entry,
  // never changing the ledger outcome.
  try {
    if (process.env.SAAX_ESCROW_JOURNAL_DIR) {
      const journal = require('./escrow-journal.js');
      const chainId = Number(payload.chainId) || 0;
      const custodyAddress = String(payload.custody || '');
      const commitmentId = String(payload.commitmentDigest || '').toLowerCase();
      const authSigner = record && record.result && record.result.recoveredSigner;
      const role = payload.role === 'evaluator' ? 'evaluator' : (payload.role === 'seller' ? 'seller' : 'buyer');
      journal.append({
        chainId, custodyAddress, commitmentId, manifestHash: commitmentId,
        transition: 'intent', role, by: authSigner || '0x0000000000000000000000000000000000000000',
        contractAction: payload.action, resultingState: 'Accepted', at: new Date().toISOString(),
        kind: 'intent', authorization: { kind: 'access-auth', nonce: payload.nonce, signer: authSigner || null },
      }).then(res => { if (!res.ok && !res.skipped) console.error('escrow-access journal append failed: ' + res.error); }).catch(e => console.error('escrow-access journal append error: ' + (e && e.message)));
    }
  } catch (e) { console.error('escrow-access journal hook (accept): ' + (e && e.message)); }
  return { ok: true, recorded: record };
}

// ---- Reconciliation (worker replacement / crash recovery) -------------------
// After a crash between acceptance and external execution, a replacement
// worker calls reconcile: it inspects the accepted record, determines whether
// the external effect occurred (chain read by the caller), records the
// outcome, and does NOT repeat the effect. The nonce is NOT re-consumed.
function getAccepted(nonce) {
  const ledger = loadLedger();
  const rec = ledger.operations[String(nonce)];
  if (!rec) return null;
  return rec;
}

function reconcile(nonce, outcome) {
  const ledger = loadLedger();
  const rec = ledger.operations[String(nonce)];
  if (!rec) return { ok: false, reason: 'no accepted operation for nonce ' + nonce };
  if (rec.status === 'complete') {
    return { ok: true, idempotent: true, recorded: rec, reason: 'operation already complete (reconciled); external effect NOT repeated' };
  }
  rec.status = outcome.occurred ? 'complete' : 'failed';
  rec.externalEffect = {
    occurred: !!outcome.occurred,
    txHash: outcome.txHash || null,
    state: outcome.state || null,
    at: Math.floor(Date.now() / 1000),
    block: outcome.block || null,
  };
  rec.result = outcome.result || rec.result;
  persistLedger(ledger);
  // Phase A journal hook (env-gated): CONFIRMED observed entries. The
  // endpoint confirms an on-chain transition (externalEffect occurred) that
  // it did not sign; records observed=true with the actual tx hash and block,
  // the AUTHORIZING signer for the transition (derived from the ledger
  // record's role per the v4 transition authority — never tx.from alone), and
  // the SUBMITTER (tx.from, possibly a relayer) recorded separately. If the
  // sender cannot be recovered, NO entry is fabricated; journalGap() reports
  // the missing transition.
  try {
    if (process.env.SAAX_ESCROW_JOURNAL_DIR && rec.externalEffect && rec.externalEffect.occurred && rec.externalEffect.txHash) {
      const journal = require('./escrow-journal.js');
      const action = String(rec.action || '').toLowerCase();
      const transition = journal.ACTION_TO_TRANSITION[action];
      if (transition) {
        const role = rec.role === 'evaluator' ? 'evaluator' : (rec.role === 'seller' ? 'seller' : 'buyer');
        journal.appendObserved({
          chainId: Number(rec.chainId) || 0,
          custodyAddress: rec.custody || '',
          commitmentId: String(rec.commitmentDigest || '').toLowerCase(),
          manifestHash: String(rec.commitmentDigest || '').toLowerCase(),
          transition, role,
          authorizer: role === 'evaluator' ? (rec.authorizer || null) : (role === 'buyer' || role === 'seller' ? roleAddrFor(role) : null),
          contractAction: rec.action, resultingState: rec.externalEffect.state || 'Confirmed',
          at: new Date().toISOString(),
          txHash: rec.externalEffect.txHash, blockHash: rec.externalEffect.block || undefined,
        }).then(res => { if (!res.ok && !res.skipped) console.error('escrow-access journal reconcile: ' + (res.missingEvidence || res.error)); }).catch(e => console.error('escrow-access journal reconcile error: ' + (e && e.message)));
      }
    }
  } catch (e) { console.error('escrow-access journal hook (reconcile): ' + (e && e.message)); }
  return { ok: true, recorded: rec };
}

// ---- Status / recovery queries (NOT gated on funding) ------------------------
// Status and recovery operations never require the funding check. They read
// the ledger + on-chain escrow state. The role's authorization is still
// verified (request status is within buyer/seller/evaluator permitted sets).
function queryStatus(nonce) {
  const rec = getAccepted(nonce);
  if (!rec) return { ok: false, reason: 'no accepted operation for nonce ' + nonce };
  return { ok: true, recorded: rec };
}

// ---- Verified funding check (execution gate) ---------------------------------
// Chain-read verification that the escrow is funded AND bound to the
// agreement. The caller passes the agreement-side expectations (digest,
// buyer, seller, evaluator, asset, amount) so the escrow record is checked
// against the digest-covered agreement, not just "is funded". Status and
// recovery queries do NOT call this — funding gates execution only.
function verifyFundingBindings(escrow, expected) {
  if (!escrow) return { ok: false, reason: 'no escrow record' };
  const esc = escrow;
  const checks = [];
  const lc = (x) => String(x || '').toLowerCase();
  if (expected && expected.digest) {
    const ed = lc(esc.digest);
    const xd = lc(expected.digest);
    if (ed && xd && ed !== xd) checks.push('digest ' + ed.slice(0, 14) + ' != agreement digest ' + xd.slice(0, 14));
  }
  if (expected && expected.buyer) {
    if (lc(esc.buyer) !== lc(expected.buyer)) checks.push('buyer ' + lc(esc.buyer).slice(0, 10) + ' != agreement buyer ' + lc(expected.buyer).slice(0, 10));
  }
  if (expected && expected.seller) {
    if (lc(esc.seller) !== lc(expected.seller)) checks.push('seller ' + lc(esc.seller).slice(0, 10) + ' != agreement seller ' + lc(expected.seller).slice(0, 10));
  }
  if (expected && expected.evaluator) {
    if (lc(esc.evaluator) !== lc(expected.evaluator)) checks.push('evaluator ' + lc(esc.evaluator).slice(0, 10) + ' != agreement evaluator ' + lc(expected.evaluator).slice(0, 10));
  }
  if (expected && expected.amount !== undefined && expected.amount !== null && expected.amount !== '') {
    if (String(esc.amount) !== String(expected.amount)) checks.push('amount ' + esc.amount + ' != agreement amount ' + expected.amount);
  }
  if ((expected && expected.asset) && esc.token) {
    if (lc(esc.token) !== lc(expected.asset)) checks.push('asset ' + lc(esc.token).slice(0, 10) + ' != agreement asset ' + lc(expected.asset).slice(0, 10));
  }
  if (!esc.buyer || /^0x0+$/.test(lc(esc.buyer))) checks.push('escrow buyer is zero');
  if (!esc.amount || BigInt(esc.amount) <= 0n) checks.push('escrow amount is zero');
  if (checks.length) return { ok: false, reason: 'escrow funding binding mismatch: ' + checks.join('; ') };
  return { ok: true, reason: null };
}

module.exports = {
  ROLE_ACTIONS,
  ROLES,
  ACCESS_DOMAIN,
  ACCESS_TYPES,
  verifyAccessAuthorization,
  roleAddrFor,
  assetAddressFor,
  verifyFundingBindings,
  acceptOperation,
  getAccepted,
  reconcile,
  queryStatus,
  payloadHash,
  LEDGER_PATH,
};