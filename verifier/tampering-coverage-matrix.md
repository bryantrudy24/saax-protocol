# SAAX Tampering Coverage Matrix (v3)

Audit trail mapping every security-relevant field and cross-record binding in the
verifier export to a tampering case, the rejection reason asserted, and the
verifier check that detects it.

- **v3 baseline:** `evidence/baseline-v3-verified-commitment.json` (fresh v3
  baseline; terms, manifestVersion, evaluator and evaluatorPermittedDecisions are
  INSIDE the signed digest and anchored on Base Sepolia; attester
  `0x59B41A...` is a DISTINCT role from evaluator `0x04867F...`)
- **v2 baseline:** `evidence/baseline-v2-verified-commitment.json` (unchanged,
  preserved: 19/19, `VERIFIED (issuance profile)` with the v2 assurance limit
  "authenticated evaluator authority is NOT established by v2")
- **v1 baseline:** `evidence/baseline-verified-commitment.json` (unchanged,
  historical; sha256 `d255a424c8e2142df1a7d047145c53c8dad3890d62e9a7eaa5176b2784eae46d`)
- **Verifier:** `verifier/verify-export.js` (fresh process, no SAAX DB)
- **v3 battery:** `scripts/v3-battery.cjs` (57 cases: baseline + 55 tamper cases +
  the positive attester != evaluator case, including the v2 suite, downgrade,
  omitted-field, conflicting-version, cross-record substitution, and the four
  evaluator bindings)
- **v3 full-lifecycle fixture:** `scripts/_make-v3-full-fixture.cjs` (released
  escrow + evaluator-signed verdict + fund/release journal events)
- **Reproduce v3 baseline verification:**
  ```
  set "SUPABASE_URL=" && set "SUPABASE_SERVICE_ROLE_KEY=" && set "SUPABASE_ANON_KEY=" && set "PGHOST=" && set "DATABASE_URL=" && node verifier/verify-export.js evidence/baseline-v3-verified-commitment.json --rpc https://sepolia.base.org
  ```
- **Reproduce v3 battery:** `node scripts/v3-battery.cjs`

Legend for **Status**: `ENFORCED` = a tampering case exists and the verifier
rejects it with a specific reason; `HISTORICAL-LIMIT` = a v1 field that verifies
under v1 rules but is explicitly reported as not authenticated (v1 assurance
downgrade); `POSITIVE` = a case that MUST verify (e.g. attester != evaluator).

---

## v3 evaluator authority — the four bindings

The v3 manifest adds `evaluator` (the address authorized to decide fulfillment)
and `evaluatorPermittedDecisions` (the set of decisions it may make — e.g.
release, refund, extend_deadline, dispute). Both are INSIDE the signed digest
(v3 canonical manifest) and covered by the anchor. The anchor attester is a
SEPARATE role and need not equal the evaluator. Four bindings are enforced:

### Binding 1: agreement → evaluator
BOTH parties sign the evaluator identity and its permitted decisions. Every v3
export must carry an `evaluator`-role authorization, signed by the parties over
the digest-covered evaluator + permitted decisions. Substituting the agreement's
evaluator is rejected (digest no longer recomputes, and no authorization signs
the substituted value).

| Field / claim | Case | Expected rejection reason | Detecting check | Status |
|---|---|---|---|---|
| `agreement.evaluator` (digest-covered) | case-60-evaluator-substitution-agreement | recomputed digest != claimed + no auth signs the substituted evaluator | `agreement digest recomputed` + `evaluator authority authenticated` | ENFORCED |
| evaluator authority absence (forged auths w/o evaluator role) | case-12-forged-authorization-selfasserted-party | no evaluator-role authorization — parties did not sign evaluator authority | `evaluator authority authenticated` | ENFORCED |
| evaluator authority cross-record (substituted signatures) | case-51-cross-record-signature-substitution | no evaluator-role authorization + an auth signs a different digest | `evaluator authority authenticated` + `cross-record binding: authorization digests` | ENFORCED |

