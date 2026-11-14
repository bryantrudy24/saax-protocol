# Phase 3A — Restricted Custody V2 Candidate: Implementation Status

Status: IMPLEMENTED AND TESTED (internal candidate — NOT deployed, NOT admitted for mainnet funding)
Date: 2026 (Phase 3A subphase)
Base: Phase 2 design (`mainnet/design/custody-v2-design.md`, `agreement-signing-spec.md`)

## 1. Scope

Implements the restricted OBJECTIVE_DIGITAL custody candidate `SAAXEscrowCustodyV2` as an
internal contract candidate, with a local Hardhat in-process EVM (chainId 31337 per the chain-identity resolution d1eb4c6d; the pre-resolution suite's 17/17 was captured under local chain 84532 and preserved as pre-resolution evidence).
No deployment, no production integration, no funding enabled. The candidate is a proposal, not
an approved release; independent design/security review remains NOT COMPLETED.

## 2. Files (Phase 3A deliverable set — untracked until local commit)

| File | Purpose |
|---|---|
| `contracts/SAAXEscrowCustodyV2.sol` | Restricted custody candidate (safe=ERC-1271 evaluator, caps, cutoff refunds) |
| `contracts/mocks/MockUSDC.sol` | Test asset (6-decimal, mintable) |
| `contracts/mocks/SafeMock2of3.sol` | Safe signature-model mock (genuine secp256k1, threshold enforcement) |
| `hardhat.config.js` | Local test config (solc 0.8.26 viaIR, in-process EVM chainId 31337, blockGasLimit 30M) |
| `scripts/test-custody-v2.cjs` | Phase 3A harness (51 checks) |

## 3. Harness repairs from the interrupted run (reviewed diff)

The interrupted run had applied broad regex edits that corrupted approve/parseUnits/getAddress/wait
expressions. Repairs were made with exact targeted replacements (no broad regex was re-run), and the
final correctness was verified by a full green run.

Repair summary (per substitution, verified in the file):
- `parseUnits('5000', 6, { gasLimit })` → `parseUnits('5000', 6)` — override removed from parseUnits (3 sites).
- `parseUnits('3000', 6, { gasLimit })` → `parseUnits('3000', 6)` (1 site).
- `.wait(, { gasLimit })` → `.wait()` — orphaned override removed (20 sites).
- `getAddress(, { gasLimit })` → `getAddress()` (1 site).
- `{ gasLimit: 300000 }` restored as the THIRD argument of `approve(...)` only (the justifyable override location).
- Aggregate-cap fixture corrected: `1000+999=1999` → exact boundary `1000+1000+500=2500`
  (below-agg, exactly-at-agg, exceeding-agg), with mutualRefund settlements restoring totalHeld=0.
- Settlements added after negative-rejection tests (cid=2, cid=5, cid=91, cid=92) so accounting
  invariants hold; global MutualResolution nonce space respected (unused high nonces 901/902/910/911/912/930/931).
- T44 expectation corrected from `Replay` to `WrongState` — the contract rejects terminal-state
  release by state (the "no double payout" guarantee); the prior assertion expected a nonce-based
  reason that the state check makes unreachable. Comment already documented the intended behavior.

After every repair: `node --check scripts/test-custody-v2.cjs` → TEST_SYNTAX_OK.

## 4. Approve-failure investigation (focused reproduction)

Checkpoint claim: "a subsequent approve transaction reportedly ran out of gas." No durable evidence
existed. Focused reproduction (`_probe-approve-gas.cjs`, local MockUSDC only):

- Case A (no override, default estimation): approve succeeds, gasUsed=45,903 (first-ever approve, cold slot).
- Case B (with `{ gasLimit: 300000 }`): approve succeeds, gasUsed=26,003 (warm slot).
- Case C: `estimateGas`=28,803; populated tx has no explicit gasLimit (est at send).

Conclusion: the bare approve does not fail on a fresh deployment; the 300,000 bound is a *bounded
explicit gasLimit that makes harness execution deterministic* (6-10x headroom over actual 26-46k),
which the Phase 3A brief explicitly permits as a labeled workaround. It does not weaken any
assertion, does not change token semantics, custody security checks, or network settings.

## 5. Test results (actual run, committed state)

```
node scripts/test-custody-v2.cjs
passed=51 failed=0
ALL PASS  (exit 0)
```

Coverage vs the brief:
- Genuine Safe/ERC-1271 threshold signatures: T2 (2-of-3 accepted), T6 (one sig), T7 (duplicate
  signer), T8 (wrong owner), T9 (wrong digest), T10 (wrong domain), T11 (wrong action),
  T12 (threshold change to 3 rejects 2-of-3), T13 (3-of-3 accepted). The mock reproduces Safe's
  packed r‖s‖v ascending-owner threshold model with genuine secp256k1 signatures. This is a
  DISTINCT from a production Safe singleton deployment (Phase 3/4 integration item).
- Mutual authorization: T14 (accepted), T15 (missing/substituted party rejected).
- Cutoff boundaries: T25 (just before accepted), T26 (at cutoff rejected — earlier sig does not
  override), T27 (timeout refund at cutoff), T28 (after cutoff), T33 (evaluator resolve after
  cutoff blocked), T31/T34 (disputed timeout refund).
- Caps/intake/accounting: T24 (per-position), T37 (below agg), T37b (exactly at agg), T38 (exceeds
  agg), T37c (capacity freed by settlement), T35 (funding disabled), T36 (exits remain available),
  T48 (no outstanding liability), T49 (no leaked principal — only unsolicited donation remains).
- Token transfer failures / donations: T42 (fund without approval reverts, no escrow recorded),
  T39 (donation does not inflate liability), T40 (release pays exact amount), T41 (donation stuck).
- Terminal-state/nonce replay: T29 (no second payout), T44 (terminal release replay rejected).
- Invariants: no double payout (T29/T44), no unauthorized payout (T6-T11/T46/T47), accounting
  consistency (T37c/T48/T49/T4).

## 6. Safe/ERC-1271 honesty boundary

`SafeMock2of3` reproduces Safe's signature model and enforces thresholds with genuine cryptographic
signatures from three distinct keys, but it is a MOCK, not the Safe singleton. The real
Safe singleton deployment + its owner/threshold governance (`addOwner`/`changeThreshold` are
unrestricted in the mock; production governance is a Phase 3/4 integration item). This subphase
does NOT claim production Safe validation. Structural signature fixtures were NOT counted as
cryptographic proof; the mock path uses real EIP-712 + ecrecover.

## 7. Remaining work (Phase 3B / integration)

- Verifier extension for the v4 agreement format (currently spec-only; Phase 3A did not touch
  historical verifiers or manifest digests).
- Real Safe singleton deployment + owner/threshold governance integration and tests.
- ERC-1271 execution-context validation for historical verdicts (export verification).
- Exact 2-of-3 mechanism decision (Safe + ERC-1271 is preferred per the Phase 3A brief; the mock
  validates the custody hook, not the production wallet).
- Economic values (caps, durations) remain synthetic test parameters until owner-approved.

## 8. Review gates

- Independent design/security review: NOT COMPLETED.
- Mainnet funding admission: DISABLED (all new profiles remain disabled; a structurally valid
  fixture is not a production-readiness certificate).
- No deployment, no push, no production routes wired.