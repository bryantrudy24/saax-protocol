# SAAX Discovery Phase 3 — Signed Preflight (proposal semantics)

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **Phase-2 HEAD:** `3814654d`

## 1. What the provider promises (offer semantics — resolved from Phase 1's "offer-until-expiry with stale-on-change")

A `prepare_commitment` response is **an offer valid until `expires`**, but it is:

- **Nonbinding on the buyer.** A provider signature is NOT buyer acceptance. The buyer accepts only by authorizing a commitment against the proposal (the future commit operation — Phase 4). Silence, retries, or mere retention of the proposal create no obligation.
- **Nonbinding on the provider in capacity terms.** The proposal describes *what* the provider would commit to under the normalized terms; it does **not** reserve capacity, lock pricing against market moves, or guarantee acceptance at commit time. The provider MAY decline a later commit for reasons outside the proposal (e.g. the capability's `prepareCommitment` interface being withdrawn, operator policy, capacity limits) — but MUST NOT substitute new terms silently.
- **Stale-on-change.** If any of the conditions the proposal binds change between issuance and commitment creation, the proposal is STALE and MUST be revalidated:
  - provider `profileVersion` changes (no silent downgrade),
  - the signing key is rotated/revoked/expired (proposal no longer verifiable under the current profile key),
  - the requested capability/schema/units/financial combination is withdrawn from the current profile,
  - the commitment-manifest version/digest the proposal references changes,
  - the proposal `expires` passes.
  A stale proposal MUST NOT be used to create a commitment; the buyer obtains a NEW proposal (fresh `clientNonce`) or the provider returns `DSC_PROPOSAL_STALE` / `DSC_EXPIRED_PROPOSAL`.

**Explicit invalidation results:**
| Condition | Result |
|---|---|
| Proposal `expires` passed | `DSC_EXPIRED_PROPOSAL` (410) — never reused |
| Conditions changed since issuance (profile version/key/combination/manifest) | `DSC_PROPOSAL_STALE` (409) — revalidate, never silent substitution |
| Same scoped idempotency key + same digest, unexpired | `DSC_DUPLICATE_REQUEST` (200 + same proposal) — idempotent replay |
| Same clientNonce + different digest | `DSC_NONCE_CONFLICT` (422) — never silently re-issued |

**Never substitute new terms beneath an existing signature.** The signed proposal is the single agreed representation; a changed request is a NEW preflight with a NEW nonce, never a mutation of the old one.

## 2. Normalization (explicit in the returned terms)

Every normalization is deterministic, reversible for comparison, and appears verbatim in the returned `terms` and `requestDigest`:

- **amount**: leading zeros stripped; integer-string only (no float, no sign). Compared with `BigInt` for bounds (capability `maxAmount`).
- **unit**: passed through; a mismatch against the capability's declared input unit → `DSC_UNITS_MISMATCH`.
- **timestamps**: parsed to UTC ISO-8601 with milliseconds (e.g. `2026-11-05T12:00:00.000Z`).
- **addresses**: buyer/seller 0x-addresses lowercased for canonical comparison; asset/network ids lowercased for canonical CAIP-2/CAIP-19 comparison.
- **key order**: irrelevant at digest time — `requestDigest = sha256(RFC 8785 JCS of the normalized request)`.

The buyer recomputes the digest over its ORIGINAL request; if it differs from `proposal.requestDigest`, the proposal is a **counter-offer**, not an acceptance (spec §6.4).

## 3. Durable proposal records & retries

Implemented as `endpoint/proposal-store.js` — an append-only, fsync-before-ack file journal (one JSON line per issued proposal), restart-safe, with an in-process serialization queue for concurrent safety. **This is operational storage, NOT an economic commitment record.** It does not introduce a financial transaction or a new commitment-format version.

**What is persisted per proposal:** proposalId, nonce, requestDigest, signedPayload, profileVersion, schema (id/version/digest), issuedAt, expires, status, signature ref, scope (clientNonce+digest).

**Deterministic retry behavior:**
| Scenario | Outcome |
|---|---|
| Same scoped key + same request, unexpired | Same unexpired proposal returned (duplicate) |
| Same key + different request | `DSC_NONCE_CONFLICT` (422) |
| Same key + same request, proposal expired | Duplicate returns the (still expired) proposal — NO silent fresh re-issue. A fresh proposal requires a fresh `clientNonce`. Explicit replacement is via `expire()` + new issuance (operator-controlled), never automatic |
| Concurrent identical retries | Exactly ONE issued; the rest duplicate. Contradictory records impossible (serialized + compare-and-swap inside the append) |
| Process restart | Journal reloaded; accepted issuance records preserved |

**Nonce separation:** proposal nonces live ONLY in this store, distinct from account nonces, access nonces, evaluator-verdict nonces, and the payment idempotency-key store (`endpoint/idempotency.js`). No shared nonce space.

**External execution is outside the atomicity claim:** the atomicity guarantee covers the persisted proposal record only; what happens on-chain/at the rail (later phases) is governed by the settlement-linkage/receipt mechanisms, not by this journal.

## 4. Interface equivalence (HTTP / MCP)

Both adapters call the SAME `endpoint/preflight-core.js`:
- **HTTP** (isolated test env): `POST /prepare-commitment` on 127.0.0.1 (test-only localhost exception; production policy never enables it). Bounded body (256 KiB), JSON-only, typed errors.
- **MCP** (`api/mcp.mjs`, tool `prepare_commitment`): identical validation + signing + persistence; zod inputSchema mirrors the request contract; the tool is NOT advertised as live until its corresponding endpoint is deployed and tested (per the no-claim rule).

Proven equivalence: HTTP issuance and MCP issuance of the same request produce the **same requestDigest**; an MCP retry of an HTTP-issued request returns the **same proposal** (duplicate).

## 5. Zero financial side effects (proven)

The preflight path calls ONLY the store (acquire/persist) and the crypto signer. Tests assert with a spy that:
- the HTTP server's side-effect recorder sees ONLY `proposal_issued` / `proposal_duplicate` kinds — never payment/custody/commitment/execution calls;
- the returned proposal contains no `paymentIntent`/`escrow`/`custody`/`execution`/`authorization` fields;
- a valid preflight succeeds through a wrapped store that would THROW on any financial API.

No payment, custody funding, economic commitment, service execution, resource reservation, or spending authority results from preflight. No preflight fee.

## 6. Limits (explicitly deferred)

- The proposal store is file-backed (portable, restart-safe). Supabase/DB backing is the documented deployment upgrade path (Phase 4), NOT assumed live here.
- The MCP tool and HTTP endpoint are implemented against the **example (throwaway) signing key**. Public deployment MUST swap in the live operator keypair; the profile it serves (`profile-phase3-unsigned.json`) is the published fixture with `prepareCommitment: true`.
- Live availability probing, buyer authorization, commitment creation from a proposal (with full revalidation per §7.2), and the A2A JSON-RPC interface remain Phase 4.