### Binding 2: escrow → agreement
The escrow record's `evaluator` field must equal the AGREEMENT's digest-covered
evaluator. If the escrow declares a different evaluator, reject with a specific
reason naming the mismatch. Issuance-profile exports (escrow null) have no
escrow claim, so the binding is vacuously satisfied.

| Field | Case | Expected rejection reason | Detecting check | Status |
|---|---|---|---|---|
| `escrow.evaluator` | case-61-evaluator-substitution-escrow | escrow evaluator 0x2222... != agreement evaluator 0x04867f... | `escrow evaluator bound` | ENFORCED |
| escrow substitution (no evaluator / no verdict) | case-11-substituted-escrow-reference | escrow record has no evaluator to bind + released escrow has no releaseVerdict.verdict | `escrow evaluator bound` + `verdict bound to escrow` | ENFORCED |

### Binding 3: journal → agreement
Every CONSEQUENTIAL journal event requires the authority defined for its
transition. Evaluator events (release, refund, extend_deadline, dispute
resolution) must be signed by the digest-covered evaluator and correspond to a
decision in `evaluatorPermittedDecisions`. Buyer/seller events stay bound to the
respective party. The recovered signer (never the declared `by`) is
authoritative.

| Field / claim | Case | Expected rejection reason | Detecting check | Status |
|---|---|---|---|---|
| `journal.evaluator` (declared) | case-39-tampered-journal-evaluator | declared evaluator != agreement evaluator | `journal evaluator bound` | ENFORCED |
| journal event authority (release signed by non-evaluator) | case-62-evaluator-substitution-journal | event 3 signer (buyer) != by (evaluator) | `journal event signed by evaluator` | ENFORCED |
| cross-record journal substitution (events from another commitment) | case-50-cross-record-journal-substitution | event 0 transition issue requires buyer but signer has no such authority + journal evaluator != agreement | `journal event authority` + `journal evaluator bound` | ENFORCED |

### Binding 4: verdict → escrow
The evaluator's decision must identify the SAME commitment, digest, escrow, and
action. The verifier checks (each with a specific reason): verdict.commitmentId
== export digest binding, verdict.digest == signed digest, verdict.escrow == the
escrow record's reference, verdict.action is within evaluatorPermittedDecisions,
and the verdict is signed by the digest-covered evaluator.

| Field / claim | Case | Expected rejection reason | Detecting check | Status |
|---|---|---|---|---|
| verdict signer (substituted evaluator) | case-63-evaluator-substitution-verdict | verdict signer != digest-covered evaluator | `verdict bound to escrow` | ENFORCED |
| verdict action outside permitted set | case-64-permitted-decision-violation | verdict action steal_funds not within evaluatorPermittedDecisions | `verdict bound to escrow` | ENFORCED |
| verdict referencing different commitment/digest/escrow | case-65-verdict-binding-failure | verdict.commitmentId != export digest binding | `verdict bound to escrow` | ENFORCED |

### Positive: attester != evaluator
The v3 baseline has DISTINCT attester (`0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70`)
and evaluator (`0x04867f30d8Cc98ad9d8E6FFb097371a0262daeE8`) addresses, and the
verifier ACCEPTS it (case-00-baseline-v3: 22/22 VERIFIED; case-66
-positive-attester-ne-evaluator: 23/23 VERIFIED on the full-lifecycle fixture).
This proves the verifier enforces the INTENDED relationship (separate roles,
evaluator authority authenticated by the parties) rather than requiring the
addresses to match.

---

## Manifest versioning and downgrade protection

The canonical manifest is **versioned**. `manifestVersion` and `terms` are
fields INSIDE the v2/v3 manifest, and v3 additionally covers `evaluator` and
`evaluatorPermittedDecisions`. The signed digest therefore authenticates the
version, every term, and the evaluator authority. The verifier selects the
manifest from the authenticated representation (formatVersion → v1/v2/v3
manifest), never from an unsigned field. An export cannot claim a weaker
manifest version than the digest was computed over.

