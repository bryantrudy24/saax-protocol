# Example 3 — Agentic Commerce Authorization Boundary

Demonstrates a conceptual commerce workflow: buyer instruction → agent authority → spending-policy check → commitment preparation → simulated payment authorization → evidence requirement → completion or recovery.

**Nonfinancial.** Everything that would touch money is simulated. No production credentials, no real funds, no production mutations.

## What this example clarifies

The central SAAX design principle: **payment authorization, transaction execution, and durable commercial commitments are related but distinct responsibilities.**

This example walks through a complete workflow and labels each step:

| Step | SAAX-native | External / simulated |
|---|---|---|
| Buyer instruction | — | Simulated (user event) |
| Agent authority resolution | SAAX (durable authorization) | — |
| Spending-policy check | — | Simulated (external policy engine) |
| Commitment preparation | SAAX (`create_commitment`) | — |
| Payment authorization | — | x402 / AP2 / payment rail (simulated) |
| Fulfillment evidence | SAAX (`submit_evidence`, `verify_evidence`) | — |
| Completion or recovery | SAAX (lifecycle transitions) | — |

## Run

```bash
npm install
node examples/authorization-boundary/run.cjs
```

## Exit codes

- `0` — workflow completed and assertions passed
- `1` — a boundary or assertion failed

## What is NOT implied

- A full x402 / AP2 / ACP integration (those are **simulated** here).
- Real spending authority (the policy check is a local variable).
- That a commitment automatically triggers a payment.
