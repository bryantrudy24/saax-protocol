# V4 verifier check map — repository inspection only

## 1. Scope, baseline and evidence

This document maps source read during this inspection. It is not a verifier implementation change, test execution report, independent audit, or production-readiness claim.

- Observed HEAD: `5a3ba7dd` (`Phase 3B: pin Safe and add isolated v4 lifecycle verifier`). The named checkpoint tag `phase3b-realsafe-checkpoint` resolves to `86f32cb71e8a82a993baa0fcb981851f5e477729`. HEAD is newer than that checkpoint; git reports eight commits ahead of origin/main. Existing modified runtime logs, access ledger, fixture script and untracked files are preserved.
- Successfully read: `verifier/verify-export.js`; `mainnet/design/agreement-signing-spec.md`; `mainnet/design/support/v4-canonical.js`; `mainnet/design/support/v4-signatures.js`; `verifier/verify-v4.js`; `verifier/v4-candidate-identity.json`; `contracts/SAAXEscrowCustodyV2.sol`; `mainnet/design/phase3b-v4-checkpoint.md`; `scripts/test-v4-checkpoint.cjs`.
- Filesystem root was established by successfully reading `ax-router/mainnet/design/support/v4-signatures.js`. Shell reads used the repository as cwd. Paths below are repository-relative.
- No Safe suite, verifier suite, chain transaction, deployment, installation or funding activation was run. Counts in the existing checkpoint document are historical reports, not newly demonstrated results.

## 2. Actual current dispatch and assurance labels

`verifier/verify-export.js::main` already dispatches **integer** `exp.formatVersion === 4` to `require('./verify-v4').cli(exp, rpcUrl)` and returns before the legacy check pipeline. Other supported versions are converted with `Number(...)`, accepted only in `[1,2,3]`, and handled by the original pipeline. Thus string `"4"` does not take the v4 branch. `SUPPORTED_FORMAT_VERSIONS` remains `[1,2,3]`; that constant is for the legacy pipeline, not a complete inventory of the entry point's support.

**V4 does not automatically inherit any checks gated by `version === 3`.** Nor does this separate branch automatically execute the shared legacy anchor, journal, evidence or cross-record functions. A separate module behind a common dispatcher is acceptable; every required obligation must be explicitly ported or independently implemented.

Current `verify-v4.js` exports `verifyV4`, `cli`, and `validateAgreement`. It returns:

| Path | Current label | Scope |
|---|---|---|
| Explicit `issue`, no lifecycle (anchor may be supplied) | `VERIFIED_ISSUANCE_ONLY` | Canonical agreement and two EOA consent signatures; if `exp.anchor` is present and RPC is supplied, the independent EAS anchor and both-party attester authority are checked and reported. No custody, settlement or finality assurance |
| Supported local lifecycle | `VERIFIED_WITH_LIMITATIONS` | Local synthetic lifecycle under repository-owned runtime identity and trusted RPC |
| Required historical/RPC references unavailable or runtime unsupported | `INCOMPLETE_UNSUPPORTED` in explicit branches | Never full verification |
| Contradiction or other caught error | `NOT VERIFIED` | Includes many RPC errors not specifically classified as incomplete |

The CLI gives exit 0 to the two limited success labels. Consumers must inspect the assurance label, not equate exit 0 with full-lifecycle VERIFIED. Issuance-only exports must never receive full-lifecycle assurance. Current v4 code does not emit unrestricted `VERIFIED`.

## 3. Legacy checks that v4 must account for explicitly

The table maps every legacy check family, not an instruction to reuse legacy weaknesses unchanged.

| Existing source/function | Existing obligation | V4 status / required adaptation |
|---|---|---|
| `checkFormatVersion`, `main` | Supported format, dispatch and result profile | Separate integer-v4 dispatch exists; require explicit profile and fail unsupported versions |
| `canonicManifest`, `rebuildEnvelope`, `recomputeDigest`, `checkDigest` | Version-specific manifest bytes and SHA-256 envelope digest | Use `v4-canonical` instead. Do not allow legacy `digestPreimage` bypass or placeholder fallback to authorize v4 |
| `agreementParty`, `checkAuthorizations` | Recover signer and bind to signed buyer/seller identity | V4 uses exactly one EOA `CommitmentConsent` per party with fixed typed data/domain; no export-supplied domain/types as trust root |
| `checkEvaluatorAuthorization` (v3 only) | Parties delegate evaluator identity/permitted decisions in signed digest | V4 full-manifest signatures cover these fields; separately establish actual evaluator mechanism/governance if claiming approved 2-of-3 |
| `schemaUid`, `referenceSchemaUid`, `schemaUidSelfTest` | Derive schema UID including resolver/revocability | Candidate reuse for EAS; entry-point self-test is not validation of a v4 export's anchor |
| `rpcCall`, `getAttestationData`, `decodeAttestation`, `decodeFirstTwoStrings`, `checkAnchor` | Chain, actual attestation, schema, UID, revocability, attester, commitment ID and digest | **Not called by v4.** Add ABI-aware anchor checking under independently configured trust roots and explicit record cross-binding |
| `checkTxChain` | Successful transaction to correct EAS emitter, matching Attested UID/schema/attester | **Not called by v4.** Match the specific event, including when a receipt has multiple attestations; avoid first-event-only selection |
| `checkJournal`, `JOURNAL_EVENT_TYPES` | Signed hash chain, event count/order/tail | **Not called by v4.** Define v4 journal schema/signatures and verify chain, sequence, identities and coverage |
| `JOURNAL_TRANSITION_AUTHORITY`, `EVALUATOR_TRANSITIONS` | Per-transition authority and digest-covered decision set, only when context.version===3 | **Not inherited.** Define v4 mutual/timeout authority separately; do not require an evaluator signature for an eligible timeout |
| `checkJournalEvaluator` | V3 evaluator distinct from EAS attester; older binding rules preserved | V4 must bind evaluator to agreement, attester to anchor, without conflating roles |
| `checkEscrowEvaluator` (v3 only) | Escrow evaluator matches signed agreement | V4 independently compares all 13 funding/getEscrow term slots, not just evaluator |
| `checkVerdict`, `contractActionFor`, `checkVerdictTimeWindow` | Scheme/domain, commitment/digest/reference, action, nonce, evaluator signature, execution window and custody recipient | V4 decodes actual successful action under allowlisted runtime. Reuse type concepts only; V1 domain, digest-derived ID assumption and dispute mapping cannot be copied blindly |
| `checkCrossRecordBindings`, `digestBytes32` | Anchor, journal and authorization refer to same digest | V4 binds consent/funding/settlement; anchor/journal are absent. V4 manifest commitment ID is separately signed bytes32, not necessarily digest bytes |
| `checkEscrow` | Terminal result and successful receipt | V4 has stricter successful receipt, contract, event, movement and historical terminal-state checks. Legacy nonterminal/no-RPC success branches must not become v4 full assurance |
| `checkEvidence` | Release cites evidence references | **Not implemented by v4.** V4 validates signed evidence requirements, not actual fulfillment/evidence satisfaction |
| `check`, `checkNA`, result branches | Distinguish failures, unexercised checks and profiles | Preserve explicit limitations/incomplete outcomes; current v4 accumulates passed check groups and catches first failure, not a comprehensive per-check report |

## 4. Current v4 implementation and additional checks

### 4.1 Canonical bytes, schema, policy and consent

Reuse `v4-canonical.js::{MANIFEST_FIELDS_V4,deepSortKeys,canonicalManifestV4,coseSign1Envelope}` and `v4-signatures.js::{agreementDomain,COMMITMENT_CONSENT_TYPES}`. `validateAgreement` adds stricter candidate restrictions on top of `validateV4Manifest`.

Implemented in source:
- Nineteen selected manifest fields; recursive sorting includes top-level keys; arrays preserve order. Envelope SHA-256 is compared with `exp.commitmentDigest`. Explicit 65-byte envelope signature-container bytes are required; those bytes are not themselves proof of party consent.
- Fixed agreement domain `SAAX Commitment V4` / `4`, signed custody address/chain, full envelope hash, role, consent nonce and expiry. Exactly two EOA authorizations, one buyer and one seller; signatures recover to the signed address-valued party fields. Expiry is compared with funding timestamp for full lifecycles.
- Restricted `OBJECTIVE_DIGITAL`, known terms versions, supported custody policy version, exact string principal/fees/reserve, positive principal matching price, zero fees/reserve, explicit consent refs/timeout effect, fallback rule, policy/profile document references, evaluator permitted set, parsed deadline mapping and signed minReleaseTime/policyId.

