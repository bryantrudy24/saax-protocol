# SAAX Conformance Test Suite

This suite proves whether an implementation conforms to the SAAX Protocol specification. It provides test vectors for commitments, signatures, hashes, lifecycle transitions, evidence evaluation, authority validation, settlement linkage, and error codes, plus a runner that executes the vectors against any SAAX implementation.

## Directory structure

```text
conformance/
  README.md
  vectors/
    commitments/   — canonical commitment objects (valid/invalid/edge)
    signatures/    — known signatures and expected verification results
    hashes/        — known payloads and expected hashes
    lifecycle/     — state transition sequences
    evidence/      — evidence objects and expected evaluations
    authority/     — authority proofs and expected validations
    settlement/    — settlement references and expected linkages
    errors/        — inputs that should produce specific error codes
  runner/
    run-conformance.mjs  — the test runner
  fixtures/
    keys/          — TEST-ONLY keys (never used on mainnet)
```

## How to use

```bash
# Point the runner at your implementation and run all vectors
node conformance/runner/run-conformance.mjs

# Or point at a specific implementation module (the Router's endpoint modules by default)
env SAAX_IMPL_MODULE=/path/to/your-impl.js node conformance/runner/run-conformance.mjs
```

The runner reads every JSON file under `vectors/`, invokes the corresponding implementation function, compares the result against the vector's `expected`, and reports:

```text
[PASS] commitment-basic-001 — minimal valid commitment
[FAIL] commitment-invalid-001 — expected valid:false, got valid:true
Summary: 55 passed, 0 failed
```

Exit code: **0** if all vectors pass, **1** if any fail.

## Vector format

```json
{
  "id": "commitment-basic-001",
  "description": "A minimal valid commitment with required fields only",
  "input": { ... },
  "expected": {
    "valid": true,
    "hash": "0x...",
    "state_after_issuance": "issued"
  }
}
```

## Implementation targeting

By default the runner loads the local reference implementation modules (`endpoint/requirement.js`, `endpoint/evidence.js`, `endpoint/authority.js`). To run against a different implementation, set `SAAX_IMPL_MODULE` to a module that exports the conformance contract functions (see `runner/run-conformance.mjs` for the expected exports). The reference implementation (SAAX Router) passes this suite; a conforming implementation must too.

## Test keys

`fixtures/keys/` contains **TEST-ONLY keys**. They are generated for this suite, hold no funds, and must never be used on any mainnet. See the warnings in that directory.

## Not a guarantee

Passing the suite demonstrates conformance to the tested behaviors of this v1 draft specification. It is not a security audit and does not certify production readiness.