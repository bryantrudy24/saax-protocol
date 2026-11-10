# SAAX Discovery Phase 2 — Decision Table & Security Posture

Date: 2026-11-05 · Phase-1 HEAD: `07a3cf96` · This table extends Phase-1's `docs/discovery-phase1/decision-table.md` (D1–D27), which remains authoritative.

## New decisions (Phase 2)

| # | Decision | Choice | Rationale / source |
|---|---|---|---|
| D28 | Signing library | `jose` v6.2.12 (`FlattenedSign`/`flattenedVerify`) for Ed25519 JWS; must NOT use JWT claims (no iat) so the signed payload is exactly the RFC 8785 canonical document | RFC 7515/8032; maintained, already in the tree (hoisted) |
| D29 | Signed payload | JWS payload = RFC 8785 canonical bytes of the PROFILE WITHOUT the `signature` envelope; `cty` header omitted; `kid` set to the signing key id | Deterministic across runtimes; matches the contract module's `jcs()` |
| D30 | Trust source (Phase 2) | ONE implemented path: `configured-key` — client pins trusted signing keys by RFC 7638 JWK thumbprint (in trust config). DID / registry / prior-pinned identity: explicitly UNSUPPORTED this phase | Brief §2: implement one concrete trust path first; mark others unsupported |
| D31 | Self-declared key | Signature consistency only. `authenticated` requires thumbprint ∈ trusted set AND origin match AND key active/valid | Brief §2; Phase-1 D4 |
| D32 | Agent Card auth | A2A v1.0 `signatures[]` verified against configured verification keys; a card carrying signatures that fail verification = auth failure → no fallback. A card with NO signatures is unauthenticated but usable (signatures optional per card spec) | A2A v1.0 card schema; brief §5: invalid authentication must not trigger weaker fallback |
| D33 | DNS rebinding defense | The OS-resolved IP is VALIDATED and the SAME IP is passed to https.request via a `lookup` override; hostname validation alone is never sufficient | Brief §4: validate actual connection destination, not only an earlier DNS lookup |
| D34 | Test-localhost exception | `allowLocalhost`/`permitLocalhost` exists ONLY in the test harness config path; production policy constant is false and the resolver's production path never enables it | Brief §6; explicit and restricted to tests |
| D35 | Cache semantics | `ProfileCache` keyed by trust-fingerprint + origin; read served ONLY if signed `expires` in the future and signing key still active; key/profile change invalidates | Phase-1 D16/D17 + brief §3: never confuse cache freshness with signed validity |
| D36 | Explicit standalone URL | A direct profile URL is a deliberate retrieval, not "fallback"; a card that exists but lacks the SAAX extension requires explicit fallback permission (fails closed otherwise) | Brief §5: distinguish missing-A2A from negotiation verdict |
| D37 | Requirement-never-downgrades | `authFallbackPolicy` + resolver: auth fail / required-extension incompat → DSC_AUTH_FAILED_NO_FALLBACK / DSC_MISSING_REQUIRED_EXTENSION, never an unsigned/weaker representation | Phase-1 D3 + brief §5 |
| D38 | Structured result axes | Result separates `advertised` (capabilities/combos declared) vs `authenticatedPublisher` (trust) vs `demonstratedConformance` (`conformance.demonstrated[]`) vs `currentAvailability` (checked:false this phase) | Brief §3: do not collapse into "trusted" |

## Security posture table (Phase 2)

| Threat | Mitigation (implemented + tested) | Evidence |
|---|---|---|
| Self-declared profile impersonation | `configured-key` thumbprint anchor; origin match; key status check | runner cases 1, 2, 17 |
| Tampered payload | JWS verify + byte-precision payload compare → DSC_PAYLOAD_MISMATCH | runner case 3 |
| Unsupported algorithm | `alg!=EdDSA` rejected up front → DSC_UNSUPPORTED_ALGORITHM | crypto probe |
| Key confusion (wrong kid) | expectedKeyId enforced → DSC_KEY_ID_MISMATCH | crypto probe |
| Expired profile | signed `expires` checked; cache cannot override | runner case 6 + cache case |
| Rotation / revoked key | key status + trust-anchor change invalidates cache; old anchor rejects new key | runner case 25 |
| SSRF / private targets | IP classification + validated-IP connect (loopback/private/link-local/ULA/CGNAT blocked) | runner cases 10, 11 |
| DNS rebinding | same validated IP used for connection (lookup override) | module design + case 10/11 |
| Redirect abuse | ≤3 hops; each hop re-validates https + destination IP | runner cases 11, 12 |
| Oversized responses | 256 KiB / 1 MiB caps enforced mid-stream | runner case 13 |
| Slowloris / timeout | 10 s total, 5 s per-hop caps | runner case 14 |
| Content sniffing / wrong type | JSON content-type enforced | runner case 15 |
| Auth-failure downgrade | DSC_AUTH_FAILED_NO_FALLBACK; tampered card → no fallback | runner case 20 |
| Required-extension downgrade | DSC_MISSING_REQUIRED_EXTENSION; no-card no-permit fails closed | runner case 19 |
| Stale cache vs expiry | signed expiry dominates cache freshness | runner case 23/24 |

## Test commands (Phase 2)

```
node conformance/runner/run-conformance.mjs          # 91 passed, 0 failed
node scripts/_check-discovery-schemas.cjs            # 11 passed, 0 failed
node tests/discovery-phase2/run-phase2-tests.cjs      # 26 passed, 0 failed
```
