# SAAX Discovery Profile v1.0.0

**Status:** Draft for review (Phase 1 — specification, schemas, examples, and executable validation tests only).
**Version:** 1.0.0
**Canonical location:** `spec/discovery-profile.md`
**Date:** 2026-11-05
**Scope:** This document defines the versioned SAAX Discovery profile that lets an unfamiliar buyer discover a provider, validate compatibility, and obtain a free signed proposal before authorizing an economic commitment. It is a **specification**; it does not implement HTTP endpoints, financial execution, custody, or settlement.

**Out of scope and explicitly NOT included:** implementation of discovery HTTP endpoints, `prepare_commitment` endpoints, payment/custody deposit, or any financial execution. This phase produces the specification, JSON Schemas, examples, and executable validation tests only.

---

## 0. Normative references (pinned)

| Standard | Version | Status at retrieval | Source URL | Retrieval date |
|---|---|---|---|---|
| Agent2Agent (A2A) Protocol | v1.0.0 (latest; v1.0.1 patch published 2026-05-28) | Released | https://a2a-protocol.org/latest/specification/ | 2026-11-05 |
| A2A Agent Card Schema | v1.0 (protocol v1.0.1) | Released | https://www.agentcard.net/agent-card-schema | 2026-11-05 |
| Model Context Protocol (MCP) | 2025-06-18 | Released | https://modelcontextprotocol.io/specification/2025-06-18 | 2026-11-05 |
| JSON Schema | 2020-12 | Current (released) | https://json-schema.org/specification | 2026-11-05 |
| CAIP-2 (Blockchain ID) | Final | **Final** | https://standards.chainagnostic.org/CAIPs/caip-2 | 2026-11-05 |
| CAIP-19 (Asset Type/ID) | 2020-06-23 | **Review (draft)** | https://standards.chainagnostic.org/CAIPs/caip-19 | 2026-11-05 |
| RFC 8785 (JCS) | — | Released (IETF) | https://www.rfc-editor.org/info/rfc8785/ | 2026-11-05 |
| RFC 7515 (JWS) | — | Released (IETF) | https://www.rfc-editor.org/rfc/rfc7515 | 2026-11-05 |
| EIP-191 / EIP-712 | — | Final (Ethereum) | https://eips.ethereum.org/EIPS/eip-191, https://eips.ethereum.org/EIPS/eip-712 | 2026-11-05 |
| DID Core (decentralized identifiers) | 1.0 | W3C Recommendation | https://www.w3.org/TR/did-core/ | 2026-11-05 |
| EdDSA / Ed25519 (RFC 8032) | — | Released (IETF) | https://www.rfc-editor.org/rfc/rfc8032 | 2026-11-05 |

Distinguished statuses: **published standard** = A2A v1.0.0 (released), MCP 2025-06-18 (released), JSON Schema 2020-12 (current), CAIP-2 (Final), RFC 8785/7515, DID Core (W3C Rec), Ed25519. **Draft** = CAIP-19 (Status: Review). **SAAX proposal** = the Discovery Profile v1.0.0 in this document, plus the provisional `/.well-known/saax.json` convention (Section 5).

---

## 1. Purpose and lifecycle of the profile

The Discovery Profile is the machine-readable surface by which an unfamiliar buyer agent (or human) can:

1. **Discover** that a provider offers SAAX-governed economic commitments.
2. **Validate compatibility** — exact supported capability, schema digest, units, network/asset/rail/mode combinations, evidence and evaluator requirements.
3. **Obtain a free, nonbinding, signed proposal** (`prepare_commitment`) that binds the provider's identity and the normalized proposed terms, but creates **no economic commitment** — no agreement, payment, custody deposit, service execution, resource reservation, or spending authority.

A provider publishes the profile as **both**:
- an **A2A Agent Card extension** (`AgentExtension` under `extensions` in the card), and
- a **standalone JSON profile** at `/.well-known/saax.json` (provisional fallback convention).

Both representations MUST be kept consistent for shared capability data (Section 5.4). The profile is not a commitment manifest; it describes what a provider *can* commit to, not a specific commitment.

---

## 2. Identity and authenticity

### 2.1 Provider identity and origin

| Field | Type | Required | Description |
|---|---|---|---|
| `providerId` | string (URI) | **required** | Canonical identifier of the provider; MUST be a https URL under the provider's own controlled origin (or a `did:` when the provider is DID-addressable) |
| `providerName` | string | recommended | Human-readable name |
| `origin` | string (https URL) | **required** | The HTTPS origin (scheme+host, no path) that serves the profile and its endpoints. Used for the origin-binding check (Section 6.1) |
| `signingKeys` | array of `SigningKeyRef` | **required** | References to the keys that sign proposals. A card/profile signature alone does NOT authenticate the provider (Section 2.5) |

### 2.2 Signing key references

