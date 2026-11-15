# Chain Identity Resolution — Decision Doc

Status: DESIGN ONLY (inspection + proposal). No config, code, contract, fixture, or evidence changed this run.
Baseline: 14adfac8. The deployment blocker "conflicting chain declarations (local Hardhat 84532 vs candidate identity)" is carried in `mainnet/design/v4-verifier-check-map.md:184-185,284-285` and `mainnet/design/phase3b-v4-checkpoint.md:95-97`. This document characterizes that conflict and proposes a resolution for owner approval.

## 1. The declared identities — full inventory

### Chain ID literals

| File:line | Value | Context |
|---|---|---|
| `endpoint/gateway.js:75-78` | `BASE_SEPOLIA_CHAIN_ID = 84532`; `ACTIVE_CHAIN_ID = Number(process.env.SAAX_CHAIN_ID || 84532)` | Runtime: default chain is 84532 (Base Sepolia); 8453 only when env overrides |
| `endpoint/gateway.js:80-108` | `ACTIVE_CHAIN_ID === 8453` branches | USDC address, RPC, network name, block explorer switch between mainnet/testnet |
| `handoff-staging/endpoint/gateway.js:58` | `BASE_SEPOLIA_CHAIN_ID = 84532` | Same legacy constant in the staging copy |
| `hardhat.config.js:4,27` | `chainId: 84532` | **Local in-process Hardhat EVM chain ID** — a test fixture chain |
| `endpoint/escrow.js:87,232` | `'eip155:84532'` | Default CAIP-2 network for funded escrow reads |
| `endpoint/escrow.js:453-473` | `chainId !== 84532` → `UNSUPPORTED_CHAIN` | **Chain guard** — refuses any RPC-resolved chain ≠ 84532; reads `eth_chainId` live |
| `endpoint/escrow-access.js:78,191-192` | `chainId: 84532`; rejects `!= '84532'` | Access-authorization payload chain lock (EIP-712 `EscrowAccess` field) |
| `endpoint/eas.js:37` | `const CHAIN_ID = 8453; // Base mainnet` | EAS path hardcodes **mainnet 8453** while `.js:350` connects provider with `84532` — internally inconsistent |
| `endpoint/eas.js:350` | `new JsonRpcProvider(rpc, 84532)` | EAS client network set to 84532 |
| `endpoint/x402.js:60` | `NETWORK_CAIP2 = { base: 'eip155:8453', ... }` | x402 immediate-payment lane maps `base` → **mainnet 8453** |
| `endpoint/rails/mpp.js:51` | `ACTIVE_CHAIN_ID = gateway... \|\| 84532` | MPP rail defaults 84532 |
| `handoff-staging/endpoint/rails/mpp.js:41` | `BASE_SEPOLIA_CHAIN_ID = 84532` | Staging copy |
| `endpoint/feedback.js:166-168,307` | `'eip155:8453'` registry; `chainId: 8453` | Feedback/reputation reads mainnet registry |
| `endpoint/route-server.js:508-530` | `eip155:8453` comments; asset/network from gateway | Self-shape comments reference mainnet |
| `conformance/vectors/**` (many) | `chainId: 8453` | Published conformance vectors use **mainnet 8453** chain IDs |
| `mainnet/admission/validator.js:340-341,406,438` | `![8453,84532].includes(...)`; mainnet gate at 8453 | Admission validator accepts both; final admission requires 84532 |
| `mainnet/design/support/v4-canonical.js:139` | `![8453,84532].includes(c.chainId)` | v4 canonical schema accepts both |
| `data/escrow-access-ledger.json:11,69,77` | `"chainId": "84532"` | Durable access ledger records 84532 |
| `hardhat.config.tmp.js` (untracked scratch) | `chainId` | Scratch, not committed |

### Chain name strings

| File:line | Value | Context |
|---|---|---|
| `endpoint/gateway.js:101-102` | `name: 'Base'/'Base Sepolia'`; `network: 'base'/'base-sepolia'` | Active network naming |
| `mainnet/mainnet-escrow-readiness.md:12,45,53` | `Base Sepolia 84532` / `Base mainnet 8453` | Docs: both chains described |
| `pilot/common` | `base-sepolia` | Pilot config names testnet |
| `spec/**` | `base-sepolia` | Spec names |

