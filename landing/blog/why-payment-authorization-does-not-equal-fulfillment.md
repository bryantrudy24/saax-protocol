# Why Payment Authorization ≠ Fulfillment in Agentic Commerce

*October 8, 2026* 

*Last updated: 2026-10-17*

---

A payment authorization is a promise to pay. A fulfillment is proof that something was delivered.

The two are treated as equivalent in most commerce infrastructure. The authorization clears, the settlement occurs, and the transaction is considered complete. This works when a human is on the other end of the purchase — they authorized the transaction, they received the goods, and their own judgment closes the gap.

When an agent is on the other end, the gap doesn't close. The agent authorized the transaction. The payment cleared. The merchant shipped something. But whether that something matches what the agent *actually intended to buy* is a separate question — and no layer in the stack is designed to answer it.

## What payment protocols actually prove

A payment authorization proves one thing: **at a specific moment, some party with valid credentials authorized a transfer of value to another party.**

That is the entire claim. It does not prove:

- That the authorizing party understood what they were authorizing
- That the recipient was capable of delivering what was paid for
- That the deliverable matched any acceptance criteria
- That the transaction was not duplicated
- That the merchant's claim of fulfillment is true
- That any recovery process exists if the fulfillment fails

These are not edge cases. They are the ordinary questions that arise in commerce, and the payment layer answers none of them.

## Why this was fine before agents

For a human-driven purchase, the gap between authorization and fulfillment is closed by the human. The buyer knows what they intended to buy. When the goods arrive, the buyer compares the goods to the intent. If they don't match, the buyer initiates a dispute — which the card network handles based on the human's testimony.

The card network's dispute infrastructure assumes a human is available to testify. It assumes the human's intent is knowable because the human is the one who authorized the transaction. It assumes the record of the intent is the human's word.

When an agent is the authorizer, none of these assumptions hold. The agent's intent is not equivalent to the principal's intent. The record of what the agent was asked to do lives in a prompt log that may expire. The record of what the agent actually did lives in a tool-call log that may not have been preserved. The record of what the merchant delivered lives in the merchant's database. None of these records necessarily reference each other.

When the human buyer calls their bank to dispute the charge, they can say "I never asked for this." When the principal behind an agent calls their bank, they have to say "I asked the agent to do something, and the agent did something different, and here is the record that proves it." For most agent systems, that record does not exist.

## Why stablecoin rails make it worse

Card networks at least have a dispute layer. Stablecoin rails generally don't: settlement is final the moment the transaction confirms, with no built-in reversal mechanism. That does not mean value can never move back — the parties can voluntarily transfer funds, and in SAAX's testnet escrow flow the custody contract can transfer funds back to the buyer under an evaluator-signed refund verdict. But that is a separate, conditional transfer, not a reversal of the blockchain record, and it is not guaranteed. On mainnet immediate payments, settlement is final.

This is not a design flaw in stablecoin rails. It is a design property. The entire point of a stablecoin is that settlement is final. The point of a card authorization is that settlement can be reversed under specific conditions. These are different products serving different use cases.

But agents are increasingly being deployed on stablecoin rails for the same reasons they're deployed everywhere — programmable, fast, low-fee, no banking hours. When agent commerce runs on rails that have no dispute mechanism, the gap between authorization and fulfillment becomes permanent.

## The three-layer model that's missing

Agent commerce requires three distinct layers, and most implementations collapse them into one:

**Authorization** — proves that a party with valid credentials authorized a specific transfer of value. This is what x402, MPP, and the card networks handle.

**Commitment** — binds the specific terms of what was agreed. Price, deliverable, deadline, acceptance criteria, evidence requirements, recovery policy. This is the layer that does not exist in most agent commerce systems today.

**Settlement** — moves the value on the specified rail. This is what the payment processors handle.

Most systems today have authorization and settlement. The commitment layer — the one that records what was agreed and evaluates whether the agreement was fulfilled — is missing.

Without the commitment layer, the payment layer is trying to do the work of the commitment layer. It approves transactions it should not approve, and it disputes transactions it cannot evaluate. It has no basis for either decision because it was never given the terms.

## What SAAX does

SAAX Protocol defines the commitment layer as a distinct artifact from the authorization and the settlement.

A commitment binds:
- The authority reference (who authorized this commitment, under what scope)
- The terms (what was agreed, at what price, by what deadline)
- The acceptance criteria (what counts as fulfillment)
- The evidence requirements (what proof must be submitted)
- The recovery policy (what happens if fulfillment fails)
- The settlement reference (which rail settles this commitment, and to what reference)

The authorization and settlement happen on the rails the parties have chosen. The commitment is the record that binds them together — and the record that determines whether the fulfillment matched the agreement.

This is not a replacement for x402, MPP, or the card networks. It is the layer above them — the layer that answers the question the payment layer cannot: *did the fulfillment match the commitment?*

The spec is at [saax-protocol.com/spec](/spec). The conformance suite is at [saax-protocol.com/conformance](/conformance). The commitment schema, the evidence interface, and the settlement-linkage model are documented there.