```json
{
  "id": "key-2026-01",
  "type": "jwk",
  "jwk": {
    "kty": "OKP",
    "crv": "Ed25519",
    "x": "BASE64URL_PUBLIC_KEY"
  },
  "controller": "https://saax-protocol.com/.well-known/did.json",
  "validFrom": "2026-01-01T00:00:00Z",
  "validUntil": "2027-01-01T00:00:00Z",
  "status": "active"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | **required** | Key ID; MUST be unique within the profile and stable across rotation |
| `type` | enum: `jwk` \| `did` | **required** | Key representation |
| `jwk` | object (RFC 7517 JWK) | required when `type=jwk` | The public key (MUST be a public key only; NEVER a private key) |
| `did` | string (DID URL) | required when `type=did` | DID:key or DID with a verification method that resolves to the key |
| `controller` | string (URI) | **required** | Who controls the key (a URL under a discovered origin or a DID) |
| `validFrom` / `validUntil` | ISO-8601 UTC | **required** | Validity window; `validUntil` MUST NOT be omitted |
| `status` | enum: `active` \| `revoked` \| `expired` | **required** | Current status |
| `revokedAt` | ISO-8601 UTC | conditional | Required when `status=revoked` |

### 2.3 Rotation, revocation, expiry

- **Rotation:** a provider rotates a key by adding a new `signingKeys[]` entry and marking the old one `expired` (or `revoked`) with a `validUntil` in the past. Proposals MUST be signed by an `active` key in `signingKeys[]`.
- **Revocation:** revoking a key immediately invalidates proposals signed by it, regardless of `issuedAt`. Clients MUST re-fetch the profile on key-change and MUST treat a profile fetched before the revocation as **stale** (Section 6.5).
- **Expiry:** a key with `validUntil < now` MUST NOT sign proposals; a proposal signed by an expired key MUST be rejected.

### 2.4 Self-declared key does not authenticate the provider

> **A self-declared key MUST NOT automatically authenticate the provider.**

The profile is a self-asserted document. If a client's only knowledge of the provider comes from a self-fetched profile, the provider's key can at most prove **self-consistency of that profile's own claims**. A provider is *authenticated* only when one or more of the following independent trust anchors hold:

1. **Registry listing:** the provider is listed in a SAAX registry/directory the client trusts, and the profile's `providerId`/origin match the registry record.
2. **DID resolution:** `providerId` is a DID that resolves to a DID Document whose verification method controls the signing key.
3. **Cached prior trust:** the client already has a verified relationship with this provider and recognizes the profile as a rotation of it (fails closed on any mismatch).
4. **Out-of-band verification:** the origin is authenticated by other means (e.g., the client operator configured it).

A profile signature proves **integrity and issuer-**self-declared **origin**, not independent authenticity. The Discovery profile always exposes this distinction in `trust`:

```json
"trust": {
  "selfSigned": true,
  "authenticated": false,
  "independentConformance": false,
  "anchors": []
}
```

### 2.5 Signed support claim vs. independently demonstrated conformance

- A **signed support claim** is a statement in the profile — *"we support SAAX v1"* — signed by the provider's key. It is a claim, not proof.
- **Independently demonstrated conformance** is evidence a third party can verify: passing the SAAX conformance suite, a registry attestation, an independent conformance report, or a published vector result set.

The profile MUST carry both, distinctly:

```json
"conformance": {
  "claims": [
    { "standard": "SAAX Discovery Profile", "version": "1.0.0", "mode": "self-declared" }
  ],
  "demonstrated": [
    {
      "test": "SAAX Conformance Suite",
      "version": "1.0.0",
      "resultUrl": "https://saax-protocol.com/conformance#discovery",
      "result": "pass"
    }
  ]
}
```

A client MUST treat `claims` as marketing and `demonstrated` as the only evidence of conformance.

---

## 3. A2A and standalone representations

### 3.1 A2A Agent Card extension (primary)

A provider expresses SAAX support through the **A2A protocol's supported extension mechanism**: the `extensions` array of `AgentExtension` objects in the Agent Card (A2A v1.0.0, §4.4.4). The extension URI:

```
https://saax-protocol.com/extensions/saax-discovery/v1
```

This is a **versioned extension URI** under the **verified SAAX-controlled domain** `saax-protocol.com`. The extension declares:

```json
{
  "uri": "https://saax-protocol.com/extensions/saax-discovery/v1",
  "description": "SAAX Discovery Profile v1: provider capability and financial-compatibility declaration, plus free nonbinding prepare_commitment preflight.",
  "required": false
}
```

**`required: false`** — SAAX discovery is optional for ordinary A2A task exchange; a client that does not understand the extension can safely ignore it. When a client opts into the extension, the A2A `A2A-Extensions` header carries the URI and the client MUST NOT fall back to a previous extension version on negotiation failure (A2A spec: "It MUST NOT fall back to a previous version of the extension automatically").

**An Agent Card does not make a service A2A-compatible by itself.** Declaring the extension is only a *claim*. A provider MUST implement the actual SAAX discovery interface (the profile retrieval + the `prepare_commitment` preflight contract) before the card is meaningful, and MUST NOT claim the interface is implemented unless it is. The profile's `capabilities.interfaces` field (Section 4.4) records which interfaces are actually implemented.

### 3.2 Standalone profile (provisional fallback)

The standalone representation is served at:

```
https://{origin}/.well-known/saax.json
```

> **Status: provisional fallback convention, NOT an officially registered standard.** SAAX does not claim `/.well-known/saax.json` is registered with IANA. It is a project convention for fallback discovery only.

**When fallback is allowed** (all of):

1. The client could not obtain an A2A Agent Card at all (no card at `/.well-known/agent-card.json`, no registry entry, no configured card URL).
2. The client's own configuration explicitly permits standalone fallback.
3. The standalone profile is retrieved over **HTTPS from the exact provider origin** (no redirect chain to a different origin).
4. The standalone profile is complete and valid (schema + signature).

**When fallback is NEVER allowed**:

- **Authentication failure** (card signature invalid, key mismatch, revoked key) MUST NOT trigger fallback to an unsigned profile.
- **Incompatible required extension** (client requires SAAX v2 but the card only offers v1, or the card declares a required extension the client cannot satisfy) MUST NOT trigger fallback to a weaker/older representation.
- The client MUST fail closed with an explicit error.

### 3.3 Consistency between representations

When a provider publishes both an Agent Card extension and a standalone profile, **shared capability data MUST be identical**. Any field that appears in both (provider identity, capabilities, financialCompatibility, endpoints that exist in both) MUST match byte-for-byte after canonicalization (Section 7). A client detecting a conflict MUST treat the provider as **inconsistent** and fail closed. Different *view* fields (e.g., card-specific descriptions) are exempt, but shared capability fields are not.

---

## 4. Capability and financial compatibility

### 4.1 Version dimensions

The profile distinguishes four version axes:

| Axis | Field | Description |
|---|---|---|
| Discovery-profile version | `profileVersion` | Version of THIS document (SAAX Discovery Profile). `1.0.0` |
| Transport version | `transport.version` | The discovery transport (A2A v1.0.0, or the standalone fallback convention) |
| Schema version | `schemas[]` | Version + digest of each declared JSON Schema (commitment manifest schema, evidence schema, etc.) |
| Commitment-manifest version | `commitmentManifest.version` | Version of the SAAX commitment manifest (reuses the existing `spec/commitment-schema.md` v1; **no manifest version change is introduced in this phase** — the existing format is sufficient for discovery; see Section 4.5) |

### 4.2 Capability declaration

```json
"capabilities": [
  {
    "id": "security-scan",
    "name": "Security scan of endpoint",
    "description": "Runs a credentialed vulnerability scan against a buyer-supplied endpoint",
    "schemas": [
      {
        "id": "https://saax-protocol.com/schemas/commitment-manifest/v1",
        "version": "1",
        "digest": "sha256:9f2c...",
        "purpose": "commitment-manifest"
      }
    ],
    "input": {
      "units": { "amount": "integer-string micro-units of settlement asset", "duration": "seconds" },
      "constraints": { "maxAmount": "250000000", "minDuration": 60, "maxDuration": 86400 }
    },
    "evidencePolicy": {
      "requiredEvidenceTypes": ["vulnerability-scan-report"],
      "minimumCountPerType": 1,
      "maxEvidenceAgeSeconds": 3600,
      "acceptedIssuers": ["0x5555555555555555555555555555555555555555"]
    },
    "evaluatorRequirements": {
      "verificationSchemes": ["eip712", "cose", "jws"],
      "minimumVendorScore": 80
    },
    "maturity": "production",
    "networkAvailability": {
      "networks": ["eip155:8453"],
      "testnetOnly": false
    }
  }
]
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | **required** | Stable capability id |
| `name` / `description` | string | required/recommended | Human text |
| `schemas[]` | array | **required** | Versioned schemas (with digests) that this capability uses |
| `input.units` | object | **required** | Input/output units; amounts are **integer strings with explicit units** (e.g. `"micro-units of settlement asset"`) |
| `input.constraints` | object | recommended | Bounds on acceptable inputs |
| `evidencePolicy` | object | **required** | Evidence types, counts, freshness, accepted issuers |
| `evaluatorRequirements` | object | **required** | Verification schemes and evaluator expectations |
| `maturity` | enum: `experimental` \| `beta` \| `production` | **required** | Actual maturity — see note below |
| `networkAvailability` | object | recommended | Where the capability operates; `testnetOnly` flag |

