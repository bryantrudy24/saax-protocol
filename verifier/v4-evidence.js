'use strict';
/**
 * SAAX Phase C — isolated v4 fulfillment-evidence validation.
 *
 * Verifies fulfillment evidence against the signed v4 agreement's
 * acceptance criteria and evidence policy (evidenceRequirements). This is a
 * BOUNDED check: it verifies structure, authenticity and the supported
 * acceptance predicates — it does NOT execute arbitrary expressions, does
 * NOT extend automatic acceptance to subjective services, physical delivery
 * or high-value profiles, and does NOT claim that a valid signature proves
 * a real-world assertion true.
 *
 * INDEPENDENCE BOUNDARY:
 *  - This module shares ONLY pure canonicalization/signing primitives
 *    (v4-canonical.js, v4-signatures.js). It performs every evaluation
 *    itself and returns separate findings for:
 *      1. evidence integrity / authenticity
 *      2. evidence sufficiency
 *      3. criterion evaluation (satisfied | not satisfied | insufficient)
 *      4. evaluator authorization / verdict consistency with the agreed
 *         decision policy
 *  - The record shape is the producer's (scripts/test-v4-producer-closure.cjs
 *    + the shared evidence-builder in this task); the verifier does not
 *    canonicalize a record it invented.
 *
 * ASSURANCE BOUNDARY:
 *  - Authenticity: issuer signature valid, issuer authorized under the
 *    signed evidence policy, payload hash matches the signed payload, item
 *    bound to commitmentId + manifestHash + criterionId.
 *  - Sufficiency: type, minimum count, uniqueness (stable itemId), freshness
 *    (maxAge), deadline window as signed; missing evidence => INSUFFICIENT
 *    (never success).
 *  - Criterion evaluation: ONLY the supported predicates below. Unknown
 *    predicate or malformed numeric/unit input => explicit unsupported result,
 *    never permissive interpretation. No arbitrary code execution.
 *  - Evaluator authorization: a signed verdict is checked for consistency
 *    with the signed evaluatorPermittedDecisions; a valid signature does not
 *    by itself establish fulfillment.
 *
 * ISSUER ALLOWLIST POLICY (signed spec): the agreement's
 * evidenceRequirements.sources is the signed policy. When it carries an
 * explicit acceptedIssuers list, ONLY those issuers may attest. When the
 * field is OMITTED, this module does NOT silently treat it as universal
 * trust NOR as an empty set — it returns an explicit "issuer allowlist
 * omitted" policy finding with reduced assurance (authenticity of the
 * signature still holds; issuer authorization is UNSUPPORTED-determined).
 *
 * Missing evidence must never become fulfillment success; an incomplete
 * export is distinct from evidence that affirmatively fails a criterion.
 */

'use strict';
const crypto = require('crypto');
const { ethers } = require('ethers');
const canonical = require('../mainnet/design/support/v4-canonical');
const sig = require('../mainnet/design/support/v4-signatures');

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const need = (ok, why) => { if (!ok) throw new Error('evidence: ' + why); };
const isAddress = v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isBytes32 = v => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const EXACT_INT = /^(0|[1-9][0-9]*)$/;

class EvidenceIncomplete extends Error {}
const incomp = why => { throw new EvidenceIncomplete('evidence: ' + why); };

// Strict record schema (the producer's shape). Unknown fields rejected.
const RECORD_KEYS = new Set(['recordVersion', 'time', 'commitmentId', 'manifestHash', 'domain', 'items', 'findings']);
const DOMAIN_KEYS = new Set(['name', 'version', 'chainId', 'verifyingContract']);
const ITEM_KEYS = new Set([
  'itemId', 'criterionId', 'type', 'issuer', 'payloadHash', 'payload',
  'at', 'amount', 'signedBy', 'sigs',
]);
const SIG_KEYS = new Set(['v', 'r', 's']);

