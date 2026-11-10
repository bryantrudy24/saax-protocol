# SAAX Discovery Phase 5 — Security + Contract-Identity + Real Testnet Integration

**Date:** 2026-11-06 · Extends `docs/discovery-phase4/capability-map.md` and the Phase-4 checkpoint.
**HEAD before this work:** `3d5edd65`. **HEAD after:** see git log.

## 1. Key-exposure investigation — NO EXPOSURE FOUND (bounded claim)

Investigated, secret-safe (never printed values):
- **Full-history blob scan**: 21,791 blobs across ALL refs scanned for PEM private keys,
  JWK `d` fields, DB conn strings with passwords, API key prefixes, JWT tokens, key
  assignments. Deduplicated findings: **87 flagged entries, all benign** —
  - `.env.example` placeholders (`sk_test_placeholder_do_not_use`, `PRIVATE_KEY=[...]`)
  - public x402/JWS fixtures (test vectors, signed examples, profile-live-signed.json)
  - `.output-day*.txt` test logs with public payment headers (network/asset IDs) and tx hashes
  - `docker-compose.yml` PGRST_DB_URI = **pure `${POSTGRES_PASSWORD}` env reference** (zero static secret bytes; verified the literal is `${POSTGRES_PASSWORD}`)
  - Go runtime strings in `mcp-publisher.exe` (`live:bytesmarkroot` false positive)
- **Private JWK files on disk** (`.output/.live-operator/*-private.jwk.json`,
  `spec/examples/discovery/keys/*-private.jwk.json`, `.env`, `.env.local`): every one is
  **byte-absent from ALL history** (`git hash-object` value has no match in
  `git rev-list --all --objects`).
- **Deployment bundle** (`.vercel/` on disk): 5,665 files scanned, **0 private-material hits**,
  0 live-operator-named files. `.vercel/output` is NOT tracked (only `.vercelignore`).
- **Public routes**: `api/discovery.mjs` signs only when a private key exists locally
  (gitignored dev key path); the deployed path reads the signer key from env/Supabase secret,
  NOT from any committed file. No route serves key material.

**Bounded limits:** scanned committed blobs + working tree + local Vercel bundle; did NOT scan
GitHub Actions logs, other branches' reflogs, or third-party mirrors. No key exposure found
in the inspected surfaces. The 2 stale-tracked `.output/v3-*.txt` logs are test output with no
secrets (hygiene item: untracked later).

## 2. Custody deployment identity — GATE PASSES (the 3d5edd65 blocker is resolved)

| Fact | Value |
|---|---|
| Address (full, from `evidence/custody-reconciliation.json`) | `0x5a5472d751839cd4968cbf1b136baf862279ff5d` |
| creationBlock / deployTx / deployer | 48176893 / `0xc7ebd72a…` / `0x59b41af9…70` |
| Live runtime (Base Sepolia eth_getCode) | 6934 bytes; keccak `0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473`; sha256 `ad6e0f73…` |
| Artifact `data/escrow-custody-build.json` | creation 6963 bytes; keccak `0x7862bb5a…`; **embeds the live runtime verbatim at byte 29** |
| Committed source `contracts/SAAXEscrowCustodyV1.sol` | identical at `3939c218` and HEAD |
| Fresh compile (solc 0.8.26, viaIR, runs 200, evm=cancun, meta=ipfs) | 6963 bytes; after stripping the 1146-byte metadata trailer, **byte-identical (5817 bytes)** to artifact |
| Metadata identity | ipfs `0x1220570dce6eb7cac01b2d2183f847e9c088796a85ec1f61a783af03c429769a4b61`; solc 0.8.26 |

**Conclusion:** the deployed contract == the committed source. The previously reported
"2-byte mismatch" is **only the embedded Solidity metadata hash** (different compile
environment), NOT code. No new deployment was needed; C5 is the correct pinned custody
for testnet use. Reproduction commands live in the checkpoint.

## 3. Test signing access — PRESENT and FUNDED (clears the Phase-4 blocker)

- All four private keys exist in `.env` (untracked), derived addresses verified with viem
  (signer/buyer/seller/evaluator — see runbook).
- Live Base Sepolia balances checked (chain 84532 verified): buyer 19.45 test USDC,
  seller 0.5, signer 0.0084 ETH; custody holds 0 after the two flows.
- ⚠ Env defaults to MAINNET (`SAAX_CHAIN_ID=8453`); every real testnet submitter written
  this phase hard-codes chain 84532 + `sepolia.base.org` and calls `resolveAndEnforceChain`.

## 4. Scope/labels corrected

- The Phase-3/4 local-EVM evidence (ganache chain-84532 + mock USDC + freshly deployed
  custody artifact bytecode) is preserved with accurate labels: "local EVM with chain ID
  84532", "LOCAL signature verification", "local contract execution (artifact bytecode)".
  It is NOT presented as public-testnet proof.
- This phase's evidence is labeled REAL: public Base Sepolia, real test USDC
  `0x036CbD…`, deployed custody `0x5a5472…`, real receipts/tx hashes/blocks, real token
  movement, independent verifier in a separate process.

## 5. Real Base Sepolia results (both outcomes + exports independently verified)

See `docs/discovery-phase5/testnet-runbook.md` for full tables. Summary:
- **Release**: fund `0xdb0903d5…` (55345366) → release `0xf0dd7556…` (55345391);
  commitment `0x4d264190…`; export **VERIFIED 39/39**.
- **Refund**: fund `0xb1fd0575…` (55345665) → refund `0x2e05a709…` (55345690);
  commitment `0xa0c03a31…`; fail-closed release-verdict revert proven; export **VERIFIED 39/39**.
- **Negative cases**: 12/12 rejected (substituted funding tx, wrong custody, wrong chain,
  altered amount, altered proposal terms, substituted commitment, forged terminal tx,
  verdict-action mismatch, substituted buyer, substituted provider, missing tx,
  substituted evaluator).

## 6. Code changes this phase
- `endpoint/financial-handoff.js`: **network-label acceptance** — both `eip155:8453`
  (legacy/label preserved for existing fixtures) and `eip155:84532` (testnet execution)
  are accepted; on-chain execution chain is still enforced separately (84532).
  Wrong networks still rejected (`DSC_WRONG_NETWORK`). No assertion weakened.
- `verifier/verify-financial-export.js` (new): independent financial-lifecycle verifier.
- `scripts/_real-sepolia-release.cjs`, `scripts/_real-sepolia-refund.cjs`,
  `scripts/_erc20-abi.cjs` (new): real broadcast drivers.
- `tests/discovery-phase5/test-verify-financial-negative.cjs` (new): 12 negative cases.
- `docs/discovery-phase5/{checkpoint.md,testnet-runbook.md,capability-map.md}` (new).

## 7. Remaining liabilities
- **Testnet only.** No production custody, no mainnet funds, no public financial routes.
- All roles operator-controlled; no external adoption/independent evaluation claimed.
- The Discovery live profile still declares CAIP `eip155:8453` (mainnet-label) in its
  committed fixture; execution chain is enforced independently as 84532.
- Immediate-payment (x402) **settlement** broadcast still requires `SAAX_X402_PRIVATE_KEY`
  (absent) — the x402 verify path is proven locally; settlement is not part of this run.
- Evaluator verdicts signed by the operator-controlled evaluator key (test authority).