# SAAX Settlement Linkage

This document defines how a SAAX commitment relates to economic settlement. The central rule: **SAAX does not prescribe a settlement rail.** A commitment carries a rail-agnostic settlement requirement, and the actual movement of value happens through registered settlement rails, resolved at execution time.

## 1. The rule

- A commitment issues a **settlement requirement (R)** — an abstract description of what needs to settle: amount, asset, recipient, chain, deadline. R is rail-agnostic.
- The **settlement rail (S)** is resolved at execution time from the registered rail registry.
- Commitment settlement is linked **by reference**, never by rail mechanism. The commitment records a `settlementReference` (rail name, credential, transaction reference) — it does not embed rail-specific plumbing.
- A conforming implementation MAY support any subset of registered rails. Supporting a rail is an implementation choice; the Protocol only defines the linkage abstraction.

## 2. The SettlementRail interface

```text
interface SettlementRail {
  realise(R) -> Credential
  validate(Credential, R) -> boolean
  settle(Credential) -> TransactionReference
}
```

| Method | Input | Output | Meaning |
|---|---|---|---|
| `realise(R)` | Settlement requirement R | `Credential` | Turn the requirement into a concrete, rail-specific payment credential (e.g., an EIP-3009 authorization for x402, an MPP quote/payment for MPP) |
| `validate(Credential, R)` | Credential + R | boolean | Verify the credential satisfies R: correct amount, asset, recipient, deadline, and valid signature |
| `settle(Credential)` | Credential | `TransactionReference` | Execute the settlement through the rail and return a reference to the on-chain transaction / ledger entry |

Any system that implements this interface can register as a SAAX settlement rail.

## 3. Settlement reference record

A commitment's `settlementReferences[]` entries carry, by reference:

```json
{
  "rail": "x402",
  "credentialReference": "urn:saax:credential:x402:...",
  "transactionReference": "0x...", 
  "amount": "50000",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "at": "2026-10-06T12:05:00Z",
  "status": "settled"
}
```

The settlement requirement R lives in `paymentTerms.settlementRequirement` on the commitment (see `commitment-schema.md`).

## 4. Currently registered reference rails

Two rails are registered as **reference implementations**:

| Rail | What it is | realise(R) → Credential | settle(Credential) |
|---|---|---|---|
| `x402` | HTTP 402 Payment Required challenge/response flow with on-chain asset transfers | An EIP-3009 authorization (transferWithAuthorization) for the required amount/asset to the recipient | Broadcast the authorization; return the tx hash |
| `mpp` | Multi-party-payment streaming rail | An MPP payment credential for the amount/asset/recipient | Submit the payment; return the ledger reference |

These are reference implementations of the interface — not requirements of the Protocol. A conforming implementation can register any other rail that implements the interface.

## 5. Adding a new rail

1. Implement the `SettlementRail` interface (`realise`, `validate`, `settle`) for the new rail.
2. Register it in the rail registry under a unique name (e.g. `entitlement`, `card`, `ach`, `internal-ledger`).
3. Ensure `realise(R)` produces a credential whose `validate` passes against R, and `settle` returns a `TransactionReference`.
4. No Protocol change is required. The commitment's `settlementRequirement` remains rail-agnostic; the rail is resolved at execution time.

Because settlement is linked by reference, adding a rail does not change the commitment schema, the lifecycle, or the audit chain.

## 6. Conformance

Settlement vectors live in the [conformance suite](../conformance). A conforming implementation must resolve the registered rail for a given R, validate the credential, and return a transaction reference — and must reject unsupported rails with the canonical `SET_UNSUPPORTED_RAIL` error.

## 7. Rail-neutral commitment attachment (saax_commitment_id)

A commitment id links to settlement on ANY rail through a single rule: **the on-chain transaction hash is the binding key.** The commitment carries the rail-neutral id `saax_<hash>`; at settlement time the rail reference (txHash / ledger reference) is stored on the commitment (`settlement_ref` in the store, `settlementReferences[]` in the spec), and the receipt endpoint resolves back by that reference. The attachment pattern is identical for every rail: put the commitment id in the payment payload’s external-reference field so the payer and payee both carry it, and record the txHash on the commitment so the seller can query the receipt.

### 7.1 x402

x402 (HTTP 402 Payment Required) carries arbitrary metadata in the top-level `extensions` object of the signed payload. The commitment id is attached there:

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "exact", "network": "eip155:8453", "amount": "100000", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "0xSeller...", "maxTimeoutSeconds": 60 },
  "payload": { "signature": "0x...", "authorization": { "from": "0xBuyer...", "to": "0xSeller...", "value": "100000", "validAfter": "0", "validBefore": "1800000000", "nonce": "0x..." } },
  "extensions": {
    "saax_commitment_id": "saax_7f3a9b2c..."
  }
}
```

The x402 verifier ignores unknown top-level fields, so `extensions` is non-breaking. After settlement, `settlement_ref = { "txHash": "0x...", "rail": "x402" }` is written to the commitment, and `GET /receipt?txHash=0x...&rail=x402` returns the commitment id.

### 7.2 MPP (multi-party payment)

MPP credentials carry an external reference field for the payment instructions. The commitment id is attached in that field:

```json
{
  "rail": "mpp",
  "payment": {
    "currency": "USDC",
    "amount": "100000",
    "recipient": "0xSeller...",
    "externalReference": {
      "saax_commitment_id": "saax_7f3a9b2c..."
    }
  }
}
```

After settlement the MPP ledger reference is recorded as `settlement_ref`, and `GET /receipt?txHash=<mpp-reference>&rail=mpp` returns the commitment id.

### 7.3 AP2 (authorized push payment)

AP2 (an authorized push payment rail) uses a remittance/reference field on the payment instruction:

```json
{
  "rail": "ap2",
  "instruction": {
    "currency": "USDC",
    "amount": "100000",
    "recipient": "0xSeller...",
    "remittanceReference": "saax_7f3a9b2c..."
  }
}
```

After settlement the AP2 transaction reference is recorded as `settlement_ref`, and `GET /receipt?txHash=<ap2-reference>&rail=ap2` returns the commitment id.

### 7.4 ACP (account-to-account / automated clearing payment)

ACP rails expose a memo/end-to-end reference field on the transfer:

```json
{
  "rail": "acp",
  "transfer": {
    "currency": "USDC",
    "amount": "100000",
    "account": "0xSeller...",
    "memo": "saax:saax_7f3a9b2c..."
  }
}
```

After settlement the ACP transaction reference is recorded as `settlement_ref`, and `GET /receipt?txHash=<acp-reference>&rail=acp` returns the commitment id.

### 7.5 Universal rule

```text
commitment id (saax_<hash>)
  -> carried in the rail’s external-reference field at payment time
  -> on-chain / ledger transaction reference (txHash) recorded on the commitment at settlement
  -> GET /receipt?txHash=<ref>&rail=<rail> resolves back to the commitment id
```

The receipt endpoint is rail-neutral: it takes any txHash / ledger reference and returns the matching commitment id with the `rail` field. Rail is metadata, never a prerequisite.