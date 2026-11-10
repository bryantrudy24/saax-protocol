# SAAX Discovery Phase 4 — Boundaries, Acceptance Semantics, and Handoff

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **Phase-3 HEAD:** `1e5b6839` (verified) · **Phase-4 HEAD:** (see git log after commit)

## 1. Boundary A — Commitment version (manifest v1 mapping)

**Finding:** The reported "manifest v1" is `endpoint/commitment.js` `buildManifest()` — a COSE_Sign1-*enveloped* (RFC 9052 structural emulation) trade manifest: fields `commitmentId`, `buyerAgentId`, `sellerAgentId`, `capability`, `price {amount,currency,decimals}`, `acceptanceCriteria {type,value}`, `deadline`, `cancelCondition`, plus `manifestHash` (sha256 of the signed envelope bytes) and a `COSE_Sign1:` signature tag.

**Critical caveat (historical artifact):** the v1 signing hook (`defaultSigningHook`) returns a **deterministic placeholder signature** (`0x00…00`, 65 bytes). v1 does NOT carry real cryptographic authentication of terms or evaluator authority. This is a documented Phase-1 posture, preserved untouched.

**Resolution (no historical omission reintroduced, no silent upgrade):** Phase 4 introduces an **additive, explicitly versioned signed representation wrapper**:

- `signedRepresentationVersion: "manifest-v1.1+saax-proposal-bound"` — a real **provider EdDSA JWS** (Phase-2 profile, RFC 8785 canonical payload) over the canonical manifest + proposal binding: `{signedRepresentationVersion, commitmentId, proposalId, proposalDigest, manifestDigest, acceptanceCriteria, deadline, price, sellerAgentId, buyerAgentId, capability, evaluator, permittedDecisions, signedAt}`.
- This closes the "signed terms + evaluator authority authenticated" gap **without changing manifest v1**. The manifest itself remains byte-identical v1 (historical artifacts preserved); the wrapper is a separate signed envelope attached to the commitment record and independently verifiable.
- **Discovery-profile versioning ≠ commitment-manifest versioning**: `profileVersion` (1.0.0) describes the discovery profile; `commitmentManifestVersion` (1) describes the commitment format; `signedRepresentationVersion` describes the auth wrapper. They are independent axes (decision table D51).

## 2. Boundary B — Proposal-store concurrency

**Finding:** the Phase-3 fsync journal serializes only **within one process** (in-process promise queue). Two processes can both pass the in-memory check and append → **NOT safe for multiple processes**. fsync alone does not imply cross-process atomicity.

**Resolution:** Phase 4 enforces a **single-writer architecture with tested ownership**:

- `endpoint/acceptance-store.js` acquires `operation.lock` via **O_EXCL** create carrying `{pid, host, writerId, startedAt}`.
- A second store instance on the same dir is **refused** (`DSC_STORE_LOCKED`) — it does not even read the journal.
- **Stale-lock recovery**: a lock whose pid is dead (`process.kill(pid,0)` EPERM/ESRCH) OR whose age exceeds 5 min is broken and re-acquired, reported as `recoveredStaleLock`. A lock that cannot be parsed is conservatively treated as live (never break on ambiguity).
- **Restart behavior** (tested): release → reopen reloads the journal; torn tails truncated and reported; accepted operations discoverable and resumable.
- **No distributed concurrency claim**: multi-node/networked writers are out of scope; the single-writer claim is local filesystem ownership, proven with a second in-process store instance and a dead-pid stale-lock case.

## 3. Boundary C — Stale proposals (exact invalidation)

A proposal is **STALE** (must not create a commitment; fresh proposal + fresh acceptance required) when ANY of these change after issuance:

| Condition | Result |
|---|---|
| Proposal `expires` passes (controlled clock) | `DSC_EXPIRED_PROPOSAL` (410) |
| Current provider `profileVersion` != proposal `profileVersion` | `DSC_PROPOSAL_STALE` (409) |
| Provider signing key rotated/revoked/expired (proposal keyId no longer the active profile key; key not in the configured trust set) | `DSC_PROPOSAL_STALE` / `DSC_UNTRUSTED_PROVIDER` (409/401) |
| Requested capability/schema/units/combination withdrawn from the current profile | `DSC_PROPOSAL_STALE` / `DSC_INVALID_COMBINATION` (409/422) |
| Commitment-manifest version or digest no longer declared by the current profile | `DSC_PROPOSAL_STALE` (409) |
| Buyer scope/limits changed (amount > scopeMaxAmount, currency mismatch, capability mismatch) | `DSC_SCOPE_EXCEEDED` / `DSC_SCOPE_MISMATCH` (422) |
| Acceptance validity window passed | `DSC_ACCEPTANCE_EXPIRED` (410) |

