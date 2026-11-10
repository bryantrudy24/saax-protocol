# SAAX Testnet Financial Runbook — Base Sepolia (REAL, verified)

Status: **EXECUTED 2026-11-06 on public Base Sepolia (chain 84532).** Both financial
outcomes (release + refund) were broadcast, reconciled on-chain, exported, and
independently verified. This supersedes the earlier "blocked: operator keys not
in env" state — the keys ARE present locally (`.env`, untracked) and were used.

## Scope and boundaries
- **Execution chain:** Base Sepolia ONLY, chain ID **84532**, RPC `https://sepolia.base.org`.
- **Asset:** Base Sepolia test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals, verified on chain).
- **Custody:** SAAXEscrowCustodyV1 at `0x5a5472d751839cd4968cbf1b136baf862279ff5d`
  (runtime keccak `0x0897dba0…19473` = pinned identity; source `contracts/SAAXEscrowCustodyV1.sol`
  + artifact `data/escrow-custody-build.json`, metadata-stripped byte-identical).
- **No mainnet funds, no production custody, no public financial routes.**
- **All roles are operator-controlled test accounts** (provider, buyer, seller, evaluator).
  No external adoption / independent evaluation is claimed.

## Accounts (derived from .env private keys; addresses only)
| Role | Address | Base Sepolia balances (2026-11-06) |
|---|---|---|
| signer (deployer) | 0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70 | 0.0084 ETH |
| buyer | 0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13 | 19.45 test USDC + 0.0126 ETH |
| seller | 0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271 | 0.5 test USDC |
| evaluator | 0x04867f30d8Cc98ad9d8E6FFb097371a0262daeE8 | 0 USDC / 0 ETH (verdicts relayed) |
| custody | 0x5a5472d751839cd4968cbf1b136baf862279ff5d | 0 (after release+refund) |

## Release (REAL)
- commitment `0x4d264190a57ae54d098471a28daa931598b16f1fbdaee6337fbb3e71d5beebb7`
- fund tx `0xdb0903d5dc3be8155fd02c5a0322846d021115639f01de3de927786b0dd575a1` (block 55345366, status 1)
- release tx `0xf0dd755617b155acdde14e1c0ff6edda75df35bb8c30302596560ddcf5abb25d` (block 55345391, status 1)
- escrow: Funded(1) -> Released(3); seller received exactly 500,000 micro-USDC; custody holds 0.
- export: `evidence/discovery-phase5/real-sepolia-release-export.json` — **VERDICT: VERIFIED (39/39)**.

## Refund (REAL, contract-permitted evaluator refund verdict)
- commitment `0xa0c03a31d526f888ab9442ce246c5e3086774c97772413b9b61f8b27d07c8f33`
- fund tx `0xb1fd05753219ab855e5297f54ec26813f369dd6938503e04fc57176e789fd305` (block 55345665)
- refund tx `0x2e05a709c2087120762d2d1cd1741e6ffebc265610dab9b6ad6dc894444073eb` (block 55345690)
- fail-closed proof: an action="release" verdict submitted as `refund()` **reverted**; escrow stayed Funded.
- escrow: Funded(1) -> Refunded(4); buyer received exactly 300,000 micro-USDC back; custody holds 0.
- export: `evidence/discovery-phase5/real-sepolia-refund-export.json` — **VERDICT: VERIFIED (39/39)**.

## Independent verifier (no app DB access)
```
node verifier/verify-financial-export.js evidence/discovery-phase5/<release|refund>-export.json \
  --provider-jwk=.output/.live-operator/operator-public.jwk.json \
  --buyer-jwk=.output/.live-operator/buyer-public.jwk.json
```
Checks: provider JWS, buyer acceptance JWS + domain/action, proposal/terms/commitment
digest bindings, chain ID 84532, custody runtime keccak == pin, funding receipt
success + to==custody, escrow on-chain state/bindings, terminal event (Released/
Refunded) + commitmentId match, verdict action/nonce/issuedAt, real token movement.
Negative cases (12) all rejected (substituted tx/address/chain/amount/terms/commitment/
buyer/provider/evaluator, forged tx, missing tx, verdict-action mismatch).

## Chain guard / identity enforcement (every submitter)
- `financial-handoff.resolveAndEnforceChain(provider)` requires chain 84532.
- Custody runtime keccak checked BEFORE any fund/release/refund (explicit pin).
- One canonical amount: integer-string micro-units; no floats; no silent defaults.
- Buyer acceptance != payment authorization != escrow funding != release verdict.

## Reproduce
```
node scripts/_real-sepolia-release.cjs --fund=0.50     # full release
node scripts/_real-sepolia-refund.cjs  --fund=0.30     # full refund
node verifier/verify-financial-export.js ...           # independent verification
```
`--dry-run` stops before any broadcast (proposal/acceptance/commitment only).

## Remaining liabilities
- Testnet only; no production custody config change; no mainnet funds.
- Evaluator/refund verdicts signed with operator-controlled evaluator key
  (arellano test); real-world evaluation would need its own authority.
- The Discovery profile terms use CAIP `eip155:84532` for this testnet run; the
  committed live profile still declares `eip155:8453` (mainnet label) — execution
  chain is independently enforced as 84532 regardless.