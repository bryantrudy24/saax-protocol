# SAAX MCP Cross-Instance Routing — Deterministic Acceptance Test & Stateless Mode

**Branch:** `investigation/consistency-mcp-measurement`
**Commit:** `b75fccbd` (routing-acceptance correction; parent `4260a203`)
**PR:** #5 (draft — NOT merged, NOT deployed)
**Date:** 2026-11-08

## 1. The acceptance question

Previous evidence (head `472903f2`) proved that a stateful session model returns
404 when a session reaches a different instance, and that clients recover by
re-initializing. That does NOT prove a client can complete real work when EVERY
request is routed to a different instance. This gate closes that gap.

## 2. Acceptance test — PASS (10/10, corrected dispatch-order trace)

`tests/accept-mcp-routing.mjs` — deterministic, bounded, real SDK client:

- Two independent Node processes (A and B) run the **actual** `api/mcp.mjs`
  handler in the new stateless mode. No shared memory.
- A single proxy URL (`tests/helpers/alternating-proxy.mjs`) alternates **EVERY
  forwarded request** — POST, GET, DELETE, notifications, retries, teardown —
  between A and B in **strict dispatch order**, using **ONE shared monotonically
  increasing dispatch counter** (odd/even → A/B). The sequence number and
  backend are assigned **synchronously at dispatch time** before any async
  forwarding. No per-method counters, no session pinning, no hidden recovery.
- The client is the **real @modelcontextprotocol/sdk 1.32.0**
  `StreamableHTTPClientTransport` + `Client` (no mocks, one proxy URL, no
  backend pinning, no harness-side recovery).
- Acceptance asserts **successful operation results**, not just absence of
  errors: `initialize` must resolve, `tools/list` must return 13 tools, and two
  read-only tool calls (`ping` → "ok", `get_protocol_info`) must complete.
  Whole flow must finish inside a **bounded 60s deadline**.

Result (1.95 s elapsed, all 10 assertions PASS) — full dispatch-order trace
(every request logged, including the SSE GET and no teardown DELETE emitted by
the SDK in stateless mode):

```
dispatch#1 seq#1 POST initialize                  -> :A 200 60ms
dispatch#2 seq#2 POST notifications/initialized  -> :B 202 39ms
dispatch#3 seq#3 GET (SSE, no session id)         -> :A 200  9ms (stream kept open)
dispatch#4 seq#4 POST tools/list                  -> :B 200 26ms (13 tools)
dispatch#5 seq#5 POST tools/call ping            -> :A 200 11ms (content "ok")
dispatch#6 seq#6 POST tools/call get_protocol_info -> :B 200 13ms
- traffic spanned BOTH instances (A and B)
- no 404/5xx in the acceptance flow (statuses 200,202,200,200,200,200)
- STRICT GLOBAL A/B alternation over EVERY forwarded request (dispatch order): A,B,A,B,A,B
- open SSE streams recorded without failing the flow (GET count=1, status 200)
```

