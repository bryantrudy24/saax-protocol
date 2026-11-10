# Prioritized Production-Readiness Plan — SAAX Custody V3 (owner-approved snapshot baseline)

**Status: PREPARATION. The review snapshot is owner-approved for independent review ONLY.**
No deployment, public-chain write, spending, funding, production activation, or outreach is
authorized by this plan. It is a roadmap with explicit ownership and dependencies.

**Baseline:** owner approval recorded 2026-11-06 (`OWNER-APPROVAL-RECORD.md`) — manifest
`920ddff8…`, prep commit `ea0562b5`, archive `bfecfd1b…`, candidate runtime pin
`0x87615e3d…`. All documented findings/limitations remain open; the snapshot is immutable
until a change is authorized (then re-preparation + re-approval).

---

## Track legend

- **[L] Lucius-executable** — local engineering/documentation; no new authorization needed.
- **[O] Owner decision** — requires the Commander's explicit decision/input.
- **[C] Cost/infrastructure** — requires provisioning authorization (may be zero-cost or paid).
- **[R] Independent review** — external reviewer engagement + remediation.
- **[A] Authorization gate** — deployment/funding/canary; separate explicit authorization.

## Priority ladder

### P1 — NOW (unblocks everything; no candidate changes)

| ID | Track | Work | Dependency | Completion criterion |
|---|---|---|---|---|
| P1-A | [R] | **Commission the independent review** of the owner-approved snapshot using `14-reviewer-handoff.md` + commissioning brief (`mainnet/design/design-review-brief.md` F1 addendum). Scope: contracts, signer architecture, Safe/governance, recovery/finality, journal/evidence/anchor, verifier, findings F-1…F-16, Q1/Q2/Q4/Q5. | [O] cost/spend authorization for the engagement; reviewer selection | Engagement terms signed; reviewer has the archive + manifest |
| P1-B | [O] | **Owner decisions that settle review target behavior**: Q1 journal-head commitment (yes/no), Q4 resolution-deadline/minReleaseTime enforcement (contract vs verifier-only), exposure caps numeric values, evaluator mechanism confirmation (Safe+ERC-1271 vs MPC), finality method+policy approval (recommendation: trusted-rpc + op-stack-finalized), mainnet USDC/token pinning. | none (owner input) | Signed decision log covering Q1/Q4 + caps + evaluator + finality + token pinning |
| P1-C | [L] | Commissioning packet finalized around the approved snapshot (this handoff; `14-reviewer-handoff.md`). | P1-A start | Packet self-contained, delivered with archive |

### P2 — NEXT (parallel, no candidate bytes touched)

| ID | Track | Work | Dependency | Completion criterion |
|---|---|---|---|---|
| P2-A | [L] | **CRLF packaging correction** (F-2): add `.gitattributes` (`contracts/*.sol eol=lf`) in a non-candidate commit; document blob-byte compile procedure for Windows reviewers. | none | Reviewer on Windows reproduces from worktree bytes without manual blob extraction |
| P2-B | [L] | **Embedded compiler metadata** (readiness G2) at **artifact level (JSON), NOT bytecode-level** — appending to bytecode would change the runtime pin `0x87615e3d…` and invalidate the approved snapshot. Record metadata in `data/escrow-custody-v3-build.json`-adjacent record; rebuild must stay byte-identical. | none | Artifact JSON carries embedded metadata; rebuild hash unchanged |
| P2-C | [L] | **Spec docs for owner decisions**: with P1-B, write the journal-head commitment spec (if Q1=yes) and the resolution-deadline/minReleaseTime enforcement options (Q4). Documentation only — no implementation before owner decision. | P1-B | Decision-ready specs with tradeoffs, no code |
| P2-D | [L] | **Hosted-lane worker integration plan** (JSON ledger → SQLite handoff; `SAAX_INTEGRATED_WORKER` rollout; monitoring spec; incident runbook; participant disclosure; backup/restore drill design). | none | Docs reviewed; drills designed |
| P2-E | [L] | **Read-only Base mainnet capability survey** (no writes): RPC tags/archive verification, head positions, EAS deployment address, USDC address. | none | Capability matrix + addresses verified, recorded as observations |
| P2-F | [L] | Pilot client example refresh (current trust-onboarding + receipt + verify steps) per the existing pilot package. | none | Runnable example verified against live nonfinancial endpoints |

### P3 — PROVISIONING (requires cost/infrastructure authorization)