> **Maturity honesty rule:** `maturity` MUST reflect actual deployment state. `production` means the capability is in production with real economic commitments; `beta` means limited availability; `experimental` means not yet stable. A capability MUST NOT claim production maturity while it is only on a local/testnet deployment (the SAAX Router currently declares its hosted custody pilot as testnet-only; see the capability map in `docs/deliverables/` Phase-1 report).

### 4.3 Financial compatibility

```json
"financialCompatibility": {
  "networks": ["eip155:8453"],
  "assets": ["eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  "rails": ["x402", "mpp"],
  "paymentModes": ["x402", "mpp", "ap2", "acp"],
  "paymentMode": "x402",
  "settlementModes": ["escrow"],
  "supportedCombinations": [
    {
      "network": "eip155:8453",
      "asset": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "rail": "x402",
      "mode": "x402",
      "maturity": "production"
    },
    {
      "network": "eip155:8453",
      "asset": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "rail": "mpp",
      "mode": "mpp",
      "maturity": "beta"
    }
  ]
}
```

Rules:

- **network/asset/rail/mode are separated.** `networks`, `assets`, `rails`, and payment/settlement modes are distinct axes.
- **Chain-qualified asset identifiers** use CAIP-19 (`eip155:8453/erc20:0x...`); networks use CAIP-2 (`eip155:8453`). See the pinned standards (Section 0); CAIP-19 is Status **Review** — this profile treats it as the best current identifier syntax and documents that status.
- **Settlement amounts are integer strings with explicit units.** No floating point; no bare numbers. `"amount": "250000000"` = 250 USDC (6 decimals). The unit is declared in `capabilities[].input.units` and in `financialCompatibility.defaultUnit`.
- **Exact supported combinations, not syntax alone.** A buyer MUST NOT infer that `x402` + `usdc` + `eip155:8453` works because each value appears somewhere. Only entries in `supportedCombinations[]` are supported. A capability request whose combination is not listed MUST be rejected (`DSC_INVALID_COMBINATION`).
- **Non-blockchain rails:** the profile leaves room for non-blockchain rails (e.g., `ach`, `card`, `internal-ledger`) in the `rails` axis and `supportedCombinations` via `rail.*` names, but **without inventing standardized identifiers or claiming unsupported integrations**. A rail that is not registered with SAAX MUST NOT be asserted as supported. The reference rails (`x402`, `mpp`, `ap2`, `acp`) are declared as known; anything else is `unknown` until registered.

### 4.4 Interfaces actually implemented

```json
"interfaces": {
  "discovery": { "profile": true, "prepareCommitment": false, "commitment": true }
}
```

`prepareCommitment` defaults to `false` in Phase 1 (no endpoint is implemented); declaring it `true` before the endpoint exists is a **claim violation**. The capability map (Phase-1 report) documents today-vs-later.

### 4.5 Commitment-manifest version

The profile reuses the existing SAAX commitment manifest (`spec/commitment-schema.md`, canonical digest + EIP-712/cose/jws schemes) as `commitmentManifest.version = "1"` with its digest. **No commitment-manifest version change is introduced in this phase.** The existing format already provides:
- canonical SHA-256 digest over sorted-key fields,
- party/evaluator authorization and signature domains (buyer/seller/signer/authority),
- rail-agnostic `settlementRequirement` (R),
- lifecycle state machine and evidence/authority interfaces.

A manifest version change would be needed only if discovery required fields the manifest cannot express (e.g., evaluator-specific signing keys that must not be reused across domains) — and even then it would be additive. No such need exists for Phase 1.

---

## 5. Endpoint and retrieval security

### 5.1 HTTPS / origin rules

- The profile (both representations) MUST be served over **HTTPS**.
- The `origin` field MUST exactly match the serving origin: `scheme://host[:port]` with no path, no trailing slash, no userinfo, no query. Ports other than 443/80 are disallowed for discovery retrieval.
- The client MUST reject any profile whose effective retrieval origin differs from `origin` (the origin-binding check).

### 5.2 Explicitly authorized cross-origin endpoints

- A profile MAY list `endpoints[].allowCrossOrigin` = true for specific endpoints it authorizes for cross-origin access (e.g., CORS-enabled `prepare_commitment`).
- Cross-origin access is **deny by default**. A client MUST NOT send economic data to an endpoint that is not explicitly authorized.
- The allowed cross-origin set is part of the signed profile (or the card) so it cannot be injected by a network attacker.

### 5.3 Remote retrieval policy (client requirements)

A SAAX discovery client MUST enforce all of:

| Rule | Policy |
|---|---|
| **Redirect limits** | At most **3** redirects per retrieval; after that, fail. |
| **Private-network/loopback protection** | Reject any URL whose hostname resolves to a loopback, link-local, ULA (fc00::/7), or private-range address (10/8, 172.16/12, 192.168/16) unless the client operator explicitly authorized local discovery (dev/test only). |
| **DNS rebinding defense** | Bind the hostname at DNS resolution time and re-validate it against the resolved IP before every request in the redirect chain; reject on any mismatch. |
| **Retrieval size limit** | Reject bodies larger than **256 KiB** for the profile and **1 MiB** for schemas/manifests. |
| **Retrieval time limit** | Reject retrievals taking longer than **10 seconds**. |
| **Safe schema fetching** | Fetch schemas only from the provider's own origin (or a URL the profile explicitly lists as `schemaAllowlist`); treat remote manifests, descriptions, and schemas as **untrusted data, never executable instructions** (never `eval`/`require`/execute them; parse only). |

