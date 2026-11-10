# SAAX Discovery Phase 4 — Decision Table (D51–D62)

**Date:** 2026-11-06 · Extends `docs/discovery-phase3/decision-table.md` (D01–D50)

| # | Decision | Choice | Rationale / evidence |
|---|---|---|---|
| D51 | Manifest versioning vs profile versioning | Independent axes; `commitmentManifestVersion=1` unchanged; new additive `signedRepresentationVersion="manifest-v1.1+saax-proposal-bound"` | Manifest v1 COSE placeholder signature is a historical artifact preserved untouched; the SR wrapper adds real provider JWS auth of terms+tasks+evaluator without a format change (boundary A) |
| D52 | Proposal-store concurrency | Phase-3 fsync journal is single-process only → Phase-4 enforces **single-writer** (O_EXCL lock + PID + stale detection) | fsync does not imply cross-process atomicity; two processes can both pass the in-memory check (boundary B) |
| D53 | Buyer authorization model | **Configured buyer registry**: buyer signed acceptance verified against the registered public JWK (thumbprint/address keyed); scope (maxAmount/currency/capability) enforced | Mirrors Phase-2 configured-key trust path; caller-supplied identity is not proof (spec §7.1) |
| D54 | Acceptance contract | `acceptance-v1` (schemaVersion), domain `saax:acceptance:v1`, action `accept_commitment`, binds proposalId+proposalDigest+termsDigest+buyer+provider+audience+versions+nonce+validity | Domain separation from payment auth / evaluator verdicts; replay-safe nonce distinct from proposal clientNonce |
| D55 | Stale proposal handling | Explicit `DSC_EXPIRED_PROPOSAL` / `DSC_PROPOSAL_STALE` / `DSC_UNTRUSTED_PROVIDER` / `DSC_INVALID_COMBINATION` / `DSC_SCOPE_*`; never silent substitution (boundary C) | Spec §7.2; the commitment manifest is built only from authenticated terms |
| D56 | Commitment creation | Local deterministic (manifest v1 + SR v1.1 provider JWS); NO payment/custody/execution/release call; no external anchor in this phase | Zero-financial-side-effect requirement; external anchoring deferred to an authorized phase |
| D57 | Acceptance single-use | A proposal accepted once cannot create additional commitments via new nonces → `DSC_PROPOSAL_REUSED` (409) unless the signed proposal declares repeatability | Replay prevention; repeatability is not declared by any in-scope proposal |
| D58 | Idempotent retry | Same idempotencyKey + same requestDigest pair → same operation/commitment (duplicate); same key + different digest → `DSC_NONCE_CONFLICT` | Atomic single decision point in `persistAcceptance` |
| D59 | Crash reconciliation | Accepted-but-uncreated → duplicate returns the persisted `accepted` record (unknown outcome explicit); created → `commitment_created` replayed; torn tail truncated+reported | Restart-safe journal; never fabricate completion |
| D60 | HTTP/MCP parity | Both call `acceptance-core.acceptCommitment`; identical errors/status; MCP registered but NOT advertised live | Same-core rule; no public endpoint claim |
| D61 | Currency defaulting | `terms.currency` = null (unit is authoritative; Phase-3 mislabel of defaultUnit as currency FIXED); manifest price.currency derives USDC at create time | Preflight-core fix; schema/Phase-3 regression green |
| D62 | Trust for acceptance | Provider identity revalidated via the SAME configured-key thumbprint anchor (current profile key must be in the trust set); buyer via buyer registry | One implemented trust path; DID/registry/prior-pinned remain unsupported |

## Boundary findings summary

- **A (commitment version):** manifest v1 preserved; SR wrapper v1.1 additive; profile/manifest/SR versioning independent.
- **B (concurrency):** file journal single-process; Phase-4 single-writer O_EXCL lock enforced + tested (H-series); no distributed claim.
- **C (stale proposals):** exact invalidation triggers + specific DSC_* codes (documented in acceptance-semantics.md §3).
