# SAAX Discovery Phase 2 — Phase-1 Question Resolution & Corrections

Date: 2026-11-05 · Repo: ax-router (solvent-applied-saax-protocol) · Phase-1 HEAD: `07a3cf96`

## 1. Commitment-manifest reuse vs. signed terms / evaluator authority

**Finding:** The Phase-1 profile reuses the existing commitment manifest v1
(`spec/commitment-schema.md`) as `commitmentManifestVersion: "1"`. This does NOT
reintroduce any historical omission:

- The commitment manifest v1 already defines **canonical SHA-256 digest over
  sorted-key fields**, **party/evaluator authorization and signature domains**
  (buyer/seller/signer/authority), **rail-agnostic settlementRequirement (R)**,
  the **lifecycle state machine**, and the **evidence/authority interfaces** —
  the "signed terms + evaluator authority" properties are in the manifest
  itself, not in the discovery profile.
- The discovery profile **adds no second commitment format**: it references the
  existing manifest by version + digest (`manifest.commitmentManifestVersion`,
  `manifest.commitmentManifestDigest`) and by the schemas array
  (`capabilities[].schemas[]` with purpose `commitment-manifest`).

**Versioning distinction (explicitly documented):**
- `profileVersion` = version of THIS Discovery Profile document (`1.0.0`).
- `commitmentManifestVersion` = version of the commitment manifest (`"1"`) —
  an independent axis. No manifest version change is introduced; the existing
  format is sufficient and already carries signed terms + evaluator authority.
- `schemas[].version` + `schemas[].digest` = per-schema versions.

**Exact handoff (documented in spec §7):** a proposal binds `profileVersion`,
`commitmentManifestVersion` + `commitmentManifestDigest`, and the schema
version+digest. At commitment creation, the buyer revalidates all of: proposal
signature under the current profile key, `profileVersion` equality (no
downgrade), `expires >= now`, capability/schema/units/combination still in the
profile's `supportedCombinations`, and the manifest version+digest still
declared. Then the existing commitment authorization (buyer/seller signatures
over the canonical commitment digest, authority-reference, evaluator bindings)
proceeds unchanged; the proposal adds only `proposalId`/`requestDigest`
provenance.

## 2. A2A declaration placement

**Finding:** Phase-1 already specified the extension under the A2A v1.0 Agent
Card `capabilities.extensions[]` mechanism with the versioned URI
`https://saax-protocol.com/extensions/saax-discovery/v1` (see spec §3.1 and
`extension-params.schema.json`). Phase 2 keeps this placement and adds:

- `capabilities.extensions[]` entry in the example Agent Card
  (`spec/examples/discovery/agent-card-valid-001.json`) with
  `required: false`, matching the A2A Agent Card schema v1.0
  (`AgentExtension { uri, description?, required?, params? }`).
- Card **signature** support: `signatures[]` over the RFC 8785 canonicalized
  card (A2A v1.0 AgentCardSignature), using the same Ed25519/JWS profile as the
  standalone profile.
- The resolver's A2A path **does not claim A2A compatibility merely by
  publishing a card**: it verifies card signatures (when present) against the
  configured trust anchors, and treats a card that carries invalid signatures as
  an auth failure that NEVER falls back.

## 3. Conformance totals reconciliation

The Phase-1 checkpoint claimed "83/83 pass (all 18 pre-existing categories
intact + 24 discovery vectors)". The **accurate breakdown** (verified from the
committed tree at `07a3cf96`):

| Measure | Value |
|---|---|
| Pre-existing vectors before Phase 1 (8 categories) | **61** |
| Phase-1 discovery vectors added | **22** |
| Removed/replaced/excluded vectors | **0** (pure additive) |
| Total vectors at Phase-1 commit | **83** |
| Phase-1 reported result | 83 passed, 0 failed (runner output `.output-discovery-phase1-run.txt` confirms) |

The "18 categories" phrase in the Phase-1 checkpoint conflated the runner's
category list (which includes the *new* `discovery` entry) with vector files.
Correction: the runner has **8 pre-existing vector categories** (commitments,
signatures, hashes, lifecycle, evidence, authority, settlement, errors) + the
new `discovery` category = **9 categories**, holding 61 + 22 = 83 vectors.

Phase 2 adds **8 more discovery vectors** (trust valid/invalid ×4, fallback
valid/invalid ×4): total = 91. The Phase-2 runner (with real crypto + network
defense) adds **26 executable integration cases** on top.

## 4. Schema-validation script committed and reproducible

**Finding:** `scripts/_check-discovery-schemas.cjs` (the ajv 2020-12
schema-against-examples check) IS committed at `07a3cf96` and IS reproducible:

```
node scripts/_check-discovery-schemas.cjs    # 11 passed, 0 failed
```

It is required test tooling and is kept in the repo under `scripts/` (the
underscore prefix reflects the repo's one-shot probe convention, NOT a
non-shippable artifact — the Phase-1 commit and runner both depend on it).
Phase 2 does not change it.

## 5. Historical artifacts preserved

No Phase-1 file was deleted, renamed, or restructured. This phase:
- added new files under `endpoint/`, `tests/discovery-phase2/`, `scripts/`,
  `docs/discovery-phase2/`, `spec/examples/discovery/keys/`, and new vectors;
- edited `conformance/runner/run-conformance.mjs` (added trust/fallback
  dispatch + module loading — additive, existing vector contract unchanged);
- edited `spec/discovery-profile.md` (additive sections for Phase 2);
- edited `spec/examples/discovery/profile-valid-001.json` (swapped the
  placeholder public key `x` for the real example public key — the placeholder
  was a base64url constant with no key behind it; the JWS placeholder in the
  signature envelope was likewise replaced by a real signature in the new
  `signed-profile-valid-001.json`; the old file remains as the UNSIGNED
  profile template).
