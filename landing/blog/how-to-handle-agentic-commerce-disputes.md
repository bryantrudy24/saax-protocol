# How to Handle Agentic Commerce Disputes

*October 8, 2026* 

*Last updated: 2026-10-17*

---

When an AI agent buys something and the purchase goes wrong, the parties usually discover the same problem: there is no structured record of what was actually committed.

The authorization was valid. The credentials were real. The merchant fulfilled a legitimate order. The buyer is looking at a charge for something they never intended to purchase. Card networks were built for a two-party dispute. Stablecoin rails were built for instant, irreversible settlement. Neither was designed to answer the question that matters here: **what did the agent actually commit to, and did the merchant deliver it?**

The dispute isn't about whether money moved. It's about whether the commitment was fulfilled.

The missing piece is not a resolution mechanism. It's the commitment record that makes a dispute decidable — what was authorized, what was agreed, what was executed, what proves fulfillment, and what happens when fulfillment fails.

SAAX Protocol treats the commitment as the primary artifact. Authority, terms, acceptance criteria, evidence requirements, and recovery policy are all bound before execution begins. When something goes wrong, the parties work from that record instead of reconstructing events after the fact.

The commitment lifecycle has defined states for failure:

**COMMITTED → EXECUTING → FAILED → RECOVERY → DISPUTE → RESOLVED → FINAL**

Recovery policy is set at commitment time, not negotiated after the problem emerges. In the integrated testnet escrow flow (Base Sepolia), a dispute freezes the escrowed funds on-chain, and the only way they move is an evaluator-signed verdict (release or refund, recorded as `resolve:release` / `resolve:refund`). This has been demonstrated in testnet runs. Refunds and compensation are separate on-chain transfers, not reversals of blockchain history, and they are not guaranteed. SAAX records what was required, what failed, what action occurred, and when the commitment became final.

The commitment schema, recovery states, and evidence interface are documented at [saax-protocol.com/spec](/spec). The conformance suite is at [saax-protocol.com/conformance](/conformance).
