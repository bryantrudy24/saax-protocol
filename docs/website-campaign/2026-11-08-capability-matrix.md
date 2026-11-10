# SAAX Website — Capability Classification & Verified Baseline (2026-11-08)

**Purpose:** accurate public representation of SAAX's verified current state. Every classification below is grounded in committed repository evidence and/or live production observation on 2026-11-08.

## Classification legend

- **LIVE** — verified in production.
- **BETA** — operational with disclosed limitations.
- **TESTNET** — implemented only in a test environment.
- **IMPLEMENTED / DISABLED** — code deployed but not activated.
- **EXPERIMENTAL** — incomplete or undergoing verification.
- **PLANNED** — not yet implemented.
- **NOT VERIFIED** — insufficient evidence.

## Capability matrix

| Capability | Classification | Evidence |
|---|---|---|
| Protocol specification (v1.0.3) | LIVE (public, versioned) | `/spec`; publication is not standards-body adoption |
| Immediate payments (x402) | LIVE — public beta on Base mainnet 8453 | Real mainnet payment `saax_1e904a1582abc99b` / tx `0x7ac2...4e75` on homepage; receipt endpoint verified |
| MPP rail | IMPLEMENTED / NOT REGISTERED IN PRODUCTION | `endpoint/rails/mpp.js` exists; production boot logs `rails.register(mpp) failed (x402-only mode)`; env lacks `SAAX_MPP_ENABLED`/`MPP_SECRET_KEY` |
| Signed Discovery / preflight / buyer acceptance | BETA (publicly deployed) | `/.well-known/saax.json`, `/prepare-commitment`, `/accept-commitment`; configured-key trust |
| MCP tools (prepare/accept/get/get_status/list) | BETA (deployed) | `https://www.saax-protocol.com/mcp`; verified initialize/tools/list/ping/protocol-info |
| Durable idempotency | BETA (deployed) | File-backed locally; Supabase/PostgreSQL in production topology; reconcile-before-respond; fault-injection suites |
| Reconciliation RPC | BETA (deployed) | `ax_router.reconcile_idempotency` installed in production (Gate A) |
| Receipt lookup (/receipt) | BETA | Verified live 2026-11-06; resolves txHash → commitment |
| Escrow custody (Custody V1) | TESTNET preview — not approved for mainnet funds | Base Sepolia 84532; operator-run test-USDC release/refund; independent export verification (78/78, 79/79) |
| Custody V3 candidate | EXPERIMENTAL / security review | Local EVM only; owner-approved snapshot for independent review; review NOT completed |
| Financial-limit infrastructure (pilot) | IMPLEMENTED / DISABLED | Deployed with enforcement OFF; pilot allowlist NOT populated |
| EAS anchoring | NOT VERIFIED / limited | No public EAS anchor claimed in the fresh financial self-test |
| Mainnet escrow | PLANNED (not available) | Explicitly not available; production custody not established |
| Independent security review | PENDING | Not completed; not an audit; no certification claimed |
| Multi-instance financial concurrency | NOT VERIFIED (production) | Local/staging multi-instance tests pass; live production concurrency not exercised |

## Key corrections made in this release

1. **x402/MPP overstatements removed.** The live rail is x402 only. MPP is implemented but not registered in production (boot log: x402-only mode; env lacks MPP enablement). Corrected in: homepage (5 spots), status.html (1), docs.html (2), protocol.html (2), llms.txt, llms-full.txt (rebuilt).
2. **Homepage positioning** updated to "Durable Commitments for Autonomous Commerce" with the complement-not-replace message and a topic-cluster article block.
3. **Status page** now includes explicit rows for durable idempotency/reconciliation (Beta deployed) and financial-limit infrastructure (Implemented/disabled).
4. **Capability boundaries** (escrow testnet-only, review pending, limits OFF) preserved and restated.

## Unchanged (preserved)

- Spec normative text (rail-registry statement is spec, not deployment status).
- Historical articles (their older "x402/MPP" mentions are preserved as historical evidence).
- Terms, privacy, disputes, security, conformance pages (no inaccuracy found requiring change).
