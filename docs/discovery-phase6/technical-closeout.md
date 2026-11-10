# SAAX Discovery → Base Sepolia financial closeout

**Verified 2026-11-06.** Starting source `8e763985ebee194c5583dffc4b57feaf447053a6`. This report supersedes the complete-assurance and bytecode-trimming claims in Phase 5, without rewriting the historical signed records or transaction evidence.

## 1. Signed network / asset binding — closed for the isolated financial profile

The actual Phase-5 release and refund proposals were separately issued with `network:eip155:84532`, asset `eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e`, USDC, six decimals. They were **not mainnet-bound proposals executed on testnet**. However, their constructed testnet profile was unsigned and absent from the export; evaluator was only generic requirements in the SR, not the on-chain evaluator identity accepted by the buyer. They cannot establish the complete required authorization chain.

Removed from the isolated `endpoint/financial-handoff.js`: mainnet-label compatibility and environment/caller substitutions. Async builders verify a separately signed active profile against exact configured provider identity/origin/key thumbprint; provider proposal, registered-buyer acceptance, complete signed representation, recomputed manifest and request-criteria digest; exact supported network/CAIP-19 asset, positive integer amount, USDC/6/unit, signed rail/mode, custody, buyer, seller, evaluator permissions and timing/recovery. Payment requirements and escrow funding derive from the same terms. `rail:x402, mode:escrow` explicitly distinguishes this isolated custody compatibility combination from immediate `x402/x402`; no facilitator payment claim is made for escrow funding.

Mainnet-bound proposals are rejected by the testnet handoff even when freshly signed. Testnet-bound execution against a mainnet RPC is rejected. A mainnet signed network cannot authorize testnet submission; a chain guard never changes signed terms. `SAAX_USDC_ADDRESS` cannot substitute another asset. Caller overrides never become authoritative. Production profile and immediate-payment implementation remain unchanged.

`preflight-core` now derives combination fields without mutating a signed profile. An optional trusted-provider financialAgreement is included **before** proposal signing. Buyer termsDigest authorizes the same agreement; SR proposalDigest transitively binds it. No network or financial override is added to public endpoints.

## 2. Custody bytecode identity — exact full match

Address: `0x5a5472d751839cd4968cbf1b136baf862279ff5d`, Base Sepolia84532. Creation transaction `0xc7ebd72a34dc0ec4be065e24df5688a29ba61031cdc0b550f4eb59a184095c1e`, block48176893. Constructor has zero arguments; `block.chainid` is assigned to storage slot0, not an immutable. No linked libraries or immutable patches.

Reproduction: `node scripts/check-custody-identity.cjs` (installed solc0.8.26+commit8a97fa7a, optimizer enabled/runs200, viaIR, Cancun). Reads canonical Git LF bytes at source revision8e763985, not Windows CRLF-converted checkout. Source Git blob195a455670791167e9ed67170749b8d2c304bd1f; artifact blob76c2287a9a49e0f8a775aa9d6d286ca49b9a95af. Original builder's default EVM target and explicit Cancun reproduce identical bytes; detailed compiler settings and JSON metadata are in the identity report.

| Portion | Bytes | keccak256 |
|---|---:|---|
| Creation |6963|`0x7862bb5a5a3163f2e58b453974a5f336752194dd51ae148fafe8d7d96d2aa91e`|
| Init prefix |29|exact CODECOPY/RETURN shape validated|
| Full deployed runtime |6934|`0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473`|
| Executable |6881|`0x9d5641680e992a4da5388951cb8441f22d41fcfd03d9d61162f1a3fab5c5ed21`|
| CBOR metadata |51|decoded map, exact consumption|
| Length trailer |2|`0x0033` unsigned big-endian CBOR byte length|

