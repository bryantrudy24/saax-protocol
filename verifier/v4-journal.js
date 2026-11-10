'use strict';
/**
 * Independent v4 journal verification (Phase B).
 *
 * Verifies the Phase A journal record (hash chain only, design doc §2 option A)
 * produced by the shared writer (mainnet/design/support/v4-journal-writer.js).
 *
 * INDEPENDENCE BOUNDARY:
 *  - This module does NOT import the writer's pass/fail judgment. It imports
 *    ONLY pure canonicalization primitives from the writer's module
 *    (canonicalEntryFields, entryHashOf, canonicalEvidence, eventIdOf, and the
 *    v4-derived authority map constants) and performs every verification step
 *    itself: strict schema, chain walking, signature recovery, role/authority
 *    checks, coverage checks and terminal consistency.
 *  - Explicit test vectors (scripts/test-v4-journal-verify.cjs) recompute the
 *    first-entry hashes inline with independent crypto to reduce shared-bug
 *    risk between writer and verifier.
 *
 * ASSURANCE BOUNDARY (what a valid journal establishes):
 *  - Authenticated association: first entry binds commitmentId + manifestHash
 *    to the signed agreement; head/tail authenticated under the v4 journal
 *    domain (SAAX Commitment Journal / "4", chainId = agreement custody chain,
 *    verifyingContract = agreement custody address — NEVER inferred from
 *    formatVersion, NOT v3's domain).
 *  - Tamper evidence: hash chain detects changes relative to the
 *    authenticated head.
 *  - Bounded lifecycle coverage: required confirmed entries (issue/funded/
 *    settlement) are checked against the supported on-chain flow. This is NOT
 *    universal completeness: it does not establish that the journal contains
 *    EVERYTHING the agreement expected, and it does not prevent an authorized
 *    signer from creating an alternative history from the checkpoint.
 *
 * What a valid journal does NOT establish (limitations returned):
 *  - Completeness of off-chain history / absence of alternative authorized
 *    history.
 *  - Truth or sufficiency of fulfillment evidence.
 *  - Approved 2-of-3 Safe governance (ERC-1271 execution success is a bounded
 *    witness only).
 *  - Public-chain finality.
 *
 * OBSERVED vs AUTHORITY (brief §3):
 *  - An observer signature authenticates an observation, NOT action
 *    authority. For observed entries, `by` must be the actual on-chain
 *    authorizing party (recoveredSigner), `submitter` (tx.from, possibly a
 *    relayer) is recorded separately, and the writer's attestation signature
 *    (recovered to signedBy) is never treated as the action's authority.
 *  - tx.from is never treated as the evaluator; exported recoveredSigner
 *    metadata is bound via evidenceDigest and cross-checked, not trusted.
 *  - Buyer OR seller may initiate dispute where the contract supports it.
 *  - Mutual resolution requires BOTH parties' signatures.
 *  - Evaluator resolution (release/refund) uses ERC-1271 / Safe authority
 *    evidenced on-chain; the journal attests the record, not the authority.
 *  - Timeout refund has NO evaluator authority: role 'open', recipient fixed
 *    by the contract (original buyer), eligible at/after final cutoff.
 *  - Unavailable required chain evidence => JournalIncomplete (INCOMPLETE/
 *    UNSUPPORTED), never a passed check.
 */

'use strict';
const { ethers } = require('ethers');
const sig = require('../mainnet/design/support/v4-signatures');
const writer = require('../mainnet/design/support/v4-journal-writer');

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const ZERO32 = '0x' + '00'.repeat(32);

class JournalIncomplete extends Error {}
const need = (ok, why) => { if (!ok) throw new Error('journal: ' + why); };
const incomp = why => { throw new JournalIncomplete('journal: ' + why); };

