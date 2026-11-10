# SAAX Discovery Phase 1 — Compatibility & Security Decision Table

Date: 2026-11-05 · Profile v1.0.0 · Repo: ax-router (solvent-applied-saax-protocol)

Every design decision below was resolved from the brief or from an existing repo component; no parallel format was invented where a sound one existed.

| # | Decision | Choice | Rationale / source |
|---|---|---|---|
| D1 | Extension mechanism | A2A AgentCard `extensions[]` AgentExtension with versioned URI `https://saax-protocol.com/extensions/saax-discovery/v1` | A2A v1.0.0 §4.4.4; versioned URI under the verified SAAX-controlled domain `saax-protocol.com` (NOT `saax.dev` — not assumed controlled) |
| D2 | Standalone profile | `https://{origin}/.well-known/saax.json` as **provisional fallback**, NOT registered IANA standard | Brief: provisional fallback convention only |
| D3 | Fallback trigger | Allowed only when: no card obtainable + client config permits + HTTPS exact-origin + complete valid profile | Brief §"When fallback is allowed"; auth failure / incompatible required extension NEVER falls back (A2A: "MUST NOT fall back to a previous version … automatically") |
| D4 | Identity/authenticity | `signingKeys[]` with jwk/did refs, controller, validFrom/Until, status; profile signature proves integrity/self-declared origin only; `trust.authenticated` requires an independent anchor | Brief: "self-declared key MUST NOT automatically authenticate"; registry/DID/prior-trust/out-of-band anchors |
| D5 | Signed claim vs. conformance | `conformance.claims[]` (self-declared) vs `conformance.demonstrated[]` (independent resultUrl) kept distinct | Brief: distinguish a signed support claim from independently demonstrated conformance |
| D6 | Signature profile | JWS (RFC 7515), EdDSA/Ed25519, RFC 8785 JCS canonicalization, `alg=EdDSA`, `canonicalization=rfc8785`; tested structure + key-status, real crypto verify deferred to Phase 2 (no crypto runtime added in Phase 1) | A2A AgentCardSignature is RFC 7515 JWS; existing repo uses EIP-712/cose/jws for commitments; discovery chooses jws for portability |
| D7 | Commitment-manifest version | **No change**; reuses `spec/commitment-schema.md` as `commitmentManifestVersion: "1"` + digest | Brief: "Do not introduce a commitment-manifest version change without identifying why the existing format is insufficient" — no such insufficiency identified |
| D8 | Version axes | `profileVersion` (discovery profile), `transport.version` (A2A v1.0.0 or fallback), `schemas[]` (version+digest), `commitmentManifestVersion` | Brief: distinguish the four |
| D9 | Asset/network identifiers | CAIP-2 for chains, CAIP-19 for assets (chain-qualified); documented that CAIP-19 is Status **Review** (draft), not Final | Brief + pinned standards §0 |
| D10 | Amounts | Integer-string settlement amounts with explicit units (`"250000000"` + `"unit"`), no floats | Brief: integer-string amounts with explicit units |
| D11 | Supported combinations | `financialCompatibility.supportedCombinations[]` — exact network/asset/rail/mode/maturity tuples; syntax alone is NOT compatibility | Brief: "Define exact supported combinations rather than accepting syntax alone" |
| D12 | Non-blockchain rails | `rails` axis + combinations may carry `ach`/`card`/`internal-ledger` names WITHOUT claiming standardized identifiers or unsupported integrations | Brief: leave room without inventing |
| D13 | Maturity honesty | `maturity` enum per capability + `testnetOnly` guard (production+testnetOnly contradiction rejected) | Brief: declare actual maturity + network availability |
| D14 | Interfaces honesty | `interfaces.discovery.prepareCommitment` defaults false; declaring true requires an https endpoint | Brief: "Do not claim an A2A Agent Card makes the service A2A-compatible unless the interface is actually implemented" |
| D15 | Retrieval policy | HTTPS-only, ≤3 redirects, private/loopback blocked, ≤256 KiB profile / ≤1 MiB schemas, ≤10s, DNS-rebind re-validation, schema allowlist, untrusted-data-only (never execute) | Brief §Endpoint and retrieval security |
| D16 | Cache vs. expiry | HTTP `Cache-Control` freshness (max 24h) independent of signed `expires`; signed expiry always wins | Brief: separate HTTP cache freshness from authenticated document expiry |
| D17 | Key change invalidation | Re-fetch profile on key change/revocation; proposals under old key invalidated; `profileVersion` part of signed payload | Brief: key/version changes + cached-data invalidation |
| D18 | Preflight semantics | Free, nonbinding; NO agreement/payment/deposit/execution/reservation/spending authority; **no preflight fee** | Brief §free, nonbinding preflight |
| D19 | Proposal nature | Offer valid until `expires` (not merely a snapshot) but nonbinding on buyer; changed conditions → stale → revalidate | Brief: informational snapshot vs offer; changed conditions handling |
| D20 | Provider signature ≠ buyer acceptance | Explicit: proposal signature commits provider identity/terms; buyer authorizes only via commitment creation | Brief |
| D21 | Revalidation before commitment | Buyer re-checks signature/profileVersion/expiry/combination/manifest digest before creating commitment | Brief §commitment handoff |
| D22 | Authorization/evaluator reuse | Commitment creation preserves existing buyer/seller/authority signature domains and evaluator bindings; discovery adds proposalId/requestDigest provenance only | Brief: preserve existing commitment authorization and evaluator bindings |
| D23 | Atomic persist | Accepted operation + nonce + requestDigest persisted atomically BEFORE execution; identical retry → same operation; changed request same nonce → conflict | Brief; mirrors existing idempotency-key store semantics |
| D24 | Replay separation | Proposal nonce domain is separate from account/access/evaluator-verdict nonces; external execution/reconciliation outside the DB atomicity claim | Brief |
| D25 | Errors | New `DSC_*` codes added in canonical shape; existing `VAL_*`/`AUTH_*`/`SET_*`/`ST_*` untouched; distinguish invalid/unsupported/expired/unavailable/unresolved | Brief + `spec/error-codes.md` reuse |
| D26 | Test scope honesty | Phase-1 vectors prove contract/schema validation ONLY; not network defenses, durable storage, or live interop | Brief §4 + conformance README "Not a guarantee" |
| D27 | JSON Schema dialect | `https://json-schema.org/draft/2020-12/schema`; format keywords (uri/date-time) are annotation-only by default — app-level checks in `endpoint/discovery.js` enforce https/origin/CAIP/digest semantics | Brief: precise dialect + document which URI/format checks need app-level validation |

## Security posture table

| Threat | Mitigation in Phase 1 spec/module | Phase 2+ |
|---|---|---|
| Self-declared profile impersonation | `trust.authenticated` requires anchor; signed claim ≠ conformance | DID/registry verification |
| Auth failure downgrade | `authFallbackPolicy` returns `allowFallback:false` on auth fail or required-extension incompat | client transport enforcement |
| Version downgrade | `profileVersion` pinned in validator + proposal; downgrade vector fails | negotiation headers |
| Tampered proposal terms | `validateProposalWithProfile` cross-checks requestDigest/audience/schema/combination vs profile | real JWS verify |
| Unsafe retrieval (SSRF/rebinding) | `checkRetrievalPolicy` blocks private/loopback + limits | client DNS/IP rebinding re-check at fetch |
| Stale cache overriding expiry | signed `expires` independent of HTTP cache; expired rejected | cache invalidation protocol |
| Conflicting representations | `checkRepresentationConsistency` on shared fields | registry reconciliation |
| Replay/nonce confusion | `replayDecide` duplicate vs conflict; separate nonce domains | atomic store + TTL sweep |
