'use strict';
/**
 * SAAX Phase C — focused tests for verifier/v4-evidence.js.
 *
 * Positive controls + paired negatives, all built against the REAL signing
 * helpers (v4-signatures) and the REAL verifier module. Each negative must
 * assert a SPECIFIC rejection reason, not just non-VERIFIED — and key
 * negatives are paired with a positive control in the SAME execution so a
 * blanket-rejector verifier cannot pass the negative suite.
 *
 * NO EVM, NO RPC, NO app DB, NO participant keys: these tests exercise the
 * evidence verifier module directly with synthetic exports built from the
 * real shared canonical/signature helpers (same shape the closure producer
 * emits). Separate-process coverage is in scripts/test-v4-producer-closure.cjs.
 */

'use strict';
const crypto = require('crypto');
const { ethers } = require('ethers');
const canonical = require('../mainnet/design/support/v4-canonical');
const sig = require('../mainnet/design/support/v4-signatures');
const evidenceVerifier = require('../verifier/v4-evidence');

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}
async function throwsReason(fn, re) {
  try { await fn(); return null; }
  catch (e) { const m = String(e.message); return re.test(m) ? m : ('WRONG_REASON: ' + m); }
}
const sha = s => '0x' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');

(async () => {
  // ——— synthetic (but fully valid) v4 agreement fixture ———
  const CHAIN = 31337;
  const custodyAddr = '0x1111111111111111111111111111111111111111';
  const buyer = new ethers.Wallet('0x' + '11'.repeat(32));
  const seller = new ethers.Wallet('0x' + '22'.repeat(32));
  const stranger = new ethers.Wallet('0x' + '33'.repeat(32));
  const evaluator = '0x4444444444444444444444444444444444444444';
  const t = Math.floor(Date.now() / 1000);
  const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
  const cid = ethers.zeroPadValue(ethers.toBeHex(1), 32);

  const deliverable = JSON.stringify({ deliverable: 'synthetic-report', format: 'application/json', fields: { ok: true }, value: 42 });
  const deliverableHash = sha(deliverable);

  const m = {
    commitmentId: cid, buyerAgentId: buyer.address, sellerAgentId: seller.address,
    capability: 'test-evidence', price: { amount: '100', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash-equals', value: deliverableHash },
    deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
    terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
    evaluator, evaluatorPermittedDecisions: ['release', 'refund'],
    policy: { version: 'saax-custody-policy-v1', digest: '0x' + 'ab'.repeat(32), profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
    profile: 'OBJECTIVE_DIGITAL',
    custody: { chainId: CHAIN, custodyAddress: custodyAddr, token: '0x5555555555555555555555555555555555555555', principal: '100', fees: '0', reserve: '0' },
    consents: {
      buyer: { accepted: true, ref: 't-buyer' }, seller: { accepted: true, ref: 't-seller' },
      sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' },
    },
    evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true, acceptedIssuers: [seller.address], requiredTypes: ['deliverable-hash'] },
    deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) },
    fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' },
  };
  const built = canonical.buildV4Manifest(m);
  m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
  const digest32 = '0x' + built.manifestHash.slice(7);

  async function makeEvidence({ issuer = seller, itemId = 'ev-1', payload = deliverable, criterionId = 'deliverable-hash', at = t, issuePayloadHash = null } = {}) {
    const payloadHash = issuePayloadHash || sha(payload);
    const msg = { recordVersion: 1, commitmentId: cid, manifestHash: digest32, criterionId, itemId, type: 'deliverable-hash', issuer: issuer.address, payloadHash, at: iso(at), amount: '0' };
    const s = ethers.Signature.from(await issuer.signTypedData(sig.evidenceDomain(custodyAddr, CHAIN), sig.EVIDENCE_ITEM_TYPES, msg));
    return {
      recordVersion: 1, time: iso(t), commitmentId: cid, manifestHash: digest32,
      domain: sig.evidenceDomain(custodyAddr, CHAIN),
      items: [{ itemId, criterionId, type: 'deliverable-hash', issuer: issuer.address, payloadHash, payload, at: iso(at), amount: '0', signedBy: issuer.address, sigs: [{ v: s.v, r: s.r, s: s.s }] }],
      findings: {},
    };
  }
  async function makeExport(evOverrides = {}, agOverrides = {}) {
    const m2 = JSON.parse(JSON.stringify(m));
    Object.assign(m2, agOverrides);
    const built2 = canonical.buildV4Manifest(m2);
    m2.signatureHex = built2.signature.slice('COSE_Sign1:'.length);
    const digest2 = '0x' + built2.manifestHash.slice(7);
    const ev = await makeEvidence(evOverrides);
    return { exp: { formatVersion: 4, agreement: m2, commitmentDigest: built2.manifestHash, authorizations: [], lifecycleProfile: 'full', lifecycle: { funding: { txHash: '0x' + 'aa'.repeat(32), blockHash: '0x' + 'bb'.repeat(32) }, settlement: { txHash: '0x' + 'cc'.repeat(32), blockHash: '0x' + 'dd'.repeat(32) } }, finality: { mode: 'local-synthetic' }, evidence: ev }, digest: digest2 };
  }
  const ctx = { digest32, outcome: 'release', mechanism: 'evaluator', resolution: BigInt(t + 1000), cutoff: BigInt(t + 2000) };

  // ——— POSITIVE CONTROLS (paired with negatives to defeat a blanket rejector) ———
  {
    const { exp } = await makeExport();
    const r = evidenceVerifier.verifyEvidence(exp, { ...ctx, digest32: '0x' + exp.commitmentDigest.slice(7) });
    check('P1 positive control: valid fulfilled release evidence verifies', r.checked === true && r.findings.integrity.ok && r.findings.sufficiency.ok && r.findings.criterion.status === 'satisfied' && r.findings.evaluator.ok);
    check('P1b positive: issuer allowlist explicit + issuer authenticated', r.findings.issuer.policy === 'explicit-allowlist' && r.items === 1);
  }
  {
    // refund outcome with the same evidence is still verifiable (settlement
    // -- a successful settlement may be verifiable even when fulfillment
    // failed or a refund occurred)
    const { exp } = await makeExport();
    const r = evidenceVerifier.verifyEvidence(exp, { ...ctx, outcome: 'refund', mechanism: 'evaluator' });
    check('P2 positive: refund outcome with same evidence still verifies (settlement ≠ fulfillment)', r.checked === true && r.findings.evaluator.outcome === 'refund' && r.findings.criterion.status === 'not satisfied' === false || r.checked === true);
  }

  // ——— NEGATIVES (specific reasons) ———
  {
    // wrong issuer: evidence signed by stranger, not the allowlisted seller
    const ev = await makeEvidence({ issuer: stranger });
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /signer != issuer|issuer not in signed acceptedIssuers/);
    check('N1 wrong issuer (stranger-signed) rejected with issuer reason', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // wrong signature: tamper the sig bytes of an otherwise-valid item
    const { exp } = await makeExport();
    exp.evidence.items[0].sigs[0].r = '0x' + 'ee'.repeat(32);
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /does not recover to signedBy|signature/);
    check('N2 tampered signature rejected (recovery reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // wrong payload hash: payload bytes changed but hash recomputed (self-consistent but not the signed criterion)
    const badPayload = JSON.stringify({ deliverable: 'NOT-THE-DELIVERABLE' });
    const ev = await makeEvidence({ payload: badPayload });
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /acceptance criterion NOT satisfied/);
    check('N3 correctly signed evidence that FAILS the criterion rejected (criterion reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // cross-commitment: evidence for a DIFFERENT commitmentId
    const otherCid = ethers.zeroPadValue(ethers.toBeHex(2), 32);
    const msg = { recordVersion: 1, commitmentId: otherCid, manifestHash: digest32, criterionId: 'deliverable-hash', itemId: 'ev-1', type: 'deliverable-hash', issuer: seller.address, payloadHash: sha(deliverable), at: iso(t), amount: '0' };
    const s = ethers.Signature.from(await seller.signTypedData(sig.evidenceDomain(custodyAddr, CHAIN), sig.EVIDENCE_ITEM_TYPES, msg));
    const ev = { recordVersion: 1, time: iso(t), commitmentId: otherCid, manifestHash: digest32, domain: sig.evidenceDomain(custodyAddr, CHAIN), items: [{ itemId: 'ev-1', criterionId: 'deliverable-hash', type: 'deliverable-hash', issuer: seller.address, payloadHash: sha(deliverable), payload: deliverable, at: iso(t), amount: '0', signedBy: seller.address, sigs: [{ v: s.v, r: s.r, s: s.s }] }], findings: {} };
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /commitmentId != signed agreement/);
    check('N4 cross-commitment evidence rejected (commitment binding reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // wrong criterion: evidence bound to a criterion the agreement doesn't define
    const ev = await makeEvidence({ criterionId: 'some-other-criterion' });
    const { exp } = await makeExport();
    exp.evidence = ev;
    // the item references a criterion the signed agreement does not define —
    // rejected (criterion binding), never interpreted permissively
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /criterionId.*!= signed acceptance criterion/);
    check('N5 wrong-criterion substitution rejected (criterion reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // replayed/duplicate evidence failing minimum-count: two identical items
    const { exp } = await makeExport();
    exp.evidence.items.push(JSON.parse(JSON.stringify(exp.evidence.items[0])));
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /duplicate itemId/);
    check('N6 replayed duplicate evidence rejected (duplicate itemId reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // wrong type: evidence type not in requiredTypes => insufficient
    const ev = await makeEvidence({ itemId: 'ev-1' });
    ev.items[0].type = 'temperature-reading';
    const msg = { recordVersion: 1, commitmentId: cid, manifestHash: digest32, criterionId: 'deliverable-hash', itemId: 'ev-1', type: 'temperature-reading', issuer: seller.address, payloadHash: sha(deliverable), at: iso(t), amount: '0' };
    const s = ethers.Signature.from(await seller.signTypedData(sig.evidenceDomain(custodyAddr, CHAIN), sig.EVIDENCE_ITEM_TYPES, msg));
    ev.items[0].sigs = [{ v: s.v, r: s.r, s: s.s }];
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /insufficient deliverable-hash evidence|type/);
    check('N7 wrong evidence type rejected (sufficiency reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // stale evidence: older than signed maxAge
    const ev = await makeEvidence({ at: t - 100000 });
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /stale|maxAge|before signed maxAge/);
    check('N8 stale evidence rejected (freshness reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // future-dated evidence
    const ev = await makeEvidence({ at: t + 99999 });
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /future-dated|after signed delivery deadline|stale/);
    check('N9 future-dated evidence rejected (time reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // deadline boundary: evidence after the signed delivery deadline
    // evidence time is before record time but the AGREEMENT's delivery
    // deadline is in the past relative to the evidence — the enforcement is
    // on the signed deadline, not the record time.
    const ev = await makeEvidence({ at: t });
    const { exp } = await makeExport();
    exp.agreement.deadlines.delivery = iso(t - 100);
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /after signed delivery deadline/);
    check('N10 evidence after signed delivery deadline rejected (deadline reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // deadline boundary: evidence exactly AT the delivery deadline is accepted
    const ev = await makeEvidence({ at: t });
    const { exp } = await makeExport();
    exp.agreement.deadlines.delivery = iso(t + 1);
    const r = evidenceVerifier.verifyEvidence(exp, ctx);
    check('N10b evidence at/before the signed delivery deadline accepted (boundary positive control)', r.checked === true && r.findings.criterion.status === 'satisfied');
  }
  {
    // malformed number: amount not an exact integer string
    const ev = await makeEvidence({ itemId: 'ev-1' });
    ev.items[0].amount = '10.5';
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /amount must be an exact integer string/);
    check('N13 malformed amount rejected (exact-integer reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // malformed number: amount with a unit suffix (silent coercion rejected)
    const ev = await makeEvidence({ itemId: 'ev-1' });
    ev.items[0].amount = '10 USDC';
    const { exp } = await makeExport();
    exp.evidence = ev;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /amount must be an exact integer string/);
    check('N13b amount with unit suffix rejected (no silent coercion)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // missing/unavailable evidence on a lifecycle export
    const { exp } = await makeExport();
    delete exp.evidence;
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /fulfillment evidence record required/);
    check('N11 missing evidence on lifecycle INCOMPLETE (required-evidence reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // unknown predicate
    const { exp } = await makeExport();
    exp.agreement.acceptanceCriteria = { type: 'sql-select', value: 'SELECT * FROM users' };
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /unsupported acceptance predicate/);
    check('N12 unknown predicate rejected (unsupported-predicate reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // malformed unit/currency semantics: reject silently coercing absence
    const { exp } = await makeExport();
    delete exp.agreement.evidenceRequirements.minimumCount; // default must not invent 1? signed requires it
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /minimumCount required/);
    check('N14 missing signed minimumCount rejected (no silent default)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // code-injection input: payload containing executable-looking content must
    // never be evaluated — the module only hashes it. The assertion: the only
    // outcome is the normal criterion result (not satisfied OR satisfied),
    // never an execution artifact (spawn/exec/require side effect).
    const injection = 'require("child_process").exec("whoami"); process.exit(0);';
    const ev = await makeEvidence({ payload: injection });
    const { exp } = await makeExport();
    exp.evidence = ev;
    let threw = false, result = null, errMsg = null;
    try { result = evidenceVerifier.verifyEvidence(exp, ctx); } catch (e) { threw = true; errMsg = String(e.message); }
    check('N15 code-injection payload never executed (opaque hash-only processing)', (!threw && result !== null && result.findings.criterion.status === 'not satisfied') || (threw && /acceptance criterion NOT satisfied/.test(errMsg)));
  }
  {
    // authorized verdict inconsistent with the signed evaluation policy:
    // evaluator releases when 'release' is not permitted
    const { exp } = await makeExport();
    exp.agreement.evaluatorPermittedDecisions = ['refund'];
    const reason = await throwsReason(() => evidenceVerifier.verifyEvidence(exp, ctx), /not within signed evaluatorPermittedDecisions/);
    check('N16 evaluator verdict inconsistent with signed policy rejected (policy-consistency reason)', reason !== null && !String(reason).startsWith('WRONG_REASON'));
  }
  {
    // omitted issuer allowlist: must be REPORTED, not assumed universal or empty
    const { exp } = await makeExport();
    delete exp.agreement.evidenceRequirements.acceptedIssuers;
    const r = evidenceVerifier.verifyEvidence(exp, ctx);
    check('N17 omitted issuer allowlist reported explicitly (policy finding, not silent trust)', r.findings.issuer.policy === 'omitted' && r.notes.some(n => /omits an acceptedIssuers allowlist/.test(n)) && r.checked === true);
  }

  console.log('evidence_passed=' + passed + ' failed=' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });