# SAAX Conformance Vectors

*55 test vectors across 8 categories. Each file is served directly at the path shown below.*


## authority (5)

- [authority-badsig-004](/conformance/vectors/authority/authority-badsig-004.json) - A proof with a bad signature is rejected
- [authority-expired-002](/conformance/vectors/authority/authority-expired-002.json) - An expired authority proof is rejected
- [authority-malformed-005](/conformance/vectors/authority/authority-malformed-005.json) - A structurally malformed proof is rejected
- [authority-outscope-003](/conformance/vectors/authority/authority-outscope-003.json) - A proof out of scope for the requested action/amount is rejected
- [authority-valid-001](/conformance/vectors/authority/authority-valid-001.json) - A valid in-scope authority proof passes validation

## commitments (10)

- [commitment-accepted-002](/conformance/vectors/commitments/commitment-accepted-002.json) - A commitment all parties signed (accepted state)
- [commitment-authority-ref-003](/conformance/vectors/commitments/commitment-authority-ref-003.json) - A commitment referencing an external authority proof
- [commitment-basic-001](/conformance/vectors/commitments/commitment-basic-001.json) - A minimal valid commitment with required fields only
- [commitment-empty-criteria-009](/conformance/vectors/commitments/commitment-empty-criteria-009.json) - Commitment with no acceptance criteria (edge)
- [commitment-expired-deadline-008](/conformance/vectors/commitments/commitment-expired-deadline-008.json) - Commitment with a deadline in the past
- [commitment-invalid-address-007](/conformance/vectors/commitments/commitment-invalid-address-007.json) - Commitment with an invalid party address
- [commitment-missing-id-004](/conformance/vectors/commitments/commitment-missing-id-004.json) - Commitment missing the required commitmentId
- [commitment-missing-party-005](/conformance/vectors/commitments/commitment-missing-party-005.json) - Commitment missing a required party
- [commitment-negative-amount-006](/conformance/vectors/commitments/commitment-negative-amount-006.json) - Commitment with a negative amount
- [commitment-no-settlement-010](/conformance/vectors/commitments/commitment-no-settlement-010.json) - Commitment without a settlement requirement (R unset)

## errors (10)

- [errors-expired-005](/conformance/vectors/errors/errors-expired-005.json) - Input that must produce ST_EXPIRED_COMMITMENT
- [errors-insufficient-evidence-007](/conformance/vectors/errors/errors-insufficient-evidence-007.json) - Input that must produce EVI_INSUFFICIENT_EVIDENCE
- [errors-invalid-commitment-001](/conformance/vectors/errors/errors-invalid-commitment-001.json) - Input that must produce VAL_INVALID_COMMITMENT
- [errors-invalid-transition-004](/conformance/vectors/errors/errors-invalid-transition-004.json) - Input that must produce ST_INVALID_TRANSITION
- [errors-kill-switch-010](/conformance/vectors/errors/errors-kill-switch-010.json) - Input that must produce SYS_KILL_SWITCH
- [errors-malformed-signature-003](/conformance/vectors/errors/errors-malformed-signature-003.json) - Input that must produce VAL_MALFORMED_SIGNATURE
- [errors-missing-proof-006](/conformance/vectors/errors/errors-missing-proof-006.json) - Input that must produce AUTH_MISSING_PROOF
- [errors-rate-limited-009](/conformance/vectors/errors/errors-rate-limited-009.json) - Input that must produce SYS_RATE_LIMITED
- [errors-required-field-002](/conformance/vectors/errors/errors-required-field-002.json) - Input that must produce VAL_REQUIRED_FIELD
- [errors-unsupported-rail-008](/conformance/vectors/errors/errors-unsupported-rail-008.json) - Input that must produce SET_UNSUPPORTED_RAIL

## evidence (5)

- [evidence-insufficient-003](/conformance/vectors/evidence/evidence-insufficient-003.json) - One valid evidence but policy requires 2 -> insufficient_evidence
- [evidence-not-satisfied-002](/conformance/vectors/evidence/evidence-not-satisfied-002.json) - Evidence whose evaluated logic is false -> not_satisfied
- [evidence-satisfied-001](/conformance/vectors/evidence/evidence-satisfied-001.json) - Valid fresh evidence from an accepted issuer satisfies the criterion
- [evidence-stale-005](/conformance/vectors/evidence/evidence-stale-005.json) - Evidence older than maxEvidenceAge -> stale
- [evidence-tampered-004](/conformance/vectors/evidence/evidence-tampered-004.json) - Payload hash mismatch -> invalid evidence

