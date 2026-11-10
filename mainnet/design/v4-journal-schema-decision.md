# V4 Journal Schema Decision (design only — no implementation)

**Status:** INTERNAL DECISION DOCUMENT. Produces a recommended journal record shape and binding answer for the v4 journal schema gap surfaced at `7ecd9a65`. Does not modify the verifier, producer, signed representation, or any test. Implementation is a separate, later task depending on owner approval of this document.
**Baseline:** `7ecd9a65` (journal schema gap surfaced). Inspection reads: `v4-verifier-check-map.md`, `agreement-signing-spec.md` §3/§5, `verify-export.js` (v3 `checkJournal`/`JOURNAL_TRANSITION_AUTHORITY`, lines 485-610 region), `scripts/test-v4-checkpoint.cjs` (v4 producer), `evidence/phase3b-v4/synthetic-*.json` (v4 lifecycle fixtures).

## 1. What the journal must commit to

**Events a real v4 lifecycle produces** (derived from the producer, not v3): the v4 producer (`scripts/test-v4-checkpoint.cjs`) drives: (a) `fund` by the buyer (13-arg mapping: commitmentId, digest32, token, buyer, seller, evaluator, principal, resolutionSeconds, finalCutoffSeconds, minReleaseTime, policyId, policyDigest, agreementRef); (b) settlement via `release`/`refund` after a Safe 2-of-3 evaluator verdict (`releaseArgs`, `ESCROW_VERDICT_TYPES` under custody domain); (c) `mutualRefund` signed buyer+seller (`MUTUAL_RESOLUTION_TYPES`); (d) zero-signature timeout `refund` broadcast by `stranger` at/after cutoff; (e) in the intermediate governance scenario, a Safe `changeThreshold` (owner/threshold change) that can invalidate an earlier authorization. There is **no `extend_deadline` and no `dispute`/`resolve_dispute_*` name in v4** — those are v3 names; v4's custody V2 permits `release`, `refund`, `mutualRelease`, `mutualRefund`, `resolve:release`/`resolve:refund` (dispute resolution actions), and timeout `refund`. Transitions that must be journaled: `issue` (agreement), `anchor-confirmed` (if anchor present), `funded` (buyer funding), `release`/`refund` (evaluator verdict), `mutual-release`/`mutual-refund` (buyer+seller), `timeout-refund` (eligible at/after final cutoff), and `governance-change` (Safe owner/threshold change affecting outstanding authorizations) if the journal is to explain invalidation.

**Role that must sign each transition (derived from v4's permitted transitions, not v3's map):** the signer is the party the custody contract accepts for that path, recovered from the signature the contract validates:
- `issue` → buyer (agreement issuance; both parties consent to the manifest per `authorizations`)
- `anchor-confirmed` → attester (EAS anchor, when present; distinct role)
- `funded` → buyer (the `fund` caller)
- `release` / `refund` (evaluator verdict) → the agreement's digest-covered `evaluator` (currently the Safe proxy; the Safe enforces its own 2-of-3 threshold — the journal records the custody-accepted authorization, not the raw Safe owner set; Safe ownership is a governance dependency, not journal authority)
- `mutual-release` / `mutual-refund` → both buyer AND seller (two signatures)
- `timeout-refund` → NO role; eligibility at/after cutoff, open to anyone to submit but recipient is fixed by the contract (refund to original buyer)
- `governance-change` → the Safe's own governance (owner/threshold change via Safe `execTransaction`); the journal records the event, it does not attribute it to a custody role.

Derivation note: unlike v3 (where `extend_deadline`/`dispute` map to the evaluator and `dispute` to buyer|seller), v4's evaluator transitions are exactly the custody-accepted verdict actions (`release`, `refund`, `resolve:*`); mutual actions require both parties; timeout requires none. A recoverable-signer model must therefore support "no signer required" as an explicit authority (timeout), not default to "any signer."

## 2. The recommended record shape

