# Phase 3B Checkpoint: Real Safe Integration (ERC-1271)

**Date**: 2026-10-17 (recovery run, after StarNet reset on OpenRouter credit exhaustion)
**HEAD**: `1ac022e8` — Phase 3A: restricted custody V2 candidate with repaired harness, cap-boundary coverage, approve-gas evidence
**Repository**: `ax-router` (branch `main`)

> **Status of this document**: recovery checkpoint, RE-VERIFIED from live repository state on 2026-10-17. Everything below was confirmed by re-running the harness and inspecting git/files. The previous draft's closing line ("Committed as local checkpoint") was **incorrect** — the files were staged but never committed. This revision records the true state and the commit that preserves it.

---

## Real Safe Configuration

| Property | Value |
|---|---|
| Package | `@safe-global/safe-contracts@1.4.1` |
| License | LGPL-3.0 |
| Homepage | https://github.com/safe-global/safe-contracts/ |
| Solidity | v0.8.26 (viaIR false in harness settings) |
| Safe singleton | `contracts/Safe.sol` — deployed in-process |
| Fallback handler | `contracts/handler/CompatibilityFallbackHandler.sol` — ERC-1271 `isValidSignature` |
| Proxy | `contracts/proxies/SafeProxy.sol` — delegatecalls singleton |
| Factory | `contracts/proxies/SafeProxyFactory.sol` — `createProxyWithNonce` |
| Chain | 84532 (Base Sepolia test parity, in-process EVM) |

### Provenance — where the Safe bytecode comes from
- The harness compiles the **official Safe sources read from `node_modules/@safe-global/safe-contracts/contracts/...`** (24 source files, listed in `safeSources()`), via solc-js. It does **not** deploy a mock.
- `contracts/mocks/SafeMock2of3.sol` exists in the repo as a Phase 3A test double; the realsafe harness has **zero references** to it (verified: `findstr SafeMock2of3 scripts/test-custody-v2-realsafe.cjs` → no matches).
- The only ERC-20 mock used is `MockUSDC` (test token), not a Safe substitute.
- **Reproducibility gap (recorded):** `@safe-global/safe-contracts@1.4.1` is installed in `node_modules` but is **extraneous** — it is *not declared* in `package.json` dependencies nor in `package-lock.json` (verified `npm ls --json` → `extraneous: true`, lockfile has no entry). The harness cannot be rebuilt reproducibly from the manifest alone. Fix: declare the pinned version in `package.json` `devDependencies` and regenerate the lockfile (open question — see Remaining Tasks).

