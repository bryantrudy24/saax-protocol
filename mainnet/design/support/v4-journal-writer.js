'use strict';
/**
 * SAAX Pilot Journal Phase A — SHARED JOURNAL WRITER MODULE.
 *
 * One writer module used by BOTH producer paths:
 *   1. scripts/test-v4-checkpoint.cjs  (producer initiates actions)
 *   2. endpoint/escrow-access.js        (endpoint initiates or observes)
 *
 * Design source: mainnet/design/v4-journal-schema-decision.md.
 *  - Record shape: hash chain only (recommended option A).
 *  - Binding: journal is SEPARATE from the signed v4 representation (NO
 *    journal root in the digest). The first entry binds to the agreement via
 *    commitmentId + manifestHash (authenticated association). It does NOT
 *    claim completeness.
 *  - Signing domain: v4 journal domain (SAAX Commitment Journal / "4",
 *    chainId = agreement custody.chainId, verifyingContract = agreement
 *    custody.custodyAddress) via mainnet/design/support/v4-signatures.js
 *    helpers. NOT v3's domain, NOT the custody domain, NEVER inferred from
 *    formatVersion.
 *  - Association vs completeness: head-binding gives association; the hash
 *    chain gives tamper evidence. Neither establishes completeness.
 *  - Hash chain vs alternative history: chain integrity is relative to an
 *    authenticated checkpoint; it does not prevent an authorized signer from
 *    creating an alternative history from that checkpoint.
 *
 * PHASE A CORRECTIONS (this module):
 *  - EVIDENCE BINDING: outcome-relevant evidence references — chain/custody,
 *    transaction hash, block reference, and authorization digest — are bound
 *    directly through a canonical evidenceDigest included in BOTH the entry
 *    hash and the EIP-712 signature. Sigs are NEVER part of their own signed
 *    hash (sigs/signedBy live outside canonicalEntryFields). Unsigned
 *    metadata (recoveredSigner/signedBy/authorization) is never treated as
 *    authoritative: it is bound via evidenceDigest and cross-checked by
 *    recovery on read, never trusted as-is.
 *  - INTENT vs CONFIRMED: accepted-intent entries (transition 'intent')
 *    record that an action was ACCEPTED, not that funding/release/refund
 *    occurred. 'intent' entries are tagged and MUST NOT satisfy a confirmed
 *    lifecycle transition. Confirmed transitions are 'funded', 'dispute',
 *    'release', 'refund', 'mutual-release', 'mutual-refund',
 *    'timeout-refund'.
 *  - DISPUTE ROLES: the custody contracts (V1/V2) allow BUYER OR SELLER to
 *    raise a dispute (raiseDispute: only commitments parties; evaluator is
 *    deliberately excluded). The writer accepts role 'buyer' OR 'seller' for
 *    the 'dispute' transition — no buyer-only assumption.
 *  - RELAYED ACTIONS: for observed entries, tx.from identifies the SUBMITTER
 *    (potentially a relayer). The authorizing party is derived from the
 *    actual contract path and applicable signature/caller rules, and recorded
 *    in 'by'. The submitter is recorded separately. Sender != authorizer is
 *    supported; the authorizer is never inferred from tx.from alone.
 *  - EVENT IDENTITY + DEDUP: every entry carries a stable eventId =
 *    sha256({commitmentId, transition, role, by, contractAction,
 *    resultingState[, txHash for observed]}). Appending an entry whose
 *    eventId already exists is rejected deterministically (no second logical
 *    event). Restart-safe: eventId is derived from entry content, so the
 *    dedup set is reconstructed from the chain on restore.
 *  - ATOMIC PERSISTENCE: the endpoint/journal persistence layer writes via
 *    tmp + atomic rename (see endpoint/escrow-journal.js save()). This module
 *    itself is in-memory + snapshot; snapshot/restore is validated.
 *
 * Transition authority (v4-derivation, NOT v3's map):
 *   issue            -> buyer            (first entry, agreement binding)
 *   funded           -> buyer
 *   dispute          -> buyer | seller   (contract V1/V2: either party)
 *   release          -> evaluator        (incl. disputed resolution)
 *   refund           -> evaluator        (incl. disputed resolution)
 *   mutual-release   -> buyer + seller   (two signatures)
 *   mutual-refund    -> buyer + seller   (two signatures)
 *   timeout-refund   -> open             (no role; eligible at/after final
 *                                          cutoff, recipient fixed by the
 *                                          contract)
 *   intent           -> <accepting role> (accepted intent; NOT a confirmed
 *                                          lifecycle transition)
 *
 * SIGNATURE MODEL (authority honesty):
 *   - by        : the authorizing party per the transition authority map
 *                 (buyer/seller/evaluator address / timeout submitter).
 *   - signedBy  : the address whose key actually signed this journal entry.
 *   - For EOA-initiated actions where the writer holds the role key
 *     (issue/funded/dispute -> buyer|seller; mutual -> buyer+seller), the
 *     role key signs the entry AND signedBy == by: the signature recovers to
 *     the authorizing party.
 *   - For evaluator transitions (Safe contract evaluator) and timeout, the
 *     writer CANNOT sign as the role-holder: the entry is signed by the
 *     writer's attestation key (signedBy recorded), and the AUTHORITY is the
 *     on-chain authorization evidence (authorization block) plus the on-chain
 *     receipt reference. The writer's signature NEVER substitutes for the
 *     authorization required to execute the action.
 *   - observed : true means the writer saw an action performed elsewhere; the
 *     entry records the ACTUAL authorizing signer recovered from the on-chain
 *     action (recoveredSigner == by) AND the submitter (tx.from) separately.
 *     The writer does NOT sign as if it authorized the action.
 *
 * Fail-closed properties:
 *   - fork rejection: append refuses if the caller-supplied prevHash does not
 *     match the writer's current tail (a fork in the writer is a bug).
 *   - write consistency: append validates EVERYTHING before mutating; the
 *     journal is never left partially mutated (throw before mutation).
 *   - failures surface (throw), never swallowed.
 *   - restore() re-validates a saved chain; refuses a broken/mismatched tail.
 *   - duplicate eventId (retry or repeated observation) is REJECTED, not
 *     silently appended.
 */

