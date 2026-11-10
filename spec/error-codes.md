# SAAX Error Codes

This document is the canonical error taxonomy for SAAX. Every conforming implementation MUST return these error codes in the documented shape. Errors are grouped by category; each entry includes the numeric code, string identifier, HTTP status, description, and remediation guidance.

**Error response shape (canonical):**

```json
{
  "error": {
    "code": "VAL_REQUIRED_FIELD",
    "codeNumber": 40001,
    "message": "Commitment missing required field: commitmentId",
    "status": 400,
    "category": "validation",
    "remediation": "Provide the missing field per spec/commitment-schema.md"
  }
}
```

## 1. Validation errors (category `validation`, HTTP 400/422)

| Code | # | HTTP | Description | Remediation |
|---|---|---|---|---|
| `VAL_INVALID_COMMITMENT` | 40001 | 400 | The commitment object is not a valid SAAX commitment (schema violation) | Validate against `spec/commitment-schema.md` before submission |
| `VAL_REQUIRED_FIELD` | 40002 | 400 | A required field is missing | Provide the named field |
| `VAL_MALFORMED_SIGNATURE` | 40003 | 422 | A required signature is malformed (bad encoding, wrong scheme) | Re-sign using the canonical signing rules |
| `VAL_INVALID_ADDRESS` | 40004 | 422 | A party/issuer field is not a valid address | Use a valid 0x-address |
| `VAL_INVALID_AMOUNT` | 40005 | 422 | `paymentTerms.amount` is not a positive decimal | Provide a valid amount string |

## 2. State errors (category `state`, HTTP 409)

| Code | # | HTTP | Description | Remediation |
|---|---|---|---|---|
| `ST_INVALID_TRANSITION` | 41001 | 409 | The requested state transition is not valid from the current state | Consult `spec/lifecycle.md`; only valid transitions are permitted |
| `ST_EXPIRED_COMMITMENT` | 41002 | 409 | The commitment deadline has passed; the commitment is `expired` | Issue a new commitment |
| `ST_ALREADY_FINALIZED` | 41003 | 409 | The commitment is already in a terminal state (`finalized`) | Read-only access only; no transitions permitted |
| `ST_UNKNOWN_COMMITMENT` | 41004 | 404 | The commitmentId does not exist | Provide a valid commitmentId |

## 3. Authority errors (category `authority`, HTTP 403)

| Code | # | HTTP | Description | Remediation |
|---|---|---|---|---|
| `AUTH_MISSING_PROOF` | 42001 | 403 | An authority reference exists but no proof is present | Attach the authority proof reference |
| `AUTH_EXPIRED_PROOF` | 42002 | 403 | The authority proof is outside its validity window | Obtain a fresh proof from the issuer |
| `AUTH_OUT_OF_SCOPE` | 42003 | 403 | The proof does not cover the requested action/amount | Obtain a proof with wider scope |
| `AUTH_BAD_SIGNATURE` | 42004 | 403 | The proof's signature fails verification | Re-issue the proof with the correct signing key |
| `AUTH_UNKNOWN_ISSUER` | 42005 | 403 | The proof issuer is not recognized | Configure the issuer or use a recognized issuer |

## 4. Evidence errors (category `evidence`, HTTP 422)

| Code | # | HTTP | Description | Remediation |
|---|---|---|---|---|
| `EVI_INVALID_EVIDENCE` | 43001 | 422 | The evidence object is structurally invalid | Validate against `spec/evidence-interface.md` |
| `EVI_WRONG_COMMITMENT_BINDING` | 43002 | 422 | Evidence `commitmentId` does not match the commitment | Submit evidence for the correct commitment |
| `EVI_WRONG_CRITERION_BINDING` | 43003 | 422 | Evidence `acceptanceCriterionId` does not match the criterion | Submit evidence for the correct criterion |
| `EVI_INSUFFICIENT_EVIDENCE` | 43004 | 422 | Evaluation outcome is `insufficient_evidence` (count/freshness/issuer) | Submit additional valid, fresh evidence |
| `EVI_STALE_EVIDENCE` | 43005 | 422 | Evidence exceeds `maxEvidenceAge` | Re-issue evidence at the time of fulfillment |
| `EVI_BAD_SIGNATURE` | 43006 | 422 | Evidence signature fails verification | Re-issue evidence with the correct signing key |
| `EVI_ISSUER_NOT_ALLOWED` | 43007 | 422 | Evidence issuer not in the policy allowlist | Use an accepted issuer |
| `EVI_PAYLOAD_HASH_MISMATCH` | 43008 | 422 | `payloadHash` does not match the payload | Recompute the canonical hash over the payload |
| `EVI_NOT_SATISFIED` | 43009 | 422 | Evaluation outcome is `not_satisfied` (logic false) | Fulfil the criterion before submitting |

## 5. Settlement errors (category `settlement`, HTTP 402/409/422)

| Code | # | HTTP | Description | Remediation |
|---|---|---|---|---|
| `SET_UNSUPPORTED_RAIL` | 44001 | 422 | The requested rail is not registered | Use a registered rail or register the rail per `spec/settlement-linkage.md` |
| `SET_INVALID_CREDENTIAL` | 44002 | 402 | The payment credential fails validation against R | Obtain a valid credential from the rail |
| `SETTLEMENT_FAILED` | 44003 | 409 | `settle(Credential)` failed (broadcast/ledger rejection) | Retry with a fresh credential |
| `SET_REQUIREMENT_UNSET` | 44004 | 422 | The commitment has no settlement requirement (R) | Define `paymentTerms.settlementRequirement` |
| `SET_REQUIRED` | 44005 | 402 | Payment is required to proceed (x402 challenge) | Satisfy the 402 challenge with a payment credential |

## 6. Recovery errors (category `recovery`, HTTP 409/422)

| Code | # | HTTP | Description | Remediation |
|---|---|---|---|---|
| `REC_INVALID_DISPUTE` | 45001 | 422 | The dispute object is malformed or lacks required fields | Provide a well-formed `disputeState` |
| `REC_RECOVERY_NOT_AVAILABLE` | 45002 | 409 | The commitment's recovery policy permits no recovery (retries exhausted or none configured) | Accept terminal failure or resolve the dispute |
| `REC_RETRY_EXHAUSTED` | 45003 | 409 | Retry budget (`recoveryPolicy.maxRetries`) exhausted | Apply refunds/compensation per policy |

## 7. System errors (category `system`, HTTP 429/503/500)

| Code | # | HTTP | Description | Remediation |
|---|---|---|---|---|
| `SYS_RATE_LIMITED` | 46001 | 429 | Request rate exceeds the per-window limit | Back off and retry after the window |
| `SYS_KILL_SWITCH` | 46002 | 503 | The service is halted by operator kill switch | Retry later; the operator controls the switch |
| `SYS_SERVICE_UNAVAILABLE` | 46003 | 503 | The service is unavailable (deploy, overload) | Retry with backoff |
| `SYS_INTERNAL` | 46004 | 500 | Unhandled internal error | Report to the operator with the request trace |

## 8. Conformance

Error test vectors live in the [conformance suite](../conformance). A conforming implementation returns the exact `code` for each vector input. The numeric codes and HTTP statuses above are canonical; clients should switch on `code` (string), never on message text.