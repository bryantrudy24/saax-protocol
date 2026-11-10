# PROPOSED - NOT APPROVED / NOT FROZEN
## Independent-Review Snapshot Approval Record - SAAX Custody V3 (F3C)

Status: PROPOSAL ONLY. This record does not freeze, approve, deploy, or authorize anything. Approval, if given, applies ONLY to an immutable local review snapshot (below) - never to production.

## 1. What is proposed for approval
Approval of the immutable LOCAL REVIEW SNAPSHOT defined by the manifest at `review/f3c-candidate/10-review-snapshot-manifest.json`, for INDEPENDENT REVIEW ONLY. The snapshot is a fixed, checksummed collection of committed repository objects (candidate source, harnesses, evidence, components) plus this preparation's documentation, so a reviewer can verify exactly what was tested without any repository access beyond the pinned revisions.

## 2. Revisions (candidate / test / evidence)
| Role | Revision | Notes |
|---|---|---|
| Candidate source | `2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8` | contracts/SAAXEscrowCustodyV3.sol, sha256 9bd413ac…; unchanged to package HEAD |
| Candidate runtime pin | keccak `0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3` | F3B/Cancun object; deployed runtime not stored (pin only) |
| Package/evidence revision | `7c26838b7709366ae032ccf6f80971692589ee37` | first-commit of 161/161 boundary harness + evidence; package HEAD |
| Prior package revision | `9066ace628cd96c569163830f3614e18b6eb0b2f` | first-commit of 46/46 realsafe harness |
| Coverage | 46/46 (real Safe ERC-1271 + same-block governance), 161/161 (boundary/invariant) | both on the pinned F3B object, identity asserted pre-behavior; executed pre-commit (see 08-test-provenance-record.md) |

## 3. Manifest path and digest
- Path: `review/f3c-candidate/10-review-snapshot-manifest.json`
- SHA-256: `920ddff847c96f6a97fadd326a19f3172c580b1d0074c3c279b7a82f7bb1abf0`
- Coverage: 78 component entries, each with pinned revision, SHA-256, byte count, keccak256; integrity block for both harnesses and source-unchanged; hash coverage explicitly EXCLUDES the manifest itself and all preparation-commit files (no circular hashes).
- The manifest content is committed in the preparation commit and is not regenerated afterwards; any regeneration changes the digest and requires re-validation.

## 4. Included scope (exact snapshot composition)
Per manifest groups: source (1), artifact (3), build (8), components (13: endpoint/worker/verifier/journal/evidence/anchor/signatures), identity/policies/config docs (10), candidate harnesses (7), candidate-lane evidence (18), historical/supporting evidence (18). Sanitized working-tree copies under `review/f3c-candidate/evidence/` and `evidence/outputs/`; generator `scripts/_review-hash-manifest.cjs`; validation notes (11-validation-notes.md); this approval record.

## 5. Exclusions
- The manifest's own checksum and the preparation-commit files (circular-hash avoidance).
- node_modules/dependency dirs; secrets, private keys, env files, runtime databases, scratch. Synthetic fixtures labeled as such.
- Dirty working-tree implementation: NOT included as candidate or harness content; only two byte-identical sanitized working-tree copies (reconcile script, final report) are included, labeled.
- Unrelated working-tree changes: preserved, not part of the snapshot.

## 6. Known limitations (retained - no production readiness implied)
- Both candidate harness runs executed on UNCOMMITTED bytes (46/46 on base 2e49625b, first committed 9066ace6; 161/161 on base 9066ace6, first committed 7c26838b); committed copies byte-identical; identity asserted pre-behavior. Full record: 08-test-provenance-record.md.
- Category D - deployment-target compatibility (84532): NOT ESTABLISHED. Local Cancun execution does not establish target-chain compatibility.
- Category E - independent review + production prerequisites: NOT DONE (no external reviewer engaged; commissioning packet exists; G11/G12 not started).
- Verifier execution-witness authorization limitation: verify-v4.js binds transaction-time authorization to canonical direct-call success into the allowlisted immutable runtime; it does NOT replay Safe owner/threshold state post-block; ERC-1271 success is not proof of approved governance.
- Anchor finality (public EAS attestation receipt): NOT ESTABLISHED. No public deployment identity entries. Mainnet activation BLOCKED under supported-network policy.
- Passing tests establish conformance, not security; no audit exists; package NOT FROZEN.

## 7. Outstanding items (carried into review)
Independent audit does NOT need to precede the snapshot it examines (gate corrected): an immutable snapshot can be prepared for independent review while deployment compatibility and production prerequisites remain open. Outstanding: owner decisions (Q1 journal-head, Q4 contract-vs-verifier enforcement, caps, legal), deployment-target compatibility work, provider/Safe provisioning, independent review engagement, deployment authorization, G9/G13 canary steps.

## 8. Change-control rules
- Approval applies ONLY to the immutable local review snapshot described by the manifest digest in section 3 at the preparation commit (the single local commit that adds this record and its companions). Any subsequent change to candidate source, harness bytes, evidence, or manifest content invalidates this approval and requires a NEW preparation and a NEW approval.
- The preparation commit is distinct from the revisions it describes (2e49625b / 9066ace6 / 7c26838b remain untouched).
- No freeze tag, no push, no publication, no reviewer outreach, no deployment, no public-chain writes, no spending, no production credentials, no mainnet activation - unless separately and explicitly authorized by the Commander after this snapshot is approved.
- Funding: T < resolutionDeadline, already approved; this proposal requests no funds.

## 9. Precise approval requested next
"Approve the local immutable review snapshot defined by review/f3c-candidate/10-review-snapshot-manifest.json (SHA-256 920ddff847c96f6a97fadd326a19f3172c580b1d0074c3c279b7a82f7bb1abf0), candidate source 2e49625b..., package revision 7c26838b..., runtime pin 0x87615e3d..., for INDEPENDENT REVIEW ONLY - with no freeze, no tag, no push, no deployment, no public-chain write, no spending, and with Categories D/E and the verifier execution-witness limitation retained as open."

Decision: [ ] APPROVE snapshot for independent review    [ ] REQUEST CHANGES (state what)