const crypto = require('crypto');
const signatures = require('./v4-signatures');

const sha256Hex = (s) => '0x' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---- transition authority (v4-derivation, NOT v3's map) ---------------------
// dispute: buyer OR seller — matches custody V1/V2 raiseDispute
// (only commitment parties; evaluator deliberately excluded).
const JOURNAL_TRANSITION_AUTHORITY = {
  issue: 'buyer',
  funded: 'buyer',
  dispute: 'buyer|seller',
  release: 'evaluator',
  refund: 'evaluator',
  'mutual-release': 'buyer+seller',
  'mutual-refund': 'buyer+seller',
  'timeout-refund': 'open',
  intent: 'any', // accepted-intent recording: the accepting role
};

// Confirmed lifecycle transitions (accepted intent does NOT satisfy these).
const CONFIRMED_TRANSITIONS = new Set([
  'issue', 'funded', 'dispute', 'release', 'refund',
  'mutual-release', 'mutual-refund', 'timeout-refund',
]);
const INTENT_TRANSITIONS = new Set(['intent']);
const EVALUATOR_TRANSITIONS = new Set(['release', 'refund']);
const MUTUAL_TRANSITIONS = new Set(['mutual-release', 'mutual-refund']);

function isAddress(v) { return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v); }
function isBytes32(v) { return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v); }
function isTxRef(v) { return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v); }

// ---- canonical entry hash ----------------------------------------------------
// Hash input = the entry fields that determine the event (array order
// preserved; object keys deep-sorted). entryHash = sha256(canonical JSON).
// The signature covers the EIP-712 JournalEventV4 message including entryHash
// AND evidenceDigest. Sigs are never part of their own hash.
const HASH_FIELDS = [
  'commitmentId', 'manifestHash', 'transition', 'role', 'by',
  'contractAction', 'resultingState', 'at', 'observed', 'prevHash',
  'evidenceDigest',
];
// Every field an entry may carry. Unknown fields are REJECTED (strict schema):
// a rogue field must never silently join the hash input or the entry.
const ALLOWED_FIELDS = new Set([
  ...HASH_FIELDS,
  'entryHash', 'eventId', 'sigs', 'signedBy', 'recoveredSigner',
  'submitter', 'txHash', 'blockHash', 'authorization',
]);