Missing or limited:
- `canonicalManifestV4` selects known fields and silently excludes unknown top-level fields. `validateV4Manifest` is not a recursively closed schema. It accepts some values through `String(...)` coercion; v4 verifier tightens money strings but not every field. Duplicate JSON keys have already been discarded by `JSON.parse`. Unsupported JS values are not comprehensively rejected by the helper. Strict input parsing/closed outcome-affecting schemas remain necessary.
- `signatureHex` is an envelope auxiliary field, not selected manifest content; its effect is via the reconstructed envelope. Specify its allowed representation explicitly rather than imply ES256 validation.
- Policy document digests are shape/binding checks, not recomputation against approved document bytes. Profile document version is truthy, not compared to a pinned supported version. No semantic resolution of all policy/evidence/attachment references.
- `terms.highValueAssurance` is not explicitly rejected as an activation layer by `validateAgreement`; restrict unsupported combinations rather than treating digest coverage as implementation support.
- Currency/decimals are not tied to an independently approved token identity. Nonzero and distinct role rules need a precise closed schema; an address-shaped buyerAgentId is the candidate convention, not a general agent-identity resolver.
- Contract-wallet party consent is explicitly unsupported. Agreement authorization expiration at a defined issuance moment and party key/contract classification need further specification if issuance assurance expands.

### 4.2 Custody, domains and monetary outcome

Reuse `verify-v4.js::verifyV4` and its nested `transaction`/`events` helpers; `v4-candidate-identity.json` supplies repository-owned ABI/runtime identity. The funding argument/getEscrow mapping is:

`commitmentId, digest32, token, buyer, seller, evaluator, principal, resolutionSeconds, finalCutoffSeconds, minReleaseTime, policyId, policyDigest, digest32-as-agreementRef`.

The implementation reads actual funding and settlement calldata, checks canonical block/receipt/transaction ordering and success, direct target custody and exact historical runtime hash, then reads `getEscrow` at settlement block. It checks matching Funded/Released/Refunded events and matching token Transfer logs. `getEscrow` state index 13 must be Released(3) or Refunded(4) according to decoded outcome.

**Custody signing domain cannot be inferred solely from formatVersion.** The actual V2 source declares `SAAX Escrow Custody V2` / `2`; legacy V1 verifier uses `SAAX Escrow Custody V1` / `1`. `v4-signatures.js` defines both agreement and custody domain helpers/types. The v4 execution-witness verifier relies on a repository-owned exact runtime identity for domain/signature enforcement, not an arbitrary export assertion. Any additional custody must have a separately justified identity/domain/ABI policy.

Further requirements before expanding assurance:
- Verify approved asset implementation and exact economic movements, not arbitrary token log authenticity; current Transfer checks use `some`, not independent balance-delta/accounting proof. Full Funded event tuple, verdictHash, Resolved/MutualResolution events, nonce transitions, and terminal timestamps are not all cross-checked explicitly.
- Funding state values match party-signed terms **in the export verifier**, but `SAAXEscrowCustodyV2::fund` does not consume/check buyer/seller agreement signatures or recompute agreementRef from commitmentDigest. It checks admitted policy ID/digest and nonzero references, accepts arbitrary nonzero token, and requires cutoff future but not deadline future. Do not claim on-chain pre-funding consent enforcement from retrospective verifier comparisons.
- No operational admission/cap governance or evidence-registration assurance is established by a lifecycle export. No mainnet activation follows from successful local verification.

### 4.3 Resolution/action rules

Current decoded paths: `release`, evaluator `refund`, zero-signature timeout `refund`, `resolve` release/refund, `mutualRelease`, `mutualRefund`. Zero legacy signature components plus empty bytes identify timeout; successful runtime execution authenticates the actual branch. Evaluator decisions must be within the signed set. Timeout executes at/after cutoff; evaluator/mutual execute before cutoff and no later than signed resolution deadline. issuedAt is checked against execution timestamp's contract window. Normal release checks minReleaseTime.

Important mismatch: source contract gates evaluator/mutual by cutoff, not resolution deadline; verifier adds the signed resolution bound. `resolve:release` and mutual release do not enforce minReleaseTime like normal `release`. These are design/assurance alignment questions, not silently uniform rules. `resolve('hold')` exists in contract but is unsupported as terminal verification. Deadline/authority requirements must be specified for every path. Reconstruct prior disputes and consequential history if the export claims them; current witness verifies terminal path, not a complete journal of all intervening actions.

### 4.4 Evidence, EAS and finality

After the independent EAS anchor implementation (see Anchored v4 state below), `verify-v4.js` DOES read `exp.anchor` when supplied: it verifies the official local EAS attestation, exact anchor bytes bound to the canonical signed v4 agreement, and both-party attester authority, and reports it in the result. It still does NOT read journal, evidence content, external fulfillment attestations or pinned-policy evaluation results. A separate-process lifecycle result therefore does not certify journal integrity, evidence sufficiency, independent adjudication, or an approved policy document. Existing `checkAnchor`/`checkTxChain` are legacy implementation references, not the executed v4 anchor path.

Only `exp.finality.mode === 'local-synthetic'` is accepted. No public-chain finality evidence is verified; the flag is an explicit limitation, not a finality proof. Public support requires chain-specific finality rules, canonical inclusion references, reorg handling and explicit unavailable-evidence outcomes. Confirmation depth alone must not be called verified L2 finality.

## 5. Historical ERC-1271 evidence requirements

Current Safe state is insufficient. End-of-execution-block Safe state may also differ from the state when the transaction executed. A current owner list/threshold or an unbound exported snapshot cannot establish historical validity.

Current bounded method (`verify-v4.js::transaction` and action parsing; checkpoint document):
1. Obtain transaction, successful receipt, canonical block hash and transaction index from public RPC. Cross-check receipt/transaction/block inclusion and ordering.
2. Decode a direct call to the exact custody address under repository-owned ABI and exact historical allowlisted runtime hash.
3. Establish by review of that immutable runtime that the successful selected path necessarily calls `_checkVerdict` -> `_isValidSignature` against the signed evaluator in actual execution state (or validates both mutual EOA signatures / timeout branch). No upgrade, delegatecall or selfdestruct path is present in the read source.
4. Bind actual funding terms, terminal escrow state, recipient, receipt events and token movement. Preserve tx hash, block hash/order, public calldata obtainable by hash, runtime identity/compiler provenance and signed agreement/consents. Do not export private keys, raw signed transactions or unrelated records.

This trusts RPC execution facts; it is not independent consensus verification, execution replay or a receipt-trie proof. It proves successful evaluator authorization under the exact runtime, **not that an arbitrary evaluator contract was an approved 2-of-3 Safe**. Independent Safe provenance requires pinned singleton/proxy/handler identities, message encoding, execution-point owners/threshold and modules/guard/handler governance. Threshold redundancy does not prove adjudicator independence.

For unknown/upgradeable custody or stronger Safe-governance attribution, require a verified transaction-position replay/trace or equivalent execution witness rooted in historical state. An exported caller-provided trace is not intrinsically trustworthy. Archive state availability is separate from trace availability. Missing required code/state/transaction witness must remain INCOMPLETE_UNSUPPORTED; absent receipts/scans do not prove non-broadcast or authorize retry.

`scripts/test-v4-checkpoint.cjs` contains a local same-block release -> Safe threshold change -> stale release scenario and a child verifier with read-only RPC/environment allowlist. Its source also compares legacy fixture outputs against checkpoint verifier code using an RPC without historical EAS. These are observed test definitions, not new executed results in this run; offline equality is not a new live positive historical-verification demonstration.

## 6. Exact reuse/change map and blockers

| Module | Reuse / smallest future change |
|---|---|
| `verifier/verify-export.js::main` | Retain common dispatch and frozen legacy branches; clarify supported-version comments if later authorized |
| `verifier/verify-v4.js::{validateAgreement,verifyV4,cli}` | Extend explicit obligations/assurance reporting; do not report omitted checks as PASS |
| `mainnet/design/support/v4-canonical.js` | Shared byte algorithm; add separately versioned/compatible strict validation rather than silently change historical bytes |
| `mainnet/design/support/v4-signatures.js` | Fixed agreement/verdict/mutual types and domains; contract-wallet party support requires new justified path |
| `verifier/v4-candidate-identity.json` | Repository-controlled identity policy; never trust identity supplied by export |
| Legacy anchor/journal/evidence helpers in `verify-export.js` | Extract side-effect-free utilities or implement equivalent checks in separate module; file currently calls main unconditionally, so importing it as a library is not a safe reuse seam |
| `contracts/SAAXEscrowCustodyV2.sol::{fund,_checkVerdict,_isValidSignature,_checkMutual,release,refund,resolve,_mutual,getEscrow}` | Ground semantics/runtime witness; no change authorized by this inspection |
| `scripts/test-v4-checkpoint.cjs` | Add targeted negative cases for newly specified obligations later, preserving old fixture/evidence files |
| `agreement-signing-spec.md` | Its candidate clarification supersedes old domain/order/support claims, but earlier contradictory passages remain. Reconcile in a later authorized documentation change |

