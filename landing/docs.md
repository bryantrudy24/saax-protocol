# SAAX integration guide

*Last verified: 2026-11-06*

> **SAAX Protocol — Public Beta**
>
> SAAX Protocol is currently in public Beta. Immediate-payment functionality is available on Base mainnet, while escrow custody remains limited to testnet.
>
> Independent external security review is pending. Although internal verification and reliability testing have been performed, these do not replace an independent security assessment.
>
> Live transactions involve financial and technical risks, including potential loss of funds and irreversible blockchain transfers. Users should evaluate these risks carefully and use the platform at their own discretion.
>
> *This notice does not constitute a guarantee of reimbursement, dispute recovery, or financial protection.*

Start with the interface you intend to use. Public signed Discovery and buyer-authorized commitment creation do not move funds. Existing immediate payments are public beta on Base mainnet. The connected custody integration is a separate Base Sepolia testnet preview, operated through controlled scripts rather than public financial execution endpoints.

Read the [terms](/terms) and [current status](/status). No refund, safety, service-quality or independent-audit guarantee applies.

## Choose a supported path

| Path | Availability | What it does |
|---|---|---|
| Signed profile → preflight → buyer acceptance | **Beta; publicly deployed** | Creates a verifiable commitment after configured buyer authorization; no financial side effect. |
| Immediate x402 payment | **Public beta; Base mainnet 8453** | Existing direct USDC payment flow, no mainnet escrow. The MPP rail is implemented but not registered in production. |
| Discovery → custody → signed release/refund | **Testnet preview; operator-run** | Actual Base Sepolia 84532 test-USDC execution with complete independent export verification for the defined self-test. No public financial API. |
| Unreleased custody/governance candidates | **Under development / security review** | Not the deployed CustodyV1 implementation; Custody V3 has an owner-approved snapshot for independent review (review not completed — not an audit, not readiness, not deployment approval); no mainnet approval or completed independent audit. |

## Discovery quickstart

### 1. Authenticate the provider key independently

Download the public profile:

```sh
curl https://saax-protocol.com/.well-known/saax.json
```

The current provider is `https://saax-protocol.com/`, origin `https://saax-protocol.com`, keyId `live-2026-11`, Ed25519 JWK thumbprint `KebjwLFLSV6LJFZ_Hp7ROBkVpHVBwrFNRgHkAQ5JldM`. These are identifiers to compare, **not an independent trust source merely because this page or the same server displays them**. Confirm the provider/key mapping through a separately authenticated operator channel before installing it in your client's trust configuration. Verify the full profile signature, origin, version, active key validity and expiry against that configured key.

Supported trust is configured-key onboarding. DID, registry or automatically permissionless publisher authentication is not established. Signature validity and publisher identity are separate checks. Rotate a trust pin only after independently authenticating its replacement; preserve historical verification keys.

### 2. Request free, nonbinding preflight

Use an exact combination from the authenticated profile. The preserved public profile currently identifies `eip155:8453` and Base-mainnet USDC. **Do not execute that proposal on testnet.** The operator-run financial preview uses a different, separately signed testnet profile.

Example request below is illustrative. Replace the buyer with your own address, generate a new nonce/time/deadline, and use the exact schema and combination in the verified live profile. Schema digests in that profile are provider declarations, not proof of an external schema audit.

```json
{
  "profileVersion": "1.0.0",
  "capability": { "id": "security-scan" },
  "schema": {
    "id": "https://saax-protocol.com/schemas/commitment-manifest/v1",
    "version": "1",
    "digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333"
  },
  "units": { "amount": "1000", "unit": "micro-units of settlement asset" },
  "financialProfile": {
    "network": "eip155:8453",
    "asset": "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "rail": "x402",
    "mode": "x402"
  },
  "constraints": { "deadline": "REPLACE_WITH_FUTURE_UTC_ISO_TIME" },
  "intendedParties": { "buyer": "REPLACE_WITH_YOUR_EVM_ADDRESS" },
  "clientNonce": "REPLACE_WITH_UNIQUE_NONCE_AT_LEAST_8_CHARS",
  "issuedAt": "REPLACE_WITH_CURRENT_UTC_ISO_TIME"
}
```

Save the completed request as `prepare-request.json` and send:

```sh
curl https://saax-protocol.com/prepare-commitment \
  -H 'Content-Type: application/json' \
  --data-binary @prepare-request.json
```

MCP `prepare_commitment` uses the same validation core. Verify the returned Ed25519 JWS over canonical proposal bytes, request digest, intended buyer/audience, schema/profile/manifest versions, network/asset/amount/decimals/unit, rail/mode, policy, nonce, issuedAt and expiry. Do not trust unsigned top-level copies instead of the signed representation.

Preflight charges no fee and creates no economic commitment, reservation, execution or spending authority. Identical nonce/request retries return the existing proposal; changed content under the same nonce conflicts. Proposals are offers-until-expiry subject to explicit stale-on-change revalidation, not guaranteed capacity.

