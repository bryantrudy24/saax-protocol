# SAAX EAS Verification Limits — the `to`-address assumption

> Status: **documented limitation, current scope = direct attestations only.**
> This is **not a defect** in the current scope; it is an explicit statement of
> the boundary the transaction-chain check operates inside.

## What the current check assumes

`verifier/verify-export.js` — `checkTxChain(anchor, rpcUrl)` (around
lines 336–405) verifies the declared `anchor.txHash` as a **chain**:

1. fetch the transaction receipt by the declared `txHash`
2. confirm it succeeded (`status == 0x1`)
3. **confirm `receipt.to` equals the EAS contract address** —
   `0x4200000000000000000000000000000000000021` (Base Sepolia / Base,
   `const EAS_ADDRESS`, line ~90)
4. confirm the receipt emitted an EAS `Attested` event whose `data` equals the
   declared `anchor.uid`
5. confirm the event's schema and attester topics match the declared
   `schemaUid` and `attester`

Link 3 is the assumption documented here: **the transaction's `to` address must
be the EAS contract itself** — i.e. the caller invoked EAS directly. That is the
direct-attestation shape.

## What it does not support

The same link-3 equality rejects (or cannot authenticate) legitimate EAS
attestations that arrive through an indirection:

| Case | Shape | Why the current check rejects / cannot verify it |
|---|---|---|
| **Delegated attestation** | A delegate (or a relayer / EIP-2771 forwarder) creates an attestation on behalf of the actual attester | `receipt.to` is the forwarder/delegate contract, not EAS. The check fires `tx to <addr> != EAS <addr>` even though a valid EAS attestation was produced. |
| **Batch attestations** | Multiple attestations in one transaction (`multitest` / `attestByDelegation` batch calls) | The EAS `Attested` event exists, but the transaction contains several; the current check takes the first matching event and does not enumerate or reconcile all of them. |
| **Contract-mediated calls** | A proxy/aggregator/escrow contract calls EAS internally; EAS is invoked from another contract | `receipt.to` is the intermediary contract, not EAS. Same link-3 rejection. |

For all three, the attestation may be perfectly valid on-chain — but the check
as written only authenticates the direct-caller shape.

## What verifying each would require

- **Delegated attestation**: resolve the delegation chain — read the
  forwarder/delegate contract's events (or its EIP-2771 / `isTrustedForwarder`
  semantics), recover the *original* attester, and verify the EAS
  `Attested` event's attester topic equals the declared `anchor.attester` after
  unwrapping the delegation, not merely taking `receipt.to == EAS`.
- **Batch attestations**: parse every `Attested` log emitted by the receipt,
  extract each UID, and require the declared `anchor.uid` to appear in that set
  (plus verify the declared schema/attester for that specific event).
- **Contract-mediated calls**: internal transaction tracing (`debug_traceTransaction`
  or equivalent) to walk the call stack into EAS and confirm the EAS call's
  calldata/attester, or verify the intermediary contract's emitted events that
  carry the EAS attestation reference.

## Current scope statement

The verifier's txHash chain check supports **direct attestations** — the caller
invokes the EAS contract directly, so `receipt.to == EAS_ADDRESS`. Delegated,
batch, and contract-mediated attestations are **out of the current scope** and
are documented here as known boundaries. This is a scoping decision, not a
defect: within the direct-attestation scope the check authenticates the full
chain (receipt → EAS event → uid → schema/attester) and rejects tampered
`txHash`, wrong `uid`, wrong `schemaUid`, and wrong `attester` with specific
reasons.