| ID | Track | Work | Dependency | Completion criterion |
|---|---|---|---|---|
| P3-A | [C] | ≥2 independent archive-capable RPC providers with safe/finalized tag support. | [O] budget | Endpoints verified against P2-E matrix; disagreement path tested |
| P3-B | [C] | Hosting + Postgres/PostgREST + backup storage (self-hosted or existing infra). | [O] budget | Provisioned; backup/restore drill passed (P2-D) |
| P3-C | [C] | Secret manager/KMS for relayer key + prepared-key delivery + rotation. | [O] budget | Keys delivered without route-process access; rotation exercised |
| P3-D | [C]+[O] | Production Safe deployment config (singleton/owners/threshold) if Safe route confirmed. | P1-B | Safe owners/threshold configured + monitored; provenance docs |

### P4 — REVIEW, DEPLOYMENT, CANARY (sequential gates)

| ID | Track | Work | Dependency | Completion criterion |
|---|---|---|---|---|
| P4-A | [R] | Review remediation + disposition table (fixed / won't-fix with rationale) for every finding. | P1-A findings | Findings report with severities; zero open critical/high; medium/low dispositioned |
| P4-B | [R] | Reviewer re-verification of changed code paths (if any remediation touches candidate, a NEW snapshot + NEW approval is required first). | P4-A | Re-check evidence committed |
| P4-C | [A] | **G11 deployment authorization** (deploy + initial limits; escrow-backed OFF until authorized). | P4-B | Authorization recorded |
| P4-D | [A] | **G12 independent bytecode/config verification** pre-funding (on-chain code hash == artifact; chain/custody env verified; no escrow-backed flag beyond scope). | P4-C | Verification report committed |
| P4-E | [A]+[L] | **G9 final-candidate testnet lifecycle rehearsal** on the exact frozen artifact (existing historical testnet flows re-run on the frozen candidate). | P4-D | Lifecycle rehearsal pass with receipts/events/token movement/export verification |
| P4-F | [A] | **G13 restricted real-fund canary** within limits; **G14 expansion** only on evidence. | P4-E + separate funding authorization | Canary positions funded→terminal with receipts/events/token movements/separate-process export verification; expansion authorized per evidence |

---

## Critical path

```
P1-B (owner decisions) ──► P2-C (specs) ──► integrate into review scope
P1-A (commission review) ──► review findings ──► P4-A remediation ──► P4-B re-verification
                                                         │
P2-A…P2-F (parallel, no candidate touch) ◄────────────────┘
P3-A…P3-D (provisioning; parallel once budget authorized)
P4-C (G11) ─► P4-D (G12) ─► P4-E (G9 rehearsal) ─► P4-F (G13 canary)
```

The LONGEST pole is the independent review (P1-A → P4-A → P4-B): it should be commissioned
as soon as the Commander authorizes the engagement cost, while owner decisions (P1-B) and
Lucius-executable preparation (P2) proceed in parallel. The approved snapshot means the
review is **not** blocked on candidate changes — the review can start today against the
immutable baseline; any remediation that requires candidate byte changes will trigger a new
snapshot + new approval (per the approval's change-control rule).

## Next executable actions (this run's handoff)

1. **[O] Commander:** authorize P1-A (review engagement cost/spend) and provide P1-B decisions.
2. **[L] Lucius (no waiting):** P2-A CRLF packaging correction; P2-B metadata record (artifact-level);
   P2-D hosted-lane/monitoring/runbook docs; P2-E read-only mainnet survey; P2-F pilot example refresh.
3. **[L] Lucius (after P1-B):** P2-C decision specs for Q1/Q4.

## What this plan does NOT authorize

- No deployment, public-chain transaction, spending, funding, production activation,
  external outreach, or public EAS anchoring.
- No modification of the approved snapshot (candidate source, harness bytes, evidence,
  manifest, archive). Any such change requires a NEW preparation commit and NEW owner
  approval.
- No mainnet custody, no x402 settlement changes, no website claims beyond the already
  published maturity labels.
- LUMIYOU and Victoria's Vision remain untouched.

## Durable checkpoint (this run)

- **Completed:** approved-baseline verification (manifest/archive/prep commit, blob identity,
  ancestor check); approval recorded (`OWNER-APPROVAL-RECORD.md`); reviewer handoff prepared
  (`14-reviewer-handoff.md`); readiness plan written (this file).
- **Evidence:** all hashes recomputed this session == approved values; pinned revisions exist;
  package clean under `git status`.
- **Open dependencies:** P1-A cost authorization; P1-B owner decisions; nothing else blocks.
- **Next executable action:** the Commander's P1-A/P1-B response; until then, P2-A…P2-F are
  runnable by Lucius on request.

---
*Prepared by the station overseer (Lucius Fox), 2026-11-06, at HEAD `b33b3073`, from the
owner-approved snapshot baseline.*