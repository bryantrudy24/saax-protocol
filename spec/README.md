# SAAX Protocol Specification

SAAX Protocol is a vendor-neutral standard for governed, contract-defined, outcome-verified, recoverable and auditable economic commitments between autonomous systems. This specification describes the commitment schema, its lifecycle, the interfaces for external authority proofs and evidence, the settlement-linkage abstraction, and the canonical error codes that conforming implementations must return.

The specification is under active development (v1 draft). Current documents cover the commitment schema, lifecycle, authority and evidence interfaces, settlement linkage, and error codes. Additional documents — conformance fixtures, node deployment guidance, threat model, and full error taxonomy — are in development.

## Specification documents

| Document | Scope |
|---|---|
| [commitment-schema.md](commitment-schema) | The canonical JSON schema for a SAAX commitment: fields, types, required/optional status, hashing rules, signing rules, and an example object |
| [lifecycle.md](lifecycle) | The commitment state machine: all states, valid transitions, trigger conditions, terminal states, recovery resolution, and a state diagram |
| [authority-proof-interface.md](authority-proof-interface) | The interface for external authority proofs: structure, supported proof types, validation rules, and behavior on valid/expired/out-of-scope proofs |
| [evidence-interface.md](evidence-interface) | The interface for external evidence: structure, verification-policy model, evaluation outcomes, supported verification schemes, freshness and minimum-count rules |
| [settlement-linkage.md](settlement-linkage) | The settlement-reference abstraction: the rule that SAAX prescribes no settlement rail, the SettlementRail interface, and registered reference rails |
| [error-codes.md](error-codes) | The canonical error codes: validation, state, authority, evidence, settlement, recovery, and system errors with remediation guidance |

## How to use this specification

1. **Implement against it.** Read `commitment-schema.md` and `lifecycle.md` first — they define what a commitment is and how it moves. Then implement the authority-proof and evidence interfaces (`authority-proof-interface.md`, `evidence-interface.md`) for external verification, and the settlement linkage (`settlement-linkage.md`) for rail-agnostic settlement references.
2. **Return the canonical errors.** Use the error codes in `error-codes.md` so clients and other nodes get consistent, actionable failures.
3. **Prove conformance.** Run the [conformance test suite](../conformance) against your implementation. The suite provides test vectors for commitments, signatures, hashes, lifecycle transitions, evidence evaluation, authority validation, settlement linkage, and error codes. A conforming implementation passes every vector.

## Reference implementation

SAAX Router is one implementation of this specification. It operates on Base mainnet, settles via USDC through the x402 and MPP rails, and is available at https://settlement.saax-protocol.com. The Router is a commercial service; it is not the specification, and the specification does not require it.