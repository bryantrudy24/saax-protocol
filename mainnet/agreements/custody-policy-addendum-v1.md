# SAAX Custody Policy Addendum — Agreement Template (v1)

> **Internal agreement template — requires transaction-specific completion and qualified legal review before participant-funded use.**
>
> This document is a **template**, not an offer or a binding agreement. Every bracketed placeholder must be completed for the specific transaction, and the completed agreement must be reviewed by qualified legal counsel before any participant-funded use. This template does not assert enforceability in any jurisdiction. Governing law, forum, institutional rules, and other jurisdiction-specific terms are **left for selection and review** and are not supplied here.
>
> - Incorporates: `mainnet/policies/custody-policy-v1.md` (version `saax-custody-policy-v1`)
> - Profile requirements: `mainnet/policies/transaction-profiles-v1.md` (profile version v1)
> - Admission validation: `mainnet/admission/` (machine-readable structural checks; a passing admission result is NOT a production-readiness certificate)

---

## Preamble

This Custody Policy Addendum (the "Addendum") forms part of the agreement between the identified parties (the "Agreement") for the funded commitment described below. The Addendum governs the escrow custody of the principal amount during the commitment lifecycle. Capitalized terms have the meanings given in the Agreement or in the incorporated custody policy.

The parties acknowledge that this Addendum is an internal template and that the completed version requires qualified legal review before participant-funded use. Signing this Addendum does not, by itself, guarantee enforceability in any jurisdiction.

## 1. Incorporation and version

1.1. This Addendum incorporates by reference, in their entirety and as in effect at the date of this Addendum:

- **Policy:** `saax-custody-policy-v1` (SAAX Custody Policy v1), digest `[POLICY_DIGEST_SHA256_HEX]`.
- **Profiles:** SAAX Transaction Profiles v1 (`transaction-profiles-v1.md`), version `saax-transaction-profiles-v1`, digest `[PROFILES_DIGEST_SHA256_HEX]`.
- **Agreement digest:** the canonical commitment digest of this Agreement is `[AGREEMENT_DIGEST_SHA256_HEX]`, computed over the signed terms, including the policy/profile versions referenced above.

1.2. In the event of conflict between this Addendum and any other document, the normative hierarchy is: custody policy v1, then transaction profiles v1, then this Addendum, then the Agreement's other terms, unless a specific clause states otherwise.

1.3. The versioned policy and profile digests above are fixed at signature. No amendment to the policy or profiles (as defined in policy §A.5) applies to this commitment after funding.

## 2. Parties, authority, chain, custody, asset

2.1. **Buyer:** `[BUYER_NAME_OR_ID]`, acting through authorized representative `[BUYER_REP_ADDRESS]` (an EOA or contract wallet as specified: `[BUYER_REP_TYPE]`), with authority reference `[BUYER_AUTHORITY_REF]`.

2.2. **Seller:** `[SELLER_NAME_OR_ID]`, acting through authorized representative `[SELLER_REP_ADDRESS]` (type: `[SELLER_REP_TYPE]`), with authority reference `[SELLER_AUTHORITY_REF]`.

2.3. **Evaluator:** `[EVALUATOR_ENTITY]`, signing address(es) `[EVALUATOR_ADDRESS_OR_MULTISIG]`, authority reference `[EVALUATOR_AUTHORITY_REF]`, permitted outcomes `[PERMITTED_OUTCOMES: "release","refund" or as agreed]`, with a resolution window ending `[RESOLUTION_DEADLINE]`. The evaluator authority and permitted decisions are bound into the Agreement digest at funding (policy §A.2).

2.4. **Chain and custody:** the commitment is funded on chain `[CHAIN_ID]` (target: 8453 mainnet; testnet: 84532) at custody contract `[CUSTODY_ADDRESS]`, which is the only permitted custody for this commitment.

2.5. **Asset and amount:** the principal is `[AMOUNT_INTEGER_BASE_UNITS]` of token `[TOKEN_ADDRESS]` (the "Asset"), held in escrow custody. All amounts are exact integers in the token's base units; no floating-point accounting is used.

2.6. **Fees and reserves:** fees `[FEE_AMOUNT_BASE_UNITS]` and dispute-cost reserves `[RESERVE_AMOUNT_BASE_UNITS]` are accounted separately from the principal and do not form part of the principal allocation in clause 3.

