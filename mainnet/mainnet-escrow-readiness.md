# SAAX Mainnet Escrow Readiness Package

**Status:** INTERNAL PLANNING MATERIAL — not for publication.
**Prepared:** by the station overseer (Lucius Fox) from repository inspection and committed evidence at HEAD `bf8c603d` (`main`).
**Purpose:** define the concrete, evidence-backed path from the current testnet custody implementation to an independently reviewed, explicitly authorized mainnet launch; expose every gap and decision rather than assert readiness.
**Scope discipline:** no custody redesign implemented here, no deployment, no mainnet transaction, no paid service, no auditor outreach. This package only inspects, documents, and recommends.

---

## 0. Executive summary

SAAX runs an **immediate-payment, non-custodial** mainnet lane today (x402 direct transfer; USDC on Base 8453) and a **testnet-only escrow custody** implementation (Base Sepolia 84532) that:

- Holds funds in an **immutable, admin-less** contract (`SAAXEscrowCustodyV1`, no owner/upgrade/pause/withdraw).
- Releases/refunds funds **only** on an EIP-712 verdict signed by the agreement evaluator (bound at `fund` time), or on a deadline-passed timeout refund.
- Is currently exercised **only in harness/scripts** (operator-run testnet tools). The live routing endpoint in escrow-backed mode (`SAAX_ESCROW_BACKED=1`) **verifies on-chain funding but never broadcasts a custody state-changing transaction** — there is no production worker that executes release/refund/resolve verdicts.
- Has **zero remaining testnet liabilities** on all three testnet custody deployments (verified at block 48205728, evidence committed).

**Mainnet readiness is NOT claimed.** The package below documents the concrete blocker set in dependency order.

---

## 1. Baseline (what is actually implemented, demonstrated, and committed)

### 1.1 Repository state

- Repo root: `ax-router/` (monorepo: contracts, endpoint, landing site, verifier, evidence, daily-logs).
- **HEAD:** `bf8c603d` — "Align website content with current SAAX state: commitment lifecycle, maturity separation, accuracy corrections across pages and 11 blog posts" (website alignment; no custody change).
- Branch: `main`; remote `origin/main` exists.
- Relevant custody history (recent commits): `f52cebeb` (chain guard absolute + stub tests), `34d2f368` (authenticated action-scoped escrow access + durable acceptance), `8f3869f3` (crash-gap recovery), `b58782fe` (reproducible harness + terminal states), `5e101602` (v3 manifest + evaluator authority), `de675d4b`/`6e48ac67` (testnet on-chain position inventory + resolutions), `02ddd43e` (Phase 6 external pilot prep), `4445b0bd` (Phase 5 custody review — internal review package).

### 1.2 Custody contract (current immutable implementation)

- Path: `contracts/SAAXEscrowCustodyV1.sol`; Solidity 0.8.26; compiled artifact at `data/escrow-custody-build.json` (abi + bytecode + source + compiledAt only — **no embedded compiler metadata**; see C.2 audit input gap).
- Build script: `scripts/_build-custody.cjs` (same solc 0.8.26, optimizer 200, viaIR per daily-logs).
- **Powers (implemented, read from source):**
  - `fund(commitmentId, commitmentDigest, token, buyer, seller, evaluator, amount, deadline, minReleaseTime)` — anyone may fund; binds all terms; pulls USDC via `_safeTransferFrom` **before** state write (atomicity: failed movement reverts the whole escrow record).
  - `release(...)` — requires evaluator-signed EIP-712 `EscrowVerdict{action:"release"}`; state must be `Funded`; funds go to seller; terminal.
  - `refund(...)` — evaluator-signed `{action:"refund"}` **or** deadline-passed timeout refund (empty signature); state must be `Funded`; funds to buyer; terminal.
  - `raiseDispute(...)` — **only** buyer or seller (evaluator intentionally excluded); state → `Disputed`; freezes the escrow.
  - `resolve(...)` — needs evaluator-signed verdict naming `release` | `refund` | `hold`; from `Disputed` only.
  - `getEscrow(bytes32)` / `balanceHeld(token)` / `domainSeparator()` — independent read surface.
- **Limitations (confirmed, do not assume more):** NO admin, NO owner, NO upgrade, NO pause, NO deposit cap, NO evaluator replacement, NO withdrawal function, NO cross-contract migration. `resolve("hold")` returns a Disputed escrow to `Funded` only via an evaluator verdict. **No deadline timeout refund exists while `Disputed`** — `refund()` reverts `WrongState` for non-`Funded` state.

### 1.3 Deployed testnet artifacts (Base Sepolia 84532)

| Deployment | Address | Creation tx | Notes |
|---|---|---|---|
| C5 (current app-flow custody) | `0x5a5472d751839cd4968cbf1b136baf862279ff5d` | `0xc7ebd7…95c1e` (block 48176893) | used in escrow-backed mode |
| C76 (older) | `0x76cce76caf348199fe8756f7f253f981f21477ae` | `0xdacf2c…60a8` | used by recovery harness default |
| F85 (older) | `0xf85abb3bcd8c7183e8b81d51d739fdb2980f6ce6` | `0xf273fc…ef53` | used in early flows |

Read-only probe (this run): on `https://mainnet.base.org` (8453) all three return **empty code** — they exist only on 84532. Production `.env` sets `SAAX_CHAIN_ID` to 8453, `SAAX_ESCROW_BACKED` unset, `SAAX_CUSTODY_ADDRESS` unset → **escrow-backed mode is OFF in production; mainnet custody is not deployed.**

### 1.4 Application integration (what the live endpoint actually does)

- `endpoint/route-server.js`:
  - Escrow-backed mode ON (`SAAX_ESCROW_BACKED=1`): on a funded commitment, reads the custody contract (`escrowMod.verifyOnChain`) and, if funded and bound, records settlement status `escrow-funded` with the funding tx hash; **does not call any custody state-changing function**.
  - Immediate mode OFF: `gateway.settleAuthorization` broadcasts the buyer's signed EIP-3009/EIP-2612 transfer (mainnet non-custodial lane); after settlement, `escrowMod.fund` records an **off-chain** escrow ledger flag (durable history, not on-chain custody).
- `endpoint/escrow.js` `verifyOnChain`: refuses any chain ≠ 84532; `SAAX_ESCROW_ALLOW_MAINNET` **no longer overrides** (removed; tested in `scripts/test-escrow-chain-guard.js`, 4 cases incl. flag-set case). Stale reference remains in `scripts/_inject-escrow-verify.cjs:21-30` (dead code, not loaded by the endpoint).
- `endpoint/escrow-access.js`: EIP-712 `EscrowAccess` authorization (role+action scoped, nonce+expiry), 31/31 acceptance suite, binds acceptance durably; external effect is left to the caller (verdict path) — **no worker executes it automatically**.
- `endpoint/recovery.js`: **stub/interface only** (Kleros Escrow V2 shape) — every method throws `NOT_IMPLEMENTED`. Real external recovery integration is post-mainnet by design.

### 1.5 Durable persistence and recovery machinery (implemented, script-exercised)

