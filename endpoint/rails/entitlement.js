// SAAX Protocol — Day 11, Item 3: Entitlement rail (interface-complete STUB)
//
// Entitlement/balance settlement — a settlement method that realises R from a
// pre-funded balance or entitlement rather than a payment network. Per the
// Phase 1 constraints this is a STUB: the interface is complete, the
// implementation throws NOT_IMPLEMENTED with a clear error.

function _notImplemented(step) {
  const err = new Error('Entitlement rail ' + step + ' is NOT_IMPLEMENTED (Phase 1 stub — balance/entitlement settlement is a later-phase item)');
  err.code = 'NOT_IMPLEMENTED';
  throw err;
}

function realise(R) { _notImplemented('realise'); }
function validate(Credential, R) { _notImplemented('validate'); }
function settle(Credential) { _notImplemented('settle'); }

module.exports = { realise, validate, settle };