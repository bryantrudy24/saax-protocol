# SAAX External Testnet Pilot — Preparation Package (Phase 6)

**Status:** PREPARED. No outreach sent — external participation requires the Commander's explicit authorization (existing authorization covers internal testnet work only).
**Objective:** one narrow service, one buyer, one supplier, on Base Sepolia, with objective acceptance criteria and measurable value.

---

## 1. Pilot service (narrow)

**Service:** "Security-scan routing" via `POST https://settlement.saax-protocol.com/route` (escrow-backed mode, test environment `SAAX_ESCROW_BACKED=1`, chain 84532).

**Supplier:** one registered supplier (e.g. agent 84667 "SYBIL" from the routing index) that advertises an x402 rail and accepts USDC on Base.

**Buyer:** one external participant (must be authorized) with a Base Sepolia wallet funded with test ETH + test USDC.

**Flow:** buyer requests the capability → receives the x402 challenge + commitment → funds the escrow custody (real on-chain tx) → supplier executes → buyer submits authenticated evidence → agreed evaluator verifies → evaluator verdict releases funds to the supplier (real on-chain tx). Independent verifier (fresh process, no SAAX DB) validates the whole record.

## 2. Objective acceptance criteria (the pilot PASSES only if:)

| # | Criterion | Evidence |
|---|---|---|
| A1 | Buyer obtains a valid 402 challenge with commitment digest + escrow custody address | raw challenge JSON |
| A2 | Escrow is funded on-chain (custody `balanceOf` > 0 matching commitment amount) | tx hash + contract read |
| A3 | Supplier delivers the service; buyer submits authenticated evidence (hash + signature) | evidence record |
| A4 | Evaluator verdict (authorized) releases funds to supplier on-chain | release tx hash + escrow state RELEASED + supplier balance delta |
| A5 | Independent verifier (no SAAX DB) returns VERIFIED for the export, or explicit NOT VERIFIED with the specific missing check | `verifier/verify-export.js` output |
| A6 | Interrupted transaction recovery: if the buyer's funding tx is broadcast but the app response is lost, a retry does NOT double-fund (idempotent) | re-POST returns cached/rejected; on-chain balance not double-charged |
| A7 | Dispute path: if the supplier does not deliver and deadline passes, buyer's timeout refund returns the funds on-chain | refund tx hash + escrow state REFUNDED |

## 3. Measurable value (what the pilot proves)

1. **Independently checking the agreement+outcome:** the buyer (or any third party) can run the verifier on the export and confirm the agreement digest, anchor, escrow funding/release — without trusting SAAX's DB.
2. **Safe recovery from an interrupted transaction:** a lost response after a broadcast does not double-charge (idempotency + on-chain reconciliation).
3. **Less dispute-reconstruction work:** every escrow's parties, digest, amount, deadlines, state, and terminal tx are on-chain and exportable — no "who paid whom" forensics needed.
4. **Less integration effort/risk:** the buyer uses a standard x402 payment payload (no custom custody SDK); SAAX handles the escrow binding.

## 4. Onboarding (1 template, to be used only with authorized participant)

```
1. Fund two Base Sepolia test wallets:
   - Buyer gas ETH  (we provide a faucet link / or distribute 0.01 ETH)
   - Buyer test USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e  (1 USDC)
2. POST /route {capability:"security scan", budget:500}
3. Sign the x402 payment payload (any standard x402 SDK / the gateway reference client)
4. Fund the escrow custody address from the challenge (approve + fund; ~0.05 USDC)
5. Re-post with the payment signature + the commitment id -> 200 (escrow-backed)
6. Complete the service; submit evidence; await evaluator release
7. (Dispute drill) if no delivery, wait for deadline; timeout refund
```

## 5. Support steps

- Live status: `GET /health` (verifyMode, store, rails, seller).
- Balances: Base Sepolia explorer for the custody + buyer + supplier addresses.
- Escrow state: `getEscrow(commitmentId)` on the custody contract via any explorer "Read Contract".
- Verification: `node verifier/verify-export.js <export.json> --rpc https://sepolia.base.org`.

## 6. Outcome questionnaire (short, for the authorized participant)

1. Did the standard x402 client construct a valid payment from the challenge? (Y/N + error)
2. Did the escrow funding succeed on-chain on the first attempt? (Y/N)
3. Did the release land on the supplier after the verdict? (Y/N + tx)
4. Did an interrupted retry double-charge? (Y/N)
5. Did the independent verifier confirm the record without SAAX DB access? (Y/N + result)
6. What was the single most time-consuming step? (free text)
7. Would you use this instead of direct payment for a $50+ job? (Y/N + why)

## 7. Test assets budget (bounded)

- Buyer: 0.01 Base Sepolia ETH (gas) + 1 test USDC (funding) — disposable.
- Supplier: receives ~0.05 USDC per completed flow A (release).
- Evaluator: 0.01 Base Sepolia ETH (gas for verdict txs).
- Total exposure per pilot run: ~1 USDC test token + ~0.03 ETH test gas. Mainnet untouched.

## 8. Dependencies / authorization required (NOT yet granted)

1. **Explicit authorization to contact ONE external participant** (the Commander must name the participant; no outreach without it). Until then the package is ready and the dependency is precisely: *a named external buyer + their Base Sepolia testnet wallet*.
2. No service purchase, no mainnet funds, no public listing.

*End of Phase 6 package — ready to run on authorization.*