### 5.4 Cache freshness vs. authenticated document expiry

- **HTTP cache freshness** is governed by the HTTP `Cache-Control`/`Expires` headers. The `cacheControl` field in the profile expresses the provider's freshness intent, and clients MUST respect a `max-age` of at most 24h for the profile.
- **Authenticated document expiry** is the `expires` field inside the signed profile/proposal (cryptographically bound). A proposal whose `expires` has passed MUST be rejected even if the HTTP cache is still fresh.
- These are **independent**: a fresh HTTP cache never overrides an expired signed document, and a valid signed document never overrides a stale key/revocation.

### 5.5 Key/version changes and cached-data invalidation

- Clients MUST re-fetch the signed profile whenever: (a) a proposal references a `profileVersion`/`schemas` version they do not cache; (b) a key `validUntil` is within 24h of expiring; (c) a revocation is suspected (signature failure on an otherwise valid document).
- On **any** profile version change or key rotation, the client MUST invalidate cached proposals signed under the old profile/key (they become unverifiable or stale) and MUST NOT reuse them.
- `profileVersion` is part of the signed payload; a mismatch between a cached proposal's `profileVersion` and the current profile is a conflict (Section 7).

---

## 6. Free, nonbinding preflight (prepare_commitment)

### 6.1 Semantics

`prepare_commitment` is the **free, nonbinding preflight**: a buyer asks a provider "can you commit to X, and under these normalized terms?" and the provider returns a **signed proposal** describing exactly what it would commit to.

> **Preflight creates NO agreement, payment, custody deposit, service execution, resource reservation, or spending authority.** It is free: **no preflight fee** in the initial profile. A provider MUST NOT require payment, a deposit, or any spending authorization to respond.

> **A provider signature is NOT buyer acceptance.** The signed proposal commits the provider's identity and the proposed terms; the buyer accepts only by authorizing a commitment against it (Section 7).

### 6.2 Request contract (`prepareCommitmentRequest`)

