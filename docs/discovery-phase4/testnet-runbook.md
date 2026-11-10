# SAAX Testnet Financial Integration — Runbook (isolated Base Sepolia)

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **Base HEAD:** `5345b53f`
**Status:** Proven on the DEPLOYED custody artifact bytecode (local EVM, chain 84532); on-chain
Base Sepolia broadcast requires the operator's test EOA private keys (not present in this environment).

## 1. What is proven (local EVM, deployed artifact bytecode)

`node scripts/_testnet-financial-flow.cjs` → **21 passed, 0 failed**

The harness deploys `data/escrow-custody-build.json` bytecode (sha256 `5c1d779dc3b307ed` — the exact
deployed artifact behind `0x5a5472...` on Base Sepolia 84532) on a local EVM with chain ID 84532 and
proves the CONNECTED lifecycle:

| Step | Proof |
|---|---|
| Discovery commitment (real Ed25519 provider signature) | explicit financial terms USDC/6/50000 |
| Immediate-payment requirements from commitment | exact asset/network/amount/payee; spend binding enforced |
| Substituted amount / network / asset | `DSC_SPEND_BINDING` / `DSC_WRONG_NETWORK` / `DSC_INVALID_ASSET` |
| Escrow funding (buyer approve + fund) | on-chain state=1, amount=50000 |
| Chain-read binding verification | digest/parties/asset/amount match commitment — `verifyFundingBindings` |
| Release | ONLY under evaluator EIP-712 EscrowVerdict (custody domain); state=3 Released, seller paid |
| Refund path | separate escrow; deadline-passed refund; invalid verdict reverts |
| Expired-deadline funding | `DSC_EXPIRED_TERMS` |
| Immediate payment LIVE verify | real buyer EOA x402 signature verifies against commitment requirements; tampered/expired fail closed |
| Zero side effects on rejection | spy: x402 verify not called on rejected requests |

## 2. The operator action needed for real Base Sepolia broadcast

The ONLY missing piece is the testnet EOA private keys (authorized test accounts):
- `SAAX_TEST_BUYER_KEY` (buyer `0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13`)
- `SAAX_SIGNER_PRIVATE_KEY` (evaluator `0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70`)
- `SAAX_X402_PRIVATE_KEY` (operator/payee wallet for live x402 signing)

Once provisioned (documented in `.env.testnet`; keys NEVER committed):

```
set SAAX_CHAIN_ID=84532
set SAAX_RPC_URL=https://sepolia.base.org
set SAAX_CUSTODY_ADDRESS=0x5a5472d751839cd4968cbf1b136baf862279ff5d
set SAAX_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
set SAAX_TEST_BUYER_ADDRESS=0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13
set SAAX_SELLER_ADDRESS=0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271
set SAAX_SIGNER_ADDRESS=0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70
node scripts/_testnet-financial-flow.cjs --live
```

The harness's chain section (fund/release/refund/read) already uses the same ethers.Contract path as
the production `financial-handoff.js`, so switching the provider URL to `sepolia.base.org` with the
real keys is the only change required. Chain 84532 is enforced at every submitter.

## 3. Balances (probed 2026-11-06, read-only)

- Chain: 84532 (Base Sepolia) — verified.
- Custody `0x5a5472...` bytecode: 6934 bytes — verified on-chain.
- Test USDC `0x036CbD...`: symbol USDC, decimals 6 — verified.
- Buyer `0xFec898...`: 19.45 test USDC · Seller `0x983040...`: 0.50 · Signer `0x59B41A...`: 0 · Custody: 0.
- NOTE: signer/buyer have 0 ETH; gas funding may be required before broadcast.

## 4. Blocker findings (release evidence)

1. **Custody artifact/source mismatch (NEW finding):** the deployed artifact `data/escrow-custody-build.json`
   bytecode (sha256 `5c1d779d`) does NOT byte-match a fresh compile of `contracts/SAAXEscrowCustodyV1.sol`
   at HEAD (sha256 `72da21ed`) NOR the working tree (same hash). The artifact is 2 bytes longer. This must
   be resolved BEFORE any real testnet broadcast: either re-compile from HEAD and deploy a NEW custody
   (with a documented identity change), or identify the exact source revision that produced the artifact.
   The harness deliberately deploys the ARTIFACT bytecode so this phase's proof is aligned with the
   deployed runtime — but the drift itself is a release-blocking item.
2. **Operator keys not in this environment** — see §2.
3. **No mainnet funds, no production custody, no public exposure** — this integration is testnet-isolated.

## 5. Non-goals (explicit)

- No database↔blockchain atomicity claim; UNKNOWN preserved when reconciliation cannot establish a fact.
- No second commitment format (manifest v1 + SR wrapper preserved).
- No claim of external adoption or independent evaluation (one operator controls buyer+evaluator in
  the current test setup — disclosed).
- Testnet integration is NOT mainnet readiness.