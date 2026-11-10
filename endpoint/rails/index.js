// SAAX Protocol — Day 11, Item 3: Rail Registry (settlement-method-neutral)
//
// A rail is a settlement METHOD (S) that REALISES a payment requirement (R).
// Per the IETF agentic-payments draft the commitment binds the TERMS; the rail
// that realises R is resolved at EXECUTION time, not commitment time.
// This registry is the single place rails are registered and resolved, so the
// gateway never hardcodes a settlement method.
//
// Rail interface (every implementation MUST expose all three):
//   realise(R): Credential            — turn a requirement into a spendable
//                                        credential for this method
//   validate(Credential, R): boolean  — is this credential valid FOR R?
//   settle(Credential): TransactionReference
//                                      — move the value; return the public
//                                        transaction reference (railReference)
//
// Register a new rail:
//   const registry = require('./rails');
//   registry.register('stripe', { realise, validate, settle });
//   const rail = registry.resolve('stripe');
const implementations = new Map();

function register(method, implementation) {
  const m = String(method || '').trim().toLowerCase();
  if (!m) throw new Error('rails.register: method name is required');
  if (!implementation || typeof implementation !== 'object') {
    throw new Error('rails.register: implementation must be an object with realise/validate/settle');
  }
  for (const fn of ['realise', 'validate', 'settle']) {
    if (typeof implementation[fn] !== 'function') {
      throw new Error('rails.register: implementation for "' + m + '" is missing ' + fn + '()');
    }
  }
  implementations.set(m, implementation);
  return m;
}

function resolve(method) {
  const m = String(method || '').trim().toLowerCase();
  const impl = implementations.get(m);
  if (!impl) return null;
  return impl;
}

function list() {
  return Array.from(implementations.keys());
}

module.exports = { register, resolve, list };