// Strict schema: the exact key sets the writer emits. Unknown fields are
// rejected (a rogue field must never silently join the hash input).
const JOURNAL_KEYS = new Set(['domain', 'commitmentId', 'manifestHash', 'chainId', 'custodyAddress', 'root', 'tailHash', 'events']);
const ENTRY_KEYS = new Set([
  'commitmentId', 'manifestHash', 'transition', 'role', 'by',
  'contractAction', 'resultingState', 'at', 'observed', 'prevHash',
  'evidenceDigest', 'entryHash', 'eventId', 'sigs', 'signedBy',
  'recoveredSigner', 'submitter', 'txHash', 'blockHash', 'authorization',
]);
const DOMAIN_KEYS = new Set(['name', 'version', 'chainId', 'verifyingContract']);
const SIG_KEYS = new Set(['v', 'r', 's']);

const isAddress = v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isBytes32 = v => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

// ---- strict schema -----------------------------------------------------------
function checkJournalSchema(j) {
  need(j && typeof j === 'object' && !Array.isArray(j), 'journal record required');
  for (const k of Object.keys(j)) need(JOURNAL_KEYS.has(k), 'unknown journal field: ' + k);
  const d = j.domain;
  need(d && typeof d === 'object', 'journal domain required');
  for (const k of Object.keys(d)) need(DOMAIN_KEYS.has(k), 'unknown journal domain field: ' + k);
  need(isBytes32(j.commitmentId), 'journal commitmentId must be bytes32');
  need(isBytes32(j.manifestHash), 'journal manifestHash must be bytes32');
  need(Number.isInteger(j.chainId) && j.chainId > 0, 'journal chainId must be a positive integer');
  need(isAddress(j.custodyAddress), 'journal custodyAddress must be a valid address');
  need(isBytes32(j.root), 'journal root must be bytes32');
  need(isBytes32(j.tailHash), 'journal tailHash must be bytes32');
  need(Array.isArray(j.events) && j.events.length >= 1, 'journal must contain at least one event');
  for (let i = 0; i < j.events.length; i++) {
    const e = j.events[i];
    need(e && typeof e === 'object' && !Array.isArray(e), 'event ' + i + ' must be an object');
    for (const k of Object.keys(e)) need(ENTRY_KEYS.has(k), 'unknown journal entry field ' + k + ' at ' + i);
    need(isBytes32(e.commitmentId) && eq(e.commitmentId, j.commitmentId), 'event ' + i + ' commitmentId mismatch');
    need(isBytes32(e.manifestHash) && eq(e.manifestHash, j.manifestHash), 'event ' + i + ' manifestHash mismatch');
    need(typeof e.transition === 'string' && e.transition.length > 0, 'event ' + i + ' transition required');
    need(typeof e.role === 'string' && e.role.length > 0, 'event ' + i + ' role required');
    need(isAddress(e.by), 'event ' + i + ' by must be a valid address');
    need(typeof e.contractAction === 'string' && e.contractAction.length > 0, 'event ' + i + ' contractAction required');
    need(typeof e.resultingState === 'string' && e.resultingState.length > 0, 'event ' + i + ' resultingState required');
    need(typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)), 'event ' + i + ' at must be an ISO timestamp');
    need(typeof e.observed === 'boolean', 'event ' + i + ' observed must be boolean');
    need(isBytes32(e.prevHash), 'event ' + i + ' prevHash must be bytes32');
    need(isBytes32(e.evidenceDigest), 'event ' + i + ' evidenceDigest must be bytes32');
    need(isBytes32(e.entryHash), 'event ' + i + ' entryHash must be bytes32');
    need(isBytes32(e.eventId), 'event ' + i + ' eventId must be bytes32');
    need(Array.isArray(e.sigs) && e.sigs.length >= 1, 'event ' + i + ' requires at least one signature');
    for (const s of e.sigs) {
      need(s && typeof s === 'object', 'event ' + i + ' malformed signature');
      for (const k of Object.keys(s)) need(SIG_KEYS.has(k), 'event ' + i + ' unknown signature field ' + k);
      need(Number.isInteger(s.v) && [0, 1, 27, 28].includes(s.v), 'event ' + i + ' invalid recovery id');
      need(/^0x[0-9a-fA-F]{64}$/.test(s.r) && /^0x[0-9a-fA-F]{64}$/.test(s.s), 'event ' + i + ' invalid r/s');
    }
    need(typeof e.signedBy === 'string' && e.signedBy.length > 0, 'event ' + i + ' signedBy required');
    if (e.recoveredSigner !== undefined) need(isAddress(e.recoveredSigner), 'event ' + i + ' recoveredSigner must be an address');
    if (e.submitter !== undefined) need(isAddress(e.submitter), 'event ' + i + ' submitter must be an address');
    if (e.txHash !== undefined) need(isBytes32(e.txHash), 'event ' + i + ' txHash must be bytes32');
    if (e.blockHash !== undefined) need(isBytes32(e.blockHash), 'event ' + i + ' blockHash must be bytes32');
    if (e.authorization !== undefined) need(e.authorization && typeof e.authorization === 'object' && !Array.isArray(e.authorization), 'event ' + i + ' authorization must be an object');
    if (e.observed) {
      need(isAddress(e.recoveredSigner), 'observed event ' + i + ' requires recoveredSigner (actual authorizing party)');
      need(isBytes32(e.txHash) && isBytes32(e.blockHash), 'observed event ' + i + ' requires txHash and blockHash');
    }
  }
}