2.7. **Fixed beneficiaries:** the fixed beneficiaries of the principal are the Buyer (refund) and the Seller (release), as allocated under clauses 3 and 8. No other recipient may be selected except as expressly agreed in this Addendum (policy §B.6, §B.8).

## 3. Milestones, evidence, acceptance

3.1. The principal `[AMOUNT_INTEGER_BASE_UNITS]` is allocated to the following milestones, which total exactly the principal:

| Milestone | Amount (base units) | Evidence required | Acceptance criteria | Deadline |
|---|---|---|---|---|
| `[MILESTONE_1_ID]` | `[MILESTONE_1_AMOUNT]` | `[MILESTONE_1_EVIDENCE]` | `[MILESTONE_1_CRITERIA]` | `[MILESTONE_1_DEADLINE]` |
| `[MILESTONE_2_ID]` | `[MILESTONE_2_AMOUNT]` | `[MILESTONE_2_EVIDENCE]` | `[MILESTONE_2_CRITERIA]` | `[MILESTONE_2_DEADLINE]` |
| … (as applicable) | | | | |

3.2. Milestone evidence must be submitted through `[EVIDENCE_SUBMISSION_MECHANISM]` from accepted evidence sources `[EVIDENCE_SOURCES]` within `[MAX_EVIDENCE_AGE]` of the event. Evidence review windows: the receiving party has `[REVIEW_WINDOW]` to accept or reject evidence after submission.

3.3. Cure/revision windows: `[CURE_WINDOW_DESCRIPTION]`. Change orders follow `[CHANGE_ORDER_PROCEDURE]` (where the profile provides one).

3.4. Deadlines in this Addendum are fixed at funding and are not extended by retries, repeated submissions, or dispute toggling (policy §B.4).

## 4. Restricted objective digital-service profile terms (where applicable)

4.1. **Profile:** `OBJECTIVE_DIGITAL` (policy §B). Deliverable: `[DELIVERABLE_DESCRIPTION]`; objective acceptance criteria: `[OBJECTIVE_ACCEPTANCE_CRITERIA]`.

4.2. **Delivery deadline:** `[DELIVERY_DEADLINE]`. **Resolution deadline:** `[RESOLUTION_DEADLINE]`. **Final cutoff:** `[FINAL_CUTOFF]` (must be at or after the delivery and resolution deadlines).

4.3. **Buyer-protective timeout — express seller consent.** The Seller expressly accepts that at or after the final cutoff `[FINAL_CUTOFF]`, any unresolved escrow — including escrow in a disputed state — becomes eligible for refund to the original Buyer (policy §B.2). The Seller acknowledges:

- (a) the cutoff is fixed and will not be extended by retries, resubmissions, or dispute toggling;
- (b) earlier-issued verdict signatures do not override execution-time cutoff rules;
- (c) eligibility means a transaction may be submitted; it does not mean automatic execution, and the Seller should not rely on any automatic release;
- (d) any eligible submitter may execute a timeout refund, but may not select another recipient; and
- (e) the timeout refund is the Buyer-protective default applicable to this profile and was a material term the Seller accepted before funding.

4.4. Signature evidence: the Seller's acceptance of clause 4.3 is evidenced by the Seller's signature over the Agreement digest (clause 11) and, where the machine-readable admission schema requires it, the field `buyerRefundTimeoutConsent.acceptedBySeller = true`.

## 5. Evaluator authority and mutual resolution

5.1. The Evaluator has authority, within the resolution window ending `[RESOLUTION_DEADLINE]`, to decide permitted outcomes `[PERMITTED_OUTCOMES]` for the commitment, per the evidence and rules in this Addendum. Evaluator decisions are signed under the custody contract's verdict scheme and are subject to the evaluator-authority rules in policy §C.

5.2. The parties may mutually sign a full release or full refund within the resolution window, which the custody contract will execute in accordance with the agreed outcome.

5.3. The 2-of-3 evaluator signing authority (policy §C.1) — `[2OF3_MECHANISM_DESCRIPTION]` — provides key redundancy. The parties acknowledge that signing redundancy is not independent adjudication (policy §C.2) and that evaluator approval, gas-paying execution, and EAS attestation are separate responsibilities (policy §C.3).

