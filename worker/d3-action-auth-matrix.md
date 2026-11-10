# D3 action-argument authorization matrix (worker/d3-action-auth.js)

Source of truth: `contracts/SAAXEscrowCustodyV2.sol` (local candidate, chain 31337)
and `endpoint/escrow-access.js` ROLE_ACTIONS (access-policy layer). Documented
BEFORE patching; the module and worker call sites implement exactly this matrix.

## Canonical action mapping (one explicit map, case-insensitive access side)

`ACTION_TO_CONTRACT` (access action -> contract action). Access actions are
lowercased for lookup; the CONTRACT side is emitted EXACTLY as the deployed ABI
spells it (camelCase / lowercase already). Never re-lowercased after mapping.

| access action (role)          | contract action  | contract fn    |
|-------------------------------|------------------|----------------|
| `submit verdict` (evaluator)  | `release`        | `release`      |
| `request refund` (buyer)      | `refund`         | `refund`       |
| `initiate dispute` (buyer)    | `raiseDispute`   | `raiseDispute` |
| `resolve dispute` (evaluator) | `resolve`        | `resolve`      |
| `mutual release` (buyer|seller) | `mutualRelease` | `mutualRelease` |
| `mutual refund` (buyer|seller)  | `mutualRefund`  | `mutualRefund` |

The mutual release/refund bug was: `String(ctx.contractAction||'').toLowerCase()`
then comparing against `'mutualRelease'`/`'mutualRefund'` (camelCase literals) —
unreachable, so mutual actions returned UNSUPPORTED_ACTION (`detail:'mutualrelease'`).
Fix: classify via an exact-match set on the CANONICAL contract action, and inside
the mutual branch derive the EIP-712 digest action from the canonical name
properly (`mutualRelease` -> `release`, `mutualRefund` -> `refund`).

## Authorized settlement paths (V2)

| Path | Valid when | Authority artifact | Beneficiary |
|------|-----------|--------------------|-------------|
| Evaluator release (`release`) | state Funded, `now < finalCutoff` | EOA verdict `"release"` (v,r,s) OR ERC-1271 verdict (empty v,r,s + sigBytes) | seller |
| Evaluator refund (`refund` verdict) | state Funded, `now < finalCutoff` | EOA verdict `"refund"` OR ERC-1271 verdict | buyer |
| Timeout refund (`refund` empty) | Funded OR Disputed, `now >= finalCutoff` | NO signature (v=0,r=s=0, sigBytes empty) — contract rule, caller anyone | buyer (fixed) |
| Mutual release | state Funded, `now < finalCutoff` | buyer+seller EIP-712 MutualResolution `"release"` | seller |
| Mutual refund | state Funded, `now < finalCutoff` | buyer+seller MutualResolution `"refund"` | buyer |
| Dispute (`raiseDispute`) | state Funded | caller is buyer or seller (contract `NotParty` gate) | — |
| Resolve (`resolve`) | state Disputed, `now < finalCutoff` | evaluator verdict `"resolve:" + resolution` (`release`|`refund`|`hold`) | per resolution |

Release is NEVER a timeout action: `release()` has no timeout branch in the
contract — an evaluator verdict is always required.

## N5 — timeout intent must be EXPLICIT and AUTHENTICATED, not inferred

`refund()`'s dispatch is purely by signature presence: any non-empty (v,r,s) or
sigBytes => verdict path (Funded only, before cutoff); all-empty => timeout path
(Funded+Disputed, at/after cutoff). The bug: the module inferred "timeout" when
`v===0` and used the presence of `sigBytes` as proof of verdict intent, so a
refund carrying `sigBytes` but `v==0` was mis-detected as timeout and then
evaluator-authorized (TIMEOUT_WITH_SIG / evaluator-eoa in the after-run).

