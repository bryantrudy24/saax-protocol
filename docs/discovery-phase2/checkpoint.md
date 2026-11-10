# SAAX Discovery Phase 2 — Durable Checkpoint

Date: 2026-11-05 · Repo: `solvent-applied-saax-protocol` (ax-router) · Phase-1 HEAD: `07a3cf96`

## Completed (verified)

1. **Phase-1 questions resolved** — see `phase1-resolution.md`: manifest reuse
   does not drop signed terms/evaluator authority (they live in manifest v1);
   profile versioning is distinct from manifest versioning; A2A extension
   placement confirmed under `capabilities.extensions[]`; conformance totals
   corrected (61 base + 22 = 83, pure additive, 9 categories not 18); the
   `_check-discovery-schemas.cjs` script is committed and reproducible (11/11).
2. **Signed profile publication** — `endpoint/discovery-crypto.js`: real
   Ed25519 JWS (jose v6, RFC 7515/8032) with RFC 8785 canonical payloads,
   pinned `alg=EdDSA`, JWK thumbprints (RFC 7638), key-id binding, and
   specific error codes (DSC_INVALID_SIGNATURE, DSC_UNSUPPORTED_ALGORITHM,
   DSC_KEY_ID_MISMATCH, DSC_PAYLOAD_MISMATCH). Private keys are never written,
   echoed, or committed; the signer script reads a private JWK from a local
   file only (`scripts/discovery-sign-profile.cjs`).
3. **Server-side publication artifacts** — `spec/examples/discovery/keys/`
   (throwaway example keypair — NOT a real secret), `signed-profile-valid-001.json`
   (real JWS over the example profile), `agent-card-valid-001.json` (signed
   A2A card with the SAAX extension), `trust-config-valid-001.json`.
4. **Resolver** — `endpoint/discovery-resolver.js`: A2A-first with safe
   standalone fallback; `validateSignedProfile` (schema+pinned version+
   signature+key-status+expiry+origin binding); one concrete trust path
   (`configured-key` thumbprint anchor); structured results distinguishing
   advertised capability / authenticated publisher / demonstrated conformance /
   current availability (checked=false in this phase); `ProfileCache` with
   signed-expiry dominance and trust-config-scoped keys; card signature
   verification; representation-consistency check.
5. **Retrieval security in execution** — `endpoint/discovery-retrieval-http.js`:
   HTTPS-only, DNS-resolved + IP-classified (loopback/private/link-local/ULA/
   CGNAT/reserved) destinations, DNS-rebinding defense by connecting to the
   validated IP (lookup override), ≤3 redirects with per-hop revalidation and
   https-only, 256 KiB profile / 1 MiB schema size caps, 10 s total time cap,
   JSON content-type guard, no remote execution. `allowLocalhost` is a
   test-only hook, never enabled in production policy.
6. **Fallback without downgrades** — `endpoint/discovery-trust.js` pure rules +
   resolver enforcement: auth failure or incompatible required extension NEVER
   falls back (DSC_AUTH_FAILED_NO_FALLBACK / DSC_MISSING_REQUIRED_EXTENSION);
   a card without the extension falls back ONLY with explicit client
   permission; a direct explicit profile URL is a deliberate retrieval.
7. **Tests** — `tests/discovery-phase2/`: TLS cert helper (Git openssl),
   controlled HTTPS server (valid/tampered/expired/untrusted/unsupported-
   version/wrong-origin/redirect loop/redirect-http/big/timeout/wrong-ctype/
   A2A cards incl. tampered/mismatch), and a runner with **26 executable
   cases** (crypto + network + trust + fallback + cache + rotation). Result:
   **26 passed, 0 failed** (`node tests/discovery-phase2/run-phase2-tests.cjs`).
8. **Conformance** — runner extended with trust/fallback vectors (8 new):
   **91 passed, 0 failed** (`node conformance/runner/run-conformance.mjs`).
9. **Schema check** unchanged and green: **11/11**.

## Unresolved decisions / explicitly deferred

- **Trust sources**: ONLY `configured-key` (thumbprint anchor) is implemented.
  DID resolution, registry listing, and prior-pinned identity are UNSUPPORTED
  in this phase (documented in resolver + trust-config example).
- **prepare_commitment HTTP/MCP endpoint, proposal nonce store, commitment
  handoff wiring**: Phase 3 (spec already defines the contracts).
- **A2A interface (JSON-RPC) serving / live card on saax-protocol.com**:
  requires the authorized deploy workflow; NOT performed in this phase.
- **CDN/cache rules, revocation distribution**: future.
- **Current-availability probing** (`checked.currentAvailability`): resolver
  reports `false`; live endpoints are not probed in this phase.

## Next executable action (Phase 3)

1. Implement `prepare_commitment` HTTP endpoint (request validation, proposal
   generation, JWS signing with `endpoint/discovery-crypto.js`, no preflight
   fee), plus the MCP `prepare_commitment` tool mirroring the spec.
2. Add proposal nonce+requestDigest atomic store (reuse the idempotency-key
   pattern in `endpoint/idempotency.js`) with duplicate-vs-conflict outcomes.
3. Wire the commitment handoff: buyer authorization covers the exact proposal
   terms; revalidate freshness before commitment creation.
4. Publish the A2A Agent Card + standalone profile on saax-protocol.com via the
   approved release workflow and probe live availability.

## LUMIYOU / Victoria's Vision confirmation

- No LUMIYOU or Victoria's Vision file, service, repository, deployment, or
  configuration was created, modified, or touched in this phase. Only files
  under `ax-router/` (SAAX repo) were added/edited, and the pre-existing
  unrelated working-tree changes were preserved untouched.
