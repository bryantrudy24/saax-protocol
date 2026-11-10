# SAAX Protocol — Commitment Lifecycle Specification

*Public specification — versioned (protocol v1.0.3). This document describes the standard, not any particular implementation. Components vary in maturity: routing and immediate payments are public beta on Base mainnet, commitment verification and receipts are beta, escrow custody is testnet preview (not approved for mainnet funds), and unreleased custody/governance candidates are under development / security review. [Read the full terms of use](/terms) before using it with real funds.*

---

## 1. The Commitment Lifecycle

The SAAX commitment lifecycle is a governed commitment that moves through a defined sequence:

**Authority → Commitment → Contract Terms → Execution → Evidence → Verification → Fulfilled or Failed → Settlement or Recovery → Finality → Audit**

The commitment binds the terms — capability, price, acceptance criteria, deadline, cancel condition — **before** value moves. It carries no rail, no credential, no settlement reference: settlement is resolved at execution time.

The commitment is issued before value moves. A spend bound to a commitment must be denied if the requested amount or currency differs.

---

## 2. Evidence / Attestation Abstraction

### 2.1 Principle

SAAX does not trust the buyer or seller to declare fulfillment. Evidence comes from **external sources** with independent verification — temperature sensors, delivery trackers, reputation oracles, inspectors. SAAX validates evidence (structure, signature, provenance, binding) and evaluates it against the commitment's acceptance-criterion verification policies. **SAAX never produces the evidence.**

### 2.2 Evidence record schema

```json
{
  "evidenceId": "0x...",
  "evidenceType": "temperature-reading",
  "issuer": "0x...",
  "subject": "0x...",
  "issuanceTimestamp": "2026-10-06T...",
  "contextReference": "0x...",
  "payload": { ... },
  "payloadHash": "sha256:...",
  "provenance": { ... },
  "signature": "COSE_Sign1...",
  "verificationScheme": "eip712|cose|jws",
  "verificationMaterial": "0x...",
  "commitmentId": "0x...",
  "acceptanceCriterionId": "0x..."
}
```

Every field is validated; only recognized fields are kept. The payload hash is the SHA-256 of the canonical JSON encoding of the payload — any payload tampering changes the hash and fails validation.

### 2.3 Verification-policy model

The commitment specifies a verification policy per acceptance criterion:

```json
{
  "criterionId": "0x...",
  "criterionDescription": "delivery temperature <= 5C",
  "requiredEvidenceType": "temperature-reading",
  "acceptedIssuers": ["0x..."],
  "verificationScheme": "cose",
  "evaluationLogic": "payload.temperature <= 5",
  "maxEvidenceAge": 3600,
  "minimumEvidenceCount": 1
}
```

Policies are provider-neutral: `acceptedIssuers` is an optional allowlist, `evaluationLogic` is a tiny safe evaluator (numeric comparison only — no code execution), and `verificationScheme` selects the signature scheme (eip712 | cose | jws).

### 2.4 Evaluation

SAAX provides three operations over evidence:

- **Validate evidence** — checks structure, signature, provenance, and binding to the commitment and criterion. A hash-vs-payload mismatch (tampering) fails validation.
- **Evaluate criterion** — applies the verification policy (type, allowlist, freshness, evaluation logic, minimum count) and returns `satisfied | not_satisfied | insufficient_evidence`.
- **Record outcome** — writes the result to the commitment record, bound to the commitment and criterion.

### 2.5 Evidence lifecycle

```
commitment issued
  ->
acceptance criteria defined with verification policies
  ->
external evidence submitted (from any source)
  ->
SAAX validates evidence (structure, signature, provenance, binding)
  ->
SAAX evaluates against criterion
  ->
outcome recorded: satisfied | not_satisfied | insufficient_evidence
  ->
commitment reaches finality or enters recovery
```