Blocking inputs/decisions: exact v4 export schema for EAS/journal/evidence/finality; policy/document trust-root approval; asset identity and decimals policy; strict unknown-field/duplicate-key treatment; resolution/min-release consistency across all exits; on-chain funding-consent enforcement design; supported Safe governance/execution-context assurance; public-chain finality/RPC capability requirements; unsupported advanced profiles/party wallets/fees/reserves; independent review and economic/operational activation inputs.

## 7. Smallest next implementation step

Do not start a new verifier from scratch: an isolated candidate already exists. The smallest bounded extension is to specify the v4 anchor record and digest/commitment mapping, then extract or implement side-effect-free EAS attestation/receipt checks for `verify-v4.js`, with one positive and one cross-commitment substitution test in a separate-process local fixture. Keep issuance-only and local-lifecycle labels limited; keep missing anchor/evidence/finality obligations explicit. Do not modify legacy signing behavior or enable admission.

Inspection deliverable only. No verifier modified; no Safe tests rerun; no push, deployment, spending, secrets loading or mainnet activation.
---

## Anchored v4 state (after independent EAS anchor implementation)

Supersedes the inspection-era statements in section 4.4 and the ledger rows above
that described `exp.anchor` as unread by v4. This section reflects the source as
implemented in the working tree (uncommitted at time of writing, prior to the local
EAS-anchor commit): `verifier/v4-anchor.js`, `verifier/v4-eas-policy.json`,
`verifier/verify-v4.js` (anchor integration), `scripts/test-v4-anchor.cjs`,
`evidence/v4-anchor/*`.

### Anchor record schema and field sources (as implemented)

`exp.anchor` is a repository-defined record. Required fields, each checked for
presence before any other anchor work:

| Field | Source / check |
|---|---|
| `recordVersion` | must equal `1`; unsupported versions rejected |
| `chainId` | must equal the signed agreement custody chainId AND the policy chainId (84532 local) |
| `easAddress` / `registryAddress` | must equal the repository policy deployment (see below) |
| `schemaUid` | must equal the repository-computed schema UID for the fixed anchor schema |
| `uid` | EAS attestation UID, 32-byte hex; must match the emitted `Attested` event and `getAttestation` record |
| `txHash` / `blockHash` / `blockNumber` | canonical references; receipt, tx, block must agree on hash, block number, transaction index and position |
| `attester` / `recipient` | EOA address checks; attester must be the direct tx `from` |
| `attestationData` | ABI-encoded tuple; must decode canonically and re-encode to the exact same bytes |
| `authorizations` | exactly two typed-data signatures (buyer + seller) over the anchor domain and message |

The anchored data tuple (13 strings + uint64) is:

`string commitmentId, string commitmentDigest, string parties, string requestedOutcome, string providerObligation, string commercialTerms, string paymentTerms, string acceptanceCriteria, string deadline, string failureConditions, string recoveryPolicy, string refundsCompensation, string lifecycleState, uint64 anchoredAt`

Field sources: `commitmentId` and `commitmentDigest` are taken from the canonical
signed v4 agreement (`m.commitmentId` and the manifest digest). The remaining
descriptive strings have NO invented v4 mapping: they are party-authorized bytes
only, not independently verified truth or fulfillment claims. `anchoredAt` must be
<= the attestation time. The verifier deliberately does not parse descriptive
fields into semantics.

### Supported EAS deployment and schema policy

- Deployment policy (repository trust root): `local-official-eas-1.7.1-v1`,
  pinned in `verifier/v4-eas-policy.json` with chainId 84532 (local Hardhat, NOT
  public Base Sepolia), EAS address, registry address, and runtime code hashes
  keccak256 of `easAddress` and `registryAddress` code at anchor block and current
  block. The registry must be the EAS schema registry and the schema must be
  registered non-revocable, resolverless, exactly matching the fixed schema string.
- The anchor schema is fixed and non-revocable; expiration, revocation, reference
  (refUID), and revocable flags are all rejected.
