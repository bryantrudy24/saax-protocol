# SAAX Custody Policy — v1

**Status:** INTERNAL POLICY — controlled document. Not for publication.
**Version:** 1
**Prepared:** by the station overseer (Lucius Fox) under Phase 1 of the approved mainnet escrow plan.
**Applies to:** every SAAX-funded commitment that holds funds in escrow custody (any chain where SAAX custody is deployed). Immediate-payment (non-custodial) lanes are governed by their own payment terms; this policy governs custody-backed commitments only.
**Normative hierarchy:** this policy defines the mandatory requirements. `transaction-profiles-v1.md` defines the per-profile field requirements. `custody-policy-addendum-v1.md` is the agreement template that incorporates this policy by reference. The machine-readable admission validator (`mainnet/admission/`) enforces the structural subset of these rules.

**Scope discipline:** this phase establishes policy, agreement requirements, and machine-readable admission validation ONLY. It does not implement the custody contract changes, the execution worker, or any production wiring. No mainnet funding is enabled by this document or by the validator. A syntactically complete agreement is not a production-readiness certificate.

---

## A. Authority and consent

1. **Mandatory policy acceptance.** Every funded commitment MUST identify a versioned custody policy (this document, `saax-custody-policy-v1`) accepted by both buyer and seller before funding. Acceptance is recorded in the agreement (see the addendum template) and, for phase 2+, covered by the signed manifest digest.
2. **Cryptographic binding before funding.** Parties, asset, amount, custody, chain, permitted outcomes, deadlines, evaluator authority, and fallback disposition MUST be cryptographically bound before any funds move. Binding is achieved by including these terms in the agreement and (per the signed-manifest integration planned in Phase 2) in the canonical commitment digest that the parties sign.
3. **No substitute for agreement authorization.** A role address, receipt, payment authorization, or service configuration alone MUST NOT substitute for agreement authorization. A configured buyer address, a received payment, or a router setting does not authorize custody outcomes.
4. **Existing funded commitments retain their rules.** Existing funded commitments (testnet or otherwise) keep the rules in force at their funding. This policy does not retrospectively alter them.
5. **No retrospective operator changes.** No operator may retrospectively change payout recipients, economic outcomes, deadlines, or the governing policy of an existing funded commitment. Any policy version change applies only to commitments funded after the version's adoption.

## B. Restricted objective digital-service profile

The default profile for this phase is the restricted objective digital-service profile. It is intended for short-duration digital services with objectively checkable deliverables.

1. **Resolution window.** Authorized evaluator decisions and mutually signed full release/refund are permitted within the agreed resolution window.
2. **Final cutoff.** At or after the fixed final cutoff, unresolved escrow becomes eligible for refund to the original buyer, including disputed escrow. The cutoff is fixed in the agreement at funding time.
3. **Buyer-protective default accepted by seller.** The buyer-protective default (unresolved escrow refunds to the buyer at/after the final cutoff) MUST be explicitly accepted by the seller. The addendum template includes the seller acceptance clause.
4. **Cutoff is fixed.** The cutoff MUST NOT be extended by retries, repeated submissions, or dispute toggling. No retry, re-submission, or dispute state change alters the cutoff.
5. **Earlier verdict signatures do not override execution-time cutoff rules.** A verdict signature issued before the cutoff does not create a right to execute after the cutoff in a manner that conflicts with the cutoff rules in force at execution time.
6. **Anyone may submit an eligible timeout transaction, but MUST NOT select another recipient.** Timeout refunds go to the original buyer (or the agreed beneficiary only when the agreement names a fixed beneficiary and the profile permits it). A submitter is a relayer, not a recipient selector.
7. **Eligibility is not automatic execution.** Eligibility means a transaction may be submitted; somebody must submit it. No automatic execution is implied or promised.
8. **Partial awards and arbitrary recipient changes are outside this initial profile.** The v1 profile supports whole-escrow full outcomes (release in full to the seller, or refund in full to the buyer). Partial awards, partial refunds, and arbitrary recipient changes are not supported in this version.

## C. Evaluator authority

1. **Recommended launch authority.** The recommended participant-funded launch uses a 2-of-3 evaluator signing authority through an established multisignature mechanism (a contract wallet or threshold signature scheme reviewed for compatibility — see C.4). This is the target; it is not yet implemented.
2. **Signing redundancy is not independent adjudication.** A multi-signature evaluator adds key redundancy; it does not make the evaluator independent. Independence of adjudication is a separate property decided by who the signers are and how they are appointed, not by how many keys sign.
3. **Separate responsibilities.** Evaluator approval (signing verdicts), gas-paying execution (submitting verdict transactions), and EAS attestation (anchoring evidence) are separate responsibilities that MAY be performed by separate actors. Separation is required wherever the operator is not the evaluator.
4. **Evaluator approval keys MUST NOT reside in the public API process.** The route server and any public-facing process must not hold evaluator approval keys. Verdict signing happens in a separate, controlled environment.
5. **Contract-wallet signature compatibility and governance MUST be reviewed explicitly.** If the intended 2-of-3 mechanism is a contract wallet, the custody contract's `ecrecover`-based verdict verification cannot verify a contract wallet signature directly; a compatibility review must determine the supported mechanism (e.g., a signing key held behind the wallet's policy, or a custody-contract change) before admission is enabled. A single operator key is NOT an acceptable fallback for the 2-of-3 requirement.
6. **Owner/threshold-change disclosure and monitoring.** Any ability to change wallet owners or thresholds MUST be disclosed in the agreement and monitored operationally. If the signing mechanism can change its authority set, that capability is part of the evaluator risk disclosure.
7. **Admission remains disabled on unsupported signing controls.** If the intended signing controls cannot be supported by the custody mechanism, admission remains disabled. SAAX MUST NOT silently fall back to a single operator key when the policy requires 2-of-3.