The signature scheme `eip712` is verified cryptographically over the EIP-712 domain `{ name: 'SAAX Evidence', version: '1' }`. `cose` and `jws` envelopes are validated **structurally** — envelope shape, required headers, and field typing — by the reference implementation; cryptographic verification of the token's signature requires the pluggable verifier hook to be connected to an attesting verifier (for example an issuer's public-key store). Structural validation alone does not prove who signed the token. A commitment that accepts `cose`/`jws` evidence should specify the verifier that attests it.

---

## 3. Authority-Proof Interface

### 3.1 Principle

A commitment references an **external authority proof** — AP2 mandates, verifiable intents, OAuth tokens, or custom schemes. **SAAX does not issue authority proofs; it consumes them** from external systems and re-evaluates them at execution time.

### 3.2 AuthorityProof structure

```json
{
  "authorityProofId": "0x...",
  "proofType": "ap2-mandate|verifiable-intent|oauth-token|custom",
  "issuer": "0x...",
  "subject": "0x...",
  "scope": { ... },
  "validFrom": "2026-10-06T...",
  "validUntil": "2026-10-07T...",
  "signature": "COSE_Sign1...",
  "verificationScheme": "cose|jws|eip712",
  "verificationMaterial": "0x..."
}
```

Scope model: `actions[]` (the requested action must be in this list), optional `capability`, optional `amountMax` (raw units), optional `currency`. An absent scope dimension is unrestricted; a present dimension must be satisfied by the commitment.

### 3.3 Validation

- **Validate authority proof** — checks structure, signature, scope, and time validity.
- **Is authorized** — verifies the proof covers the specific action the commitment represents (combines integrity + time + scope).
- **Attach to commitment** — attaches the proof **reference** to the commitment at issuance. The full proof and its signature are never stored on the commitment — only the verifiable reference; the proof material lives at the external issuer.

### 3.4 Authority lifecycle

```
authority proof presented (external source)
  ->
SAAX validates proof (structure, signature, scope, time)
  ->
commitment issued, referencing the authority proof
  ->
proof evaluated at execution time (still valid? still in scope?)
  ->
commitment validly authorized or rejected
```

In the current v3 agreement format, an agreement without an external authority proof is signed directly by the parties — the buyer and the seller — and those signatures are part of the digest that is hashed and anchored. That is the normal path today, not a legacy fallback; external authority proofs are an additional authorization mechanism a commitment can reference.

---

## 4. Settlement-Rail Neutrality

**SAAX does not prescribe a settlement rail.**

- The commitment issues a settlement **requirement (R)** that is rail-agnostic: `R = <amt, cur, payee, eta, scheme, t_exp>` — no rail knowledge at commitment time.
- The **rail (S)** is resolved at execution time from the registered registry.
- Currently registered rails: **x402**, **MPP**.
- Future rails: entitlement, card, ACH, internal ledger — any implementation of the rail interface can register as a SAAX settlement rail.

### 4.1 Rail interface

```
interface SettlementRail {
  realise(R): Credential                    // turn a neutral requirement into a credential
  validate(Credential, R): boolean          // is this credential valid FOR R?
  settle(Credential): TransactionReference  // move value; return PUBLIC tx reference
}
```

Any system that implements this interface can register as a SAAX settlement rail:

```js
registry.register('new-rail', { realise, validate, settle });
const rail = registry.resolve('new-rail');
```

The rail knows nothing about the commitment's content; it only knows how to realise R. Rail credentials never appear in receipts, logs, or results — only the public transaction reference.

---

*SAAX components vary in maturity: the specification is public and versioned, routing and immediate payments are public beta on Base mainnet, commitment verification and receipts are beta, escrow custody is testnet preview (not approved for mainnet funds), and unreleased custody/governance candidates are under development / security review. [Read the full terms of use](/terms). Nothing in this specification constitutes financial, legal, or investment advice.*
---

## 5. Escrow Custody (Day 17)

SAAX escrow protects funds pending an outcome. The escrow is a **separate on-chain custody contract** — never an in-memory flag, never a direct transfer labelled "escrow".

