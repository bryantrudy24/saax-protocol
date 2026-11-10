// SAAX Protocol — Day 11, Item 6: Recovery Layer (Kleros Escrow V2 interface)
//
// Reference: Kleros Escrow V2 — Transaction struct binds buyer, seller,
// amount, deadline, dispute ID; supports settlement negotiation, partial
// payments, deadline execution, and Kleros Court arbitration.
//
// The recovery layer wakes when a committed outcome is NOT accepted: the
// buyer disputes, the seller fails to deliver, or the deadline passes without
// verified acceptance. Phase 1 ships the INTERFACE ONLY — the real Kleros
// integration happens post-mainnet (per the operator constraints: no Kleros
// escrow deployment in Phase 1).
//
// Interface contract:
//   createEscrow(commitment, manifest) -> escrow ID
//   proposeSettlement(escrowId, amount) -> settlement proposal
//   acceptSettlement(escrowId) -> finalize
//   raiseDispute(escrowId, evidence) -> dispute ID
//
// Each method validates its inputs THEN throws NOT_IMPLEMENTED with a clear
// error — so a caller can never mistake the stub for a live escrow.

const missing = (name) => {
  const err = new Error('recovery.' + name + ' is NOT_IMPLEMENTED — Kleros Escrow V2 integration is Phase 1 stub only (real integration is post-mainnet)');
  err.code = 'NOT_IMPLEMENTED';
  return err;
};

const requireCommitment = (commitment, name) => {
  if (!commitment || typeof commitment !== 'object') throw new Error('recovery.' + name + ': commitment object is required');
  if (!commitment.commitmentId) throw new Error('recovery.' + name + ': commitmentId is required');
};

function createEscrow(commitment, manifest) {
  requireCommitment(commitment, 'createEscrow');
  throw missing('createEscrow');
}

function proposeSettlement(escrowId, amount) {
  if (!escrowId || typeof escrowId !== 'string') throw new Error('recovery.proposeSettlement: escrowId is required');
  if (amount === undefined || amount === null || !/^\d+(\.\d+)?$/.test(String(amount))) {
    throw new Error('recovery.proposeSettlement: amount must be a numeric string');
  }
  throw missing('proposeSettlement');
}

function acceptSettlement(escrowId) {
  if (!escrowId || typeof escrowId !== 'string') throw new Error('recovery.acceptSettlement: escrowId is required');
  throw missing('acceptSettlement');
}

function raiseDispute(escrowId, evidence) {
  if (!escrowId || typeof escrowId !== 'string') throw new Error('recovery.raiseDispute: escrowId is required');
  if (!evidence || typeof evidence !== 'object') throw new Error('recovery.raiseDispute: evidence must be an object (e.g. { type, value })');
  throw missing('raiseDispute');
}

module.exports = { createEscrow, proposeSettlement, acceptSettlement, raiseDispute };