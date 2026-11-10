// SAAX Protocol — Day 8, Item 3: Kill switch at the verification layer (pre-live)
//
// THE EARLIEST GATE. Runs before idempotency, before rate limiting, before
// sanitization, before signature checks, before on-chain lookups, before amount
// validation, before routing/settlement.
//
//   SAAX_KILL_SWITCH        = "false" (default, normal operation) | "true" (halt ALL
//                           live payment processing instantly)
//   SAAX_KILL_SWITCH_FILE   = optional path to a flag file. If the file EXISTS, the
//                           switch is ON (operator touches the file to halt, rm to
//                           resume). Enables runtime toggling WITHOUT restart even
//                           if the process caches env at startup — but we read the
//                           env var at CALL TIME anyway (same pattern as
//                           x402.getVerifyMode / feedback.getSignMode).
//
// Semantics (per brief):
//   - When ON: live payment verifications return 503 Service Unavailable with
//     { status: "halted", reason: "operator_kill_switch" }. No signature
//     verification, no on-chain query, no routing, no settlement.
//   - The MOCK branch KEEPS WORKING when SAAX_X402_VERIFY_MODE=mock — the switch
//     stops LIVE processing, not mock testing (mock mode is the operator's
//     testing lane; the kill switch is the live-money lane's emergency brake).
//   - Placement decision: the check sits in TWO places below, both before ANY
//     processing:
//       1) module-level isKillSwitchOn()     — pure, testable, unit-test target
//       2) requireKillSwitch(mode)          — the guard used by the router:
//          live verify  -> halted 503
//          mock verify  -> passes through (mock lane stays open)
//
// The "live payment processing" test in test-day8-item3.js drives the flag on a
// live-mode verify and asserts the 503 + no-signature-check (via the injected
// spy). The router-level integration test (item2/3 E2E) proves the ORDER: kill
// switch before rate limit before idempotency before sanitization.
const fs = require('fs');

const KILL_SWITCH_ENV = 'SAAX_KILL_SWITCH';
const KILL_SWITCH_FILE_ENV = 'SAAX_KILL_SWITCH_FILE';

let _killSwitchOverride = null; // test/runtime override; null = follow env

// Read env at CALL TIME (no startup caching). File-based fallback wins when set.
function isKillSwitchOn() {
  if (_killSwitchOverride !== null) return !!_killSwitchOverride;
  const env = String(process.env[KILL_SWITCH_ENV] || '').trim().toLowerCase();
  if (env === 'true' || env === '1') return true;
  const filePath = process.env[KILL_SWITCH_FILE_ENV];
  if (filePath) {
    try {
      return fs.existsSync(filePath);
    } catch (_) {
      return false; // unreadable/missing file -> OFF (fail-open on file read
                    // errors is deliberate: a broken file path must not halt
                    // production; the ENV var remains the authoritative switch)
    }
  }
  return false;
}

function setKillSwitch(val) { _killSwitchOverride = val; }

// The router guard. liveVerify:true + switch ON -> { ok:false, halted:true }.
// Mock lane passes through (kill switch stops live processing, not mock testing).
function requireKillSwitch(mode) {
  if (!isKillSwitchOn()) return { ok: true };
  const live = String(mode || '').toLowerCase() === 'live';
  if (!live) {
    return { ok: true, note: 'kill switch ON but verify mode is ' + mode + ' (mock lane stays open)' };
  }
  return {
    ok: false,
    halted: true,
    status: 503,
    body: { status: 'halted', reason: 'operator_kill_switch' },
  };
}

module.exports = { KILL_SWITCH_ENV, KILL_SWITCH_FILE_ENV, isKillSwitchOn, setKillSwitch, requireKillSwitch };