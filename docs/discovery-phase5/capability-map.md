# SAAX Discovery Phase 5 — Capability Map (REAL testnet integration)

**Date:** 2026-11-06 · Extends `docs/discovery-phase4/capability-map.md`.

## Implemented + proven on PUBLIC Base Sepolia (this phase)

| Component | Evidence |
|---|---|
| Real release: proposal → acceptance → commitment → custody fund → evaluator-verdict release | `evidence/discovery-phase5/real-sepolia-release-export.json` — **VERIFIED 39/39** |
| Real refund: separate funded commitment → contract-permitted refund verdict → buyer repaid (fail-closed first) | `evidence/discovery-phase5/real-sepolia-refund-export.json` — **VERIFIED 39/39** |
| Independent financial-lifecycle verifier (no app DB; trust inputs passed explicitly) | `verifier/verify-financial-export.js` |
| Negative cases (12) all rejected | `tests/discovery-phase5/test-verify-financial-negative.cjs` |
| Custody deployment identity pinned (runtime keccak + artifact + source + metadata) | `docs/discovery-phase5/security-identity-release.md` §2 |
| Key-exposure investigation (no exposure found) | `docs/discovery-phase5/security-identity-release.md` §1 |
| Testnet runbook (reproduce + liabilities) | `docs/discovery-phase5/testnet-runbook.md` |

## Status transitions vs Phase-4 map

| Item | Phase-4 said | Phase-5 reality |
|---|---|---|
| On-chain Base Sepolia broadcast | "awaits operator keys + artifact/source bytecode reconciliation" | ✅ DONE — keys present; identity reconciled (metadata-only diff); release+refund broadcast + verified |
| Escrow financial proof | "proven on artifact bytecode (local EVM)" | ✅ now ALSO proven on the real deployed custody on Base Sepolia |
| Verifier scope | discovery-export only | ✅ financial-lifecycle verifier added (chain receipts, events, token movement) |

## Still NOT implemented / not claimed

- **Production** payment/custody/execution on mainnet — out of scope, no authorization.
- **Immediate-payment (x402) settlement** broadcast — `SAAX_X402_PRIVATE_KEY` absent;
  x402 verify path proven locally only.
- **External anchoring (EAS) on-chain of commitment records** — deterministic local only.
- **A2A JSON-RPC interface** — card claim only.
- **Distributed multi-node custody** — single-writer local FS ownership; the deployed
  Supabase store handles cross-instance discovery/acceptance records, not chain custody.
- Public discovery/preflight/acceptance interfaces remain **NONFINANCIAL** — no charge,
  custody, execution, or release through the public path.

## Explicit role-control disclosure
All provider/buyer/seller/evaluator roles in the real flows are operator-controlled
test accounts on Base Sepolia. No external adoption and no independent evaluation is
claimed. Verdicts are signed by the operator-controlled evaluator key.