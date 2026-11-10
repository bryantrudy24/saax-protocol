# SAAX Discovery Phase 1 — Durable Checkpoint & Phase-2 Readiness

Date: 2026-11-05 · Repo: `solvent-applied-saax-protocol` (ax-router) · HEAD BEFORE this phase: `32931e32`

## Completed (verified)

1. **Inspected current truth.** Repo = ax-router (origin `bryantrudy24/solvent-applied-saax-protocol.git`), HEAD `32931e32`, main is 52 commits ahead of origin/main (prior local-only review state — preserved untouched). No LUMIYOU/Victoria files in the commit range or the working tree additions of this phase.
2. **Pinned standards** (A2A v1.0.0; MCP 2025-06-18; JSON Schema 2020-12; CAIP-2 Final; CAIP-19 Review; RFC 8785/7515; DID Core; Ed25519), with source URLs + retrieval date 2026-11-05 in `spec/discovery-profile.md` §0. Distinguishes published standards, drafts, and SAAX proposals.
3. **Specification** `spec/discovery-profile.md` v1.0.0 — identity/authenticity, A2A+standalone representations, capability/financial compatibility, endpoint/retrieval security, free nonbinding preflight, commitment handoff.
4. **JSON Schemas** (2020-12, `$id`): extension-params, profile, prepare-request, proposal — under `spec/schemas/discovery/`.
5. **Examples** valid+invalid with coherent timestamps/units/networks/digests under `spec/examples/discovery/`.
6. **Validation module** `endpoint/discovery.js` — contract-level, no HTTP, no financial execution; controlled clock; JCS serializer; retrieval policy; replay semantics; auth-no-fallback; representation consistency.
7. **Conformance** — new `discovery` category; **83/83 pass** (all 18 pre-existing categories intact + 24 discovery vectors). Command: `node conformance/runner/run-conformance.mjs`.
8. **Schema-against-examples proof** — **11/11 pass** via maintained ajv (2020-12). Command: `node scripts/_check-discovery-schemas.cjs`. Also confirms which URI/format checks require app-level validation (documented in spec §0 + decision table D27).
9. **Decision table + capability map** under `docs/discovery-phase1/`.

## Evidence files

- `.output-discovery-phase1-run.txt` — exact conformance run (83/83, zero fails).

## Unresolved decisions

- **Real signature verification** (JWS/EdDSA verify, key rotation revocation distribution) is deferred to Phase 2 — Phase 1 validates structure/key-status, not crypto runtime.
- **A2A Agent Card publishing** deferred to Phase 2 (spec defines the extension; no card claimed until the interface is implemented).
- **Which phase implements the MCP `prepare_commitment` tool** — spec + capability map call for Phase 2; ordering vs. HTTP endpoint is a Phase-2 planning choice.
- **`saax-protocol.com` DNS/route changes** — the standalone profile path and extension URI are spec'd but not deployed; deployment of new routes needs the existing authorized SAAX deploy workflow, out of Phase-1 scope.

## Next executable action (Phase 2)

1. Implement `/.well-known/saax.json` serving (profile assembly + signing) behind the existing Vercel function pattern.
2. Implement `prepare_commitment` HTTP endpoint (request validation, proposal generation, JWS signing, no preflight fee).
3. Add Supabase `proposal_records` table + acquire RPC for atomic nonce/digest persistence (mirror `endpoint/idempotency.js`).
4. Publish A2A Agent Card with the `saax-discovery/v1` extension (only after 1+2 exist).
5. Add MCP tool `prepare_commitment` mirroring the spec.
6. Extend conformance vectors for the new endpoint/transport behaviors (network defenses are real in Phase 2, not policy-only).

## LUMIYOU / Victoria's Vision confirmation

- `git log origin/main..HEAD` for the phase commit range: no lumi/victoria/CreatorAgentX references.
- No LUMIYOU or Victoria's Vision file outside the SAAX repo was created or modified; this phase only staged files inside `ax-router/` (spec, schemas, examples, endpoint/discovery.js, conformance runner+vectors, docs, scripts) plus a test-output file.
- The repo's working tree contains many pre-existing untracked files from earlier phases — none of them were touched or staged by this phase.