### 3. Sign buyer acceptance, then create one commitment

A provider signature is not buyer consent. Acceptance requires a separately onboarded buyer Ed25519 public key mapped to the buyer identity and scope by the operator; possessing an arbitrary wallet address or copying a public key into the request does not register it. Unsupported buyers receive authorization errors. This is not permissionless buyer onboarding.

The acceptance-v1 document binds action `accept_commitment`, domain `saax:acceptance:v1`, intended provider/audience, buyer identity, proposalId and exact proposalDigest, termsDigest, profile/manifest/schema versions, an independent nonce, and a validity window. Sign canonical acceptance bytes with the registered buyer key. The operator revalidates supported terms, trust and expiry before durable acceptance.

```json
{
  "proposal": { "...": "FULL_SIGNED_PROPOSAL_UNCHANGED" },
  "acceptance": { "...": "FULL_BUYER_SIGNED_ACCEPTANCE_V1" },
  "idempotencyKey": "PERSIST_ONE_KEY_FOR_THIS_OPERATION"
}
```

Post this envelope to `https://saax-protocol.com/accept-commitment`, or call MCP `accept_commitment`. A successful first creation returns201; an identical retry returns the existing operation/commitment. Reusing a single-use proposal with a new key is rejected. The authenticated commitment contains manifest-v1 fields plus the real provider JWS wrapper `manifest-v1.1+saax-proposal-bound`; the historical COSE-shaped placeholder is not itself a cryptographic signature.

The operation may carry financial terms but creates **no token approval, transfer, escrow funding, service execution or verdict**. Later financial choices require their own signed terms and authorization. Do not equate proposalId, operationId, commitmentId, manifestHash, escrow ID or transaction hash.

## MCP integration

Endpoint:

```text
https://www.saax-protocol.com/mcp
```

The release check initializes MCP and calls `tools/list`, `ping` and `get_protocol_info`. The deployed tool names are (verified live against the production endpoint):

**Core & routing**

- `get_protocol_info`, `get_routing_fee`, `ping`
- `route_request`, `list_capabilities`
- `prepare_commitment`, `accept_commitment`, `create_commitment`

**Commitments & lifecycle**

- `get_commitment`, `list_commitments`, `get_commitment_status`
- `get_commitment_history`, `get_recovery_status`, `get_pending_actions`
- `resume_commitment`, `cancel_commitment`, `close_commitment`

**Evidence**

- `submit_evidence`, `list_evidence`, `verify_evidence`
- `get_evidence_verification`, `get_authority_validation`

**Disputes**

- `raise_dispute`, `resolve_dispute`, `list_disputes`

All 25 tools are available through the same endpoint. Mutating tools (`create_commitment`, `accept_commitment`, `cancel_commitment`, `close_commitment`, `submit_evidence`, `verify_evidence`, `raise_dispute`, `resolve_dispute`, `resume_commitment`) require the caller to present a valid EIP-712 authority proof and to hold the corresponding authorization record in the durable agent-authorization registry. Read-only tools (`get_commitment*`, `list_*`, `get_protocol_info`, `ping`, `route_request`, `list_capabilities`, `get_recovery_status`, `get_pending_actions`, `get_authority_validation`) do not require a proof, but still enforce commitment-scoped visibility.

**Commitment Lifecycle & Evidence Operations**

The canonical lifecycle is: `issued -> authority_validated -> accepted -> in_flight -> executing -> evidence_pending -> evidence_submitted -> verifying -> fulfilled -> settled -> finalized`, with recovery (`recovering`) and dispute (`disputed`) branches. **Cancellation** is an authorized terminal branch: a caller holding buyer or provider authority may transition an eligible nonterminal commitment to `cancelled` via `cancel_commitment`. **Closure** (`close_commitment`) finalizes a settled commitment (`settled -> finalized`) and is reserved for system or authority roles. **Evidence submission** (`submit_evidence`) durably records evidence bound to the commitment and its acceptance criteria; `verify_evidence` sets the verification outcome (verified/rejected) and requires evaluator authority; `list_evidence` returns the durable evidence records with integrity references and submitter attribution. Evidence submission is nonfinancial: it never triggers settlement, escrow release, or refunds. A replacement agent may continue a commitment through `resume_commitment` only with its own independently authorized grant -- authority never transfers automatically.

Client configuration varies by MCP client:

```json
{ "mcpServers": { "saax": { "url": "https://www.saax-protocol.com/mcp" } } }
```

The older `create_commitment` tool is distinct from the new signed proposal/acceptance path. Its deterministic `saax_...` reference or a successful tool response does not establish the complete signed Discovery financial profile. Use the exact export verifier for the representation you received, not a generic claim that any commitment is fully verified.

## Existing immediate payments

The existing live mainnet Router uses x402 with Base USDC. The MPP rail is implemented but not registered in production (x402-only mode). The site HTTP route is `https://saax-protocol.com/route`; the settlement host `https://settlement.saax-protocol.com` is a separate existing integration surface. Read its current challenge before authorizing a payment. This website release does not change its payment code, fees, secrets or configuration.

