# SAAX External Testnet Pilot — Readiness Addendum (v2)

**File status:** Addendum to `pilot/external-testnet-pilot-phase6.md` (v1, kept as historical artifact). This addendum CORRECTS the participant-facing surface and records the verified pilot state. It does not alter the v1 acceptance criteria, feedback form, or budget — those remain as written.

**Status:** PREPARED, NOT SENT. No outreach sent — external participation requires the Commander's explicit authorization (existing authorization covers internal testnet work only).

---

## 1. Correction — participant-facing endpoint (CRITICAL)

**v1 said:** `POST https://settlement.saax-protocol.com/route` (escrow-backed mode, test environment, chain 84532).

**Correction:** `settlement.saax-protocol.com` is the **production mainnet** surface. Its live configuration is `SAAX_CHAIN_ID=8453`, `SAAX_RPC_URL=https://mainnet.base.org` (verified from the live `.env`). The escrow-backed path activates ONLY when an instance runs `SAAX_ESCROW_BACKED=1` + `SAAX_CUSTODY_ADDRESS` + `SAAX_CHAIN_ID=84532`. **External participants must NEVER be pointed at the production domain for a testnet escrow pilot** — the immediate-payment lane there settles mainnet USDC.

**The pilot surface is a dedicated testnet instance.** One of:
- **(A) Local/self-hosted:** `node endpoint/route-server.js` with `SAAX_CHAIN_ID=84532 SAAX_ESCROW_BACKED=1 SAAX_CUSTODY_ADDRESS=0x5a5472d751839cd4968cbf1b136baf862279ff5d SAAX_EAS_MODE=live SAAX_RPC_URL=https://sepolia.base.org SAAX_X402_MODE=self`, exposed on a testnet-only host:port.
- **(B) Deployed testnet project:** a SEPARATE Railway/Vercel project (never the production app) with those env vars and a testnet-only domain. No such deployment config is committed yet — this is an open dependency.

**The keeper rule:** every transaction-capable component verifies chain ID 84532 and refuses otherwise (already enforced in `endpoint/escrow.js` `verifyOnChain` — the mainnet bypass was removed). Mainnet custody is never enabled.

## 2. Correction — role disclosure (honesty)

**v1 flow says** "buyer, supplier, evaluator" as if independent. **Actual history:** every prior testnet run (Phase 4, acceptance, recovery, resolutions) used keys controlled by ONE operator. Explicit honesty note in the build log: *"buyer, seller and evaluator are all keys controlled by ONE operator for testnet purposes... These are NOT independent participants."*

**Pilot requirement:** at minimum an **external buyer** (real participant, own keys). Supplier and evaluator **may** be operator-run — but that MUST be disclosed to the external buyer before they fund, and the brief's "internal test wallets do not qualify" applies to the external-role claim. An external buyer + disclosed operator supplier/evaluator is a valid external pilot; an all-operator replay is not.

## 3. Verified pilot facts (committed state, HEAD e3d24555)

| Fact | Value | Verified |
|---|---|---|
| Custody contract (C5, testnet escrow) | `0x5a5472d751839cd4968cbf1b136baf862279ff5d` | deployed code on 84532 (`getCode` non-empty), 0 ETH held |
| Verdict scheme | `escrow-custody-v1` (EIP-712 `EscrowVerdict`, domain name `SAAX Escrow Custody V1`, chainId 84532, verifyingContract = custody) | `evidence/integrated-escrow-verified-commitment.json` |
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals) | `endpoint/gateway.js` |
| Verifier CLI | `node verifier/verify-export.js <export.json> --rpc https://sepolia.base.org` | committed, 28-check full-lifecycle verification |
| Access auth | `x-saax-access-auth` (EIP-712 `EscrowAccess`, role-scoped, 8 bindings incl. nonce+expiry) | `endpoint/escrow-access.js`, 31/31 acceptance suite |
| Escrow-backed routing | `SAAX_ESCROW_BACKED=1` → accepts access-auth, REJECTS direct `payment-signature` | `endpoint/route-server.js:149-259, 989-1012` |
| Chain guard | `verifyOnChain` refuses any chainId ≠ 84532 | `endpoint/escrow.js:472` |
| Real EAS anchor | live mode broadcasts `attest` on Base (signer gas) | `endpoint/eas.js:117, 291` |
| Prior liabilities | ZERO remaining on C5/C76/F85 at block 48205728 (all resolved/refunded) | `evidence/onchain-position-inventory.json`, `evidence/position-resolutions.json` |

## 4. Test assets budget (bounded, unchanged from v1)

- Buyer: 0.01 Base Sepolia ETH (gas) + 1 test USDC (funding) — disposable.
- Supplier: receives ~0.05 USDC per completed flow A (release).
- Evaluator: 0.01 Base Sepolia ETH (gas for verdict txs).
- Total exposure per pilot run: ~1 USDC test + ~0.03 ETH test gas. Mainnet untouched.

## 5. The smallest request to proceed (open dependencies)

To run the pilot I need from the Commander exactly:

1. **A named external buyer** — identity/contact the Commander authorizes me to onboard (or the Commander relays the invitation). They bring: a Base Sepolia wallet (own keys), ~0.01 ETH + ~1 USDC test assets.
2. **Authorization to stand up the dedicated testnet surface** — either run the local testnet route-server on a reachable host:port, or deploy the separate testnet project (needs deployment platform access/credentials). This is the only way external participants can reach the verified application flow without touching mainnet.
3. **Optional but preferred: an external supplier** ("Ruins" is NOT confirmed — no committed record of that offer, and no outreach authorization exists) — otherwise the supplier role is operator-run and disclosed as such.

Until (1) and (2) are provided, the package is ready and the pilot cannot be truthfully claimed as external. No internal wallet replay will be labeled as an external pilot.

*End of addendum — ready to run on authorization.*