```json
{
  "profileVersion": "1.0.0",
  "capability": { "id": "security-scan" },
  "schema": { "id": "https://saax-protocol.com/schemas/commitment-manifest/v1", "version": "1", "digest": "sha256:9f2c..." },
  "units": { "amount": "250000000", "unit": "micro-units of settlement asset" },
  "financialProfile": {
    "network": "eip155:8453",
    "asset": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "rail": "x402",
    "mode": "x402"
  },
  "constraints": { "maxAmount": "250000000", "deadline": "2026-11-06T00:00:00Z" },
  "intendedParties": { "buyer": "0x1111111111111111111111111111111111111111", "seller": "0x2222222222222222222222222222222222222222" },
  "clientNonce": "0x1234abcd",
  "issuedAt": "2026-11-05T12:00:00Z"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `profileVersion` | string | **required** | The Discovery Profile version the request is expressed against |
| `capability.id` | string | **required** | One of the provider's declared capability ids |
| `schema` | object | **required** | The schema id/version/digest the buyer expects the commitment to conform to |
| `units` | object | **required** | Amount as an **integer string** + explicit unit |
| `financialProfile` | object | **required** | Network (CAIP-2), asset (CAIP-19), rail, mode — all four axes |
| `constraints` | object | recommended | maxAmount, deadline, etc. |
| `intendedParties` | object | conditional | buyer/seller when the buyer wants the proposal bound to specific parties |
| `clientNonce` | string | **required** | Buyer-chosen nonce; echoed in the response to prevent cross-proposal confusion |
| `issuedAt` | string (ISO-8601 UTC) | **required** | Client's timestamp (informational; server time wins) |

### 6.3 Response contract (`prepareCommitmentProposal`)

```json
{
  "profileVersion": "1.0.0",
  "proposalId": "prop_01J...",
  "nonce": "0x1234abcd",
  "requestDigest": "sha256:4f8a...",
  "provider": {
    "providerId": "https://saax-protocol.com",
    "name": "SAAX Router",
    "signingKeyId": "key-2026-01",
    "origin": "https://saax-protocol.com"
  },
  "audience": { "buyer": "0x1111111111111111111111111111111111111111", "intendedAudience": "0x1111111111111111111111111111111111111111" },
  "manifest": {
    "commitmentManifestVersion": "1",
    "commitmentManifestDigest": "sha256:manifest-digest",
    "schema": { "id": "https://saax-protocol.com/schemas/commitment-manifest/v1", "version": "1", "digest": "sha256:9f2c..." }
  },
  "terms": {
    "network": "eip155:8453",
    "asset": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "rail": "x402",
    "mode": "x402",
    "amount": "250000000",
    "unit": "micro-units of settlement asset",
    "currency": "USDC",
    "deadline": "2026-11-06T00:00:00Z",
    "policies": { "refundOnFailure": true, "compensationPercent": "5" }
  },
  "issuedAt": "2026-11-05T12:00:05Z",
  "expires": "2026-11-05T13:00:05Z",
  "status": "proposed",
  "signature": {
    "scheme": "jws",
    "alg": "EdDSA",
    "keyId": "key-2026-01",
    "jws": "eyJhbGciOiJFZERTQSJ9...",
    "canonicalization": "rfc8785"
  },
  "trust": { "selfSigned": true, "authenticated": false, "independentConformance": false, "anchors": [] }
}
```

The response **binds**:
- `requestDigest` — sha256 over the canonicalized *accepted* request as normalized by the provider (Section 6.4).
- normalized proposed terms (`terms`) — network, asset, rail, mode, amount (integer string) + explicit unit, deadline, policies.
- provider identity, intended buyer/audience, manifest/schema versions and digests, proposal id, nonce (echoed), `issuedAt`, `expires`, signature profile.

**Semantics of provider signature:** the signature over the canonical proposal proves the provider issued it and that the terms are the provider's bound proposal. It is NOT buyer acceptance.

**Informational snapshot vs. offer.** The proposal is an **offer valid until `expires`**, not merely an informational snapshot — but it is *nonbinding on the buyer* (no acceptance by silence; no obligation unless the buyer authorizes a commitment). If *conditions change* between proposal issuance and commitment creation (provider profile version changes, key rotation, supported combination withdrawn, price/availability change), the proposal is **stale** and MUST be revalidated (Section 7.2); changed conditions invalidate the proposal.

### 6.4 Normalization and digest of the accepted request

1. The provider selects the parts of the request it accepts: `capability.id`, `schema` (id+version+digest), `units.amount`+`units.unit`, `financialProfile` (network/asset/rail/mode), `constraints` (as accepted), `intendedParties`, `clientNonce`.
2. The provider normalizes: amount to canonical integer-string with declared unit; timestamps to UTC ISO-8601; addresses/asset ids to lowercase or EIP-55 as declared; order-insensitive object keys sorted (RFC 8785 JCS for the canonical bytes).
3. `requestDigest = RFC8785-JCS-sha256(normalized accepted request)`; this digest is bound in the proposal. The buyer recomputes the digest over its original request; if it differs, the proposal is a **counter-offer**, not an acceptance, and the buyer MUST treat it as non-matching (Section 7.1).

### 6.5 Error taxonomy

Typed errors for discovery + preflight (canonical shape mirrors `spec/error-codes.md`):

| Code | HTTP | Category | Meaning |
|---|---|---|---|
| `DSC_UNSUPPORTED_VERSION` | 422 | discovery | Requested profile/schema/extension version not supported by provider |
| `DSC_INVALID_PROFILE` | 422 | discovery | Profile JSON fails schema or is inconsistent |
| `DSC_INVALID_SIGNATURE` | 422 | discovery | Profile/proposal signature invalid |
| `DSC_MISSING_REQUIRED_EXTENSION` | 422 | discovery | A client-required extension is absent |
| `DSC_INVALID_COMBINATION` | 422 | discovery | network/asset/rail/mode combination not in `supportedCombinations` |
| `DSC_UNSUPPORTED_CAPABILITY` | 422 | discovery | Capability id not declared |
| `DSC_SCHEMA_MISMATCH` | 422 | discovery | Requested schema version/digest differs from provider's |
| `DSC_UNITS_MISMATCH` | 422 | discovery | Units/amount format incompatible |
| `DSC_EXPIRED_PROPOSAL` | 410 | preflight | Proposal `expires` passed |
| `DSC_PROPOSAL_STALE` | 409 | preflight | Conditions changed since proposal (revalidate) |
| `DSC_DUPLICATE_REQUEST` | 409 | preflight | Same request+nonce already accepted (idempotent) |
| `DSC_NONCE_CONFLICT` | 422 | preflight | Same nonce with a DIFFERENT request (conflict) |
| `DSC_ORIGIN_MISMATCH` | 422 | discovery | Profile origin ≠ retrieval origin |
| `DSC_UNSAFE_RETRIEVAL` | 400 | discovery | Retrieval policy violation (redirects/private-IP/size/time) |
| `DSC_AUTH_FAILED_NO_FALLBACK` | 403 | discovery | Auth failure — no unsigned fallback permitted |
| `DSC_UNAVAILABLE` | 503 | discovery | Provider cannot service preflight right now |
| `DSC_UNRESOLVED` | 409 | discovery | Outcome cannot be determined (treat as unknown, poll) |

These codes are new SAAX Discovery codes; the existing `VAL_*`, `AUTH_*`, `SET_*`, `ST_*` taxonomy is unchanged and reused for commitment operations.

---

## 7. Commitment handoff

### 7.1 Buyer/policy authorization covers the exact agreed representation

- The buyer authorizes a commitment against the **exact agreed representation**: the proposal's `terms` (network/asset/rail/mode/amount/unit/deadline/policies), the manifest/schema version+digest, and the proposal id.
- The commitment MUST be constructed to reference the proposal id and the accepted request digest. No field in the commitment may contradict the proposal's normalized terms.

### 7.2 Revalidation before commitment creation (buyer side)

Before creating a commitment from a proposal, the buyer MUST revalidate **all** of:

1. The proposal signature still verifies under the current provider profile key (`keyId` still active, not revoked/expired).
2. `profileVersion` of the proposal == current provider profileVersion (no downgrade).
3. The proposal is not expired (`expires >= now` under the controlled clock).
4. The requested capability/schema/units/financial combination is still in the current profile's `supportedCombinations`.
5. The provider still declares the manifest version+digest the proposal references.

Any failure → `DSC_PROPOSAL_STALE` and the buyer MUST NOT create the commitment.

### 7.3 Preserving existing commitment authorization and evaluator bindings

- Commitment creation preserves the existing SAAX authorization model: buyer/seller signatures over the canonical commitment digest, optional `authorityReference` (authority-proof interface), and evaluator bindings (accepted issuers, verification schemes) exactly as `spec/commitment-schema.md` and `spec/authority-proof-interface.md` define.
- The Discovery profile adds a **proposal reference** and **request digest** to the commitment's provenance, but does NOT alter the signature domains, the evaluator binding rules, or the authority model.

### 7.4 Atomic persist of accepted operation, nonce, and request digest

- At commitment-creation time, the accepted operation (commitment id + proposal id + nonce + request digest) MUST be **atomically persisted before execution** (same transaction as the commitment record).
- **Identical authenticated retries** (same request, same nonce, same request digest) retrieve the **same operation** (idempotent success).
- **Changed requests using the same nonce** are a **conflict** (`DSC_NONCE_CONFLICT`), never silently re-processed.
- **Replay protection separation:** proposal replay handling (this section) uses the proposal nonce + request digest; it is **separate** from account nonces, access nonces, and evaluator-verdict nonces (the existing idempotency-key store in `endpoint/idempotency.js` covers payment-request idempotency; the commitment idempotency covers operation idempotency; an evaluator-verdict nonce covers evidence evaluation). They never share a nonce space.
- **External execution and reconciliation are outside the database atomicity claim.** The atomicity guarantee covers the persisted operation record only; what happens on-chain or at the rail is governed by the settlement-linkage and receipt mechanisms (`spec/settlement-linkage.md`), not by the atomic persist.

### 7.5 Separating proposal replay from other nonce domains

| Nonce domain | Purpose | Separate from |
|---|---|---|
| Proposal nonce (`clientNonce`) + requestDigest | Proposal idempotency/replay | account/access/evaluator-verdict nonces |
| Idempotency-Key (payment requests, `endpoint/idempotency.js`) | Payment-request dedupe | proposal nonce |
| Commitment id / audit chain | Commitment identity | — (rooted in commitmentId) |
| Account nonces | Per-account transaction ordering | all others |
| Evaluator-verdict nonce | Evidence evaluation replay | all others |

---

## 8. Conformance and phase boundary

This specification + the JSON Schemas in `spec/schemas/discovery/` + the executable vectors in `conformance/vectors/discovery/` constitute **Phase 1**. The runner (`conformance/runner/run-conformance.mjs`) is extended with a `discovery` category that exercises `endpoint/discovery.js`.

**What Phase 1 does NOT prove:** network defenses (DNS rebinding, private IP), durable storage/atomicity, or live interoperability. Passing the Phase-1 vectors proves **schema-level and contract-level validation** only. Do not present schema validation as proof of network defenses, durable storage, or live interoperability.

## 9. Capability map (today vs. later phases)

See `docs/discovery-phase1/decision-table.md` (compatibility/security decisions) and `docs/discovery-phase1/checkpoint.md` (capability map + Phase-2 tasks).

---
*SAAX Discovery Profile v1.0.0 — Draft for review. Provisional conventions: `/.well-known/saax.json` is NOT an IANA-registered standard; the extension URI is versioned under the verified SAAX-controlled domain `saax-protocol.com`; example domains in fixtures are illustrative and not controlled by SAAX.*

---

## 10. Phase 2 addendum — signed publication, retrieval, trust (implemented)

Status of this addendum: **implemented and tested in Phase 2** (commit after
`07a3cf96`). It defines the concrete mechanisms behind Sections 2–5.

### 10.1 Signature profile (normative)

- **Scheme:** JWS compact (RFC 7515), **algorithm: EdDSA / Ed25519** (RFC 8032).
- **Canonicalization:** RFC 8785 (JCS). The signed payload is the canonical
  bytes of the **profile object WITHOUT the `signature` envelope**. A verifier
  reconstructs that object and compares bytes; a tampered field or a
  re-serialization that changes canonical bytes fails
  (`DSC_PAYLOAD_MISMATCH`).
- **Header:** `{ "alg": "EdDSA", "kid": "<signingKeys[].id>" }`. No JWT claims
  (no `iat`) — the payload is the raw canonical document.
- **Key references:** the `signature.keyId` MUST name an entry in
  `signingKeys[]`; that entry MUST be `type: jwk` with an Ed25519 public JWK,
  `status: active`, `validFrom <= now <= validUntil` at validation time.
- **Errors:** `DSC_INVALID_SIGNATURE`, `DSC_UNSUPPORTED_ALGORITHM`,
  `DSC_KEY_ID_MISMATCH`, `DSC_KEY_NOT_ACTIVE`, `DSC_KEY_EXPIRED`,
  `DSC_KEY_NOT_YET_VALID`, `DSC_PAYLOAD_MISMATCH`, `DSC_PROFILE_EXPIRED`,
  `DSC_ORIGIN_MISMATCH`.
- **Private key hygiene:** private keys are never placed in committed files,
  public responses, or profiles; the signer reads a private JWK from a local
  file (`scripts/discovery-sign-profile.cjs`) and never echoes it.

### 10.2 Trust (the one implemented path)

A client establishes trust through an **explicitly configured trust source**.
The only trust source implemented in Phase 2 is **`configured-key`**: the
client pins the provider's signing key(s) by RFC 7638 JWK thumbprint in its
trust configuration. A profile is `authenticated` only when ALL hold:

1. the signing key's JWK thumbprint is in the configured trusted set, AND
2. the profile origin equals the configured provider origin, AND
3. the signing key is `active` and within its validity window, AND
4. the profile signature verifies under that key.

DID resolution, registry listings, and prior-pinned identity are **explicitly
unsupported trust sources** in this phase and are so labeled in the resolver
and the trust-config example.

### 10.3 A2A card signing and the no-claim rule

- A2A v1.0 `AgentCardSignature[]` entries are flattened JWS over the RFC 8785
  canonicalized card (minus the `signatures` field), verified against the same
  configured verification keys.
- A card that carries signatures which FAIL verification is an
  **authentication failure** and MUST NOT fall back to the standalone profile
  (`DSC_AUTH_FAILED_NO_FALLBACK`).
- A card with no signatures is *unauthenticated but usable* (the A2A card
  spec makes signatures optional); the resolver records
  `a2a.authenticated=false`.
- Declaring the extension on a card is a **claim**, not demonstrated
  conformance: `capabilities.extensions[]` is informational; the resolver only
  uses it to (a) negotiate the SAAX interface when present and (b) decide
  whether standalone fallback is permissible.

### 10.4 Standalone fallback (normative rules, implemented)

Fallback to `/.well-known/saax.json` is permitted ONLY when ALL hold:

1. no A2A card was obtainable (or the obtained card does not declare the SAAX
   extension), AND
2. the client's trust configuration explicitly permits standalone fallback, AND
3. the profile URL is HTTPS on the exact configured origin (or an explicit
   direct URL supplied by the caller — a deliberate retrieval, not a fallback),
   AND
4. retrieval policy passes (redirects/size/time/content-type) AND the profile
   validates (schema + version + signature + key + expiry + origin binding).

Auth failure and required-extension incompatibility NEVER permit fallback
(`DSC_AUTH_FAILED_NO_FALLBACK`, `DSC_MISSING_REQUIRED_EXTENSION`). An
ambiguous A2A failure (network error) is "no card obtainable" and may fall
back only under rule 2. A card that EXISTS but lacks the extension is a
negotiation verdict: it falls back only with explicit permission
(`DSC_MISSING_REQUIRED_EXTENSION` when permission is absent).

### 10.5 Retrieval security (implemented, in execution)

The resolver retrieves profiles/cards/schemas through
`endpoint/discovery-retrieval-http.js`, enforcing in execution:

- HTTPS only; `http:` refused. No credentials in URLs.
- DNS rebinding defense: the OS-resolved IP of each host is validated against
  the blocklist (loopback, private 10/8 · 172.16/12 · 192.168/16, link-local,
  ULA fc00::/7, CGNAT 100.64/10, reserved), and the SAME validated IP is what
  the TLS connection uses (a `lookup` override) — the connection cannot be
  re-resolved to a different address than the one validated.
- At most 3 redirects; each hop re-validates https + destination IP before
  following; redirects to `http:` are refused.
- 256 KiB max profile/card body; 1 MiB max schema body (declared in the
  schema-allowlist fetch path).
- 10 s total retrieval limit (5 s per hop).
- Content-Type must be JSON (`application/json` or `*+json`).
- Bodies are untrusted data: parsed with JSON.parse only, never executed.

**Test-only localhost exception:** the client honors `allowLocalhost` ONLY in
the test harness (controlled 127.0.0.1 server with a pinned test CA).
Production retrieval policy never enables it.

### 10.6 Caching (implemented)

- `ProfileCache` keys by (trust-config fingerprint, origin). A cache hit is
  served ONLY when the signed `expires` is still in the future and the signing
  key is still `active`; otherwise the cache entry is treated as stale and the
  profile is refetched. HTTP `Cache-Control` freshness is never conflated with
  authenticated expiry.
- Any key change/revocation/profile-version change invalidates cached
  proposals/profiles under the old key (the cache key includes the trust
  config, so a trust-anchor change also invalidates).

### 10.7 Outcome axes

Discovery results report FOUR distinct axes; never a blanket "trusted":

- `advertised` — capabilities/combinations the profile declares.
- `authenticatedPublisher` — whether the signing key matched the configured
  trust anchor.
- `demonstratedConformance` — whether `conformance.demonstrated[]` is non-empty
  (independent evidence).
- `currentAvailability` — whether the endpoints were actually probed. In this
  phase it is `false`; live probing is Phase 3.

---

## 11. Phase 3 addendum — signed preflight (prepare_commitment), implemented

**Status of this addendum: implemented and tested in Phase 3** (commit after
`3814654d`).

### 11.1 The operation

`prepare_commitment` is **free and nonbinding**. A request is validated,
normalized, and — when the provider profile declares
`interfaces.discovery.prepareCommitment: true` — answered with a **signed
proposal** (`status: "proposed"`). Preflight creates **no agreement, payment,
custody deposit, service execution, resource reservation, or spending
authority**, and there is **no preflight fee**.

### 11.2 Deterministic compatibility validation (specific DSC_* errors)

The shared core (`endpoint/preflight-core.js`) validates in order:

1. request shape → `DSC_INVALID_REQUEST` (422)
2. `profileVersion` semver → `DSC_UNSUPPORTED_VERSION` (422)
3. capability declared → `DSC_UNSUPPORTED_CAPABILITY` (422)
4. schema id+version+digest among the capability's schemas →
   `DSC_SCHEMA_MISMATCH` (422)
5. units integer-string + declared unit; amount ≤ capability `maxAmount` →
   `DSC_UNITS_MISMATCH` (422)
6. network/asset/rail/mode EXACTLY in `supportedCombinations[]` →
   `DSC_INVALID_COMBINATION` (422) (syntax alone is never enough)
7. deadline within the capability's `maxDuration` horizon →
   `DSC_INVALID_REQUEST` (422)
8. interface truthfulness: `prepareCommitment: false` in the profile →
   `DSC_UNAVAILABLE` (503)

Outcomes: `DSC_DUPLICATE_REQUEST` (409/200+same proposal) for identical
retries; `DSC_NONCE_CONFLICT` (422) for same nonce + different digest;
`DSC_EXPIRED_PROPOSAL` (410) and `DSC_PROPOSAL_STALE` (409) for offer
semantics (see `docs/discovery-phase3/proposal-semantics.md`).

### 11.3 Normalization and digest (spec §6.4, made executable)

`requestDigest = sha256(RFC 8785 JCS of the NORMALIZED request)`. Normalization
is explicit and echoed in the returned terms: integer-string amounts (leading
zeros stripped), UTC ISO-8601 timestamps, lowercased addresses/asset/network
ids, order-insensitive keys. A buyer recomputing the digest over its original
request and finding a mismatch treats the proposal as a **counter-offer**, not
an acceptance.

### 11.4 Proposal content and signature profile

The proposal binds (all signed): `profileVersion`, `proposalId`, `nonce`
(echoed), `requestDigest`, `provider` (id/name/keyId/origin), `audience`
(buyer + intendedAudience), `manifest` (commitmentManifestVersion=**1**,
commitmentManifestDigest, schema id/version/digest), `terms` (network/asset/
rail/mode/amount/unit/currency/deadline/policies incl. evidence + evaluator
requirements), `issuedAt`, `expires` (now + 1 h), `status: "proposed"`,
`trust` (selfSigned=true, authenticated=false — see §11.6), and `signature`
(scheme `jws`, alg `EdDSA`, keyId, JWS over the RFC 8785 canonical proposal
WITHOUT the `signature` envelope — the Phase-2 signature profile).

**Provider signature is NOT buyer acceptance.** The buyer accepts only by
authorizing a commitment against the proposal (Phase 4).

### 11.5 Durable proposal records and retries

`endpoint/proposal-store.js` — append-only fsync journal, restart-safe,
serialized. Same scoped key (clientNonce+requestDigest) + same request →
**same unexpired proposal**; same key + different request → **conflict**
(`DSC_NONCE_CONFLICT`); expired proposals **remain expired** (fresh issuance
requires a fresh nonce; `expire()` replacement is operator-controlled, never
automatic). Concurrent retries cannot create contradictory records. Proposal
nonces are **separate** from account/access/evaluator-verdict nonces and from
the payment idempotency-key store. This is operational storage only — not an
economic commitment record, and it introduces **no financial transaction and
no new commitment-format version** (manifest v1 is reused).

### 11.6 Trust

The proposal is signed with the provider's active key; `trust.authenticated`
is `false` in every Phase-3 proposal. Authentication of the key remains the
Phase-2 resolver's job (the one implemented trust source: configured-key
thumbprint anchor; DID/registry/prior-pinned remain UNSUPPORTED).

### 11.7 Adapters and equivalence

- **HTTP** (isolated test env): `tests/discovery-phase3/preflight-http-server.cjs`
  serves `POST /prepare-commitment` on 127.0.0.1 (test-only localhost
  exception; production retrieval policy never enables it). Bounded 256 KiB
  body, JSON-only, typed errors.
- **MCP** (`api/mcp.mjs` tool `prepare_commitment`): same core; zod
  inputSchema; description states nonbinding and free. Not advertised as live
  until the corresponding public endpoint is deployed and tested.

Proven equivalence: HTTP and MCP issuance of the same request yield the same
`requestDigest`; an MCP retry of an HTTP-issued request returns the **same**
proposal. No financial side effects (spy-proven §G of the Phase-3 tests).

### 11.8 Not implemented in Phase 3 (do not claim)

- No public deployment (no origin serves `/prepare-commitment`; the example
  profile/card remain un-published fixtures).
- No buyer authorization, no commitment creation from a proposal (§7 handoff
  is Phase 4 with full revalidation: signature, profileVersion, expiry,
  combination, manifest digest).
- No live A2A JSON-RPC interface; no Supabase-backed proposal persistence
  (file journal is the Phase-3 portability choice).
- No second commitment format, no manifest version change.

---

## 12. Phase 4 addendum — buyer authorization + commitment creation (implemented)

### 12.1 Boundary resolutions (normative)

- **Commitment versioning (D51):** `commitmentManifestVersion=1` is preserved unchanged (historical artifact: v1's COSE_Sign1 envelope carries a placeholder signature — see `endpoint/commitment.js`). Phase 4 adds an **additive, explicitly versioned signed representation wrapper**: `signedRepresentationVersion: "manifest-v1.1+saax-proposal-bound"` — a provider EdDSA JWS (Phase-2 profile, RFC 8785 canonical payload) over the canonical manifest + proposal binding, including evaluator + permitted-decision authority (from the profile `evaluatorRequirements`). Discovery-profile versioning, commitment-manifest versioning, and signed-representation versioning are independent axes.
- **Store concurrency (D52):** the Phase-3 fsync journal is single-process only. Phase 4 enforces **single-writer** with an O_EXCL lockfile (`{pid, host, writerId, startedAt}`), stale-lock recovery (dead PID or >5 min age), and refusal of a second owner (`DSC_STORE_LOCKED`). No distributed concurrency claim.
- **Stale proposals (D55):** exact invalidation — expiry (`DSC_EXPIRED_PROPOSAL`), profileVersion drift (`DSC_PROPOSAL_STALE`), key rotation/revocation (`DSC_PROPOSAL_STALE`/`DSC_UNTRUSTED_PROVIDER`), capability/schema/combination withdrawal (`DSC_PROPOSAL_STALE`/`DSC_INVALID_COMBINATION`), manifest version/digest change (`DSC_PROPOSAL_STALE`), buyer scope (`DSC_SCOPE_EXCEEDED`/`DSC_SCOPE_MISMATCH`), acceptance expiry (`DSC_ACCEPTANCE_EXPIRED`). Never substitute new terms beneath an existing signature.

### 12.2 Buyer acceptance (normative)

Versioned contract (`schemaVersion: acceptance-v1`, `$id https://saax-protocol.com/schemas/discovery/acceptance/v1`), domain-separated:

```
domain: 'saax:acceptance:v1'
action: 'accept_commitment'
```

Binds: `proposalId` + complete signed-proposal digest, exact normalized `termsDigest`, buyer identity, intended provider (+`signingKeyId`), audience (provider origin), `notBefore`/`notAfter`, versions (profileVersion/manifestVersion/schema), acceptance `nonce` (distinct from the proposal clientNonce).

The buyer's signature is a REAL EdDSA JWS (Phase-2 profile) over the RFC 8785 canonical acceptance payload. Verification uses the **configured buyer registry** public key; a caller-supplied identity or expected signer is NOT proof of authorization. A buyer acceptance is NOT a payment authorization or an evaluator release verdict.

### 12.3 Revalidation before acceptance (normative, spec §7.2 executable)

Before any persist, the implementation verifies ALL of:

1. Provider identity through the configured-key thumbprint anchor (current profile signing key in the trust set — `DSC_UNTRUSTED_PROVIDER` otherwise).
2. Proposal signature under the CURRENT profile key (kid match; `DSC_INVALID_SIGNATURE` / `DSC_KEY_ID_MISMATCH` / `DSC_UNSUPPORTED_ALGORITHM`).
3. `profileVersion` equality (no downgrade — `DSC_PROPOSAL_STALE`).
4. Expiry under the controlled clock (`DSC_EXPIRED_PROPOSAL`, 410).
5. Capability/schema/units/financial combination still in the current profile (`DSC_PROPOSAL_STALE` / `DSC_INVALID_COMBINATION`).
6. Manifest version+digest still declared (`DSC_PROPOSAL_STALE`).
7. Buyer scope and limits (`DSC_SCOPE_EXCEEDED` / `DSC_SCOPE_MISMATCH`).

