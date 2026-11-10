// SAAX Worker crash-test child (used by test-worker-failure.js).
// Runs real intent work against the durable store, then dies at a boundary
// (before broadcast / crash after broadcast) to simulate a killed worker.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const store = require('../endpoint/store.js');
const escrow = require('../endpoint/escrow.js');

(async () => {
  const action = process.env.W_ACTION || 'fund';
  const commitmentId = process.env.W_COMMITMENT || '';
  const idem = process.env.W_IDEM || '';
  const boundary = process.env.W_BOUNDARY || '';
  const txHash = process.env.W_TXHASH || null;
  const client = store.buildStoreClient();
  escrow.setStoreClient(client);
  if (!client) { console.error('no store'); process.exit(1); }

  // 1. Persist intent BEFORE broadcast (durable, idempotency-keyed).
  const rec = await escrow.recordIntent({ commitmentId, action, idempotencyKey: idem, payload: { action, boundary } });
  if (!rec.ok && !rec.duplicate) { console.error('intent record failed ' + JSON.stringify(rec)); process.exit(1); }

  if (boundary === 'before-broadcast') {
    // The worker persisted the intent then died BEFORE broadcasting anything.
    // Do NOT mark broadcast; exit 0 (the replacement will see pending).
    console.log('worker: before-broadcast, intent=' + idem + ' status=pending');
    process.exit(0);
  }

  if (boundary === 'crash-after-broadcast') {
    // Mark broadcast (external action in flight), then simulate the process
    // dying before saving the completion/confirmation.
    const upd = await escrow.updateIntent({ idempotencyKey: idem, intentStatus: 'broadcast', txHash });
    if (!upd.ok) { console.error('broadcast mark failed ' + JSON.stringify(upd)); process.exit(1); }
    console.log('worker: crash-after-broadcast, intent=' + idem + ' status=broadcast (SIGKILL next)');
    process.exit(9); // crash — no completion saved
  }

  // default: just persist and exit clean
  process.exit(0);
})().catch(e => { console.error('worker fatal ' + e.message); process.exit(1); });