### RPC URLs

| File:line | Value | Context |
|---|---|---|
| `.env.example:40` | `SAAX_BASE_SEPOLIA_RPC=https://sepolia.base.org` | Testnet RPC documented |
| `.env.example:66` | `SAAX_RPC_URL=https://base-rpc.publicnode.com` | Generic RPC default |
| `endpoint/gateway.js:83` | `'https://sepolia.base.org'` (default when not 8453) | Runtime testnet RPC |
| `pilot/hosting-plan-base-sepolia.md:21` | `https://sepolia.base.org` | Testnet deployment RPC |
| `daily-logs/saax-rail-neutral-commitment.md:341` | `base-rpc.publicnode.com` default; `sepolia.base.org` verified | History |

### EIP-712 domains (chainId is a chain identity declaration)

| Domain | Name/Version | chainId source | Where |
|---|---|---|---|
| Agreement consent (v1-v3) | `SAAX Commitment Authorization` v1, `SAAX Commitment Journal` v1 | Fixed 84532 in `verifier/verify-export.js:525-526,737` | Legacy verifier hardcodes **84532** |
| Custody verdict (V1) | `SAAX Escrow Custody V1` v1 | `verifier/verify-export.js:656,737` — `chainId: 84532` hardcoded; contract binds chainId at construction | EIP-712 EscrowVerdict |
| Custody verdict (V2 candidate) | `SAAX Escrow Custody V2` v2 | `mainnet/design/support/v4-signatures.js:29-36` — `custodyDomain(verifyingContract, chainId, ...)` — **chainId passed in, not hardcoded** | v4 verdicts |
| Agreement consent (v4) | `SAAX Commitment V4` v4 | `v4-signatures.js:42-46` — `agreementDomain(verifyingContract, chainId)` — chainId passed in | v4 parties |
| Anchor auth | `SAAX V4 Anchor Authorization` v1 | `verifier/v4-anchor.js:19` — `chainId: a.chainId` from anchor record | v4 EAS anchor |
| Access auth | `EscrowAccess` (domain name implicit) | `endpoint/escrow-access.js:78,191` — fixed **84532** | Runtime access path |
| EAS schema | (registry) | `endpoint/eas.js:37,350` — **8453 vs 84532 internal conflict** | EAS |

### Contract deployment records

| Contract | Address | Chain | Recorded at |
|---|---|---|---|
| Testnet custody C5 (current) | `0x5a5472d751839cd4968cbf1b136baf862279ff5d` | **Base Sepolia 84532** | `audit/custody-review-phase5.md:6`, `pilot/hosting-plan-base-sepolia.md:24`, `mainnet/mainnet-escrow-readiness.md:49` |
| Older custodies C76, F85 | `0x76cce76caf...77ae`, `0xf85abb3bcd...6ce6` | Base Sepolia 84532 | `audit/custody-review-phase5.md:7` |
| Mainnet USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Base mainnet 8453 | `daily-logs/saax-mainnet-activation.md:15` |
| Testnet USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Base Sepolia 84532 | `pilot/hosting-plan-base-sepolia.md:26` |
| EAS/registry | `0x420000...21` / `...20` | Base Sepolia 84532 | `daily-logs/saax-rail-neutral-commitment.md:418,842` |
| Mainnet EAS SchemaRegistry | `0x420000...21` (standard deployer proxy) | Base mainnet 8453 | `daily-logs/saax-rail-neutral-commitment.md:341` |

### Verifier chain checks

| File:line | Compares |
|---|---|
| `endpoint/escrow.js:468-473` | RPC-resolved `eth_chainId` must === 84532; **refuses anything else**; `SAAX_ESCROW_ALLOW_MAINNET` no longer overrides (per `mainnet/mainnet-escrow-readiness.md:60`) |
| `verifier/verify-export.js:424-435` | Reads live RPC `eth_chainId`, compares to declared `anchor.chainId` — **parametrized**, not hardcoded |
| `verifier/verify-export.js:526,737` | Legacy journal + verdict domains **hardcode 84532** |
| `verifier/verify-v4.js:85-88` | Compares signed agreement `custody.chainId` to the rpc's chain — **parametrized** |
| `verifier/v4-anchor.js:30-33` | Anchor `chainId` must equal agreement custody chainId AND policy chainId (both currently 84532); live RPC must match |

