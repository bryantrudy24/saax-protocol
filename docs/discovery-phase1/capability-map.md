# SAAX Discovery Phase 1 — Capability Map (today vs. later)

Date: 2026-11-05 · Repo: `solvent-applied-saax-protocol` (ax-router) · HEAD: 32931e32

## What exists TODAY (pre-Phase-1, verified in repo)

| Component | Location | Status |
|---|---|---|
| Commitment manifest v1 (canonical SHA-256 digest, sorted-key serialization, EIP-712/cose/jws schemes, party signature domains) | `spec/commitment-schema.md` | Reused as `commitmentManifestVersion: "1"` |
| Authority-proof interface (AP2 mandates, verifiable intent, OAuth, custom; scope/amount/time checks; by-reference binding) | `spec/authority-proof-interface.md`, `endpoint/authority.js` | Reused for buyer/policy authorization domains |
| Evidence interface + verification policies + evaluator bindings | `spec/evidence-interface.md`, `endpoint/evidence.js` | Reused as `evidencePolicy`/`evaluatorRequirements` |
| Lifecycle state machine (issued→…→finalized) | `spec/lifecycle.md` | Reused; commitment handoff preserves it |
| Settlement linkage (rail-agnostic R; x402/mpp/ap2/acp reference rails; receipts) | `spec/settlement-linkage.md` | Reused as financialCompatibility rails |
| Error taxonomy (canonical codes, response shape) | `spec/error-codes.md` | Extended with `DSC_*` codes (new file, no mutation of existing codes) |
| Idempotency-key store (payment-request nonce domain) | `endpoint/idempotency.js` | Kept separate from proposal nonce domain |
| MCP server (streamable HTTP, 10 tools incl. `list_capabilities`, `get_protocol_info`, `get_routing_fee`) | `api/mcp.mjs` | Capability discovery surface exists as MCP tools; NO A2A Agent Card, NO profile file, NO prepare_commitment |
| Conformance runner + vectors (commitments/signatures/hashes/lifecycle/evidence/authority/settlement/errors) | `conformance/` | Extended additively with `discovery` category (this phase) |
| HTTP /route, /receipt, /mcp endpoints (saax-protocol.com) | `api/`, `vercel.json` | Discovery endpoints NOT implemented (Phase 2) |

## What Phase 1 ADDS (this commit)

| Deliverable | Location |
|---|---|
| Discovery Profile v1.0.0 specification | `spec/discovery-profile.md` |
| JSON Schemas (extension params, standalone profile, prepare request, signed proposal) — 2020-12, `$id` under `https://saax-protocol.com/schemas/discovery/` | `spec/schemas/discovery/*.schema.json` |
| Valid + invalid examples (coherent timestamps/units/networks/digests) | `spec/examples/discovery/*.json` |
| Validation module (contract-level; no HTTP, no financial execution) | `endpoint/discovery.js` |
| Conformance vectors + runner category | `conformance/vectors/discovery/*.json`, `conformance/runner/run-conformance.mjs` |
| Schema-against-examples proof (ajv 2020-12) | `scripts/_check-discovery-schemas.cjs` |

## Capability map: today vs. later phases

| Capability | Today (Phase 1) | Phase 2 | Phase 3+ |
|---|---|---|---|
| Profile spec + schemas + tests | ✅ done | — | — |
| `.well-known/saax.json` endpoint | ❌ | serve + sign profile | CDN/cache rules |
| A2A Agent Card + `extensions[].uri` (saax-discovery/v1) | ❌ | publish card + extension | register/registry listing |
| `prepare_commitment` HTTP endpoint | ❌ | implement (free, nonbinding, signed response, no preflight fee) | load/policy scaling |
| Proposal nonce+digest atomic store (Supabase) | ❌ | table + RPC (reuse idempotency-key pattern) | distribution/cleanup |
| Commitment handoff from proposal (buyer authorization → commitment) | Spec defined only | wire proposal→commitment (proposalId/requestDigest refs) | end-to-end |
| Retrieval security (DNS rebinding, private-IP block, redirect/size/time limits) | Policy defined + unit vector | client lib enforcement | network-level defense tests |
| Real signature verification (EdDSA/JWS, key rotation/revocation) | Structure + profile signature contract | implement verify + key registry | revocation distribution |
| MCP tool for discovery preflight | ❌ | `prepare_commitment` MCP tool (+ docs) | — |
| Registry/directory integration | ❌ | optional registry record | trust anchor registry |
| CAIP-19 asset-id canonicalization | Syntax validation only | EIP-55 casing + dedupe | — |

## Explicitly NOT implemented in Phase 1 (do not claim)

- No HTTP endpoints for discovery or preflight; no `.well-known/saax.json` served.
- No financial execution, custody, deposit, or spending authority.
- No durable proposal store/atomicity (only the replay-decide PURE RULE and spec).
- No real DNS/network-defense implementation (policy + unit vectors only).
- No A2A Agent Card published (the spec defines the extension; a provider must
  actually implement the interface before claiming it).

## Phase-1 proof status

- Conformance suite: **83/83 pass** (`node conformance/runner/run-conformance.mjs`),
  including all 18 pre-existing categories — no regression.
- Schema-example check: **11/11 pass** (`node scripts/_check-discovery-schemas.cjs`).