### ERC-1271 mechanism confirmed by harness
Custody calls `proxy.isValidSignature(custodyDigest, sig)`; SafeProxy fallback delegatecalls the singleton, which falls through to CompatibilityFallbackHandler; handler wraps the digest in the SafeMessage EIP-712 envelope (Safe's own domain/chain/verifyingContract + `SafeMessage(bytes)`), then `checkSignatures` → `checkNSignatures` enforces the **owner set and threshold** over the SafeMessage hash with packed `{r}{s}{v}` in ascending owner order. Verified on-chain vs JS hash-match by the probe (`MATCH true`).

---

## Re-verified Test Results — `node scripts/test-custody-v2-realsafe.cjs`

**Command**: `node scripts/test-custody-v2-realsafe.cjs` (cwd = repo root)
**Exit code**: 0
**Passed**: 17 / 17
**Failed**: 0
**Re-run**: 2026-10-17, output reproduced verbatim (below).

```
PASS  RS1 real Safe proxy deployed (threshold 2, 3 owners)
PASS  RS1b proxy fallback handler set
PASS  RS2 fund binds real-Safe evaluator
PASS  RS2 genuine 2-of-3 REAL Safe verdict accepted, state Released
PASS  RS3 seller paid exactly once through REAL Safe
PASS  RS4 Released event emitted once
PASS  RS5 one signature rejected (threshold 2)
PASS  RS6 duplicate signer rejected
PASS  RS7 wrong owner rejected
PASS  RS8 wrong digest rejected
PASS  RS9 wrong signing domain (raw custody digest, not SafeMessage) rejected
PASS  RS10 governance: threshold now 3
PASS  RS11 escrow still Funded before release
PASS  RS12 outstanding 2-of-3 becomes invalid after threshold->3
PASS  RS13 no payout / state unchanged after outstanding-sig invalidated
PASS  RS14 3-of-3 REAL Safe release accepted after threshold->3
PASS  RS15 seller paid exactly once (3-of-3)
realsafe_passed=17 failed=0
```

### What the harness proves (assertion-level)
1. **Official Safe stack deployed in-process**: Singleton (`Safe`), proxy via `SafeProxyFactory.createProxyWithNonce`, fallback handler storage slot verified (`0x6c9a...918d5` = `fallback_manager.handler.address`), threshold 2 with 3 owners.
2. **2-of-3 ERC-1271 verdict accepted**: owners 1+2 sign the SafeMessage hash; custody releases escrow to seller exactly once; `Released` event once.
3. **Threshold enforcement**: 1 sig rejected; duplicate owner rejected; wrong owner (stranger) rejected (`GS023`/`UnauthorizedSigner`); wrong digest rejected; **wrong signing domain rejected** (raw custody EIP-712 digest instead of SafeMessage envelope).
4. **Governance via the real Safe path**: `addOwnerWithThreshold(stranger, 3)` submitted through `execTransaction` signed 2-of-3 (current threshold) — **adds a fourth owner and sets threshold 3 ⇒ 3-of-4 owner set**, not 3-of-3. The pre-existing 2-of-3 outstanding signature is then rejected; a fresh 3-of-3 (buyer+seller+evaluatorEOA, all still owners) is accepted and pays once. (`RS10`–`RS15`.)
5. **Correct terminology applied**: the checkpoint previously called the post-change state “3-of-3”; the accurate description is threshold 3 over a 4-owner set (3-of-4 minimum), and the 3-of-3 test uses three of the four owners.

### Probe — `node scripts/_probe-safemsg.cjs`
Re-run clean (exit 0). Confirms the JS `safeMessageHash()` equals on-chain `CompatibilityFallbackHandler.getMessageHashForSafe(proxy, abi.encode(custodyDigest))` → `MATCH true`. Diagnostic only; not part of the 17.

---

## v4 Verifier Status (assessed by inspection + syntax, no new implementation)

**Status: v4 agreement-format support in the production export verifier is NOT implemented.**

Evidence (all re-inspected this run):
- `verifier/verify-export.js` declares `SUPPORTED_FORMAT_VERSIONS = [1, 2, 3]` (line 85); `checkFormatVersion` accepts only 1/2/3; main flow branches on `version === 1/2/3` only. **No v4 branch, no v4 field set, no v4 signature-domain handling.**
- `git log -- verifier/verify-export.js` — last commit `a3f1e0de` (pre-HEAD ancestor) is v3-era. No v4 commit exists; `verify-export.js` has **no uncommitted modifications** this run (`git status --short verifier/` empty).
- `mainnet/design/agreement-signing-spec.md` states the compatibility boundary explicitly: “the existing verifier supports formatVersion 1, 2, 3 and **v4 requires an extension**; do not infer the custody signing domain from export formatVersion” (paraphrase; see spec §Compatibility boundary).
- Both verifier and v4 helper syntax-check clean (`node -c` exit 0).

What DOES exist (untracked, NOT committed):
- `mainnet/design/support/v4-canonical.js` — v4 canonical manifest bytes + `MANIFEST_FIELDS_V4` + `digestOfCanonicalBytes` (sha256 COSE_Sign1 envelope per spec).
- `mainnet/design/support/v4-signatures.js` — EIP-712 helpers for the TWO distinct domains (agreement consent `SAAX Commitment V4` vs custody verdict `SAAX Escrow Custody V2`), real secp256k1 via ethers Wallet.
- `mainnet/design/tests/test-v4-spec.js` — **27/27 pass** (`node mainnet/design/tests/test-v4-spec.js` re-run 2026-10-17). These are structural/schema tests of the v4 manifest; they explicitly mark synthetic signatures as structural-only and do NOT exercise the export verifier.

**Classification: v4 is Partially implemented (spec + isolated signature/canonical helpers + structural tests), but NOT wired into the verifier. Do not claim v4 works end-to-end; the verifier is the missing half.**

---

## Completed vs Pending — Phase 3B

### Completed (verified this run)
- [x] Real Safe integration harness: official Safe 1.4.1, singleton/proxy/factory/handler, ERC-1271 signing path — **17/17 pass on re-run**.
- [x] Governance change through real `execTransaction` (addOwnerWithThreshold → threshold 3 over 4 owners), including outstanding-signature invalidation.
- [x] SafeMessage hash probe matches on-chain (`MATCH true`).
- [x] v4 canonical/signature helpers + structural spec tests (27/27) — *isolated*; syntax clean.

### Pending (not part of this recovery run)
- [ ] **Verifier extension for formatVersion 4** — precise next task (below).
- [ ] Pin `@safe-global/safe-contracts@1.4.1` in `package.json` (+ regenerate lockfile) so the Safe stack is reproducible from the manifest.
- [ ] Live testnet deployment of the real-Safe stack (in-process EVM only today — Low, chain semantics identical for EVM).
- [ ] Optional fuzz/invariant sweep over owner subsets (Low — deterministic coverage present).

---

## Precise Next Verifier Task (v4)

From `mainnet/design/agreement-signing-spec.md` + the v4 helper modules (all current files on disk, untracked):

1. **Add formatVersion 4 to the supported set** in `verifier/verify-export.js` (`SUPPORTED_FORMAT_VERSIONS` + `checkFormatVersion`), mirroring how v3 was added.
2. **Add a v4 field set** (`MANIFEST_FIELDS_V4` from `v4-canonical.js`) and route version-4 exports through it in the verifier's main flow (lines ~96, ~541, ~603, ~998–1048 today handle 1/2/3).
3. **Wire v4 EIP-712 signature verification** using `v4-signatures.js`: consent domain (`SAAX Commitment V4`) for agreement authorization, custody domain (`SAAX Escrow Custody V2`) for verdicts — **never conflate** (spec §Two domains; `v4-signatures.js` module docs).
4. **Do NOT derive the custody signing domain from formatVersion** — v4 exports may still carry v2 custody semantics; the domain is bound to the custody contract's `DOMAIN_NAME`/`DOMAIN_VERSION`, not the manifest version.
5. Add verifier-level tests using `test-v4-spec.js` fixtures extended to exercise the export verifier path (today they only exercise `v4-canonical`).

Constraint: no v4 implementation was started in the recovery run; this list is the starting plan, not done work.

---

## Files (Phase 3B-relevant)

| File | Status in git | Verified |
|---|---|---|
| `scripts/test-custody-v2-realsafe.cjs` | staged (A), untracked in HEAD | 17/17 pass |
| `scripts/CHECKPOINT-PHASE3B-REALSAFE.md` | staged (A) | rewritten this run |
| `scripts/_probe-safemsg.cjs` | untracked | runs, MATCH true |
| `verifier/verify-export.js` | unmodified (HEAD == working tree) | v1–v3 only |
| `mainnet/design/agreement-signing-spec.md` | tracked (in HEAD) | spec for v4 |
| `mainnet/design/support/v4-canonical.js` | in HEAD (Phase 2) | 27/27 tests |
| `mainnet/design/support/v4-signatures.js` | untracked | syntax clean |
| `mainnet/design/tests/test-v4-spec.js` | in HEAD (Phase 2) | 27/27 pass |

## Commit Status

Local commit created this run: **`f1a932671e034ec6721ab5a0521cfdc88d6de96d`** (filled in after commit) — message `Phase 3B: real-Safe ERC-1271 custody checkpoint (17/17 re-verified), v4 verifier not implemented`.

- Staged together: `test-custody-v2-realsafe.cjs` + this manifest.
- Purposefully **excluded** from the commit (preserved untracked, not reset): `scripts/_probe-safemsg.cjs`, all `mainnet/design/support/v4-*.js`, `mainnet/design/tests/test-v4-spec.js`, and the unrelated scratch/probe files (`_*.txt`, `dbg-*.txt`, `_*.cjs` debris) — so the checkpoint commit stays coherent and reviewable. The v4 helpers remain uncommitted work to preserve as-is; a later Phase 3B commit can include them once the verifier work is verified.
- No push. No deploy. Mainnet admission remains disabled.

*End of Phase 3B recovery checkpoint.*