Correct arithmetic: **6881+51+2=6934; 29+6934=6963**. The earlier “1146 metadata bytes /5817 executable bytes” and reported runtime SHA256 are incorrect. Full runtime SHA256 is `ba5d296d323bdb67fc09eb51677dd0f2ebec9e46576b77385a0c64543d95f4a3`; executable SHA256 `bcd62a14c799d6460e9b377aceb986c4334d3c6d8a4dd644376aa3e0e038b110`.

CBOR: `ipfs:0x1220570dce6eb7cac01b2d2183f847e9c088796a85ec1f61a783af03c429769a4b61`, `solc:0x00081a` (0.8.26). Decoder uses actual final two bytes, validates a complete CBOR map and bounds; no guessed trim. Actual runtime, artifact-extracted runtime, exact-source compiled runtime and deployment input match in full, including metadata. CRLF source recompilation changes metadata, not executable. No new deployment justified or performed. Parsing reference: https://docs.soliditylang.org/en/latest/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode . Full values and raw runtime: `evidence/discovery-phase6/custody-identity.json`.

## 3. Independent financial verification — closed for the explicit v2 self-test profile

## 2026-11-06 — /receipt store-schema 500 fixed (config-level, no redeploy)
Root cause: PostgREST schema exposure — authenticator `pgrst.db_schemas` was
`'public, vv_survey'` (ax_router missing). Additive migration exposed
`ax_router` (preserving `vv_survey` and `public`); `reload config` + `reload
schema`. Live matrix after fix: known txHash 200 (saax_e8c3107513646a58), unknown
404, invalid/missing 400. Endpoint code and grants were already correct; access
posture unchanged (read RPCs service_role/authenticated only). Migration file:
`data/migration-20261106-expose-ax-router-postgrest.sql`. Tests:
`tests/receipt-reliability.test.mjs` (6/6), `scripts/_verify-receipt-live.mjs`
(10/10). `SAAX_X402_PRIVATE_KEY` is a legacy live-branch/local-tooling var, not a
production payment dependency (self-mode uses SAAX_SIGNER_PRIVATE_KEY).

`verifier/verify-financial-export.js` uses public RPC, configured public trust mappings and exported signed artifacts; it has no application/database imports. Separate-process runs receive an explicit environment allowlist with no application DB URL/key/role or dotenv.

Checks include provider identity/key relationship and separately signed testnet profile; actual registered buyer signature; full normalized request, proposal/terms/manifest/SR digests and versions; evaluator identity and decisions authenticated in buyer-authorized agreement and SR; exact deployment runtime pin, constructor chain, on-chain domainSeparator and VERDICT_TYPEHASH; decoded funding/terminal calldata, successful receipts with exact tx/block identity; signature recovery against authorized evaluator; action/nonce/issuedAt, nonce unused before then consumed after, and execution timestamp rules `issuedAt<=blockTime+120`, `blockTime<=issuedAt+300`; exact custody events, token transfer events, historical escrow states, custody and beneficiary token balance deltas at actual blocks. No latest-balance assumptions or exported before-balances are trusted.

A separate seller-signed fulfillment artifact is verified against the signed evidence policy and deterministic SHA256 criterion. A separate evaluator signature binds its evidenceDigest to the on-chain verdictDigest. **CustodyV1 verdict itself has no evidence field**: the contract enforces evaluator authority, not off-chain quality/evidence semantics. The verifier adds the explicit evidence binding; this is not proof of external service quality.

Signed evaluator refunds require refund permission, valid domain/signature and execution-time window. Unsigned timeout refunds use all-zero v/r/s, explicit timeout labeling, the signed timeout policy and actual execution timestamp>=authenticated deadline. A signed refund cannot be relabeled a timeout. The fresh pair demonstrates signed release/refund; it does not add a new real timeout or disputed recovery rehearsal. A consumed nonce alone proves neither correct action nor authorized terms.

Trust remains configured-key onboarding: third parties must authenticate the provider thumbprint and buyer-key-to-address mapping independently. Keys fetched from the same untrusted export/profile do not bootstrap identity. Verification trusts the selected RPC/archive provider, not a locally verified consensus/light client; no L1 finality guarantee or independent audit is claimed.