- `data/day17_escrow_durable.sql` — Postgres schema: `ax_router.escrows` (immutable bindings, version bump, legal-transition guard), `escrow_events` (hash-chained audit, FK, seq-unique), `escrow_intents` (idempotency-key unique, statuses pending/broadcast/confirmed/failed/unknown) + atomic RPCs (`upsert_escrow`, `append_escrow_audit`, `record_escrow_intent`, `update_escrow_intent`, `pending_escrow_intents`). Store client: `endpoint/store.js` (PostgREST; Docker self-hosted preferred, Supabase fallback).
- `scripts/day20-live-recovery.cjs` — worker A persists intent → broadcasts real testnet fund tx → **kills before saving txHash**; worker B (fresh process) discovers the pending intent, reconciles against authoritative chain state (receipt + balance + nonce), marks confirmed/matched, refuses duplicate funding. Committed recovery-kill evidence: `evidence/recovery-kill-evidence.json` (boundary after-broadcast-before-receipt, pid/tx recorded) and `evidence/recovery-verified-commitment.json`, `evidence/restart-test-ledger.json`.
- The intent ledger RPCs are wired into `endpoint/escrow.js` (recordIntent/updateIntent/reconcileIntent/pendingIntents) and are exercised by scripts **only**; the live escrow-backed path does not currently persist intents or broadcast.

### 1.6 Independent verification software vs independent security review

- **Independent verification software:** `verifier/verify-export.js` — a 28-check full-lifecycle verifier (anchor fact checks, transaction-chain check, digest, journal, escrow bindings, signatures). Re-runnable by a third party against a fresh RPC with no SAAX DB. Boundaries documented: `verifier/eas-verification-limits.md` (direct EAS attestations only; delegated/batch/contract-mediated attestations out of scope).
- **Independent security review:** **none exists.** `audit/custody-review-phase5.md` is explicitly the **vendor's own review package prepared FOR an external reviewer** ("this document is NOT an independent audit"). It documents findings honestly (incl. the permanent-lock scenario) and lists exactly what an external reviewer should verify (code-hash match, harness rerun, on-chain reads, event logs, chain-guard reject paths, dispute-liveness assessment).
- **On-chain inventory:** `evidence/onchain-position-inventory.json` (13 positions across 3 testnet custody deployments, all terminal at block 48205728; 12 timeout refunds + 1 disputed resolve:refund; balances zero) with raw block-reference reads in `evidence/block-ref-raw-reads.json`. `evidence/custody-reconciliation.json` is an earlier snapshot (balances 400000/100000/150000) **superseded** by the inventory's verified-zero state.
- **Maturity separation (honesty):** the pilot readiness addendum records that all prior testnet runs used keys controlled by **one operator** (buyer/seller/evaluator) — "these are NOT independent participants". The Phase 6 external pilot (**prepared, NOT sent**) requires an external buyer with their own keys; all-operator replay does not qualify.

---

## 2. Executive decision table

| Decision | Recommended approach | Reason | Alternatives / tradeoffs | Approval needed |
|---|---|---|---|---|
| D1. Mainnet custody deployment | Deploy a **new** immutable custody deployment on Base mainnet 8453 (same or revised source, new address) | Current deployments prove testnet-only behavior; mainnet needs its own code-hash-verified artifact; existing testnet positions stay on testnet rules | Reuse C5 source unchanged (no liveness fix) vs revise source (add governed secondary exit) — see D2 | Owner |
| D2. Dispute-liveness policy | **Prefer adding a bounded, governed secondary exit** for post-dispute freeze (see A.6/A.7), deployed as a new immutable contract | Current contract can permanently lock disputed funds if the evaluator vanishes; unacceptable for real funds; adding `buyer+seller mutual-consent release` or a long-delay escape preserves the no-unilateral-withdrawal trust model | Accept permanent-lock risk (not recommended for mainnet); add admin/withdraw (rejected — silently expands operator authority) | Owner + (later) independent reviewer |
| D3. Escrow-backed live path | Build the **missing execution worker** that (a) persists intent, (b) broadcasts the signed verdict tx, (c) reconciles receipt/state, (d) is idempotent per commitment/verdict-nonce before any mainnet escrow is enabled | Today the endpoint only verifies funding; nothing executes release/refund/resolve automatically; without the worker, escrow mode is not operationally usable | Manual operator broadcast per verdict (acceptable only for a tiny canary; not for scale) | Owner + independent reviewer |
| D4. Evaluator key custody | Move testnet operator-key simplification to **separate mainnet roles**: buyer = participant keys, seller = participant keys, evaluator = dedicated mainnet key with cold storage + signing policy; never host participant private keys | Phase 6 disclosure says all prior testnet runs were one operator; mainnet must not repeat that | Multi-sig evaluator / threshold signing (stronger, more infra) | Owner |
| D5. Background durable store | Keep the Postgres/PostgREST store (configured) as the single-writer durable source of truth for escrows/intents/audit; document single-writer constraint and backup/restore | Recovery machinery depends on it; `escrow_intents` idempotency is the crash-safety backbone | Supabase platform rollback (documented, kept for fallback) | Owner |
| D6. Independent audit | Commission one contract+integration review of the **frozen release candidate** (source, artifact, bytecode-compare, harness rerun, integration paths) — scope in §C | The Phase 5 package is explicitly not an independent audit; mainnet launch gate requires one | Skip audit (rejected — contradicts the objective); AI self-review (rejected — not independent) | Owner (spend) |
| D7. Production configuration | Separate mainnet/testnet env + signing identities; chain-guard enforced in `verifyOnChain` (already refuses ≠84532); add explicit mainnet custody address config and **no shared keys between nets** | Replay/cross-chain separation depends on it | Single shared config (rejected — replay risk) | Owner |
| D8. Initial launch shape | Restricted real-fund canary: small per-position cap, small aggregate cap, admission list, full lifecycle rehearsal first, then post-canary expansion only on verified evidence | Bounded exposure while the worker/ops/monitoring mature (§D, §E) | Unrestricted launch (rejected) | Owner |
| D9. Push / publication of this package | **Commit locally; do NOT push.** `vercel.json` is tracked and a push to `main` triggers a public production deployment; this package is internal planning material | §4.2 of the brief: do not trigger publication without authorization | Push after explicit authorization to publish | Owner |

---

## A. Proposed custody policy

### A.1 Current rules (implemented, testnet)

Funding/release/refund/timeout/dispute behavior is defined by `SAAXEscrowCustodyV1` (see §1.2):

- **Funding:** anyone may `fund` (pulls token from `msg.sender`). Terms frozen at fund: digest, buyer, seller, evaluator, token, amount, deadline, minReleaseTime.
- **Release:** only via evaluator-signed verdict `release`; state `Funded`; terminal.
- **Refund:** evaluator-signed `refund` verdict, or deadline-passed timeout refund (no sig); state `Funded`; terminal.
- **Dispute:** only buyer or seller; state → `Disputed`; **freezes the escrow** (no timeout refund while disputed).
- **Resolution:** only evaluator-signed verdict `release` | `refund` | `hold`. `hold` returns to `Funded`.
- **Authority:** buyer = funds/refund/dispute; seller = release/dispute; evaluator = the single signature authority; relayer anyone (call succeeds only with valid embedded verdict); operator = **none on-chain** (no admin).
- **Outcomes require evaluator authorization** (release/refund/resolve all need evaluator verdicts except the deadline timeout refund).