// ---- signature recovery -------------------------------------------------------
function recoverEntrySigners(j, e) {
  const msg = {
    commitmentId: e.commitmentId, manifestHash: e.manifestHash, transition: e.transition,
    role: e.role, by: e.by, contractAction: e.contractAction, resultingState: e.resultingState,
    at: e.at, observed: e.observed, prevHash: e.prevHash, entryHash: e.entryHash,
    evidenceDigest: e.evidenceDigest,
  };
  const d = {
    name: j.domain.name, version: j.domain.version, chainId: j.domain.chainId,
    verifyingContract: j.domain.verifyingContract,
  };
  const recovered = [];
  const seen = [];
  for (const s of e.sigs) {
    const rec = ethers.verifyTypedData(d, sig.JOURNAL_EVENT_V4_TYPES, msg, { v: s.v, r: s.r, s: s.s });
    recovered.push(rec);
    if (seen.includes(rec.toLowerCase())) throw new Error('journal: duplicate signer at event ' + e.transition);
    seen.push(rec.toLowerCase());
  }
  return recovered.map(a => a.toLowerCase());
}

// ---- the verifier ------------------------------------------------------------
/**
 * ctx: {
 *   digest32,            // bytes32 commitment digest (from the committed envelope)
 *   outcome,             // 'release' | 'refund' (independently checked on-chain)
 *   mechanism,           // 'evaluator' | 'mutual' | 'timeout'
 *   recipient,           // seller for release, buyer for refund (fixed beneficiaries)
 *   fundTime, settleTime,// BigInt unix seconds from on-chain blocks
 *   resolution, cutoff,  // BigInt signed deadlTimes
 *   lifecycle,           // boolean: true when export claims full lifecycle
 *   lifecycleRefs,       // { funding: {txHash, blockHash}, settlement: {txHash, blockHash} }
 * }
 */