function deepSortKeys(v) {
  if (Array.isArray(v)) return v.map(deepSortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = deepSortKeys(v[k]); return acc; }, {});
  }
  return v;
}

function canonicalEntryFields(entry) {
  const fields = {};
  for (const f of HASH_FIELDS) fields[f] = entry[f];
  return fields;
}

function entryHashOf(fields) { return sha256Hex(JSON.stringify(deepSortKeys(fields))); }

// ---- canonical evidence digest ----------------------------------------------
// Binds outcome-relevant evidence references (chain/custody, transaction
// hash, block reference, authorization digest) into one canonical digest that
// is part of the entry hash AND the EIP-712 signature.
function canonicalEvidence({ chainId, custodyAddress, txHash, blockHash, authorization, submitter }) {
  const ev = { chainId: Number(chainId), custodyAddress: String(custodyAddress).toLowerCase() };
  if (txHash) { if (!isTxRef(txHash)) throw new Error('journal writer: txHash must be 32-byte hex'); ev.txHash = txHash.toLowerCase(); }
  if (blockHash) { if (!isTxRef(blockHash)) throw new Error('journal writer: blockHash must be 32-byte hex'); ev.blockHash = blockHash.toLowerCase(); }
  if (submitter) { if (!isAddress(submitter)) throw new Error('journal writer: submitter must be a valid address'); ev.submitter = submitter.toLowerCase(); }
  if (authorization !== undefined && authorization !== null) {
    if (typeof authorization !== 'object') throw new Error('journal writer: authorization must be an object');
    const auth = {};
    for (const k of Object.keys(authorization).sort()) {
      const v2 = authorization[k];
      if (v2 === undefined || v2 === null) continue;
      auth[k] = (typeof v2 === 'string') ? v2.toLowerCase() : v2;
    }
    ev.authorization = auth;
  }
  return sha256Hex(JSON.stringify(deepSortKeys(ev)));
}

// ---- stable event identity ---------------------------------------------------
// Same logical event (commitment + transition + role + by + action + state,
// plus txHash for observed) always maps to the same eventId. Retry/duplicate
// observation => same eventId => rejected deterministically.
function eventIdOf({ commitmentId, transition, role, by, contractAction, resultingState, txHash }) {
  return sha256Hex(JSON.stringify(deepSortKeys({
    commitmentId: String(commitmentId).toLowerCase(),
    transition, role, by: String(by).toLowerCase(),
    contractAction, resultingState,
    ...(txHash ? { txHash: String(txHash).toLowerCase() } : {}),
  })));
}

// ---- restore validation --------------------------------------------------------
function validateChain(events) {
  let tail = '0x' + '00'.repeat(32);
  const seen = new Set();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.prevHash !== tail) return { ok: false, at: i, why: 'prevHash broken at ' + i };
    const expected = entryHashOf(canonicalEntryFields(ev));
    if (ev.entryHash !== expected) return { ok: false, at: i, why: 'entryHash mismatch at ' + i };
    if (ev.eventId !== undefined) {
      const eid = eventIdOf(ev);
      if (ev.eventId !== eid) return { ok: false, at: i, why: 'eventId mismatch at ' + i };
      if (seen.has(ev.eventId)) return { ok: false, at: i, why: 'duplicate eventId at ' + i };
      seen.add(ev.eventId);
    }
    tail = ev.entryHash;
  }
  return { ok: true, tail };
}