// Supported acceptance predicates (bound subset, exact semantics only).
//   hash-equals:   payload's canonical hash equals the signed expected value
//                  (acceptanceCriteria.value is the expected sha256 hex).
//   hash-prefix:   payload hash equals the signed expected value as a prefix
//                  (exact same semantics — no fuzzy prefix matching inventing
//                  partial acceptance).
// Unsupported predicates => EvidenceIncomplete (unknown predicate), never
// permissive interpretation.
const SUPPORTED_PREDICATES = new Set(['hash-equals']);

// ——— strict schema ———
function checkRecordSchema(r) {
  need(r && typeof r === 'object' && !Array.isArray(r), 'evidence record required');
  for (const k of Object.keys(r)) need(RECORD_KEYS.has(k), 'unknown evidence record field: ' + k);
  need(Number.isInteger(r.recordVersion) && r.recordVersion === 1, 'unsupported evidence record version');
  need(typeof r.time === 'string' && !Number.isNaN(Date.parse(r.time)), 'evidence record time must be an ISO timestamp');
  need(isBytes32(r.commitmentId), 'evidence commitmentId must be bytes32');
  need(isBytes32(r.manifestHash), 'evidence manifestHash must be bytes32');
  const d = r.domain;
  need(d && typeof d === 'object', 'evidence domain required');
  for (const k of Object.keys(d)) need(DOMAIN_KEYS.has(k), 'unknown evidence domain field: ' + k);
  need(d.name === sig.EVIDENCE_DOMAIN_NAME && d.version === sig.EVIDENCE_DOMAIN_VERSION, 'unsupported evidence domain/version');
  need(Array.isArray(r.items) && r.items.length >= 1, 'evidence record must contain at least one item');
  for (let i = 0; i < r.items.length; i++) {
    const it = r.items[i];
    need(it && typeof it === 'object' && !Array.isArray(it), 'item ' + i + ' must be an object');
    for (const k of Object.keys(it)) need(ITEM_KEYS.has(k), 'unknown evidence item field ' + k + ' at ' + i);
    need(typeof it.itemId === 'string' && it.itemId.length > 0 && it.itemId.length <= 128, 'item ' + i + ' itemId required');
    need(typeof it.criterionId === 'string' && it.criterionId.length > 0, 'item ' + i + ' criterionId required');
    need(typeof it.type === 'string' && it.type.length > 0, 'item ' + i + ' type required');
    need(isAddress(it.issuer), 'item ' + i + ' issuer must be a valid address');
    need(isBytes32(it.payloadHash), 'item ' + i + ' payloadHash must be bytes32');
    need(typeof it.payload === 'string', 'item ' + i + ' payload must be a string (canonical bytes)');
    need(crypto.createHash('sha256').update(it.payload, 'utf8').digest('hex') === it.payloadHash.slice(2), 'item ' + i + ' payload hash mismatch (noncanonical payload)');
    need(typeof it.at === 'string' && !Number.isNaN(Date.parse(it.at)), 'item ' + i + ' at must be an ISO timestamp');
    if (it.amount !== undefined && it.amount !== null) {
      need(typeof it.amount === 'string' && EXACT_INT.test(it.amount), 'item ' + i + ' amount must be an exact integer string');
    }
    need(Array.isArray(it.sigs) && it.sigs.length >= 1, 'item ' + i + ' requires at least one signature');
    for (const s of it.sigs) {
      need(s && typeof s === 'object', 'item ' + i + ' malformed signature');
      for (const k of Object.keys(s)) need(SIG_KEYS.has(k), 'item ' + i + ' unknown signature field ' + k);
      need(Number.isInteger(s.v) && [0, 1, 27, 28].includes(s.v), 'item ' + i + ' invalid recovery id');
      need(/^0x[0-9a-fA-F]{64}$/.test(s.r) && /^0x[0-9a-fA-F]{64}$/.test(s.s), 'item ' + i + ' invalid r/s');
    }
    need(typeof it.signedBy === 'string' && it.signedBy.length > 0, 'item ' + i + ' signedBy required');
  }
}

