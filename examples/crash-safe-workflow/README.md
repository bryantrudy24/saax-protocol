# Example 1 — Crash-Safe Agent Workflow

Demonstrates: commitment creation, authorized acceptance, execution, simulated interruption, durable state recovery, and idempotent retry.

**Nonfinancial.** No real payments, no production credentials, no production mutations.

## What this proves

1. A commitment is durably recorded.
2. A second agent (or the same agent after a restart) can retrieve persisted state.
3. Replaying the same operation with the same idempotency key produces no duplicate effect.
4. Stale-version writes are rejected.

## Prerequisites

- Node.js 20+
- The SAAX local Docker testbed (PostgREST + Postgres). See `tests/reliability/README.md`.

## Run

```bash
npm install
node examples/crash-safe-workflow/run.cjs
```

## What the code does

```js
// 1. Create a durable commitment (agent A)
const created = await createCommitment({
  principal: agentA,
  terms: { description: "Compute a SHA-256 digest", acceptanceCriteria: ["crc-001"] },
});

// 2. Agent B accepts within the canonical state machine
const accepted = await acceptCommitment(created.commitmentId, agentB);

// 3. Simulate a crash: the process exits before any further transition.
//    (In the example this is a throw inside a try/finally.)

// 4. A fresh client reads the durable state — the commitment survived.
const reloaded = await getCommitment(created.commitmentId);
assert.equal(reloaded.state, "accepted");

// 5. Idempotent retry: replay the accept with the same idempotency key.
const replay = await acceptCommitment(created.commitmentId, agentB, { idempotencyKey: accepted.idempotencyKey });
assert.equal(replay.replayed, true);           // no duplicate transition
assert.equal(replay.state, "accepted");        // state unchanged
```

## Exit codes

- `0` — all assertions passed
- `1` — an assertion failed

## What is NOT demonstrated

- Real payment / settlement (deliberately excluded)
- Multi-instance concurrency (see `tests/reliability/`)
