// SAAX Protocol — crash-gap recovery harness (milestone: recovery).
// Uses the INTEGRATED path: the same v3 digest construction, EAS anchoring,
// custody funding, contract-scheme EscrowVerdict release, durable-acceptance
// ledger (escrow-access.js), and export builder as the connected flow.
//
// The scenario (real Base Sepolia financial action):
//   Worker 1 (broadcast worker):
//     a. computes a fresh v3 digest + commitmentId
//     b. broadcasts a REAL EAS attestation (anchor)
//     c. buyer funds the custody against the EXACT digest + evaluator
//     d. durably ACCEPTS the release operation (ledger, nonce consumed)
//     e. signs the contract-scheme EscrowVerdict (custody domain, nonce, issuedAt)
//     f. BROADCASTS the release transaction via sendTransaction — hash known,
//        receipt NOT waited for, receipt NOT recorded anywhere
//     g. writes pid + last log line to evidence/recovery-kill-evidence.json
//     h. dies (process.exit(9)) — the crash gap: broadcast in flight,
//        receipt never recorded by the worker that broadcast it
//   Worker 2 (replacement worker):
//     a. reads the accepted operation from the ledger (nonce already consumed)
//     b. reads the handoff tx hash; chain-reads the receipt by hash
//     c. determines the on-chain outcome (mined? success? state?)
//     d. records the outcome via escrow-access.reconcile() — the external
//        effect is recorded, NOT repeated (never re-broadcasts)
//     e. builds the full-lifecycle export from the real events
//   Then the v3 verifier runs against the export independently.
//
// The external effect count must be exactly ONE release transaction.
module.exports = {}; // shared-marker only; the driver runs workers as children