### A.2 Recommended rules for mainnet (proposed)

Adopt the current rule set with explicit additions:

1. **Deadline semantics:** every funded escrow has a deadline. Before deadline: release or refund only by evaluator verdict. After deadline (state still `Funded`): timeout refund callable by anyone (relayer-friendly), unchanged.
2. **Dispute:** parties may raise dispute (unchanged). While `Disputed`, funds are frozen pending resolution.
3. **Evaluator disappearance/refusal/key loss (proposed fix):** add a **governed secondary exit** (see A.6) so a missing evaluator cannot permanently lock funds. Minimal contract delta, new immutable deployment.
4. **Evaluator compromise:** contract cannot detect a compromised evaluator; mitigations are operational: key custody policy (D4), monitoring of verdict patterns, and the secondary exit as backstop. Where an evaluator signs a malicious verdict, disputes opened before the verdict can be resolved only by the evaluator — hence the secondary exit matters *before* a compromise, not after a malicious terminal verdict (terminal states are irreversible by design).
5. **Unsupported tokens:** escrow mode must be restricted to the whitelisted token (testnet-verified USDC on Base Sepolia was `0x036CbD…CF7e`; mainnet USDC is a different address — re-verify). Fee-on-transfer/rebasing tokens are **rejected** by the exact-delta check but not *provably* rejected for every rebasing token; the policy is a token whitelist + chain/contract verification, not "any ERC-20".
6. **Immutability/versioning:** custody is immutable. Version changes require a **new deployment**; existing funded positions **retain their original rules** (no silent migration). No authorized migration path exists today for on-chain positions — document that funded mainnet positions are bound to their deployment's rules forever unless a future migration contract is agreed and deployed.
7. **Emergency response:** there is **no on-chain halt**. What can be halted: the service kill switch (stops new funding intake via the app) but **cannot freeze custody or stop direct deposits to the custody address**. Release/refund/resolve remain callable directly on-chain by anyone with a valid verdict; the contract cannot be paused. The incident procedure must therefore be: stop intake → assess → use the secondary exit / verifier evidence / participant communication — never rely on a custody freeze.

### A.3 Evaluator authority boundary

- **Do NOT introduce an unrestricted admin withdrawal** under any circumstance (rejected; changes trust model and enables operator theft).
- **Do NOT silently expand operator authority** — any change to the custody contract is a visible, explicit release decision.
- **Do not present proposals as implemented** — every recommendation in §A.2 is a proposal pending D2.

### A.4 Permanently-locked disputed funds (explicit)

**Yes: the current contract can permanently lock disputed funds.** One scenario: buyer or seller raises a dispute, the evaluator never signs a resolution, and the escrow sits in `Disputed`. `refund()` reverts (`WrongState`, state ≠ Funded), so even past the deadline the funds are unmovable. There is no admin, no pause, no second exit. The Phase 5 review documents this explicitly ("YES in exactly one scenario: Disputed + evaluator never resolves").

**Recommendation:** do NOT take this to mainnet as-is. Either (a) add the governed secondary exit (A.6) for the mainnet deployment, or (b) if the owner accepts the freeze risk for a bounded canary, cap exposure and document the risk in participant disclosures. (a) is recommended.

### A.5 Minimal contract changes for mainnet

If a governed secondary exit is approved, the minimal deltas are:

1. `refundByConsent(commitmentId, digest, buyerSig, sellerSig)` — both parties' EIP-712 signatures (a distinct action type + nonce domain) release a `Disputed` escrow to the buyer (or seller if both sign the release variant). Requires the two parties' signatures, never the operator's.
   - OR an **escape hatch**: after a long fixed delay from dispute (e.g. 30 days) past the deadline, either party may call a timeout-refund variant on a `Disputed` escrow, allowing funds to return to the buyer. This preserves buyer protection without operator power but creates a delay-based seller risk if the buyer disputes maliciously (seller is protected only by evaluator verdict or mutual consent).
2. New deployment address; new EIP-712 domain is automatic (verifyingContract = new address; chainId = 8453).
3. Optional: deposit cap enforced in `fund` (per-position or aggregate) if the owner wants contract-enforced limits (otherwise caps are service/operational — see D.8).

Trust/security tradeoffs:

- Mutual-consent exit: strong against evaluator loss; no operator power; requires both parties to cooperate (a stubborn party can still freeze, but only by refusing to sign — and the other party's dispute claim is then a legal/off-chain matter with on-chain evidence).
- Long-delay escape: protects the buyer unilaterally after delay; seller has a weaker position if a dishonest buyer disputes and lets the timer run; still requires no evaluator.
- Both inherit the irreversibility of terminal states: once released/refunded, no reversal.

### A.6 Supported token/chain scope

- Chain: Base (8453 mainnet) when the deployment is made; the contract binds `chainId` at construction.
- Token: whitelist exactly one token per deployment at this stage (mainnet USDC, address to be re-derived and verified; the testnet-verified contract was Base Sepolia USDC `0x036CbD…CF7e`).
- Unsupported behavior: fee-on-transfer/rebasing → rejected by exact-delta (with the documented caveat that "not guaranteed to reject every rebasing token"); any non-whitelisted token → reject at the application layer (service-enforced), and the contract's exact-delta check provides defense in depth.

### A.7 Dispute deadlines, fallback authority, bounded exit

- Deadline refund (Funded, past deadline, no evaluator): implemented.
- Dispute freeze: implemented; **no fallback today**.
- Proposed fallback authority: buyer+seller mutual consent (`refundByConsent`), or long-delay escape, as a bounded exit — both are proposals pending D2.
- Resolution deadline: currently none on-chain. Consider an on-chain `disputeResolutionDeadline` (requires contract change) so `Disputed` states cannot age indefinitely without either resolution or exit; if not added, monitor Disputed positions operationally (D9 monitoring).

---

## B. Remaining recovery work

The crash-boundary table maps each boundary to current behavior, evidence, the remaining gap, the proposed fix, and an acceptance test. **Recovery path classification:** Automatic (the durable store + worker reconciles without operator), Operator-assisted (a script/tool the operator runs), or Unsupported (no mechanism).

| # | Crash boundary | Current behavior | Evidence | Remaining gap | Proposed fix | Acceptance test | Recovery path |
|---|---|---|---|---|---|---|---|
| B1 | Before durable acceptance (buyer-funded on-chain; app crashed before accept record) | Escrow is funded on-chain; no durable accept row; retry path re-reads chain state via `verifyOnChain` and records acceptance idempotently | `endpoint/escrow-access.js` (durable acceptance, idempotent retry); `34d2f368`; 31/31 acceptance suite | Requires the caller (user) to re-present; no automatic sweep of funded-but-unknown escrows | Add a reconciliation sweep: scan custody events/positions whose commitment has no durable accept; reconcile from chain | Fund on-chain with app down; restart; sweep finds and records the acceptance exactly once | Operator-assisted (sweep script) → automatic once sweeper runs |
| B2 | After acceptance but before execution (verdict signed by evaluator, not broadcast) | Acceptance is durable; **no worker executes the verdict broadcast**; evaluator signs verdict externally (harness/testnet only) | `endpoint/escrow-access.js` (returns "accepted durably; external effect pending caller execution via verdict path"); `route-server.js` escrow-backed path never broadcasts | **No automatic execution of release/refund/resolve verdicts anywhere in the live path** | Build the execution worker: load durable acceptance → sign verdict (evaluator) → persist intent → broadcast → reconcile (D3) | Worker broadcasts a `release` for a held escrow; state → Released; intent confirmed after receipt | Unsupported today → must be built (operator-assisted manual broadcast as interim) |
| B3 | After signing but before broadcast (evaluator signed; crash before send) | Verdict is an EIP-712 signature; nothing persisted pre-broadcast in the live path | `scripts/day20-live-recovery.cjs` records intent only for fund; release/refund intents exist as RPCs but no live caller | No durable storage of the signed verdict bytes + nonce + expiry in the live path | Extend the intent ledger: persist `{action, nonce, issuedAt, sig v/r/s, commitmentId, digest}` before broadcast with verdict-expiry awareness (120s/300s window) | Kill after signing before broadcast; recovery replays the SAME verdict (nonce consumed once) or re-signs with a fresh nonce if expired | Unsupported today → build |
| B4 | After broadcast acceptance but before durable hash storage | Script-level demonstrated for `fund` (worker A killed after broadcast, worker B reconciles); **not wired into live settlement/release paths** | `evidence/recovery-kill-evidence.json` (boundary after-broadcast-before-receipt); `day20-live-recovery.cjs` assertions; `recovery-verified-commitment.json` | Live path has no broadcast step to protect (B2 gap); once the worker exists, this boundary applies | Same intent-ledger + reconcile flow as B2/B3 for every custody broadcast | Test harness kills the worker after `send` before receipt save; a fresh worker reconciles confirmed exactly once (no double) | Automatic (once worker exists) |
| B5 | After mining but before reconciliation | Script-level for fund; store RPCs model `unknown` outcome states | `day17_escrow_durable.sql` (intent_status unknown, reconcile to confirmed/failed/unknown); `test-escrow-durable.js` | Live path lacks a reconciler that re-checks chain for `unknown` intents | Periodic reconciler: for `pending/broadcast/unknown` intents, re-read receipt/state and mark matched/mismatch/unknown — never infer non-broadcast from an absent receipt or tx scan | Seed a `broadcast` intent with a real mined tx; reconciler marks confirmed; seed a `pending` with no chain effect; reconciler keeps `unknown` (no false completion) | Automatic (once reconciler exists) |
| B6 | During replacement-worker / concurrent-worker execution | Durable store enforces atomic transitions (`UPDATE … WHERE state=expected`), unique idempotency keys, terminal-state guards; `escrow_intents` unique on idempotency_key | `day17_escrow_durable.sql` (SQL atomicity, stale-version rejection, ALREADY_CONFIRMED guard); `test-worker-failure.js`; `_worker-crash.js` | Single-writer enforcement and worker-coordination policy not documented for production; no lease/lock around long broadcasts | Document single-writer constraint (one active executor per commitment), add worker lease if multiple processes run; keep SQL atomicity as the final guard | Two workers attempt release of the same escrow; exactly one succeeds; the other sees a terminal state and no-ops | Automatic (SQL-guarded) — once a worker exists |
| B7 | RPC uncertainty / reorg / finality | Broadcast helper uses 1 confirmation (Base finality doc: 1 block for this use); `verifyOnChain` reads `latest`; verifier reads at explicit blocks | `endpoint/broadcast.js` (CONFIRMATIONS_DEFAULT=1, Base checklist); `evidence/block-ref-raw-reads.json`; `ef3d24555` (block-ref reads at correct height) | Confirmation policy vs reorg risk not modeled in a reconciler; `latest` reads can race | Define finality policy (N confirmations before terminal reconciliation; treat <N as `unknown`), read at fixed blocks for evidence | Reorg drill on a local fork; reconciler keeps `unknown` until N confirmations, then confirms exactly once | Operator-assisted (policy) → automatic |
| B8 | Multiple processes / concurrent verdicts | SQL atomicity + unique key guards exist; no live executor | `test-worker-failure.js`, `_worker-crash.js` | Same as B6/B7 — needs the executor + lease/policy | Lease per commitment; SQL guard as backstop | Concurrency drill: parallel workers, one winner | Automatic |
| B9 | External service side effects (EAS anchor, settlement linkage) | Escrow-backed path logs linkage failures but never alters the response contract; EAS anchor verified by verifier | `route-server.js` (linkage write is additive, non-fatal); `verifier/verify-export.js` | Side effects (EAS attest, x402 settlement) can double-fire if the worker retries after an ambiguous response | Idempotency keys per side effect (already the design for intents); reconcile EAS/attestation and settlement separately from custody | Retry after ambiguous settlement response → no duplicate EAS attest, no duplicate transfer | Automatic (once wired) |

### B.10 Nonce taxonomy (explicit)

Three distinct nonce spaces exist — do not conflate:

1. **Account nonce (`tx.nonce`)**: the EOA transaction sequence; controls broadcast order and replay of *transactions*. The recovery harness pins sequential nonces for approve→fund (documented failure class: replacement-underpriced/silent revert when nonces collide).
2. **Access nonce (EIP-712 `EscrowAccess.authorization.nonce`)**: consumed in `escrow-access.js` for durable acceptance of a participant's action scope; idempotent retry keyed on it.
3. **Evaluator-verdict nonce (`usedVerdictNonce`)**: the custody contract's replay guard for `EscrowVerdict` — one-time use, maps to a single verdict; `Replay` revert on reuse. Distinct from both account nonce and access nonce.

**Identical-tx rebroadcast vs replacement/duplicate:** the signed verdict tx is *identical* only if nonce + gas + expiry are byte-identical — replaying the same signed tx bytes is harmless (idempotent on the contract: nonce consumed or terminal state reverts). Re-signing with a new verdict nonce is a *replacement* verdict, not a duplicate business action. Duplicate business actions are prevented by the intent ledger's unique idempotency key, and by the contract's `state != None` guard on `fund` and terminal-state guards.

**Durable acceptance ≠ completed execution.** B2–B5 are precisely the boundaries where a durable acceptance exists but the on-chain effect has not yet been proven. The worker + reconciler (D3) is what closes this; today it is unsupported in the live path.

---

## C. Exact independent audit scope

### C.1 Repository paths and artifacts (commissioning-ready)

| Item | Path / value |
|---|---|
| Custody source | `contracts/SAAXEscrowCustodyV1.sol` |
| Build artifact | `data/escrow-custody-build.json` (abi, bytecode, source, compiledAt; **no compiler metadata**) |
| Build script | `scripts/_build-custody.cjs` |
| Candidate commit | `bf8c603d` (HEAD at package time) — freeze a release candidate commit before commissioning |
| Solidity | 0.8.26; solc optimizer 200, viaIR (per daily-logs; confirm in the frozen build) |
| Deployed testnet artifacts | C5 `0x5a5472…ff5d` (block 48176893, tx `0xc7ebd7…95c1e`); C76 `0x76cce7…77ae`; F85 `0xf85abb…6ce6` |
| Testnet USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Base Sepolia) |
| EAS | Base Sepolia EAS `0x4200000000000000000000000000000000000021` (same on Base mainnet; verify) |
| Application integration | `endpoint/route-server.js` (escrow-backed branch ~1601-1720), `endpoint/escrow.js` (verifyOnChain, intents), `endpoint/escrow-access.js`, `endpoint/store.js`, `endpoint/broadcast.js`, `endpoint/recovery.js` (stub) |
| Persistence | `data/day17_escrow_durable.sql` |
| Verifier | `verifier/verify-export.js`, `verifier/eas-verification-limits.md` |
| Harness | `scripts/_escrow-custody-harness.cjs` (51 cases), `scripts/test-escrow-chain-guard.js`, `scripts/test-escrow-durable.js`, `scripts/test-worker-failure.js`, `scripts/_worker-crash.js`, `scripts/day20-live-recovery.cjs` |
| Prior vendor review | `audit/custody-review-phase5.md` (vendor self-review; not independent) |
| Evidence | `evidence/` (onchain-position-inventory, block-ref-raw-reads, recovery-kill-evidence, integrated-escrow-verified-commitment, v2/v3 batteries, baseline batteries, testnet-v1) |

