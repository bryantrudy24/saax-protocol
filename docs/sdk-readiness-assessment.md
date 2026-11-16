# SAAX SDK Readiness Assessment — Gate J.16, Workstream D

**Date:** 2026-11-15 · **Status:** Assessment only — NO package published (npm/PyPI).
Proposed package names (`@saax/sdk` TS, `saax-protocol` Python) are placeholders, not artifacts.

---

## 1. What reusable client functionality already exists

- **Official MCP SDK (JS/TS):** `@modelcontextprotocol/sdk@1.32.0` is a direct dependency of the
  SAAX repo and is proven against the live endpoint this gate:
  - SDK battery `tests/repro-mcp-sdk-client.mjs` — **6/6 PASS** (connect, list 26 tools,
    cross-instance session 404, new-session recovery, finite backoff, no reuse of dead session).
  - `examples/mcp-recovery/run.cjs` Part A — **9/9 PASS** (live discovery, 26-tool inventory,
    required-tool exposure, read-only `get_protocol_info` call).
- The MCP surface itself is the client contract: 26 typed tools with JSON schemas (captured this
  gate from live `tools/list`), streamable-http transport, session management.
- Read-only tools work without auth; mutating tools require EIP-712 proof + durable
  authorization (enforced server-side, proven by the harness/disputes/evidence suites).

## 2. What can be built using the existing MCP interface

Everything a developer needs for the first adoption milestone:

- Connect + initialize + session management (`StreamableHTTPClientTransport`).
- Discover tools (`tools/list`) and read-only inspection (`get_commitment`, `get_recovery_status`,
  `get_commitment_history`, `get_protocol_info`, `ping`).
- Mutating lifecycle via `create_commitment` / `prepare_commitment` / `accept_commitment` /
  `cancel_commitment` / `close_commitment` / `submit_evidence` / `verify_evidence` /
  `raise_dispute` / `resolve_dispute` / `resume_commitment` — when the caller holds a valid
  proof + authorization (operator/testbed-provisioned).

No additional client-side dependency is required to call any of these.

## 3. Which functions need typed wrappers

For a first milestone, **none are strictly required** — the SDK's generic `callTool` is
sufficient. The value of a typed wrapper is ergonomics + compile-time safety:

| Tool group | Value of a typed wrapper | Priority |
|---|---|---|
| `get_protocol_info`, `ping`, `list_capabilities`, `get_routing_fee`, `route_request` | Low (few args, stable shapes) | P3 |
| `get_commitment`, `get_commitment_status`, `get_commitment_history`, `list_commitments` | Medium (commitment shape reused) | P2 |
| `create_commitment`, `prepare_commitment`, `accept_commitment` | Medium-high (auth envelope) | P2 |
| `submit_evidence`, `verify_evidence`, `list_evidence`, `get_evidence_verification` | Medium | P2 |
| `raise_dispute`, `resolve_dispute`, `list_disputes` | Medium | P3 |
| `get_recovery_status`, `get_pending_actions`, `resume_commitment` | **High** (recovery is the differentiator) | **P1** |

A `SaaxClient` wrapper could expose `commitments.*`, `evidence.*`, `disputes.*`, `recovery.*`
namespaces with result types and idempotency-key helpers.

## 4. Authentication & authorization handling

The MCP endpoint itself handles proof validation. A client wrapper's responsibilities:

1. Accept caller identity (agent id + EIP-712 signer) as configuration.
2. Pass through the caller-supplied proof parameters to mutating tools (never fabricate proofs).
3. Surface `AUTH_MISSING_AUTHORIZATION` / `AUTH_REVOKED` / `AUTH_EXPIRED` /
   `AUTH_OUT_OF_SCOPE` / `AUTH_ROLE_DENIED` errors with actionable messages.
4. Document that authorization provisioning is an operator/testbed action.

No client-side key management beyond what the application already does (viem/ethers for the
signer). The wrapper must not attempt to mint or bypass authorizations.

## 5. Retries & idempotency

- SAAX enforces idempotency server-side via idempotency refs (proven: `IDEM_FINGERPRINT_CONFLICT`
  on changed refs; `replayed` on identical retries; no duplicate effects).
- Client guidance: **reuse the same idempotency ref for a retry of the same logical operation;
  use a fresh ref for a genuinely new operation.**
- The SDK's reconnect defaults (finite backoff, maxRetries=2) are correct; a wrapper should
  surface "session lost — re-initialize once, then retry with the same idempotency ref" rather
  than silently looping.
- Timeout handling: use `AbortController` with a caller-configured timeout; on timeout, check
  `get_commitment_status`/`get_recovery_status` before re-POSTing (reconcile-before-respond).

## 6. Client recovery from timeouts

Proven pattern (reliability suites): on unknown outcome, **query state, don't re-POST**.
`get_commitment_status` returns `next_action: retry_safe` for unknown IDs and `poll` for
in-flight — the wrapper should expose this next-action hint to the caller.

## 7. Tests required before publication

If an official package is pursued (future gate):

- Unit: argument validation, idempotency-ref reuse rules, error mapping.
- Integration (testbed): create → accept → crash → recover (the 3-agent recovery scenario),
  idempotent replay, authorization-denied paths.
- Live smoke: connect + list 26 tools + read-only call against production (nonfinancial).
- Type-level: strict TS `tsc` compile; Python `mypy`/`pyright` for typed stubs.
- Docs example tests: every quickstart snippet executed.

## 8. Is an SDK necessary for the first milestone?

**No.** The official MCP SDK (JS/TS) already provides a complete, verified client path, and
Python has `mcp` official SDK support for the same streamable-http transport. The first
adoption milestone (connect → discover → safe example) is met without a SAAX-specific package.

**Recommendation:** do NOT publish `@saax/sdk` or `saax-protocol` yet. Instead:
1. Ship the corrected quickstart + examples (this gate) — the "SDK" for milestone 1 is the MCP
   SDK plus SAAX's docs.
2. Add a **typed recovery helper** (small, in-repo, not published) if desired: a `recovery.js`
   wrapper around `get_recovery_status` / `get_pending_actions` / `resume_commitment` with
   next-action typing.
3. Revisit publication after external developer feedback shows a real demand for typed wrappers
   and after the authorization-provisioning UX is settled.

Publishing an unproven package now would add maintenance surface without adoption evidence.
