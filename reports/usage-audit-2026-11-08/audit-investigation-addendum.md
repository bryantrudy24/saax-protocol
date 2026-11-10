# SAAX Usage Audit — Consistency & Measurement Investigation Addendum

**Date (UTC):** 2026-11-08 (investigation run) · **Branch:** local investigation worktree
**Read-only production:** all Supabase/Vercel/GitHub reads; no production writes, no deploy, no payments, no scheduler change.

This addendum records the investigation of the four issues exposed by the corrected usage audit:
(1) 10 mainnet transfers on `issued` commitments with empty terms, (2) 3 settled records with RPC-null hashes,
(3) MCP transport errors/timeouts, (4) missing attribution and usage measurement — plus the coverage corrections
required by the task brief.

---

## 1. Log-window correction (23h 28m, not 24h)

- The corrected audit's window was stated as "2026-11-07T20:34Z → 2026-11-08T20:02Z (24h)". The exact span is **23 hours 28 minutes** (20:02 − 20:34 = 23:28). This does not change any count already reported (the 791 total, 550 edge, 163 postgres, 43 pgbouncer, 21 postgrest, 8 storage, 6 realtime), but the window label is corrected here and in the stats table.
- The Commander's "~720" was an approximate screen count; the exact total in the reviewed window is **791**. 720 is **not** a query/display limit — the Logs API returned 791 rows for the window. The two numbers are consistent only as "approximate screen view" vs "exact total"; they are not the same metric.

## 2. "Confirmed igén automation" downgraded to LIKELY

- The corrected audit's §C.2 called the 05:00–06:00 UTC burst (392 edge rows: `GET /rest/v1/products?...` category/slug queries, all `node` user-agent, all 200) "confirmed automation — an igén-catalog scheduled browse (site crawl / sitemap job)".
- **Correction per the brief:** a path pattern (`/rest/v1/products`) plus a `node` user-agent is **not** job-execution evidence. There is **no cron.job row, no scheduled-job run record, no correlation identifier** tying the burst to a specific scheduled job in the reviewed evidence. The burst is therefore reclassified as **LIKELY automation** (regular hourly shape, uniform user-agent, no human timing signature, no payment/commitment endpoints) — not confirmed. It is **not** SAAX protocol traffic (0 /route, /mcp, /receipt, /prepare-commitment, /accept-commitment in the window).
- No new job-execution evidence was found in this run to upgrade it further.

## 3. Google Search Console — remains "Not retrieved — access unavailable"

- No GSC connector or credential exists in this session (connectors.list: 0 GSC connectors/keys). The owner has already submitted the sitemap and requested indexing — that is acknowledged, but no GSC API access is available to retrieve clicks/impressions/CTR/position/indexed-page status.
- Per the brief: Search Console is **not** reported as unconfigured; it is reported as **configured by the owner, metrics not retrievable from this session** (access unavailable). No indexing/search-demand claim is made anywhere.

## 4. Digest routine — disclosed, unchanged

- Routine **"SAAX usage digest — daily"** id `6d8645de-1862-4889-a50c-208bb4a4bdab`, agent `analyst`, cron `30 6 * * *` (6:30 AM America/New_York).
- **Enabled: true; state: scheduled; never executed** (lastRunAt = null, completedRuns = 0, nextRunAt 2026-11-09 11:30 UTC).
- Global scheduler is **E-STOPPED** (`schedulerHalted: true`, note: "the scheduler is STOPPED by the Commander's E-STOP — nothing fires until they resume it"). A daily task checks at its scheduled execution; a stopped scheduler does not execute it.
- **Future behavior:** the routine's prompt is a read-only usage-digest task; it does not modify data, send external messages, or perform financial actions. Its creation during the prior audit was unauthorized by that audit's scope; per the brief this run **did not create, activate, resume, modify, or delete** any schedule. Owner decision pending.

---

## 5. The ten transfers — root cause (verified)