- **Public deployment status: RESOLVED-PENDING-IMPLEMENTATION.** Chain declarations
  are unified on Base Sepolia 84532 (chain ID 84532, RPC https://sepolia.base.org)
  for the hosted pilot; the local EVM uses its own distinct chain ID (31337). The
  verifier legacy hardcode (verify-export.js:526,737 — verdict-domain chainId) is
  named as a remaining cleanup item, not fixed here. Local-only EAS anchor
  assurance is what this implementation provides.

### Checks implemented, with test names and evidence

All executed in `scripts/test-v4-anchor.cjs` (local-only, official EAS package
1.7.1 artifacts, no app DB, no secrets, read-only RPC allowlist; results in
`evidence/v4-anchor/results.json`; full run transcript `run.txt`; separate-process
CLI export `separate-process.txt`). 38 checks, 0 failed.

Positive control (real contract): `REAL CONTRACT: official EAS issuance anchor
positive` and `REAL CONTRACT: full lifecycle with independent anchor`, plus
`separate-process CLI full export positive; no app DB/environment` (exit 0) and
`child RPC read-only methods only`.

Negative cases, each asserting its specific rejection reason (not a generic
non-VERIFIED):

| Test | Expected rejection surfaced |
|---|---|
| `wrong UID` | NOT VERIFIED: matching EAS event required |
| `wrong schema` | INCOMPLETE_UNSUPPORTED: unsupported anchor schema |
| `wrong digest data` | NOT VERIFIED: commitment/digest binding mismatch |
| `REAL CONTRACT: anchor from another commitment` | NOT VERIFIED: commitment/digest binding mismatch |
| `wrong attester` | NOT VERIFIED: direct EAS attester/target mismatch |
| `wrong chain` | NOT VERIFIED: signed agreement chain mismatch |
| `unapproved EAS deployment` | INCOMPLETE_UNSUPPORTED: unsupported EAS deployment |
| `missing anchor data` | INCOMPLETE_UNSUPPORTED: anchor missing attestationData |
| `modified descriptive data despite matching id/digest` | NOT VERIFIED: attest calldata/policy mismatch |
| `missing party attester authority` | NOT VERIFIED: two anchor authority signatures required |
| `forged party attester authority` | NOT VERIFIED: unauthenticated buyer anchor authority |
| `expired authority at creation` | NOT VERIFIED: anchor authority expired at issuance |
| `wrong block reference` | NOT VERIFIED: noncanonical references |
| `wrong recipient` | NOT VERIFIED: attest calldata/policy mismatch |
| `authority domain substitution` | NOT VERIFIED: unauthenticated buyer anchor authority |
| `REAL CONTRACT: expiration disallowed by immutable anchor policy` | NOT VERIFIED: attest calldata/policy mismatch |
| `REAL CONTRACT: immutable schema cannot be revoked` | (rejection by contract itself) |
| `MOCK RPC: reverted receipt rejected` | NOT VERIFIED: transaction reverted |
| `MOCK RPC: missing/mismatched Attested event` | NOT VERIFIED: matching EAS event required |
| `MOCK RPC: wrong event emitter` | NOT VERIFIED: matching EAS event required |
| `MOCK RPC: unavailable RPC capability incomplete` | INCOMPLETE_UNSUPPORTED (RPC capability missing) |
| `MOCK RPC: missing receipt incomplete` | INCOMPLETE_UNSUPPORTED: anchor transaction/receipt unavailable |
| `MOCK RPC: missing attestation incomplete` | INCOMPLETE_UNSUPPORTED: attestation record unavailable |
| `MOCK RPC: revocationTime / revocable / expirationTime / refUID invariant rejected` | NOT VERIFIED: immutable nonexpiring unreferenced schema policy required |
| `full lifecycle missing anchor incomplete` | INCOMPLETE_UNSUPPORTED: anchor record required |

The two most important negatives are paired with the positive control in the same
run (`REAL CONTRACT: anchor from another commitment` and `wrong digest data` run
beside `REAL CONTRACT: official EAS issuance anchor positive`), so a blanket
rejector cannot pass while also rejecting valid anchors.

Regression (shared-dispatcher guard): `verify-export.js` dispatch,
`v4-canonical.js`, and `v4-signatures.js` are unchanged by this work (git-clean;
only `verify-v4.js` changed). The historical v1/v2/v3 fixture outputs are
re-verified by the same run against the baseline verifier:
`legacy exact output/exit: baseline-verified-commitment.json`,
`baseline-v2-verified-commitment.json`, `baseline-v3-verified-commitment.json`,
`v3-battery/fixture-full-lifecycle.json` — all baseline=1, current=1, exact text
match (see `evidence/v4-anchor/legacy-*.txt`). Verdicts and assurance-limit lines
unchanged. The Safe suite and broad protocol battery were NOT rerun.

### Assurance gained

- **Anchor binding**: the EAS attestation (uid, schema, attester, recipient,
  exact data bytes) is verified against the official local EAS contract at the
  anchor block and current block, canonical tx/receipt/block references, emitted
  `Attested` event, and `getAttestation` record.
- **Attester authority**: both parties signed typed-data authorizations over the
  exact anchor bytes (manifest digest, commitmentId, schema, attester, recipient,
  dataHash, expiry) in a fixed anchor domain; recovered signers must equal the
  signed agreement buyer/seller identities. This is both-party authorization of
  the anchor content and attester, not evaluator inference.
- Anchor immutability (nonexpiring, non-revocable, unreferenced schema) is
  enforced by both the schema policy and the actual contract state.

### Assurance NOT gained (explicit gaps; must not be described as covered)

- **Journal verification**: absent from v4. No hash-chain/event sequence check.
- **Fulfillment-evidence validation**: absent. Signed evidence requirements are
  validated, not actual fulfillment or evidence content.
- **Public-chain finality**: absent. Only `local-synthetic` finality mode is
  accepted; no Base L1 finality proof.
- **Approved 2-of-3 Safe governance**: absent. Successful ERC-1271 execution
  does not establish that the authorized evaluator was an approved 2-of-3 Safe.

### Bounded ERC-1271 witness qualifications (preserved unchanged)

The historical ERC-1271 method and its qualifications are unchanged: canonical
execution witness through the allowlisted immutable custody runtime; proves
successful evaluator authorization under that exact runtime, not that the
evaluator was an approved 2-of-3 Safe; trusted RPC, no consensus/receipt-trie
proof, no replay; runtime has no upgrade/delegatecall/selfdestruct path so
end-of-block identity does not hide an intra-block switch. Contract-wallet party
consent remains unsupported. No new Safe claim is introduced by the anchor work.

### Deployment blocker

Public deployment of this verifier (or mainnet activation) is RESOLVED-PENDING-
IMPLEMENTATION: declarations are unified on Base Sepolia 84532 for the pilot; the
local EVM uses its own distinct ID (31337). The verifier legacy hardcode
(verify-export.js:526,737) is a named remaining cleanup item, not fixed here.
No push, deployment, public-chain write, spending, outreach, production secrets,
website change, or mainnet activation was performed.
## Journal record inventory (step 1 — inspection finding, HEAD 407aba50)

**Date:** this run. **Verdict: stop — no v4 journal record exists; schema gap
surfaced, not papered over.**

### What fields exist in v4 exports today

Top-level keys of every v4 export (`evidence/phase3b-v4/synthetic-lifecycle.json`,
`synthetic-mutual.json`, `synthetic-timeout.json`, `evidence/v4-anchor/positive-export.json`):

```
formatVersion, agreement, commitmentDigest, authorizations,
lifecycleProfile, lifecycle { funding, settlement }, finality
```

No `journal` key anywhere — top level, nested in `lifecycle`, or any other
position. The producer `scripts/test-v4-checkpoint.cjs` writes these exports
without a journal record. There is no other v4 export producer in the
repository (endpoint/emits no journal, build-export.js is the v1/v2/v3 path).

### What the signed v4 representation commits to

Per `mainnet/design/agreement-signing-spec.md` (canonical field list + §5
binding table), the v4 digest covers: policy id/version/digest + profiles doc,
profile, custody (chain, address, token, principal, fees, reserve),
consents (buyer, seller, seller timeout), evidenceRequirements,
deadlines (delivery/resolution/finalCutoff), fallbackDisposition, parties,
evaluator + evaluatorPermittedDecisions, price/amount, commitment/capability/
acceptance. The signed representation does NOT commit to any journal field —
the v4 manifest schema has no journal shape at all.

### What v3's journal check does that v4 does not

v3 (`verifier/verify-export.js` `checkJournal` + `checkJournalEvaluator`,
lines 485-610, gated `context.version === 3`):

1. **Sequence integrity** — `prevHash` chain from `root`, recomputed
   `entryHash = sha256(JSON.stringify({state, transition, at, by, prevHash}))`,
   declared `eventCount` exact (missing/injected history), monotonic `at`,
   declared `tailHash` === last entry hash.
2. **Event signature** — every event has `sig {r,s,v}` recovered over
   `JournalEvent` EIP-712 message (domain `SAAX Commitment Journal` v1), and the
   recovered signer must equal the declared `by`.
3. **Transition authority (v3-only)** — `JOURNAL_TRANSITION_AUTHORITY`: issue→buyer,
   anchor-confirmed→attester, release/refund/extend_deadline/dispute→evaluator,
   fulfill→seller. Recovered signer must satisfy the role for the transition;
   evaluator events must ALSO be within digest-covered
   `evaluatorPermittedDecisions` (`EVALUATOR_TRANSITIONS` set).
4. **Agreement binding (v3-only)** — `checkJournalEvaluator`: declared
   `journal.evaluator` must equal the agreement's digest-covered `evaluator`
   (NOT the anchor attester; roles kept distinct).

v4 does none of these: `verify-v4.js` never reads a journal, `verify-export.js`
gates journal/authority checks to `context.version === 3`, and the v4 dispatcher
returns before the legacy chain.

### Reuse assessment

- `checkJournal` core (prevHash/entryHash/eventCount/tailHash/at-ordering) is
  format-independent and **reusable in principle** (extract or mirror in a
  v4-journal module); must be imported from the shared helpers or reimplemented
  without touching the legacy file.
- `JOURNAL_TRANSITION_AUTHORITY` / `EVALUATOR_TRANSITIONS` mappings are **v3
  semantics**: they reuse v3 transition names. For v4 they must be re-derived to
  v4's actual transitions (v4 custody has release/refund/resolve/mutualRelease/
  mutualRefund/timeout, no extend_deadline, no dispute-resolution names) — do
  not copy blindly.
- Signature domain: v3 uses `SAAX Commitment Journal` v1 with a synthetic
  default `verifyingContract`; v4 must define its own versioned journal domain,
  NOT infer it.
- **There is currently nothing to verify**: no v4 producer emits a journal, no
  v4 export carries one. Implementing the check against an invented record
  shape would verify it against itself — prohibited by this task brief.

### Schema gap (the finding)

The v4 export schema and the v4 producer lack a journal record. Closing this
gap requires, in order: (1) define the v4 journal schema (hash chain or event
sequence — production decision), (2) make the producer emit journal events for
v4 lifecycle exports, (3) then implement + test the v4 journal check against
real produced records. Step 3 is blocked on steps 1-2. This run stops at the
finding per the brief; no record shape was invented.### Phase A corrections (HEAD bf77972e + this run)

The schema gap is closed for NEW journal-bearing outputs. The journal record
now EXISTS in the v4 export schema and is produced by the dedicated local
producer. State as of this run:

- **Journal record shape (implemented):** hash chain only. Each entry carries
  `commitmentId, manifestHash, transition, role, by, contractAction,
  resultingState, at, observed, prevHash, evidenceDigest, entryHash, eventId,
  sigs[], signedBy` (+ observed: `recoveredSigner, submitter, txHash,
  blockHash`; + `authorization` for evaluator/timeout authority evidence).
  Signed under the v4 journal domain `SAAX Commitment Journal` / "4",
  chainId = the agreement's custody chain, verifyingContract = the agreement's
  custody address (never inferred from formatVersion; NOT v3's domain).
- **EVIDENCE BINDING (correction):** outcome-relevant references — chain/
  custody, txHash, blockHash, authorization, submitter — are bound through a
  canonical `evidenceDigest` that is part of BOTH the entry hash and the
  EIP-712 signature. Sigs are never part of their own signed hash. Unsigned
  `recoveredSigner`/`signedBy`/`authorization` metadata is never authoritative:
  it is bound via evidenceDigest and cross-checked by recovery on read.
  Substitution tests prove txHash/authorization tampering breaks the binding.
- **INTENT vs CONFIRMED (correction):** `acceptOperation` records ACCEPTED
  INTENT (`transition: 'intent'`, `resultingState: 'Accepted'`), NOT confirmed
  funding/release/refund. Intent entries cannot satisfy a confirmed lifecycle
  transition (`CONFIRMED_TRANSITIONS` excludes `intent`; `journalGap` ignores
  intent entries and reports the missing confirmed transition).
- **DISPUTE ROLES (correction):** contract V1/V2 `raiseDispute` allows BUYER
  OR SELLER; the writer accepts `dispute` with role `buyer` or `seller` (no
  buyer-only assumption).
- **RELAYED ACTIONS (correction):** observed entries record `by` = the
  AUTHORIZING party (recovered from the on-chain action / transition
  authority) and `submitter` = tx.from (possibly a relayer) as separate
  fields. Sender != authorizer is supported and tested.
- **RETRY PRECISION (correction):** stable `eventId` (commitment+transition+
  role+by+action+state+txHash) makes identical retries and repeated
  observations deterministically rejected (DUPLICATE_EVENT) at the writer;
  atomic persistence (tmp+rename) + restart-safe restore (chain + eventId
  dedup set rebuilt from content). Ledger layer additionally returns
  idempotent/duplicate for identical retries and same-op-different-nonce.
- **CHAIN IDENTITY (correction):** new local journal tests and outputs run on
  chain **31337** (local EVM) with 31337 manifests and signature domains.
  Historical 84532 fixtures (synthetic-*.json, results.json,
  separate-process.txt, v4-anchor/*) are preserved byte-identical and are NOT
  presented as current local-chain evidence. The `SAAX_LOCAL_CHAIN_ID=84532`
  escape hatch was removed; hardhat.config.js always runs the local EVM at
  31337. v4-canonical accepts 31337 for local-test context only; the public
  chain-guard (84532 Base Sepolia) and admission policy are unchanged.

### Pre-existing producer/verifier drift (recorded, NOT fixed this run)

The producer `scripts/test-v4-checkpoint.cjs` at HEAD cannot reproduce its own
committed evidence: `verify-v4.js` (since 407aba50) unconditionally requires an
`exp.anchor` in the full-lifecycle path (`v4-anchor.js:25` "anchor record
required"), but the producer never emits an anchor. Re-running the producer at
HEAD fails `separate process verifies pre-governance lifecycle...` and the
anchor-dependent checks. The committed `separate-process.txt`/`results.json`
predate the anchor requirement. This drift is OUT OF SCOPE for the Phase A
corrections (anchor verification is a separate verifier concern; the journal
corrections do not depend on it). It must be resolved before the producer's
separate-process battery can be re-run green — a verifier/producer alignment
task, not a journal task.

### Journal verification (Phase B): IMPLEMENTED and tested

`verifier/v4-journal.js` (new, behind the common dispatcher; `verify-v4.js`
calls `journalVerifier.verifyJournal` in both the issuance and lifecycle
branches). Independent checks: strict schema; agreement-bound signing domain
(chain/custody/name/version, NEVER derived from formatVersion); authenticated
association (commitmentId + manifestHash); hash chain, predecessor links,
evidenceDigest recomputation and stable event identities; signature recovery
to role identities with the v4 transition authority map; observed-vs-
initiated (observer signature authenticates the observation, never the action
authority; relayer/submitter distinct from authorizing party); intent vs
confirmed (bounded lifecycle coverage — intent never satisfies a confirmed
transition); on-chain reference cross-check; terminal consistency with the
independently checked custody execution. Missing/unavailable required
evidence raises `JournalIncomplete` → INCOMPLETE/UNSUPPORTED, never a pass.

**Lifecycle-ref fallback (implemented + explicitly reported):** legacy
entries that do not store their transaction/block references bind the
independently verified lifecycle references (funding/settlement) for the
evidence digest. The result carries `legacyFallbackUsed: true` and a note
stating the fallback anchors the submitted history relative to the verified
references and does NOT independently prove the missing references or
completeness. Ambiguous/absent ref classes and conflicting explicit-vs-
verified refs are rejected with specific reasons (INCOMPLETE for a missing
class, evidenceDigest mismatch for a conflicting/tampered reference); an
explicit-but-invalid journal reference is never silently replaced by the
fallback.

**Tests:** `scripts/test-v4-journal-verify.cjs` 37/37 PASS (positives:
writer-produced lifecycle, seller-dispute, relayer!=authorizer, mutual
terminal; negatives: reordered/removed/duplicated/broken-link, tampered
manifest/domain/custody/evidenceDigest/tx/block/authorization, wrong role,
observer-substituted-for-authority, intent-substituted-for-confirmed,
impossible transition, terminal mismatch, missing journal, unknown version,
and the full fallback class). Walk suite 87/87, v4 spec suite 27/27, closure
producer 18/18.

**Assurance gained:** authenticated association + tamper evidence relative to
the binding/checkpoint + bounded lifecycle coverage (issue/funded/
settlement). **NOT established (unchanged):** completeness of off-chain
history, absence of an alternative authorized history, truth/sufficiency of
fulfillment evidence, approved 2-of-3 Safe governance, public-chain finality.
Issuance-only exports without a journal remain `VERIFIED_ISSUANCE_ONLY` with
an explicit no-assurance note; the journal verification is NOT a full-lifecycle
VERIFIED claim.

**Historical-export finding:** the pre-fix Phase A exports
(`evidence/phase3b-v4/journal-*.json`) carry evidenceDigests computed under
an OLDER writer canonicalization and FAIL verification under the current
scheme (evidenceDigest mismatch) — they are preserved byte-identical as
historical artifacts and are NOT claimable as verified. The current valid
evidence is the self-contained export from the closure producer
(`evidence/phase3b-v4-closure/lifecycle-anchored-journal.json`), whose
entries store their own tx/block references (no fallback used).

## Closure: reproducible local v4 producer with genuine EAS anchor + journal (after this run)

### The drift, precisely reproduced
- The checkpoint producer (`scripts/test-v4-checkpoint.cjs`) NEVER emitted an
  `anchor` record, while `verifier/verify-v4.js` (lifecycle path) calls
  `anchorVerifier.verifyAnchor(...)` unconditionally. Reproduction on the
  committed baseline:
  - `evidence/phase3b-v4/synthetic-lifecycle.json` (84532, no anchor) →
    `INCOMPLETE_UNSUPPORTED: transaction/receipt unavailable` (local txs
    absent from the public RPC).
  - `evidence/phase3b-v4/journal-lifecycle.json` (31337, no anchor) →
    `NOT VERIFIED: unsupported candidate chain` (identity pinned 84532).
- Historical anchor evidence (`evidence/v4-anchor/*`, 38/38 at the anchor
  commit) was produced by a DIFFERENT path: `scripts/test-v4-anchor.cjs`
  deploys official EAS 1.7.1 and emits anchors; the checkpoint producer never
  reused it. This run consolidates both paths.

### The fix (this run)
- `scripts/test-v4-producer-closure.cjs` — one reproducible local producer:
  boots the LOCAL EVM chain 31337 (never 84532), deploys official EAS 1.7.1 +
  SchemaRegistry + MockUSDC + SAAXEscrowCustodyV2 + Safe 1.4.1, registers the
  anchor schema, attests a REAL anchor with both-party attester authority,
  funds + releases the escrow, writes the Phase A journal, and emits ONE full
  export carrying BOTH `anchor` and `journal`:
  `evidence/phase3b-v4-closure/lifecycle-anchored-journal.json`.
- `verifier/v4-eas-policy.json` — now `{ default, policies }` with the 84532
  entry byte-identical (historical evidence era) and an EXPLICITLY
  LOCAL-TEST-ONLY `31337` entry (official 1.7.1, fresh local deploy, runtime
  hashes pinned). Public chains have no entry and remain unsupported.
- `verifier/v4-candidate-identity-31337.json` — local-test-only custody
  identity (runtime-hash pinned). `verify-v4.js` selects identity by the
  export's declared chain; NO trust-any-deployment flag; any chain without a
  pinned profile is rejected unsupported.
- `verifier/v4-anchor.js` — chain-scoped policy selection; identity checks
  (schema UID, runtime hashes, registry wiring, immutability) apply exactly
  for every supported chain.

### Separate-process verification result (evidence/phase3b-v4-closure/)
```
VERDICT: VERIFIED_WITH_LIMITATIONS
assurance: local synthetic full lifecycle with independently bound EAS anchor
anchor.policy: local-official-eas-1.7.1-v1-31337
historicalMethod: canonical successful execution of allowlisted immutable
                  direct-call custody runtime
```
- Anchor checks GENUINELY PASS (independent EAS anchor, exact data, both-party
  attester authority) on the local 31337 EVM.
- Journal verification remains UNIMPLEMENTED (Phase B) — explicit limitation:
  "Journal, external evidence content/sufficiency, ... are not certified."
- Fulfillment/finality/governance limitations stay explicit (no public-chain
  finality; ERC-1271 success does not establish approved 2-of-3 Safe
  governance; no production bytecode equivalence claim).
- NO full-lifecycle VERIFIED claim: the verdict is
  VERIFIED_WITH_LIMITATIONS, never plain VERIFIED.
- Negative controls: anchor UID substitution → NOT VERIFIED (specific anchor
  reason); digest substitution (re-signed changed amount) → NOT VERIFIED
  (funding binding mismatch). Issue-only positive control →
  VERIFIED_ISSUANCE_ONLY. Run record: `run-record.json` (command, revision,
  chain 31337, EAS 1.7.1, Safe 1.4.1, ethers 6, solc 0.8.26, no public
  finality).

### Focused fresh-local regressions (this run)
- `scripts/test-binding-fresh-local.cjs` — module-level authorization binding
  on a FRESH local 31337 funded escrow: 9/9 (valid control; buyer/asset/
  amount/digest mismatch rejected with specific reasons; signer==configured
  buyer; seller-as-buyer rejected; wrong-role rejected). NOTE: the access-auth
  chain guard is deliberately Base-Sepolia-bound (84532) — that is the public
  tested control; the local EVM supplies custody/escrow only.
- `scripts/test-recovery-fresh-local.cjs` — module-level recovery/restart on a
  FRESH local ledger: 6/6 (durable acceptance survives restart; identical
  retry idempotent with recorded result; changed-payload-same-nonce conflict;
  same-op-new-nonce duplicate; reconcile idempotent, no re-execution).
- `scripts/test-endpoint-journal-hook.cjs` 12/12 and
  `scripts/test-v4-journal-walk.cjs` 87/87 — unchanged and green.
- The committed `scripts/test-binding-mismatch.cjs` and
  `scripts/test-recovery-resume.cjs` reference STALE resolved Base Sepolia
  escrows; their server-integration cases remain EXPLICITLY UNVERIFIED (not
  declared passed). The fresh-local tests above cover the same essential
  assertions without the stale dependency.

### Assurance boundaries (unchanged where not demonstrated)
- Anchor: independently bound EAS anchor on the LOCAL EVM; exact bytes
  party-authorized; NOT proof of fulfillment, truthful evidence, or a security
  audit.
- Journal: producible + internally consistent (association + tamper evidence);
  completeness NOT claimed; VERIFIER (Phase B) UNIMPLEMENTED.
- Finality: local-synthetic only; no public-chain finality.
- Governance: successful ERC-1271 execution does not establish approved 2-of-3
  Safe governance.
- No public deployment; no mainnet activation; historical 84532 evidence
  byte-identical (git diff clean).---

### Phase C — fulfillment-evidence validation (evidence-path matrix + implementation)

#### Step-1 evidence-path matrix (signed requirement → produced evidence → verification rule → supported)

| Signed requirement (v4 manifest) | Produced evidence | Verification rule | Supported |
|---|---|---|---|
| `acceptanceCriteria` (type `hash-equals`, value = 32-byte digest) | Evidence item `payload` whose sha256 = the signed digest (seller produces the deliverable payload) | `v4-evidence.js`: at least one item's `payloadHash` equals the signed expected digest; criterion evaluation = satisfied / not satisfied / insufficient | **Supported** (only supported predicate; unknown predicates → INCOMPLETE) |
| `evidenceRequirements.sources` (e.g. `['synthetic']`) | Evidence record (`exp.evidence`) on lifecycle exports | Record must exist on lifecycle; absent → INCOMPLETE (`fulfillment evidence record required`) | **Supported** |
| `evidenceRequirements.minimumCount` | Item count per required type | Exact ≥ count; missing minimumCount rejected (no silent default) | **Supported** |
| `evidenceRequirements.requiredTypes` | Item `type` values | Each required type must have ≥ minimumCount items; wrong type → insufficient reason | **Supported** |
| `evidenceRequirements.maxAge` | Item `at` timestamps | No item older than maxAge at record time; future-dated rejected | **Supported** |
| `evidenceRequirements.acceptedIssuers` (allowlist) | Item `issuer` + genuine EIP-712 signature under the evidence domain | Signature recovers to issuer (authenticity); issuer in allowlist (authorization); omitted allowlist reported explicitly (neither universal trust nor empty set) | **Supported** (omitted → reported, reduced assurance) |
| `evidenceRequirements.verdictRequired` | (policy flag) | Evaluator decision consistency with `evaluatorPermittedDecisions` | **Supported** (consistency, not proof) |
| `deadlines.delivery` | Item `at` | No item after signed delivery deadline; boundary at/before accepted | **Supported** |
| Commitment binding (`commitmentId`, `manifestHash`, `criterionId`) | Evidence record fields | Must equal signed agreement; cross-commitment / wrong-criterion rejected | **Supported** |
| Uniqueness / replay | Item `itemId` | Duplicate itemId → rejected (no replayed evidence inflating count) | **Supported** |
| Subjective services / physical delivery / high-value | — | NOT auto-accepted; distinct rules required (unsupported) | **Unsupported** (explicit limitation) |
| Real-world truth of the assertion | — | NOT established by any signature or verdict (explicit limitation) | **Not claimed** |
| Arbitrary code / expressions in predicates | — | Only `hash-equals` predicate; unknown predicate → INCOMPLETE; payloads hashed opaquely, never executed | **Rejected** |

#### Claims kept distinct (per brief §3)
- **Evidence integrity/authenticity**: issuer signature valid, payload hash canonical, commitment/criterion binding, issuer in signed allowlist (when explicit).
- **Evidence sufficiency**: type, count, uniqueness (itemId), freshness (maxAge), deadline window — as signed.
- **Criterion evaluation**: `satisfied` (hash-equals matched), `not satisfied` (correctly signed but fails), `insufficient` (missing/unsupported) — separate findings.
- **Evaluator authorization**: verdict consistency with the signed decision policy; a valid signature does NOT prove a real-world assertion; an authorized verdict does NOT independently establish fulfillment; a verifiable settlement may accompany a refund.

#### Implementation
- `verifier/v4-evidence.js` — strict schema, agreement-bound evidence domain (`SAAX Commitment Evidence` / `4`, chainId = agreement custody chain, verifyingContract = agreement custody — never inferred from formatVersion), per-item authenticity + issuer authorization under the signed policy, sufficiency, bounded predicate evaluation, evaluator-policy consistency, distinct findings. EvidenceIncomplete for missing/unsupported (never a passed check).
- `mainnet/design/support/v4-signatures.js` — added `evidenceDomain`, `EVIDENCE_ITEM_TYPES` (EvidenceItemV4), `evidenceItemDigest`, `signEvidenceItem` (genuine EIP-712, fourth distinct domain).
- `verifier/verify-v4.js` — wired `evidenceVerifier.verifyEvidence` into the lifecycle path after journal verification (checks + limitations merged into the verdict). Issuance path unchanged (no evidence claimed on issuance-only).
- `scripts/test-v4-producer-closure.cjs` — producer now builds a deterministic deliverable payload, sets `acceptanceCriteria` = `{type:'hash-equals', value: <sha256 of payload>}`, signs a genuine seller evidence item under the evidence domain, emits `exp.evidence`, records the explicit issuer allowlist + `requiredTypes`, and adds Phase C separate-process asserts + 3 evidence negatives (wrong issuer, correctly-signed-but-fails-criterion, missing evidence). Outputs moved to NEW `evidence/phase3c-v4/` (Phase B closure evidence untouched, byte-identical).
- `scripts/test-v4-evidence.cjs` — focused suite, 22/22: positives P1/P1b/P2 (valid fulfilled release; explicit allowlist; refund-with-same-evidence still verifies), negatives N1-N17 with SPECIFIC reasons (wrong issuer, tampered sig, signed-but-fails criterion, cross-commitment, wrong criterion, duplicate replay, wrong type, stale, future-dated, after-deadline + boundary positive, malformed amount + unit suffix, missing on lifecycle, unknown predicate, missing minimumCount, code-injection payload opaque, verdict-policy inconsistency, omitted allowlist reported). Anti-blanket-rejector guard: P1/P1b/P2 run beside N1-N17 in the same execution.

#### Separate-process result (evidence/phase3c-v4/separate-process.txt, exit 0)
- VERDICT: **VERIFIED_WITH_LIMITATIONS** (not VERIFIED).
- Phase C evidence checks PASS in the separate process (schema+domain, item signature+issuer, sufficiency, criterion satisfied, evaluator consistency).
- Limitations explicit: evidence validation does not establish the truth of the real-world assertion; objective-only (subjective/physical/high-value unsupported); valid signature ≠ proof, authorized verdict ≠ fulfillment, verifiable settlement may accompany a refund; anchor/journal/finality/governance limitations unchanged.
- NO full-lifecycle VERIFIED claim; no secrets; read-only RPC proxy.

#### Regressions
- `scripts/test-v4-journal-walk.cjs` 87/87, `scripts/test-v4-journal-verify.cjs` 37/37 — unchanged green.
- `scripts/test-v4-evidence.cjs` 22/22. Producer 25/25.
- Historical fixtures byte-identical (git diff empty): `evidence/v4-anchor/*`, `evidence/phase3b-v4/synthetic-*.json`, `evidence/v3-battery/fixture-full-lifecycle.json`. New evidence lives in `evidence/phase3c-v4/`; the Phase B closure dir is untouched.
- Mainnet admission remains disabled; no push, no deployment, no public-chain writes.---

## Phase D1 — Durable execution and transaction preparation (IMPLEMENTED, local, not deployed)

**Commit:** local (see `git log` after this section). **Status:** worker foundation implemented and tested; NOT wired into production routes; NOT broadcast-capable.

### What exists
- `worker/d1-store.js` — node:sqlite (built-in, Node 26) transactional store: ACID WAL, UNIQUE nonce reservations, versioned claims, stalled-reservation ledger. Isolated adapter; NOT a migration of the hosted PostgreSQL store.
- `worker/d1-tx.js` — custody calldata builder (release/refund/mutualRelease/mutualRefund/raiseDispute/resolve) + `signTransactionLocal` (ethers `signTransaction` with NO provider → NO broadcast) + local tx-hash computation (keccak256 of signed bytes).
- `worker/d1-worker.js` — `D1Worker.prepare()`: accept (idempotent, conflict-checked) → prerequisites → calldata → nonce reservation (bounded retry) → sign-without-broadcast → durable persist → versioned PREPARED claim. `recover()` lists ACCEPTED + restores PREPARED.
- `worker/d1-abi.js` — loads the committed `SAAXEscrowCustodyV2` artifact ABI.
- `mainnet/design/worker-plan-d1.md` — architecture, persistence rationale, invariants, secret-storage requirements, supported actions, exact D2 scope.

### Test evidence
- `scripts/test-d1-worker.cjs` **26/26 PASS** (valid op → PREPARED; unauthorized/state-not-permitted/expired rejected; identical retry idempotent; changed-payload replay rejected; unsupported action rejected; crash-before-sign → ACCEPTED + zero broadcast; recovery finds ACCEPTED; post-prepare recovery restores exact hash/nonce; concurrent workers distinct nonces + one prepared action per op; stale version claim rejected; persist failure fails closed; **broadcast spy: ZERO broadcasts**; nonce never recycled).
- `scripts/test-d1-cross-process.cjs` **2/2 PASS × 6 runs** (two OS processes, same account, same store → distinct nonces enforced by the store UNIQUE constraint; exactly one prepared action per op).
- Local chain 31337; synthetic keys; isolated tmp sqlite stores.

### Assurance gained
Durable operation acceptance (atomic, idempotent, conflict-checked), prerequisite-gated preparation, unique account-nonce reservation, signed-but-never-broadcast PREPARED persistence, restart recovery of accepted+prepared work, fail-closed persistence, zero broadcast path.

### Not yet (explicit remaining; see Phase D2 section above)
- Live-path wiring (access JSON ledger to SQLite worker handoff), relayer key custody (production secret manager), independent worker audit, public-chain finality (interface exists, NOT activated).
- Mainnet admission remains DISABLED; hosted deployment unchanged.


### Implemented (mainnet/design/worker-plan-d2.md)
- validatePrepared: decode + recompute hash + sender/chain/destination/calldata-action/value/nonce/bindings checks; recheck current state + deadlines; reject corrupted/mismatched records; simulation advisory only.
- broadcastPrepared: ONLY send path; sends ONLY persisted signed bytes; durable PENDING attempt BEFORE send; crash-after-send leaves SUBMISSION_UNCERTAIN (reconciled by hash, never inferred non-broadcast from absent receipt).
- Explicit attempt/operation states: PENDING, SUBMISSION_UNCERTAIN, INCLUDED, FINALIZED, REVERTED, BLOCKED (fee replacement DEFERRED — stuck/dropped txs surfaced as BLOCKED + incident, never recycled, never double-submitted).
- reconcileOutcome: successful receipt + canonical block ref, correct custody address/action, expected events, resulting escrow state, actual token movement + amount, beneficiary, explicit finality policy (local-confirmations, LABELED local-only; public-chain interface NOT activated; fixed wait ≠ finality).
- Reorg detection: removed/replaced receipt or changed block hash → returned to reconciliation WITHOUT a second business action (REORG_DETECTED incident).
- Nonce init/reconcile: account history (fresh store on used account = normal init), pending, reservations, unexpected consumption (blocking incident gates new work), gaps, stalled reservations (never recycled).
- External settlement: worker records actual outcome + executor; does NOT claim it executed the action. Operation failure separate from escrow outcome.
- At-most-once custody effects: one canonical prepared action/op; idempotent retry; terminal FINALIZED recorded once; repeated reconcile is a no-op (no 2nd payout, no re-broadcast). NO claim of unconditional exactly-once; DB updates + chain execution are NOT one atomic transaction.

### State machine (attempt level)
PENDING (durable) → SUBMISSION_UNCERTAIN (sent) → INCLUDED (mined) → FINALIZED | REVERTED | BLOCKED. Reorg: INCLUDED → reconciliation (re-check by hash); absent receipt stays SUBMISSION_UNCERTAIN (uncertain observation, not failure).

### Tests (scripts/test-d2-worker.cjs)
40/40 PASS, exit 0. [REAL] local EVM 31337: evaluator release/refund, disputed resolution, mutual release, timeout refund (at/after cutoff), external settlement (worker refuses before broadcast, no fake success), child-process prepare/broadcast/restart-reconcile (real spawn/kill/respawn). [MOCK] labeled: response discarded → SUBMISSION_UNCERTAIN; mining-before-reconcile; reorg → REORG_DETECTED; unexpected nonce consumption → blocking incident; stalled reservation never recycled.

### Regressions (all green)
test-d1-worker 26/26 · test-d1-cross-process 2/2 · test-v4-journal-walk 87/87 · test-v4-journal-verify 37/37.

### Limitations retained (brief §7)
Access JSON ledger → SQLite worker handoff UNINTEGRATED. SQLite WAL single-host (not multi-host shared-filesystem). Node ≥ 22.5 (repo runs 26). Signed-byte protection + production signer custody remain activation gates (synthetic keys only here; bytes never exported/logged; not encrypted — no encryption claimed). Nonce UNIQUE constraints do NOT fence a stale signer (lease boundary documented; signer never reuses reserved nonce, never broadcasts before durable persist). Fee replacement deferred. Public-chain finality NOT activated. Mainnet admission DISABLED; no deployment, no push.
### Implemented (mainnet/design/worker-plan-d3.md) — D3 integrated lane
- ONE authoritative acceptance transaction (worker/d3-store.js acceptIntegrated): operation + work item + journal/outbox intent committed atomically in BEGIN IMMEDIATE; same-nonce/changed-payload → 409 CONFLICT_CHANGED_PAYLOAD (guarded by auth_nonce lookup); identical retry → same operation, no second row; blocking-incident check inside the tx.
- HTTP integration (route-server.js, gated by SAAX_INTEGRATED_WORKER=1): the handler's authorization/admission checks (access auth, funding bindings vs agreement, role/escrow-party pinning, chain/custody) run BEFORE the acceptance write; the worker never invents evaluator approval — execution requires D2Prerequisites (signed agreement/policy, on-chain state permits the exact action, cutoff, genuine signatures/timeout rules); actionArgs verdict signatures are the REAL key signatures the contract enforces.
- Work discovery is POLLING ONLY (work_items), never an in-memory notification; work survives worker absence and handler death; worker crash after broadcast → replacement reconciles (FINALIZED), repeated reconciliation idempotent (no double payout).
- Journal/outbox intent written at acceptance; drained into REAL journal entries tied to actual receipts after chain execution; journal-write failure after execution stays recoverable (outbox PENDING → re-drain from recorded outcome, NO re-execution). Observer/submitter/authorizer distinct; timeout-refund journaled as 'timeout-refund' role 'open' (no evaluator authority), never conflated with evaluator refund.
- Chain/ABI lane: SAAX_NETWORK=local allows the configured local chain (31337); SAAX_CUSTODY_ABI env picks the V2 18-tuple ABI (legacy default = V1 artifact, unchanged); getLogs fund-scan bounded by chain head (low-block chains no longer hang). Hosted lane defaults unchanged (84532, V1 ABI).

### Tests (scripts/test-d3-integration.cjs)
47/47 PASS, exit 0 — REAL HTTP handler + REAL worker as SEPARATE processes, REAL local EVM 31337: release path (one op, executed once, journaled with real refs), timeout-refund path (Refunded, fixed beneficiary, timeout-refund journal entry), negatives before acceptance (token/role/chain/custody/terms → 401/402 with no op), identical retry → one op, changed-payload same nonce → 409, handler-killed-after-commit work durable + retry same op, worker-dies-after-broadcast replacement reconciles no double payout, journal persistence failure recovered without re-execution, terminal status/export after restart, separate-process verifier reports honest limited verdict (no fabricated VERIFIED).

### Regressions (all green)
test-v4-journal-walk 87/87 · test-v4-journal-verify 37/37 · test-d1-worker 26/26 · test-d2-worker 40/40 · test-d3-integration 47/47.

### Remaining (unchanged)
- Hosted lane: JSON ledger remains the default until a separate, documented migration; operational JSON ledgers are NOT imported automatically.
- Public-chain finality NOT activated; fee replacement deferred (BLOCKED + incident); relayer key custody + signed-byte protection remain activation gates (synthetic keys only; bytes never exported/logged; not encrypted); independent worker audit NOT completed.
- Mainnet admission DISABLED; no deployment, no push.### D3 CLOSURE (2026-10-18) — resolve policy, expiry semantics, complete exports
- RESOLVE access-role enforcement (worker/d3-action-auth.js): `resolve dispute`
  requires accessRole === evaluator BEFORE the verdict re-entry —
  `RESOLVE_ROLE_REQUIRED`. A genuine verdict never substitutes for caller
  access authorization; buyer/seller/normalized ops are rejected at the
  mapping or role gate. Test: scripts/test-d3-action-auth.cjs now 28/28
  (added P9, N16, N17, N18).
- Expiry semantics (worker/d2-prereqs.js + endpoint/escrow-access.js):
  access-auth expiry is a WALL-CLOCK ACCEPTANCE-time check (EXPIRED before the
  acceptance record); execution authority is bounded by contract-action
  validity + EVM-clock cutoffs (state-permitted, AFTER_CUTOFF, timeout
  carve-out at/after cutoff, verdict execution window), NOT by the access-auth
  expiry. The execution-time wall-clock AUTH_EXPIRED rejection was removed:
  delayed worker pickup of an accepted op must proceed; access expiry alone
  does not erase accepted work and does not prove a prepared tx cannot
  execute. Signatures/deadlines are never extended. Test:
  scripts/test-d3-expiry-semantics.cjs 6/6.
- Complete integrated exports (scripts/test-d3-closure-export.cjs):
  Export A = fulfilled release (criterion satisfied, evaluator release,
  full artifact chain: signed v4 agreement + authorizations + genuine EAS
  anchor + journal + evidence); Export B = AFFIRMATIVE NONFULFILLMENT →
  authorized evaluator refund BEFORE final cutoff (criterion NOT satisfied —
  the legitimate failed-fulfillment outcome, NOT a timeout refund); negative
  control = missing anchor/journal/evidence → NOT verified (no fabricated
  VERIFIED). v4-evidence.js narrow fix: criterion not-satisfied is a truthful
  finding; fatal ONLY for release outcomes; refund outcomes verify the
  failure. Separate-process verification with the candidate ceiling
  (VERIFIED_WITH_LIMITATIONS, never full VERIFIED). Evidence:
  evidence/d3-closure/.---

## E1B v4 finality state (after trusted-config finality integration)

Supersedes the inspection-era statement in section 4.4 that "Only
`exp.finality.mode === 'local-synthetic'` is accepted" as the COMPLETE
finality story. This section reflects the source as implemented in E1B
(`verifier/verify-v4.js`, `verifier/verify-export.js`,
`verifier/v4-finality-adapter.js`, `scripts/test-e1b-finality.cjs`,
`scripts/test-e1b-verify-v4.cjs`, `scripts/observe-e1b-sepolia.cjs`,
`evidence/e1b-sepolia-observation.json`).

### Trusted-config finality policy (v4 verifier)

- **Selection**: `SAAX_V4_FINALITY` (operator environment) selects the policy
  passed to `verifyV4(exp, rpcUrl, finalityPolicy)` and the CLI. Values:
  `local-synthetic` (alias `local-confirmations`) | `op-stack-safe` |
  `op-stack-finalized`. Unknown modes fail closed
  (`FINALITY_POLICY_UNSUPPORTED`). NEVER inferred from the export.
- **Strength ordering** (monotonic): local-synthetic (0) < op-stack-safe (1) <
  op-stack-finalized (2). The export's declared `finality.mode` may be equal or
  weaker than the trusted config (the trusted config is what is enforced —
  strengthening is safe). An export claiming a STRONGER mode than the trusted
  config is rejected (`overclaim/downgrade attempt rejected`). Export policy
  thus can never LOWER the configured requirement.
- **Coverage set**: funding and settlement transactions (both) must be
  covered; evaluated together and consistently.
- **SAFE vs FINALIZED**: safe-head coverage is SAFE-stage
  (`safeStage=true, finalizedStage=false`), never consensus-finalized, and does
  not satisfy `op-stack-finalized`. Finalized policy requires finalized-head
  coverage of both references.
- **Outcomes**: local-synthetic -> unchanged boundary check; public policy ->
  observations recorded in `finality.{mode,safeStage,finalizedStage,
  observations}`; the overall ceiling stays `VERIFIED_WITH_LIMITATIONS` in
  every case. An insufficient-finality export yields `INCOMPLETE_UNSUPPORTED`
  with the exact observed status (TAG_UNAVAILABLE / BOUND_EXCEEDED /
  SAFE_ONLY / INCLUDED_ABOVE_HEAD / ...). A SAFE-stage limitation explicitly
  states it is not consensus finality.
- **Anchor gate preserved**: `v4-anchor.js` still requires the export's
  declared `finality.mode === 'local-synthetic'` (local-era EAS gate); the
  public finality observation runs against a local-synthetic-DECLARED export
  with the trusted config enforcing the stronger policy.

### RPC capability and trust requirements (finality observation)

- The configured provider is a TRUSTED source of receipts, canonical blocks
  and the safe/finalized tags. Tagged reads (`eth_getBlockByNumber 'safe' /
  'finalized'`) are RPC observations, NOT independent consensus
  reconstruction.
- Bounded ancestry verification: hash-aware parent walk bounded by `maxDepth`
  (default 256). Old evidence beyond the bound -> `BOUND_EXCEEDED` (fail
  closed). The check is NOT widened or removed to make old history pass.
- Required capabilities: `eth_getBlockByNumber` (tags + hex-number + hash),
  `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getCode`
  (historical), `eth_call` (historical state), `eth_chainId`. Archive access is
  needed for `eth_getCode` at old blocks and historical `eth_call`.

### Public deployment identity (unchanged restriction)

- The 84532 profiles (`v4-eas-policy.json`, `v4-candidate-identity.json`)
  remain the historical LOCAL-EVIDENCE profiles, NOT public Base Sepolia
  deployments. No trust-any-address flag, no EAS/custody bypass, no
  unreviewed-deployment whitelist was added.
- A lifecycle export claiming 84532 public deployment identity stays
  unsupported (`INCOMPLETE_UNSUPPORTED`) — verified by a focused negative in
  `test-e1b-verify-v4.cjs`.
- Mainnet admission disabled (`FINALITY_MAINNET_NOT_ACTIVATED` on chain 1; no
  mainnet profile). The full public-chain export remains unsupported; the
  finality COMPONENT is integrated and demonstrated independently of
  deployment identity.

### Evidence

`evidence/e1b-sepolia-observation.json` records the read-only Base Sepolia
(chain 84532) observation: 4 committed transactions (funding/settlement for
the refunded and disputed escrows) with receipts present, status 0x1,
canonical block-hash match and tx-in-canonical-block; bounded ancestry walk
fails closed with `BOUND_EXCEEDED` for these ~100k-block-deep transactions;
separately labeled arithmetic head-position note (included block <= safe and
finalized head numbers — NOT ancestry proof); observation time, head
references, policy and RPC trust assumptions recorded. The result is an RPC
observation, never independent consensus reconstruction.