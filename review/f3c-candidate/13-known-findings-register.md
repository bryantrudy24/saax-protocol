# Known Findings & Residual Risks Register — Custody V3 Review Snapshot (PROPOSED, NOT FROZEN)

Source of truth: `review/f3c-candidate/` package (manifest `920ddff8…`), re-validated 2026-11-06.
This register is NOT a security audit. It consolidates every disclosed gap, limitation, and unresolved risk carried into independent review. Items marked **[NEEDS REVIEW]** are questions the independent reviewer must answer. Items marked **[OWNER]** require owner decisions. Nothing here is fixed or silently changed to make checks pass.

## F-1. Provenance of exact-candidate test runs (historical — disclosed, corrected)
- The 46/46 realsafe harness and 161/161 boundary harness executed on **uncommitted bytes** (46/46 on base `2e49625b`, first committed `9066ace6`; 161/161 on base `9066ace6`, first committed `7c26838b`). Committed copies are byte-identical (hashes in `08-test-provenance-record.md`); both harnesses assert the candidate runtime identity before behavior.
- **This session's re-run** executes the committed bytes from a fresh locked install at `ea0562b5` — the post-commit reproducibility gap is closed. Baseline: 280/280 exact-candidate + 23/23 checkpoint-binding.
- Status: resolved for current evidence; historical records retain their original caveat.

## F-2. CRLF checkout caveat on Windows (environment, not code) [REPRODUCIBILITY]
- `git checkout` on Windows converts `contracts/*.sol` to CRLF; the manifest hashes are over the LF blob bytes. Compiling the worktree file yields a different source sha256 and therefore different bytecode.
- Not a candidate defect: compiling the blob bytes reproduces artifact + pin exactly (this session: creation `0x58a83b0e…`, runtime `0x87615e3d…`).
- Residual risk: a reviewer on Windows may reproduce FAIL unless they compile from blob bytes or set `eol=lf`. Documented in `12-current-state-and-reproducibility.md` §5.
- Recommendation: add `.gitattributes` (`contracts/*.sol eol=lf`) in a future non-candidate commit; packaging/documentation correction only — does not touch the candidate.

## F-3. Deployment-target compatibility — Category D [NEEDS REVIEW][OWNER]
- V3 has only been executed on **local EVM chainId 31337** (Cancun). Compatibility with Base Sepolia **84532** and Base mainnet **8453** (EIP-155 chainId binding, EIP-712 domain separation, EAS schema/UID availability, Safe singleton addresses on those chains) is **NOT ESTABLISHED**.
- The deployed testnet contract is Custody **V1** (`0x0897dba0…`, 84532) — distinct from this V3 candidate.
- Required: independent deployment plan + chain execution test, separately authorized.

## F-4. Independent security review — Category E [OWNER]
- No external reviewer engaged. The commissioning packet is prepared; the snapshot is the input to that review.
- Passing tests establish conformance, not security. No audit exists.

## F-5. Production signer/governance provisioning — Category E [OWNER]
- Evaluator/provider signing in tests uses synthetic keys. Production requires isolated signer provisioning (HSM/KMS, host isolation), Safe governance wiring (owner set, threshold), and exposure-limit values. None configured.

## F-6. Verifier execution-witness limitation [NEEDS REVIEW]
- `verify-v4.js` binds transaction-time authorization to **canonical direct-call success into the allowlisted immutable runtime** (the runtime enforced Safe ERC-1271 at execution point). It does **NOT replay Safe owner/threshold state post-block**; ERC-1271 success is not proof of approved governance if governance changed between signing and execution.
- Question for reviewer: is execution-point authorization sufficient for the intended assurance level, or is post-block governance-state verification required?

## F-7. Anchor finality (public EAS attestation) — NOT ESTABLISHED [NEEDS REVIEW][OWNER]
- Local official EAS 1.7.1 used in tests. Public EAS schema UIDs, attestation receipts, and anchor finality on a public chain are not established. No public deployment identity entries. Exports carry `noPublicFinality: true` by design (`VERIFIED_WITH_LIMITATIONS` is the ceiling).