The POST-only subset in this trace reads A,B,B,A,B — expected under a single
global counter, because the SSE GET (dispatch #3) interleaves between POST #2
and #4. `A,B,A,B,A,B` over ALL requests is the assertion that matters; a
per-method alternation assertion would reintroduce the method-specific-counter
mistake this correction removes (see §2.1).

Run: `node tests/accept-mcp-routing.mjs` (local only; not live financial).

### 2.1 Previous method-specific-counter mistake (corrected in `b75fccbd`)

Two successive harness defects produced misleading traces; the application was
correct throughout (all SDK operations always succeeded):

1. **Original defect (fixed in `4260a203`):** earlier harnesses logged 5
   requests while omitting the still-open SSE GET (buffered with
   `arrayBuffer()`, which never resolves), and the "strict alternation" claim
   was unchecked — the old assertion only checked "some toggle".
2. **Method-specific counters (introduced in `4260a203`, removed in `b75fccbd`):**
   to make the visible POST sequence strictly A/B, the proxy used **separate
   POST and non-POST counters** plus session pinning, and the test asserted
   alternation over POSTs only. POST-only alternation passed — but the agreed
   requirement is **strict alternation across EVERY forwarded HTTP request**,
   and that had never been verified under the separate-counter design.

The corrected proxy uses **ONE shared dispatch counter for every method**
(odd/even → A/B), assigns the sequence and backend synchronously before async
forwarding, pipes SSE live (never buffers), records every dispatch immediately
even while a response is open, and separates status/completed/abort fields.
The test now asserts **strict global alternation over the complete dispatch
trace** (A,B,A,B,A,B), keeps operation success separate from stream-close
behavior, and captures any teardown requests in the trace.

## 3. Implementation change — stateless per-request mode

`api/mcp.mjs` gains a stateless dispatch path (opt-in via
`SAAX_MCP_MODE=stateless`; the env is read ONCE at module load — flipping it
requires a redeploy, documented in the deployment plan). The SDK's
`StreamableHTTPServerTransport` is explicitly designed for this
(`sessionIdGenerator: undefined` disables session validation —
`webStandardStreamableHttp.js` `validateSession()`: "If the sessionIdGenerator
ID is not set, the session management is disabled"). Each HTTP request:

1. Creates a fresh `McpServer` + transport (SDK requirement: a stateless
   transport must not be reused across requests — message ID collisions).
2. Parses the JSON-RPC body and calls `transport.handleRequest(req, res, body)`.
3. Closes the transport in `finally` after the response completes.

Per-request identity comes from HTTP headers (X-SAAX-Email /
X-SAAX-Session-Email), not from a process-local session map. Tool closures
share only module-level read caches (plain synchronous Maps). **No request can
close another request's transport** — each owns its own.

Default remains `stateful`, preserving all existing session-based behavior
(verified: every stateful suite still passes — cross-instance 19/19, isolation
15/15, transport 6/6, stale 6/6, race 5/5, SDK-client 6/6, financial-boundary
6/6, streaming 6/6).

### Why stateless is the right model here

- Vercel has **no sticky-session routing guarantee** for `/mcp` (plain rewrite;
  no session-affinity config). A database-backed session map cannot preserve a
  live transport or in-flight process state across instances.
- The SDK client tolerates the open SSE GET at connect (it does not block
  connect on a priming event), and POSTs carry `mcp-protocol-version` after
  initialize — stateless non-init POSTs validate (verified by the acceptance
  run: `notifications/initialized` → 202, `tools/list` → 200).
- **Durable financial identity does not depend on sessions.** Commitment IDs
  and idempotency keys are deterministic and persisted in Supabase; retries
  reconcile against the same row regardless of which instance serves them
  (financial-boundary suite, 6/6 — a session-loss retry with the same identity
  yields exactly one row; different identity yields an independent row).

## 4. Surface behavior in stateless mode (probe)

`tests/_probe-stateless-get.mjs` (temporary probe, removed before commit):

- Plain GET `Accept: application/json` → **200 application/json** (friendly
  info, preserved by a guard before the stateless branch).
- GET SSE `Accept: text/event-stream` → **200 `text/event-stream`**, stream
  held OPEN with no events for 10 s (probe read timed out; client must cancel
  to close it). There is no session to resume in stateless mode (server sends
  no `Mcp-Session-Id`), and the SDK's `handleGetRequest` supports an idle SSE
  stream per fresh transport (no 409 because each request gets a fresh
  transport whose `_streamMapping` is empty). The SDK client tolerates this —
  it only uses GET SSE for resumption, not for connect.
- **Session-dependent capabilities (resumption via `Last-Event-ID`, GET SSE
  continuation of a specific session) are NOT supported in stateless mode**:
  each request is a fresh transport with no session state, so there is nothing
  to resume. Cancellation: when a client cancels, the stream is destroyed by
  the transport teardown in `finally`. These limits are inherent to the
  stateless model and are distinct from the preserved stateful mode, which
  keeps full session, SSE-resume, and DELETE-session semantics (verified by the
  stateful suite). Clients that require server-push notifications or resumable
  streams must use stateful mode (default) or a host with session affinity.
- **Identity/authorization in stateless mode:** request identity is read from
  HTTP headers (`X-SAAX-Email` / `X-SAAX-Session-Email`) shared into the per‑request
  server via the `__request__` key in `sessionIdentityStore`, or passed as the
  `subscriptionEmail` tool argument. Both paths validate against the
  subscriptions table via `gatePremium` (no active subscription → explicit
  `payment_required` response). Arbitrary headers are NEVER treated as trusted
  identity — a caller-supplied email only gates access after an active
  subscription lookup succeeds. There is no unauthenticated path that mutates
  financial state: MCP tools are read-only (route_request ranks suppliers,
  get_commitment reads, list_* reads; settlement stays on the HTTP `/route`
  endpoint).

## 5. Labels and corrections (per review)

- **`tests/repro-mcp-financial-boundary.mjs` is persistence-deduplication
  evidence, NOT exactly-once payment execution proof.** A single row proves the
  durable store deduplicated the write; it does not prove a payment rail
  executed once. The suite name and this addendum both state that boundary.
- **SDK automatic recovery vs harness-implemented recovery:** the SDK client
  does NOT automatically re-initialize a session on a POST 404 — its
  reconnection logic is SSE-resume-only and finite (`maxRetries: 2`). The
  acceptance test passes because the stateless server never returns a 404 to a
  valid JSON-RPC request; clients genuinely complete work without any
  reinitialization. The earlier SDK-client suite (C1-C4) demonstrates the
  harness-initiated recovery path explicitly and labels it as such.
- **`maxDuration: 60`** is the observed **configured** limit in
  `api/mcp.mjs` (`export const config = { runtime: "nodejs", maxDuration: 60 }`).
  No platform-wide limit is independently established; reported as configured,
  not inherent.

## 6. Regression results (this gate)

| Suite | Result |
|---|---|
| accept-mcp-routing (new, stateless, real SDK client, alternating proxy) | 10/10 |
| repro-mcp-cross-instance (stateful) | 19/19 |
| repro-mcp-isolation | 15/15 |
| repro-mcp-transport | 6/6 |
| repro-mcp-stale | 6/6 |
| repro-mcp-race | 5/5 |
| repro-mcp-sdk-client | 6/6 |
| repro-mcp-financial-boundary (persistence dedup) | 6/6 |
| test-mcp-get-streaming | 6/6 |
| test-telemetry-integration | 6/6 |
| test-telemetry-http | 6/6 |
| store-delete-filter | 14/14 |
| mcp-recovery | 12/12 |
| lost-response-recovery | 8/8 |
| pilot-default-off | 12/12 |
| conformance (run-conformance.mjs) | 94/94 |

All pass. Nothing weakened.

## 7. Remaining limitations (honest)

- **Verified locally only.** Production still runs the pre-fix (stateful)
  handler; `SAAX_MCP_MODE=stateless` is NOT set in production. Production
  verification of the stateless path requires the controlled deploy.
- **SSE/streaming note:** stateless mode serves GET SSE as an idle stream but
  does not support session resumption or session-scoped notification streams
  (no session state across requests). Verified in the stateful (default) mode;
  stateless clients receive POST responses with full tool results.
- **`maxDuration: 60`** is the **configured** limit (`export const config`),
  not a platform-wide guarantee; documented as configured, not inherent.
- Telemetry delivery remains **best-effort** (fire-and-forget). Request counts
  derived from telemetry are potentially incomplete; financial totals come
  from authoritative durable records and chain evidence.
- **Live multi-instance financial verification NOT performed** — simulated
  only. This gate proves request routing correctness, not financial
  exactly-once under live production concurrency.

## 8. Hosting assumption

`/mcp` on Vercel has no sticky-session routing. Stateless mode removes the
dependency on process-local session state entirely. If a future host provides
session affinity, the stateful path remains available (default) and both modes
are verified.

## 9. Working-tree inventory reconciliation (597 → 602 → 604)

The reported "597 vs 602 dirty entries" was a **counting-method artifact**, not
a change in unrelated files.

- `git status --porcelain=v1` (collapsed-untracked, the only stable machine
  readable format used across runs) counts **one line per untracked directory
  or file**. Expanded (`-uall`) counts **every untracked file** — this run
  `1893` lines. Different totals across prior gates (555/556/557/562/597/602)
  are the same tree measured with different collapse states as scratch files
  were added/removed by other tasks.
- This run's snapshots (same command, same options):
  - Before edits: **602** = 50 modified + 552 untracked (collapsed).
  - After my two test edits: **604** = 52 modified + 552 untracked.
  - After committing those two files: **602** = 50 modified + 552 untracked.
- The two task-owned changes are exactly `tests/helpers/alternating-proxy.mjs`
  and `tests/accept-mcp-routing.mjs` (both tracked, committed in `b75fccbd`).
  No unrelated path changed status in this run.
- Limitation: no byte-level before/after inventory of the 552 untracked files
  survives from earlier runs (only aggregate counts in gate docs:
  557 @ Gate D.1, 562 @ Gate D.3). Exact preservation of every unrelated
  file cannot be proven from an aggregate count alone; `git status` deltas
  over this run, plus the unchanged 552-untracked count, are the available
  evidence. A fresh baseline captured before this correction (`602` =
  50 M + 552 ??) was re-verified after (`602` = 50 M + 552 ??) — identical.
