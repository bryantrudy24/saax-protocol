# Phase 3B: reproducibility and isolated v4 verifier checkpoint

Internal local candidate. Mainnet admission remains DISABLED. No worker implementation,
production routes, website changes, push, deployment or funded public-chain tests.
Baseline inspected: HEAD `86f32cb71e8a82a993baa0fcb981851f5e477729`, tag
`phase3b-realsafe-checkpoint`. Pre-existing ledger/log changes and scratch remain unmodified.

## Dependency and artifact provenance

Root package.json/package-lock.json pin Safe contracts **1.4.1**, solc **0.8.26** and
Hardhat **2.22.4**. Safe registry tarball integrity is in the lockfile; LGPL-3.0.
`.npmrc` records legacy-peer-deps because Safe's JS tooling requires ethers 5.4.0,
whereas this repository independently uses ethers 6.17.0 and compiles only Safe's
Solidity sources. Safe package JS tooling is not used. npm regenerated the lockfile,
including pruning pre-existing extraneous Ganache lock entries; no live modules removed.

Compiler: `0.8.26+commit.8a97fa7a.Emscripten.clang`. Custody/MockUSDC: optimizer 200,
viaIR true, EVM paris (Hardhat default); pinned local solc-js selected explicitly,
no downloaded compiler required. Official Safe source compilation uses optimizer
200, viaIR false and solc's default EVM target. Safe source paths and import closure
are explicit in `scripts/test-custody-v2-realsafe.cjs`. Artifact identity records ABI,
source SHA-256, compiler/settings and runtime keccak256 in
`verifier/v4-candidate-identity.json`. This is a repository trust policy, not an export
claim. `--record-identity` is a deliberate maintenance action, never a verifier option.
**No claim that locally compiled Safe or custody bytecode equals a production deployment.**

Clean verification: `node scripts/check-phase3b-clean.cjs` copies only relevant sources
into a fresh OS temporary folder, uses `npm ci --ignore-scripts --no-audit --no-fund`,
compiles from pinned solc, and runs the real-Safe and v4 harnesses. Existing node_modules
are neither removed nor reinstalled. Evidence: `evidence/phase3b-v4/clean-install.txt`.

## Check matrix

| Requirement | Existing helper | New verifier check | Evidence | Limitation |
|---|---|---|---|---|
| Exact manifest/digest | recursive deep sort, COSE-style SHA-256 | same bytes, explicit signature container | canonical spec tests, tampering | envelope placeholder itself is not crypto consent |
| Genuine parties/consents | signing helper only | two exact roles, EOA recovery over complete hash in fixed agreement domain; expiry at funding | separate process, swapped/omitted signatures | contract-wallet party consent unsupported |
| Policy/profile/evaluator/asset/value/time/chain | structural only, integer coercion/lexical times insufficient | strict strings, parsed dates, signed policyId/minReleaseTime, actual fund calldata and escrow tuple | changed binding cases | only restricted profile, zero fees/reserve |
| Custody identity/domain | helper defaults V2/2; conflicts with proposed spec V1/1 | exact candidate runtime policy; direct call only | runtime hash and domain constants checked | no formatVersion-derived deployment identity |
| Action authorization | EIP-712 encoders | actual successful evaluator/mutual/timeout/resolve path; permitted decisions and execution windows | real Safe release, mutual refund, timeout | nonterminal hold excluded |
| Historical ERC-1271 | none | canonical execution witness through allowlisted immutable runtime | same-block release/governance/stale release | trusted RPC, not standalone consensus proof |
| Receipts/movement/state | none | canonical block+tx index, success, correct recipient/events, token Transfer and escrow state | separate subprocess | arbitrary token authenticity not certified |
| Finality | none | explicit local-synthetic mode only | public-finality claim rejected | no Base L1 finality proof |
| Issuance vs lifecycle | none | explicit separate verdict; both lifecycle references required | missing settlement incomplete | no vacuous full VERIFIED |
| Historical formats | frozen v1/v2/v3 code | separate dispatch, no legacy check edits | before/after fixture output+exit comparison | offline/unsupported EAS RPC results preserved, not new live positive claims |

## Historical ERC-1271 method

For the exact non-upgradeable custody runtime in the identity file, a successful
**direct** transaction to the decoded release/refund/resolve path necessarily executes
`_checkVerdict`, including the ERC-1271 staticcall in the actual intra-block state.
Successful mutual paths necessarily validate both EOA party signatures; timeout refund
necessarily takes its cutoff branch. The verifier binds that execution to the canonical
transaction hash, block hash, transaction index, calldata, receipt, events and historical
escrow tuple. The runtime has no delegatecall, selfdestruct or upgrade path, so an
end-of-block runtime identity does not hide an intra-block implementation switch.
This is execution evidence, not a claim that a wallet remains valid after execution.

The focused harness queues release -> Safe threshold increase -> stale release in one
block. First succeeds; governance changes the threshold; last fails without payout.
The earlier authorization still verifies historically despite the later governance.
There is no `isValidSignature(..., latest)` or end-of-block Safe call. No caller-supplied
trace or snapshot is accepted. Provider block order and receipts must agree. Required
historical code/state unavailability is `INCOMPLETE_UNSUPPORTED`. Unknown custody
runtime is unsupported; no fallback to a weaker signature check. Trace absence alone
is not a blocker because this method proves the actual successful authorization path.

Trust: the configured RPC faithfully reports canonical blocks, tx input, receipt success,
logs, code and historical state. This verifier does not independently verify consensus,
receipt trie proofs, execution replay or Safe owner/threshold attribution. The real Safe
stack is tested locally, but the generic runtime authorizes whatever evaluator contract
was signed: successful ERC-1271 authorization does not itself certify that the evaluator
was an approved 2-of-3 Safe or that its owners were independent adjudicators.

