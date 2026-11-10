# SAAX Discovery Phase 3 — Capability Map (implemented vs. next)

**Date:** 2026-11-06 · Extends `docs/discovery-phase2/capability-map.md`

## NEW in Phase 3 (implemented + tested)

| Component | Location | Status |
|---|---|---|
| Preflight core (normalize, deterministic DSC_* validation, signed proposal) | `endpoint/preflight-core.js` | ✅ implemented + tested (68/68) |
| Durable proposal store (append-only fsync journal, restart-safe, duplicate/conflict semantics) | `endpoint/proposal-store.js` | ✅ implemented + tested |
| Isolated HTTP endpoint (`POST /prepare-commitment`, test-only localhost) | `tests/discovery-phase3/preflight-http-server.cjs` | ✅ implemented + tested (isolated env only, NOT deployed) |
| MCP `prepare_commitment` tool (same core; inputSchema + outputSchema; nonbinding/free description) | `api/mcp.mjs` | ✅ implemented; **NOT advertised live** (no public deployment) |
| Phase-3 fixture profile (`prepareCommitment: true`) + signed proposal examples | `spec/examples/discovery/profile-phase3-unsigned.json`, `keys/` | ✅ committed fixture (throwaway key, public) |
| Proposal semantics doc (offer/stale/conflict/duplicate rules) | `docs/discovery-phase3/proposal-semantics.md` | ✅ |
| Phase-3 tests (real crypto + controlled clock + concurrency + restart + spies) | `tests/discovery-phase3/run-phase3-tests.cjs` | ✅ 68 passed, 0 failed |

## What Phase 4 (next) MUST implement (not claimed now)

| Capability | Today | Phase 4 |
|---|---|---|
| Buyer authorization + commitment creation from a verified proposal (full revalidation §7.2: signature, profileVersion, expiry, combination, manifest digest) | ❌ proposal only | wire via proposalId + requestDigest; preserve existing evaluator bindings |
| Atomic persist of accepted operation (commitment + nonce + digest) before execution | ❌ journal only | extend the commitment store (idempotency-key pattern) |
| Live availability probing (`checked.currentAvailability`) | ❌ false | probe endpoints |
| Public deployment (A2A card + standalone profile + `/prepare-commitment` on the approved origin, live operator keypair) | ❌ example only | via approved release workflow |
| A2A JSON-RPC interface serving the SAAX extension | ❌ card claim only | implement interface |
| Supabase-backed proposal records (deployment upgrade path) | ❌ file journal | RPC + RLS like `upsert_commitment` |
| Replay/revocation distribution + cache invalidation on key change | ❌ per-profile revalidation | design + implement |

## Truthful-endpoints status

- The Phase-3 fixture profile declares `interfaces.discovery.prepareCommitment: true` — because the endpoint + MCP tool ARE implemented (in isolated/test form). The profile is the **public example**; production publication still requires the approved release process.
- The MCP tool is registered but its description states it is nonbinding + free, and the GET tools list includes it — however the adapter is NOT deployed to a public origin yet, so nothing is advertised as live.

## Explicitly NOT implemented in Phase 3

- No public deployment (no DNS/route change, no production `/prepare-commitment`, no live card/profile on saax-protocol.com).
- No payment/custody/commitment execution (proven zero side effects).
- No second commitment format and no manifest version change (manifest v1 reused everywhere).
- No live A2A interface, no DID/registry trust sources, no revocation distribution.
