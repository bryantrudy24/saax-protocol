// env-allowlist.js — Phase D4B explicit environment allowlist for child
// processes (integrated custody lane).
//
// PURPOSE
//   When a supervisor spawns a child process (the external-signer reference
//   server, or a worker subprocess), it must NOT inherit the full application
//   environment (which may contain API keys, the prepared-transaction key, the
//   pilot token, or other secrets). This module builds an EXPLICIT allowlist
//   env: only the named variables are passed through; everything else is
//   dropped. This is scoped to the integrated custody lane — it does not touch
//   the immediate-payment lane or any unrelated legacy key path.
//
//   Separate processes under one OS account are NOT host-compromise isolation;
//   this module enforces the process-level secret boundary (a child sees only
//   what it needs), which is a distinct, weaker guarantee. Documented here,
//   not overstated.
//
//   The allowlist is DENY-BY-DEFAULT: a child inherits NONE of the parent env
//   except the explicitly listed keys. Secrets never listed are never leaked.

'use strict';

/**
 * Build an explicit env allowlist for a child process.
 * @param {object} sourceEnv  the parent environment (defaults to process.env)
 * @param {string[]} allow    exact variable names to pass through
 * @param {object} overrides  additional explicit values to set on the child
 * @returns {object} a fresh env object containing ONLY the allowlisted keys +
 *                   overrides.
 */
function buildChildEnv(sourceEnv = process.env, allow = [], overrides = {}) {
  const out = {};
  for (const k of allow) {
    if (sourceEnv[k] !== undefined) out[k] = sourceEnv[k];
  }
  // Always carry PATH-like and platform basics required for node to exec.
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (sourceEnv[k] !== undefined && !(k in out)) out[k] = sourceEnv[k];
  }
  for (const [k, v] of Object.entries(overrides || {})) {
    out[k] = v;
  }
  return out;
}

/**
 * Compute the set of secrets that WOULD have leaked to a child had the parent
 * env been passed wholesale, but that the allowlist now prevents. Useful for
 * tests and audits (returns names, never values).
 * @param {string[]} secretNames  candidate secret env names to check
 * @param {object} sourceEnv
 * @param {string[]} allow
 */
function leakedSecretNames(secretNames, sourceEnv = process.env, allow = []) {
  const allowSet = new Set(allow);
  return secretNames.filter((k) => sourceEnv[k] !== undefined && !allowSet.has(k));
}

module.exports = { buildChildEnv, leakedSecretNames };
