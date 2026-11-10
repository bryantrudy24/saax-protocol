# SAAX Protocol — Solvent Applied Autonomous Exchange Protocol

## What SAAX Protocol is

SAAX Protocol (Solvent Applied Autonomous Exchange Protocol), formerly AX Router, is a machine-to-machine economic routing layer for the agent economy. It sits between demand and supply: agents submit routing requests, and SAAX pairs them with the best supplier and settles the payment. The system is built as four layers — **demand intake** (the `/route` endpoint that accepts payment-backed routing requests and issues governed commitments), **discovery/ranking** (`router.js` + `rank-suppliers.js` score suppliers by price, freshness, and on-chain reputation), **payment routing** (a rail-agnostic settlement layer: x402 self-hosted gateway and the Machine Payments Protocol rail, chosen at execution time), and **reputation feedback** (`feedback.js` writes outcome data back to the reputation registry so routing quality compounds over time).

## Rename notice

This project was renamed from **AX Router** to **SAAX Protocol** (Solvent Applied Autonomous Exchange Protocol). The rename covers: environment variables (`AX_` → `SAAX_`), the database schema (`ax_router` → `saax_router`), the package name (`ax-router` → `saax-protocol`), docker-compose service names (`saax-db`, `saax-postgrest`), the network/volume names, all source comments and log messages, and all documentation. Historical daily logs (Day 1–12) carry a header note stating they were written under the previous name.

## Current state

- **Sprint 1 complete.** The four-layer pipeline is built and exercised end-to-end.
- **Day 8 security controls in place:** nonce-bound idempotency, rate limiting (per-IP and per-wallet), kill switch (first gate, zero RPC under halt), and signature-derived buyer reputation.
- **Day 9: live testnet settlement proven on Base Sepolia** — 15 settlements across five consecutive clean runs, every transaction verified on BaseScan.
- **Day 10: dual-path signature detection** — the gateway probes the USDC contract for EIP-3009 (`transferWithAuthorization`) vs EIP-2612 (`permit` + `transferFrom`) and selects the path with per-settlement evidence. Base Sepolia selects EIP-2612.
- **Day 11: rail-agnostic commitment lifecycle** — governed commitment → settlement requirement (R) → rail-resolved settlement → spend receipt → audit trail. x402 is no longer mandatory.
- **Day 12: MPP rail implemented** — the Machine Payments Protocol is a registered second settlement rail (x402 + MPP dual-challenge gateway; the same commitment settles via either rail).
- **Mainnet not activated.**

## What is mocked vs live

- **Mock by default:** `SAAX_X402_MODE=mock`, `SAAX_X402_VERIFY_MODE=mock`.
- **Self-hosted gateway available:** `SAAX_X402_MODE=self` (testnet-proven; mainnet not activated).
- **MPP:** implemented and registered as a rail; live gas-backed settlement requires the on-chain `settledBy` dispatcher with dry-run off. MPP sessions (off-chain vouchers) are documented but deferred.
- **Custody:** single-key testnet wallet. Safe multi-sig (3-of-5) documented but not deployed — pending hardware wallet procurement.
- **Dual-path:** EIP-2612 proven on testnet; EIP-3009 documented only (needs a mainnet probe).
- **Mainnet:** not activated. No real funds.

## What is next

- Procure hardware wallets (OOT-framework Trezor/Ledger direct from manufacturer).
- Deploy the Safe 3-of-5 multi-sig on Base mainnet.
- Run a mainnet read-only probe to confirm the EIP-3009 selector, fund the fee-payer wallet, run the three-clean-run mainnet test sequence.
- Demand generation.