| Field | Case | Expected rejection reason | Detecting check | Status |
|---|---|---|---|---|
| `agreement.manifestVersion` (v3) | case-41-downgrade-manifestVersion-to-v1 | recomputed digest != claimed (version not in the signed digest) | `agreement digest recomputed` | ENFORCED |
| `agreement.manifestVersion` removed (unsigned) | case-42-unsigned-manifestVersion-removed | v3 manifest missing manifestVersion (not authenticated) | `agreement digest recomputed` | ENFORCED |
| `formatVersion` claimed v1 on a v3 export | case-43-formatVersion-claim-v1-on-v3 | recomputed digest != claimed + journal evaluator != anchor attester | `agreement digest recomputed` + `journal evaluator bound` | ENFORCED |
| conflicting version fields | case-47-conflicting-version, case-48-conflicting-version-reverse | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `formatVersion` unsupported | case-38-tampered-formatVersion | unsupported formatVersion 9 (supported: 1, 2, 3) | `format version supported` | ENFORCED |

## Security-relevant fields (v3 coverage)

| Field | Case | Expected rejection reason | Detecting check | Status |
|---|---|---|---|---|
| `commitmentDigest` (agreement digest) | case-09-modified-digest-field | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.buyerAgentId` | case-17-tampered-buyerAgentId | digest mismatch + recovered buyer signer != agreement | `agreement digest recomputed` + `auth signer buyer` | ENFORCED |
| `agreement.sellerAgentId` | case-18-tampered-sellerAgentId | digest mismatch + recovered seller signer != agreement | `agreement digest recomputed` + `auth signer seller` | ENFORCED |
| `agreement.price` | case-01-modified-price | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.acceptanceCriteria` | case-19-tampered-acceptanceCriteria | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.signatureHex` | case-20-tampered-agreement-signature | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.terms.policyVersion` | case-30-tampered-terms-policyVersion | recomputed digest != claimed (terms inside v3 digest) | `agreement digest recomputed` | ENFORCED |
| `agreement.terms.schemaVersion` | case-31-tampered-terms-schemaVersion | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.terms.hashingVersion` | case-32-tampered-terms-hashingVersion | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.terms.evidencePolicy` | case-33-tampered-terms-evidencePolicy | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.terms.recoveryRules` | case-34-tampered-terms-recoveryRules | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.terms` omitted | case-44-omitted-terms | recomputed digest != claimed (omitted-field) | `agreement digest recomputed` | ENFORCED |
| `agreement.deadline` omitted | case-45-omitted-deadline | recomputed digest != claimed (omitted-field) | `agreement digest recomputed` | ENFORCED |
| `agreement.acceptanceCriteria` omitted | case-46-omitted-acceptanceCriteria | recomputed digest != claimed (omitted-field) | `agreement digest recomputed` | ENFORCED |
| `agreement.evaluator` (v3) | case-60-evaluator-substitution-agreement | recomputed digest != claimed | `agreement digest recomputed` | ENFORCED |
| `agreement.evaluatorPermittedDecisions` (v3) | case-64-permitted-decision-violation (exercised via verdict action) | verdict action not within permitted set | `verdict bound to escrow` | ENFORCED |
| authorization signature (buyer) | case-07-forged-buyer-authorization | recovery fails / signer != agreement | `auth signer buyer` | ENFORCED |
| authorization signature (seller) | case-15-forged-seller-authorization | recovery fails / signer != agreement | `auth signer seller` | ENFORCED |
| authorization recovered signer (buyer) | case-08-substituted-party, case-12-forged-authorization-selfasserted-party | recovered signer != digest-covered agreement party | `auth signer buyer` | ENFORCED |
| authorization domain.chainId | case-25-tampered-auth-domain-chainId | recovery yields a different signer | `auth signer buyer` | ENFORCED |
| authorization message.scope | case-26-tampered-auth-message-scope | recovery yields a different signer | `auth signer buyer` | ENFORCED |
| authorization expectedParty (contradicts agreement) | case-27-contradictory-declared-party | declared contradicts agreement | `auth signer buyer` | ENFORCED |
| `anchor.uid` | case-02-wrong-attestation-uid | attestation not found (zero uid) | `EAS anchor chain-verified` | ENFORCED |
| `anchor.txHash` | case-35-tampered-anchor-txHash | tx not found on chain | `EAS anchor txHash chain-verified` | ENFORCED |
| `anchor.chainId` | case-36-tampered-anchor-chainId | on-chain chainId != declared | `EAS anchor chainId matches` | ENFORCED |
| `anchor.commitmentId` | case-13-anchor-commitmentId-mismatch | on-chain commitmentId != declared | `EAS anchor commitmentId matches` | ENFORCED |
| `anchor.commitmentDigest` | case-03-substituted-anchor-digest | on-chain digest != declared + cross-record anchor digest | `EAS anchor digest matches` + `cross-record binding: anchor digest` | ENFORCED |
| `anchor.schemaUid` | case-37-tampered-anchor-schemaUid | declared schemaUid != on-chain / derived | `EAS anchor schemaUid matches` | ENFORCED |
| `anchor.resolver` (nonzero) | case-14-anchor-resolver-nonzero | recomputed schema UID no longer matches on-chain | `EAS anchor schema matches` | ENFORCED |
| `anchor.revocable` / revocable attestation | case-16-anchor-points-at-revocable-attestation | schema mismatch + revocable=true | `EAS anchor schema matches` + `EAS anchor revocable=false` | ENFORCED |
| `anchor.attester` | case-40-tampered-anchor-attester | on-chain attester != declared | `EAS anchor attester matches` | ENFORCED |
| journal event count (declared) | case-24-tampered-journal-eventCount | event count != declared | `journal ordering + hash chain` | ENFORCED |
| journal event ordering | case-05-reordered-journal | broken at N: prevHash | `journal ordering + hash chain` | ENFORCED |
| journal tail hash | case-21-tampered-journal-tailHash | tail != declared tailHash | `journal ordering + hash chain` | ENFORCED |
| journal event signature | case-22-tampered-journal-event-signature | event N signer none != by | `journal event signed by evaluator` | ENFORCED |
| journal event parent reference (prevHash) | case-23-tampered-journal-prevHash | broken at N: prevHash | `journal ordering + hash chain` | ENFORCED |
| journal event state/entryHash (altered history) | case-04-altered-journal-state | tampered at N: entryHash | `journal ordering + hash chain` | ENFORCED |
| journal missing history (suffix dropped) | case-06-missing-history | event count != declared | `journal ordering + hash chain` | ENFORCED |
| `journal.evaluator` (v3 → agreement) | case-39-tampered-journal-evaluator | declared evaluator != agreement evaluator | `journal evaluator bound` | ENFORCED |
| escrow binding (substituted reference) | case-11-substituted-escrow-reference | state not terminal / no tx reference / escrow has no evaluator | `escrow terminal outcome` + `evidence-backed release` + `escrow evaluator bound` | ENFORCED |
| lifecycle profile (relabel) | case-10-relabeled-lifecycle-profile | issue profile with escrow record | `escrow terminal outcome` | ENFORCED |
| `formatVersion` | case-38-tampered-formatVersion | unsupported formatVersion | `format version supported` | ENFORCED |

