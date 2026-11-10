# SAAX Discovery Phase 4 — Capability Map (implemented vs. next)

**Date:** 2026-11-06 · Extends `docs/discovery-phase3/capability-map.md`

## NEW in Phase 4 (implemented + tested)

| Component | Location | Status |
|---|---|---|
| Acceptance core (revalidate §7.2 → verify buyer acceptance → durable accept-once → create commitment) | `endpoint/acceptance-core.js` | ✅ implemented + tested (67/67 Phase-4) |
| Buyer acceptance signing profile (acceptance-v1, domain-separated, EdDSA) | `endpoint/acceptance-crypto.js` | ✅ implemented + tested |
| Durable single-writer acceptance store (O_EXCL lock, PID + stale detection, restart recovery, torn-tail) | `endpoint/acceptance-store.js` | ✅ implemented + tested (single-writer, no distributed claim) |
| Signed commitment representation v1.1 (provider JWS over canonical manifest+proposal binding; closes the v1 placeholder-signature gap additively) | `endpoint/acceptance-core.js` `buildCommitment`/`signCommitmentRepresentation` | ✅ implemented + tested |
| HTTP `/accept-commitment` (isolated, test-only, 127.0.0.1, bounded body) | `tests/discovery-phase3/preflight-http-server.cjs` (extended) | ✅ implemented + tested (isolated env only, NOT deployed) |
| MCP `accept_commitment` tool (same core; inputSchema + zod; NOT advertised live) | `api/mcp.mjs` | ✅ implemented; **NOT deployed/advertised** |
| Acceptance JSON Schema (v1) + signed example + buyer-registry example + buy keygen | `spec/schemas/discovery/acceptance.schema.json`, `spec/examples/discovery/acceptance-valid-001.json`, `buyer-registry-example.json`, `scripts/_discovery-phase4-examplegen.cjs` | ✅ committed tooling + fixtures |
| Phase-4 tests (positive, negatives, concurrency, crash, parity, financial spies, multi-process lock) | `tests/discovery-phase4/run-phase4-tests.cjs` | ✅ 67 passed, 0 failed |
| Boundary findings + acceptance semantics doc | `docs/discovery-phase4/acceptance-semantics.md` | ✅ |

## Exact signed-format mapping (Phase 4)

| Layer | Format | Authenticated by |
|---|---|---|
| Discovery profile | JSON + provider JWS (EdDSA, RFC 8785) | provider key (trusted thumbprint anchor) |
| Preflight proposal | JSON + provider JWS | provider key |
| Buyer acceptance | acceptance-v1 JSON + buyer JWS | buyer key (configured buyer registry) |
| Commitment manifest | COSE_Sign1 envelope (v1, PLACEHOLDER sig — historical artifact preserved) | ⚠️ NOT crypto (documented) |
| **Signed representation wrapper** | `manifest-v1.1+saax-proposal-bound` provider JWS over canonical manifest+proposal | ✅ provider key (real crypto) |
| Evaluator + permitted decisions | carried in the SR wrapper (from profile `evaluatorRequirements`) | ✅ provider-signed |

## What Phase 5 (next) MUST implement (not claimed now)

| Capability | Today | Phase 5 |
|---|---|---|
| Live availability probing (`checked.currentAvailability`) | ❌ false | probe endpoints |
| Public deployment (origin + live operator keypair + signed profile + `/prepare-commitment` + `/accept-commitment` on https://saax-protocol.com) | ✅ DEPLOYED (2026-11-06; Vercel prod alias) | MCP tools now advertise live provider identity; keep in sync with deployed behavior |
| Supabase-backed acceptance + proposal records (cross-instance idempotency + recovery; `public.discovery_acceptance_operations` + `public.discovery_proposals`, RLS-on, service-role-only RPCs) | ✅ DEPLOYED | monitor; add retention/backup policy |
| Payment settlement / custody funding / service execution from a commitment | ✅ TESTNET-ISOLATED (21/21 on deployed custody artifact bytecode; `endpoint/financial-handoff.js` + `scripts/_testnet-financial-flow.cjs`) | on-chain Base Sepolia broadcast needs operator test EOA keys (runbook §2) |
| Immediate payment (x402) from commitment | ✅ requirements + spend binding + LIVE buyer-signature verify (proven) | settlement broadcast needs `SAAX_X402_PRIVATE_KEY` |
| Prefunded escrow (V1 custody) from commitment | ✅ fund → binding verify → evaluator-verdict release → refund (proven on artifact bytecode) | real broadcast needs buyer+evaluator keys; artifact/source bytecode mismatch is a release blocker (runbook §4.1) |
| External anchoring (EAS attestation / testnet anchor) of commitment records | ❌ deterministic local only | follow existing `eas.js` mock/live pattern in the authorized test env |
| A2A JSON-RPC interface serving the SAAX extension | ❌ card claim only | implement interface |

## Explicitly NOT implemented in Phase 4 (still true after deployment)

- No production payment/custody/execution, no commitment settlement, no release/evaluator-verdict wiring in the PUBLIC path. (The public discovery/preflight/acceptance interfaces remain NONFINANCIAL — no charge, no custody, no execution occurs through them.) Financial integration is TESTNET-ISOLATED only (`financial-handoff.js`), proven on the deployed custody artifact bytecode; on-chain broadcast awaits operator keys + artifact/source bytecode reconciliation.
- No second commitment format (manifest v1 untouched) — the SR wrapper is additive, not a format change.
- No distributed (multi-node) concurrency — single-writer local filesystem ownership only, tested.
- The legacy `create_commitment` MCP tool (Tool 9) is preserved unchanged; `accept_commitment` is the proposal-bound authenticated path (no parallel/conflicting implementation).