## D. Advanced transaction profiles

Advanced profiles (physical delivery, subjective service, high-value assurance) are defined in `transaction-profiles-v1.md`. The following rules apply to all advanced profiles:

1. **Distinct rules.** Physical delivery and subjective services require distinct evidence and economic rules. They MUST NOT be treated as objective digital services.
2. **High-value assurance is an additional layer.** High-value assurance can compose with any profile. It adds controls; it does not replace a profile.
3. **No universal dollar threshold.** Classification considers irreversibility, complexity, replacement difficulty, and loss exposure, not a single nominal value. A nominal threshold alone does not trigger the layer.
4. **No automatic whole-transaction buyer refund after value has changed hands.** Advanced profiles MUST NOT inherit an automatic whole-transaction buyer refund once value has changed hands (delivery, partial performance, or transfer). Refund rules are profile-specific and agreed.
5. **Only separable disputed amounts are held.** Where the accounting and agreement support distinguishing a disputed amount from released amounts, only the separable disputed amount is held. Funds already released are not re-haled.
6. **Previously released funds are not recoverable via lifecycle-state change.** A lifecycle-state change does not recover funds already released. Recovery claims MUST NOT describe released funds as recoverable through a state change.
7. **Executable longstop disposition before admission.** Every advanced profile MUST have an executable longstop disposition (a defined terminal allocation of any held funds) before admission is enabled.

## E. Recovery and execution

1. **Durable acceptance is not completed execution.** Recording an accepted operation is not proof that the external effect occurred. These are distinct facts.
2. **Execution design (Phase 4 requirement).** The execution design MUST persist, before broadcast: transaction intent, reserved account nonce, signed bytes, and the locally computed hash. This enables crash-gap reconciliation.
3. **Nonce taxonomy.** Account nonces (EOA transaction sequence), access nonces (EIP-712 action authorization), and verdict nonces (evaluator verdict replay guard) are distinct mechanisms and MUST NOT be conflated.
4. **Absence of evidence is not evidence of absence.** Missing receipts, missing records, and absent transaction scans MUST NOT alone establish non-broadcast. Reconciliation determines on-chain outcome from authoritative chain reads.
5. **One authorized business outcome.** Retries, replacements, reconciliation, and finality MUST preserve one authorized business outcome per commitment. Duplicate execution is a violation.
6. **A database lease does not revoke a signed transaction.** A signed transaction that is valid on-chain is not revoked by a lease or a state flag. Leases coordinate workers; they do not un-sign bytes.

## F. Limits and emergency operation

1. **No unrestricted administrative withdrawal.** There is no unrestricted administrative withdrawal or arbitrary diversion of escrow principal. The custody contract has no admin withdrawal path, and none may be added.
2. **Hard custody limits are on-chain.** Initial exposure limits MUST be enforced on-chain if advertised as hard custody limits. A service-level intake cap is not a hard on-chain limit; direct on-chain funding bypasses it (documented in the readiness package §D.7–D.8).
3. **Admission/funding can be stopped without suppressing exit paths.** Halting new admission or funding MUST NOT indefinitely suppress agreed exit paths (release, refund, resolve). Exit remains callable by anyone with a valid verdict or an eligible timeout.
4. **Router shutdown is not a custody halt.** Router shutdown stops intake; it does not stop direct contract calls, and it is not represented as stopping them.
5. **Explicit dependencies.** Token pause/blacklisting, network failure, and adjudicator failure remain explicit dependencies. They are disclosed, not hidden.
6. **No unconditional promises.** SAAX MUST NOT promise unconditional recovery, guaranteed fairness, or guaranteed legal enforceability. Where a rule is dependent on third parties (token, network, evaluator), that dependency is stated.

---

## Version and amendment

- **Version:** 1. Adoption records the version + digest of this document in each agreement.
- **Amendment:** on-chain funded positions retain the policy version in force at funding. New versions bind only new commitments. No operator may amend the policy of an existing funded commitment (A.5).
- **Related documents:** `mainnet/policies/transaction-profiles-v1.md`, `mainnet/agreements/custody-policy-addendum-v1.md`, `mainnet/admission/` (validator + fixtures), `mainnet/mainnet-escrow-readiness.md` (roadmap and gates).