## Cross-record bindings (v2+)

A commitment's records must all bind to the SAME signed digest. Substituting an
anchor, journal, or signature from a DIFFERENT commitment produces records that
verify individually (same parties, same schema) but reference a different
digest. v1 keeps the legacy digest binding; v2/v3 enforce the strict binding.

| Binding | Case | Expected rejection reason | Detecting check | Status |
|---|---|---|---|---|
| `anchor.commitmentDigest` ↔ export signed digest | case-49-cross-record-anchor-substitution | anchor digest != export digest | `cross-record binding: anchor digest` | ENFORCED |
| `journal.commitmentId` ↔ export signed digest | case-50-cross-record-journal-substitution | journal digest != export digest | `cross-record binding: journal digest` | ENFORCED |
| authorization message digest ↔ export signed digest | case-51-cross-record-signature-substitution | an authorization signs a different digest than the export | `cross-record binding: authorization digests` | ENFORCED |
| `anchor.commitmentDigest` ↔ export digest | case-03-substituted-anchor-digest | on-chain digest != declared + cross-record anchor digest | `EAS anchor digest matches` + `cross-record binding: anchor digest` | ENFORCED |
| `agreement.digest` ↔ `anchor.digest` | case-03-substituted-anchor-digest | on-chain digest != declared commitmentDigest | `EAS anchor digest matches` | ENFORCED |
| `anchor.commitmentId` ↔ export `commitmentId` | case-13-anchor-commitmentId-mismatch | on-chain id != anchor.commitmentId | `EAS anchor commitmentId matches` | ENFORCED |
| `anchor.schemaUid` ↔ derived schema UID | case-37-tampered-anchor-schemaUid | declared != on-chain / derived | `EAS anchor schemaUid matches` | ENFORCED |
| `agreement.buyerAgentId` ↔ recovered buyer signer | case-08-substituted-party, case-17-tampered-buyerAgentId | recovered signer != agreement party | `auth signer buyer` | ENFORCED |
| `agreement.sellerAgentId` ↔ recovered seller signer | case-15-forged-seller-authorization, case-18-tampered-sellerAgentId | recovered signer != agreement party | `auth signer seller` | ENFORCED |
| journal `tailHash` ↔ last event hash | case-21-tampered-journal-tailHash | tail != declared tailHash | `journal ordering + hash chain` | ENFORCED |
| journal `eventCount` ↔ number of events | case-24-tampered-journal-eventCount | count != declared | `journal ordering + hash chain` | ENFORCED |
| `anchor.attester` ↔ authorized attester | case-40-tampered-anchor-attester | on-chain attester != declared | `EAS anchor attester matches` | ENFORCED |
| `journal.evaluator` ↔ agreement evaluator (v3) | case-39-tampered-journal-evaluator | declared evaluator != agreement evaluator | `journal evaluator bound` | ENFORCED |
| agreement evaluator ↔ party-signed evaluator authorization (v3) | case-60-evaluator-substitution-agreement | no auth signs the substituted evaluator | `evaluator authority authenticated` | ENFORCED |
| escrow evaluator ↔ agreement evaluator (v3) | case-61-evaluator-substitution-escrow | escrow evaluator != agreement evaluator | `escrow evaluator bound` | ENFORCED |
| verdict signer ↔ agreement evaluator (v3) | case-63-evaluator-substitution-verdict | verdict signer != digest-covered evaluator | `verdict bound to escrow` | ENFORCED |