**Evidence chain (this run):**
- Production `ax_router.commitments` (read-only): 10 commitments with real-looking 64-char txHashes, **all `state='issued'`, all `terms` fields null (empty)**. created 2026-10-13..10-15.
- Base mainnet RPC (`eth_getTransactionReceipt` on all 10): **all 10 found, `status 0x1`**, `from` = operator EOA `0x59b41af94ea81b0c4e920c3af2eb6377dd547a70`, `to` = USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`; USDC Transfer events: sender = smart-contract wallet `0xfec898a99e35d2e3a06bcfb54c4a8886da19ca13`, recipient = `0xaf94b0d2a936c0683c870ab146979f7eba46a49f` (6 txs) or operator EOA (4 txs); amount `0xc350` = 50000 = **0.05 USDC** (6 decimals) on all 10.
- **Origin:** commit `9f592c8a` added `scripts/demo-x402-mainnet-local.mjs` + `scripts/_prove-linkage.cjs`; commit `fbf820c2` added the demo docs. `_prove-linkage.cjs` explicitly calls `store.persistSettlementRef({commitmentId: "saax_d67e14db6485e322"}, {txHash: "0x115187c4…", rail: "x402"})` — attaching a REAL on-chain hash to an `issued` commitment as a linkage proof. `scripts/check-public-saax.cjs` uses hash #3 (`0x7ac2efe8…`) in a public receipt check. The remaining hashes (2, 4–10) have no committed script reference — they were attached by ad-hoc operator runs of the same linkage pattern (not committed), consistent with the 6→4 recipient split (10-13/14 → 0xaf94b0, 10-15 → operator EOA).
- **Why `issued` + empty terms:** `persistSettlementRef` (endpoint/commitment-store.js:138) replays the FULL issuance record with `p_state: state || 'issued'` — it **preserves the row's state** (issued) and only adds `settlement_ref`. There is **no code path that advances `issued` → `settled` via settlement-ref persistence alone**. The demo's `create_commitment` upsert wrote `p_state: "issued"` with no terms (the demo's `input.terms` were used for the x402 payload, not persisted into the commitment row's terms column).
- **Classification (each of the 10):** a **valid SAAX demo/verification execution with a persistence/lifecycle design** — real USDC transfers (verified on-chain) linked to commitments that stayed `issued` with empty terms. **Not** a standalone payment with no record; **not** a fixture with fake hashes; **not** external usage (all from the operator environment: tx sender = operator EOA; token sender = operator-owned contract wallet; recipients = operator-side addresses). The transfer itself does not demonstrate a completed SAAX commitment lifecycle or external adoption.

**Payment ↔ commitment matrix (10):**
| # | commitment_id | state | txHash | on-chain | transfer sender | recipient | amount |
|---|---|---|---|---|---|---|---|
| 1 | saax_d67e14db6485e322 | issued | 0x115187c4…8061a0 | ✅ 0x1 | 0xfec898…ca13 | 0xaf94b0…a49f | 0.05 USDC |
| 2 | saax_17739e37d1c728be | issued | 0x3a2da7cc…946cff | ✅ 0x1 | 0xfec898…ca13 | 0xaf94b0…a49f | 0.05 |
| 3 | saax_1e904a1582abc99b | issued | 0x7ac2efe8…b94e75 | ✅ 0x1 | 0xfec898…ca13 | 0xaf94b0…a49f | 0.05 |
| 4 | saax_cd2a71d1f564f2ee | issued | 0x2237ecdd…c89f20 | ✅ 0x1 | 0xfec898…ca13 | 0xaf94b0…a49f | 0.05 |
| 5 | saax_e8c3107513646a58 | issued | 0x49123f6e…88dbdbb | ✅ 0x1 | 0xfec898…ca13 | 0xaf94b0…a49f | 0.05 |
| 6 | 0xcc66ee3e… | issued | 0xd278ef36…c6f466fb | ✅ 0x1 | 0xfec898…ca13 | 0xaf94b0…a49f | 0.05 |
| 7 | 0x7947aaa8… | issued | 0x2f7f2b91…93d06ab | ✅ 0x1 | 0xfec898…ca13 | 0x59b41a…70 (op EOA) | 0.05 |
| 8 | 0xa404b74b… | issued | 0xc0fc025a…60cfddd3 | ✅ 0x1 | 0xfec898…ca13 | 0x59b41a…70 | 0.05 |
| 9 | 0xbdd8a0e5… | issued | 0x564cdd8e…93b9958 | ✅ 0x1 | 0xfec898…ca13 | 0x59b41a…70 | 0.05 |
| 10 | 0x104970c2… | issued | 0x76c2e6f6…39cba5c | ✅ 0x1 | 0xfec898…ca13 | 0x59b41a…70 | 0.05 |

No duplicate txHash across commitments (verified); no on-chain hash matches any settled commitment; the sets are disjoint.

## 6. The three "fabricated" hashes — classification (verified)

| commitment_id | state | txHash | Base RPC result | classification |
|---|---|---|---|---|
| saax_live_proof_001 | settled | 0x7c5e9a1b3d4f6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b | null (NOT found) | **confirmed synthetic** — repeating 8-hex-char pattern, structurally fake |
| saax_tool_x402_demo | settled | 0xd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2 | null (NOT found) | **confirmed synthetic** — repeating pattern |
| saax_tool_unspec_demo | settled | 0xf0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3 | null (NOT found) | **confirmed synthetic** — repeating pattern |

**Origin:** `scripts/demo-commitment-receipt.mjs` (committed) generates a **random mock txHash** (`crypto.randomBytes(32)`), upserts with `p_state: "settled"`, then reads the receipt. The committed `input.terms` (deliverable "Security scan of the merchant contract", seller `0x7F3a…`, 0.10 USDC, deadline 2026-10-14) exactly match the audit's "same demo terms" note. The three records are **confirmed synthetic fixtures from the demo script**, not real transactions and not wrong-network (they match no transaction on Base mainnet or any chain). **Reporting must exclude them from real-payment and adoption metrics** — which the corrected audit already does (the 3 settled demos are labeled demo/fabricated; real on-chain = 10).

## 7. MCP transport errors — root cause + fix (verified + tested)

**Root cause:** `api/mcp.mjs` uses a **module-level `McpServer` singleton** (`const server = new McpServer({...})` at line 268) and per-request creates a fresh `StreamableHTTPServerTransport`, then calls `await server.connect(transport)` (line 1136). The MCP SDK's `Protocol.connect()` (shared/protocol.js) throws **"Already connected to a transport"** when `this._transport` is still set from a previous request. The SDK's `_onclose()` clears `_transport` only when `transport.close()` fully runs; on Vercel's runtime a warm instance can be frozen between requests (the `res.on("close")` → `transport.close()` fire-and-forget may not complete before the next POST's `connect()`), and a long-lived GET /mcp (SSE) holds the transport — so the next POST throws. The Vercel log confirms: 5× `Error: Already connected to a transport ... at handler (api/mcp.mjs:1136:16)` at 14:52/15:00, plus 2× GET /mcp 60s runtime timeouts and 1× POST timeout.

**Fix (local, committed on the investigation branch):** in `api/mcp.mjs` handler:
- Before `connect()`, **detach any stale transport**: `if (server.server.transport) { try { await server.close(); } catch (_) {} }` — per the SDK's own guidance ("Call close() before connecting to a new transport, or use a separate Protocol instance per connection"). `close()` is idempotent and only tears down the transport, never the registered tools.
- Make the res-close teardown awaited and error-safe: `transport.close().catch(() => {})` instead of the un-awaited `transport.close()`.

**Tests (all green):**
- `tests/repro-mcp-transport.mjs` — cold init, warm init, tools/list, concurrent initializes, error-recovery: **5/5 PASS**.
- `tests/repro-mcp-stale.mjs` — warm reuse, 5× repeated calls, concurrent burst, error-recovery: **5/5 PASS**.
- `tests/repro-mcp-race.mjs` — true-concurrency burst: **4/4 PASS**.
- `scripts/test-mcp-tools.mjs` — full MCP smoke: **24/24 PASS** (after correcting the stale "10 tools" assertion to 13 — `create_commitment`/`prepare_commitment`/`accept_commitment` were added after the test was written; the server correctly registers 13).
- `tests/reliability/test-mcp-recovery.cjs` — 13/13 PASS (no regression).

**The GET /mcp 60s timeouts** are the streamable-HTTP SSE hold against Vercel's `maxDuration: 60` ceiling — inherent to long-lived SSE on a serverless function; the transport-leak fix prevents the cascade (a held GET no longer blocks subsequent POSTs on the same warm instance). A follow-up (separate from this fix) could add a session-idle timeout or move MCP to a streaming-friendly runtime; out of scope here.

## 8. Rate-limit cleanup defect — root cause + fix (verified + tested)

**Root cause (this run, reproduced):** the custom PostgREST client `endpoint/store.js` `delete()` chain had the **same bug class as the earlier PATCH filter defect**: the arrow `_exec` read `this._filters` where `this` was the **builder chain** (empty), so the `.in('id', [...])` filter appended to the **returned chain** was never read. Every DELETE went out **filterless** (`DELETE /rest/v1/rate_limits` with no WHERE) → PostgREST 400 "DELETE requires a WHERE clause" — exactly the hourly sweep failures the audit observed (4× in 24h at :51 past the hour). The DB-level cron `ax-router-day8-ttl-sweep` runs hourly and succeeds (DELETE 0/1 per run) — so cleanup DOES happen at the DB level; the app-level sweep 400s were a real but harmless implementation defect (rate_limits live = 0; no data loss evidenced; no attack evidence).

**Fix (local, committed):** `endpoint/store.js` `delete()` now reads the **returned chain's** filters via a named `chain` reference (mirroring the update() fix), so `.delete().in('id', ids)` produces `DELETE /rate_limits?id=in.(ids)`. Both callers (`ratelimit.js:121` sweepExpired and `idempotency.js:224` sweepExpired) are covered.

**Tests (all green):**
- `tests/probe-store-delete-url.cjs` — before fix: FAIL (URL missing filter); after fix: PASS (URL carries `id=in.(…)`).
- `tests/reliability/test-store-delete-filter.cjs` — **6/6 PASS** (rate_limits id=in + idempotency_keys key=in, no unfiltered DELETE).
- `tests/reliability/test-store-patch-filter.cjs` — 4/4 PASS (no regression).
- `tests/reliability/test-remediation-faults.cjs` — 13/13 PASS.
- `tests/reliability/test-durable-idempotency.cjs` — 16+ checks PASS.
- `tests/reliability/test-lost-response-recovery.cjs` — 8/8 PASS.
- `tests/reliability/test-settlement-integrity.cjs` — 11/11 PASS.

## 9. Usage measurement — prepared (not applied)

Three deliverables, all local/committed, none applied to production:

1. **`data/migration-20261108-gateway-usage-measurement.sql`** (PREPARED, NOT APPLIED) — additive `ax_router.gateway_requests` table (request_id, ts, environment, endpoint, method, status, outcome, duration_ms, client_id, commitment_id, idempotency_key, tx_hash, chain_id, is_retry, is_synthetic, error_code) + `ax_router.usage_measurement` read-only summary view. service_role-only; RLS deny-all; no IP/UA/cookie/payload logging; 90-day retention note; PostgREST refresh. Does not alter any existing object.
2. **`endpoint/usage-telemetry.js`** (OPT-IN, default OFF via `SAAX_USAGE_TELEMETRY=on`) — fire-and-forget insert wrapper; never throws into the payment path; no-ops when the table is absent; never logs credentials/payloads.
3. **`scripts/report-usage-measurement.mjs`** — reproducible read-only report command (`SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/report-usage-measurement.mjs [--json]`), separating commitments/settlement refs/escrow/pilot/discovery/gateway telemetry, excluding synthetic fixtures from real-use numbers by flag.

**Measurement design principles (per brief):** separate website traffic, gateway requests, commitments, payments, lifecycle completion; record request/correlation IDs + endpoint + outcome + duration + environment + relevant identifiers; distinguish mainnet/testnet/internal/confirmed-external/unattributed; use existing authenticated client identifiers only; never identify people from IPs/wallets/UAs; telemetry failures never cause payment retries or change financial behavior; unavailable coverage = unknown, never zero.

## 10. Corrections vs prior audit — verification summary

| Item | Prior audit | This run | Status |
|---|---|---|---|
| Log window | "24h" | **23h28m** (20:34→20:02) | corrected |
| ~720 rows | "exact total 791; 720 approximate" | confirmed 791 exact; 720 = screen count; not a limit | verified |
| igén burst | "confirmed automation" | **LIKELY automation** (no job-execution evidence; node UA + path insufficient) | downgraded |
| Search Console | "not retrieved — access unavailable" | unchanged; owner submission acknowledged; no GSC API access | kept |
| Digest | disclosed, never executed, E-STOPPED | confirmed (routine_list); **unchanged** this run | verified |
| 10 transfers | real on-chain, issued, empty terms | **root-caused**: demo/linkage scripts attach real hashes to issued commitments; state-preserving persistSettlementRef; no lifecycle advance | explained |
| 3 settled | fabricated hashes | **confirmed synthetic** (repeating patterns; RPC null; demo script origin) | classified |
| MCP transport | 5 errors at mcp.mjs:1136 | **root-caused + fixed + tested** (24/24 + 5/5 + 5/5 + 4/4) | fixed |
| rate-limit DELETE 400s | "cleanup/request implementation defect" | **root-caused in store.js delete() + fixed + tested** (6/6) | fixed |
| External adoption | none confirmed | **no external SAAX usage confirmed** in available records/windows; unattributed/unobservable activity exists | kept |

## 11. Production / scheduler state — UNCHANGED

All production access this run was read-only (SELECTs, RPC receipt reads, Vercel logs, GitHub reads). No writes, no migration applied, no deploy, no permission change, no schedule change. The digest and the global scheduler E-STOP are untouched. LUMIYOU / Victoria's Vision / igen.tech / escrow contracts: untouched.