5.4. Evaluator approval keys do not reside in any public API process (policy §C.4). Where the signing mechanism is a contract wallet with owner/threshold-change capability, that capability is disclosed and monitored (policy §C.5–C.6).

5.5. **Evaluator dependence disclosure.** The parties acknowledge that if the Evaluator becomes unavailable and no permitted resolution is reached, funds may remain locked pending the dispute-liveness policy or the applicable cutoff rules. The custody contract has no administrative withdrawal (policy §F.1).

## 6. Reviewer independence, conflicts, replacement, escalation

6.1. Where the profile names an independent reviewer or specialist (advanced profiles): the reviewer is `[REVIEWER_IDENTITY]` with appointment mechanism `[APPOINTMENT_MECHANISM]`. Conflicts rule: `[CONFLICTS_RULE]`. The reviewer must disclose any conflict of interest with either party; a conflicted reviewer is disqualified.

6.2. **Replacement appointment:** if the reviewer becomes unavailable, disqualified, or conflicted, a replacement is appointed by `[REPLACEMENT_APPOINTMENT_PROCEDURE]` within `[REPLACEMENT_WINDOW]`. The replacement must be prearranged or determinable without a party's unilateral discretion where the profile requires it.

6.3. **Escalation:** a decision of the reviewer may be escalated by either party through `[ESCALATION_PROCEDURE]` to `[ESCALATION_TARGET]`.

6.4. **Appeals:** there are a finite number of appeal stages, specified as `[APPEAL_STAGES]`, with an appeal budget `[APPEAL_BUDGET_BASE_UNITS]`. No appeal stage extends the final cutoff (policy §B.4).

## 7. Dispute notice, evidence access, response/cure

7.1. **Dispute notice:** either party may initiate a dispute by `[DISPUTE_INITIATION_MECHANISM]`, with notice to the other party and the Evaluator.

7.2. **Evidence access in dispute:** each party has access to the evidence submitted in the commitment, subject to confidentiality (clause 10). Evidence retention and availability: `[EVIDENCE_RETENTION_TERM_AND_ACCESS]`.

7.3. **Response/cure opportunities:** the responding party has `[RESPONSE_WINDOW]` to respond to a dispute notice and `[CURE_WINDOW]` to cure the alleged breach before the dispute proceeds to resolution.

7.4. **Adjudication costs are separately funded.** Dispute adjudication costs are funded from a separately accounted dispute-cost reserve `[RESERVE_AMOUNT_BASE_UNITS]` (clause 2.6) and escalation budget `[ESCALATION_BUDGET_BASE_UNITS]` where the high-value layer applies. **No party automatically loses a dispute or its rights solely because it cannot pay an unexpected fee.** Cost reallocation occurs only through the agreed authorized procedure `[COST_REALLOCATION_PROCEDURE]`.

## 8. Longstop disposition and terminal allocation

8.1. **Longstop:** at the longstop time `[LONGSTOP_TIME]`, if the escrow has not reached a terminal state through the processes above, the held funds are disposed of as follows: `[LONGSTOP_ALLOCATION]` (an exact allocation among fixed beneficiaries), executed by `[LONGSTOP_EXECUTOR]` under `[LONGSTOP_MECHANISM]`.

8.2. **External-custody handoff (alternative):** where the parties and profile approve an external-custody handoff, it must be an executable arrangement `[EXTERNAL_CUSTODY_HANDOFF_DESCRIPTION]` with identified custodian, terms, and executor. **A provider name alone is not evidence of an executable handoff** (policy §D.7, profiles §5.7); the handoff must be executable under defined terms before admission.

8.3. For advanced profiles, no automatic whole-transaction buyer refund applies after value has changed hands (policy §D.4); only separable disputed amounts are held (policy §D.5); and previously released funds are not recoverable through a lifecycle-state change (policy §D.6).

## 9. Physical goods, returns, cancellation, usage rights (where applicable)

