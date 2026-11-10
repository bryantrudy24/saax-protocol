# SAAX Verification-Gap Closure — Investigation Addendum (Gate review)

**Date (UTC):** 2026-11-08 (verification run) · **Branch:** `investigation/consistency-mcp-measurement`
**Base commit:** `b4c4e783` · **Work:** local only — no merge, no deploy, no production migration, no telemetry enablement, no payment, no scheduler change.

This addendum supersedes the earlier `audit-investigation-addendum.md` §7 (MCP transport fix) and §9 (telemetry) claims with **verified** results, corrects the test-count discrepancy (13/13 vs 12/12), and records the new per-session MCP design, the DELETE-filter safety guard, and the telemetry wiring proof.

---

## 1. MCP concurrency safety — design change (verified)

### 1.1 Why the previous fix was unsafe

The previous handler (`b4c4e783`) used:
- a **module-level `McpServer` singleton** (`const server = new McpServer(...)`),
- a **fresh stateless transport per request** (`sessionIdGenerator: undefined`),
- a **pre-connect `server.close()`** to detach any attached transport.

SDK evidence (installed `@modelcontextprotocol/sdk@1.32.0`):
- `shared/protocol.js:219-221`: `connect()` **throws** `"Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection."` — a Protocol owns exactly ONE transport.
- `server/mcp.js:87-94`: `McpServer.connect`/`close` delegate to the single underlying Protocol.
- `server/webStandardStreamableHttp.js:170-179`: a **stateless** transport (no `sessionIdGenerator`) **throws** `"Stateless transport cannot be reused across requests"` on reuse — each request needs its own transport, which conflicts with a shared server.

Therefore the previous `close()`-then-`connect()` pattern could **close another request's active transport**: on Vercel's warm instance, request A's `res.on('close')` → `transport.close()` → `server.close()` tears down the module-level server's currently-attached transport — which may be request B's transport if B connected first. The SDK's own `simpleStreamableHttp` server example instead uses **one server + transport per session**, keyed by `Mcp-Session-Id`.

### 1.2 The fix (implemented, tested)

`api/mcp.mjs` now implements the SDK's session-ownership model:
- `createSessionServer()` factory — builds a **fresh `McpServer` per session** and registers all 13 tools on it (module-level tool-closure state — `commitmentStore`, `sessionIdentityStore` — are plain sync Maps shared read-only; safe).
- `sessions: Map<sessionId, { server, transport, open, lastActive }>` — **per-session transport + server**, created on the initialize POST (`sessionIdGenerator: () => crypto.randomUUID()`), stored in `onsessioninitialized`.
- Existing-session POST/GET: looks up by `Mcp-Session-Id` and reuses that session's transport — **no cross-session close possible**.
- `DELETE /mcp` closes only the named session.
- `closeSession()` / `sweepIdleSessions()` (15-min idle, 500 max) — bounded lifecycle; teardown never touches another session.
- Missing/sessionless non-initialize POST → 400; unknown session → 404; >MAX sessions → 503 (per SDK example contract).

### 1.3 Tests (all green, 62 MCP checks)

| Test | Result |
|---|---|
| `tests/repro-mcp-isolation.mjs` (**new**) | 15/15 — overlapping A/B complete independently; abort of A doesn't break B; failed request doesn't poison; teardown of A leaves B alive; slow A doesn't block B; sessionless POST 400; unknown session 404; DELETE scoped |
| `tests/repro-mcp-transport.mjs` (rewritten, session-based) | 6/6 — cold init, warm init distinct sessions, tools/list after reuse, concurrent inits, error recovery |
| `tests/repro-mcp-stale.mjs` (rewritten, session-based) | 6/6 — warm init, 5 repeated calls, concurrent burst no leaks, error recovery |
| `tests/repro-mcp-race.mjs` (rewritten, session-based) | 5/5 — 6 concurrent inits distinct sessions, all usable, 2× repeat bursts |
| `scripts/test-mcp-tools.mjs` (updated client) | 24/24 — all 13 tools registered + functional + security gates |
| `tests/test-mcp-get-streaming.mjs` (**new**) | 6/6 — plain GET info; SSE requires session; SSE opens on valid session; long GET doesn't block another session; session usable after SSE closes |

### 1.4 GET /mcp streaming and timeouts — explicit

