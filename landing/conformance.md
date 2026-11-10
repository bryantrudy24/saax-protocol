# SAAX Conformance Suite

*Public conformance tests for the SAAX Protocol specification. Any implementation that claims SAAX conformance can run this suite to prove it.*

## Overview

The SAAX Conformance Suite is a set of test vectors and a runner that verify an implementation matches the SAAX Protocol specification. It is for:

- **Implementation teams** — prove your implementation conforms to the standard
- **Auditors and reviewers** — independently check a claimed-conformant node
- **The SAAX Network (planned)** — once independent nodes operate, their conformance is assessed against these vectors. The federated network is not yet deployed; the only running endpoint is the SAAX Router, operated by the SAAX team.

The suite is provider-neutral: it tests the *standard*, not any one product. The reference implementation used to validate the vectors is the SAAX Router, but the runner works against any implementation that exposes the same function contract.

## What It Tests

The suite covers eight areas of the specification:

| Category | Vectors | What it verifies |
|---|---|---|
| commitments | 10 | Commitment schema validity: required fields, addresses, amounts, settlement requirements |
| signatures | 5 | Signature verification: valid, malformed, wrong signer, wrong digest, expired |
| hashes | 5 | Canonical hashing: key-order invariance, field-ordering sensitivity, known digests |
| lifecycle | 10 | State machine: valid transitions, invalid transitions, terminal states |
| evidence | 5 | Evidence evaluation: satisfied, not_satisfied, insufficient, tampered, stale |
| authority | 5 | Authority proof validation: valid, expired, out-of-scope, bad signature, malformed |
| settlement | 5 | Settlement linkage: x402/MPP rails, unsupported rail, invalid credential, realise(R) |
| errors | 10 | Error classification: each input maps to the canonical error code |

## How to Run It

Requirements: Node.js 18+ and the implementation modules you want to test.

```bash
# from your copy of the suite
cd conformance
node runner/run-conformance.mjs
```

Expected output ends with:

```
Summary: 55 passed, 0 failed (55 total)
```

The runner exits `0` when every vector passes, and `1` if any fail.

## Test Vector Format

Each vector is a JSON file with `id`, `description`, `input`, and `expected`:

```json
{
  "id": "commitment-basic-001",
  "description": "A minimal valid commitment with required fields only",
  "input": { "...": "the commitment object" },
  "expected": {
    "valid": true,
    "state_after_issuance": "issued"
  }
}
```

A full worked example: [commitment-basic-001.json](/conformance/vectors/commitments/commitment-basic-001.json)

## Implementing Against SAAX

The runner calls a fixed set of functions. Point it at your implementation with the `SAAX_IMPL_MODULE` environment variable:

```bash
SAAX_IMPL_MODULE=/path/to/your-impl.mjs node runner/run-conformance.mjs
```

Your module must export these functions:

| Function | Vectors using it |
|---|---|
| `validateCommitment(commitment)` | commitments, errors |
| `verifyPartySignature(input)` | signatures |
| `commitmentDigest(commitment)` | hashes |
| `transition(input)` | lifecycle |
| `evaluateCriterion(criterion, evidence[])` | evidence |
| `validateAuthorityProof(proof, commitment)` | authority |
| `resolveSettlementVector(input)` | settlement |
| `classifyError(input)` | errors |

The runner source is public: [run-conformance.mjs](/conformance/runner/run-conformance.mjs).

## Current Suite Status

**55 vectors passing** against the reference implementation (SAAX Router). These published vectors are conformance fixtures for the commitment schema, signatures, hashes, lifecycle, evidence, authority, settlement linkage, and error classification. They are distinct from (a) tampering tests — which mutate a record and assert that verification rejects it — and (b) lifecycle verification checks — which validate a full commitment history against chain data via the standalone verifier. A passing vector suite means the reference implementation conforms to the published standard’s tested behavior. It is **not** an independent audit, a security certification, or a guarantee of production readiness.

## MCP Tool Surface

The MCP endpoint currently exposes **11 tools**: `create_commitment`, `get_protocol_info`, `get_routing_fee`, `ping`, `route_request`, `get_commitment`, `list_capabilities`, `get_authority_validation`, `get_evidence_verification`, `list_commitments`, and `get_commitment_status`.

## Contributing Vectors

The suite is open to new vectors. Contributions should:

- Target one of the eight categories
- Be a single JSON file matching the vector format
- Include a description of the behavior being pinned down
- Add at least one positive and one negative case for any new behavior

To submit, use the support contact in the [integration guide](/docs). Test vectors use test-only keys — never real mainnet keys.

## The Specification

The vectors pin down behavior defined in the [SAAX Protocol specification](/spec). Where the spec and a vector disagree, the vector records the shipped behavior of the reference implementation.