A402 challenge supplies the amount, asset, network and payee. A separate wallet/payment authorization is required; Discovery acceptance does not pay. Confirm the actual successful settlement and its binding to your intended request. A transaction hash is not proof of success, fulfillment or refund rights. See [what a receipt proves](/blog/x402-receipts-what-a-receipt-proves).

The x402 broadcaster may cover gas for its supported immediate-payment path; do not generalize this to custody transactions. Mainnet immediate payments are non-custodial and final, not escrow-backed.

## Testnet financial integration and independent verification

The isolated preview completes: separately signed testnet profile → provider proposal → buyer acceptance → commitment → real custody funding → signed evidence → evaluator-signed release or refund → complete export → independent verifier. It pins Base Sepolia 84532, USDC `0x036cbd53842c5426634e7929541ec2318f3dcf7e`, six decimals and CustodyV1 `0x5a5472d751839cd4968cbf1b136baf862279ff5d`.

Network and CAIP-19 asset chain must agree across authenticated terms and execution. Mainnet terms cannot be interpreted as a testnet label, and no environment override changes the signed asset. Explicit `mode:escrow` differs from immediate-payment `mode:x402`; the preview's x402 compatibility rail label does not mean a facilitator settled the escrow.

Operator-run tooling in the controlled source checkout:

```sh
node scripts/check-custody-identity.cjs
node verifier/verify-financial-export.js \
  evidence/discovery-phase6/closeout-release-export.json \
  --trust=evidence/discovery-phase6/trust.json --json
```

Source access and dependencies are prerequisites; the repository is not represented as permissionlessly public. These are read-only verification commands, not public financial execution endpoints. The verifier uses explicit public trust inputs and public historical RPC reads without SAAX database credentials. It recomputes bindings, verifies actual signatures/evaluator permissions and the exact deployed-contract EIP-712 domain/type/action/nonce/issuedAt at execution time, then checks successful decoded calldata/events, historical state and token outcomes. Current evidence passes78 release checks and79 signed-refund checks. [Walk through the verification boundaries](/blog/signed-discovery-to-testnet-finance).

The actual fulfilled service is a deterministic local SHA-256 self-test. All roles are operator-controlled. The refund evidence is an authenticated test nonfulfillment declaration. Signed seller evidence is independently checked, and a separate evaluator attestation binds it to the custody verdict because deployed V1 does not include an evidence hash in its verdict struct. This does not prove external service quality, external adoption or independent audit.

Funding requires test USDC and test ETH for gas. No public `/fund`, `/release` or `/refund` service is enabled. A local EVM with chain ID84532 is not public Base Sepolia proof. Earlier incomplete exports remain historical records, not silently upgraded evidence.

## Receipts, recovery and custody readiness

`/receipt?txHash=<hash>&rail=x402` is a settlement-reference lookup, not the complete financial verifier. The latest live read returns HTTP 500 with a store-schema mismatch; this documentation release does not modify the database or claim that defect is fixed. Discovery and read-only MCP checks pass separately.

Recovery tests cover replacement-process issuance after durable acceptance and specific financial broadcast/reconciliation boundaries. The new producer journals the signed transaction hash before broadcast and reconciles by that hash; it does not prove every failure boundary or provide an unattended public recovery service. Reconcile unknown outcomes before retrying. [Recovery explanation](/blog/unknown-payment-outcomes-agent-recovery).

CustodyV1 signed refunds and unsigned deadline refunds are different authorizations. Timeout refunds work only while **Funded**, not while **Disputed**. Only buyer or seller can raise a dispute. An unavailable evaluator can leave disputed funds frozen indefinitely; there is no admin, pause, upgrade or evaluator replacement. Newer custody/governance candidates remain under development/security review, not deployed versions. No mainnet escrow readiness or guaranteed refund is claimed.

## Supplier registration

The existing Router consumes ERC-8004 identity/reputation signals and ranks available suppliers. A registry entry is neither authentication of every Discovery publisher nor proof of actual service quality. See the [identity standard explanation](/blog/erc-8004-agent-identity-draft-standard) and inspect current registration/endpoint requirements before relying on discovery.

## Pricing and subscriptions

Discovery preflight has no fee. Mainnet routing/payment fees are disclosed in the applicable challenge before authorization. Existing Premium subscriptions use Stripe: 14-day trial with card collected upfront, Developer $29/month, Business $199/month, Enterprise custom. Subscription email matching is an access key, not identity proof. Features apply as they ship; no SLA, compliance certification or outcome guarantee is implied. The website release does not alter billing logic.

## Risk and support

Read [security](/security), [disputes](/disputes), [privacy](/privacy) and [terms](/terms). SAAX is experimental software with component-specific maturity; production payments involve real funds. SAAX is not affiliated with Coinbase, Base or the ERC-8004 authors. Internal tests and independent verification software are not independent security review.