### Docs statements

| Where | Statement |
|---|---|
| `mainnet/mainnet-escrow-readiness.md:12,45,53` | Immediate-payment mainnet lane on 8453; escrow custody testnet-only on 84532; production `.env` = 8453, escrow-backed **off** |
| `mainnet/design/v4-verifier-check-map.md:184-185,284-285` | The blocker as carried: "conflicting chain declarations (Hardhat local 84532 vs candidate identity)" |
| `mainnet/design/phase3b-v4-checkpoint.md:95-97` | Deployment policy `local-official-eas-1.7.1-v1` chainId 84532 local Hardhat, NOT public Base Sepolia |
| `pilot/external-testnet-pilot-readiness-addendum.md:13-16` | Production surface is 8453 mainnet; escrow path requires 84532 + custody + backed=1 |

## 2. The conflict characterized

### Identity table (declared → where → use → conflict → breakage)

| Declared identity | Where | Used for | Conflicts with | Breaks if this side wins |
|---|---|---|---|---|
| **84532 as local Hardhat EVM** | `hardhat.config.js:4,27`; `phase3b-v4-checkpoint.md:95` | Local contract tests (custody V2 candidate, Safe, EAS anchor) | Shares the numeric chain ID with real Base Sepolia | Testnet reads mis-verified locally; signatures for "84532" ambiguous between local EVM and real testnet |
| **84532 as Base Sepolia** | `endpoint/escrow.js:472`; `endpoint/escrow-access.js:191`; `pilot/hosting-plan-base-sepolia.md` | Deployed custody C5/C76/F85, USDC testnet, EAS testnet, access auth, ledger | Shares the numeric chain ID with the local EVM | A verifier reading Base Sepolia cannot distinguish a signature made for the local EVM |
| **8453 as Base mainnet** | `endpoint/gateway.js:80-108`; `endpoint/x402.js:60`; `feedbacks.js:307`; `.env` (prod) | Immediate-payment lane, registries, conformance vectors | Production immediate-payment chain (by design separate) | Not a conflict per se; it is the mainnet lane. The conflict is that some **docs and comments** present mainnet-8453 as the deployment target while escrow is testnet-only |
| **8453 in conformance vectors** | `conformance/vectors/**` | Published test vectors | Vector chainId (8453) vs verifier default domain (84532) | Vectors and a chain-guarded verifier would disagree if the verifier enforced its own domain chain against vector data |

### The "local Hardhat 84532" declaration
It lives in `hardhat.config.js:4,27` (and the scratch `hardhat.config.tmp.js`). It is a **test-fixture chain ID**: a real Hardhat in-process EVM configured to present chainId 84532 so that local contract tests (custody V2, Safe singleton, EAS anchor) exercise the same chain ID the deployed testnet uses. It is NOT a real chain that exists off-box. It is the same category as the v3 test fixture chain — a numbered EVM for tests. The fix category is therefore **test-fixture chain selection**, not production config.

### The "candidate identity"
The docs never name it. The candidate identity is **Base Sepolia (84532) as a public chain**: the deployed testnet custody C5, testnet USDC `0x036CbD…CF7e`, EAS schema registry `0x420…21`, and the whole escrow-backed runtime that the pilot intends to host. So the conflict is precisely:

**84532 is overloaded.** The local Hardhat EVM claims 84532 for tests and the Base Sepolia testnet claims 84532 for real deployment. They are different chains with the same numeric ID. The EIP-712 domains sign against the number 84532 in both cases, so a signature produced for the local EVM is cryptographically valid against the same domain/chainId/verifyingContract as one produced for Base Sepolia — the domain cannot distinguish them because the verifyingContract (custody address... which IS different) — see §2.3.