## hashes (5)

- [hash-canonical-001](/conformance/vectors/hashes/hash-canonical-001.json) - Canonical digest of the basis commitment
- [hash-deadline-change-004](/conformance/vectors/hashes/hash-deadline-change-004.json) - Digest changes with deadline
- [hash-empty-object-005](/conformance/vectors/hashes/hash-empty-object-005.json) - Canonical hash of the empty object (sha256 of "{}")
- [hash-key-order-003](/conformance/vectors/hashes/hash-key-order-003.json) - Digest is invariant to object key order (sorted canonicalization)
- [hash-price-change-002](/conformance/vectors/hashes/hash-price-change-002.json) - Digest changes when price changes (field ordering canonical)

## lifecycle (10)

- [lifecycle-accepted-executing-003](/conformance/vectors/lifecycle/lifecycle-accepted-executing-003.json) - accepted -> executing (provider starts)
- [lifecycle-executing-evidence-pending-004](/conformance/vectors/lifecycle/lifecycle-executing-evidence-pending-004.json) - executing -> evidence_pending (obligation complete)
- [lifecycle-fulfilled-settled-006](/conformance/vectors/lifecycle/lifecycle-fulfilled-settled-006.json) - fulfilled -> settled (settlement realised)
- [lifecycle-invalid-expired-010](/conformance/vectors/lifecycle/lifecycle-invalid-expired-010.json) - expired -> accepted is INVALID (terminal by time)
- [lifecycle-invalid-issued-fulfilled-008](/conformance/vectors/lifecycle/lifecycle-invalid-issued-fulfilled-008.json) - issued -> fulfilled is INVALID
- [lifecycle-invalid-terminal-009](/conformance/vectors/lifecycle/lifecycle-invalid-terminal-009.json) - finalized -> any state is INVALID (terminal)
- [lifecycle-issued-accepted-001](/conformance/vectors/lifecycle/lifecycle-issued-accepted-001.json) - issued -> accepted (no authority ref, all signed)
- [lifecycle-issued-authority-002](/conformance/vectors/lifecycle/lifecycle-issued-authority-002.json) - issued -> authority_validated (valid proof)
- [lifecycle-settled-finalized-007](/conformance/vectors/lifecycle/lifecycle-settled-finalized-007.json) - settled -> finalized (audit complete)
- [lifecycle-verifying-fulfilled-005](/conformance/vectors/lifecycle/lifecycle-verifying-fulfilled-005.json) - verifying -> fulfilled (all criteria satisfied)

## settlement (5)

- [settlement-invalid-credential-004](/conformance/vectors/settlement/settlement-invalid-credential-004.json) - A credential without a signature fails validation against R
- [settlement-mpp-002](/conformance/vectors/settlement/settlement-mpp-002.json) - MPP rail resolves when explicitly requested
- [settlement-realise-005](/conformance/vectors/settlement/settlement-realise-005.json) - realise(R) produces a credential referencing the rail
- [settlement-unsupported-003](/conformance/vectors/settlement/settlement-unsupported-003.json) - An unsupported rail is rejected
- [settlement-x402-001](/conformance/vectors/settlement/settlement-x402-001.json) - x402 rail resolves for an R with rail null (default rail)

## signatures (5)

- [signature-expired-004](/conformance/vectors/signatures/signature-expired-004.json) - A signature whose validity window has passed
- [signature-invalid-002](/conformance/vectors/signatures/signature-invalid-002.json) - A malformed signature (wrong hex)
- [signature-valid-001](/conformance/vectors/signatures/signature-valid-001.json) - A valid buyer signature over the commitment digest
- [signature-wrong-digest-005](/conformance/vectors/signatures/signature-wrong-digest-005.json) - Signature over the wrong digest
- [signature-wrong-signer-003](/conformance/vectors/signatures/signature-wrong-signer-003.json) - Signature from a party not in the commitment

---
*Total: 55 vectors.*