**Never substitute new terms beneath an existing signature.** A changed request is a NEW preflight with a NEW `clientNonce`; a changed acceptance is a new acceptance contract. The commitment manifest is built **only** from the authenticated proposal terms (verified by the acceptance `termsDigest` binding).

## 4. Buyer acceptance contract (acceptance-v1)

Versioned (`schemaVersion: acceptance-v1`), domain-separated (`domain: saax:acceptance:v1`, `action: accept_commitment`), signed by the **buyer's own Ed25519 key** with the Phase-2 signature profile (EdDSA, RFC 8785 canonical payload, kid bound).

Binds: proposalId + complete signed-proposal digest, exact normalized terms digest, buyer identity, intended provider (+signingKeyId), audience (provider origin), validity window (notBefore/notAfter), versions (profileVersion, manifestVersion, schema id/version/digest), nonce (distinct from the proposal clientNonce).

**Verification rules (Phase 4):**
- The buyer's signature must recover to the key registered in the **configured buyer registry** (`endpoint/acceptance-core.js` consumes `buyerScope.buyerPublicJwk` — a caller-supplied identity or expected signer is NOT proof).
- The signed payload (acceptance minus signature) is verified byte-for-byte against the RFC 8785 canonical reconstruction → tampering fails `DSC_ACCEPTANCE_SIGNATURE_INVALID` or `DSC_ACCEPTANCE_MISMATCH`.
- The acceptance audience must match the proposal provider origin (trailing-slash normalized).

**A buyer acceptance is NOT a payment authorization or an evaluator release verdict.** The commitment record carries no `paymentAuthorization`/`evaluatorVerdict` field; the acceptance domain separates it from the payment idempotency-key store, account nonces, evaluator-verdict nonces, and R nonces.

## 5. Durable accept-once and commitment creation

The single decision point is `AcceptanceStore.persistAcceptance` (append + fsync before ack), which decides **duplicate vs conflict vs reused-proposal** atomically. After persist:

1. The commitment manifest is built (v1) from the authenticated terms.
2. The provider JWS (signed representation v1.1) binds the canonical manifest + proposal.
3. The operation status transitions `accepted` → `commitment_created` (append-only second record).

**Crash semantics (tested):**
- Crash after durable acceptance, before commit-creation status: retry with the same idempotency key returns **duplicate** with the persisted `accepted` record → reconciliation is explicit (unknown outcome is never fabricated as complete).
- Crash after commitment creation: restart discovers `commitment_created` and replays as duplicate with the same commitment.
- Torn tail: truncated and reported; never merged; valid records survive.

**Single-use proposals:** a proposal accepted once cannot create additional commitments through new nonces → `DSC_PROPOSAL_REUSED` (409), unless the signed proposal declares repeatability (none do in scope).

**No financial effects:** the acceptance/commitment path calls ONLY the acceptance store + crypto signer. Rejected requests and ordinary creation never invoke payment, custody, execution, or release functions (proven with spies).

## 6. Persisted evidence

Each acceptance record persists: operationId, commitmentId, proposalId, requestDigest, clientNonce, acceptedAt, status, profileVersion, signingKeyId, manifestVersion, manifestDigest, schema, buyerScope, proposalDigest, acceptanceRef (acceptanceId/digest/keyId), commitmentRef (manifestHash), signedRepresentation (jws/keyId/version), idempotencyKey, terms. No keys, credentials, or unnecessary proposal contents are logged.

## 7. Nonce separation (unchanged from Phase 3)

| Nonce domain | Purpose |
|---|---|
| Proposal `clientNonce` + requestDigest | proposal idempotency/replay |
| Acceptance `nonce` | buyer acceptance replay (distinct from proposal nonce) |
| Idempotency-Key (Phase 4 acceptance) | operation dedupe |
| R nonce (`endpoint/requirement.js`) | payment requirement single-use |
| Idempotency-Key (`endpoint/idempotency.js`) | payment-request dedupe |
| Account nonces / evaluator-verdict nonces | separate domains |

No shared nonce space.
