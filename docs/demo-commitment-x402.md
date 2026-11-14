# SAAX Protocol — Commitment → x402 Settlement Demo (Base Mainnet)

**Audience:** Fireblocks & Skyfire teams

## The commitment

- **Commitment ID:** saax_1e904a1582abc99b
- **Rail:** x402
- **Network:** Base mainnet (eip155:8453)

## The settlement

- **Transaction hash:** 0x7ac2efe8... (full hash recorded in the build log; TXHASH_C)
- **Amount:** 0.05 USDC
- **From (buyer):** 0xFec8...cA13
- **To (cold vault):** 0xAF94b0d2a936C0683c870aB146979F7ebA46A49f
- **Basescan:** https://basescan.org/tx/<TXHASH_C> (block recorded in build log)

## Query the receipt

Production endpoint — anyone with the txHash can resolve it back to the commitment:

https://saax-protocol.com/receipt?txHash=<TXHASH_C>&rail=x402

Returns HTTP 200 with the commitment ID that survived settlement.

## How the flow works (five lines)

1. Create a commitment via MCP (create_commitment) with settlement_rail x402 — returns saax_<hash>.
2. Call the x402-protected endpoint with the commitment ID in the payment payload extensions (extensions.saax_commitment_id).
3. Client signs an EIP-3009 authorization; the facilitator verifies and broadcasts on Base mainnet.
4. Settlement confirms; the server persists settlement_ref = { txHash, rail: x402 } on the commitment row (additive write, commit 9f592c8a).
5. GET /receipt?txHash=<real-hash>&rail=x402 resolves the txHash back to the original commitment ID.

## Why this matters

The commitment ID survives settlement and is queryable by anyone holding the txHash — proving the on-chain payment is bound to the off-chain commitment without any manual reconciliation.
