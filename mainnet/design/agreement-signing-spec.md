# SAAX Agreement Signing Specification — v4 (proposed)

**Status:** INTERNAL SPECIFICATION — proposed signed-agreement format. Not implemented in production, not deployed, not validation-complete.
**Spec version:** `agreement-signing-spec-v1` (this document); **proposed manifest version: 4** (`formatVersion: 4`, `manifestVersion: 4`).
**Authoritative inputs:**
- `mainnet/policies/custody-policy-v1.md` (normative policy, esp. §A.2 binding, §B, §C, §E nonce taxonomy, §F)
- `mainnet/policies/transaction-profiles-v1.md` (profile fields)
- `mainnet/agreements/custody-policy-addendum-v1.md` (agreement template)
- `mainnet/admission/` (Phase 1 schema/validator — the structural subset this spec canonicalizes)
- `verifier/verify-export.js` (current v1/v2/v3 format handling — the compatibility boundary)
- `endpoint/commitment.js` (COSE_Sign1 envelope + canonical manifest conventions)

**Compatibility boundary (NOT a protocol-wide version claim):** the existing verifier supports `formatVersion` 1, 2, 3 and `manifestVersion` up to 3. **v4 is proposed here; the verifier is NOT extended in this phase.** v1/v2/v3 digest calculations and historical assurance claims are unchanged. Nothing in this document is wired into production routes.

---

## 1. Purpose

Define the exact signed-agreement format that cryptographically binds the Phase 1 policy/profile/admission terms (parties, asset, amount, custody, chain, permitted outcomes, deadlines, evaluator authority, fallback disposition, consents, fees/reserves) so they become digest-covered and verifiable — while preserving v1/v2/v3 compatibility for historical records.

The format follows the repo's established convention: a **COSE_Sign1-style envelope** over a **canonical JSON manifest**, with `manifestHash = sha256(signed envelope bytes)`. v4 extends the digest-covered field set; it does not change the envelope mechanics, the hash algorithm, or the v1–v3 field semantics.

---

## 2. Version identifier selection