- Plain `GET /mcp` without `Accept: text/event-stream` → friendly JSON info (200) — unchanged.
- `GET /mcp` with `Accept: text/event-stream` + valid `Mcp-Session-Id` → SSE stream (200, `text/event-stream`), per the SDK's `handleGetRequest`; a second concurrent SSE per session → 409 (SDK).
- Vercel `maxDuration: 60` caps the SSE hold at 60s — the earlier observed 60s timeouts are the **platform ceiling**, not transport leakage. The per-session fix removes the **cascade** (a held GET no longer blocks another session's POST on the same warm instance). A client that needs longer-lived server→client streaming requires a streaming-friendly runtime; documented as an operational limitation, not a defect.

---

## 2. Telemetry — integration proof (was: module exists but unwired)

The `endpoint/usage-telemetry.js` module existed at `b4c4e783` but **no gateway handler invoked it** (verified: only self-reference in the tree). Now wired into all three adapters:

- `api/route.mjs` — wraps `handleRoute`; records endpoint `/route`, method, status (captured from `res.writeHead`), outcome, duration, idempotency-key header, x-mock synthetic flag, request id.
- `api/receipt.mjs` — records `/receipt` with txHash from query, status, outcome, duration; safe when `res.writeHead` is absent (unit mocks).
- `api/mcp.mjs` — records `/mcp` initialize / session POST / DELETE / error paths with session id as client id.

Each adapter calls `usageTelemetry.setStoreClient(buildStoreClient())` **only when `isEnabled()`** (i.e., `SAAX_USAGE_TELEMETRY=on` — default OFF), so the default path is byte-identical to before.

### 2.1 Tests

- `tests/test-telemetry-integration.cjs` — T1 default OFF skips; T2 full row fields; T3 failing store returns `{ok:false,skipped:'error'}`, never throws; T4 slow store completes without blocking; T5 retry/synthetic flags; T8 privacy (no credentials/payment payload keys or values in rows).
- `tests/test-telemetry-http.mjs` — H1 MCP handler works with a **failing** telemetry store (init/session/tools/tool-error-shape all normal, no 5xx); H3 request latency unaffected (`elapsed=3ms`); H2 OFF mode initialize normal.
- `tests/receipt-reliability.test.mjs` — 6/6 after the `writeHead` guard (regression caught by this suite: the initial wiring assumed `res.writeHead` exists; unit mocks omit it — fixed).

### 2.2 Delivery honesty

Telemetry writes are **fire-and-forget**: `record()` is awaited nowhere in the response path (each adapter calls `usageTelemetry.record(...).catch(() => {})` without awaiting). On serverless runtimes this is **best-effort** — a write that outlives the response may be lost if the instance is frozen. Documented: reliable delivery would require a supported lifecycle hook (e.g., Vercel `waitUntil`) or an external queue; out of scope here, and the brief's requirement is explicitly "document best-effort delivery and possible loss."

### 2.3 Financial-behavior non-interference (proven)

- Record failures never surface into the HTTP response (H1: 200/200/200 with failing store).
- `isEnabled()` is OFF by default; the table is absent → insert no-ops via store error → swallowed.
- No read of telemetry in any payment path (migration view is service_role-only, no payment code reads it).

---

## 3. DELETE-filter safeguards — verified + one guard added

`endpoint/store.js` `delete()`:
- **Verified** the chained `.in(...)`/`.eq(...)` filters are merged via the named `chain` reference (line 186) — no more filterless DELETE.
- **Added** a fail-closed guard: if the final filter set is empty, `_exec` returns `{ error: new Error('DELETE /<table> refused: no filter chained (would delete all rows)') }` **without issuing any HTTP DELETE**. A filterless DELETE would target the entire table (PostgREST rejects it anyway with 400, but the client must never even attempt it).

`tests/reliability/test-store-delete-filter.cjs` — **14/14**:
- D1–D6: original regression suite (filter present, no root delete, both sweep callers).
- E1/E1b: empty id list still carries `key=in.()` (never a bare DELETE).
- E2/E2b: no-filter delete → refused with error, no HTTP DELETE sent.
- E3: chained `.in()+eq()` both in URL. E4: percent-encoding of special chars (`%27`, `%2C`). E5: exact id set targeted. E6: DB 400 surfaces as error.

---

## 4. Test-count correction (13/13 vs 12/12)

The earlier report's narrative "MCP recovery 13/13" vs table "12/12": the suite `tests/reliability/test-mcp-recovery.cjs` prints **`passed=12 failed=0`** (12 explicit `[PASS]` assertions) + a summary banner. The narrative counted the banner as a check. **Correct count: 12/12.** The suite passes on the new code (re-run this run).

## 5. Historical classification (unchanged, re-verified)

- **10 mainnet transfers** (0.05 USDC each, Base, status 0x1, sender `0xfec898…ca13`, recipients `0xaf94b0…a49f` ×6 / operator EOA ×4): **internal/operator demo activity** — real on-chain transfers linked to `issued` commitments with empty terms (linkage-proof pattern in `scripts/_prove-linkage.cjs`). **Not** lifecycle-completed commitments; **not** synthetic.
- **3 settled "hashes"**: `saax_live_proof_001`, `saax_tool_x402_demo`, `saax_tool_unspec_demo` — RPC null, repeating 8-hex patterns, origin `scripts/demo-commitment-receipt.mjs` (random mock hash). **Confirmed synthetic fixtures** — excluded from real-use metrics (re-verified by `tests/verify-13-hashes.mjs`: found=10/13, missing=3).

---

## 6. Regression results (this run, final)

| Suite | Result |
|---|---|
| MCP isolation (new) | 15/15 |
| MCP transport / stale / race | 6/6 · 6/6 · 5/5 |
| MCP tools smoke | 24/24 |
| MCP GET streaming (new) | 6/6 |
| MCP recovery (reliability) | 12/12 |
| Telemetry integration / http (new) | 6/6 · 6/6 |
| Receipt reliability | 6/6 |
| Store delete filter | 14/14 |
| Store patch filter | 4/4 |
| Durable idempotency | 19/19 |
| Settlement integrity | 13/13 |
| Evidence boundaries | 10/10 |
| Lost-response recovery (testbed) | 8/8 |
| Reconcile before respond | 18/18 |
| Reconcile concurrency | 14/14 |
| Reconcile restart | 7/7 |
| Remediation faults | 14/14 |
| Pilot default-off | 12/12 |
| Pilot http semantics | 7/7 |
| Pilot limits | 25/25 |
| Pilot limits live | 4/4 |
| E2E reliability | 13/13 |
| Final gate | 7/7 |
| Payment idempotency restart | 4/4 |
| Gate D multi-instance | 22/22 |
| Gate D3 retry-after | 8/8 (T8 fixed) |
| Conformance | 94/94 |

### Environment-dependent note
`test-lost-response-recovery.cjs` (8/8) and `test-pilot-*` require the **local Docker testbed** (`ax_router_db` :5433, `ax_router_postgrest` :3000). Earlier failures were traced to **leaked T8 seed rows** from `test-gate-d3-retry-after.cjs` (its cleanup omitted `wallet(500..510)`), corrupting the shared reservation state. The T8 cleanup fix + testbed reset made all suites pass. The shared `payment_reservations` table is now clean.

## 7. Files changed (task-owned)

- `api/mcp.mjs` — per-session server/transport model + telemetry wiring.
- `api/route.mjs` — telemetry wrapper (guarded writeHead).
- `api/receipt.mjs` — telemetry wrapper (guarded writeHead).
- `endpoint/store.js` — filterless-delete guard.
- `endpoint/usage-telemetry.js` — unchanged (already correct; now actually invoked).
- `tests/repro-mcp-isolation.mjs` (new), `tests/helpers/mcp-client.mjs` (new), `tests/test-mcp-get-streaming.mjs` (new), `tests/test-telemetry-integration.cjs` (new), `tests/test-telemetry-http.mjs` (new).
- `tests/repro-mcp-{transport,stale,race}.mjs`, `scripts/test-mcp-tools.mjs` — session-based client updates.
- `tests/reliability/test-store-delete-filter.cjs` — extended safeguards.
- `tests/reliability/test-gate-d3-retry-after.cjs` — T8 cleanup-hygiene fix.
- `tests/receipt-reliability.test.mjs` — untouched (caught the writeHead regression).
- This addendum.

## 8. Production / scheduler state — UNCHANGED

No production writes, no migration applied, no deploy, no permission change, no schedule change. The digest routine and global scheduler E-STOP remain untouched. LUMIYOU / Victoria's Vision / igen.tech / escrow contracts: untouched. Pre-existing dirty files (evidence/, daily-logs/, landing/, verifier/, data/) preserved uncommitted.

---

## 9. MCP cross-instance verification (INDEPENDENT PROCESSES) — 31/31 checks

**Commit:** `0162e069` (branch `investigation/consistency-mcp-measurement`). Local-only; no deploy, no migration, no telemetry, no payments.

### 9.1 The deployment question

Vercel serves `/mcp` via a plain rewrite (vercel.json) with **no sticky-session routing guarantee**. Session state (`api/mcp.mjs` `sessions` Map) is **process-local memory**; a shared DB would NOT preserve a live transport or in-flight state. Therefore a session initialized on instance A can be routed to instance B, and B must return a protocol-valid 404 (`Session not found`, code -32001) and the client must recover by re-initializing a NEW session. The durable identity that must survive session loss is the **commitment/proposal/acceptance idempotency identity (deterministic commitment ID / idempotencyKey)**, NOT the MCP session ID.

### 9.2 Test 1 — `tests/repro-mcp-cross-instance.mjs` (19/19)

Two independent Node processes (A :19101, B :19102) importing the REAL `api/mcp.mjs` handler — no shared memory — with a deterministic routing oracle:

| Scenario | Expected | Observed |
|---|---|---|
| S1 init on A → same-session request to B | 404 -32001 | 404 -32001 ✓ |
| S2 alternate A/B with reinit on miss | each 404 deterministic; new unique session each time; no hang/5xx | ✓ (ms=3 on unknown) |
| S3 restart A, reuse old session id | 404 (no memory) | 404 ✓ |
| S4 DELETE one session; other survives | scoped teardown | 200/404/200 ✓ |
| S5 SSE open on A; same-session POST to B | 404; A's stream alive | 404 + stream open ✓ |
| S6 abort in-flight on A; reconnect | no poisoning | 200 ✓ |
| S7 concurrent clients A+B | response isolation | both 200 ✓ |
| S8 unknown session → clean error, reinit works | no hang/5xx; new session | ✓ |

### 9.3 Test 2 — `tests/repro-mcp-financial-boundary.mjs` (6/6, isolated testbed)

Session loss MUST NOT duplicate durable financial state. Using the REAL `upsert_commitment` RPC on the isolated Docker testbed (ax_router :3000), the same wire shape the app's client uses (profile headers; supabase-js RPC path does NOT set Accept-Profile/Content-Profile on this PostgREST — the documented reason endpoint/store.js implements its own client):

- F1 first persistence → exactly 1 row (issued).
- F2 retry with same durable identity (new MCP session, same commitment id) → still 1 row (no duplicate).
- F3 cross-process retry (spawned child process does the same upsert) → still 1 row (store dedupes by PK).
- F4 no invented settlement_ref (issued upsert cannot fabricate settlement).
- F5 different identity → independent row (dedupe is keyed, not blanket).
- F6 store reachable + deterministic lookup.

### 9.4 Test 3 — `tests/repro-mcp-sdk-client.mjs` (6/6, real SDK 1.32.0 client)

- C1 real `StreamableHTTPClientTransport` + `Client` connects on A, lists 13 tools.
- C2 raw same-session hop to B → 404.
- C3 re-init on B yields a NEW session; tools work (recovery path; no reuse of dead session).
- C4 SDK reconnect defaults: initial 1s, grow 1.5x, max 30s, maxRetries 2 — finite backoff; the SDK does NOT auto-reinitialize by itself (application decision), so no endless reinit loop within defaults.

### 9.5 Financial-boundary interpretation

The MCP tools do NOT execute payments (payment = POST /route). Their durable side effects (commitment/proposal/acceptance persistence) are deduplicated by deterministic commitment IDs + PK upsert RPCs + idempotencyKey-scoped single-writer stores — **none keyed on the ephemeral MCP session ID**. Session loss therefore cannot cause duplicate persistence or duplicate payment authorization; unknown outcomes remain resolvable through the durable record. This is simulated multi-instance testing — NOT live production financial verification (still requires separate authorization).

### 9.6 Clarification: previous "live gateway checks"

The earlier report's phrase "Live gateway checks" referred to **Vercel production log observation** (`vercel logs saax-protocol.com`, project bryant-s-projects5/ax-router) — which captured the PRE-FIX baseline (5× "Already connected to a transport", 2× GET /mcp 60s timeouts, 1× POST timeout) — plus **local** testbed runs of the NEW code. The new session-based handler has NOT been deployed; production still runs the pre-fix handler (deploy `ax-router-pr4moaioq`). Corrected wording: the fix is **verified locally only**; production observations are the pre-fix baseline.

### 9.7 Hosting assumptions (documented)

- No sticky sessions on Vercel for `/mcp` (plain rewrite; no session-affinity config).
- Sessions are process-local and ephemeral (15-min idle sweep, MAX_SESSIONS=500).
- Clients must tolerate 404 on session loss and re-initialize (finite backoff; new session).
- Durable identity (commitment id / idempotency key) is the recovery authority, not the session id.
- SSE streaming remains capped by Vercel `maxDuration: 60` (platform limit); a held GET no longer blocks other sessions' POSTs.
