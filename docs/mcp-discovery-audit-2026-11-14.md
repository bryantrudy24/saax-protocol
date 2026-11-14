# SAAX MCP Discovery & Refresh — Audit Report (2026-11-14)

**Status: DISCOVERY FIXES PREPARED AND VERIFIED — AWAITING OWNER APPROVAL**
**Authorization: research/testing/development/preparation only. No production change made.**

## 1. Executive Summary

Three discovery areas were investigated with live evidence. Two genuine, verifiable defects were found and candidate fixes prepared in an isolated worktree (`feature/mcp-discovery-audit` from the deployed base `e92e77b4`):

1. **llms.txt is stale** — claims "13 tools" while the live MCP endpoint serves **26 tools**; the MCP endpoint line references the non-canonical `www.` hostname and omits the machine-readable discovery files. **Candidate fix prepared** (llms.txt updated).
2. **`/.well-known/mcp.json` does not exist** — an emerging machine-readable discovery convention that downstream directories and MCP clients use to find server metadata. **Candidate fix prepared** (new public-safe discovery document + vercel.json rewrite).
3. **OPTIONS preflight returns 405 on `/mcp`** — a CORS compatibility defect for browser-based MCP clients that send preflight with the `Mcp-Session-Id` header. Root-caused to Vercel platform-level OPTIONS rejection on function routes; the application handler's 204 never executes. **Candidate fix documented** (requires a verified platform-level routing change; NOT applied).

The **official MCP registry has NO record for `io.github.bryantrudy24/saax-protocol`** (verified: v0.1 exact lookups 404 on all 4 path variants; paginated list absent). The site's `/server.json` serves version **1.0.4** with correct canonical metadata — the metadata is ready but **publication has not occurred** (requires owner GitHub OAuth via `mcp-publisher login`). This is the single highest-leverage discoverability gap.

## 2. Production Baseline (verified live, read-only)

| Item | Value |
|---|---|
| Production MCP endpoint | `https://saax-protocol.com/mcp` — POST initialize → 200 SSE, serverInfo `saax-protocol` 1.0.3, protocolVersion 2025-03-26, tools.listChanged |
| www hostname | `https://www.saax-protocol.com/mcp` — same POST behavior, 200 SSE (no redirect) |
| GET /mcp (both) | 200 JSON server-info (name saax-protocol, version 1.0.3, 26 tools) |
| Live tools/list | **26 tools** (captured): incl. prepare_commitment, accept_commitment, cancel_commitment, close_commitment, submit_evidence, list_evidence, verify_evidence, raise_dispute, resolve_dispute, list_disputes, get_supplier_details |
| /server.json | 200 — name io.github.bryantrudy24/saax-protocol, version **1.0.4**, canonical endpoint, modern description (deployed candidate) |
| /llms.txt | 200 — **stale**: "13 tools", old snapshot date 2026-11-06, www endpoint |
| /openapi.json | 200 — title "SAAX Router", version 1.0.3, paths /route /receipt |
| /robots.txt | 200 — Allow: /, Sitemap correct |
| /sitemap.xml | 200 — 41 URLs, includes /recovery + 6 new articles (2026-11-14 lastmods) |
| /.well-known/saax.json | 200 (signed profile) |
| /.well-known/mcp.json | **404 (does not exist)** |
| /.well-known/mcp/server-card.json | 404 |
| OPTIONS /mcp (all origins) | **405 Method Not Allowed** (Vercel platform; Allow: GET, POST, DELETE) |
| Official MCP registry | **No record** — v0.1/servers/{id}/versions 404, /versions/1.0.4 404, list pagination absent |

## 3. Task One — MCP Redirect & POST Compatibility: **NO REDIRECT DEFECT; ONE CORS GAP**

- Both hostnames answer MCP POST directly with **200, no redirect** — no 301/302/307/308 issue. POST method and JSON-RPC body are preserved (there is no redirect to preserve).
- Streamable-HTTP SSE initialize works on both. GET returns the friendly server-info JSON (also 200, correct for crawlers/verifiers).
- **Defect found: OPTIONS preflight = 405.** The j5-branch `api/mcp.mjs` contains `res.status(204).end()` for OPTIONS, but Vercel rejects OPTIONS at the platform routing layer before the function runs (`Allow: GET, POST, DELETE` response, 405). Consequence: browser-based MCP clients and any client sending the `Mcp-Session-Id` header (which triggers preflight) cannot complete CORS preflight — the MCP session flow breaks in browsers. **Candidate fix (documented, not applied):** add a Vercel `handle: "options"` phase route for `/mcp` returning 204 + CORS headers, or convert `api/mcp.mjs` to a path-based route with `OPTIONS` allowed in vercel.json routing. Requires isolated verification and a separate deployment authorization.

## 4. Task Two — Official Registry & Downstream Discovery

### Official MCP Registry
- Identifier `io.github.bryantrudy24/saax-protocol`: **NOT PUBLISHED**.
  - `GET /v0.1/servers/{id}/versions` → 404
  - `GET /v0.1/servers/{id}/versions/1.0.4` → 404
  - `GET /v0.1/servers/{id}` → 404
  - `GET /v0.1/servers` list (paginated) → SAAX absent on the first page (30 entries, alphabetical)
- The registry's official API (`/openapi.yaml`) documents `GET /v0.1/servers/{serverName}/versions[/{version}]`, publish via `/v0.1/publish` with a registry JWT obtained from GitHub OAuth.
- **The site already serves correct 1.0.4 metadata at `/server.json`** — but publication to the registry is the missing step. **Version policy respected: no 1.0.5 invented to trigger a crawl.**

