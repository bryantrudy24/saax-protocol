# SAAX Transaction Profiles — v1

**Status:** INTERNAL POLICY — controlled document. Not for publication.
**Version:** 1
**Prepared:** by the station overseer (Lucius Fox) under Phase 1 of the approved mainnet escrow plan.
**Purpose:** define the transaction profile types SAAX custody may support, the required fields for each, and the activation inputs that remain unresolved. Profiles are the agreement-level counterpart to the policy rules in `custody-policy-v1.md`.
**Scope discipline:** this document defines requirements. It does not implement, deploy, or enable anything. Every profile in this document is **disabled for mainnet funding in this phase**. A syntactically complete agreement is not a production-readiness certificate.

**Field notation:** `[required]` = must be present and valid for the profile to be structurally admitted; `[conditional]` = required when the referenced condition holds; `[activation input]` = required to activate the profile for real funding, value not yet resolved by the owner (recorded here as an input, NEVER invented as a default).

---

## 1. OBJECTIVE_DIGITAL

Short-duration digital service with objectively checkable deliverables. This is the default profile for Phase 1.

### Required fields

| Field | Requirement | Notes |
|---|---|---|
| `profile` | `[required]` | `"OBJECTIVE_DIGITAL"` (must match exactly) |
| `policyVersion` | `[required]` | `"saax-custody-policy-v1"` — the exact versioned policy accepted by both parties |
| `policyDigest` | `[required]` | 0x-hex SHA-256 of the adopted policy document; must match the canonical policy digest registry |
| `deliverable` | `[required]` | Object: `{ description, format, objectiveAcceptanceCriteria[] }` — criteria must be objectively checkable (machine-verifiable), not subjective |
| `evidenceSources` | `[required]` | Submission mechanism: issuer(s) who may attest evidence, evidence type(s), and the submission channel; minimum evidence count and max evidence age |
| `deliveryDeadline` | `[required]` | ISO-8601 UTC; the time by which fulfillment must complete |
| `resolutionDeadline` | `[required]` | ISO-8601 UTC; end of the evaluator resolution window |
| `finalCutoff` | `[required]` | ISO-8601 UTC; at/after this, unresolved escrow becomes eligible for refund to the original buyer; MUST be ≥ delivery and resolution deadlines; fixed at funding |
| `buyerRefundTimeoutConsent` | `[required]` | `{ acceptedBySeller: true, cutoff: <finalCutoff>, effect: "refund to original buyer at/after cutoff" }` — the seller's explicit acceptance of the buyer-protective default |
| `evaluator` | `[required]` | `{ address, authorityRef, permittedOutcomes: ["release","refund"], nonce, expiry }` — the digest-covered evaluator authority |
| `asset` | `[required]` | Token address (0x-hex) or CAIP-19 asset; exactly one asset |
| `amount` | `[required]` | Exact integer in the token's base units (never floating point); whole-escrow amount |
| `chainId` | `[required]` | The chain the custody deployment binds (mainnet target: 8453; testnet: 84532) |
| `custodyAddress` | `[required]` | The exact custody contract address holding the escrow |
| `cutoffExtensionRule` | `[required]` | `"none"` — retries, repeated submissions, and dispute toggling MUST NOT extend the cutoff (policy B.4) |
| `partialAwards` | `[required]` | `false` — partial awards and arbitrary recipient changes are outside this profile (policy B.8) |

### Not supported in v1
- Partial awards / partial refunds / arbitrary recipient changes.
- Any extension of the final cutoff by retry, resubmission, or dispute toggling.
- Automatic execution (eligibility requires a submitter; policy B.7).

---

## 2. PHYSICAL_DELIVERY

Physical goods with shipment, inspection, acceptance, and retention milestones. **Disabled for mainnet funding in this phase** (requires longstop + legal review).

### Required fields