Fix (module):
1. Structural check FIRST — `normalizeSig` of (v,r,s): if `rr/ss` non-empty
   (NON-ZERO bytes), this is a VERDICT refund or RELEASE — never the timeout
   path. r/s that are missing, `'0x'`, or ALL-ZERO bytes are EMPTY (the
   contract treats r==0 && s==0 with v==0 as the no-signature container for
   the timeout rule / ERC-1271 branch). Then:
   - if sigBytes is ALSO non-empty (with a non-zero v != 0) -> ambiguous ->
     `VERDICT_SIG_AMBIGUOUS`.
   - release with v==0 but no r/s -> `RELEASE_REQUIRES_VERDICT`.
2. Fully-empty (v,r,s) => timeout path ONLY for refund with EMPTY sigBytes:
   `authorization:'timeout-contract-rule'`. Release => `RELEASE_REQUIRES_VERDICT`.
   (Empty sigBytes with r/s present cannot arise: structural rule 1 already
   routed r/s-present to verdict. An EOA evaluator with empty (v,r,s) + non-empty
   sigBytes => `BAD_VERDICT_SIG`: the container only carries authority for a
   CONTRACT-WALLET evaluator.)
3. v,r,s NON-empty (non-zero bytes) => evaluator path (release OR refund
   verdict) — verify digest against escrow.evaluator: ERC-1271 (contract
   wallet) or EOA ecrecover. A verdict signature is the AUTHENTICATED
   evaluator path; a buyer 'request refund' access auth permits SUBMITTING
   the operation (relayer-shaped), but the worker executes a REFUND only
   under the timeout rule (no signature) or an evaluator verdict — the
   overlapping access role does NOT create evaluator authority.