// ---- the writer --------------------------------------------------------------
function createJournalWriter({ chainId, custodyAddress, commitmentId, manifestHash }) {
  if (!isBytes32(commitmentId)) throw new Error('journal writer: commitmentId must be 32-byte hex');
  if (!isBytes32(manifestHash)) throw new Error('journal writer: manifestHash must be 32-byte hex');
  if (!isAddress(custodyAddress)) throw new Error('journal writer: custodyAddress must be a valid address');
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('journal writer: chainId must be a positive integer');

  const events = [];
  const seenEventIds = new Set();
  let tailHash = '0x' + '00'.repeat(32);

  function currentTail() { return tailHash; }

  async function buildEntry({
    transition, role, by, contractAction, resultingState, at, observed = false,
    signerWallets = [],      // EOA wallets whose keys sign this journal entry
    recoveredSigner,         // observed: actual authorizing signer (on-chain)
    submitter,               // observed: tx.from — the submitter, possibly a relayer
    txHash, blockHash,       // observed: on-chain references
    authorization = null,    // evaluator/timeout: custody-accepted authorization evidence
    expectByEqualsSigner = undefined,
    ...rest
  }) {
    const unknown = Object.keys(rest);
    if (unknown.length) {
      throw new Error('journal writer: unknown field(s) on entry: ' + unknown.join(', ') + ' (strict schema — non-canonical fields rejected)');
    }
    if (!Object.prototype.hasOwnProperty.call(JOURNAL_TRANSITION_AUTHORITY, transition)) {
      throw new Error('journal writer: unsupported transition "' + transition + '" ');
    }
    // Role validation: 'buyer' | 'seller' | 'evaluator' | 'buyer+seller' | 'open' | 'any'
    const authority = JOURNAL_TRANSITION_AUTHORITY[transition];
    const roleOk = authority === 'any' || authority === role ||
      (authority === 'buyer|seller' && (role === 'buyer' || role === 'seller'));
    if (!roleOk) throw new Error('journal writer: transition ' + transition + ' requires role ' + authority + ' but got ' + role);
    if (!isAddress(by)) throw new Error('journal writer: by must be a valid address');
    if (typeof contractAction !== 'string' || !contractAction) throw new Error('journal writer: contractAction required');
    if (typeof resultingState !== 'string' || !resultingState) throw new Error('journal writer: resultingState required');
    const ts = Date.parse(at);
    if (Number.isNaN(ts)) throw new Error('journal writer: invalid at timestamp');
    const atIso = new Date(ts).toISOString();
    if (signerWallets.length === 0) throw new Error('journal writer: at least one signing wallet is required (role key or writer attestation key)');

    if (observed) {
      if (!isAddress(recoveredSigner)) throw new Error('journal writer: observed entry requires recovered on-chain authorizing signer');
      if (recoveredSigner.toLowerCase() !== by.toLowerCase()) {
        throw new Error('journal writer: observed by != recovered signer (by must be the AUTHORIZING party, not the submitter)');
      }
      if (!txHash || !isTxRef(txHash)) throw new Error('journal writer: observed entry requires txHash');
      if (!blockHash || !isTxRef(blockHash)) throw new Error('journal writer: observed entry requires blockHash');
      if (submitter !== undefined && submitter !== null && !isAddress(submitter)) {
        throw new Error('journal writer: submitter must be a valid address');
      }
    }

    if (transition === 'intent') {
      // Accepted intent: by is the accepting/recovered access signer (or the
      // endpoint attests with the caller's role). Explicitly NOT a confirmed
      // lifecycle transition; resultingState must be an intent marker.
      if (!/^intent:/i.test(resultingState) && resultingState.toLowerCase() !== 'accepted') {
        throw new Error('journal writer: intent entry resultingState must mark intent (got ' + resultingState + ')');
      }
    }

    // Determine the actual signer addresses.
    const signerAddrs = signerWallets.map(w => String(w.address).toLowerCase());
    if (!observed && role !== 'open' && role !== 'evaluator' && transition !== 'intent') {
      if (role === 'buyer+seller') {
        if (signerWallets.length !== 2) throw new Error('journal writer: mutual transition requires exactly two signing wallets');
        if (signerAddrs[0] === signerAddrs[1]) throw new Error('journal writer: mutual signers must be distinct');
      } else if (signerWallets.length !== 1) {
        throw new Error('journal writer: transition ' + transition + ' requires exactly one signing wallet');
      }
      if (expectByEqualsSigner !== false && signerAddrs[0] !== by.toLowerCase()) {
        throw new Error('journal writer: by ' + by + ' != role signer ' + signerAddrs[0]);
      }
    }
    if (role === 'evaluator' && !observed && !authorization) {
      throw new Error('journal writer: evaluator transition requires on-chain authorization evidence (SafeMessage/verdict)');
    }

    // Canonical evidence digest: binds chain/custody + (observed: tx/block/
    // submitter) + authorization into the hash AND the signature.
    const evidenceDigest = canonicalEvidence({
      chainId, custodyAddress, txHash, blockHash, authorization, submitter,
    });

    const entry = {
      commitmentId, manifestHash, transition, role, by,
      contractAction, resultingState, at: atIso, observed: !!observed,
      prevHash: tailHash, evidenceDigest,
      // Evidence refs are persisted on EVERY entry that carries them (initiated
      // AND observed) so the record carries its own evidence — the digest alone
      // over hidden refs is not reconstructible from the record. Observed
      // entries additionally carry recoveredSigner/submitter.
      ...(txHash ? { txHash, ...(blockHash ? { blockHash } : {}) } : {}),
      ...(observed ? { recoveredSigner, ...(submitter ? { submitter } : {}) } : {}),
      ...(authorization ? { authorization } : {}),
    };
    entry.entryHash = entryHashOf(canonicalEntryFields(entry));
    entry.eventId = eventIdOf({ commitmentId, transition, role, by, contractAction, resultingState, txHash });

    // Dedup: the same logical event must not be appended twice.
    if (seenEventIds.has(entry.eventId)) {
      const err = new Error('journal writer: duplicate eventId ' + entry.eventId.slice(0, 18) + ' (code DUPLICATE_EVENT — identical logical event already recorded; retry/repeated observation rejected)');
      err.code = 'DUPLICATE_EVENT';
      throw err;
    }

    const sigInput = {
      commitmentId, manifestHash, transition, role, by,
      contractAction, resultingState, at: atIso, observed: !!observed,
      prevHash: entry.prevHash, entryHash: entry.entryHash,
      evidenceDigest,
      verifyingContract: custodyAddress, chainId,
    };
    entry.sigs = [];
    for (const w of signerWallets) {
      const s = await signatures.signJournalEvent(w, sigInput);
      entry.sigs.push({ v: s.v, r: s.r, s: s.s });
    }
    entry.signedBy = signerAddrs.join('+');
    return entry;
  }

  async function append(opts) {
    if (opts.prevHash !== undefined && opts.prevHash !== tailHash) {
      throw new Error('journal writer: fork — caller prevHash ' + String(opts.prevHash).slice(0, 20) + ' != writer tail ' + String(tailHash).slice(0, 20));
    }
    const entry = await buildEntry(opts);
    events.push(entry);       // single mutation, only after full success
    seenEventIds.add(entry.eventId);
    tailHash = entry.entryHash;
    return entry;
  }

  // Restore from a saved snapshot (restart persistence). Validates the whole
  // chain + tail + eventId uniqueness; refuses broken state. Reconstructs
  // events + dedup set in memory.
  function restore(saved) {
    if (!saved || !Array.isArray(saved.events)) throw new Error('journal writer: cannot restore — no events');
    if (String(saved.commitmentId).toLowerCase() !== commitmentId.toLowerCase()) throw new Error('journal writer: restore commitmentId mismatch');
    if (String(saved.manifestHash).toLowerCase() !== manifestHash.toLowerCase()) throw new Error('journal writer: restore manifestHash mismatch');
    const v = validateChain(saved.events);
    if (!v.ok) throw new Error('journal writer: restore refused — ' + v.why);
    if (saved.tailHash !== undefined && saved.tailHash !== v.tail) throw new Error('journal writer: restore refused — declared tailHash mismatch');
    events.length = 0;
    seenEventIds.clear();
    for (const ev of saved.events) {
      events.push(JSON.parse(JSON.stringify(ev)));
      seenEventIds.add(ev.eventId);
    }
    tailHash = v.tail;
    return true;
  }

  function snapshot() {
    return {
      domain: signatures.journalDomain(custodyAddress, chainId),
      commitmentId, manifestHash, chainId, custodyAddress,
      root: events.length ? events[0].entryHash : null,
      tailHash, events: JSON.parse(JSON.stringify(events)),
    };
  }

  function count() { return events.length; }

  return { append, restore, snapshot, currentTail, count };
}

module.exports = {
  createJournalWriter,
  JOURNAL_TRANSITION_AUTHORITY,
  CONFIRMED_TRANSITIONS,
  INTENT_TRANSITIONS,
  EVALUATOR_TRANSITIONS,
  MUTUAL_TRANSITIONS,
  canonicalEvidence,
  eventIdOf,
  entryHashOf,
  canonicalEntryFields,
  validateChain,
  sha256Hex,
};