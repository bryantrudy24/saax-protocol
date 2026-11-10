# SAAX Trust Onboarding — Release Check C

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **HEAD:** `5345b53f` (+ this run's fixes)

## 1. The problem: a self-downloaded key must not self-authenticate

The live discovery profile (`https://saax-protocol.com/.well-known/saax.json`) is signed
with the operator key `live-2026-11`. A client that fetches the profile and extracts the
signing key **from that same response** would be authenticating the publisher with the
publisher's own claim — a self-referential trust loop. That is exactly what SAAX forbids
(spec §10.2: "A profile signature proves integrity and issuer-self-declared origin, not
independent authenticity").

The ONLY implemented trust source is **`configured-key`**: the client pins the provider's
signing public key by RFC 7638 JWK thumbprint in its OWN trust configuration, out of band
from the profile. The profile is `authenticated` only when ALL hold (spec §10.2):

1. the signing key's JWK thumbprint is in the configured trusted set, AND
2. the profile origin equals the configured provider origin, AND
3. the signing key is `active` and within its validity window, AND
4. the profile signature verifies under that key.

## 2. How a client independently authenticates the operator thumbprint (onboarding)

The thumbprint MUST be delivered through a channel that is not the profile itself.
Recommended options, in descending assurance:

| Channel | What the client verifies | Risk if used alone |
|---|---|---|
| The operator publishes the thumbprint on a **verified second channel** (e.g. the project GitHub repository `bryantrudy24/solvent-applied-saax-protocol` README, a DNS TXT record on the operator domain, or a signed announcement from an already-trusted identity) | Thumbprint string matches the profile's signing JWK | Channel compromise |
| **Out-of-band confirmation by the operator** (voice/video call, a message on a pre-existing trusted chat, printed matter) | Thumbprint string matches | Social engineering of the operator |
| **Registry/prior-pinned** (NOT implemented — unsupported) | — | — |

The client then writes the thumbprint into its trust configuration (the equivalent of the
test harness's `trustedKeys: [thumbprint]` + `trustedVerificationKeys: [publicJwk]`) and
points the resolver at the configured origin. After that, the resolver refuses any profile
whose signing key is not in the configured set — regardless of cryptographic validity.

## 3. Demonstrated configured-key path (valid + substituted)

Ran against the committed Phase-2 suite (`tests/discovery-phase2/run-phase2-tests.cjs`):

```
node tests/discovery-phase2/run-phase2-tests.cjs
```

- **PASS** `valid signed profile from configured trusted publisher succeeds` — the key IS in
  the configured set → `authenticated: true`.
- **PASS** `valid signature from untrusted key does NOT authenticate` — the same profile,
  valid Ed25519 JWS, signed by a key NOT in the configured set → `authenticated: false`
  (signature validity ≠ publisher trust; the distinction is explicit in the resolver result).
- **PASS** `rotation: new trusted key resolves` / `rotation: old trust anchor does NOT accept
  the new key` — when the operator rotates, ONLY a client that installs the NEW thumbprint
  accepts; the old anchor fails closed.
- **PASS** `tampered card -> AUTH FAILED, no fallback` — authentication failure never
  downgrades to an unsigned/weaker representation.

The same discipline applies to the buyer registry: a buyer's public key is trusted only
when its thumbprint is in the configured buyer registry (`SAAX_BUYER_REGISTRY_JSON` on the
deployed environment), never when it is merely supplied by the caller.

## 4. Explicit distinction in every result

SAAX reports FOUR axes and never collapses them:
`advertised` (what the profile declares) · `authenticatedPublisher` (key matched the
configured anchor) · `demonstratedConformance` (independent evidence) ·
`checked.currentAvailability` (live probe — currently false). A signature-valid but
untrusted profile is reported as `authenticated:false`, and every proposal carries
`trust.authenticated:false` until the resolver authenticates the key.

## 5. What is NOT claimed

- Permissionless identity verification (no DID/registry/prior-pinned support — documented
  unsupported).
- A key downloaded from the profile is trusted by itself (explicitly forbidden).
- This onboarding makes SAAX "trusted" in an absolute sense; it establishes publisher
  authenticity only as configured by the client operator.