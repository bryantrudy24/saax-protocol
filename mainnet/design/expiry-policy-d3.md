# D3 Closure — Expiry Policy (authoritative)

Status: IMPLEMENTED + TESTED (test-d3-expiry-semantics.cjs 6/6; action-auth 29/29).

## Clocks and enforcement points

| Clock | Value | Enforced at | Mechanism |
|---|---|---|---|
| Access-authorization expiry | wall clock | DURABLE ACCEPTANCE | `endpoint/escrow-access.js` `EXPIRED` (expiry <= now => reject) — fires BEFORE any acceptance record is created. |
| Evaluator/mutual authorization validity | signature issuance vs execution | EXECUTION | Verdict/mutual digest bound to the exact contract-action literal + execution-validity window (`verify-v4`: `issuedAt <= settle.time+120s && settle.time <= issuedAt+300s`), verified against `esc.evaluator` (EOA ecrecover or ERC-1271 staticcall). Signatures are NEVER extended automatically. |
| Delivery deadline | EVM clock | EXECUTION | `worker/d2-prereqs.js` state-permitted + `DEADLINE_NOT_PASSED` (timeout refund before deadline rejected). |
| Final cutoff | EVM clock | EXECUTION | `worker/d2-prereqs.js` `AFTER_CUTOFF` — at/after cutoff only the timeout refund is eligible; everything else rejected. Earlier-issued verdict signatures do NOT override cutoff rules (contract `AfterCutoff` in release/refund/resolve). |

## The rule

An access authorization must be valid at durable acceptance. After
acceptance, the operation is a durable, retrievable record:

- Delayed worker pickup of an accepted op proceeds; the access-auth expiry is
  NOT re-checked at execution (removed `AUTH_EXPIRED` from
  `worker/d2-prereqs.js`).
- Access expiry alone does NOT erase accepted work and does NOT prove a
  prepared transaction cannot execute.
- Retries of the accepted op retrieve the recorded result under the
  authenticated retrieval policy (same nonce + same payload => idempotent;
  same nonce + changed payload => conflict; same payload + different nonce =>
  duplicate).
- Action-specific contract validity and cutoff rules STILL apply at
  execution (they are the execution authority, bound by the contract's own
  clock, not the application auth expiry).

## Deliberately NOT done

- No automatic extension of access-auth expiries, verdict signatures, or
  contract deadlines.
- No bypass of the contract's cutoff for evaluator/mutual actions.
- No inference of caller authority from a genuine verdict: the resolve
  branch enforces `accessRole === 'evaluator'` separately
  (`RESOLVE_ROLE_REQUIRED`), and the endpoint's role->action map rejects
  unauthorized role/action pairs before acceptance.