*Status note: the custody implementation described below refers to the hosted testnet escrow flow (Base Sepolia, chain 84532). A newer custody candidate, `SAAXEscrowCustodyV3.sol`, has been tested only on a local EVM (chain 31337) and is under independent-review preparation; it is not deployed and does not power any hosted flow. See [current status](/status).*

### 5.1 Where funds are held

Settled USDC is moved into `SAAXEscrowCustodyV1` on the configured network (Base Sepolia for testnet). The contract's `balanceOf(this)` is the authoritative held amount — verifiable on-chain by anyone, without SAAX's database.

### 5.2 Who can release / refund / withdraw

- **release(commitmentId, digest, nonce, issuedAt, v, r, s)** — releases USDC to the seller. Requires an **EIP-712 verdict signed by the agreed EVALUATOR** (from the commitment terms, bound at fund time). `msg.sender` may be a relayer; the recovered signer must equal the evaluator. Wrong signer / wrong digest / expired / replayed verdict → revert.
- **refund(...)** — returns USDC to the buyer. Requires an evaluator-signed refund verdict **OR** the deadline has passed (timeout refund, no signature needed).
- **raiseDispute / resolve** — only the funded buyer or seller can raise a dispute (funds freeze); only the evaluator's signed verdict naming `release|refund|hold` resolves it.
- **NO admin, NO owner, NO upgrade, NO withdraw function.** Once funded, funds move ONLY to the seller (release) or buyer (refund). The deployer cannot pull funds; SAAX's database status cannot move funds.

### 5.3 Binding

Custody is bound to:
- **commitment digest** (bytes32, from the EAS-anchored manifest) — every terminal action requires it; wrong digest reverts.
- **buyer, seller, evaluator, asset, amount, network, deadline** — frozen at `fund()`; terminal states are final (one release OR one refund, never both).

### 5.4 Timeout / refund / dispute / evaluator / upgrade behavior

- **Timeout**: after `deadline`, `refund()` without a signature succeeds (funds return to buyer). Before deadline, unsigned refund reverts.
- **Dispute**: `raiseDispute` from `Funded` freezes funds into `Disputed`; direct release/refund during dispute reverts; only `resolve` (evaluator verdict) moves funds.
- **Evaluator unavailable**: a Funded escrow can use its unsigned deadline refund after the deadline. A Disputed escrow cannot use that timeout path and can remain frozen indefinitely. No automatic resolution or operator override exists.
- **Upgrade**: none — the contract is immutable by design.

### 5.5 Contract addresses (testnet)

- EAS: `0x4200000000000000000000000000000000000021`
- SchemaRegistry: `0x4200000000000000000000000000000000000020`
- Base Sepolia USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- `SAAXEscrowCustodyV1` source: `contracts/SAAXEscrowCustodyV1.sol` (deployed via `scripts/testnet-broadcast.js --deploy-custody`)

---

## Discovery signature and financial-profile clarification (2026-11-06)

Discovery profile 1.0.0, acceptance-v1 and `manifest-v1.1+saax-proposal-bound` are distinct from protocol/package v1.0.3 and older v3 agreement exports. The live Discovery path uses actual Ed25519 JWS crypto for provider proposal/SR and onboarded-buyer acceptance. The general structural COSE/JWS evidence-hook limitation in section2.5 still applies to that separate evidence interface; it must not be generalized to claim Discovery JWS is structural-only.

The public Discovery/preflight/acceptance operations create no payment, custody or service execution. Financial terms are not spending authority. A financial profile selecting network/asset/rail/mode cannot later substitute them under the general rail-neutral abstraction; the provider must issue new terms and the buyer must accept them.

The separate `discovery-financial-v2` testnet export profile binds an explicitly signed Sepolia profile, exact proposal/terms/manifest digests, configured buyer authority, evaluator address/permitted decisions, custody/runtime identity, recovery rules and evidence policy. Its independent verifier checks the deployed-contract verdict, timestamp and actual successful custody/token outcome without application DB credentials. The local SHA256 self-test evidence and separate evaluator evidence-to-verdict attestation are explicitly operator-controlled, not an external attester demonstration, EAS anchor or independent audit. [Details and limitations](/blog/signed-discovery-to-testnet-finance).