### Smallest fresh authorized evidence

Old successful transactions were preserved, not repeated. Because their missing signatures/authority cannot be retrofitted, new records used **1000 raw test USDC (0.001) each**, existing custody and operator-controlled accounts, no new deployment/mainnet spend. Producer journals each signed test transaction before broadcasting; retries reconcile exact hashes.

| Flow | Commitment | Funding (block) | Terminal (block) |
|---|---|---|---|
|Release|`0x4362c3c3e676002dcdeb0c70bdcb4d5af82056742ba6d280469f13c9668bc316`|`0x999e21b612d8c9f0ed527ada512726e25220496a2f3720ef6f062f9dc0bc86d9` (55360471)|`0xb0766b1e4a28861e0688655fb104e4cd553f1ee2e8a110e6896b0f42f1feeaf6` (55360516)|
|Signed refund|`0xaf5942cb175acaef785ddbc43c97e816b81f2a13d8cd487a2437d99d772bd559`|`0x1e20dbfc7bcd7ba4cc505d5569f51a88f845bd1111a2edd16b262c0bda30cc9a` (55360691)|`0xe324fff58137c2817835e3bf408b1fdd2b03a44914f7860b86244685335231eb` (55360737)|

The service is explicitly a deterministic local SHA256 self-test, not an external vulnerability scan. Refund evidence is an authenticated test nonfulfillment declaration, not external monitoring. All roles are controlled by the operator. Complete outputs are retained in `evidence/discovery-phase6/independent-{release,refund}-verification.json`.

### Commands and results

`node scripts/run-financial-closeout-checks.cjs --fixtures-root=<existing-authorized-SAAX-checkout>` records exact commands/results. Locally, NODE_PATH was explicitly set to the existing installed SAAX node_modules for solc and test dependencies; existing gitignored fixture keys were copied without altering committed public fixtures. Do not print private keys. Detailed outputs and totals: `evidence/discovery-phase6/test-results.json` and `test-*.txt`.

- Phase2 26/26; Phase3 68/68; Phase4 67/67; ownership28/28; SR10/10; financialterms19/19; recovery18/18; Supabase adapter contracts20/20+6/6; checkdCLI2/2.
- Conformance94/94, schema examples14/14. New signed testnet profiles also passed their governing profile schema.
- Focused primitive/verdict/CBOR tests25/25; verifier selftests14/14; strict network handoff checks passed. Full positive-control and specific-failure export cases22/22.
- Separate-process release **VERIFIED78/78**, signed refund **VERIFIED79/79** after historical-balance and timeout-label refinements; zero failed/incomplete. These counts apply to this version, not the old39-check verifier.

## Remaining liabilities / publication boundaries

- Testnet preview only. No public financial execution endpoint or mainnet custody activation. Existing live Base-mainnet immediate payment lane is separate, non-custodial, public beta and unchanged.
- Mainnet-bound production discovery profile remains exactly unchanged. Its financial terms do not enable custody.
- Historical Phase5 v1 exports are explicitly INCOMPLETE for full v2 assurance; original signatures/transactions remain evidence of the narrower checks.
- CustodyV1 has no admin/pause/upgrade/evaluator replacement. **A disputed escrow can remain frozen indefinitely if the evaluator disappears; timeout refund is only available in Funded state.** No guaranteed refunds/safety claim.
- Newer custody/governance candidates remain undeployed, under development/security review. Internal tests/review are not a completed independent audit or external adoption.
- Legacy financial drivers/harness requiring environment-swapped assets/mainnet labels are unsupported by strict handoff. Their old evidence is preserved; they are not valid substitutes for the new authorized flow.
- This technical branch is not automatically a production runtime release. Website publication uses a separate branch based on verified production8e763985 and explicitly excludes these financial runtime changes.