Candidates: (A) hash chain only; (B) event sequence only; (C) both (v3's approach).

**Recommendation: A — hash chain only, for the pilot's first version.**

The strongest two arguments against it:
1. **Producer serialization + retry reasoning:** every write depends on the prior entry's hash, so `append` cannot be retried after a partial failure without either re-reading the chain or risking a fork if a different tail is used; parallel writers cannot append concurrently.
2. **No trivial gap detection:** a missing middle entry breaks the chain but the break position must be located by walking hashes; an event-sequence counter would surface a gap at a glance.

Why they do not override for the pilot: the v4 producer is single-writer (one process appends funding then settlement for one escrow at a time), so serialization is not a concurrency cost; the producer already holds the prior entry at append time (`events[i-1].entryHash`), making hash chaining the natural, lowest-complexity structure. Retry reasoning is handled at the application layer by the durable acceptance ledger (a partial journal write is either not yet accepted or re-read deterministically; a failed journal write after settlement is a recoverable, explicit INCOMPLETE in the export — see §4). Gap detection is a verifier concern, and the verifier already walks the full chain (v3 `checkJournal`), so a broken link at position *i* names that position exactly. B (sequence only) is rejected because sequence integrity then rests on the store rather than on signatures — the pilot's whole point is chain-independent provenance. C (both) adds an `eventCount`+`tailHash` (v3's extra invariants) that are cheap, but for the first version they duplicate what the hash chain already proves and add schema surface; they can be layered on later without breaking readers that treat the extra fields as optional (documented: a v4 journal with both is still valid under the hash-chain-only reader, since the chain check is the binding one).

Tradeoff restated: hash-chain-only gives tamper-evidence and ordering at the cost of single-writer append and manual gap walk; both are acceptable for the pilot and are the two costs B would remove but only by delegating integrity to the store.

## 3. The binding question — the one that matters most

**Does the signed v4 representation commit to the journal root (or tail hash) at issuance?**

**Recommendation: NO — the journal is a separate record alongside the agreement, for the pilot's first version.** The signed v4 digest covers `MANIFEST_FIELDS_V4` (`agreement-signing-spec.md` §3.1: commitmentId … fallbackDisposition — 19 fields); it does not contain a journal root. Binding the journal root at issuance would be an **agreement-schema change**: it adds a digest-covered field, which changes the v4 canonical manifest bytes, which changes `manifestHash`, which changes the `commitmentDigest`, which breaks **every existing signed v4 fixture** and the anchor binding (the EAS anchor covers the digest).

Consequence of NO: a verifier can check the journal's internal consistency (hash chain, authorities, terminal-state agreement with the escrow record) but **cannot prove the journal belongs to this agreement** rather than being replayed from another one. That replay-resistance gap is closed differently and cheaply: bind the journal's first event to the agreement digest and commitmentId (the first `issue` event's signed fields include `commitmentId` and the `manifestHash` — matching the export's `commitmentDigest` and `commitmentId`), which ties the journal to the agreement without changing the signed representation. This is strictly weaker than a signed root but sufficient for the pilot: an attacker replaying another agreement's journal would fail the commitmentId/digest binding in the first event. It also preserves the existing signed artifacts.

**Consequence for existing v4 fixtures:** under the NO recommendation, **zero fixtures need regeneration** (no signed representation, no anchor, no digest changes; the journal is an additive export field the producer starts emitting). If the owner instead chooses YES, then all existing signed v4 artifacts change and must be regenerated:
- `evidence/phase3b-v4/synthetic-lifecycle.json`, `synthetic-mutual.json`, `synthetic-timeout.json` (3) — examplar lifecycle fixtures committed as evidence;
- `evidence/v4-anchor/positive-export.json` (1) — the anchored issuance/lifecycle export;
- plus any re-run of the producer's check fixtures (`ANYTHING` the anchor test suite asserts against committed exports) and the `evidence/v4-anchor/separate-process.txt`/`results.json` text outputs would need re-capture.
Count under YES: **at least 4 signed fixture files + their captured verifier transcripts** would need regeneration; all 4 are committed evidence referenced by the v4 anchor test suite (`scripts/test-v4-anchor.cjs`).

## 4. Producer implications

`scripts/test-v4-checkpoint.cjs` would build the journal incrementally: capture the `issue` event at agreement build (commitmentId + manifestHash + both-party consent), append an `anchor-confirmed` event when an anchor is recorded, append `funded` after the `fund` receipt (observing the on-chain escrow fields it just funded: digest, buyer, seller, evaluator, principal, cutoff), and append the settlement event after the settlement receipt — observing which path actually executed by decoding the selected call (release/refund verdict vs mutual vs timeout) and the resulting terminal escrow state — then emit the journal as an export field at the same moment it emits `lifecycle.settlement`. Because the producer knows the settlement outcome only after the receipt, a journal write can fail after the settlement it journals (e.g. the process dies between receipt recording and journal append); in that case the export is not produced (or is produced without a journal → explicit INCOMPLETE in the verifier), never a fabricated journal, and the next identical retry re-derives the journal from the durable acceptance ledger + chain reads rather than re-executing.

