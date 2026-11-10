# The Audit Trail Problem in Agentic Commerce

*October 8, 2026* 

*Last updated: 2026-10-17*

---

Six months after an agent made a purchase, someone needs to know what happened.

The buyer wants to reconcile the charge. The merchant wants to prove the fulfillment was correct. A regulator wants to understand how the decision was made. An auditor wants to verify that the transaction complied with the policy that was in force at the time.

Every one of them asks the same question: *can you reconstruct what actually happened?*

In most agentic commerce systems today, the answer is no.

## Why the record doesn't survive

Agent transactions produce a scattered trail. The agent runtime logs the tool calls. The merchant logs the orders. The payment rail logs the settlements. The model provider may log the prompts, if anything, for a limited window. The authorization system logs the delegation. Each of these records is fragmentary, held by a different party, retained for a different period, and structured differently.

Reconstructing a single transaction across all of them requires the cooperation of every party involved, in a time window before any of them have deleted their logs. In practice, that window closes faster than anyone expects. Log retention policies range from days to months. The agent's session context is gone the moment the process restarts. The model provider's prompts are typically retained for 30 days at most.

Six months later, there is nothing to reconstruct from.

This isn't a storage problem. Storage is cheap. The problem is that no one treated the transaction as a record worth preserving in the first place. Each system recorded what it needed for its own operation, and none of them recorded what would be needed to answer the question that comes later.

## What an audit trail actually requires

An audit trail is not a log. It is a **structured, verifiable record that answers the questions a later reviewer will ask**. For agentic commerce, those questions are:

- **What was authorized?** The principal's instruction. The scope granted to the agent. The limits in force at the time.
- **What was committed?** The specific terms the agent agreed to. Price. Deliverable. Deadline. Acceptance criteria.
- **What was executed?** The agent's actions. The merchant's fulfillment. The settlement that occurred.
- **What proves fulfillment?** External evidence that the deliverable matched the acceptance criteria. Independent attestations if applicable.
- **What recovery occurred?** If something failed, what the recovery policy said, what action was taken, and when the commitment reached finality.

An audit trail is not a single log line. It is a **bound record** that captures all five of these as a unit, so they can be reviewed together when the question is asked.

## Why existing solutions don't cover this

**Application logs** capture what an application did. They do not capture the authority under which it acted, the terms it was bound to, or the evidence that supports its claims.

**Payment records** capture that money moved. They do not capture what the payment was for, whether the deliverable matched the commitment, or what recovery policy applied if it didn't.

**Blockchain settlement** is immutable but minimal. A transaction hash proves the settlement occurred. It does not prove what the settlement was for.

**AP2 and similar protocols** define authorization mandates. They record that an agent was authorized to act. They do not record what the agent actually committed to, what was delivered, or how the outcome was verified.

**Platform audit logs** are held by the platform. They are useful for the platform's own operations. They are not a durable record the buyer, merchant, or regulator can independently verify.

Each captures a piece. None captures the commitment record that makes the transaction reconstructable.

## What SAAX does

SAAX Protocol treats the commitment as the durable unit of record. A commitment captures:

- The authority reference (the proof that the agent was authorized to act)
- The terms (what was promised, at what price, under what constraints)
- The acceptance criteria (what counts as fulfillment)
- The evidence references (what proof was submitted to demonstrate fulfillment)
- The settlement reference (which rail settled, and to what reference)
- The outcome (whether the commitment was fulfilled, failed, or disputed)
- The finality (when the commitment reached its terminal state)

Each commitment is signed and hashed. The record is structured. It survives process restarts, session boundaries, and platform retention policies because it is stored independently of any single party's operational logs.

This does not replace the operational logs of each system. It provides the **commitment record** that all of them can reference when a later reviewer asks what happened.

## What "durable" actually means

The record has to be durable in three ways:

**Structurally durable** — the record has a defined schema, not free-form text. A reviewer in six months can read it and understand what happened without needing the original system to explain.

**Cryptographically durable** — the record is signed by the parties that created it and hashed for integrity. Alteration after the fact is detectable.

**Independently durable** — the record is not held solely by one party. Any party to the commitment can hold a copy. The absence of one party's storage does not erase the record.

## Why this matters for the parties involved

For the **buyer**, the record shows what was authorized and what was delivered. If the delivered result does not match the acceptance criteria, the record is the evidence for the recovery claim.

For the **merchant**, the record shows that fulfillment was performed against a specific commitment with specific terms. The merchant does not carry the liability for a decision that was made against the commitment.

For the **platform or rail**, the record shows the commitment that the settlement was linked to. The platform does not need to reconstruct what the transaction was for — the commitment record answers it.

For the **regulator or auditor**, the record is the structured evidence they need to verify that the transaction complied with the policy in force at the time.

## What this looks like in practice

When a SAAX commitment is created, it includes the authority reference, the terms, the acceptance criteria, the evidence requirements, and the recovery policy. This becomes the durable record.

When the commitment is executed, the evidence is attached as references — external attestations, delivery proofs, delivery hashes — signed and bound to the commitment.

When the commitment reaches fulfillment or failure, the outcome and finality states are recorded against the same commitment. The full lifecycle — from authority to finality — is captured in a single durable record.

Six months later, the record still exists only if the parties retained it: the export file, the on-chain anchor, and the evidence material must be available. The on-chain digest and attestation are durable; the full agreement terms and evidence payloads are durable only where the parties keep them (or where the export preserves them). A record that exists only in a worker's memory is not durable. Exporting the commitment and retaining the evidence are part of making the audit trail real.

The spec is at [saax-protocol.com/spec](/spec). The conformance suite is at [saax-protocol.com/conformance](/conformance). The commitment schema, the evidence interface, and the audit-chain structure are documented there.