### C.2 Independent review scope (contract + integration)

1. **Custody accounting and conservation of funds.** `fund`/`release`/`refund`/`resolve` token movements, exact-delta checks, balance invariants (custody balance = Σ outstanding escrows), terminal-state exclusivity, no withdrawal path.
2. **Access control, state transitions, deadlines, disputes, evaluator liveness.** `fund` term binding; `release`/`refund`/`resolve` signature authority; `raiseDispute` party restriction; deadline/timeout semantics; `minReleaseTime`; the post-dispute freeze and any added secondary exit; verdict time window (120s/300s) and nonce replay guard.
3. **Token compatibility, transfer failures, reentrancy, external-call risks.** `_safeTransfer*` handling of bool-return/no-return/fee-on-transfer/rebasing; nonReentrant; checks-effects-interactions ordering; token-whitelist enforcement point; EAS and settlement external calls.
4. **Canonical agreement digest, party signatures, evaluator policy, escrow-term bindings.** commitmentId/digest binding at fund and on every terminal action; manifest-v3 evaluator bindings; agreement signature verification; digest formatting (`sha256:` / `0x` normalization) and cross-record bindings.
5. **Exact EIP-712 domains, actions, nonces, expiry/issuedAt semantics, chain and custody separation.** `EscrowVerdict` domain (name "SAAX Escrow Custody V1", version "1", chainId, verifyingContract); action strings `release`/`refund`/`resolve:<resolution>`; `issuedAt`/expiry; `usedVerdictNonce`; `EscrowAccess` domain (separate); replay across chains/deployments (verifyingContract + chainId binding).
6. **Replay, cross-chain/cross-contract misuse, role confusion.** Verdict replay across escrows (digest+commitmentId binding), across chains (chainId in domain), across deployments (verifyingContract), and role confusion between buyer/seller/evaluator/attester/operator (the v3 battery covers evaluator substitution, verdict binding, positive attester≠evaluator).
7. **Worker execution, idempotency, concurrency, persistence, crash recovery.** Intent ledger RPCs, atomic transitions, unique idempotency keys, terminal-state guards, `unknown` reconciliation, single-writer/lease if added.
8. **EAS anchoring and export verification — what each proves and does not.** The verifier's 28 checks: anchor txHash chain (`receipt.to == EAS`, Attested event uid/schema/attester), digest binding, journal integrity, escrow bindings. Explicitly: **an EAS anchor proves the attestation was emitted for that digest at that time — it does NOT prove the escrow was funded, released, or refunded, and it does NOT prove a security review.** The custody contract read + receipts prove fund/release/refund. The verifier does not prove "no other liabilities exist".
9. **Production configuration, key boundaries, incident-control assumptions.** Env split (8453 vs 84532), no shared keys, chain guard behavior, kill-switch limits (can stop intake, cannot freeze custody), monitoring/alert ownership.

### C.3 Explicit exclusions and third-party dependencies

- **Exclusions:** the immediate-payment x402 gateway (out of scope for the escrow audit except where it intersects the escrow key/digest binding); the website content; OS/host security; third-party RPC reliability (treat as operational); the Kleros/EAS contracts themselves (treat as third-party dependencies with their own trust assumptions: EAS proxy on Base, token contract).
- **Third-party dependencies:** USDC token contract (Base mainnet), EAS + SchemaRegistry (Base), RPC providers, Postgres/PostgREST (self-hosted), Vercel (app hosting). Each should be named in the audit's assumptions, with the exact addresses/versions.
- **Attack/threat assumptions to state:** evaluator key compromise; buyer/seller collusion; relayer spam; RPC response manipulation (mitigated by verifier reading at explicit blocks + multiple RPCs); operator compromise (mitigated by no admin/withdraw); reorgs; token behaviors (fee-on-transfer/rebase).
- **Unresolved design decisions to list for the auditor:** the secondary-exit choice (D2), deposit caps enforcement point (contract vs service), confirmation/finality policy (B7), worker lease design (B6/B8).

### C.4 Multi-stage verification pipeline (separate stages, separate owners)

1. **Internal readiness/testing** — vendor: freeze candidate, run unit/invariant/fuzz/integration/recovery suites, produce a reproducible build with **embedded compiler metadata** (this is an input gap: the current artifact lacks metadata for independent rebuild comparison).
2. **Independent contract and integration review** — external reviewer: scope C.2, against the frozen candidate; deliverables: findings report with severities.
3. **Remediation** — vendor: fix findings, re-run internal suites; every fix re-frozen into the candidate.
4. **Auditor review of fixes** — external reviewer: confirm each remediation; re-verify any changed code paths.
5. **Deployed bytecode/configuration verification** — independent: after deployment, compare on-chain code hash to the artifact's runtime bytecode (the Phase 5 package already specifies this procedure for the testnet artifact); verify env/config (chain id, custody address, escrow-backed off until authorized).

**Do not describe AI self-review or passing conformance tests as an independent audit.** The 28-check verifier and 51-case harness are conformance/tooling evidence, not a security review. **An audit does not guarantee safety** — it reduces the probability of specific defect classes; residual risk (key custody, ops, token behavior) remains and is addressed by §D.

---

## D. Production operating plan

### D.1 Configuration and key separation

- Separate mainnet/testnet environment files with **distinct signing identities** (different evaluator, buyer-helper, seller addresses; no shared private keys across nets).
- Evaluator: dedicated mainnet key; cold-storage primary + policy-controlled signing (or threshold/multi-sig if the owner accepts infra). Compromise response: rotate signing identity where the contract allows (evaluator is bound per-escrow at fund — a new deployment/escrow uses the new key; existing escrows keep the old evaluator → the secondary exit (A.6) is the backstop for those positions).
- **Participant-controlled buyer keys: never request or host participant private keys.** The app must only ever see signatures/signed payloads (x402 payment payloads, EIP-712 authorizations) — never raw keys.

