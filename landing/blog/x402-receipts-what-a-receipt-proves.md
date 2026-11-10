# x402 Receipts: What a Payment Receipt Actually Proves

*November 4, 2026*

*Last updated: 2026-11-04*

---

An x402 receipt proves that payment moved. It does not prove that anything was delivered.

That distinction decides how much you can rely on a receipt in an agent workflow. A paid HTTP call returns a response, a payment signature, and an on-chain transaction. Collectively these are the receipt. They prove a settlement occurred between two addresses at a point in time. They do not prove the deliverable matched the terms, that the seller's claim of fulfillment is true, or that the purchase was not duplicated.

## What an x402 payment actually returns

x402 turns the dormant HTTP 402 status code into a payment flow: a client requests a resource, the server responds with a Payment Required challenge describing what to pay and to whom, the client settles, and the server returns the resource. The [protocol documentation](https://docs.x402.org/introduction) is explicit that the challenge describes a payment, not a delivery.

x402 V2 moved the payment data into headers (PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE) so the response body stays available for the resource itself, and it adds lifecycle hooks — including before/after settlement verification — so integrators can capture and validate a receipt at the moment payment confirms ([x402 V2 announcement](https://x402.org/x402-v2-launch/)). With V1, integrators had to parse the challenge and the settlement response themselves; V2 gives the SDK a place to hook verification logic.

What an integrator typically stores as a "receipt":

- The PAYMENT-RESPONSE / signature data returned by the server or facilitator
- The settlement transaction hash on the settlement chain
- The seller's fulfillment response (the body that came with the 200)

The first two are payment evidence. The third is a claim.

## What a receipt can be checked against

The useful property of an on-chain receipt is that it can be re-verified by a third party without trusting the agent or the seller. Tools in the ecosystem do exactly this: [vet402](https://vet402.com/) re-reads the settlement transfer on-chain and separates "the server said the payment wall passed" from "the transfer actually confirmed", and [x402-attest](https://github.com/0xsims/x402-attest) issues tamper-evident receipts for paid HTTP calls that a third party can verify without trusting the involved parties.

This works because the settlement reference — chain, asset, amount, sender, recipient, transaction hash — is public. Anyone can replay the read against a block explorer or an RPC and confirm the value moved.

That is the ceiling of a receipt: it proves a transfer. Everything above it is inference.

## What a receipt does not prove

A settlement reference says nothing about:

- **Fulfillment.** The seller may have taken the payment and returned garbage. The receipt is silent.
- **Authorization of the action.** A settled payment is not an authorized action. The authorization question — was the buyer's agent permitted to make this purchase — lives in a different layer (AP2-style mandates, verifiable intent, or a commitment's authority reference), not in the transfer.
- **Non-duplication.** Two separate settlements to the same seller are two receipts. Nothing in either receipt says the second was a mistake.
- **Deliverable quality.** A receipt cannot carry acceptance-criteria evaluation; that requires evidence, not payment.

The x402 spec does not claim otherwise. The gap appears when an agent pipeline treats "receipt present" as "transaction complete". That conflation is where wrong purchases, duplicates, and dispute failures come from. The recovery side of that problem is covered in [Unknown Payment Outcomes: The Agent Recovery Problem Nobody Instruments](/blog/unknown-payment-outcomes-agent-recovery).

## The receipt-to-commitment pattern

The pattern that closes the gap is to bind the receipt to a commitment record created before the purchase attempt.

A commitment record — the kind SAAX defines — holds the authority reference, terms, acceptance criteria, evidence requirements, recovery policy, and the settlement reference of the payment. When the agent pays, the receipt is attached as the settlement evidence for that commitment. Verification then has a shape: does this settlement reference match the commitment's agreed price, recipient, and terms? Is the evidence genuine? Is the outcome consistent with the acceptance criteria?

SAAX's current implementation reflects this split. Receipt lookup by transaction hash is available at /receipt, and the MCP server exposes evidence and authority verification tools; the supported evidence schemes are eip712, cose, and jws (with cose/jws validated structurally, without an attesting verifier — see the [current status page](/status)). A receipt confirms a settlement reference; the status page says so explicitly: it does not prove fulfillment or independently verify the full lifecycle.

One operational caveat that is current as of this writing: the live receipt lookup at /receipt is erroring on a store schema mismatch. The MCP verification and commitment APIs are unaffected. Anyone building on receipt lookup today should read the [current status page](/status) before relying on it.

## Tradeoffs

- **Facilitator trust.** When a facilitator settles on the server's behalf, the receipt's authenticity depends on the facilitator's signing key and the server's honesty. Structural validation is not attestation.
- **Chain finality.** A receipt is only as final as the settlement chain. On Base mainnet, USDC settlement is irreversible once confirmed; there is no chargeback layer underneath the receipt.
- **Receipt vs. evidence.** A receipt is settlement evidence. Fulfillment evidence — the artifact that proves delivery matched the terms — is a separate record with its own verification requirements (freshness, issuer, criteria), as defined in the [commitment lifecycle specification](/spec).

## Where this fits

For a developer wiring agent payments today, the practical rule: capture the signed payment response and the transaction hash at settlement time, verify the transfer independently against the chain, and store the receipt against the commitment that authorized the purchase. Do not let a receipt stand in for fulfillment evidence.

SAAX publishes the [commitment schema, the evidence interface, and the settlement-linkage model](/spec) in the specification, and the [conformance suite](/conformance) pins down the tested behavior.

Next step: build a small capture-and-verify loop — pay for one test resource over x402 on Base Sepolia, save the PAYMENT-RESPONSE and the transaction hash, and re-verify the transfer from the hash before you attach it to anything you consider a completed transaction.