### Downstream directories
- **RNWY** (rnwy.com): a trust-intelligence layer indexing MCP servers across Smithery + the Official Registry + more. SAAX is **not confirmed listed**; its MCP server index lives behind its app (no public `/mcp/servers` page). Refresh mechanism: pulls from the official registry/Smithery — so publishing to the official registry is the correct primary action.
- **Glama**: `glama.ai/mcp/connectors/io.github.bryantrudy24/saax-protocol` — SAAX **is listed** (connector exists). Its data derives from the registry/repo, so registry publication refreshes it.
- **claudecodeagents.com**, **openaisuite.com** — SAAX listings exist (third-party scrapers of registry/repo metadata; they already show the modern description).
- **SAAX's own site** — GET /mcp server-info is version 1.0.3 while /server.json is 1.0.4: **inconsistent self-reporting** (the /mcp GET handler's PROTOCOL const reads package.json = 1.0.3; the root server.json was updated to 1.0.4 but the /mcp GET was not). Candidate fix documented: align the /mcp GET server-info version/description with server.json.

## 5. Task Three — Machine-Readable Discovery

| File | Status | Assessment |
|---|---|---|
| /llms.txt | Stale | Fixed in candidate (26 tools, canonical endpoint, discovery refs) |
| /llms-full.txt | Present | 242 KB full doc snapshot; needs regeneration only when status changes |
| /openapi.json | Present, 1.0.3 | HTTP API reference (Router). Not the MCP schema source — MCP schemas live in the endpoint. |
| /server.json | Present, 1.0.4 | Correct registry-format manifest — candidate source of truth |
| /.well-known/mcp.json | **Missing** | NEW candidate added |
| /.well-known/saax.json | Present | Signed discovery profile (different purpose) |
| /robots.txt, /sitemap.xml | Correct | Verified |
| MCP registry manifest | Not published | Blocked on owner OAuth — documented |

**Candidate `/.well-known/mcp.json`** contains: name, title, version 1.0.4, description, websiteUrl, canonicalEndpoint, registryIdentifier/version, transport (streamable-http, POST, content types), remotes (both hostnames), repository, documentation links, security disclosure + Pending Release Requirement, capabilities (read-only discovery, mutation-requires-auth, no financial ops, toolCount 26), notes (no certification implied). Public-safe: no secrets, no private endpoints, no operator data.

## 6. Prepared Changes (isolated worktree `feature/mcp-discovery-audit`, base `e92e77b4`)

| File | Change |
|---|---|
| `landing/llms.txt` | MCP line → 26 tools, canonical endpoint, added server.json/mcp.json/registry-status lines |
| `landing/.well-known/mcp.json` | NEW discovery document (validated JSON, 2101 B) |
| `vercel.json` | Added `/.well-known/mcp.json` rewrite (36 rewrites, valid JSON) |

**NOT changed (documented only):** official registry publication (OAuth-gated), OPTIONS-405 fix (needs isolated Vercel routing verification), /mcp GET server-info version alignment (deployed-code change on the release branch).

## 7. Verification

- vercel.json: valid JSON, 36 rewrites.
- mcp.json: valid JSON, name/version/endpoint verified.
- llms.txt: MCP line now lists all 26 live tools + discovery refs.
- Live endpoint state (baseline) re-verified: 26 tools, /server.json 1.0.4, registry absent, OPTIONS 405.
- No production deployment, alias change, registry publication, or OAuth initiated.

## 8. Production Deployment Plan (for owner approval — NOT executed)

1. **Registry publication** (highest priority): owner runs `mcp-publisher login` (GitHub OAuth) → `mcp-publisher publish` with the validated `/server.json` (1.0.4) → verify via `GET /v0.1/servers/io.github.bryantrudy24/saax-protocol/versions/1.0.4`.
2. **Website candidate**: build from `feature/mcp-discovery-audit` → non-promoting `vercel deploy --target production --skip-domain` → validate `/llms.txt` + `/.well-known/mcp.json` + MCP init + 26 tools → promote both domains → verify.
3. **OPTIONS-405 fix** (separate): vercel.json `handle:"options"` route or function-route change, isolated candidate, then deploy with the same non-promoting procedure.
4. **Rollback**: keep current deployment (`ax-router-...` production) as rollback target; content-only changes are reversible by re-deploying the prior artifact.

## 9. Owner Approval Requirements

1. **Registry publication** — requires owner GitHub OAuth (mcp-publisher login). No OAuth attempted.
2. **Website deployment** — promote the llms.txt + mcp.json candidate to production.
3. **OPTIONS-405 routing fix** — implement + deploy the CORS preflight correction.
4. **/mcp GET server-info version alignment** — align 1.0.3→1.0.4 on the release branch.

## 10. Safety Verification

- Financial enforcement OFF, telemetry OFF, scheduler E-STOPPED, mainnet escrow inactive, mainnet EAS signing inactive.
- External developer pilot: **paused** (not activated).
- Independent security assessment: **not started** (Pending Release Requirement).
- No production mutation, no alias change, no registry write, no credential accessed, no OAuth initiated.
- Repository: main worktree `a7597c6d` (681 dirty files) preserved untouched; new worktree isolated on `feature/mcp-discovery-audit`; nothing pushed or merged.

## 11. Final Status

**DISCOVERY FIXES PREPARED AND VERIFIED — AWAITING OWNER APPROVAL**
