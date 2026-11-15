# SAAX Mainnet Admission — Phase 1 (isolated schema + validator)

**INTERNAL, ISOLATED.** This module is **not wired into any production route**. It does not
enable mainnet funding for any profile. It validates the structural policy/profile
requirements defined in `mainnet/policies/` against synthetic agreements.

## Scope

- Base profiles: `OBJECTIVE_DIGITAL`, `PHYSICAL_DELIVERY`, `SUBJECTIVE_SERVICE`.
- Composable layer: `HIGH_VALUE_ASSURANCE` (adds controls; not a standalone profile).
- Policy gating: only `saax-custody-policy-v1` (with a valid 32-byte digest) is admitted.

## The four-way admission result

The validator distinguishes (see `validator.js` → `validateAdmission`):

| Category | Meaning |
|---|---|
| `structural` | The agreement shape is internally consistent (fields present, types correct, accounting balances, deadlines ordered). |
| `missingActivation` | Structurally valid but NOT activatable: required activation inputs are unresolved (mainnet custody deployment, mainnet USDC address, exposure limits, 2-of-3 evaluator mechanism, legal instrument for advanced profiles, longstop executor identity, dispute-cost reserve funding). |
| `unsupportedCapabilities` | The deployed custody contract cannot support what the agreement requires (e.g. contract-wallet signature verification, provider-name-only longstop). |
| `finalAdmission` | The final decision. **All new profiles are disabled for mainnet funding in this phase. A syntactically complete agreement is not a production-readiness certificate.** |

## What the validator enforces

- **Exact integers only** for amounts (no floating-point accounting).
- **Milestone principal allocations must total the agreed principal.**
- **Fees/reserves are separate** from principal and accounted explicitly.
- **Deadline ordering** (`delivery ≤ resolution ≤ finalCutoff` for OBJECTIVE_DIGITAL; milestone deadlines internally consistent).
- **Addresses** are 0x-hex 40-char; **asset** is an address or CAIP-19.
- **Required profile-specific terms and explicit consents** (e.g. seller timeout consent for OBJECTIVE_DIGITAL).
- **Resolvable authority references** and **defined replacement/longstop mechanisms** for advanced profiles.
- **Advanced profiles do not inherit** the automatic whole-contract buyer refund.
- **Provider names alone do not establish an executable custody handoff** (categorized as unsupported capability).

## Future signed-manifest integration (Phase 2)

This phase intentionally does **not** alter the current manifest digest, historical signature
verification, ABI, or existing escrow behavior.

Phase 2 must introduce policy/profile fields into a **new signed manifest version** — the
canonical commitment digest the parties sign must cover: parties, asset, amount, custody,
chain, permitted outcomes, deadlines, evaluator authority, and fallback disposition
(policy §A.2). New fields must **not** be silently appended as unsigned fields to the
existing assurance claims. The exact field additions and digest version bump are Phase 2
design work; this validator is the admission-side contract that the signed manifest will
feed.

## Layout

- `schema.js` — constants/helpers (policy versions, profile ids, exact-int math).
- `validator.js` — the admission validator.
- `fixtures/` — synthetic fixtures (valid + invalid).
- `tests/` — focused tests.