### D.2 Durable storage, backup/restore, concurrency

- Postgres/PostgREST store is the durable source of truth (already configured); single-writer constraint per commitment (one active executor); SQL atomic transitions as the final guard.
- Backup/restore: documented and rehearsed — restore a DB backup and re-reconcile every `pending/broadcast/unknown` intent against chain state (no re-broadcast of confirmed intents).
- Concurrency: worker lease per commitment if multiple processes run (D3/D5).

### D.3 RPC resilience, transaction tracking, reconciliation, confirmation policy

- Multiple RPCs (primary + fallback); read at explicit blocks for evidence; `latest` only for live state.
- Confirmation policy: N confirmations before terminal reconciliation (proposed N=2+ for mainnet; Base finality 1 block documented — confirm with the base finality oracle and legal/ops posture); `<N` = `unknown`, never assumed failed.
- Transaction tracking: intent ledger (idempotency key, txHash, txNonce, status, reconcile_status) is the single source for "what was broadcast, what landed"; receipts and contract state are the authoritative outcome.

### D.4 Monitoring

Balances/liabilities (custody balance vs Σ open escrows), pending operations (pending/broadcast/unknown intents), disputes (Disputed positions + age), evaluator availability (last signing activity), persistence failures (store errors), chain/RPC health. Alert ownership: named owner per alert; response procedures documented (intake halt, evidence preservation, secondary-exit invocation, participant notification).

### D.5 Incident shutdown and resumption

- **Shutdown:** service kill switch stops new intake; **cannot** halt custody or direct deposits; direct custody interactions remain callable — procedures must assume that.
- **Resumption:** after root-cause review, reconcile all in-flight intents, re-verify balances, then re-enable intake with explicit authorization.

### D.6 Source verification and release recordkeeping

Frozen release candidate commit; reproducible build (embedded metadata); deployment tx + nonce + block recorded; on-chain code-hash compared to artifact; env/config verified after deploy before any funding.

### D.7 Restricted initial launch (proposed exposure limits)

| Limit | Proposed value (illustrative) | Enforcement |
|---|---|---|
| Per-position cap | e.g. 100 USDC | **Contract** (cap in `fund`, if D8 approved) or service/operational |
| Aggregate custody cap | e.g. 2,000 USDC | **Service/operational** (app rejects new funding above cap); contract only if a per-deployment cap is added |
| Admission | allow list of participant addresses (owner-approved) | **Operational** (app-level) |
| Token | single whitelisted USDC (mainnet address) | **Contract** (exact-delta) + service whitelist |

Explicit: until a cap is added to `fund`, the contract itself has **no cap** — any caller can fund any amount; the cap is purely service/operational at intake, and **direct on-chain calls to `fund` bypass the app entirely** (that is by design: the contract is permissionless). The service cannot prevent direct funding; the exposure limits therefore only gate the *advertised* surface; monitor direct `fund` events.

### D.8 Direct on-chain interactions bypassing router controls

Parties can call the custody contract directly (fund/release/refund/resolve with valid signatures). The router's checks (whitelist, caps, admission) do not apply to those calls. Disclosure must state that on-chain positions are governed by the contract alone.

### D.9 Participant disclosures, support responsibilities, legal/compliance

- Disclosures: custody immutability, evaluator singularity, no admin/withdraw, permanent-lock risk pre-fix (and post-fix residual risk if the secondary exit is approved), direct-call bypass, terminal-state irreversibility, chain/token scope.
- Support: documented escalation paths, dispute evidence policy, community/email support owner.
- Legal/compliance: qualified review required on escrow custody, money-transmission/BIT licensing exposure, consumer-protection disclosure obligations, tax treatment of held funds, and the participant-facing terms. This package does not provide legal advice; it flags the requirement.

### D.10 Rollback limits for immutable contracts

- No code rollback; only intake rollback (service) + reconciliation.
- Already-funded positions keep their funded rules forever (no migration path exists). If the owner later ships a migration contract, it must be a **new, separately audited deployment** with explicit participant consent; never assume silent migration.

---

## E. Measurable launch gates

Gate phases: **pre-deployment** (can build/deploy), **pre-funding** (candidate deployed + config verified, before real funds), **post-canary** (small real funds flow successfully before expansion).

