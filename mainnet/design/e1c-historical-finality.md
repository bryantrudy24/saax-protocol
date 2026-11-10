# E1C — historical-membership module + explicit method dispatch

Baseline: `f22b59e6` (HEAD before E1C). Local commit: after E1C (local only, no
push). Preceding: `a8148aff` (E1B), `932e7ea1` (E1A).

## What changed

### `worker/d2-historical-finality.js` (new)

A trusted-RPC canonical-membership module that is EXPLICITLY NOT a finality
check. Canonical membership (receipt present, block hash canonical, transaction
present in the canonical block) establishes only that a committed transaction
is on the currently-canonical chain as observed by a TRUSTED RPC. It does NOT
satisfy `op-stack-safe` / `op-stack-finalized` policy, does NOT cause worker
completion/finalization by itself, and is never reported as a successful
public-finality check.

- **`getBlockByRef(provider, ref)` — explicit method dispatch (boundary #2).**
  A 64-hex block hash routes to `eth_getBlockByHash`; a supported tag
  (`latest`/`safe`/`finalized`/`pending`/`earliest`), a hex-quantity number, or
  a decimal number routes to `eth_getBlockByNumber`. A hash is NEVER passed as
  a block-number argument. Tests assert the exact methods used and that no
  hash ever appears as a parameter to `eth_getBlockByNumber`.
- **`HistoricalMembership.checkMembership(txHash)`** — canonical membership
  observation: receipt present, canonical block hash matches the receipt's
  recorded block hash, and the transaction hash is present in the canonical
  block's transactions list. Deep-history membership needs NO ancestry walk:
  the canonical block at the recorded height is the source of membership.
  Reason values distinguish missing history (`RECEIPT_ABSENT`,
  `CANONICAL_BLOCK_UNAVAILABLE`, `HEAD_UNAVAILABLE`,
  `TX_IN_BLOCK_UNVERIFIABLE`) from a CONFIRMED membership mismatch
  (`CANONICAL_BLOCK_HASH_MISMATCH`, `TX_NOT_IN_CANONICAL_BLOCK`). Missing
  history is never reported as a confirmed mismatch.
- **`HistoricalMembership.assertPublicFinality(opts)`** — the DISTINCT public
  safe/finalized assertion for the recent-head case. It is not membership: it
  additionally proves the receipt is covered by the tagged safe/finalized head
  via a BOUNDED ancestry walk (`maxDepth`, default 256) AND that the tagged
  head is stable across a verification-time recheck (same head number, same
  hash, on the current canonical chain) — the head-binding/consistency checks.
  Even when it returns `final:true` it remains a TRUSTED-RPC observation with
  the documented trust assumptions; no independent-consensus claim.
  `op-stack-safe` requires safe-head coverage (SAFE, not FINALIZED);
  `op-stack-finalized` requires finalized-head coverage (safe coverage alone is
  `SAFE_ONLY` — insufficient). Missing tags / bounded exhaustion /
  head-binding change fail closed (`TAG_UNAVAILABLE` / `BOUND_EXCEEDED` /
  `UNCOVERED_WITHIN_BOUNDS` / `HEAD_BINDING_CHANGED`).
- **`HistoricalMembership.establish(txHash, policy)`** — worker-facing path.
  Returns `{ membership, finality }` — the two findings are separate in every
  output. Membership NEVER drives finality: the finality finding is produced
  ONLY by `assertPublicFinality`. An `op-stack-*` configured requirement is
  never downgraded to a membership observation or to local confirmations.
  `local-confirmations`/`local-synthetic` returns
  `FINALITY_PUBLIC_NOT_ACTIVATED` (never public finality).
- **Mainnet refusal + deployment identity restrictions preserved**: mainnet
  (chain 1) public policy refused (`FINALITY_MAINNET_NOT_ACTIVATED` for both
  findings); local-confirmations remain chain-31337-only; no
  trust-any-deployment flag; no public-chain deployment activation.

### `scripts/test-e1c-historical-finality.cjs` — labeled mock battery (35 assertions)

`[MOCK]` labeled provider simulations; every mock records each `send()` so
tests assert the ACTUAL RPC methods used and the exact bounded call counts.

- Explicit method dispatch: hash → `eth_getBlockByHash` (never
  `eth_getBlockByNumber`); tag/hex-quantity/decimal → `eth_getBlockByNumber`.
- Deep-history positive membership (block 2 of a 20-block chain) passes as a
  canonical member with exactly receipt + block + head reads (3 calls, no
  ancestry walk).
- Tampering: canonical block hash changed after capture →
  `CANONICAL_BLOCK_HASH_MISMATCH`; tx removed from canonical block →
  `TX_NOT_IN_CANONICAL_BLOCK` (both distinct from missing history).
- Unavailable history: missing canonical block → `CANONICAL_BLOCK_UNAVAILABLE`;
  absent receipt → `RECEIPT_ABSENT`; missing history never reported as a
  confirmed mismatch.
- Changing canonical views: first observation member, after reorg at the same
  height → `CANONICAL_BLOCK_HASH_MISMATCH`.
- Policy-downgrade prevention (bounded adapter `maxDepth=3`): deep-history
  membership PASS does NOT satisfy safe or finalized policy
  (`BOUND_EXCEEDED`); `establish` returns separate membership + finality
  findings; membership never drives `final:true`; local policy never returns
  public finality.
- Public safe/finalized recent-head positive: SAFE satisfaction
  (`SAFE_COVERED`, safe only, never labeled finalized), finalized satisfied
  after finalized-head advance (`FINALIZED_COVERED`), missing safe tag →
  `TAG_UNAVAILABLE`, finalized-not-safe → `SAFE_ONLY`.
- Head-binding change: unstable tagged head across the verification-time
  recheck → `HEAD_BINDING_CHANGED` (fail closed).
- Mainnet refusal + unsupported policy: `FINALITY_MAINNET_NOT_ACTIVATED` (both
  findings) and `FINALITY_POLICY_UNSUPPORTED`.
- RPC work is bounded and measured: finality path records its actual calls,
  no hash routed as a block-number argument.

### `scripts/observe-e1c-sepolia.cjs` + `evidence/e1c-sepolia-membership.json`

Read-only Base Sepolia (chain 84532) observation of the FULL committed
transaction hashes from `evidence/terminal-state-escrows.json` (fundTx /
refundTx / disputeTx, full 32-byte hashes). Chain identity validated
(`eth_chainId` = 84532).

- **Membership findings (separate)**: all 4 committed hashes are canonical
  members (`CANONICAL_MEMBER`) — receipt present, canonical block hash match,
  tx present in canonical block. No ancestry walk required for membership.
- **Finality findings (separate)**: both public policies fail closed with
  `BOUND_EXCEEDED` for all 4 hashes — these txs are ~104k blocks deep and the
  bounded ancestry window (256) is NOT widened or removed to make old history
  pass. `safeCovered=false`, `finalizedCovered=false` for every observation.
- **Anchor references alongside funding/settlement**: the per-record
  commitment `cid`/`digest` refs are recorded for each escrow record where the
  record carries them (2 anchor refs). (The synthetic EAS anchor
  `positive-export.json` txHash is a local artifact, not present on public
  Sepolia; no fabricated on-chain anchor claim was made.)
- Head references (safe/finalized/latest) recorded at the end of the window.
- The result is an RPC observation, never independent consensus
  reconstruction; membership PASS never closes the finality requirement.

## Tests / counts / exit codes (this run)

- `scripts/test-e1c-historical-finality.cjs` — 35 passed, 0 failed, exit 0.
- `scripts/observe-e1c-sepolia.cjs` — exit 0 (chain matches; 4/4 committed
  hashes canonical members; finality findings recorded separately and
  fail-closed — expected, not a run failure).
- Regressions (all exit 0):
  - `scripts/test-e1-finality.cjs` (E1A battery) — 33 passed, 0 failed.
  - `scripts/test-e1b-finality.cjs` (E1B adapter battery) — 26 passed, 0 failed.
  - `scripts/test-d2-worker.cjs` — 40 passed, 0 failed.
- E1A/E1B adapter/worker files were NOT modified by E1C: `git diff a8148aff --`
  shows only the new E1C files, the new evidence, the new observer, and this
  note (verified below in the commit diff).

## Membership vs finality — the invariant

| finding | what establishes it | satisfiable by deep history? |
|---|---|---|
| `membership.member=true` (`CANONICAL_MEMBER`) | trusted RPC: receipt present, canonical block hash match, tx in canonical block | YES (no ancestry walk) |
| `finality.final=true` (`SAFE_COVERED` / `FINALIZED_COVERED`) | bounded ancestry walk to the safe/finalized head + head-binding recheck | NO — fails closed `BOUND_EXCEEDED` beyond `maxDepth` |

A membership PASS is reported as membership PASS and the required finality as
INCOMPLETE. The configured assurance (`op-stack-safe` / `op-stack-finalized`)
is never lowered; worker completion/finalization is not driven by membership.

## Remaining gates (unchanged from E1A/E1B)

- Signer: external signer integration (D4B) and signing isolation remain
  operator/activation gates.
- Governance: approved 2-of-3 Safe governance provenance is NOT established by
  successful ERC-1271 execution; journal attests records, not authorization.
- Audit: independent security/economic audit (readiness gate G4) remains
  outstanding; conformance tests are not an audit.
- Operating: mainnet admission, public deployment identity review, RPC
  capability requirements (archive/non-archive, safe/finalized tag support,
  multiple providers for disagreement detection), and finality policy approval
  for public-chain operation remain before any public export is permitted.
- The OP Stack `finalized` tag for these deep-history txs is ~104k blocks
  behind the safe head and ~103k behind final; even arithmetic head-position
  comparison would need the bounded walk widened, which the safety check
  deliberately does not do. Exact remaining finality gap: safe/finalized head
  coverage is NOT established for these committed hashes (bounded walk fails
  closed at `BOUND_EXCEEDED`); only canonical membership is established.

## Definition of done (E1C)

- [x] Historical-membership module (`worker/d2-historical-finality.js`) with
      explicit method dispatch (`eth_getBlockByHash` for hash,
      `eth_getBlockByNumber` for number/tag).
- [x] Membership and finality kept separate in every output; membership never
      satisfies safe/finalized policy; configured assurance never downgraded.
- [x] Anchor references alongside funding/settlement where applicable.
- [x] Deployment identity restrictions and mainnet refusal preserved.
- [x] Tests: deep-history positive membership, tampering, unavailable history,
      changing canonical views, policy-downgrade prevention — 35/35.
- [x] Read-only Sepolia observer run using full committed transaction hashes
      (4/4 canonical members; finality separate and fail-closed).
- [x] Focused affected regressions re-run (E1A 33/33, E1B 26/26, D2 40/40).
- [x] Docs updated (this note).
- [x] Committed locally, not pushed. No push, no deployment, no public-chain
      writes, no spending, no production secrets, no mainnet activation.
