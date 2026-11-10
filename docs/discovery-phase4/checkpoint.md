# SAAX Discovery Phase 4 — Durable Checkpoint (gap closure + public deployment)

**Date:** 2026-11-06 · **Repo:** `solvent-applied-saax-protocol` (ax-router) · **Base HEAD:** `8b98c73d` (verified) · **Current HEAD:** see git log.

## Gap closure (four Phase-4 gaps resolved + deployment path)

### 1. Single-writer ownership (Gap 1) — `endpoint/acceptance-store.js`
- Replaced the age-based stale-lock reclaim ("reclaim if older than 5 min") with a **renewable lease + fencing** model:
  - A lock is broken ONLY on **proven death on this host** (pid not alive) with a **PID-reuse guard** (the lock records `ownerStartedAtMs`; a dead pid whose current process started AFTER the lock was written is treated as recycled → reclaim DEFERRED).
  - Unknown/remote-host locks are never reclaimed (conservative).
  - The owner **renews** the lock every `RENEW_INTERVAL_MS` (60 s) and **every journal write re-checks** the lock still names this pid+writerId (fencing → `DSC_STORE_NOT_OWNER` on loss).
  - `releaseLock` only deletes the lock if it still belongs to this process (a stale owner cannot delete a successor's lock).
  - Concurrent recovery is guarded by an O_EXCL **recovery-intent marker** → at most one writer.
- Tests: `tests/discovery-phase4/test-gap1-ownership.cjs` — **28/28** (healthy owner beyond old threshold; second process refused; proven-death recovery; concurrent recovery ≤ 1 writer; stale owner can't delete successor lock or write after loss; remote-host conservative; recycled-pid deferred; renewal keeps lease current).

### 2. Independent verifier SR version dispatch (Gap 2) — `verifier/verify-export.js`
- Added `srVerify(exportObj, { publicJwk })`: REAL jose `compactVerify` of the **export-carried** JWS (never a caller-supplied different JWS) with kid binding; enforces:
  - SR version pinning + downgrade rejection (`manifest-v1.1+saax-proposal-bound` only),
  - provider identity against the configured trusted public JWK (never derived from the export),
  - exact commitmentId / manifestDigest / proposalId / proposalDigest bindings,
  - complete terms (price amount/currency, parties, capability, acceptanceCriteria),
  - policy versions (profileVersion + manifestVersion) authenticated in the SR payload (added to the core signer),
  - evaluator authority where the profile requires it (an "issuance-only" declaration does NOT suppress it),
  - buyer acceptance binding the exact proposal digest + terms digest (a valid provider JWS alone is never sufficient).
- `main()` guarded behind `require.main === module` (import-safe).
- Tests: `tests/discovery-phase4/test-gap2-verifier.cjs` — **10/10** incl. separate-process CLI verification.

### 3. Explicit financial terms (Gap 3) — `preflight-core.js`, `acceptance-core.js`, schemas
- `supportedCombinations` now carry **`settlementCurrency` + `settlementDecimals` + `financialTerms`** (`financial` | `nonfinancial` | `rail-neutral`). Schema updated (`profile.schema.json`, `proposal.schema.json`).
- Preflight: financial combo **must** declare currency+decimals (else `DSC_INVALID_COMBINATION` — no silent USDC default); nonfinancial/rail-neutral must NOT carry a currency.
- Proposal terms carry the explicit `currency`/`decimals`/`financialTerms` (authenticated into the signed payload).
- Acceptance revalidation rejects: currency substitution, missing decimals, currency in a nonfinancial proposal, and nonfinancial→financial profile drift (fresh proposal+acceptance required).
- Numeric conversions remain integer-string lossless (no float, no rounding).
- Tests: `tests/discovery-phase4/test-gap3-financial-terms.cjs` — **19/19**.

### 4. Crash-to-completion recovery (Gap 4) — `endpoint/discovery-recovery.js`
- New reconciliation engine: after a crash, a replacement process scans `accepted` operations and either returns the **existing** commitment (already `commitment_created`) or **completes the SAME intended issuance exactly once** (same operation id, same commitment id, same manifestHash, same signedRepresentation — rebuilt deterministically from the persisted record; never regenerated content).
- Real process-kill tests (SIGKILL at the acceptance-persisted and post-issuance points) + startup reconciliation + independent export verification.
- Tests: `tests/discovery-phase4/test-gap4-recovery.cjs` — **18/18** (real kills, single commitment, truthful status, separate-process export verify).

### 5. Supabase-backed stores (Gap 5) — deployment path
- The fs journal is single-host-only; Vercel is ephemeral multi-instance, so the durable DB is the deployment store.
- Migrations applied to the LIVE project (`codboejrwohkjidrrcgl`): `public.discovery_acceptance_operations` + `public.discovery_proposals` (RLS enabled, zero policies) + SECURITY DEFINER RPCs (`discovery_acceptance_persist/transition/get_by_idempotency/get_by_proposal/list_pending`, `discovery_proposal_persist`) granted EXECUTE to **service_role only** (the `ax_router` schema is NOT exposed to PostgREST — PGRST106; `public` is).
- JS adapters: `endpoint/supabase-acceptance-store.js`, `endpoint/supabase-proposal-store.js` (drop-in interfaces; unique constraints = cross-instance decision points).
- Tests: `tests/discovery-phase4/test-gap5-supabase-store.cjs` (20/20), `tests/discovery-phase4/test-gap5b-supabase-proposal-store.cjs` (6/6).
- Verified against the live DB: single-use proposal raises the unique violation (DSC_PROPOSAL_REUSED); same-key duplicate returns the existing row; transition + pending scan work.

## Public deployment (Vercel)

- **Project:** `ax-router` (Vercel, org `bryant-s-projects5`), production alias **https://saax-protocol.com**.
- **New function:** `api/discovery.mjs` serving:
  - `GET /.well-known/saax.json` — signed live standalone discovery profile (live operator key `live-2026-11`),
  - `POST /prepare-commitment` — free nonbinding preflight (Supabase proposal store),
  - `POST /accept-commitment` — buyer acceptance -> one authenticated commitment (Supabase acceptance store).
- **MCP:** `api/mcp.mjs` also now prefers the live signed profile + operator key and the Supabase stores (HTTP/MCP parity).
- **Secrets (Vercel prod):** `SAAX_OPERATOR_PRIVATE_JWK` (live operator private key, never committed), `SAAX_BUYER_REGISTRY_JSON` (configured buyer key trust).
- **ESM fix:** `endpoint/discovery-crypto.js`, `acceptance-crypto.js`, `acceptance-core.js`, `discovery-resolver.js` no longer top-level `require('jose')` (jose v6 is ESM-only on Vercel) — lazy `import('jose')` + local base64url helpers.
- **vercel.json:** rewrites for the three discovery paths.

## Live verification (all green)

| Interface | Result |
|---|---|
| `GET https://saax-protocol.com/.well-known/saax.json` | 200, live operator key, expires 2027-11-06 |
| `POST /prepare-commitment` | 200 signed proposal (USDC/6/financial); duplicate same-nonce → same proposal |
| `POST /accept-commitment` | 201 one commitment (`0xf87e4b...`, `0x546b4b...`); identical retry → 200 duplicate SAME cid; new-key reuse → 409 `DSC_PROPOSAL_REUSED`; unregistered buyer → 401 |
| Supabase rows | `commitment_created`, authenticated terms + acceptance ref + SR version; NO payment/escrow/custody/execution/release fields |
| SR independent verify | JWS verifies with live operator key; binds commitmentId + proposalId; price + versions authenticated |
| MCP `/mcp` | init OK (saax-protocol 1.0.3), 13 tools incl. prepare_commitment/accept_commitment, ping ok, invalid args typed, valid preflight ok with LIVE provider identity |

## Regression totals (all green)

- run-phase4-tests 67/67 · gap1 28/28 · gap2 10/10 · gap3 19/19 · gap4 18/18 · gap5 20/20 · gap5b 6/6 · phase3 68/68 · phase2 26/26 · conformance 94/94 · schemas 14/14.

## Remaining limits (explicit, not claimed)

- **Trust:** live path is a CONFIGURED-KEY trust path — clients must install the live operator public key (thumbprint `KebjwLFLSV6LJFZ_Hp7ROBkVpHVBwrFNRgHkAQ5JldM`, keyId `live-2026-11`) before they authenticate the profile. NOT permissionless identity verification; DID/registry/prior-pinned unsupported.
- **Rollback:** Vercel deployment history + `vercel rollback <deployment-url>`; the previous production deployment is listed in the Vercel dashboard. Secret removal via `vercel env rm`.
- **Key rotation:** generate a new keypair (`scripts/_provision-live-operator.cjs`), update `SAAX_OPERATOR_PRIVATE_JWK`, re-sign the live profile, and redeploy; clients re-install the new thumbprint.
- **No financial execution:** proposals/commitments carry authenticated financial TERMS but trigger NO payment, custody, escrow, execution, or release. Financial integration (immediate x402 payments, prefunded escrow distinct) is the NEXT phase and needs its own spending authorization.

## Next executable steps (financial integration)

1. Map proposal/acceptance/commitment identity into the existing settlement + custody bindings (x402 challenge, escrow custody V1).
2. Wire the commitment's authenticated terms (currency/amount/decimals) into a spend-binding check (checkSpendBinding) before any payment is authorized.
3. Testnet-only tests (Base Sepolia, test USDC) for the full lifecycle; then a new spending authorization for mainnet.
4. Optional: live availability probing (checked.currentAvailability: true) and A2A JSON-RPC interface.

## LUMIYOU / Victoria's Vision

Untouched. Staged diffs contain zero lumi/victoria paths; pre-existing dirty working-tree files preserved unmodified; no private key material committed (operator + buyer private keys live only in `.output/.live-operator/` and Vercel secrets; both gitignored).## Post-hoc release-evidence corrections (2026-11-06, Discovery→Testnet integration run)

### Commit accounting (Release Check A)
- **Claimed:** "eight commits" in the Phase-4 deploy window.
- **Actual (verified `git rev-list --count 8b98c73d..5345b53f`):** **9 commits** —
  1. `d4c1a6aa` gap closure: single-writer lease+fencing, SR verifier dispatch, explicit financial terms, crash-to-completion recovery
  2. `9b189a47` Supabase-backed acceptance store (cross-instance idempotency + recovery) with contract tests
  3. `7b2c388d` deploy nonfinancial discovery/preflight/acceptance interfaces (Vercel functions, Supabase store, live signed profile)
  4. `a22cdb52` lazy-import jose in CJS crypto modules for Vercel ESM runtime
  5. `1bba0457` remove remaining top-level jose requires (acceptance-core, discovery-resolver)
  6. `f7da8a7d` Supabase-backed proposal store for cross-instance preflight idempotency
  7. `4a1844bc` point Supabase stores at exposed public schema RPCs (PGRST106 fix)
  8. `4b78df10` MCP provider ref prefers live signed profile + operator key
  9. `5345b53f` deployment docs/checkpoint update + live verification scripts
- **Correction applied:** this entry replaces the erroneous "eight" count. Base `8b98c73d` (Phase 4 core) excluded from the window.

### Dirty verifier policy (Release Check B)
- **Claimed:** pre-existing dirty `verifier/v4-eas-policy.json` might have influenced committed-state verification, the deployed package, or verifier results.
- **Actual (verified):** working-tree blob hash `af9d587140c2bb232a53fa091f464407cdf274e1` **equals** the committed blob (`git ls-files -s` and `git rev-parse HEAD:verifier/v4-eas-policy.json` agree); `git diff HEAD -- verifier/v4-eas-policy.json` = 0 lines. The ` M` flag is a `core.autocrlf=true` stat-cache artifact (warning: "LF will be replaced by CRLF").
- **Conclusion:** zero content difference → **no influence** on any reported verification, the deployed release package, or independent-verifier results. No re-run of affected checks is necessary; the file remains untouched (not discarded, not committed).## Testnet financial integration checkpoint (2026-11-06, Discovery→Testnet run)

### Release checks (A–D) — all resolved
- **A. Commit accounting:** `git rev-list --count 8b98c73d..5345b53f` = **9** (not 8). The deployment window contains exactly 9 commits (d4c1a6aa → 5345b53f). Corrected; the checkpoint above and this entry are the authoritative record.
- **B. Dirty verifier policy:** `verifier/v4-eas-policy.json` working-tree blob `af9d5871...` is byte-identical to the committed blob (verified via `git hash-object` vs `git rev-parse HEAD:`); `git diff HEAD` = 0 lines. The ` M` is a `core.autocrlf` stat artifact → **no influence** on any committed-state verification, the deployed package, or verifier results.
- **C. Trust onboarding:** documented in `docs/discovery-phase4/trust-onboarding.md`. The configured-key path is demonstrated: valid trusted key authenticates; valid untrusted key does NOT; rotation requires the new thumbprint installed; tampered card → no fallback. Thumbprint must arrive out-of-band (second channel), never from the profile itself.
- **D. Complete verifier:** `verifier/verify-export.js` CLI now dispatches discovery exports (`formatVersion=4` + `commitment.signedRepresentation`) through `srVerify` PLUS `validateAcceptance`, all in a SEPARATE process without app DB access. Proven: `tests/discovery-phase4/test-checkd-cli.cjs` — VERIFIED on a fresh export, NOT VERIFIED + exit 1 on tampered SR JWS. (Gap closed: the CLI previously never ran `srVerify`.)

### Financial integration (testnet-isolated, proven)
- `endpoint/financial-handoff.js` — one core orchestrator (immediate x402 + prefunded escrow V1): chain 84532 enforced at every submitter; one canonical integer-string amount; spend binding + currency↔asset binding; buyer acceptance ≠ payment authorization ≠ release verdict; durable-accept/reconcile discipline; zero side effects on rejection.
- `scripts/_testnet-financial-flow.cjs` — **21/21**: discovery commitment → payment requirements → escrow fund (state=1) → chain-read binding verify → evaluator EIP-712 verdict release (state=3 Released) → refund path → tamper/expiry fail-closed → spy-proven zero side effects.
- The harness deploys the DEPLOYED artifact bytecode (`data/escrow-custody-build.json`, sha256 `5c1d779d`) so the proof matches the on-chain runtime at `0x5a5472...` (Base Sepolia 84532).
- **Blocker (release evidence):** the artifact bytecode does NOT byte-match a fresh compile of `contracts/SAAXEscrowCustodyV1.sol` at HEAD (`72da21ed`, 2 bytes shorter). Must reconcile (recompile+redeploy with identity change, or pin the exact source revision) before real testnet broadcast.
- **Blocker (operator):** test EOA private keys (`SAAX_TEST_BUYER_KEY`, `SAAX_SIGNER_PRIVATE_KEY`, `SAAX_X402_PRIVATE_KEY`) not present in this environment → on-chain broadcast is documented in `docs/discovery-phase4/testnet-runbook.md` §2; everything else is proven.

### Regression totals (all green)
Phase-4 67/67 · gap2 10/10 · checkd 2/2 · Phase-3 68/68 · Phase-2 26/26 · conformance 94/94 · schemas 14/14 · testnet-financial 21/21.

### Next executable steps
1. Operator provisions test EOA keys; run `scripts/_testnet-financial-flow.cjs --live` with RPC `https://sepolia.base.org` (chain 84532 enforced).
2. Reconcile custody artifact/source bytecode (recompile+redeploy with documented identity, or pin source revision) — release blocker.
3. Then: mainnet readiness assessment (needs separate authorization; this task is testnet-only).