## Transaction verification is a chain, not a field check

The EAS attestation's UID is derived from its data, not from its creating
transaction. The declared `anchor.txHash` is therefore verified as a chain, not
assumed from the attestation data:

1. fetch the transaction receipt by the DECLARED txHash
2. confirm it succeeded (status `0x1`) to the EAS contract
3. confirm it emitted an `Attested` event whose `data` equals the declared
   `anchor.uid`
4. confirm the event's schema and attester topics match the declared
   `schemaUid` and `attester`

If any link fails, the verifier rejects with a specific reason naming the link.
Detecting check: `EAS anchor txHash chain-verified`. Enforced by
`case-35-tampered-anchor-txHash`. See `verifier/eas-verification-limits.md` for
the direct-attestation scope and the delegated/batch/contract-mediated
limitations.

## Historical v1 preservation and assurance limits

A v1 record (`formatVersion: 1`) verifies under its original v1 rules — its
original digest and signatures recompute and recover — and the verifier reports
the v1 assurance limit explicitly:

- **Result:** `VERIFIED_WITH_LIMITATIONS` (a distinct result from v2/v3
  `VERIFIED`), with the structured message: *"v1 record — original digest and
  signatures verify, but agreement.terms was NOT authenticated by the v1
  signatures."*
- The 11 preserved `evidence/coverage-defects/` artifacts are re-run under the
  corrected verifier: terms defects (G04–G08) return `VERIFIED_WITH_LIMITATIONS`
  (the v1 limit is correctly labeled); anchor-fact, version, and evaluator
  defects (G09–G22) return `NOT VERIFIED` with specific reasons. Zero return
  plain `VERIFIED`.

