# SAAX Security + Contract-Identity + Real Testnet — Durable Checkpoint

## Context
- Repo: `ax-router` @ `3d5edd65` (HEAD, pushed). Remote: github.com/bryantrudy24/solvent-applied-saax-protocol.
- Task: (1) key-exposure investigation, (2) custody deployment identity, (3) test signing access,
  (4) verifier scope/labels, (5) real Base Sepolia release, (6) real refund, (7) export+verify, (8) docs+commit.

## Completed
### 1. Key exposure — NO EXPOSURE FOUND (bounded claim)
- Full-history blob scan (21,791 blobs): no `.output/` private JWK, no `.env`, no PEM, no jwk-d, no real API keys committed.
- The 4 private JWKs on disk (`.output/.live-operator/*-private.jwk.json`, `spec/examples/discovery/keys/*-private.jwk.json`) are byte-absent from ALL history (`git hash-object` no match in `rev-list --all --objects`).
- `docker-compose.yml` PGRST_DB_URI credential = **pure `${POSTGRES_PASSWORD}` env reference** — zero static secret bytes.
- `.vercel` deployment bundle on disk: 5,665 files scanned, 0 private-material hits. No live-operator file in bundle.
- 2 stale-tracked `.output/v3-*.txt` logs (test output, no secrets) — hygiene item, not exposure.
- Project's own `scan-secrets-precise.js`: 24 findings, all false positives (env placeholders, Go runtime strings in exe, PostgREST mentions).
- Limits: scanned committed blobs + working tree + local Vercel bundle; did NOT scan GitHub Actions logs/other branches' reflogs or third-party mirrors.

### 2. Custody deployment identity — GATE PASSES (resolved the 3d5edd65 blocker)
- Authoritative address: `0x5a5472d751839cd4968cbf1b136baf862279ff5d` (C5; from `evidence/custody-reconciliation.json`)
  - creationBlock 48176893, deployTx `0xc7ebd72a…`, deployer `0x59b41af94ea81b0c4e920c3af2eb6377dd547a70` (= signer key)
- Live eth_getCode (Base Sepolia): **6934 bytes**, keccak `0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473`, sha256 `ad6e0f73…`
- Artifact `data/escrow-custody-build.json`: creation 6963 bytes, keccak `0x7862bb5a…`, **embeds the live runtime verbatim at byte 29** => artifact == deployed.
- Fresh compile of committed `contracts/SAAXEscrowCustodyV1.sol` (viaIR, runs 200, evm=cancun, meta=ipfs) = **6963 bytes**; after stripping the 1146-byte metadata trailer, **byte-identical** (5817 bytes) to artifact.
- => The 2-byte delta is ONLY the embedded solc metadata (different compile env), not code. Deployment identity = committed source + artifact + metadata ipfs `0x1220570dce…`, solc 0.8.26.
- The previous "mismatch" is explained: code identical, metadata hash differs. NO new deployment needed. Existing C5 is safe for testnet use.

### 3. Test signing access — PRESENT AND FUNDED (clears prior blocker)
- `.env` (untracked) holds real 64-hex keys; derived addresses verified (viem):
  - SAAX_SIGNER_PRIVATE_KEY -> 0x59B41Af9…70 (custody deployer + evaluator)
  - SAAX_TEST_BUYER_KEY     -> 0xFec898A9…13
  - SAAX_SELLER_PRIVATE_KEY -> 0x983040F7…71
  - SAAX_EVALUATOR_PRIVATE_KEY -> 0x04867f30…E8
- Base Sepolia balances (chain 84532 verified):
  - buyer 19.45 test USDC + 0.0126 ETH; seller 0.5 USDC + 0 ETH; signer 0.0084 ETH; evaluator 0 ETH/0 USDC; custody 0.
- Test USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e (6 decimals, verified).
- ⚠ LOCAL .env defaults to MAINNET (8453/mainnet.base.org) — real driver MUST explicitly override to 84532 + sepolia.base.org.

### 4. Verifier + labels (in progress)
- Existing `verifier/verify-export.js` = EAS-centric; `tests/discovery-phase4/test-checkd-cli.cjs` verified the discovery-export path.
- Baselines all green (re-ran): phase2 26/26, phase3 68/68, phase4 67/67, conformance 94/94, schemas 14/14, gap1 28/28, gap2 10/10, gap3 19/19, gap4 18/18.

## Next executable actions
1. Build `scripts/_real-sepolia-release.cjs`:
   - local testnet profile (Sepolia USDC), real provider Ed25519 key (operator), real buyer Ed25519 key (.output/.live-operator), real proposal via preflight-core, real acceptance via acceptance-crypto, real commitment via acceptance-core (single-use).
   - fund custody 0x5a5472... with buyer's real Sepolia USDC (approve + fund), chain guard 84532.
   - evidence, evaluator verdict (evaluator key), release via custody release().
   - reconcile chain-read; export full record.
2. Build `scripts/_real-sepolia-refund.cjs` (separate funded escrow; deadline-passed refund or evaluator refund verdict).
3. Extend `verifier/verify-export.js` (or a focused financial-export verifier) to check: chain ID, custody code equality, funding/release receipts, token movement, verdict replay domain, refund state.
4. Regressions + commit + push.

## Open items
- `testnet-runbook.md` referenced in prior report is NOT in repo (missing) — create it now.
- The `eip155:8453` CAIP network label in profile/terms vs execution chain 84532: document as intentional (CAIP = canonical asset network; execution = testnet), do NOT change the label in committed fixtures silently.## FINAL STATE (2026-11-06)

### Real Base Sepolia — both outcomes BROADCAST + VERIFIED
- Release: commitment 0x4d264190…, fund 0xdb0903d5 (55345366), release 0xf0dd7556 (55345391); export VERIFIED 39/39.
- Refund: commitment 0xa0c03a31…, fund 0xb1fd0575 (55345665), refund 0x2e05a709 (55345690); export VERIFIED 39/39.
- Fail-closed: release-action verdict as refund() reverted; escrow stayed Funded.
- Negative cases: 12/12 rejected.

### Code changes
- endpoint/financial-handoff.js: accept eip155:84532 + eip155:8453; wrong networks still rejected.
- verifier/verify-financial-export.js (new), scripts/_real-sepolia-{release,refund}.cjs (new), scripts/_erc20-abi.cjs (new), tests/discovery-phase5/test-verify-financial-negative.cjs (new).
- docs/discovery-phase5/{checkpoint.md,testnet-runbook.md,capability-map.md,security-identity-release.md} (new).

### Regression totals (all green)
- Phase2 26/26, Phase3 68/68, Phase4 67/67, conformance 94/94, schemas 14/14,
  gap1 28/28, gap2 10/10, gap3 19/19, gap4 18/18, negative 12/12.