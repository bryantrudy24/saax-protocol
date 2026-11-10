# SAAX Discovery Phase 3 — Durable Checkpoint

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **Phase-2 HEAD:** `3814654d` (verified re-run) · **Phase-3 HEAD:** (see git log after commit)

## Phase-2 closeout (verified from the live repo, not prior claims)

- HEAD `3814654d` (Phase 2), remote `origin/main` = `https://github.com/bryantrudy24/solvent-applied-saax-protocol.git`.
- Re-ran all three reported checks against the committed tree:
  - `node conformance/runner/run-conformance.mjs` → **91 passed, 0 failed**
  - `node scripts/_check-discovery-schemas.cjs` → **11 passed, 0 failed**
  - `node tests/discovery-phase2/run-phase2-tests.cjs` → **26 passed, 0 failed**
- Concrete publisher-trust source: `configured-key` (RFC 7638 JWK thumbprint anchor in the client's trust config), enforced by `endpoint/discovery-resolver.js`; DID/registry/prior-pinned UNSUPPORTED (documented).
- Specific failures proven in execution: untrusted key (no auth), tampered payload (`DSC_PAYLOAD_MISMATCH`), expired profile (`DSC_PROFILE_EXPIRED`), wrong origin (`DSC_ORIGIN_MISMATCH`), redirect limits (`DSC_RETRIEVAL_REDIRECT_LIMIT`), size/time/content-type guards, fallback-no-downgrade (`DSC_AUTH_FAILED_NO_FALLBACK`), cache expiry dominance, rotation (new anchor ok / old anchor rejects).
- A2A extension placement for the pinned version: `capabilities.extensions[]` (AgentExtension, A2A v1.0.0), URI `https://saax-protocol.com/extensions/saax-discovery/v1`, `required:false`.
- Commitment-format handoff: manifest v1 (signed terms + evaluator authority live in the manifest; discovery only references it by version+digest); profile versioning ≠ manifest versioning (no manifest change introduced).
- Deployment status: local/test only. Nothing published to a public origin; unsupported cases explicitly labeled.

## Phase-3 completed (verified)

| Item | Evidence |
|---|---|
| Preflight core | `endpoint/preflight-core.js` — normalize → digest → deterministic DSC_* validation → signed proposal (EdDSA JWS, RFC 8785) |
| Durable store | `endpoint/proposal-store.js` — append-only fsync journal, restart-safe, serialized persist (single atomic decision point) |
| HTTP endpoint (isolated) | `tests/discovery-phase3/preflight-http-server.cjs` (`POST /prepare-commitment`, 127.0.0.1 test-only, bounded body) |
| MCP adapter | `api/mcp.mjs` tool `prepare_commitment` (same core; zod schema; nonbinding description; registered but NOT advertised live) |
| Fixture + examples | `spec/examples/discovery/profile-phase3-unsigned.json` (prepareCommitment:true), `signed-proposal-valid-001.json` (real signed example), keys/ throwaway pair |
| Docs | `docs/discovery-phase3/proposal-semantics.md`, `capability-map.md`, `decision-table.md`; spec §11 addendum |
| Phase-3 tests | `node tests/discovery-phase3/run-phase3-tests.cjs` → **68 passed, 0 failed** (A positive control incl. independent verification; B HTTP/MCP parity + spy; C 12 negative DSC_* cases; D substitution detection (request/terms/signature/version/audience); E controlled-clock expiry + profile change; F concurrency + restart + torn-tail recovery; G zero financial side effects; H HTTP wire negatives) |

## Semantics resolved (Phase-1 open question)

Proposal = offer valid until `expires`, nonbinding on buyer, stale-on-change
(profileVersion/key/combination/manifest/expiry). Never substitute new terms
beneath an existing signature. Provider signature ≠ buyer acceptance.

## Unresolved / deferred → Phase 4 (next executable steps)

1. Buyer authorization + commitment creation from a verified proposal: revalidate signature (current profile key), profileVersion equality, expiry, exact combination, manifest digest (§7.2), then persist the accepted operation atomically (commitment + proposalId + nonce + requestDigest) before any execution.
2. Wire existing commitment store + idempotency-key pattern for the commit operation (proposal nonces stay separate).
3. Live availability probing (`checked.currentAvailability: true`).
4. Public deployment via the approved release process (origin + live operator keypair + card/profile + `/prepare-commitment`); then advertise the MCP tool as live.
5. Supabase-backed proposal records (RPC + RLS) as the deployment path; keep the file journal as the portable fallback.

## LUMIYOU / Victoria's Vision

No LUMIYOU or Victoria's Vision file, service, repository, deployment, or
configuration was created, modified, or touched. Only files under `ax-router/`
(SAAX repo) were added/edited; the pre-existing unrelated working-tree changes
were preserved untouched (verified at commit time by staged-diff review + a
lumi/victoria path scan).