### Runtime vs configuration-surface
**This is a configuration-surface conflict, not a runtime conflict — with one real runtime exception.**
- The runtime path is deterministic: `endpoint/escrow.js:468-473` reads the **live RPC-resolved chain**; a local Hardhat EVM answers 84532, Base Sepolia answers 84532 — and the code compares against the number. The running instance always resolves one chain deterministically. Nothing in the runtime tries to be two chains at once.
- The **configuration surface** is where declarations disagree: `endpoint/eas.js:37` (8453) vs `eas.js:350` (84532); conformance vectors (8453) vs verifier default domain (84532); the "testnet-only" guard (84532) vs production `.env` (8453); v1-v3 verifier hardcoding 84532 vs v4 parametrized chainId.
- **The real runtime exception:** `verifier/verify-export.js:737` hardcodes the verdict domain `chainId: 84532` regardless of which chain the export was produced on. A v1-v3 export whose anchor/verdict was truly signed for another 84532-externally-identical chain (the local EVM) would be verified as if it were Base Sepolia. That is a silent verification-failure surface — the domain's chainId is the same *number* but the verifyingContract is the custody address, which **does** differ between local (deployed in the EVM at an address) and testnet. The domain separation still partially holds via verifyingContract — but the verifier does not check the custody address against a deployment record; it trusts the export. So the *domain* cannot alone prove "Base Sepolia vs local EVM" — that's the design gap.

### EIP-712 domains vs deployed testnet custody
- v4 (`v4-signatures.js`) and v4 verifier/anchor: **chainId is parametrized** and currently equals the agreement's `custody.chainId` = 84532. The v2-candidate custody domain `SAAX Escrow Custody V2`/2 with chainId 84532 matches the Base Sepolia deployment's number. **For local tests the SAME 84532 is used against the local EVM** — the domain matches by number, and the verifyingContract differs (local custody address vs C5). So: **the domains match the deployed testnet custody by number; they are not distinguishable from the local EVM by chainId alone.**
- v1-v3 legacy (`verify-export.js:737`): verdict domain **hardcodes** 84532 — matches the deployed testnet custody's chain by number; same overloading caveat.
- Conclusion: the EIP-712 domains sign against 84532, which **matches** the deployed testnet custody C5's chain. The silent-failure risk is not chainId mismatch — it is **chainId overloading**: a signature for the local EVM is indistinguishable by chainId from a signature for Base Sepolia, so the verifier must bind the domain's verifyingContract to a **known deployment record** (custody address allowlist per chain), which it currently does not.

## 3. Proposed resolution

### Recommended identity for the pilot's hosted deployment
- **Chain ID: 84532**
- **Chain name: Base Sepolia**
- **RPC: https://sepolia.base.org**
- **EIP-712 domain chainId: 84532** — all signing helpers (v4 agreement, v4 custody verdict, v4 anchor, legacy v1-v3 verdict/journal) sign with chainId 84532, and every deployed custody address comes from the committed deployment record.
- This is the **current de-facto answer**; the resolution is to make every declaration *name* it as Base Sepolia (public testnet) and stop presenting the local EVM as the same chain.

