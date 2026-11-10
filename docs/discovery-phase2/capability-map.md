# SAAX Discovery Phase 2 — Capability Map (today vs. Phase 3)

Date: 2026-11-05 · Extends `docs/discovery-phase1/capability-map.md`.

## What exists TODAY (Phase 2 adds)

| Component | Location | Status |
|---|---|---|
| Real Ed25519 JWS sign/verify (RFC 8785 payload) | `endpoint/discovery-crypto.js` | ✅ implemented + tested |
| Signed profile publication tooling (signer script + signed example) | `scripts/discovery-sign-profile.cjs`, `spec/examples/discovery/signed-profile-valid-001.json` | ✅ implemented; public deployment NOT done (needs authorized release workflow) |
| Signed A2A Agent Card example (extension + signature) | `spec/examples/discovery/agent-card-valid-001.json` | ✅ example; NOT published live |
| Trust anchors (configured-key thumbprint path) | `endpoint/discovery-resolver.js` (`validateSignedProfile` trust decision) | ✅ ONE path implemented; DID/registry/prior-pinned UNSUPPORTED |
| Resolver (A2A-first + safe standalone fallback, structured DSC_* results) | `endpoint/discovery-resolver.js` | ✅ implemented + tested |
| Bounded HTTPS retrieval (DNS-pinned IP, redirect/size/time/ctype limits) | `endpoint/discovery-retrieval-http.js` | ✅ implemented + tested |
| Fallback-without-downgrade rules | `endpoint/discovery-trust.js` + resolver | ✅ implemented + conformance vectors |
| Cache with signed-expiry dominance | `endpoint/discovery-resolver.js` (`ProfileCache`) | ✅ implemented + tested |
| Executable Phase-2 tests (real crypto + controlled network) | `tests/discovery-phase2/` | ✅ 26/26 |
| Conformance vectors for trust/fallback | `conformance/vectors/discovery/discovery-trust-*.json`, `discovery-fallback-*.json` | ✅ 91/91 total |

## What Phase 3 MUST implement (not claimed now)

| Capability | Today | Phase 3 |
|---|---|---|
| `prepare_commitment` HTTP endpoint (free, signed, nonbinding) | ❌ spec only | implement + sign with discovery-crypto |
| `prepare_commitment` MCP tool | ❌ | implement mirroring spec |
| Proposal nonce+digest atomic store (duplicate vs conflict) | ❌ pure rules only | table + RPC (idempotency-key pattern) |
| Commitment handoff (proposal → commitment, revalidate freshness) | ❌ spec only | wire via manifest digest + proposal id |
| Live A2A Agent Card + standalone profile on saax-protocol.com | ❌ example only | publish via approved release workflow |
| Live availability probing (`checked.currentAvailability`) | ❌ false | probe endpoints |
| Trust sources beyond configured-key (DID, registry, prior-pinned) | ❌ unsupported | implement + document |
| Revocation distribution (CRL/status list) | ❌ | design + implement |
| CDN/cache invalidation rules | ❌ | config |

## Truthful-endpoints guard

The Phase-1 profile already sets `interfaces.discovery.prepareCommitment: false`
(no endpoint exists). Phase 2 keeps that: the signed example profile declares
`prepareCommitment: false`, so no proposed capability can be mistaken for live
support. The A2A card example declares the SAAX extension with `required:
false` and the resolver treats card presence as a claim, never as
demonstrated conformance.

## Explicitly NOT implemented in Phase 2 (do not claim)

- No public deployment (no DNS/route change, no Vercel function, no card or
  profile served on saax-protocol.com).
- No `prepare_commitment` endpoint, no MCP tool, no proposal store, no
  commitment handoff execution.
- No financial execution, custody, deposit, or spending authority (unchanged).
- No DID resolution, registry integration, or prior-pinned-identity trust.
- No revocation distribution network.
