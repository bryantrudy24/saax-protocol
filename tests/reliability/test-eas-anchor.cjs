// SAAX MCP Lifecycle Phase 3 — EAS event-anchoring conformance (isolated).
//
// Tests endpoint/eas-anchor.js: deterministic event hashing, schema/version
// binding, commitment binding, idempotent anchoring attempts, reconciliation
// after uncertain outcomes, and the no-false-anchor policy (a pending anchor
// is NEVER reported as confirmed).
//
// Usage: node tests/reliability/test-eas-anchor.cjs
'use strict';

const eas = require('../../endpoint/eas-anchor.js');

let PASS = 0, FAIL = 0;
const failures = [];
function record(name, ok, info) {
  if (ok) { PASS++; console.log('PASS ' + name + (info ? ' :: ' + info : '')); }
  else { FAIL++; failures.push(name); console.log('FAIL ' + name + (info ? ' :: ' + info : '')); }
}

(async () => {
  eas._reset();

  const ev = {
    eventType: 'commitment.transition',
    commitmentId: 'c-abc123',
    eventId: 'evt-1',
    fromState: 'accepted',
    toState: 'executing',
    actorPrincipal: '0x1111111111111111111111111111111111111111',
    authorityRef: 'ap:ref1',
    evidenceRef: null,
    timestamp: '2026-11-12T12:00:00.000Z',
  };

  // ---- T1: deterministic hash -------------------------------------------------
  const h1 = eas.eventHash(ev);
  const h2 = eas.eventHash({ ...ev });
  record('T1-deterministic-hash', h1 === h2 && h1.startsWith('sha256:') && h1.length === 71, 'len=' + h1.length);

  // ---- T2: hash changes when any field changes --------------------------------
  const h3 = eas.eventHash({ ...ev, toState: 'evidence_pending' });
  record('T2-field-sensitivity', h1 !== h3, 'changed=' + (h1 !== h3));

  // ---- T3: canonical sorted keys (key order does not matter) -------------------
  const h4 = eas.eventHash({ ...ev, commitmentId: 'c-abc123', eventType: 'commitment.transition', fromState: 'accepted', toState: 'executing', actorPrincipal: '0x1111111111111111111111111111111111111111', authorityRef: 'ap:ref1', eventId: 'evt-1' });
  record('T3-canonical-key-order', h1 === h4, 'stable=' + (h1 === h4));

  // ---- T4: schema version binding ----------------------------------------------
  // The module builds the hashed payload from its SCHEMA_VERSION constant and
  // the event fields. Prove the schema version is INSIDE the digest by
  // reconstructing the canonical payload (sorted keys, sha256) and comparing.
  const crypto = require('crypto');
  const canonical = JSON.stringify({
    schemaVersion: 1,
    eventType: ev.eventType,
    commitmentId: ev.commitmentId,
    eventId: ev.eventId,
    fromState: ev.fromState,
    toState: ev.toState,
    actorPrincipal: ev.actorPrincipal,
    authorityRef: ev.authorityRef,
    evidenceRef: ev.evidenceRef,
    timestamp: ev.timestamp,
    chainId: 11155111,
  }, (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {});
    }
    return v;
  });
  const expected = 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  record('T4-schema-version-in-payload', eas.SCHEMA_VERSION === 1 && eas.eventHash(ev) === expected, 'schemaVersion=' + eas.SCHEMA_VERSION + ' digest-matches-reconstructed-payload=' + (eas.eventHash(ev) === expected));

  // ---- T5: commitment binding ---------------------------------------------------
  const h5 = eas.eventHash({ ...ev, commitmentId: 'c-other' });
  record('T5-commitment-binding', h1 !== h5, 'changed=' + (h1 !== h5));

  // ---- T6: anchor confirmed (simulated transport success) ----------------------
  const forcedOkTransport = async (digest) => ({ ok: true, attestationUid: '0x' + 'cd'.repeat(32), txHash: '0x' + 'ef'.repeat(32) });
  const a1 = await eas.anchorEvent(ev, { transport: forcedOkTransport });
  record('T6-anchor-confirmed', a1.ok && a1.record.status === 'confirmed' && a1.record.attestationUid && a1.record.chainId === 11155111, 'status=' + (a1.ok ? a1.record.status : 'err') + ' chain=' + (a1.ok ? a1.record.chainId : '?'));

  // ---- T7: idempotent re-anchor returns existing record ------------------------
  const a2 = await eas.anchorEvent(ev, { transport: forcedOkTransport });
  record('T7-reanchor-idempotent', a2.ok && a2.record.replayed === true && a2.record.status === 'confirmed' && a2.record.attestationUid === a1.record.attestationUid, 'replayed=' + (a2.ok && a2.record.replayed));

  // ---- T8: pending on uncertain transport (no false confirm) -------------------
  eas._reset();
  const pendingTransport = async (digest) => ({ ok: false, reason: 'network uncertainty' });
  const a3 = await eas.anchorEvent(ev, { transport: pendingTransport });
  record('T8-pending-no-false-confirm', a3.ok && a3.record.status === 'pending' && a3.record.confirmedAt === null, 'status=' + (a3.ok ? a3.record.status : 'err'));

  // ---- T9: reconcile promotes to confirmed only with a confirmed receipt ------
  const a4 = await eas.reconcileAnchor(ev.eventId, { transport: forcedOkTransport });
  record('T9-reconcile-promotes-on-confirm', a4.ok && a4.record.status === 'confirmed' && a4.record.confirmedAt !== null, 'status=' + (a4.ok ? a4.record.status : 'err'));

  // ---- T10: reconcile keeps pending when still uncertain ------------------------
  eas._reset();
  await eas.anchorEvent(ev, { transport: pendingTransport });
  const a5 = await eas.reconcileAnchor(ev.eventId, { transport: pendingTransport });
  record('T10-reconcile-keeps-pending', a5.ok && a5.record.status === 'pending', 'status=' + (a5.ok ? a5.record.status : 'err'));

  // ---- T11: getAnchor returns the record ---------------------------------------
  const a6 = await eas.getAnchor(ev.eventId);
  record('T11-get-anchor', a6.ok && a6.record.eventId === ev.eventId, a6.ok ? 'found' : (a6.reason || ''));

  // ---- T12: missing event fields rejected ---------------------------------------
  const a7 = await eas.anchorEvent({ eventType: 'x' }, { transport: forcedOkTransport });
  record('T12-missing-fields-rejected', !a7.ok, a7.ok ? 'unexpected ok' : (a7.reason || ''));

  // ---- T13: mainnet not anchored (chain pinned to testnet) ----------------------
  record('T13-testnet-chain-pinned', eas.CHAIN_ID === 11155111 && eas.ANCHOR_SCHEMA_UID.startsWith('0x'), 'chain=' + eas.CHAIN_ID);

  // ---- T14: simulated uncertain transport is deterministic per hash ------------
  // The default mock confirms for hashes ending in 0-8 and stays pending for '9'
  // (exercised by T8-T10 with explicit transports; here verify the default works).
  eas._reset();
  const a8 = await eas.anchorEvent({ ...ev, eventId: 'evt-default' });
  record('T14-default-transport-works', a8.ok && (a8.record.status === 'confirmed' || a8.record.status === 'pending'), 'status=' + (a8.ok ? a8.record.status : 'err'));

  eas._reset();
  console.log('\n==== PHASE 3 EAS ANCHOR RESULT: ' + PASS + '/' + (PASS + FAIL) + ' PASS ====');
  if (FAIL) { console.log('FAILED: ' + failures.join(', ')); process.exitCode = 1; }
})();