Operational conditions are checked ONLY where the implementation can establish them; an unimplemented availability probe is never assumed success.

### 12.4 Durable accept-once and commitment creation (normative)

The single decision point is `persistAcceptance` (append + fsync before ack). Semantics:

- Same idempotencyKey + same request digest → **duplicate** (same operation + commitment).
- Same idempotencyKey + different digest → **conflict** (`DSC_NONCE_CONFLICT`).
- Single-use proposal accepted once → **`DSC_PROPOSAL_REUSED`** under a new idempotency key (repeatability only if the signed proposal declares it; none in scope).
- Concurrent requests → at most one accepted issuance operation.
- Restart → journal reloaded; accepted operations discoverable and resumable; torn tails truncated and reported.
- Crash after acceptance (before commit status) → retry returns duplicate with the persisted `accepted` record; **unknown outcomes are explicit, never fabricated as complete**.
- Crash after commitment creation → restart sees `commitment_created` and re-issues the same commitment.

The commitment is created locally: manifest v1 built from authenticated terms + provider SR v1.1 JWS. Commitment creation does NOT trigger payment settlement, escrow funding, service execution, or release. Any separately authorized anchoring (EAS/testnet) must follow the existing durable external-action pattern and remain restricted to the authorized test environment.

### 12.5 Adapters and parity (normative)

Both the isolated HTTP endpoint (`POST /accept-commitment`, test-only 127.0.0.1, 256 KiB bound) and the MCP tool `accept_commitment` call the SAME `acceptance-core.acceptCommitment`. Same validation, signing, persistence, and error logic. The MCP tool is NOT advertised live until its corresponding endpoint is deployed and tested (no-claim rule). The legacy `create_commitment` MCP tool is preserved unchanged.

### 12.6 Not implemented in Phase 4 (do not claim)

- No public deployment, no production payment/custody/execution/release.
- No settlement, escrow funding, or service execution from a commitment.
- No external anchoring (EAS/testnet) of commitment records.
- No Supabase-backed acceptance persistence (file journal + single-writer lock is the Phase-4 portability choice).
- No live A2A JSON-RPC interface; no distributed (multi-node) concurrency.
- No second commitment format; manifest v1 untouched; SR wrapper additive.