| Field | Requirement |
|---|---|
| `profile` | `[required]` `"PHYSICAL_DELIVERY"` |
| `policyVersion` / `policyDigest` | `[required]` as in OBJECTIVE_DIGITAL |
| `goodsSpecification` | `[required]` `{ description, quantity, unit, identityOrSerials? }` — serials/identity where relevant to the goods |
| `milestones` | `[required]` `{ shipment, inspection, acceptance, retention }` — each with a deadline and evidence requirement |
| `carrierEvidence` | `[required]` `{ requiredTypes, acceptedIssuers }` — carrier/tracking evidence, DISTINCT from conformity evidence |
| `conformityEvidence` | `[required]` `{ requiredTypes, acceptedIssuers }` — evidence the goods conform to spec |
| `transitRiskAllocation` | `[required]` `{ riskBearer, insuranceResponsible, ownershipTransferPoint }` |
| `incoterm` | `[conditional]` `{ code, version, namedPlace }` — when Incoterms are used; MUST NOT be invented when not agreed |
| `inspectionAndRejection` | `[required]` `{ inspectionWindow, rejectionProcedure, evidenceForRejection }` |
| `partialDelivery` | `[required]` `{ permitted: boolean, accountingRule }` — MUST NOT silently refund the whole contract after value has changed hands (policy D.4) |
| `returnTerms` | `[required]` `{ returnCostBearer, returnEvidence, salvageTreatment }` |
| `noRetainGoodsAndFullPayment` | `[required]` `{ rule: "buyer may not retain goods and full payment; refund is conditional on return or agreed disposition" }` — the no-refund rule that silently lets a buyer retain both goods and full payment is prohibited |
| `adjudication` | `[required]` `{ mechanism, appointmentRule, replacementRule, conflictsRule }` |
| `longstopDisposition` | `[required]` `{ at, allocation, executor }` — an EXECUTABLE longstop; an external provider name alone is not evidence of an executable handoff (policy D.7) |
| `evaluator` / `asset` / `amount` / `chainId` / `custodyAddress` | `[required]` as in OBJECTIVE_DIGITAL |
| `legalInstrumentReference` | `[activation input]` — the contractual/legal instrument and reviewed legal requirements; not yet resolved |

---

## 3. SUBJECTIVE_SERVICE

Services whose quality is judged (design, writing, strategy, bespoke engineering). **Disabled for mainnet funding in this phase.**

### Required fields

| Field | Requirement |
|---|---|
| `profile` | `[required]` `"SUBJECTIVE_SERVICE"` |
| `policyVersion` / `policyDigest` | `[required]` as in OBJECTIVE_DIGITAL |
| `brief` | `[required]` `{ description, references, deliverables, formats }` |
| `evaluationRubric` | `[required]` `{ criteria[], weights, passingThreshold }` — objective parts separated from subjective judgment |
| `objectiveRequirements` | `[required]` `{ list[] }` — must be separated from the subjective rubric |
| `subjectiveJudgment` | `[required]` `{ rubric, judgeRef }` — the part evaluated by the named expert, not by an unconstrained AI model |
| `revisionLimits` | `[required]` `{ maxRevisions, cureWindow }` |
| `clientDependencies` | `[required]` `{ neededInputs, feedbackWindows, delaysAttributableToClient }` |
| `changeOrders` | `[required]` `{ procedure, budgetImpactRule }` |
| `earnedMilestones` | `[required]` `{ milestones[], acceptanceDependentAmounts, cancellationCompensation }` — no automatic whole-contract refund after value has changed hands (policy D.4) |
| `intellectualProperty` | `[required]` `{ usageTerms, paymentRelationship }` — IP/usage terms and their relationship to payment |
| `namedExpert` | `[required]` `{ identity, appointmentMechanism, replacementMechanism }` — a NAMED expert or appointment mechanism |
| `noAIModelFinalAdjudicator` | `[required]` `{ rule: "no unconstrained AI model as final adjudicator for the initial profile" }` |
| `adjudication` / `longstopDisposition` | `[required]` as in PHYSICAL_DELIVERY |
| `evaluator` / `asset` / `amount` / `chainId` / `custodyAddress` | `[required]` as in OBJECTIVE_DIGITAL |
| `legalInstrumentReference` | `[activation input]` — not yet resolved |