## F-8. Authorization timing [NEEDS REVIEW]
- Same-block governance ordering demonstrated (release → changeThreshold(3) → release2 in one block: first paid, second reverted without payout; indices 0<1<2; alternative causes excluded — RS-C14a..C16e).
- Residual questions: reorg/rollback behavior on the local-EVM fixture (no public-chain reorg tested); whether a custody call authorized pre-threshold-change can be replayed post-change on a public chain with mempool ordering differences.

## F-9. Token-handling scope [NEEDS REVIEW]
- Tests use MockUSDC (standard ERC-20, 18→6 decimals fixture). Fee-on-transfer, rebasing, pausable, or malicious tokens are **not** tested. The contract's exactly-once payout assumptions (balance deltas vs. transfer amounts) hold for standard tokens; reviewer should assess the token-whitelist requirement.

## F-10. Reentrancy surface [NEEDS REVIEW]
- Payout paths: external token transfers occur after state transitions (CEI pattern claimed). The exact-candidate suites cover release/resolve/mutual/timeout/refund sequences and duplicate-payout prevention; a dedicated reentrancy attack harness on the exact object is not part of the package (the fuzz battery 540-round runs on the Paris object only).

## F-11. Replay protection / nonce classes [NEEDS REVIEW]
- Escrow-scoped nonce classes for verdict/mutual; head commitment (frozen checkpoint) and chainId binding. Boundary suite F covers signature timing + nonce classes on the exact object. Cross-chain replay (same escrow, different chain) not executed on a public chain; EIP-712 domain binding is code-level only.

## F-12. Dispute liveness [NEEDS REVIEW][OWNER]
- Refund paths tested without min-release wait; timeout before/at/after finalCutoff; RDL==CUT equality and intentional gap; `DeadlineNotPassed` rejections correct. Residual: any configuration that makes RDL == CUT **permanently lock** funds is governed by approved economics (Option A, T<resolutionDeadline); the equality case is tested. Legal/ops recovery rules (manual intervention, key loss) are not defined. [OWNER] recovery/canary parameters decision.

## F-13. Crash recovery / durable worker [NEEDS REVIEW]
- `worker/d3-worker.js` + store: tested (integrated-flow 26/26: handler killed after commit → work remains durable; worker finalizes exactly once; no duplicate payout; outbox drained COMPLETE; journal written). Two-worker contention 14/14 (second worker cannot double-execute). Residual: public-chain reorg mid-recovery (local chain only); journal corruption/fsync semantics on production stores.

## F-14. Dependency provenance [OWNER]
- Locked npm deps (797 packages) reproduce the build byte-identically this session. No npm supply-chain integrity attestation beyond lockfile integrity hashes was performed (documented in `09-fresh-install-linkage.md`). Hardhat 2.22.4, ethers 6.17.0, solc 0.8.26, @safe-global/safe-contracts 1.4.1, eas-contracts 1.7.1.

## F-15. Out-of-scope exclusions (explicit)
- Paid discovery, DHT networking, custom on-chain registries, live preflight, immediate-payment (x402 testnet pending key), production deployment, public EAS anchoring, mainnet activation. No financial execution authorized by this snapshot.

## F-16. Historical artifacts preserved, not rewritten
- `evidence/.preserved-f3c-repair/`, `evidence/f3c-final-report-2e49625b.md` (kept; identity claim corrected by `01-provenance-correction.md`), phase3b/3c-v4 exports, `mainnet/f3c-status.md`, `mainnet/release-candidate-gap-assessment.md`, `mainnet/funding-rule-approval.md` — all untouched.

## Open owner decisions (from approval record §7, unchanged)
Q1 journal-head semantics, Q4 contract-vs-verifier enforcement, caps & legal review, deployment-target compatibility work, provider/Safe provisioning, independent review engagement, deployment authorization, G9/G13 canary steps.

## Status
- **PROPOSED — NOT FROZEN, NOT APPROVED.** Approval, if given, freezes ONLY the identified snapshot for independent review. It does NOT constitute an audit, establish production readiness, or authorize deployment/funding.
- Changes after approval require a new identified revision and an assessment of necessary re-review.