# SAAX Documentation & Discovery Alignment Report — Gate J.16, Workstream E

**Date:** 2026-11-15 · **Scope:** public website, README (public + internal), MCP docs,
`/llms.txt`, `/openapi.json`, `server.json`, `mcp.json`, recovery/security docs.
All claims below verified against the live endpoint or the committed source this gate.

---

## 1. Surface inventory (live, verified this gate)

| Endpoint | Status | Content type | Notes |
|---|---|---|---|
| `https://saax-protocol.com/mcp` | 200 | SSE/JSON | initialize OK, protocol 2025-03-26, app 1.0.3, **26 tools** |
| `/llms.txt` | 200 | text/plain | 26-tool list, current URLs, accurate status block |
| `/openapi.json` | 200 | application/json | 3 paths: /route, /health, /receipt; info v1.0.3 |
| `/.well-known/mcp.json` | 200 | application/json | canonical endpoint, registry id, transport |
| `/server.json` | 200 | application/json | registry-format manifest v1.0.4 |
| `/recovery` | 200 | text/html | 26-tool inventory page |
| `/security` | 200 | text/html | accurate security status |
| `/docs` | 200 | text/html | integration guide (public version current) |
| `/spec` | 200 | text/html | versioned specification |

## 2. Alignment results by claim

| Public claim | Verified live | Verdict |
|---|---|---|
| 26 MCP tools | 26 tools in tools/list | **ACCURATE** |
| Conformance 94/94 | 94/94 PASS this gate | **ACCURATE** |
| Registry 1.0.4 latest | server.json v1.0.4; registry listing confirmed prior gates | **ACCURATE** |
| Runtime 1.0.3 | serverInfo version 1.0.3 | **ACCURATE** |
| Protocol 2025-03-26 | negotiated protocolVersion 2025-03-26 | **ACCURATE** |
| x402 immediate payments on Base mainnet | documented; live /route exists | **ACCURATE** (no new claim) |
| Escrow testnet-only | docs/llms consistent | **ACCURATE** |
| EAS anchoring inactive | docs say not activated | **ACCURATE** |
| Financial enforcement OFF | operational state unchanged this gate | **ACCURATE** |
| Security review NOT STARTED | /security consistent | **ACCURATE** |

**No inaccurate public claims found.** The public line is well-maintained (Gate J.13/J.14
corrections landed).

## 3. Corrections applied this gate (candidates)

| File | Change | Reason |
|---|---|---|
| `docs/DEVELOPER-QUICKSTART.md` | 25 tools → 26 (×2), protocol 2025-06-18 → 2025-03-26 | Live inventory + negotiated protocol |
| `examples/mcp-recovery/run.cjs` | 25-tool → 26-tool assertion | Example now passes 9/9 Part A |

## 4. Stale internal-repo content (needs release decision)

The **internal dev repo** (origin/main @ cd6fd913) diverges from the deployed line:

- `README.md`: "10 tools (up from 8)" + "55/55 vectors" (vs public 26 tools / 94/94).
- `landing/docs.md`: MCP section lists 13 tools (vs public 26).
- `api/mcp.mjs` on origin/main: only 13 registered tools (vs public 26).

**Impact:** developers building from the internal repo get a stale surface. The public repo is
correct; this is a sync gap, not a content error in the deployed line.
**Recommendation:** a future release syncs origin/main to the public-main state (requires owner
approval; not performed in this gate).

## 5. Resolved non-finding: "[redacted-secret]" in blog title / llms.txt

Several files display `[redacted-secret]` in the console/terminal (blog HTML title/og/twitter/
JSON-LD, llms.txt line 53, blog index). **Hex verification proves the actual bytes are**
`verifying Discovery-to-testnet finance` (ASCII) — the display is a harness console
**redaction filter** replacing byte patterns that look secret-like. Both the worktree and the
live page are clean:

- Worktree title hex: `...617574686f72697a6174696f6e3a20766572696679696e67...` (": verifying")
- Live page: same (char-by-char ASCII confirmed).

**This also closes the Gate J.13 "R5 tool-description mojibake" finding** — same display
artifact, not real content corruption. Documented so future gates do not reopen it.

## 6. Tool-name/schema accuracy

All 26 tool names and their input schemas were captured from live `tools/list` this gate
(`_j16-tool-schemas.json`). The docs' examples reference real tool names and argument shapes:

- `create_commitment(buyerId, sellerId, terms, acceptanceCriteria, evidenceRequirements,
  recoveryPolicy, settlementRail)` — matches live schema.
- `resume_commitment(commitmentId, agentId, role, proof, action, idempotencyRef,
  expectedVersion, authorityRef, evidenceRef)` — matches live schema.
- Recovery tools require `proof` + `agentId` + `role` — matches the authorization model proven
  by the harness suites.

**No doc example advertises a tool or capability that does not exist.**

## 7. MCP / x402 / AP2 / ACP comparisons

Public docs (docs.md, llms.txt, blog) consistently frame SAAX as a **complement** to these
ecosystems, not a replacement: "It is not a payment rail, identity provider, oracle,
marketplace, or escrow custodian." Verified accurate — no overclaim found.

## 8. Open items for owner

- Internal-repo sync (README/docs/api) to the deployed line — **release decision**.
- `scripts/test-mcp-tools.mjs` (13-tool smoke) — mark superseded or update — **low-priority
  cleanup**.
- Public sandbox / demo instance with pre-provisioned authorizations — **future gate**.