## 5. Signing domain

The v4 journal signing domain must be a **new, versioned journal domain** — explicitly NOT: v3's `SAAX Commitment Journal`/`1` (v3 names/domain), NOT the custody domain (`SAAX Escrow Custody V2`/`2` with verifyingContract = the custody address — that domain signs `EscrowVerdict`, a different struct), and NOT inferred from `formatVersion`. Recommended: domain name `SAAX Commitment Journal` version `"4"`, chainId = the signed agreement's `custody.chainId` (84532 local candidate), verifyingContract = the signed agreement's `custody.custodyAddress`, with a **v4 journal event struct** carrying `commitmentId, commitmentDigest (or manifestHash), transition, at, by, prevHash, entryHash` — structurally like v3's `JournalEvent` but versioned and bound to the v4 agreement's custody/chain, so a v3 signature can never validate a v4 event and vice versa. If a different domain is preferred (e.g. a dedicated `verifyingContract` for the journal registry), that is a decision, but the recommendation is to reuse the signed custody address as verifyingContract for consistency with the agreement domain and to avoid introducing a new trust root.

## 6. What this decision does not do

This document does not implement anything: it does not change the verifier (`verify-export.js` / `verify-v4.js`), does not change the signed representation (`agreement-signing-spec.md` / `MANIFEST_FIELDS_V4` / digest), does not change the producer (`scripts/test-v4-checkpoint.cjs`), does not change any test or fixture, and **does not close the journal assurance gap** — v4 exports today still contain no journal and the v4 verifier still has no journal check. It defines what closing the gap would require (a v4 journal schema per §1-§2, a binding model per §3, producer emission per §4, a domain per §5) so the owner can approve or redirect the design before any implementation task is authorized. The other two v4 gaps (fulfillment-evidence validation, public-chain finality) are untouched; the deployment blocker (conflicting chain declarations) is unchanged and not resolved here.

## 7. Open questions for the owner

1. May existing signed v4 artifacts be regenerated? (Under the recommended NO-binding, none need to be; under YES, at least 4 signed fixture files plus captured verifier transcripts would be re-created.)
2. Does the pilot's first version tolerate the producer-side complexity of the chosen shape? (Hash-chain-only requires single-writer append and deterministic re-derivation after a failed journal write; event-sequence-only delegates integrity to the store; both adds schema surface.)
3. Should the journal also record Safe governance changes (`changeThreshold`/owner changes) as first-class events, or is that out of scope for the pilot's first journal (the ERC-1271 witness already explains invalidation)?
4. Should the v4 journal domain bind `verifyingContract` to the signed custody address (recommended) or introduce a dedicated journal-registry address?

---
*End of decision document. Nothing implemented; v4 journal assurance gap remains open.*

---

## 8. Mainnet binding path (not decided here; requires a new custody contract)

**The pilot recommendation stands for the pilot, not for mainnet.** The NO-binding / head-bound recommendation in this doc is the pilot's answer. It is correct for the pilot because head-binding is sufficient to demonstrate the journal belongs to the agreement, and because rebuilding the testnet anchor evidence to obtain root-binding would invalidate artifacts the anchor commit (407aba50) is evidenced by.

**Testnet evidence does not carry to mainnet.** A mainnet deployment is a new deployment: different chain, different EAS deployment, different custody contract, different attestation UID. There is no testnet anchor evidence to invalidate for mainnet because none of it is mainnet evidence. The "rebuild anchor evidence?" cost calculus does not apply to mainnet.

**Recommended mainnet mechanism (corrected): a settlement-time *pre-settlement head* commitment in the custody contract.** The parties sign the agreement at issuance under head-binding (as now). The settlement transaction commits the journal's **pre-settlement head** on-chain — the tail *before* the settlement entry is appended. The settlement receipt is then linked into the journal as a *subsequent* entry. This gives the verifier an on-chain anchor for the journal's state up to settlement without requiring the parties to predict the full journal root before events occur.

**Why the original phrasing was wrong — and the two coherent alternatives.** The earlier sentence "the settlement transaction commits the journal tail hash" was circular and is **not implementable as written**: a journal entry recording the settlement transaction cannot contain that transaction's hash, because the hash depends on the entry's contents. The two coherent formulations are:

1. **Pre-settlement head commitment (recommended).** The settlement transaction commits the journal's pre-settlement head (the tail before the settlement entry is appended); the settlement receipt is then linked into the journal as a subsequent entry. The transaction does not commit itself. **Tradeoff:** this anchors the journal state as it existed immediately before settlement — it does not commit the final journal end state (the receipt entry plus anything recorded later), so a verifier's on-chain anchor stops at the pre-settlement boundary. That is adequate for the pilot's assurance because the receipt itself is evidenced on-chain and the post-settlement tail is a single well-defined entry. It is also the only self-consistent formulation: it avoids the circularity of including the settlement transaction's own hash, because the transaction commits the journal state that existed before the settlement entry, and the settlement receipt is linked into the journal afterward.

2. **Separately designed checkpoint mechanism (alternative, not the recommendation).** A checkpoint entry is defined at a chosen boundary and committed later, with the settlement receipt linked between checkpoints. This decouples the on-chain commitment from any single settlement transaction, at the cost of a separate checkpoint-record type and a separate commitment step. It is named as an alternative, not the recommendation, because it adds mechanism without adding assurance the pre-settlement-head version does not already provide for the pilot.

The recommendation is **option 1 (pre-settlement head commitment)**. State plainly: **"settlement commits the tail" is not implementable as written** — the design must commit the pre-settlement head, not the settlement entry's own hash.

**This requires a new custody contract; it cannot be retrofitted to the existing one.** State plainly:

- The settlement-time (pre-settlement head) commitment is a custody-contract requirement — the contract must accept the head hash as part of settlement calldata and record it as an authorized tail. It records the **authorized tail the submitter presents in settlement calldata**; it does not and cannot automatically know an off-chain journal's "actual tail." That recorded value anchors the submitted history; it does not prove completeness. **Proving completeness requires additional rules (e.g., a transition set fixed in the agreement, or a checkpoint chain) and additional evidence — not the commitment alone.**
- The existing SAAXEscrowCustodyV1 / SAAXEscrowCustodyV2 contracts do not implement this. They are deployed and immutable; the requirement is not an upgrade to them.
- Mainnet deployment is therefore a new custody contract version, not a configuration change to the pilot's custody. The pilot's custody contract stays as-is.
- The new contract version is out of scope for this decision doc: defining it, auditing it, and deploying it are separate work items that follow from this addendum, not part of it.

**Issuance-time root binding is a high-value-profile option, not a default — and it cannot commit future event contents.** Parties can sign the journal format, the initial binding, and the allowed transition set — they **cannot sign the contents of events that have not happened**. If a "root binding at issuance" option is retained, it commits the format and initial binding, not a prediction of future event contents, and the doc should say so. It also requires the parties to fix the expected transition set in the agreement before funding ("this commitment will journal these N transitions, in this order, or fail"), which is a real constraint on lifecycle flexibility. Recommend it only for profiles where the parties want the event set fixed in advance and the value justifies the constraint. Do not make it the default. This option would also be a new custody contract version at mainnet, for the same reason.

**What this addendum does not do.** It does not change the pilot's recommendation, does not change the v4 signed representation, does not change the existing custody contract, does not implement or specify the new custody contract version, does not close the journal assurance gap for the pilot (which remains head-bound, as stated), and does not authorize any mainnet work. It names the mainnet path so the pilot decision isn't mistaken for the permanent answer, and states that the path requires a new custody contract rather than a retrofit.

### Limitations that bind the entire journal design (head-binding and chain integrity)

These two statements are normative for every journal-verification design that follows, and the producer and verifier prompts reference them:

1. **Head-binding establishes association, not completeness.** A properly authenticated head binds the journal to the agreement. It does not by itself establish that the journal is complete — i.e., that it contains all the events the agreement expected.

2. **A hash chain detects changes relative to an authenticated checkpoint; it does not prevent an authorized signer from creating an alternative history.** Chain integrity is a property relative to a checkpoint; it is not a property against a signer who controls a fork from that checkpoint.

These follow directly from the A1/A2 corrections above and appear in the assurance-gap list: the journal's head binds it to the agreement (association), the hash chain detects tamper relative to the checkpoint (tamper evidence), and neither establishes completeness — completeness requires the additional rules (fixed transition set, checkpoint chain) and evidence named in the corrected item 3.

*Addendum ends. Decision document remains design-only; v4 journal assurance gap stays open (head-bound); no mainnet work authorized.*