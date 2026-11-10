# SAAX Financial Handoff Design — Discovery → Testnet Financial Integration

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **Base HEAD:** `5345b53f`
**Scope:** bind the publicly implemented Discovery → Preflight → Acceptance → Commitment flow to the
EXISTING financial adapters in an ISOLATED Base Sepolia environment. Testnet only. No mainnet funds,
no production custody, no public exposure of any financial test interface.

## 1. Selected adapters (from actual evidence, not assumed)

| Concern | Selected implementation | Evidence |
|---|---|---|
| Immediate payment | `endpoint/x402.js` (x402 V2 schemes) — `verifyPaymentPayload` + `checkSpendBinding` (in `endpoint/commitment.js`) | Live Base Sepolia USDC `0x036CbD...`; EIP-3009/Per mit2 schemes; mock/live mode flag; Phase-2/4 tests |
| Prefunded escrow | `contracts/SAAXEscrowCustodyV1.sol` deployed at `0x5a5472d751839cd4968cbf1b136baf862279ff5d` (Base Sepolia 84532) | `audit/custody-review-phase5.md`: real flows A/B (release tx `0xfa2ae379...`, refund tx `0x543b679f...`); harness 51/51; custody 6934 bytes on-chain (probed) |
| Escrow access (role-scoped, durable accept + reconcile) | `endpoint/escrow-access.js` — EIP-712 `EscrowAccess` (role, commitmentDigest, escrowId, custody, chainId, action, nonce, expiry), JSON-ledger durable acceptance, reconciliation | Same module, tested against live contracts |
| Settlement orchestrator | `endpoint/settle.js` — builds requirements, settles through x402 verify | Tested mock + live |
| Chain submission | `endpoint/broadcast.js` — `broadcastSignedTx` (1-confirmation, chain checks) | Used by escrow flows |

**Why V1 and not V2/V3:** `audit/custody-review-phase5.md` pins V1 as THE deployed testnet artifact
(`0x5a5472...`, Base Sepolia 84532). V2 is the legacy D3 local-lane candidate; V3 is the local-lane
(31337) candidate. The directive requires the maintained implementation used by production testnet
flows — that is V1. V2/V3 remain documented candidates, NOT selected.

## 2. Identity mapping (explicit, never equated)

| SAAX record | Value | Relationship |
|---|---|---|
| Proposal ID | `prop_*` | Signed proposal identifier |
| Proposal digest | `sha256:` of canonical proposal payload | Binds acceptance + SR |
| Acceptance ID | `acc_*` | Buyer acceptance contract ID |
| Operation ID | `op_*` | Durable acceptance operation |
| Commitment ID | `0x…32 bytes` | Commitment manifest identifier |
| Commitment digest | `sha256:` of CANONICAL manifest envelope (v1) | EAS anchor, escrow binding |
| Escrow ID | `== commitmentId` (the contract keys escrows by commitmentId) | DELIBERATE: matching identity |
| Transaction hash | `0x…` | Chain-level fact (fund/release/refund) |
| EAS attestation UID | `0x…` | Anchor of the digest |

**Deliberate equality:** the escrow contract stores `escrows[commitmentId]`; the agreement digest used
in `EscrowVerdict` is the commitment digest. These are the format's defined relationships — verified
in `audit/custody-review-phase5.md` and `escrow-access.js`. All other identifiers (proposal ID,
acceptance ID, operation ID) are NOT equated to escrow ID or tx hash.

## 3. Canonical amount representation

- ONE representation: **integer-string units of the settlement asset, decimal-exact** (e.g. `"1000000"` = 1.000000 USDC).
- The commitment manifest carries `price {amount, currency, decimals}`; the signed proposal carries
  `terms {amount, unit: "micro-units of settlement asset", currency, decimals}`.
- **Rejection rules:**
  - Any conversion/rounding not explicitly authorized in the signed terms → reject.
  - Currency substitution → reject (`checkSpendBinding` + acceptance revalidation).
  - Decimals mismatch → reject (`DSC_INVALID_COMBINATION` — explicit `settlementDecimals`).
  - Unit-label-only inference of a settlement asset → REJECT (no silent USDC default; the profile must
    declare `settlementCurrency` + `settlementDecimals` for a financial combination).
- Normalization: only UTF-8 JSON + RFC 8785 canonicalization (jcs) + sha256. All numeric handling is
  BigInt-safe integer string.