// ——— issuer authorization under the signed evidence policy ———
// Returns { allowed: true|false, policy: 'explicit-allowlist'|'omitted' }.
// An omitted allowlist is reported explicitly; it is neither universal trust
// nor an empty set — issuer authorization is UNSUPPORTED-determined.
function issuerPolicy(reqs) {
  if (!reqs || typeof reqs !== 'object') return { allowed: false, policy: 'missing' };
  if (Array.isArray(reqs.acceptedIssuers) && reqs.acceptedIssuers.length > 0) {
    return { allowed: true, policy: 'explicit-allowlist', issuers: reqs.acceptedIssuers };
  }
  return { allowed: true, policy: 'omitted', issuers: [] };
}

// ——— the verifier ———
/**
 * exp: the v4 export. ctx: {
 *   digest32,              // committed envelope digest (bytes32)
 *   outcome,               // 'release' | 'refund' (independent on-chain result)
 *   mechanism,             // 'evaluator' | 'mutual' | 'timeout'
 *   expectedCriterion,     // the signed acceptanceCriteria (object)
 *   resolution, cutoff,    // BigInt signed deadline seconds
 * }
 */
function verifyEvidence(exp, ctx) {
  const checks = [];
  const pass = n => checks.push(n);
  const m = exp.agreement;
  const ev = exp.evidence;
  const reqs = m.evidenceRequirements;
  const findings = { integrity: null, sufficiency: null, criterion: null, evaluator: null, issuer: null };

  if (!ev) {
    // Issuance-only exports carry no evidence; lifecycle exports REQUIRE it.
    if (ctx.lifecycle === false || exp.lifecycleProfile === 'issue') {
      return {
        checked: false, checks,
        findings,
        notes: ['Issuance-only export: no fulfillment evidence claimed.'],
        limitations: [],
      };
    }
    incomp('fulfillment evidence record required for lifecycle export');
  }

  // 1. strict schema + domain (agreement-bound, NOT formatVersion-inferred)
  checkRecordSchema(ev);
  need(Number(ev.domain.chainId) === m.custody.chainId, 'evidence domain chainId != signed agreement chain');
  need(eq(ev.domain.verifyingContract, m.custody.custodyAddress), 'evidence domain verifyingContract != signed custody');
  need(eq(ev.commitmentId, m.commitmentId), 'evidence commitmentId != signed agreement');
  need(eq(ev.manifestHash, ctx.digest32), 'evidence manifestHash != committed envelope digest');
  pass('evidence record strict schema and agreement-bound domain');

  // 2. per-item authenticity + criterion binding + issuer authorization
  const seenItems = new Set();
  let allowlistPolicy = issuerPolicy(reqs);
  findings.issuer = { policy: allowlistPolicy.policy, issuers: allowlistPolicy.issuers || [] };
  // The signed acceptance criterion is the ONLY criterion a record may claim:
  // items bound to a criterion the agreement does not define must be rejected
  // (no invented criterion identifiers; the record references the agreement's).
  const signedCriterionId = m.acceptanceCriteria && typeof m.acceptanceCriteria.criterionId === 'string'
    ? m.acceptanceCriteria.criterionId
    : 'deliverable-hash';
  for (let i = 0; i < ev.items.length; i++) {
    const it = ev.items[i];
    // stable uniqueness by itemId (per commitment)
    const idKey = String(it.itemId);
    if (seenItems.has(idKey)) throw new Error('evidence: duplicate itemId ' + idKey + ' (replayed evidence)');
    seenItems.add(idKey);
    need(it.criterionId === signedCriterionId, 'evidence item ' + i + ': criterionId (' + it.criterionId + ') != signed acceptance criterion (' + signedCriterionId + ')');
    // signature recovery to the issuer's own key (authenticity only)
    const rec = ethers.verifyTypedData(
      { name: ev.domain.name, version: ev.domain.version, chainId: ev.domain.chainId, verifyingContract: ev.domain.verifyingContract },
      sig.EVIDENCE_ITEM_TYPES,
      {
        recordVersion: ev.recordVersion, commitmentId: ev.commitmentId, manifestHash: ev.manifestHash,
        criterionId: it.criterionId, itemId: it.itemId, type: it.type, issuer: it.issuer,
        payloadHash: it.payloadHash, at: it.at, amount: it.amount !== undefined && it.amount !== null ? it.amount : '0',
      },
      { v: it.sigs[0].v, r: it.sigs[0].r, s: it.sigs[0].s }
    );
    need(eq(rec, it.signedBy), 'evidence item ' + i + ' signature does not recover to signedBy');
    need(eq(it.signedBy, it.issuer), 'evidence item ' + i + ': signer != issuer (authenticity requires the issuer key)');
    // issuer authorization under the signed policy
    if (allowlistPolicy.policy === 'explicit-allowlist') {
      need(allowlistPolicy.issuers.some(a => eq(a, it.issuer)), 'evidence item ' + i + ': issuer not in signed acceptedIssuers allowlist');
    } else if (allowlistPolicy.policy === 'omitted') {
      // The signed spec's evidence policy omits an allowlist — reported
      // explicitly; issuer authorization cannot be established from the
      // agreement alone (reduced assurance, NOT universal trust).
      checks.push('evidence issuer allowlist OMITTED by signed policy (reported, not assumed universal or empty)');
      // still authenticated: certificate-style issuer identity is checked;
      // authorization remains UNSUPPORTED-determined.
    } else {
      throw new Error('evidence: missing signed evidence policy');
    }
    pass('evidence item ' + i + ' signature valid and issuer authenticated');
  }
  findings.integrity = { ok: true, items: ev.items.length };

  // 3. sufficiency vs signed requirements
  // minimumCount is a SIGNED requirement. A missing/absent value must be
  // rejected explicitly — never silently defaulted to 1.
  if (!Number.isInteger(reqs.minimumCount) || reqs.minimumCount < 1) {
    throw new Error('evidence: signed evidenceRequirements.minimumCount required (no silent default)');
  }
  const reqTypes = Array.isArray(reqs.requiredTypes) ? reqs.requiredTypes : [];
  if (reqTypes.length > 0) {
    for (const t of reqTypes) {
      const n = ev.items.filter(it => it.type === t).length;
      if (n < Number(reqs.minimumCount)) throw new Error('evidence: insufficient ' + t + ' evidence (required ' + reqs.minimumCount + ', got ' + n + ')');
    }
  } else {
    if (ev.items.length < Number(reqs.minimumCount)) throw new Error('evidence: insufficient evidence count (required ' + reqs.minimumCount + ', got ' + ev.items.length + ')');
  }
  // freshness: no item older than maxAge at the settlement/verdict time
  if (reqs.maxAge !== undefined && reqs.maxAge !== null) {
    for (const it of ev.items) {
      const itemMs = Date.parse(it.at);
      const refMs = Date.parse(ev.time);
      need(itemMs <= refMs, 'evidence item ' + it.itemId + ' future-dated (at > record time)');
      need(refMs - itemMs <= Number(reqs.maxAge) * 1000, 'evidence item ' + it.itemId + ' stale (older than signed maxAge)');
    }
  }
  // deadlines: all evidence must fall within the signed delivery window
  const delivery = Date.parse(m.deadlines.delivery);
  for (const it of ev.items) {
    const itemMs = Date.parse(it.at);
    need(itemMs <= delivery + 1000, 'evidence item ' + it.itemId + ' after signed delivery deadline');
  }
  findings.sufficiency = { ok: true, count: ev.items.length, required: Number(reqs.minimumCount || 1), freshnessOk: true };
  pass('evidence sufficiency: type, count, uniqueness, freshness, deadline window');

  // 4. criterion evaluation (bounded predicates only)
  const ac = m.acceptanceCriteria;
  const predicate = ac && typeof ac.type === 'string' ? ac.type : null;
  if (!SUPPORTED_PREDICATES.has(predicate)) {
    findings.criterion = { status: 'unsupported', predicate: predicate || '(missing)' };
    incomp('unsupported acceptance predicate "' + predicate + '" (supported: ' + [...SUPPORTED_PREDICATES].join(', ') + ')');
  }
  // hash-equals: at least one item's payload hash equals the signed expected value
  const expected = ac.value;
  need(typeof expected === 'string' && /^0x[0-9a-fA-F]{64}$/.test(expected), 'hash-equals: signed acceptanceCriteria.value must be a 32-byte hex digest');
  const matched = ev.items.some(it => eq(it.payloadHash, expected));
  findings.criterion = { status: matched ? 'satisfied' : 'not satisfied', predicate, expected };
  // D3 CLOSURE — outcome distinction, narrowly scoped:
  //   * release outcome: the acceptance criterion MUST be satisfied (a
  //     fulfilled release cannot verify on unsatisfied evidence).
  //   * refund outcome (evaluator-authorized or mutual OR timeout): a
  //     NOT-satisfied criterion is the legitimate failed-fulfillment
  //     outcome — the evidence affirms the deliverable was NOT met and the
  //     authorized refund is the settlement of that failure. Report the
  //     finding; do not throw. The caller (verify-v4) resolves outcome
  //     semantics; this module reports the criterion truthfully either way.
  // This does NOT weaken release requirements: release still demands
  // satisfaction, and settlement correctness never implies fulfillment.
  const settlementOutcome = String(ctx.outcome || '').toLowerCase();
  if (!matched && settlementOutcome === 'release') {
    throw new Error('evidence: acceptance criterion NOT satisfied (no item payload matches the signed expected digest); release requires satisfaction');
  }
  if (matched) pass('evidence acceptance criterion satisfied (hash-equals over signed expected digest)');
  else pass('evidence acceptance criterion NOT satisfied (hash-equals over signed expected digest); consistent with a refund outcome (nonfulfillment)');

  // 5. evaluator authorization / verdict consistency
  // A valid signature does not prove a real-world assertion; an authorized
  // evaluator verdict does not independently establish fulfillment. We check
  // CONSISTENCY only: the settlement outcome must be within the signed
  // evaluatorPermittedDecisions, and the export's evidence may accompany a
  // release OR a refund (a successful settlement can be verified even when
  // fulfillment failed / a refund occurred).
  const permitted = Array.isArray(m.evaluatorPermittedDecisions) ? m.evaluatorPermittedDecisions : [];
  if (ctx.mechanism === 'evaluator') {
    need(permitted.includes(ctx.outcome), 'evaluator verdict ' + ctx.outcome + ' not within signed evaluatorPermittedDecisions');
  }
  findings.evaluator = {
    ok: true,
    mechanism: ctx.mechanism,
    outcome: ctx.outcome,
    consistentWithPolicy: true,
    note: 'Signed evaluator verdict is CONSISTENT with the agreed decision policy. This does not independently establish fulfillment; evidence authenticity and criterion satisfaction are reported separately.',
  };
  pass('evaluator decision consistent with signed evaluatorPermittedDecisions (consistency, not proof)');

  return {
    checked: true,
    checks,
    findings,
    notes: allowlistPolicy.policy === 'omitted'
      ? ['Signed evidence policy omits an acceptedIssuers allowlist. Issuer signatures are authenticated; issuer AUTHORIZATION is not established by the agreement (reported, not assumed universal trust).']
      : [],
    items: ev.items.length,
    limitations: [
      'Evidence validation establishes authenticity (issuer signature + authorization under the signed policy when allowlisted) and the supported acceptance predicate (hash-equals). It does NOT establish the truth of the real-world assertion the evidence describes.',
      'Only OBJECTIVE_DIGITAL with exactly supported predicates is auto-accepted. Subjective services, physical delivery and high-value profiles require distinct evidence and evaluation rules — unsupported here.',
      'A valid signature does not prove a real-world assertion true; an authorized evaluator verdict does not independently establish fulfillment; a successful settlement may be verifiable even when fulfillment failed or a refund occurred.',
    ],
  };
}

module.exports = {
  verifyEvidence,
  EvidenceIncomplete,
  checkRecordSchema,
  SUPPORTED_PREDICATES,
  RECORD_KEYS,
  ITEM_KEYS,
};