## 6. Durable Persistence — Implementation Profiles

The standard requires that a commitment's authoritative state survive process restarts and be recoverable by a replacement worker. It does not prescribe one storage technology. Implementations satisfy this by profile:

- **Postgres profile** (the reference deployment's Docker `ax_router` database): escrow state lives in `ax_router.escrows` with atomic conditional transitions; process memory is only a cache.
- **File-ledger profile** (the escrow-access acceptance milestone): accepted operations, nonce consumption, and reconcile outcomes are persisted to a JSON ledger with atomic rename (`data/escrow-access-ledger.json`). Nonce consumption happens at durable acceptance, not at external execution; an identical retry returns the recorded result; a changed payload on the same nonce is rejected.
- **Memory-only profile** (the x402 idempotency cache): duplicate-request responses are held in working memory and are lost on restart. This does not affect the durable escrow record.

### 6.1 Tables

- `ax_router.escrows` — one row per commitment; immutable binding fields (digest, buyer, seller, evaluator, amount, asset, network, deadline) + mutable state/version + tx refs + audit chain.
- `ax_router.escrow_events` — ordered, hash-chained audit events (append-only, FK to escrow).
- `ax_router.escrow_intents` — external action intents persisted BEFORE any broadcast (idempotency-keyed, unique), reconciled AFTER with the authoritative outcome.

### 6.2 Atomic transitions

`upsert_escrow` is a single SQL statement that:
- rejects **stale writes** (`STALE_VERSION` — a generic upsert can never clobber newer durable state),
- rejects **illegal transitions** (`ILLEGAL_TRANSITION` — e.g. held→unfunded),
- rejects any change to a **terminal state** (`TERMINAL_STATE` — released/refunded/timed_out are final).

`record_escrow_intent` / `update_escrow_intent` enforce intent lifecycle atomically: pending→broadcast once; confirmed is terminal; duplicate idempotency keys are rejected (no double broadcast).

### 6.3 Recovery

On restart, `pending_escrow_intents` returns all pending/broadcast/unknown intents; the replacement worker re-queries authoritative chain/service state before retrying. Unknown outcomes remain explicitly `unknown` until reconciled. A missing record or an absent transaction scan is never treated as proof that a broadcast did not happen: the worker must determine the on-chain outcome by reading the chain at the identified reference, and only then record it. Demonstrations: `scripts/test-escrow-durable.js` (14 checks), `scripts/test-worker-failure.js` (11 checks, real SIGKILL).

---

## 7. Independent Verification (Day 17)

`verifier/verify-export.js` runs in a **fresh process with no SAAX database access** and derives every result from the export + public chain data:

1. **Agreement digest** — recomputes `sha256` of the COSE_Sign1 envelope (documented algorithm) and compares to the export.
2. **Party authorization** — recovers the EIP-712 signer of each authorization record (secp256k1) and checks it against the agreed party; never trusts a claimed signer.
3. **EAS anchor** — reads `getAttestation(uid)` via the chain RPC; checks schema UID, revocable=false, and the on-chain commitment digest.
4. **Journal ordering** — validates the hash-linked audit chain (root=commitmentId; every entryHash matches content; timestamps monotonic).
5. **Escrow terminal outcome** — a claimed release/refund must carry a tx reference; with an RPC, the receipt must be success. Non-terminal state = explicit `unknown`.
6. **Evidence-backed release** — a released escrow must cite evidence references.

Tampering classes rejected by test: modified terms, altered/reordered/missing journal events, forged evidence, wrong anchor, substituted escrow tx refs, incomplete digest, incomplete terminal escrow. Incomplete → explicit NOT VERIFIED (incomplete/unknown), never success.

---
