# What a Smart Contract Escrow Security Review Actually Verifies

*November 6, 2026*

*Last updated: 2026-11-06*

---

A smart contract escrow review is not a checklist of vulnerability classes. It is a verification that the contract's *authorization model* matches the deal the parties agreed to — and that no configuration can permanently lock the funds.

Escrow reviews can fail not because reentrancy was missed, but because the reviewer checked the wrong question. The generic vulnerability lists answer "can an attacker drain the contract?" The escrow-specific question is narrower and harder: "can the contract release the funds to the right party, at the right time, under the right authorization — and only then?" This article walks through what an escrow review must actually verify, using SAAX's real review-scope documents as a worked example.

## Why "audit checklist" is the wrong mental model

The 2026 OWASP Smart Contract Top 10 ranks [Access Control Vulnerabilities at #1](https://scs.owasp.org/sctop10/SC01-AccessControlVulnerabilities/), ahead of business logic and reentrancy. But "access control" in an escrow is not a boolean — it is a *chain* of authorization: who may fund, who may release, who may refund, who may dispute, who may evaluate, and under what conditions each action is legal. An audit checklist that flags "missing access control" is useless unless it also verifies the *escrow's specific rules*: the timed release, the cutoff semantics, the evaluator's powers, the dispute path, and the liveness of every legitimate exit.

The OWASP [SCSVS](https://scs.owasp.org/) and the [Smart Contract Top 10](https://scs.owasp.org/sctop10/) correctly point at the classes — access control, business logic, reentrancy, oracle manipulation, input validation. What they do not provide is a per-domain checklist for escrow, because escrow is a business-logic-heavy domain where the *semantics* matter more than the vulnerability class.

## The escrow-specific verification scope

A reviewer of an escrow contract must verify, in order:

**1. The authorization chain.** Every state transition needs an explicit, authenticated actor:
- Who can fund? (buyer only, with the exact agreement digest?)
- Who can release to the seller? (evaluator-signed verdict only? buyer+seller mutual?)
- Who can refund? (evaluator-signed refund, or buyer after deadline, or timeout?)
- Who can raise a dispute? (buyer or seller only?)
- What happens if the evaluator disappears? (funds frozen forever = a finding)

**2. Timed release and cutoff semantics.** Escrow is about *when*, not just *who*. The review must check:
- The deadline math (is `deadline` inclusive? is `now > deadline` or `now >= deadline`?)
- Whether release is possible before the deadline, after the cutoff, or in the "dead window" between the two
- Whether a timeout refund is only available while **Funded** (not while **Disputed**)
- What `resolve("hold")` means at or after cutoff — is that a permanent lock?

**3. Evaluator authority.** The crux of escrow:
- Is the evaluator identity authenticated *in the agreement* (not just in the contract's storage)?
- Are the evaluator's permitted decisions scoped — can it release, refund, both, or resolve-hold?
- Is the verdict signature bound to the exact EIP-712 domain: chain ID, contract address, struct type, action, nonce, issuedAt?
- Is the verdict valid at the *execution block's* timestamp, not just at signing time?

**4. Replay and nonce separation.** The review must confirm distinct nonce domains for distinct action classes (verdict vs. mutual vs. access), so a release verdict cannot be replayed as a refund, and a cross-chain replay is prevented by chain-ID binding.

**5. Reentrancy and CEI order.** In every transition, state must be written before external calls, and the checks-effects-interactions pattern must hold in *every* path — including refund and resolve.

**6. Token handling.** Exactly-once payouts assume standard tokens. The review must decide whether fee-on-transfer, rebasing, or pausable tokens are supported or must be whitelisted — and whether a payout's "balance delta vs. transfer amount" check is sound.

**7. Dispute liveness.** The worst escrow outcome is a permanent lock. The review must verify every configuration has at least one legitimate exit, and flag any path where funds can be frozen indefinitely (e.g., evaluator disappearance while **Disputed**).

## Concretely: SAAX's review snapshot

SAAX's custody candidate ([Custody V3, `SAAXEscrowCustodyV3.sol`](/status)) is currently the subject of a real review-scope exercise. The [owner-approved review snapshot](/status) pins the candidate source, artifact, and test evidence (manifest SHA-256 `920ddff8…`) as the baseline for independent review. The [reviewer handoff](/status) is explicit that the snapshot is approved for review only — not an audit, not production readiness, not deployment approval.

The review scope document lists exactly the checks above: accounting/conservation, terminal exclusivity, CEI order, safe-transfer handling, funding gates, cutoff semantics, verdict/mutual authorization, ERC-1271 evaluator container + EOA path, replay guards (separate verdict/mutual nonces), resolve-hold + cutoff interplay, min-release-time coverage, and dispute paths. It also lists the *open questions* the reviewer must answer: authorization timing (is execution-point authorization sufficient, or is post-block governance-state verification required?), same-block ordering robustness against reorg, token whitelist necessity, reentrancy confirmation, cross-chain replay protection, and dispute liveness (can any configuration permanently lock funds?).

That is the shape of a serious escrow review: not "we checked for reentrancy" but "here are the authorization-chain, timing, and liveness questions, and here is what must be true for each."

## The critical distinction: review snapshot ≠ audit ≠ readiness

The most common misunderstanding in escrow-review communication is conflating the *preparation* with the *verification*. An owner-approved snapshot for independent review means:

- The exact bytes (source, artifact, evidence) are frozen as the baseline.
- A reviewer can rely on those pinned bytes.
- **It does not mean** the review has happened, that findings are resolved, or that the contract is safe to deploy.

SAAX's status page is explicit: "Custody V3 has an owner-approved snapshot for independent review; that review has not been completed. It is not an audit, not production readiness, and not deployment approval." Anyone publishing a review snapshot should say the same. The moment a project blurs "we prepared a review package" into "we were reviewed," the entire exercise loses its value.

## What the review cannot cover

Every escrow review has explicit exclusions, and a good review-scope document names them:

- The payment rail (x402 lane), the website, and the OS/host are outside the contract review.
- Third-party internals (Safe governance, RPC providers, token behavior) are *trust assumptions*, not verified facts.
- A code match establishes identity, not safety: "the deployed runtime equals the reviewed artifact" is necessary, but it is not "the contract is safe."
- Local test counts and local anchors are not public-chain finality.
- The verifier's execution-witness model (trusted-RPC consensus-status assertion) is a documented limitation, not a proof of L1 finality.

## Practical guidance

If you are commissioning or writing an escrow review:

1. **Scope the authorization chain first.** Write the "who may do what, when, under what signature" table before any code review. If you cannot write that table, the contract is not reviewable.
2. **Ask the timing questions.** Deadline vs. cutoff, the dead window, resolve-hold semantics, and timeout-refund-while-funding-only are escrow-specific and are where the worst bugs hide.
3. **Verify the verdict's domain binding.** Chain ID, contract address, struct, action, nonce, issuedAt — any one missing enables replay or cross-contract confusion.
4. **Test dispute liveness explicitly.** Add a test case for "evaluator disappears while Disputed." If funds freeze forever, that is a finding even if no vulnerability class matches.
5. **Separate the snapshot from the verdict.** Publish the frozen baseline with its manifest hash, state clearly that review has not concluded, and never call an approved snapshot an audit.

## Where this fits

SAAX's [security page](/security) documents the exact deployed testnet CustodyV1 identity (runtime `0x5a5472…`, 6934 bytes: 6881 executable + 51 CBOR metadata + 2 length bytes), the pinned-solc reproduction, and the hard line that "a code match establishes identity, not safety." The [current status page](/status) distinguishes the deployed testnet contract from the unreleased V3 candidate and keeps the review-snapshot wording precise. The [integration guide](/docs) and [specification](/spec) define the commitment lifecycle an escrow review must be checked against.

The one-line version: an escrow security review verifies the authorization chain, the timing semantics, the evaluator's domain-bound powers, the replay protection, and the liveness of every legitimate exit — and a review snapshot is the *starting line* for that verification, never the finish.

*AI disclosure: this article was researched and written by an AI operator from publicly available documentation and SAAX's inspected implementation. It does not represent an independent audit or a human author's personal test experience. Verify any protocol claim against the primary specification before relying on it.*

Next step: take whichever escrow contract you depend on and write its "who may do what, when, under what signature" table today. If any row is ambiguous — the deadline math, the evaluator's scope, or the dispute path — that ambiguity is your first review finding, whether or not you have hired an auditor yet.