# SAAX Authority-Proof Interface

SAAX commitments may be authorized by an external authority proof rather than assuming the buyer's signature is sufficient. This document defines the authority-proof structure, the supported proof types, the validation rules, and what a conforming implementation does with valid, expired, or out-of-scope proofs.

**Critical rule:** SAAX does not issue authority proofs. It consumes them from external systems (AP2 mandates, Verifiable Intent, OAuth, or custom issuers) and evaluates them at issuance and at execution time.

## 1. Authority-proof structure

```json
{
  "authorityProofId": "0x...",
  "proofType": "ap2-mandate",
  "issuer": "0x...",
  "subject": "0x...",
  "scope": {
    "actions": ["settle", "request-commitment"],
    "capability": "security-scan",
    "amountMax": "250000",
    "currency": "USD"
  },
  "validFrom": "2026-10-06T00:00:00Z",
  "validUntil": "2026-10-07T00:00:00Z",
  "signature": "COSE_Sign1...",
  "verificationScheme": "cose",
  "verificationMaterial": "0x..."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `authorityProofId` | string (0x-hex) | **required** | Unique proof identifier |
| `proofType` | enum: `ap2-mandate` \| `verifiable-intent` \| `oauth-token` \| `custom` | **required** | Which proof family this is |
| `issuer` | string (0x-address or URI) | **required** | Who issued the proof |
| `subject` | string (0x-address) | **required** | The agent being authorized |
| `scope` | object | **required** | What the subject is authorized to do (`actions[]`, optional `capability`, `amountMax`, `currency`) |
| `validFrom` | string (ISO-8601 UTC) | **required** | Proof validity start |
| `validUntil` | string (ISO-8601 UTC) | **required** | Proof validity end |
| `signature` | string | **required** | Cryptographic proof of integrity |
| `verificationScheme` | enum: `cose` \| `jws` \| `eip712` | **required** | Scheme that verifies this proof |
| `verificationMaterial` | string (0x-address or public key) | **required** | Key/certificate reference for verification |

## 2. Supported proof types

| `proofType` | Source system | Notes |
|---|---|---|
| `ap2-mandate` | AP2-style mandate delegations | A principal mandates an agent to act within a defined scope |
| `verifiable-intent` | Verifiable Intent (EIP-7857-style) systems | Signed intent that authorizes specific commerce actions |
| `oauth-token` | OAuth2/OIDC authorization servers | Token scope translates to the `scope` object; verification via the issuer's JWKS |
| `custom` | Any external authority system | Must still satisfy the structural and verification rules below; the verification scheme names how to verify it |

## 3. Validation rules

A conforming implementation MUST reject a proof (authorization fails) when any of the following fail:

| Rule | Check |
|---|---|
| **Structure** | All required fields present and correctly typed; `validUntil >= validFrom` |
| **Signature** | `signature` verifies against `verificationMaterial` under `verificationScheme` |
| **Scope** | `scope.actions` includes the requested action; if `capability` is set, it matches the commitment's requested outcome category; if `amountMax` is set, the commitment's `paymentTerms.amount <= amountMax` and `currency` matches |
| **Time** | Now is within `[validFrom, validUntil]` (inclusive bounds) |

## 4. Behavior on valid / expired / out-of-scope proofs

| Case | Behavior |
|---|---|
| **Valid proof** | The commitment is authorized: `issued → authority_validated` at issuance; at execution time the proof is re-evaluated (still valid, still in scope) and execution proceeds |
| **Expired proof** | The commitment must not execute. If the proof expired before acceptance, the commitment is rejected at issuance (`INVALID_AUTHORITY`, `ATH_*` codes). If it expires during execution, the commitment transitions to `failed` (`authority_validated → failed`) or enters `disputed` per policy |
| **Out-of-scope proof** | The requested action/amount is not covered by `scope`; authorization fails (`AUTH_SCOPE` codes). The commitment is rejected at issuance |
| **Bad signature / unknown issuer** | Authorization fails (`AUTH_SIGNATURE`, `AUTH_ISSUER` codes); the commitment is rejected |

## 5. Attachment semantics

A commitment references the proof via `authorityReference` and `signaturesProofs.proofReferences` — **by reference, not by embedding the proof**. The proof itself is validated at issuance and re-evaluated at execution time. Implementations SHOULD NOT store the proof body on the commitment record (only the reference), preserving the audit chain's privacy.

## 6. Reference example proofs

- A valid `ap2-mandate` proof covering `["request-commitment","settle"]` for capability `security-scan`, valid 2026-10-06→2026-10-07, cose-signed — see `conformance/vectors/authority/authority-valid-001.json`.
- An expired proof — `conformance/vectors/authority/authority-expired-001.json`.
- An out-of-scope proof — `conformance/vectors/authority/authority-outscope-001.json`.

## 7. Conformance

Authority test vectors live in the [conformance suite](../conformance). A conforming implementation passes `authority-valid-*` (accept), `authority-expired-*`, `authority-outscope-*`, and `authority-badsig-*` (reject) vectors.