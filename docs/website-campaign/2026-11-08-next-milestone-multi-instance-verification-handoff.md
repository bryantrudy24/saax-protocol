# Next Engineering Milestone: Live Multi-Instance Financial Verification — Handoff Plan

**Date:** 2026-11-08
**Status:** PREPARED — NOT AUTHORIZED. The website update is complete; live financial verification is the next separately-authorized milestone. **No wallet enrollment, enforcement activation, transaction execution, or funding has occurred or is authorized by this plan.**

## Objective (next milestone)

Controlled live multi-instance financial verification: prove SAAX's financial-safety guarantees (one authorized commitment → one permitted payment → no duplicate authorization under concurrency/restart) under real production conditions with real money, using small owner-authorized amounts.

## Owner actions required before execution

1. **Approve test wallets** (owner-provided wallets; no wallet is populated or approved by this plan).
2. **Fund wallets** with a stated ceiling and network verification (Base mainnet USDC).
3. **Approve transaction spending ceilings** (per-wallet and total).
4. **Authorize financial-limit activation** (pilot enforcement ON) with the approved policy: $100 single / $200 wallet 24h / 3 count / $1,000 global 24h / 15 count / verified USDC only.
5. **Authorize live execution** of the specific test matrix.
6. **Provide or approve monitoring/alerting access** if not already configured.

## Execution phases (draft)

### Phase 0 — Readiness
- Confirm production deploy identity (`ax-router-pr4moaioq` current; rollback `ax-router-kx0954g5r`).
- Confirm `SAAX_PILOT_ENFORCEMENT=off` currently; flip to `on` ONLY after owner authorization.
- Confirm pilot tables empty, allowlist empty until wallets approved.
- Record DB baseline (commitments, reservations, wallets, idempotency rows).

### Phase 1 — Wallet enrollment & funding
- Owner approves wallet addresses; populate `pilot_wallets` (owner-controlled revocation).
- Fund wallets to the approved ceiling; verify balance/network on Base mainnet.
- No funds move without owner approval of amounts.

### Phase 2 — Single-instance control
- One authorized commitment → one payment at approved amount.
- Verify: commitment row, reservation row (1), settlement reference, receipt.
- Verify duplicate retry with same key → same commitment, no second reservation, no second payment.

### Phase 3 — Multi-instance concurrency
- Deploy/run at least 2 application instances sharing the same Supabase.
- Concurrent identical requests (same key) → exactly 1 reservation, 1 payment.
- Concurrent conflicting payloads (same key, different body) → 422, no execution.
- Simultaneous key acquisition → exactly one winner (transactional/advisory-lock serialization).
- Worker termination after reservation commit, before settlement → restart reconciles; no second authorization.
- Lost DB response after commit → retry returns existing record; no duplicate.

### Phase 4 — Unknown-outcome handling
- Simulate settlement status unknown → operation stays unresolved; reserve retained.
- Query authoritative on-chain evidence before any decision; never interpret timeout as failure.

### Phase 5 — Evidence & telemetry
- Record all transaction hashes, commitment IDs, reservation IDs, timings.
- Capture logs (redacted — no secrets), error rates, reconciliation results.
- Emergency stop: `SAAX_PILOT_ENFORCEMENT=off` + rollback deploy `ax-router-kx0954g5r` if a safety invariant breaks.

## Safety invariants (must hold)

1. One authorized commitment → at most one SAAX-initiated payment.
2. Conflicting payloads never reuse an existing authorization.
3. Unknown outcomes remain unresolved until authoritative evidence.
4. Process crash never erases committed state.
5. DB outage never downgrades to unsafe memory/file storage.
6. No successful response claims persistence that did not occur.
7. Limits (when activated) hold atomically across instances.

## Rollback & stop

- Stop triggers: unexpected state changes, persistence unavailable, settlement validation regresses, permissions differ, critical health failure.
- Rollback application: `vercel rollback` to `ax-router-kx0954g5r`. Do NOT automatically drop reservation tables containing financial evidence.
- Post-rollback verification: aliases, health, DB untouched by the rollback itself.

## Independent-review implication

Live financial verification evidence (transaction hashes, receipts, reconciliation logs, conformance results) should be packaged for the pending independent security review — it demonstrates production behavior, not certification.

## Boundaries (still apply)

- No mainnet escrow. No smart-contract changes. No custody activation.
- No changes to LUMIYOU / Victoria's Vision.
- Preserve the dirty working tree and approved snapshots.
- This plan authorizes nothing by itself; it is a draft for owner approval.