## Verdicts and remaining gates

- `VERIFIED_ISSUANCE_ONLY`: canonical agreement + both genuine EOA consent signatures;
  no funding, settlement, finality or external evidence assurance.
- `VERIFIED_WITH_LIMITATIONS`: local synthetic full lifecycle under explicit candidate
  identity; limitations printed in output. Never an unrestricted VERIFIED verdict.
- `INCOMPLETE_UNSUPPORTED`: required RPC/historical references/state unavailable or
  runtime unsupported. `NOT VERIFIED`: contradictions, tampering or failed execution.

### EAS anchor state (v4, after independent anchor implementation)

- The local official-EAS anchor is implemented and integrated (`verifier/v4-anchor.js`,
  `verifier/v4-eas-policy.json`, `verifier/verify-v4.js`). When `exp.anchor` is
  supplied with an RPC, `VERIFIED_ISSUANCE_ONLY` and `VERIFIED_WITH_LIMITATIONS`
  results now include an independently bound EAS anchor: exact anchored bytes
  (commitmentId + manifest digest) against the official local EAS contract, and
  both-party typed-data attester authority over the exact anchor bytes in a fixed
  anchor domain. Descriptive anchor fields are party-authorized bytes only, with no
  invented v4 semantic mapping; anchor immutability (nonexpiring, non-revocable,
  unreferenced schema) is enforced against actual contract state.
- Deployment policy: `local-official-eas-1.7.1-v1` (local EVM chain 31337, NOT public
  Base Sepolia 84532). Chain declarations are unified on Base Sepolia 84532 for the
  pilot; the local EVM uses its own distinct ID 31337; the verifier legacy hardcode
  (verify-export.js:526,737) remains a separate cleanup item, not fixed here.
  Local-only anchor assurance.
- Evidence: `scripts/test-v4-anchor.cjs`, results `evidence/v4-anchor/results.json`
  (38 passed, 0 failed, including a separate-process CLI full-export positive and the
  paired positive control beside the two key negatives "anchor from another
  commitment" and "wrong digest data"). Every negative asserts its specific rejection
  reason; no case is a generic non-VERIFIED.
- Regression: `verify-export.js`, `v4-canonical.js`, `v4-signatures.js` unchanged;
  v1/v2/v3 fixtures re-verified byte-identical (baseline=1, current=1) in the same
  run. Safe suite and broad protocol battery not rerun (no shared code changed).
- Assurance gained: anchor binding + attester authority via both-party signatures.
- Assurance still NOT gained (explicitly absent from v4): journal verification,
  fulfillment-evidence validation, public-chain finality, and approved 2-of-3 Safe
  governance. These must not be described as covered. Bounded ERC-1271 witness
  qualifications preserved unchanged (no new Safe claim).
- Candidate contract does not enforce the resolution deadline separately from finalCutoff;
  verifier conservatively enforces both signed windows. No contract semantics changed.
- External evidence content/sufficiency, policy-document approval, finality on public
  chains, contract-wallet party consent, advanced profiles, fees/reserves, malicious token
  identity, exhaustive fuzz/invariant suites, execution worker, independent audit, legal
  review and owner-approved economic/admission parameters remain activation blockers.
- No private keys, raw signed transactions, reusable spend authorizations, credentials,
  or token-bearing local URLs are exported. Synthetic party consent is agreement-only;
  the custody evaluator signatures are read from already-executed public transaction
  calldata, not included as reusable authorization files.

## Reproduction commands

```
node scripts/test-v4-checkpoint.cjs
node scripts/check-phase3b-clean.cjs
node mainnet/design/tests/test-v4-spec.js
node verifier/schema-uid-regression.js
```

The v4 harness starts a temporary read-only loopback RPC proxy and closes it before
exit. Its child verifier gets public read methods only; no app modules or DB are loaded.
`results.json`, `separate-process.txt` and synthetic fixtures record the local outcome.
Existing historical fixture regression compares output/exit with the pre-dispatch
verifier (normalizing only the temporary baseline filename in error stack traces).

## Observed checkpoint results

- Local v4 harness: **38 passed, 0 failed** (`results.json`), including evaluator
  real-Safe release, mutual refund, cutoff timeout, re-signed term substitutions,
  consent signature/domain attacks, same-block governance ordering and four
  historical fixture output/exit comparisons.
- Isolated clean install/build: npm ci exit 0; pinned versions printed; Hardhat
  compiles from local solc; real-Safe harness **17 passed, 0 failed**. Detailed
  v4 rerun output is appended in `clean-install.txt`.
- Existing canonical specification tests: **27 passed, 0 failed**.
- `node verifier/schema-uid-regression.js`: all derivation checks passed.
- Lockfile comparison: no existing resolved package version changed and no
  non-extraneous package entry removed by regeneration.

The historical fixture comparison intentionally preserves offline/incomplete
assurance. It does not claim a new live EAS-backed positive regression run. The
older historical evidence remains intact and was not regenerated or overwritten.

Environment caveat: this workstation runs Node v26.3.0, outside Hardhat 2.22.4's
supported Node range; Hardhat also warns about partial Solidity 0.8.26 tooling support.
Observed compilation and focused tests pass, but this is not a supported-runtime
certification. Dependency install lifecycle scripts are intentionally disabled.

Admission gate regression: `node mainnet/admission/tests/run-tests.js` reports
**40 passed, 0 failed**, including denial with all activation inputs supplied and
mainnet chainId. Admission source was not changed in this checkpoint.