---

## 4. HIGH_VALUE_ASSURANCE — composable additional layer

An additional layer that composes with any profile (OBJECTIVE_DIGITAL, PHYSICAL_DELIVERY, SUBJECTIVE_SERVICE). It is not a standalone profile. **Disabled for mainnet funding in this phase.**

### Required fields (when the layer is applied)

| Field | Requirement |
|---|---|
| `layer` | `[required]` `"HIGH_VALUE_ASSURANCE"` |
| `baseProfile` | `[required]` one of the three base profiles |
| `classificationRationale` | `[required]` `{ reasons[], maxExposure }` — rationale MUST consider irreversibility, complexity, replacement difficulty, and loss exposure; a nominal threshold alone does not trigger the layer (policy D.3) |
| `maxExposure` | `[required]` exact integer base units (the most the layer will hold) |
| `representatives` | `[required]` `{ buyerRep, sellerRep }` — authorized representatives with authority refs |
| `milestones` | `[required]` `{ independentlyAcceptedMilestones[], retentionRules }` |
| `independentSpecialist` | `[required]` `{ mechanism, conflictsRule, replacementAppointment }` — prearranged |
| `disputeCostReserve` | `[required]` `{ fundedReserve, escalationBudget }` — separate from principal, accounted explicitly |
| `legalInstrumentReference` | `[required]` `{ instrument, reviewedLegalRequirements }` — the contractual/legal instrument and its review status |
| `activationGate` | `[required]` `{ rule: "no activation merely because a nominal value threshold passes" }` |

---

## 5. Shared rules across all profiles

1. **Exact integers.** Monetary amounts are exact integers in the token's base units. Floating-point accounting is rejected.
2. **Milestone principal totals.** Milestone principal allocations MUST total the agreed principal. Dispute reserves and fees are separate from principal and accounted for explicitly.
3. **Deadline consistency.** `deliveryDeadline ≤ resolutionDeadline ≤ finalCutoff` for OBJECTIVE_DIGITAL; profile milestones must be internally consistent; deadlines must be in the future at funding.
4. **Address validity.** All addresses are 0x-hex 40-char (or CAIP-19 where the field says asset); invalid addresses are rejected.
5. **Policy version gating.** Only `saax-custody-policy-v1` (policyDigest verified) is admitted in this phase; unknown versions are rejected.
6. **Resolvable authority references.** Evaluator/authority references must be resolvable; advanced profiles require defined replacement and longstop mechanisms.
7. **Provider names are not handoffs.** An external provider name alone is not evidence of an executable custody handoff.

---

## 6. Activation inputs (unresolved, never invented)

The following are required to activate a profile for real funding. Values are NOT decided in this phase and MUST NOT be defaulted:

| Input | Profiles affected | Why it is unresolved |
|---|---|---|
| Mainnet custody deployment + address | All | G1/D1 decision (readiness package) — not deployed |
| Mainnet USDC address verification | All | Different from testnet `0x036CbD…CF7e`; must be re-derived and verified on 8453 |
| Exposure limits (per-position, aggregate; contract vs service) | All | G1/D8 decision — no numerical limits invented |
| 2-of-3 evaluator signing mechanism (contract-wallet compatibility) | All | Policy C.4–C.7 — mechanism not implemented; admission disabled until supported |
| Legal instrument + qualified legal review | PHYSICAL_DELIVERY, SUBJECTIVE_SERVICE, HIGH_VALUE_ASSURANCE | Profile-specific legal terms require review; none invented |
| Longstop executor identity (executable handoff) | ADVANCED profiles | Policy D.7 — provider names alone insufficient |
| Governing law / forum / institutional rules | Agreements | Left for selection and review; not invented |
| Dispute-cost reserve funding amounts | HIGH_VALUE_ASSURANCE | Economic parameter — owner decision |

A profile is **structurally valid but not activatable** when all structural fields pass and the activation inputs above remain unresolved. The admission result reports this distinction explicitly (see `mainnet/admission/README.md`).