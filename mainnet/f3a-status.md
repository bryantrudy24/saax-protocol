# F3A — Custody V3 Implementation Status (PRE-AUDIT CANDIDATE)

**Status:** IMPLEMENTED AND LOCALLY TESTED (internal candidate — NOT deployed, NOT admitted, NOT reviewed).
**Baseline:** HEAD `f3e90663` (verified `git log`).
**Scope:** contract + signature support. Worker/verifier integration = F3B.

## Deliverables (this phase)

| File | Purpose |
|---|---|
| `contracts/SAAXEscrowCustodyV3.sol` | New immutable custody V3 candidate (distinct domain `SAAX Escrow Custody V3`/`3`, 6-field head-bearing verdict/mutual types, escrow-scoped nonces, exact boundaries, preserved safeguards) |
| `mainnet/f3a-custody-v3-spec.md` | Normative spec: approved rules, action/state table, checkpoint encoding, nonce scope, events, ABI, storage, rejection of unknown representations, gate resolution D1–D8 |
| `scripts/v3-signing.cjs` | Version-explicit V3 EIP-712 helper (typehashes + digest/sign functions); V2 helpers untouched |
| `scripts/test-custody-v3.cjs` | EOA battery (83 checks) — head commitment, boundaries, expiry, nonces, wrong role/party/escrow/chain/custody/version, caps, funding-disable, failed transfers, donations, no double payout, accounting invariants |
| `scripts/test-custody-v3-realsafe.cjs` | REAL Safe 1.4.1 ERC-1271 battery (25 checks) — genuine 2-of-3, negatives, governance threshold change, head substitution through real Safe, timeout, mutual |
| `scripts/test-custody-v3-fuzz.cjs` | Invariant/fuzz sweep (540 checks) — 60 random escrows, adversarial perturbations, accounting + terminal exclusivity invariants, real Safe evaluator |
| `scripts/build-v3-repro.cjs` | Reproducible build (pinned solc 0.8.26+commit.8a97fa7a, optimizer 200, viaIR, paris) → `artifacts/f3a/v3-build-manifest.json` + bytecode/ABI artifacts |
| `artifacts/f3a/*` | Build manifest + creation/runtime bytecode + ABI (hashes below) |

## Test results (actual runs)

```
node scripts/test-custody-v3.cjs           → v3_eoa_passed=83 failed=0
node scripts/test-custody-v3-realsafe.cjs  → v3_realsafe_passed=25 failed=0
node scripts/test-custody-v3-fuzz.cjs      → v3_fuzz_passed=540 failed=0
```

## Build evidence

- solc: 0.8.26+commit.8a97fa7a (node_modules-pinned), optimizer runs=200, viaIR=true, evmVersion=paris (identical to hardhat.config.js).
- sourceSha256        9bd413ac145b7fe0709ef82aed062d2c4290dcfa7dc75c1bc69b65b794cdbc76
- creationBytecode256 d375a09c77b57e995808b86b95cf4bcb8659324de56cfae1071086fed8244b3f
- runtimeBytecode256  9a029d6131b5de3a666b641effa5ea6baca7f02981896263b8bb451c202a6e10
- Full manifest: `artifacts/f3a/v3-build-manifest.json`.

## Gates NOT satisfied (by design)

- F3B worker/verifier integration: NOT implemented (head equality checks in the verifier, timeout-no-head rule, V3 runtime identity pinning, negative verifier battery, admission wiring for the V3 address).
- Independent security/design review: NOT COMPLETED — candidate is labeled `pre-audit-candidate`.
- Mainnet admission: DISABLED. No deployment, no push, no public-chain writes, no production keys, no activation, no outreach, no paid services.
- Numeric caps / Safe owner set / USDC pinning / mainnet RPC+finality policy: unchanged open items.