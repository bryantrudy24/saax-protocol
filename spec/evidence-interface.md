# SAAX Evidence Interface

SAAX commitments are fulfilled against externally-produced, independently-verifiable evidence. SAAX does not produce evidence; it validates and evaluates evidence against the commitment's acceptance criteria and verification policies. This document defines the evidence structure, the verification-policy model, the evaluation outcomes, the supported verification schemes, and the freshness and minimum-count rules.

## 1. Evidence structure

```json
{
  "evidenceId": "0x...",
  "evidenceType": "temperature-reading",
  "issuer": "0x...",
  "subject": "0x...",
  "issuanceTimestamp": "2026-10-06T12:00:00Z",
  "contextReference": "0x...",
  "payload": { "maxTemperature": 4.2, "probe": "sensor-17" },
  "payloadHash": "sha256:...",
  "provenance": { "source": "iot-hub", "transport": "https", "traceId": "..." },
  "signature": "COSE_Sign1...",
  "verificationScheme": "cose",
  "verificationMaterial": "0x...",
  "commitmentId": "0x...",
  "acceptanceCriterionId": "c1"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `evidenceId` | string (0x-hex) | **required** | Unique evidence identifier |
| `evidenceType` | string | **required** | Domain-specific type, e.g. `temperature-reading`, `delivery-receipt`, `inspection-report` |
| `issuer` | string (0x-address) | **required** | Who produced the evidence |
| `subject` | string (0x-address) | **required** | What the evidence is about (agent, asset, commitment) |
| `issuanceTimestamp` | string (ISO-8601 UTC) | **required** | When the evidence was produced |
| `contextReference` | string (0x-hex) | optional | Request/context reference linking evidence to an execution event |
| `payload` | object | **required** | The evidence content |
| `payloadHash` | string (`sha256:...`) | **required** | Canonical SHA-256 hash of the payload |
| `provenance` | object | optional | Source chain / transport metadata (`source`, `transport`, `traceId`) |
| `signature` | string | **required** | Cryptographic proof of integrity over the canonical evidence payload |
| `verificationScheme` | enum: `eip712` \| `cose` \| `jws` | **required** | Scheme that verifies this evidence |
| `verificationMaterial` | string (0x-address or public key) | **required** | Key/certificate reference for verification |
| `commitmentId` | string (0x-hex) | **required** | The commitment this evidence binds to |
| `acceptanceCriterionId` | string | **required** | Which acceptance criterion this evidence satisfies |

## 2. Verification-policy model

A commitment specifies a verification policy for each acceptance criterion (or a default policy). The policy declares how evidence for that criterion is evaluated:

```json
{
  "criterionId": "c1",
  "criterionDescription": "delivery temperature <= 5C",
  "requiredEvidenceType": "temperature-reading",
  "acceptedIssuers": ["0x..."],
  "verificationScheme": "cose",
  "evaluationLogic": "payload.maxTemperature <= 5",
  "maxEvidenceAge": 3600,
  "minimumEvidenceCount": 1
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `criterionId` | string | optional | Policy applies to this criterion |
| `criterionDescription` | string | optional | Human-readable criterion |
| `requiredEvidenceType` | string | optional | Evidence must carry this type |
| `acceptedIssuers` | array (0x-addresses) | optional | Allowlist; when present, evidence from unlisted issuers is rejected |
| `verificationScheme` | enum: `eip712` \| `cose` \| `jws` | **required** | Scheme the evidence must use |
| `evaluationLogic` | string | optional | Safe numeric/categorical comparison over payload fields, e.g. `payload.maxTemperature <= 5`; `payload.complete == true` |
| `maxEvidenceAge` | integer (seconds) | **required** | Evidence older than this (from `issuanceTimestamp` to evaluation time) fails freshness |
| `minimumEvidenceCount` | integer | **required** | Minimum number of valid evidence records required for `satisfied` |

**Evaluation logic safety:** `evaluationLogic` is restricted to comparisons over payload fields (numeric `<`,`<=`,`>`,`>=`,`==`,`!=` and boolean `== true/false`). Implementations MUST NOT execute arbitrary code from the policy.

## 3. Evaluation outcomes

For each acceptance criterion, the evaluation of the candidate evidence set yields exactly one of:

| Outcome | Meaning |
|---|---|
| `satisfied` | Enough fresh, valid evidence; every policy check passed (type, issuers, scheme, logic) |
| `not_satisfied` | Valid evidence exists but the evaluation logic evaluates false (or contradicts the criterion) |
| `insufficient_evidence` | Not enough valid evidence: count below minimum, all stale, all structurally invalid, or issuer-blocked — the outcome is undetermined |

If **any** criterion resolves `not_satisfied`, the commitment fails (no recovery path). If any resolves `insufficient_evidence` and recovery allows resubmission, the commitment enters `recovering`; otherwise it fails.

## 4. Supported verification schemes

| Scheme | Meaning |
|---|---|
| `eip712` | EIP-712 typed-data signature over the canonical evidence payload; verify with `verifyTypedData` against `verificationMaterial` |
| `cose` | COSE_Sign1 document (`COSE_Sign1...`); verify structure, protected headers, and the signature over the signed payload |
| `jws` | JSON Web Signature (`eyJ...`); verify the compact serialization's signature over the signing input against the verification key |

## 5. Freshness and minimum-count rules

- **Freshness:** `now - issuanceTimestamp <= maxEvidenceAge`. Evidence exceeding the age is rejected as stale regardless of validity.
- **Minimum count:** the evaluation must see `>= minimumEvidenceCount` **valid, fresh** evidence records for the criterion; otherwise the outcome is `insufficient_evidence`.
- **Type match:** evidence `evidenceType` must equal `requiredEvidenceType` when the policy sets it.
- **Issuer allowlist:** when `acceptedIssuers` is present, evidence `issuer` must be in the list.
- **Binding:** evidence `commitmentId` must equal the commitment under evaluation and `acceptanceCriterionId` must equal the policy's criterion; else the evidence is rejected as mis-bound.

## 6. Reference example evidence

- Valid evidence satisfying the temperature criterion — `conformance/vectors/evidence/evidence-satisfied-001.json`.
- Tampered payload (hash mismatch) — `conformance/vectors/evidence/evidence-tampered-001.json`.
- Stale evidence (older than the policy's `maxEvidenceAge`) — `conformance/vectors/evidence/evidence-stale-001.json`.

## 7. Conformance

Evidence test vectors live in the [conformance suite](../conformance). A conforming implementation produces the expected outcome (`satisfied` / `not_satisfied` / `insufficient_evidence`) for each vector.