### Recommended identity for local development
- **Chain ID: use a distinct local EVM chain ID** (e.g. 31337, one of the literals listed in the brief and present in the repo's scratch oddly — 31337/0x7a69 is not claimed anywhere in committed code; both 0x14a34=84532 hex and 0x2105=8453 hex are the hex encodings of 84532/8453).
- State it: the local Hardhat EVM should present a chain ID that is **not** 84532, so local test signatures can never be mistaken for testnet signatures.
- How the runtime distinguishes local from testnet: **explicit env flag + chain ID pair**. `SAAX_CHAIN_ID=31337` + `SAAX_NETWORK=local` selects the local EVM; `SAAX_CHAIN_ID=84532` + `SAAX_NETWORK=base-sepolia` selects testnet. The chain guard (escrow.js:472) and the v4 verifier (verify-v4.js:85-88) already compare the RPC-resolved chain against config — they would enforce the distinction automatically once the local chain is not 84532.

### What changes (list only — NOT made this run)
1. `hardhat.config.js:27` — local EVM `chainId: 84532` → distinct local ID (e.g. 31337).
2. `mainnet/design/phase3b-v4-checkpoint.md:95` — deployment-policy chainId 84532 → local ID; name the policy `local-official-eas-1.7.1-v1` with the local chain ID.
3. `mainnet/design/v4-verifier-check-map.md:184-185,284-285` — update the blocker statement: 84532 = Base Sepolia public testnet; local EVM uses its own ID; the conflict is resolved by the split.
4. `endpoint/eas.js:350` — provider chainId `84532` → derive from the same active chain (or env); `eas.js:37` CHAIN_ID 8453 → make it follow the active chain config (mainnet EAS vs testnet EAS are different deployments; the constant conflates).
5. `verifier/verify-export.js:526,737` — replace the hardcoded 84532 with the export's `anchor.chainId`/agreement chain (parametrize like the v4 path). Historical v1-v3 fixtures declare their chain; the verifier should compare against the declared chain, not a constant.
6. `conformance/vectors/**` — either the vectors stay 8453 (mainnet, correct for the x402 immediate-payment vector semantics) or they are annotated as mainnet-lane vectors; the verifier must not reject them for a testnet-domain check they were never intended for.
7. `mainnet/admission/validator.js:340-341,438` + `v4-canonical.js:139` — keep accepting both, but require the **policy chainId** to name the deployment; final admission already requires 84532 — keep, and note that "84532" means Base Sepolia explicitly.
8. `pilot/hosting-plan-base-sepolia.md`, `.env.example` — document that `SAAX_CHAIN_ID=84532` means Base Sepolia (public testnet), never the local EVM.

### What does not change
- **Deployed custody contracts** (C5 `0x5a5472…ff5d`, C76, F85), the **anchored evidence**, and the **signed fixtures** (baseline-*, v3-battery/*, conformance vectors) are **not invalidated by the local-chain-ID change** because they were produced against Base Sepolia (84532) / mainnet (8453) chains — none were signed for the local EVM's chain as if it were a public chain. The only records that carry the local-EVM chain implicitly are **test transcripts** (dbg-run*, results.json under evidence/v4-anchor) — those are local-test evidence and stay valid *as local tests*. Changing the local EVM's chain ID does not touch any on-chain artifact.
- If the resolution instead required changing any signed fixture, the cost would be regenerating that fixture and re-anchoring — **not recommended here**, and not proposed.

### Verification steps (a future run would check)
1. **Runtime chain guard:** with `SAAX_CHAIN_ID=31337` + local EVM, `endpoint/escrow.js` verifyOnChain refuses anything ≠ 84532 — confirm the local EVM now reads 31337 and is refused; with `SAAX_CHAIN_ID=84532` + sepolia RPC, the guard passes. (Mirrors `scripts/test-escrow-chain-guard.js` 4-case pattern.)
2. **EIP-712 domain test:** sign a v4 verdict with the local EVM chain ID and confirm the v4 verifier rejects it (RPC chain mismatch at `verify-v4.js:88`); sign with 84532 + custody C5 and confirm acceptance. Same for the v1-v3 verdict domain once parametrized.
3. **Chain-guard test:** extend `scripts/test-escrow-chain-guard.js` with the local-EVM chain case.
4. **Provenance check:** the v4 verifier should require the custody address in the export to equal the committed deployment record for the declared chain (`audit/custody-review-phase5.md:6` allowlist), closing the overloading gap.

## 4. If fixture regeneration were required
It is not recommended and is not proposed. Both options are recorded for the owner:
- **Option A (recommended):** constrain the deployment/verifier to match existing signed fixtures — paramtrize domain chainId from the export, keep the local EVM on a distinct chain ID. No fixture changes, no re-anchoring, zero invalidation.
- **Option B (not recommended):** change the local EVM chain ID and/or regenerate fixtures for a new local chain — would invalidate every existing local test transcript and require re-running the batteries. Costs outweigh benefits.

## 5. Open items
- Exact local EVM chain ID value (31337 or another) — owner choice; the code change list assumes 31337 as a placeholder.
- Whether conformance vectors should be annotated as mainnet-lane or updated — owner choice.
- The EAS path (mainnet 8453 EAS vs testnet 84532 EAS) needs an explicit env-driven deployment selection — this is a genuine runtime-correctness fix, currently latent (mainnet EAS constant with testnet provider).