9.1. **(Physical delivery profile only)** Goods: `[GOODS_SPECIFICATION]`. Shipment/inspection/acceptance/retention milestones: `[MILESTONE_DETAILS]`. Carrier evidence (`[CARRIER_EVIDENCE_TYPES]`) is distinct from conformity evidence (`[CONFORMITY_EVIDENCE_TYPES]`). Transit-risk allocation: `[TRANSIT_RISK_ALLOCATION]`; insurance responsibility: `[INSURANCE_RESPONSIBLE]`; ownership transfer at `[OWNERSHIP_TRANSFER_POINT]`; Incoterm `[INCOTERM_CODE]` version `[INCOTERM_VERSION]` named place `[NAMED_PLACE]` (only where agreed). Return costs: `[RETURN_COST_BEARER]`; return evidence: `[RETURN_EVIDENCE]`; salvage treatment: `[SALVAGE_TREATMENT]`.

9.2. **No retain-goods-and-full-payment:** a refund is conditional on return of the goods or an agreed disposition; the Buyer may not retain the goods and the full payment simultaneously (`[RULE_REF]`).

9.3. **(Subjective service profile only)** Revisions: `[MAX_REVISIONS]` within `[CURE_WINDOW]`; client dependencies: `[CLIENT_DEPENDENCIES]`; feedback windows: `[FEEDBACK_WINDOWS]`; change orders: `[CHANGE_ORDER_PROCEDURE]`.

9.4. **Cancellation** compensation: `[CANCELLATION_COMPENSATION]`; earned-work milestones: `[EARNED_MILESTONES]`. Intellectual-property/usage terms: `[IP_USAGE_TERMS]`, and their relationship to payment: `[IP_PAYMENT_RELATIONSHIP]`. No unconstrained AI model acts as final adjudicator for the initial profile (profiles §3).

## 10. Confidentiality, amendments, authority changes

10.1. **Confidentiality.** Each party shall treat the other's confidential information disclosed under this Addendum as confidential, except where disclosure is required by law, to professional advisors, or as needed to exercise rights under this Addendum. Confidentiality term: `[CONFIDENTIALITY_TERM]`.

10.2. **Evidence availability and retention** for this commitment: `[EVIDENCE_RETENTION_TERM_AND_ACCESS]`, extending `[EVIDENCE_RETENTION_AFTER_TERMINAL]` after the escrow reaches a terminal state.

10.3. **Amendments.** This Addendum may be amended only by a written instrument signed by both parties and, where the amendment affects evaluator authority or permitted outcomes, the Evaluator. No amendment applies retrospectively to a funded commitment (policy §A.5).

10.4. **Authority changes.** Either party may change its authorized representative only by written notice to the other party, and the change is effective `[AUTHORITY_CHANGE_EFFECTIVE_DELAY]` after notice. Authority changes do not alter the fixed beneficiaries, amounts, or deadlines (policy §A.5).

## 11. No guarantees; signature/consent

11.1. **No guaranteed reimbursement, insurance, or universal legal enforceability.** SAAX and the operator make no promise of unconditional recovery, guaranteed fairness, or guaranteed legal enforceability (policy §F.6). Refunds under this Addendum are separate transfers; they do not reverse blockchain history. This Addendum does not constitute insurance, and no reimbursement guarantee is provided. Where a rule depends on third parties (token, network, evaluator), that dependency is disclosed and no guarantee is made.

11.2. **Status of this template.** This is an internal template. The completed Addendum requires qualified legal review before participant-funded use. This template and any completed Addendum do not assert enforceability in any jurisdiction; governing law, forum, and institutional rules are left for selection and review and are not supplied here.

11.3. **Signatures.** By signing the Agreement digest (or its machine-readable equivalent), each party: (a) confirms its acceptance of this Addendum's terms, including (where applicable) the express seller consent in clause 4.3; (b) confirms its authorized representative has authority to bind it; and (c) agrees that the signed digest is the authoritative record of the parties' consent.

> **Signature block (transaction-specific completion required):**
>
> Buyer: `[BUYER_NAME_OR_ID]` — signature over Agreement digest: `[BUYER_SIGNATURE_OR_REF]` — date: `[DATE]`
>
> Seller: `[SELLER_NAME_OR_ID]` — signature over Agreement digest: `[SELLER_SIGNATURE_OR_REF]` — date: `[DATE]`
>
> Evaluator (where evaluator consent is required): `[EVALUATOR_ENTITY]` — signature: `[EVALUATOR_SIGNATURE_OR_REF]` — date: `[DATE]`