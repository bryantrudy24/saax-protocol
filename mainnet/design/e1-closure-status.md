# E1 CLOSURE — Target-Chain Guards and Runtime Configuration

**Baseline (verified):** `84e163b3` (HEAD before this closure; E1D).
**Local commit:** after this closure (local only, no push).
**Preceding:** `84e163b3` (E1D), `7dce4d85` (E1C), `a8148aff` (E1B), `932e7ea1` (E1A).

## 1. Base mainnet 8453 stays BLOCKED (explicit supported-network policy)

SAAX's target mainnet is Base chain **8453**. Ethereum chain **1** is a separate
unsupported mainnet. Finality support is now restricted by an EXPLICIT
repository-owned supported-network policy — never "not chain 1".

### New module: `mainnet/design/support/supported-networks.js`

Single source of truth for chain classification:

| class | chains | meaning |
|---|---|---|
| `local` | **31337** | local EVM / hardhat — LOCAL-only, never public finality |
| `public-testnet` | **84532** (Base Sepolia) | configured public-testnet finality checks permitted |
| `mainnet` | **1, 8453** | recognized mainnets — BLOCKED (FINALITY_MAINNET_NOT_ACTIVATED) |
| `unsupported` | any other | rejected (FINALITY_NETWORK_UNSUPPORTED) |

The policy is wired into every finality surface:

- `worker/d2-finality.js` — `FinalityAdapter` constructor gates:
  - `local-confirmations` only on 31337 (`FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337`).
  - public policies (`op-stack-safe`/`op-stack-finalized`) only on 84532;
    chain 8453 / chain 1 / arbitrary fail closed
    (`FINALITY_MAINNET_NOT_ACTIVATED:<n>` / `FINALITY_NETWORK_UNSUPPORTED:<n>` /
    `FINALITY_PUBLIC_POLICY_CHAIN_UNSUPPORTED:chain=<n>:class=<cls>`).
- `worker/d2-trusted-rpc-finality.js` — `TrustedRpcFinality.assertHistoricalFinality`
  refuses mainnet (1, 8453) and unsupported chains before any RPC work.
- `worker/d2-historical-finality.js` — `HistoricalMembership.assertPublicFinality`
  and `establish` refuse mainnet (1, 8453) and unsupported chains.
- `verifier/v4-finality-adapter.js` — `observeFinality` / `observeHistoricalFinality`
  chain-gate before any observation: 84532 only for public policies; 31337
  only for local-synthetic.
- `worker/config-gates.js` — production startup requires
  `SAAX_ALLOWED_CHAIN_ID`/`SAAX_CHAIN_ID` = 84532; 8453, 1, and arbitrary
  chains are rejected as violations.
- `worker/run-d2-worker.cjs` / `worker/run-d3-worker.cjs` — launcher seam
  validates the finality METHOD and POLICY at startup and constructs the
  worker with the explicit chain gate.

### Exact chain-guard results (from the closure battery)

| chain | policy | result |
|---|---|---|
| 31337 | `local-confirmations` | PASS — local-test policy only |
| 31337 | `op-stack-safe` | REJECTED — public policy not on local chain (no downgrade) |
| 84532 | `op-stack-safe` / `op-stack-finalized` | PASS — configured public-testnet checks |
| 8453 | any | REJECTED — `FINALITY_MAINNET_NOT_ACTIVATED:8453` |
| 1 | any public | REJECTED — `FINALITY_MAINNET_NOT_ACTIVATED:1` |
| 11155111 / 10 / 999 | any public | REJECTED — `FINALITY_NETWORK_UNSUPPORTED:<n>` |

Exported chain/method/policy values cannot override trusted configuration:
the policy/method are read only from operator env at the launcher seam, the
export's `finality.mode` cannot strengthen/lower the trusted policy
(`strength(exportMode) <= strength(trustedMode)` check in verify-v4 unchanged),
and the supported-network allowlists are repository-owned constants.

## 2. Runtime configuration propagation (actual launcher path)

The closure battery spawns the ACTUAL `run-d2-worker.cjs` and
`run-d3-worker.cjs` as child processes (`--probe-finality` diagnostic) and
asserts the configuration that reached the constructed worker:

- **Default (no env):** `finalityMethod=bounded-ancestry`,
  `policyMode=local-confirmations`, `localOnly=true` on 31337 — D2 and D3.
- **Explicit trusted-rpc:** `SAAX_FINALITY_METHOD=trusted-rpc` +
  `SAAX_FINALITY_POLICY=op-stack-safe` on 84532 →
  `finalityMethod=trusted-rpc`, `policyMode=op-stack-safe`,
  `trustedRpcBound=true` — D2 and D3.
- **Default bounded-ancestry remains the default** on 84532 with
  `op-stack-finalized`: `finalityMethod=bounded-ancestry`.
- **Unknown method fails closed:** `SAAX_FINALITY_METHOD=bogus` →
  exit 1 `FINALITY_METHOD_UNSUPPORTED:bogus` (D2 and D3), before any
  worker construction.
- **Unknown policy fails closed:** `SAAX_FINALITY_POLICY=bogus-policy` →
  exit 1 `FINALITY_POLICY_UNSUPPORTED:bogus-policy`.