4. The module binds the EIP-712 custody domain itself
   (`verifyingContract = ctx.expectedCustody`, `chainId = ctx.expectedChainId`)
   when computing verdict/mutual digests — it never depends on the caller
   wrapping the domain in (the suite/worker call-sites may also provide it;
   the module's values win and match).

## Resolve (`resolve`) — evaluator verdict over "resolve:" + resolution

The contract's `_checkVerdict` hashes `string.concat("resolve:", resolution)`
(design custody-v2-design.md T6-T8). A resolve op must therefore carry the
evaluator verdict over `"resolve:" + resolution`, where resolution ∈
`release|refund|hold`. The module:
- validates `A.resolution` ∈ that set (`BAD_RESOLUTION` otherwise);
- re-enters the RELEASE verdict path with `accessAction: 'submit verdict'`
  (the verdict authority is the evaluator's, not the resolve access role) and
  `digestActionOverride: 'resolve:' + resolution` so the SAME EOA/ERC-1271
  evaluator verification as release() verifies the resolve digest;
- never invents resolver/operator privileges — the only resolve authority is
  the evaluator verdict, verified against escrow.evaluator exactly as
  release()/refund() (EOA ecrecover or ERC-1271 isValidSignature).

## Submitter vs evaluator (N5 policy resolution)

Distinct: `submitter` = tx sender = relayer (anyone may submit per A.1/A.2);
`authorizing party` = the party whose genuine signature the contract accepts.
The endpoint verifies the access auth (role + signature) at acceptance; the
worker re-verifies the ACTION ARGS against the on-chain escrow (this module)
and the D2 prereq validator re-checks state/cutoff/policy at prepare. Nothing
invented "resolver"/"operator" privileges: the only authorities are
evaluator (EOA or ERC-1271), buyer/seller mutual, buyer|seller dispute, and the
cutoff timeout rule. The worker executes an op only when one of those genuine
authorities exists — it never creates one because the buyer requested refund.

## EOA vs ERC-1271 evaluator consistency

Both paths require the digest over the EXACT contract action literal
(`release` / `refund` / `resolve:<res>`), verified against `esc.evaluator`.
EOA: ecrecover(v,r,s) == evaluator. Contract wallet: (v,r,s) must be empty and
sigBytes non-empty, verified via `isValidSignature(hash, sigBytes)` ==
`0x1626ba7e`. The module's `verifyContractWallet` hook staticcalls the REAL
evaluator contract; both paths return distinct reasons and never fall back.

## Worker call-site rules (verifyActionArgsForOp)

- `contractAction` passed to the module = `contractActionFor(op.requestedAction)`
  (the CONTRACT action — release/refund/mutualRelease/mutualRefund/raiseDispute/
  resolve), NOT the access action (submit verdict/request refund/...). The old
  call passed the access action in, which the module could not map.
- `accessAction` = the original access action from the op row (used for the
  ACTION_NOT_AUTHORIZED cross-check that the access action's scope covers the
  contract action).
- `accessRole` = op.authRole — used only for the timeout rule: a timeout refund
  requires `authRole === 'buyer'` (the deadline path belongs to the buyer per
  policy A.2). No evaluator authority is inferred from the access role.
- Escrow is read FRESH from the chain; op bindings (escrowId, custody, chain)
  must match; nothing from the caller-supplied body is trusted as recovered
  signer metadata.
- `resolution` for a resolve op flows through `actionArgs` from the accepted
  request body and is validated + bound into the verdict digest here.## D3 CLOSURE — resolve access-role enforcement (2026-10-18)

The resolve branch (`worker/d3-action-auth.js` RESOLVE) re-enters the verdict
path with `accessAction: 'submit verdict'` for digest classification. D3
closure adds an explicit access-role gate BEFORE the re-entry:

- `RESOLVE_ROLE_REQUIRED` — `resolve dispute` requires `accessRole === 'evaluator'`.
  The documented access policy (this matrix: Resolve is evaluator-only) is
  enforced SEPARATELY from the verdict: a genuine evaluator verdict over
  `resolve:<res>` is evidence of the evaluator's on-chain authority, NOT the
  caller's access authorization. A buyer/seller op cannot gain resolve access
  through the internal contract-action normalization; a buyer op whose access
  action was already normalized to the verdict contract action is rejected at
  the mapping gate (`ACTION_NOT_AUTHORIZED`) or the role gate
  (`RESOLVE_ROLE_REQUIRED`) — both defense layers tested (N16/N17/N18).
- EOA and ERC-1271 paths both carry the same role requirement: the role gate
  fires before signature type dispatch, so a contract-wallet evaluator op
  also requires `accessRole === 'evaluator'`.

Tests: `scripts/test-d3-action-auth.cjs` P9 (evaluator resolve:refund
authorized), N16/N17 (buyer/seller denied), N18 (normalized-op denied).

## D3 CLOSURE — expiry semantics (2026-10-18)

Clocks and enforcement points:

| Clock | Enforced at | Mechanism |
|---|---|---|
| Access-authorization expiry (wall clock) | Durable ACCEPTANCE | `endpoint/escrow-access.js` EXPIRED (expiry <= now => reject) BEFORE the acceptance record exists. |
| Evaluator/mutual authorization validity | EXECUTION | Verdict/mutual signature bound to the exact contract-action digest + execution-validity window (`verify-v4` issuedAt ± window; `d3-action-auth` digest binding). Signatures never extended automatically. |
| Delivery deadline / final cutoff (EVM clock) | EXECUTION | `worker/d2-prereqs.js` state-permitted + cutoff checks; timeout refund eligible at/after cutoff; everything else AFTER_CUTOFF. |

Rule: an access authorization must be valid at durable acceptance. A later
retry retrieves the ACCEPTED operation under the authenticated retrieval
policy; access expiry alone does not erase accepted work and does not prove a
prepared transaction cannot execute. The execution-time wall-clock AUTH_EXPIRED
rejection previously in `d2-prereqs` was REMOVED — it blocked legitimate
delayed worker pickup of accepted operations. Contract-action validity and
cutoff rules are unchanged and still enforced at execution.

Tests: `scripts/test-d3-expiry-semantics.cjs` 6/6 (expired pre-acceptance,
delayed pickup proceeds, release-on-Disputed rejected by state, release after
cutoff rejected, timeout at/after cutoff eligible, retry policy).