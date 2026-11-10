# SAAX Protocol — Sprint 1 Summary

**Deliverable C · Day 7 · one page** — the SAAX Protocol protocol, built across
Days 1-7 in mock mode, proven end-to-end, ready for the operator's wallet
connection. Last verified: 2026-10-01 (all test suites PASS).

---

## 1. What was built (four layers, all mocked where required)

| Layer | Component | Files | State |
|---|---|---|---|
| **1 · Identity + Reputation** | ERC-8004 IdentityRegistry + ReputationRegistry (Base mainnet) | `abis/*.json`, `data/agent-ids-day2.json`, `data/reputation-day{2,3}.json` | real reads (119 agents probed; 10 scored), RLS applied |
| **2 · Demand intake + ranking** | sanitize gate → 402 challenge → rank (capability match × rep × freshness × price, floor 0.4) | `endpoint/route-server.js`, `scripts/rank-suppliers.js` | real ranking over 124 agents; sanitization hardened Day 7 (fail-closed on injection) |
| **3 · Payment routing + settlement** | x402/MPP decision tree per supplier registration; exact/upto signing + verification (mock/live branches); MPP stubbed | `endpoint/router.js`, `endpoint/settle.js`, `endpoint/x402.js` | mock signing/verification/settlement; LIVE verify branch wired + unit-tested |
| **4 · Reputation feedback loop** | outcome → score → `giveFeedback` ERC-8004 tx, CID receipt-uri, mock signing; broadcast helper inert | `endpoint/feedback.js`, `endpoint/agent-index.js`, `endpoint/broadcast.js` | mock signed dry-run; LIVE signer branch wired + gated; broadcast disabled in mock |

## 2. What is proven (test counts, verification per layer)

| Layer | Proof | Result |
|---|---|---|
| 1 · Registry/ABI | `getVersion()=2.0.0`, getClients→getSummary flow, avgX100 computed | Day 2/3 logs; READ validation vs leaderboard |
| 2 · Endpoint+ranking | no-match for underwater welding; floor respected; 422 gates; S4 injection fail-closed | Day 4/5/7 E2E ALL PASS (incl. Day 5 regression after hardening) |
| 3 · Payment | 5 decision-tree unit tests; mock receipts field-for-field; live branch rejects mock + accepts real sig | Day 5 unit (24/24) + E2E (17/17) |
| 4 · Feedback | score 100/-50 txs; unknown agentId error; injection rejected; dry-run === live field-for-field; mock sig verifies; live branch key-gated | Day 6 unit (21/21) |
| **End-to-end (Day 7)** | **4/4 scenarios PASS**: standard (challenge→pay→rank→route→settle→feedback full log), no-match (no settlement), high-rep buyer (20% off, $0.04), injection (422, nothing processed) | `node endpoint/test-day7-e2e.js` |

## 3. Mocked vs Stubbed vs Real

- **Mocked:** x402 signing + mock-verification branch (`SAAX_X402_VERIFY_MODE=mock`),
  settlement receipts (`txHash: mock_<uuid>`), feedback signing (`SAAX_FEEDBACK_SIGN_MODE=mock`),
  buyer-reputation input (`x-mock-buyer-rep` header), outcome source, payTo/fee addresses.
- **Stubbed:** MPP settlement (`{ rail:"mpp", status:"stubbed" }`; mppx + Stripe not
  installed — Day 7+ checklist §8), live broadcast (inert helper), upto settle-time
  metering (60% simulation), PostgREST exposure (RLS already applied).
- **Real:** deployed ABIs + addresses, on-chain reputation reads, ranking engine,
  sanitizer (hardened), RLS policy, the LIVE verification/signing branches
  themselves (real ECDSA, proven by isolated tests), ERC-8004 transaction encoding,
  deterministic CIDv0 receipt-uri + keccak hash, EIP-1559 signed dry-run tx.

## 4. Exact next action after operator wallet connection

1. Operator connects the wallet (raw key env vars **or** Coinbase Agentic Wallet
   MCP path) and explicitly authorizes live mode.
2. Flip config only (in order): `SAAX_X402_VERIFY_MODE=live`, `SAAX_FEEDBACK_SIGN_MODE=live`
   + `SAAX_FEEDBACK_SIGNER_KEY`, `SAAX_X402_PAYTO` (details = `daily-logs/day7-wallet-checklist.md` §1-2).
3. Run the three $0.01 test transactions in order (§3): pay-to-self → x402
   routing fee → feedback broadcast; verify each on BaseScan (§4).
4. After all three pass: activate MPP (§8) and swap buyer reputation to the
   verified x402-identity source (§9).
5. If any live step fails: single-flag rollback to mock (§5/§7.6), log, re-attempt
   only on explicit authorization.

## 5. Open items / recommendations

- **Wallet custody:** prefer the MCP path (keys never touch process env).
- **Buyer reputation (§9):** recommended (a) x402 signature → on-chain identity.
- **Vercel reauth / PostgREST exposure:** endpoint is local (`SAAX_PORT=8080`);
  RLS verified at SQL-role level; REST exposure pending.
- **Real prices / freshness:** `SAAX_PRICE_SCORE_DEFAULT=50` neutral; switch
  freshness to `timestamp_delta` when the archive event-scan resolves timestamps.
- **Human gate:** the first $0.01 live charge, MPP live charge and any broadcast
  require explicit operator authorization. Sprint 1 performed none of these.
- **Known ABI divergences + broadcast + MPP + buyer-rep:** permanently recorded
  in `day7-wallet-checklist.md` §6-9 so the wallet operator is never surprised.

---
*Artifacts: `endpoint/test-day7-e2e.js` (proof), `endpoint/broadcast.js` (inert live
broadcast), `daily-logs/day7-wallet-checklist.md` (operator handoff),
`daily-logs/day7-log.md` (this day's log).*