## 4. Buyer agreement acceptance ≠ payment authorization

The `acceptance-v1` contract (domain `saax:acceptance:v1`, action `accept_commitment`) is a buyer's
agreement to the commitment terms. It is NOT an EIP-3009 transfer authorization, NOT a Permit2
witness, NOT an escrow release verdict. The commitment record carries NO `paymentAuthorization` field.

Payment authorization (immediate path) is a SEPARATE x402 payload signed by the buyer wallet over the
commitment's exact spend. Escrow funding is a SEPARATE token allowance + `fund()` call by the buyer
wallet. Release is a SEPARATE evaluator `EscrowVerdict`. Each carries its own domain/replay nonce:

- x402: EIP-3009 `transferWithAuthorization` nonce (per-account nonce) / Permit2 witness nonce.
- Escrow access: `nonce` in `EscrowAccess` (consumed at durable acceptance).
- Escrow verdict: `usedVerdictNonce` in the custody contract (one-time).
- Proposal: `clientNonce` (distinct).
- Acceptance: `acceptance nonce` (distinct).
- Account: wallet nonce (per-address).

## 5. Handoff implementation (one core)

`endpoint/financial-handoff.js` — a thin, deterministic orchestrator that takes a VERIFIED commitment
(created by `acceptance-core.js`) and a requested financial action, and:

1. **Revalidates** the commitment is `commitment_created` (durable store), not expired/stale/reused.
2. **Immediate payment:**
   - Builds `PaymentRequirements` from the commitment: asset = `terms.asset` (CAIP-19 → token),
     network = `terms.network` (CAIP-2 → chain 84532), amount = `terms.amount` (integer string),
     payee = configured seller, scheme = `terms.rail` (`x402`).
   - Enforces `checkSpendBinding(manifest, { amount, currency })` BEFORE settlement.
   - Calls `x402.verifyPaymentPayload` (live mode) — structural + Circle-style verification (mock
     branch only for the isolated harness).
   - No charge on expired/stale/mismatched/already-settled operation.
3. **Prefunded escrow:**
   - `verifyAccessAuthorization` (EIP-712 `EscrowAccess`, role buyer/evaluator/seller).
   - `verifyFundingBindings(escrow, { commitmentDigest, custody, chainId, asset, amount, parties })`
     — compares ACTUAL chain state (getEscrow + balance) against the commitment.
   - Funding: buyer wallet signs `fund(commitmentId, digest, parties, token, amount)` via the custody
     ABI; `broadcastSignedTx` submits; the escrow-journal records the tx.
   - Release: evaluator signs `EscrowVerdict` under the custody domain; `release` relayed; receipt,
     events, state, and token movement verified on-chain.
   - Refund: legitimate timeout/refund path via `refund` (deadline passed) or evaluator verdict.
4. **Durable acceptance + recovery:** every financial intent is persisted BEFORE external execution
   (access ledger / journal), reconciled AFTER (chain read), and never repeated on retry (nonce
   consumed at durable acceptance). Blockchain account nonces, access nonces, evaluator-verdict nonces,
   proposal/acceptance replay controls all separate.
5. **Zero financial side effects on rejection:** rejected requests return specific `DSC_*`/HTTP error
   codes and spy-proven call zero payment/custody/execution/release functions.

## 6. Testnet execution bounds

- Chain ID 84532 enforced at EVERY submitter (`SAAX_CHAIN_ID`, broadcast helper, custody-version lane).
- Test token: Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (verified symbol/decimals).
- Custody: `0x5a5472d751839cd4968cbf1b136baf862279ff5d` (bytecode 6934 bytes on-chain, probed).
- Accounts: buyer `0xFec898...`, seller `0x983040...`, signer/evaluator `0x59B41A...` — all existing
  authorized test accounts (in `.env.testnet`). Balances probed (buyer 19.45 USDC, seller 0.50, signer 0).
- No mainnet funds, no production custody, no public exposure of the test interface, no new external
  participant accounts.

## 7. What is NOT claimed

- Database ↔ blockchain atomicity (explicit UNKNOWN on external outcome where reconciliation cannot
  establish it).
- "Not broadcast" from a scan that finds nothing.
- Mainnet readiness, independent adoption/evaluation (one operator controls buyer+evaluator in the
  current test setup — disclosed).
- Any new commitment-format version (manifest v1 preserved; the SR wrapper remains additive).