| # | Gate | Pass criterion | Required evidence | Responsible role | Current status | Blocking dependency |
|---|---|---|---|---|---|---|
| G1 | Custody policy approved | Owner approves D1–D9 incl. dispute-liveness decision and exposure caps | Signed decision log (this package §2) | Owner | ⏳ Not approved — decisions pending | Owner decision |
| G2 | Release candidate frozen + reproducible build | A candidate commit + artifact with **embedded compiler metadata**; rebuild reproduces artifact | Build script + metadata + hash match | Owner/engineer | ⏳ Not done (artifact lacks metadata; candidate not frozen) | G1 policy direction (secondary exit changes source) |
| G3 | Unit/invariant/fuzz/integration tests complete | All suites pass on the frozen candidate (harness 51, chain-guard 4, durable, worker-failure, escrow-access 31, v2/v3 batteries) | Test outputs committed against the candidate | Engineer | 🟡 Internal suites exist and have passed historically; must be re-run on the **frozen candidate** (not HEAD drift) | G2 |
| G4 | Independent audit + remediation reviewed | External review of C.2 scope on the frozen candidate; all critical/high remediated; **disposition of every other finding documented** (won't-fix with rationale) | Auditor findings report + remediation commits + disposition table | Independent reviewer | ⏳ Not started (no audit commissioned) | Owner (spend) + G2 |
| G5 | No unresolved critical/high findings | Zero open critical/high; medium/low dispositioned explicitly | Findings tracker | Owner/reviewer | ⏳ N/A (no audit yet) | G4 |
| G6 | Required recovery boundaries demonstrated | B1–B9 crash boundaries have passing acceptance tests (worker exists, reconciled, no double-broadcast) | Recovery test outputs on the candidate | Engineer | 🟡 Script-level fund-recovery demonstrated (B4/B5 fund path); **B2/B3 (verdict execution) unsupported — worker not built** | D3 worker build + G3 |
| G7 | Backup/restore + incident procedures rehearsed | Restore drill passes; incident runbook exercised in a drill | Drill report | Owner/ops | ⏳ Not demonstrated (no committed drill evidence) | Operational work |
| G8 | Production roles/config/monitoring verified | Mainnet env validated (chain 8453, custody address, escrow-backed off until authorized), no shared keys, monitoring live | Config checklist + monitoring screenshot | Owner/ops | ⏳ Config split exists conceptually; mainnet custody not deployed; monitoring not evidenced | G1, deployment |
| G9 | Final-candidate testnet lifecycle rehearsal | A complete escrow lifecycle (fund → hold → release/refund, dispute → resolve) run on **Base Sepolia against the exact candidate artifact** | On-chain tx hashes + state reads + verifier output | Engineer | 🟡 Historical testnet flows done (Flow A/B, disputed resolve, inventory); must re-run on the **exact final candidate** | G2/G3 |
| G10 | Participant onboarding/disclosures ready | Disclosure text + onboarding checklist reviewed (legal flags resolved) | Reviewed copies | Owner (+ legal) | ⏳ Pilot onboarding template exists (testnet); mainnet disclosures not reviewed | G1, legal review |
| G11 | Explicit authorization for mainnet deployment + real-fund limits | Owner signs off deployment + initial real-fund limits (D.7) | Signed authorization | Owner | ⏳ Pending | G1–G10 in order |
| G12 | Post-deployment source/bytecode/config verification before funding | On-chain code hash == artifact bytecode; env verified; no escrow-backed flag enabled beyond authorized scope | Verification report (independent) | Independent verifier | ⏳ Pending deployment | G11 + deployment |
| G13 | Restricted real-fund canary (post-canary) | Small real positions (per G11 limits) complete funded→released/refunded with receipts, events, token movements, export verification; all G1–G12 gates recorded | On-chain txs + balances + verifier output + gate checklist | Owner/engineer | ⏳ Not started | G12 |
| G14 | Expansion (post-canary) | Canary evidence reviewed; aggregate cap raised only via explicit owner authorization; monitoring/alerts proved during canary | Expansion authorization + canary report | Owner | ⏳ Not started | G13 |

### E.1 External pilot status

**Prepared, NOT sent** (`pilot/external-testnet-pilot-phase6.md` + readiness addendum). It would validate: a real external buyer constructing an x402 payment against the challenge, funding an escrow with their own keys, an evaluator-signed release landing seller funds, an interrupted-retry not double-charging, and the independent verifier confirming without SAAX DB access. It is a **valuable pre-mainnet signal**, but with the current worker gap (B2) the pilot's release step is manual/operator-run — which is fine for a pilot but must be disclosed. **Recommendation: keep the external testnet pilot as a pre-deployment gate (before G11), not a substitute for the independent audit (G4) or the canary (G13).** All historical testnet runs were one-operator; an external buyer with own keys is required for the pilot to count. The owner's wallet is not external validation and must never be presented as such.

---

## 3. Prioritized path

### 3.1 Work Lucius can prepare now (no new authorization)

- Freeze an audit-ready candidate commit and add **embedded compiler metadata** to the build artifact (reproducibility input).
- Draft the **execution-worker design** (D3: intent → sign → broadcast → reconcile; idempotency, nonce pinning, expiry handling, lease) as a reviewed implementation plan.
- Draft the **secondary-exit contract delta** (A.6: `refundByConsent` mutual-consent and/or long-delay escape) as a design document for owner decision and audit scope.
- Draft **monitoring dashboard spec** and **incident runbook** (D.4/D.5).
- Draft **participant disclosure text** (D.9) for legal review.
- Prepare the **commissioning packet** for the independent audit (C.1/C.2) so it can be sent the moment the owner authorizes spend.

### 3.2 Decisions the owner must make

1. **D2 — dispute-liveness policy** (accept freeze vs add secondary exit; which variant).
2. **D1/D8 — mainnet custody deployment + exposure caps** (contract-enforced vs service-enforced).
3. **D6 — audit commissioning** (authorize spend + pick reviewer).
4. **D4 — mainnet key custody model** (single dedicated key vs threshold/multi-sig).
5. **G7/G8 — ops readiness investment** (drills, monitoring, config).
6. **Pilot participant** (name an external buyer; authorize outreach) — or explicitly defer the pilot.

### 3.3 Work requiring an independent reviewer

- C.2 contract + integration review (G4).
- Remediation verification (stage 4).
- Deployed bytecode/config verification (G12, stage 5).

### 3.4 Actions requiring deployment/spending authorization

- Audit engagement (spend).
- Mainnet custody deployment (spend + deployment).
- Execution worker deployment + enabling escrow-backed mode on mainnet.
- Any external pilot outreach (authorization required, none granted).
- Push of this package to the public site (do NOT push without authorization — see D9).

### 3.5 Shortest dependency-ordered path to a restricted launch

```
G1 owner policy decision (D1–D9)
  → G2 freeze candidate + reproducible build (add compiler metadata)
  → G3 re-run all suites on frozen candidate
  → [parallel: D3 worker design + build; C.1/C.2 audit commissioning]
  → G4/G5 independent audit + remediation + disposition
  → [parallel: G7 drills, G8 config/monitoring, G9 final-candidate testnet rehearsal, G10 disclosures]
  → G11 owner authorization (deploy + initial limits)
  → G12 independent bytecode/config verification (pre-funding)
  → G13 restricted canary (real funds, small)
  → G14 expansion (post-canary)
```

External testnet pilot (E.1) slots before G11 as an optional-but-recommended pre-deployment signal (needs a named external buyer).

### 3.6 Effort estimates (grounded only)

- **Engineering (vendor):** building the execution worker (B2/B3 + reconciler) — large, multi-day; adding compiler metadata + reproducible build — small; secondary-exit contract delta + harness cases — medium; monitoring/runbook — medium. Estimates are relative, not quotes.
- **External review lead time:** an independent contract review typically takes weeks, with scheduling subject to reviewer availability. **No quote or date is asserted or implied.**
- **Unknowns:** auditor availability/pricing; legal/compliance review outcome; external buyer recruitment; mainnet USDC address verification and token-provider finality semantics; Base finality-oracle behavior under stress.

---

## 4. Verification of this package

- Every claim above was checked against inspected source at HEAD `bf8c603d` (`contracts/SAAXEscrowCustodyV1.sol`, `endpoint/*.js`, `scripts/*`, `data/day17_escrow_durable.sql`, `audit/custody-review-phase5.md`, `pilot/*`, `evidence/*`), committed evidence files, and a read-only live probe (chain 8453 mainnet: custody code absent; env split confirmed; escrow-backed unset).
- No custody write, deployment, transaction, or paid service was executed. No secrets, private key values, signed transaction bytes, or participant data are included in this document (env references are name-only placeholders).
- This package is internal planning material; it must not be pushed to the public site (D9).

*End of package.*

## 5. Phase roadmap (adopted from the Phase 1 execution order)

The mainnet escrow effort proceeds through the following phases. Each phase has explicit gates; a phase is not "done" until its deliverables and verification are committed and reviewed. **The full contract-and-worker candidate must be frozen before its release audit. Material later changes require appropriate reassessment.**

### Phase 1 — Policy/agreement foundation and admission schema (THIS PHASE)

**Deliverables:** custody policy v1 (`mainnet/policies/custody-policy-v1.md`); transaction profiles v1 (`mainnet/policies/transaction-profiles-v1.md`); agreement addendum template (`mainnet/agreements/custody-policy-addendum-v1.md`); isolated admission schema + validator (`mainnet/admission/`) with synthetic fixtures and focused tests; this roadmap.

**Gate:** policy docs reviewed for consistency; admission validator tests pass; all new profiles disabled for mainnet funding; no production wiring.

### Phase 2 — Precise custody design, signed-manifest integration, independent design review

**Deliverables:** exact custody design for mainnet (incl. the 2-of-3 evaluator signing mechanism and contract-wallet signature compatibility review, policy §C); integration of policy/profile fields into a **new signed manifest version** (canonical digest covers parties, asset, amount, custody, chain, permitted outcomes, deadlines, evaluator authority, fallback disposition — policy §A.2), without silently appending unsigned fields; independent design review of the custody + manifest approach.

**Gate:** design review sign-off; signed-manifest integration specified; admission validator aligned to the new manifest fields.

### Phase 3 — Custody implementation and targeted tests

**Deliverables:** custody contract changes (if any) implementing the approved design; secondary-exit/longstop disposition; targeted security tests for the new contract paths; admission validator wired to the new manifest.

**Gate:** targeted tests pass; no funded mainnet positions.

### Phase 4 — Durable execution worker and recovery integration

**Deliverables:** execution worker with durable intent persistence (transaction intent, reserved account nonce, signed bytes, locally computed hash persisted before broadcast — policy §E.2); reconciliation; retry/replacement/finality preserving one authorized business outcome; crash-gap recovery integrated with the admission flow.

**Gate:** recovery tests at the defined boundaries pass; the worker cannot duplicate execution.

### Phase 5 — Full-candidate rehearsal/freeze, independent audit, remediation/review

**Deliverables:** full lifecycle rehearsal on testnet; candidate freeze; independent audit (contract + integration, per §C); remediation of findings; review of remediations.

**Gate:** the frozen candidate passes the independent audit; no material changes after freeze without reassessment.

### Phase 6 — Operating readiness, deployment authorization, deployment verification

**Deliverables:** production operating plan execution (§D); key separation; monitoring; runbooks; explicit deployment authorization; deployed artifact verification (code-hash match, config verification, chain id, custody address, escrow-backed off until authorized).

**Gate:** deployment verified on-chain; escrow-backed remains off until funding authorization.

### Phase 7 — Separately authorized restricted funding/canary, then evidence-based expansion

**Deliverables:** restricted initial launch (proposed exposure limits §D.7; admission list; full lifecycle rehearsal first); post-canary expansion only on verified evidence (§E gates G11/G13).

**Gate:** canary succeeds on-chain with real funds within limits; expansion authorized per evidence.

**Freeze rule:** the full contract-and-worker candidate must be frozen before its release audit. Material changes after freeze require appropriate reassessment (re-audit of the changed scope). This roadmap organizes prior gate definitions into phases; it supersedes none of them.
### E1B operating requirements — v4 finality observation (post-E1A)

- **Finality policy is trusted configuration, never export-owned.** The v4
  verifier enforces `SAAX_V4_FINALITY` (`local-synthetic` |
  `op-stack-safe` | `op-stack-finalized`); an export may declare an equal or
  WEAKER mode but can never claim a stronger one (overclaim/downgrade rejected
  at verification). This is what "exported policy/booleans cannot lower the
  configured requirement" means operationally.
- **SAFE is not FINALIZED.** A transaction covered by the OP Stack `safe` head
  but not the `finalized` head is a SAFE-stage observation
  (`safeStage=true, finalizedStage=false`), never consensus-finalized, and is
  reported with an explicit limitation. SAFE alone does not satisfy an
  `op-stack-finalized` requirement.
- **Coverage set**: the funding AND settlement transactions of a v4 lifecycle
  export are the required coverage set; both must meet the configured stage.
  Any reference missing a receipt/canonical-block match or head coverage is
  `INCOMPLETE_UNSUPPORTED` with the exact observed status.
- **Bounded ancestry/RPC capability**: the adapter verifies head coverage via
  a hash-aware bounded parent walk (`maxDepth`, default 256). Operators must
  provide an RPC that serves `eth_getBlockByNumber` with the `safe`/`finalized`
  tags, hex-quantity numbers and block hashes, plus `eth_getTransactionReceipt`,
  `eth_getTransactionByHash`, historical `eth_getCode` and `eth_call` (archive
  for deep history). Missing capabilities or history beyond the bound fail
  closed (TAG_UNAVAILABLE / BOUND_EXCEEDED) — never a silent pass.
- **RPC observation framing**: safe/finalized reads are observations from a
  trusted provider, NOT independent consensus reconstruction. Operational use
  should run multiple independent providers and, when material, reconcile
  disagreement (the adapter exposes `observePublicHead` for two-actual-conflict
  detection).
- **Mainnet admission remains disabled.** Public policy on chain 1 is refused
  at construction; no mainnet profile exists. The full public-chain export
  remains unsupported; E1B demonstrated the finality COMPONENT on Base Sepolia
  read-only. Any future public operation additionally requires deployment
  identity review, RPC capability confirmation, finality-policy approval and
  the standing signer/governance/audit gates.---

## 6. Phase F1 status pointer (commit `86061976` — 35 local commits ahead of origin/main `bf8c603d`)

The authoritative current overview is **`mainnet/release-candidate-gap-assessment.md`**
(Phase F1 consolidated gap table). Superseded-by-status statements in this package:

- **Custody candidate:** the v2 (`SAAXEscrowCustodyV2`) restricted OBJECTIVE_DIGITAL
  candidate exists at `contracts/SAAXEscrowCustodyV2.sol` (LOCAL ONLY, not deployed, not
  frozen, not independently reviewed) implementing the Phase-2 v2 design's restricted
  profile; advanced profiles remain disabled.
- **Dispute liveness:** the Phase-1 permanent-lock question is implemented for the
  restricted profile (final-cutoff timeout refund includes Disputed); the owner's numeric
  caps, durations, and contract-vs-service enforcement decisions remain open.
- **Worker:** the missing execution worker (D1–D3) is implemented and tested locally
  (durable acceptance, broadcast, reconcile, crash recovery, journal/outbox drain); the
  hosted lane is NOT wired (`SAAX_INTEGRATED_WORKER` off; JSON ledger remains the hosted
  default).
- **Signer:** D4A/D4B signed-byte protection + signer isolation implemented locally (AES-
  256-GCM envelope, config gates, complete signing intent); production remote/HSM/KMS
  signing and host-level isolation pending.
- **Journal:** pilot decision = hash-chain-only, head-bound, no signing-time journal-root
  binding; mainnet pre-settlement journal-head commitment UNDECIDED and requires a new
  immutable contract if adopted.
- **Finality:** funding/settlement finality component demonstrated read-only on Base
  Sepolia (SAFE 4/4, FINALIZED 4/4 via the trusted-RPC method); **anchor finality NOT
  ESTABLISHED** (only cid/digest anchor refs; no EAS attestation receipt); mainnet 8453
  BLOCKED under the explicit supported-network policy (`finality-mainnet-not-activation`).
- **Independent review/audit:** none exists; the commissioning brief is updated (Phase F1
  addendum) around the actual candidate. This package is internal planning material;
  do not push without authorization (D9).

Historical sections above (decisions D1–D9, gates G1–G14, §A–§E, phases 1–7) are preserved
as the original readiness record and are superseded only where this pointer or the Phase F1
assessment says so. No claim in this package should be read as an audit, a freeze, or a
readiness certificate.