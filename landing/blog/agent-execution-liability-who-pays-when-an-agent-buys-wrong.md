# Agent Execution Liability: Who Pays When an Agent Buys Wrong

*October 8, 2026* 

*Last updated: 2026-10-17*

---

When an agent buys the wrong thing, four parties can plausibly claim the loss is not theirs.

The **principal** authorized the agent, but only within a stated scope. The **agent** executed according to its configuration, but the configuration is the principal's. The **merchant** fulfilled a legitimate order against valid credentials. The **platform** provided the infrastructure and the rules, but the rules were followed.

Everyone did what they were supposed to do. And yet the loss is real, and someone has to absorb it.

This is not a fraud problem. The credentials were valid. It is not a technical failure. The transactions completed as designed. It is a **liability allocation problem** — and the existing frameworks don't solve it because they were never designed to answer the question that matters here: *which party was responsible for the specific decision that went wrong?*

The card networks built their dispute infrastructure around a two-party model — consumer and merchant — with a clear default: the merchant carries the loss unless the consumer's claim is unsubstantiated. When an AI agent acts on delegated authority, that model breaks. The merchant is now the one holding the short straw, even when the agent's error was the cause. The record the merchant needs to defend the transaction — the user's original prompt, the agent's interpretation, the scope of authority the agent was operating under — does not exist in standard chargeback evidence.

Stablecoin rails make this worse. Settlement is instant and irreversible. There is no chargeback, no classification framework, no process for allocating the loss. The principal who delegated authority to the agent has none of the protections that would have applied on a card transaction, and the merchant has no mechanism to demonstrate that the fulfillment was correct.

Protocol-level solutions are emerging. Job states, evaluator roles, arbitration mandates. Each addresses the *mechanism* of resolution. None addresses the **evidence standard** that makes liability allocation possible in the first place. Without a structured record of what was authorized, what was committed, and what was executed, "who pays" becomes a negotiation between parties with incomplete and incompatible stories.

SAAX Protocol treats the commitment as the primary artifact — the record that makes liability decidable.

A commitment binds authority, terms, acceptance criteria, evidence requirements, and recovery policy **before execution begins**. It records the scope the principal granted, the specific terms the agent agreed to, the acceptance criteria both parties accepted, and the recovery policy that applies if fulfillment fails.

When something goes wrong, the commitment is the record. It shows what was authorized, what was agreed, what was delivered, and what the recovery policy says happens next. The liability question becomes answerable because the facts are structured and agreed.

This does not determine legal liability, and it does not decide who pays. A commitment record supports investigation and review — all parties work from the same structured record instead of reconstructing events after the fact — but who ultimately bears a loss is decided by the applicable rules, contracts, and dispute forums, not by SAAX or by the existence of a record.

The spec is at [saax-protocol.com/spec](/spec). The conformance suite is at [saax-protocol.com/conformance](/conformance). The commitment schema, authority-proof interface, and recovery policy model are documented there.