function verifyJournal(exp, ctx) {
  const checks = [];
  const pass = n => checks.push(n);
  const m = exp.agreement;
  const j = exp.journal;
  let legacyFallbackUsed = false;

  if (!j) {
    if (ctx.lifecycle) incomp('journal record required for lifecycle export');
    return { checked: false, checks, notes: ['No journal record supplied: no journal association or tamper-evidence assurance.'], limitations: [] };
  }

  // 1. strict schema
  checkJournalSchema(j);
  pass('journal strict schema and supported record shape');

  // 2. domain binding (agreement-derived, NOT formatVersion)
  need(typeof j.domain.name === 'string' && j.domain.version === '4', 'unsupported journal domain/version');
  need(j.domain.name === sig.JOURNAL_DOMAIN_NAME, 'journal domain name mismatch');
  need(Number(j.domain.chainId) === m.custody.chainId, 'journal domain chainId != signed agreement chain');
  need(eq(j.domain.verifyingContract, m.custody.custodyAddress), 'journal domain verifyingContract != signed custody');
  pass('agreement-bound journal signing domain (chain, custody, name, version)');

  // 3. agreement binding (authenticated association)
  need(eq(j.commitmentId, m.commitmentId), 'journal commitmentId != signed agreement');
  need(eq(j.manifestHash, ctx.digest32), 'journal manifestHash != committed envelope digest');
  need(Number(j.chainId) === m.custody.chainId, 'journal chainId != signed agreement chain');
  need(eq(j.custodyAddress, m.custody.custodyAddress), 'journal custodyAddress != signed custody');
  pass('journal authenticated association to signed agreement (commitmentId + manifestHash)');

  // 4. chain walk: hashes, links, evidenceDigest, eventId, monotonic at
  let tail = ZERO32;
  const seenIds = new Set();
  const atVals = [];
  for (let i = 0; i < j.events.length; i++) {
    const e = j.events[i];
    // predecessor link
    need(eq(e.prevHash, tail), 'broken journal link at ' + i + ' (prevHash != prior tail)');
    // canonical entry hash
    const expectedHash = writer.entryHashOf(writer.canonicalEntryFields(e));
    need(eq(e.entryHash, expectedHash), 'journal entryHash mismatch at ' + i);
    // canonical evidence digest recomputed from the supplied evidence. Entry
    // refs take precedence; legacy entries (pre-writer-fix) that did not store
    // their tx refs bind the independently-verified lifecycle reference for the
    // matching transition — the same evidence the on-chain checks established.
    let evTx = e.txHash, evBlock = e.blockHash;
    const usedFallback = !e.txHash && ctx.lifecycleRefs && (e.transition === 'funded' || ['release', 'refund', 'mutual-release', 'mutual-refund', 'timeout-refund'].includes(e.transition));
    if (!e.txHash && ctx.lifecycleRefs) {
      if (e.transition === 'funded') {
        // ambiguous/absent funding ref class: reject cleanly, never crash.
        const fr = ctx.lifecycleRefs.funding;
        if (!fr || !fr.txHash || !fr.blockHash) incomp('legacy funded entry requires a funding lifecycle reference (funding class absent from the independently verified lifecycle refs)');
        evTx = fr.txHash; evBlock = fr.blockHash;
      }
      else if (['release', 'refund', 'mutual-release', 'mutual-refund', 'timeout-refund'].includes(e.transition)) {
        const sr = ctx.lifecycleRefs.settlement;
        if (!sr || !sr.txHash || !sr.blockHash) incomp('legacy ' + e.transition + ' entry requires a settlement lifecycle reference (settlement class absent from the independently verified lifecycle refs)');
        evTx = sr.txHash; evBlock = sr.blockHash;
      }
    }
    if (usedFallback) legacyFallbackUsed = true;
    const expectedEv = writer.canonicalEvidence({
      chainId: j.chainId, custodyAddress: j.custodyAddress,
      txHash: evTx, blockHash: evBlock,
      authorization: e.authorization, submitter: e.submitter,
    });
    need(eq(e.evidenceDigest, expectedEv), 'journal evidenceDigest mismatch at ' + i + ' (evidence reference tampered)');
    // stable event identity, unique. Legacy initiated entries bound their
    // eventId to the same tx refs (see evidenceDigest fallback above).
    const eid = writer.eventIdOf({ commitmentId: e.commitmentId, transition: e.transition, role: e.role, by: e.by, contractAction: e.contractAction, resultingState: e.resultingState, txHash: evTx });
    need(eq(e.eventId, eid), 'journal eventId mismatch at ' + i);
    if (seenIds.has(e.eventId)) throw new Error('journal: duplicate eventId at ' + i + ' (identical logical event recorded twice)');
    seenIds.add(e.eventId);
    const at = Date.parse(e.at);
    if (atVals.length && at < atVals[atVals.length - 1]) throw new Error('journal: non-monotonic at at ' + i);
    atVals.push(at);
    tail = e.entryHash;
  }
  need(eq(j.root, j.events[0].entryHash), 'journal root != first entry hash');
  need(eq(j.tailHash, tail), 'journal tailHash != last entry hash');
  pass('journal hash chain, predecessor links, evidenceDigest and stable event identities');

  // 5. per-entry signature recovery + role authority (v4-derived map)
  const confirmed = [];
  for (let i = 0; i < j.events.length; i++) {
    const e = j.events[i];
    const recovered = recoverEntrySigners(j, e);
    // record authenticity: recovered signer set must equal signedBy
    const signedByIds = String(e.signedBy).toLowerCase().split('+').map(s => s.trim());
    need(recovered.length === signedByIds.length && recovered.every((a, k) => a === signedByIds[k].toLowerCase()), 'journal signature does not recover to signedBy at ' + i);
    const authority = writer.JOURNAL_TRANSITION_AUTHORITY[e.transition];
    if (!authority) throw new Error('journal: unsupported transition "' + e.transition + '" at ' + i);

    if (e.transition === 'intent') {
      // accepted intent — never a confirmed transition
      need(e.resultingState === 'Accepted' || /^intent:/i.test(e.resultingState), 'journal intent entry must mark intent at ' + i);
      continue;
    }
    confirmed.push(e);

    if (['issue', 'funded'].includes(e.transition)) {
      need(e.role === 'buyer', 'journal ' + e.transition + ' requires role buyer at ' + i);
      need(eq(e.by, m.buyerAgentId), 'journal ' + e.transition + ' by != agreement buyer at ' + i);
      need(recovered.length === 1 && eq(recovered[0], m.buyerAgentId), 'journal ' + e.transition + ' signature must recover to the buyer at ' + i);
    } else if (e.transition === 'dispute') {
      need(e.role === 'buyer' || e.role === 'seller', 'journal dispute requires role buyer or seller at ' + i);
      const party = e.role === 'buyer' ? m.buyerAgentId : m.sellerAgentId;
      need(eq(e.by, party), 'journal dispute by != agreement ' + e.role + ' at ' + i);
      need(recovered.length === 1 && eq(recovered[0], party), 'journal dispute signature must recover to the ' + e.role + ' at ' + i);
    } else if (e.transition === 'release' || e.transition === 'refund') {
      // evaluator (incl. disputed resolution)
      need(e.role === 'evaluator', 'journal ' + e.transition + ' requires role evaluator at ' + i);
      need(eq(e.by, m.evaluator), 'journal ' + e.transition + ' by != agreement evaluator at ' + i);
      need(Array.isArray(m.evaluatorPermittedDecisions) && m.evaluatorPermittedDecisions.includes(e.transition), 'journal evaluator ' + e.transition + ' not within evaluatorPermittedDecisions at ' + i);
      need(e.authorization && typeof e.authorization === 'object' && (e.authorization.kind || e.authorization.note), 'journal evaluator ' + e.transition + ' requires on-chain authorization evidence at ' + i);
      // writer attests the record; authority is the on-chain execution
      // (already checked independently in verify-v4). The recovered signer is
      // the ATTESTER, not the evaluator — this must never be read as the
      // evaluator's own signature.
      need(recovered.length >= 1, 'journal evaluator ' + e.transition + ' requires an attesting signature at ' + i);
      if (recovered.some(a => eq(a, m.evaluator))) throw new Error('journal: evaluator entry signed BY the evaluator address — unsupported signature mechanism (contract wallet cannot produce a raw EOA sig) at ' + i);
    } else if (e.transition === 'mutual-release' || e.transition === 'mutual-refund') {
      // both parties
      need(e.role === 'buyer+seller', 'journal ' + e.transition + ' requires role buyer+seller at ' + i);
      need(recovered.length === 2, 'journal ' + e.transition + ' requires exactly two signatures at ' + i);
      const parties = [m.buyerAgentId.toLowerCase(), m.sellerAgentId.toLowerCase()];
      need(parties.includes(e.by.toLowerCase()), 'journal ' + e.transition + ' by must be buyer or seller at ' + i);
      need(recovered.every(a => parties.includes(a)) && recovered.length === new Set(recovered).size, 'journal ' + e.transition + ' must be signed by BOTH agreement parties at ' + i);
    } else if (e.transition === 'timeout-refund') {
      // no evaluator authority; fixed beneficiary = original buyer; at/after cutoff
      need(e.role === 'open', 'journal timeout-refund requires role open at ' + i);
      need(eq(e.by, m.buyerAgentId), 'journal timeout-refund by != fixed beneficiary (original buyer) at ' + i);
      const atSec = BigInt(Math.floor(Date.parse(e.at) / 1000));
      need(atSec >= ctx.cutoff, 'journal timeout-refund before final cutoff at ' + i);
      // allowed to be initiated/observed by anyone; sig is the writer attestation
    } else {
      throw new Error('journal: unsupported transition "' + e.transition + '" at ' + i);
    }
  }
  pass('journal signatures recover to role identities and v4 transition authority');

  // 6. observed entries: observer sig authenticates the observation, not authority
  for (let i = 0; i < j.events.length; i++) {
    const e = j.events[i];
    if (!e.observed) continue;
    // by must be the actual authorizing party recovered from the on-chain action
    need(eq(e.by, e.recoveredSigner), 'observed event ' + i + ': by != recovered authorizing signer (authorizer must be the on-chain party, not the submitter)');
    // submitter is tx.from (may be a relayer) — distinct from authorizer
    if (e.submitter !== undefined && !eq(e.submitter, e.recoveredSigner)) {
      // relayer case: submitter != authorizer — OK, but never treat tx.from as authorizer
      pass('observed event ' + i + ': relayer (submitter) distinct from authorizing party');
    } else if (e.submitter !== undefined && eq(e.submitter, e.recoveredSigner)) {
      // same account submitted and authorized — fine
    }
    // the recovered journal signer (writer attestation) must NOT be presented as the action's authorizer
    const recovered = recoverEntrySigners(j, e);
    for (const r of recovered) need(!eq(r, e.recoveredSigner), 'observed event ' + i + ': observer signature substituted for action authority');
    if (e.transition === 'release' || e.transition === 'refund') {
      need(eq(e.by, m.evaluator), 'observed evaluator event ' + i + ': by != agreement evaluator');
      need(e.authorization, 'observed evaluator event ' + i + ' requires authorization evidence');
    }
  }
  pass('observed entries: observer signature authenticates the observation, not the action authority');

  // 7. intent vs confirmed: required lifecycle coverage (bounded, not completeness)
  if (ctx.lifecycle) {
    const trans = new Set(confirmed.map(e => e.transition));
    const required = ['issue', 'funded'];
    const missing = required.filter(t => !trans.has(t));
    if (missing.length) incomp('journal missing required confirmed entr' + (missing.length > 1 ? 'ies' : 'y') + ': ' + missing.join(', ') + ' (intent does not satisfy confirmed lifecycle coverage)');
    const settled = confirmed.filter(e => ['release', 'refund', 'mutual-release', 'mutual-refund', 'timeout-refund'].includes(e.transition));
    if (settled.length === 0) incomp('journal missing settlement transition (release/refund/mutual/timeout)');
    if (settled.length > 1) throw new Error('journal: multiple settlement transitions (competing resolutions)');
    pass('journal bounded lifecycle coverage: issue + funded + settlement confirmed (intent excluded)');
  }

  // 8. on-chain reference cross-check: journal transaction/block refs must match
  //    the independently verified lifecycle references (correct chain, custody,
  //    transaction, block, successful execution).
  if (ctx.lifecycleRefs) {
    for (let i = 0; i < j.events.length; i++) {
      const e = j.events[i];
      if (!e.txHash) continue;
      if (e.transition === 'funded') {
        need(eq(e.txHash, ctx.lifecycleRefs.funding.txHash) && eq(e.blockHash, ctx.lifecycleRefs.funding.blockHash), 'journal funded entry does not reference the verified funding transaction at ' + i);
      } else if (['release', 'refund', 'mutual-release', 'mutual-refund', 'timeout-refund'].includes(e.transition)) {
        need(eq(e.txHash, ctx.lifecycleRefs.settlement.txHash) && eq(e.blockHash, ctx.lifecycleRefs.settlement.blockHash), 'journal settlement entry does not reference the verified settlement transaction at ' + i);
      }
    }
    pass('journal transaction/block references match the independently verified on-chain lifecycle');
  }

  // 9. terminal consistency with independently checked custody execution
  if (ctx.lifecycle && ctx.outcome) {
    const terminal = confirmed[confirmed.length - 1];
    const expectedState = ctx.outcome === 'release' ? 'Released' : 'Refunded';
    need(terminal.resultingState === expectedState, 'journal terminal state ' + terminal.resultingState + ' != escrow terminal state ' + expectedState + ' (outcome ' + ctx.outcome + ')');
    // mechanism consistency
    if (ctx.mechanism === 'timeout') need(terminal.transition === 'timeout-refund', 'journal terminal transition ' + terminal.transition + ' != escrow mechanism timeout-refund');
    if (ctx.mechanism === 'evaluator') need(['release', 'refund'].includes(terminal.transition), 'journal terminal transition ' + terminal.transition + ' != escrow evaluator mechanism');
    if (ctx.mechanism === 'mutual') need(['mutual-release', 'mutual-refund'].includes(terminal.transition), 'journal terminal transition ' + terminal.transition + ' != escrow mutual mechanism');
    // fixed beneficiary consistency. Only timeout-refund has a contract-fixed
    // beneficiary recorded as `by` (the original buyer; role 'open'). Evaluator
    // entries' `by` is the evaluator (authorizing party) and mutual entries'
    // `by` is buyer or seller — both already checked in the authority section;
    // the actual payout recipient is established by the independently checked
    // on-chain execution (token movement to outcome's fixed beneficiary).
    if (terminal.transition === 'timeout-refund') {
      need(eq(terminal.by, m.buyerAgentId), 'journal terminal beneficiary mismatch (timeout must refund the original buyer)');
    }
    pass('journal terminal consistency with independently checked custody execution');
  }

  return {
    checked: true,
    checks,
    notes: legacyFallbackUsed
      ? ['Legacy lifecycle-ref fallback used: one or more journal entries did not store their transaction/block references; the independently verified lifecycle references (funding/settlement) were bound for the evidence digest. This anchors the submitted history relative to the verified on-chain references; it does not independently prove the missing references or completeness of the journal.']
      : [],
    legacyFallbackUsed,
    entries: j.events.length,
    terminal: confirmed.length ? confirmed[confirmed.length - 1] : null,
    root: j.root,
    head: j.events[0].entryHash,
    tail: j.tailHash,
    limitations: [
      'Journal verification establishes authenticated association and tamper evidence relative to its binding/checkpoint.',
      'It does NOT establish completeness of off-chain history, absence of an alternative authorized history, truth/sufficiency of fulfillment evidence, approved 2-of-3 Safe governance, or public-chain finality.',
      'Bounded lifecycle coverage: only events the supported on-chain flow can establish are checked; missing required entries are reported.',
    ],
  };
}

module.exports = {
  verifyJournal,
  JournalIncomplete,
  checkJournalSchema,
  recoverEntrySigners,
  JOURNAL_KEYS,
  ENTRY_KEYS,
};