- **Chain gates at the launcher:** 8453 / 1 / arbitrary chains refuse at
  worker construction (exit 1 with the exact reason); a "default"
  local-confirmations launcher on 8453 refuses
  (`FINALITY_LOCAL_CONFIRMATIONS_ONLY_31337:chain=8453`).

### SAFE vs FINALIZED (distinct, persisted)

`d2-store.js` persists `finality_state` separately from the lifecycle
`status` (`LOCAL` / `INCLUDED` / `SAFE` / `FINALIZED`). `d2-worker.js`
`reconcileOutcome` maps policy → state: `op-stack-safe`→`SAFE`,
`op-stack-finalized`→`FINALIZED`, `local-confirmations`→`LOCAL`. SAFE is
never labeled consensus-finalized (E1A regression asserts the persisted row:
`finality_state === 'SAFE'`, never `'FINALIZED'`, and `'LOCAL'` for local
success). A failed public check never falls back to local confirmations
(E1A: `no fallback` PASS; the adapter's public path returns not-final with the
exact reason, and the closure battery asserts the same for the chain gate).

## 3. Anchor coverage — NOT ESTABLISHED (explicit limitation)

The E1D observation (`evidence/e1d-sepolia-trusted-finality.json`) records
**two cid/digest anchor references** — identifiers only:

```json
{"label":"refunded.commitment","cid":"0xac918e…ed08a","digest":"0xac918e…ed08a"}
{"label":"disputed.commitment","cid":"0x043717…2448","digest":"0x043717…2448"}
```

No EAS attestation TRANSACTION RECEIPT (uid, txHash, blockHash, receipt,
blockNumber) for any anchor is present in the finality observations or anchor
refs. The observed transactions are the escrow funding/settlement hashes
(4 membership refs, 8 finality rows). Therefore:

> **Anchor finality is NOT ESTABLISHED.** A cid/digest reference is not a
> finalized attestation transaction. No unreviewed public EAS/custody
> deployment was added to obtain a green result; anchor verification remains
> available only under the pinned local-official-EAS policies (31337 / 84532
> historical local profiles), which authorize no public deployment.

## 4. Tests / counts / exit codes

| battery | result | exit |
|---|---|---|
| `scripts/test-e1-closure-guards.cjs` (new) | 52 passed, 0 failed | 0 |
| `scripts/test-e1-finality.cjs` (E1A) | 33 passed, 0 failed | 0 |
| `scripts/test-e1b-finality.cjs` (E1B adapter) | 26 passed, 0 failed | 0 |
| `scripts/test-e1b-verify-v4.cjs` (E1B verifier, updated) | 8 passed, 0 failed | 0 |
| `scripts/test-e1c-historical-finality.cjs` (E1C) | 35 passed, 0 failed | 0 |
| `scripts/test-e1d-trusted-rpc-finality.cjs` (E1D) | 35 passed, 0 failed | 0 |
| `scripts/test-d2-worker.cjs` (D2 worker) | 40 passed, 0 failed | 0 |
| `scripts/test-d4b-external-signer.cjs` (D4B config gates + launcher) | 101 passed, 0 failed | 0 |
| `scripts/test-d3-closure-export.cjs` (D3 closure) | 21 passed, 0 failed | 0 |
| `mainnet/admission/tests/run-tests.js` (admission) | 40 passed, 0 failed | 0 |
| `scripts/test-escrow-chain-guard.js` (endpoint chain guard) | 9 passed, 0 failed | 0 |

Note: `scripts/test-e1b-verify-v4.cjs`'s single [PUBLIC] case was updated:
previously it expected a SAFE-stage positive when a trusted public policy was
configured against the local-test chain 31337. Under the E1 closure explicit
supported-network policy, a public policy on 31337 must fail closed at the
chain gate (never a downgrade, never a green) — the test now asserts exactly
that (stronger). `scripts/test-escrow-chain-guard.js`'s two expected-string
assertions were corrected to match the actual endpoint message (which carries
`, expected 84532` since ff6affc4); the guard behavior is unchanged.

## 5. Remaining production activation gates (unchanged)

- Signer: external-signer integration (D4B) and signing isolation.
- Governance: approved 2-of-3 Safe governance provenance is NOT established by
  successful ERC-1271 execution.
- Audit: independent security/economic audit (readiness gate G4) outstanding.
- Operating: mainnet admission, public deployment identity review, RPC
  capability requirements (archive, safe/finalized tag support, multiple
  providers for disagreement detection), finality policy approval, and
  explicit operator activation of the trusted-RPC method
  (`SAAX_V4_FINALITY_METHOD=trusted-rpc` + `SAAX_V4_FINALITY=<policy>` for the
  verifier; the worker launcher reads `SAAX_FINALITY_METHOD` +
  `SAAX_FINALITY_POLICY`).
- Mainnet: Base 8453 (and Ethereum 1) remain blocked under current
  authorization; no mainnet profile, no trust-any-deployment flag.

## Constraints honored

- No push, no deployment, no public-chain writes, no spending, no production
  secrets, no mainnet activation.
- Preserved unrelated working-tree changes and historical fixtures; the only
  pre-existing test-string corrections are noted above.
- Local-chain success is always labeled local; SAFE is never consensus-finalized.