- **`manifestVersion: 4`** (integer) inside the signed manifest (per the v3 pattern where `manifestVersion` is a digest-covered field).
- **`formatVersion: 4`** in the export envelope (the verifier's supported-version selector; currently `[1,2,3]` — v4 requires a verifier extension in Phase 3, explicitly out of scope here).
- Manifest terms `schemaVersion: "saax-commitment-v4"`, `hashingVersion: "sha256-cose-v4"`, `signatureDomainVersion: "saax-commitment-auth-v4"`.

**Why a new integer version rather than reusing v3:** the digest-covered field set changes (v4 adds policy/profile/consent/custody terms). The verifier selects the manifest by `formatVersion` and recomputes the digest over the version's exact field list; a new version number prevents an export from claiming v4 semantics over a v3 digest (downgrade/upgrade confusion — the same reason v3 is distinct from v2). This aligns with the repo's downgrade-protection design ("an export cannot claim a weaker manifest version than the digest was computed over").

---

## 3. Exact schema

### 3.1 Field list (canonical order — the digest is over this exact sequence)

```
const MANIFEST_FIELDS_V4 = [
  // v1 base (8 fields)
  'commitmentId',
  'buyerAgentId',
  'sellerAgentId',
  'capability',
  'price',
  'acceptanceCriteria',
  'deadline',
  'cancelCondition',
  // v2 additions
  'manifestVersion',
  'terms',
  // v3 additions
  'evaluator',
  'evaluatorPermittedDecisions',
  // v4 additions (Phase 1 policy/profile binding)
  'policy',              // { version, digest, profilesDocVersion, profilesDocDigest }
  'profile',             // OBJECTIVE_DIGITAL | PHYSICAL_DELIVERY | SUBJECTIVE_SERVICE
  'custody',             // { chainId, custodyAddress, token, principal, fees, reserve }
  'consents',            // buyer + seller consent records (incl. seller timeout consent where profile requires)
  'evidenceRequirements',// { sources, submissionMechanism, minimumCount, maxAge, verdictRequired }
  'deadlines',           // profile deadlines: { delivery, resolution, finalCutoff } (obj) / milestones (phy/subj)
  'fallbackDisposition', // { rule, executor? } — the approved fallback/longstop
];
```

The canonical manifest object contains **only these fields** (in this order), with nested objects key-sorted recursively (deepSortKeys), no whitespace — following the repo's `canonicManifest` convention.

### 3.2 Required vs optional fields

| Field | Required | Notes |
|---|---|---|
| `commitmentId`, `buyerAgentId`, `sellerAgentId`, `capability` | required | as v1/v2/v3 |
| `price` | required | `{ amount: exact-integer-string, currency, decimals }` — float rejected |
| `acceptanceCriteria` | required | v3 pattern (`evidence_hidden_answer_set_v1` etc.) |
| `deadline`, `cancelCondition` | required | v1 base; deadline ISO-8601 UTC |
| `manifestVersion` | required | must be `4` |
| `terms` | required | schema/hashing/signature-domain/policy/evidence/recovery sub-objects (v3 pattern) |
| `evaluator` | required | 2-of-3 aggregate address (v3 idea extended) |
| `evaluatorPermittedDecisions` | required | `["release","refund"]` for restricted; advanced may extend |
| `policy` | required | `{ version: "saax-custody-policy-v1", digest, profilesDocVersion, profilesDocDigest }` |
| `profile` | required | one of the three |
| `custody` | required | `{ chainId, custodyAddress, token, principal, fees, reserve }` (all exact ints; fees/reserve separate from principal) |
| `consents` | required | `{ buyer: {accepted:true, ref}, seller: {accepted:true, ref} }` + profile-required consents (e.g. `sellerTimeoutConsent`) |
| `evidenceRequirements` | required | sources, mechanism, min count, max age, verdict required |
| `deadlines` | profile-conditional | obj: `{delivery, resolution, finalCutoff}`; phy/subj: milestone deadlines |
| `fallbackDisposition` | conditional | required for advanced profiles (longstop); may be omitted for restricted obj? — see §4 (restricted profile's timeout refund IS the fallback; recorded in `deadlines.finalCutoff` + `consents`) |

**Consent semantics:** `consents` is **required** — a buyer and seller consent record must both be present and `accepted:true`. For OBJECTIVE_DIGITAL, `consents.sellerTimeoutConsent` must be present with the exact declared effect ("refund to original buyer at/after cutoff") — mirroring the admission validator's `buyerRefundTimeoutConsent.acceptedBySeller === true` check. **A missing consent is a structural failure of the signed agreement** (not merely a warning).

### 3.3 Descriptive attachments vs enforceable terms

- Everything in `MANIFEST_FIELDS_V4` is a **digest-covered enforceable term** (changes break the digest).
- **Descriptive/off-chain attachments** (evidence record bodies, carrier documents, IP text, the full off-chain agreement PDF reference) are **not** inside the canonical manifest. They are referenced by hash/URI in `terms`/`evidenceRequirements`/`fallbackDisposition` as **references**, distinguished from standalone fields. The spec requires: *any outcome-affecting value is an in-manifest field; anything merely descriptive is a referenced attachment* — the verifier treats only the canonical manifest as signed terms, and treats attachment references as unverified-by-digest (their content is authenticated by their own stated hash, not by the agreement digest).
- This separation is mandatory: the signed digest is the **authoritative record of the parties' consent**; attachments are evidence, not terms.

---

## 4. Canonicalization, signatures, and encoding

### 4.1 Canonicalization (bytes fed to the signing hook)

```
canonicalManifestV4(m) =
  JSON.stringify(
    deepSortKeys(pickFields(m, MANIFEST_FIELDS_V4))
  )            // fields in MANIFEST_FIELDS_V4 order, nested keys sorted, no whitespace
```

- `deepSortKeys` sorts object keys recursively (arrays keep order) — matches the repo's verifier implementation.
- **Monetary amounts:** exact integer strings in token base units; floats rejected (validated before signing). `price.amount`, `custody.principal`, `custody.fees`, `custody.reserve` are all exact-integer strings.
- **Addresses:** 0x-hex 40 chars (or CAIP-19 for `asset` where applicable) — validated before signing.
- **Times:** ISO-8601 UTC strings for deadlines; unix seconds (integer) for on-chain `deadline`/`finalCutoff` mapping (documented conversion; the manifest stores the ISO form, the custody contract stores unix seconds — the conversion is deterministic and covered by the digest via the ISO form).
- **Hash algorithms:** SHA-256 for the manifest digest (`sha256:` + hex, per repo convention). EIP-712 typed-data hashing uses keccak256 with domain separation (below).

### 4.2 COSE_Sign1 envelope (unchanged mechanics from v1–v3)

```
envelope = { tag: 'COSE_Sign1',
             protected: base64url({alg, kid}),
             unprotected: base64url({}),
             payload: base64url(canonicalManifestV4),
             signature: signatureHex }        // from the signing hook
manifestHash = 'sha256:' + sha256(JSON.stringify(envelope))
```

The signing hook returns a 65-byte ECDSA signature (0x + 130 hex) for EOA signers; for contract-wallet parties the signature is an EIP-1271 reference (`0x` + magic value or reference) — see §6. The hook is the same pattern as `endpoint/commitment.js`; the structure (not the crypto) is what this spec fixes.

### 4.3 Domain separation

**Two EIP-712 domains are used (never conflated):**

1. **Agreement/commitment authorization domain** (parties signing the v4 manifest as EIP-712 typed data, where the manifest is signed as a typed struct for party consent): domain name `"SAAX Commitment V4"`, version `"4"`, chainId, verifyingContract = the custody deployment address (so a signature on mainnet is invalid on testnet and vice versa).
2. **Custody verdict domain** (already deployed in V1, unchanged): `DOMAIN_NAME = "SAAX Escrow Custody V1"`, `DOMAIN_VERSION = "1"`, chainId, verifyingContract = custody address. **V2 keeps this same verdict domain name/version** unless the custody contract changes the verdict type — the v2 design preserves the `EscrowVerdict` type and domain to keep verdict verification semantics stable (the v2 deployment simply has a different `verifyingContract` automatically).

**Signature types:**
- Party consent: EIP-712 `CommitmentConsent` (or COSE_Sign1 for the envelope; the two may coexist: the manifest is the canonical payload, and each party additionally signs an EIP-712 consent over the manifest hash for authorization-token workflows — specify which in the transaction's auth profile).
- Verdict: EIP-712 `EscrowVerdict(commitmentId, commitmentDigest, action, nonce, issuedAt)` — unchanged from V1.

**Separation invariant:** a custody verdict signature cannot authorize an agreement term change, and an agreement consent cannot move funds. Access authorization (role/action nonce) is a third, distinct signature domain (`EscrowAccess` in `endpoint/escrow-access.js`) — see §7.

---

## 5. Binding obligations (what the digest covers)

The v4 digest cryptographically binds **all outcome-affecting values**:

| Term | Digest-covered via |
|---|---|
| Policy id/version/digest + profiles doc | `policy` |
| Selected profile | `profile` |
| High-value layer (when applied) | `terms.highValueAssurance` (digest-covered sub-object) |
| Parties (buyer, seller) | `buyerAgentId`, `sellerAgentId` (+ `terms.representatives` for HVA) |
| Asset, principal, fees, reserve | `custody` (exact ints; fees/reserve separate from principal) |
| Evaluator identity + permitted decisions | `evaluator`, `evaluatorPermittedDecisions` |
| Custody + chain | `custody.chainId`, `custody.custodyAddress` |
| Deadlines (delivery/resolution/final cutoff; milestones) | `deadlines` |
| Fallback/longstop disposition | `fallbackDisposition` |
| Evidence requirements | `evidenceRequirements` (sources, mechanism, count, age, verdict required) |
| Buyer/seller consent + seller timeout consent | `consents` |
| Commitment/capability/acceptance | v1 base fields |

**Required buyer/seller consent:** the `consents` object is a required field; both parties' `accepted:true` records are digest-covered. For OBJECTIVE_DIGITAL, `consents.sellerTimeoutConsent` (express seller acceptance of the cutoff refund) is required and digest-covered — the machine-readable equivalent of addendum clause 4.3.

---

## 6. Contract-wallet validation (consistent across signing, verdict, export)

| Stage | Current | v4 requirement | Implementation status |
|---|---|---|---|
| Agreement signing | EOA EIP-712 / COSE hook | Accept an EIP-1271 signature reference for contract-wallet parties; record `walletType` + `verificationBlock` | **Not implemented** — specified here; Phase 3+ |
| Verdict authorization | `ecrecover` (V1) | 2-of-3 aggregate: ecrecover-compatible (MPC) OR EIP-1271 hook (Safe) — per custody-v2-design §7 | **Not implemented** — mechanism decision pending (activation blocker) |
| Export verification | verifier checks EOA ecrecover | Verifier must record the signer mechanism and, for contract wallets, read the wallet owner/threshold snapshot at the verdict block | **Not implemented** — Phase 3+ (must not silently assume ecrecover works for a contract wallet) |

**Where additional implementation remains necessary:** (1) custody EIP-1271 hook if the Safe route is chosen; (2) verifier support for contract-wallet signer snapshots (owner/threshold at a recorded block); (3) admission validator alignment to `MANIFEST_FIELDS_V4` field names. All three are recorded as deferred in §8 and in the capability matrix (custody-v2-design §8).

---

## 7. Nonce taxonomy (four distinct mechanisms — never conflated)

| # | Nonce | Scope | Purpose | Guard |
|---|---|---|---|---|
| 1 | **Business operation identity** | The commitment/operation id (e.g. `commitmentId`) | Identifies the business operation; idempotency key for the durable acceptance ledger | Unique per operation (ledger unique key) |
| 2 | **Access authorization nonce** | `EscrowAccess.authorization.nonce` (EIP-712) | Authorizes a role+action scope; consumed at durable acceptance; retries keyed on it | Replay-guarded by the access ledger (once per nonce per role) |
| 3 | **Verdict/resolution nonce** | `EscrowVerdict.nonce` (`usedVerdictNonce` in custody) | One-time evaluator verdict per escrow | Custody `Replay` revert on reuse |
| 4 | **Relayer account transaction nonce** | EOA `tx.nonce` (the account sequence) | Broadcast ordering; replay protection for transactions | Standard Ethereum account nonce |

**Distinct invariants:**
- A verdict nonce maps to exactly one verdict; it is NOT the access nonce and NOT the account nonce.
- The access nonce is consumed at **durable acceptance** — not at external execution (policy §E.1; the recovery milestone's finding).
- The business-operation identity is the idempotency key for the durable ledger — an identical retry returns the recorded result; a changed payload with the same nonce is a conflict (409).
- A database lease does not revoke a signed transaction (policy §E.6); nonce spaces remain separate even under lease/worker coordination.

---

## 8. Migration/integration plan (documentation only — no code wired this phase)

### 8.1 How new policy fields enter a future signed manifest version

- The Phase 1 admission schema's fields (`policy`, `profile`, `custody`, `consents`, `evidenceRequirements`, `deadlines`, `fallbackDisposition`, `highValueAssurance`) must be **added as digest-covered manifest fields** in the v4 canonical field list — exactly as specified in §3.
- **Do NOT silently append unsigned fields to the existing v3 assurance claims.** The v3 digest is over `MANIFEST_FIELDS_V3`; adding fields without a version bump would create an export whose claimed digest does not cover the new fields (an unauditable claim). The version bump to 4 is the mechanism that keeps digests honest.
- The admission validator's field names must map to the v4 manifest field names (a documented mapping; Phase 3 wiring).

### 8.2 Compatibility boundary (what may NOT change)

- v1/v2/v3 digest calculations: unchanged (the verifier's field lists for 1/2/3 are frozen).
- Historical signature verification: unchanged (a v3 export still verifies under v3 rules; a v1 export under v1 rules).
- The deployed V1 custody contract and its `EscrowVerdict` domain: unchanged.
- The v4 spec is additive: a new manifest version, a new export format version, new digest-covered fields.

---

## 9. Test vector conventions (synthetic)

- All fixtures synthetic; addresses `0x1111…`–`0x9999…`; amounts exact-int strings; deadlines future ISO-8601 UTC; no real keys, no secrets.
- Deterministic digest test: two identical manifest objects (deep-equal) produce identical canonical bytes and identical `sha256:` digests; key-order permutations produce identical digests (deepSortKeys).
- Version separation: a v3 manifest and a v4 manifest with the same visible fields produce different canonical bytes (the `manifestVersion` differs) and different digests.
- Tampering: any digest-covered field change (policy version, consent removal, deadline swap, amount change) changes the digest.
- Missing consent: removing `consents.sellerTimeoutConsent` is a structural failure.
- Invalid amount/deadline: float amount / non-ISO deadline / deadline ordering violation fail validation before signing.

*End of agreement-signing-spec (v4).*
## Phase 3B candidate clarification (supersedes conflicting proposed passages)

The isolated v4 verifier is now implemented in `verifier/verify-v4.js`, dispatched from
`verifier/verify-export.js`; this does not enable production routes or admission.

- Canonical bytes follow the existing `v4-canonical.js` implementation: **all object
  keys, including the top level, are sorted recursively**. The field list selects
  fields; it does not impose serialized top-level order. Legacy v1/v2/v3 remain unchanged.
- The local **actual V2 candidate** declares custody domain `SAAX Escrow Custody V2`,
  version `2`. The earlier §4.3 proposal that V2 preserves the V1 domain is not true
  of this implementation. Agreement consent remains `SAAX Commitment V4` / `4`.
  Format version alone never selects custody identity or domain.
- The COSE-style envelope is a serialization/digest container; its `ES256` label
  and structural placeholder signature are NOT proof of party authorization.
  Exactly one genuine EOA EIP-712 CommitmentConsent per buyer/seller authorizes
  its complete hash. Contract-wallet PARTY consent remains unsupported.
- Candidate export mapping adds signed `terms.policyId` (decimal integer string)
  and `terms.minReleaseTime` (unix-seconds integer string). `deadline` and
  `deadlines.resolution` map to the same seconds. The verifier enforces the signed
  resolution bound even though the candidate contract only gates exits by cutoff.
- Restricted local scope requires zero fees/reserve, explicit buyer/seller refs,
  seller timeout effect `refund to original buyer at/after cutoff`, fallback rule
  `refund-original-buyer-at-cutoff`, and bytes32 commitment identifiers.
- Historical evaluator ERC-1271 assurance uses successful canonical direct-call
  execution of an exact allowlisted immutable custody runtime, NOT a current or
  end-of-block Safe snapshot. See `phase3b-v4-checkpoint.md` for trust boundaries.
- Public-chain finality and full external evidence/adjudication assurance are not
  implemented; local lifecycle verdict is `VERIFIED_WITH_LIMITATIONS`. Issuance
  returns `VERIFIED_ISSUANCE_ONLY`. Missing required historical support returns
  `INCOMPLETE_UNSUPPORTED`, never full-lifecycle VERIFIED.