A v1 record is a valid historical artifact — it is not a fully verified
commitment, and it can never become one (its terms were never in the v1 signed
digest).

## v2 preservation and its assurance limits

The v2 baseline is unchanged and still verifies under its original rules:
19/19 checks pass, `VERDICT: VERIFIED (issuance profile)`. The v2 manifest has
NO digest-covered evaluator field, so the verifier states the v2 assurance limit
explicitly on the verdict line:

> *"v2 assurance limit: authenticated evaluator authority is NOT established by
> v2 (no digest-covered evaluator field in the v2 manifest)"*

A v2 record may verify its original digest, signatures, and anchor. It does NOT
assert that the evaluator was authenticated by the parties. The v3 manifest
closes this gap by putting the evaluator identity and its permitted decisions
inside the signed digest.

## Defects closed (v1 → v2) and the v3 evaluator gap

The 11 defects from `evidence/coverage-defects/` are closed. Each now has an
enforcing check and a v2/v3 tamper case:

| # | Field (v1 defect) | v2/v3 case | Detecting check |
|---|---|---|---|
| 1 | `agreement.terms.policyVersion` | case-30 | `agreement digest recomputed` |
| 2 | `agreement.terms.schemaVersion` | case-31 | `agreement digest recomputed` |
| 3 | `agreement.terms.hashingVersion` | case-32 | `agreement digest recomputed` |
| 4 | `agreement.terms.evidencePolicy` | case-33 | `agreement digest recomputed` |
| 5 | `agreement.terms.recoveryRules` | case-34 | `agreement digest recomputed` |
| 6 | `anchor.txHash` | case-35 | `EAS anchor txHash chain-verified` |
| 7 | `anchor.chainId` | case-36 | `EAS anchor chainId matches` |
| 8 | `anchor.schemaUid` | case-37 | `EAS anchor schemaUid matches` |
| 9 | `formatVersion` | case-38 | `format version supported` |
| 10 | `journal.evaluator` | case-39 | `journal evaluator bound` (v3: to agreement evaluator) |
| 11 | `anchor.attester` | case-40 | `EAS anchor attester matches` |

The v3 milestone additionally closes the evaluator-authority gap: evaluator
substitution across agreement (case-60), escrow (case-61), journal (case-62),
and verdict (case-63) is rejected with specific reasons; a permitted-decision
violation (case-64) and a verdict binding failure (case-65) are rejected; and
the attester != evaluator positive case (case-66 + the v3 baseline itself)
proves the verifier enforces the intended separate-role relationship.

## Acceptance note

**A field count is an acceptance target, not proof of complete security.**
Coverage is defined by the tests, not by the field count. The battery asserts a
specific rejection reason for every tamper case, and the verifier's checks are
exercised by real failure modes (including downgrade, omitted-field,
conflicting-version, cross-record substitution, evaluator substitution, and
permitted-decision violations). A field count is not a security guarantee.