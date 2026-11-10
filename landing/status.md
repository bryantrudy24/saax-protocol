# SAAX current status

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

SAAX is a commitment layer for autonomous commerce. The public discovery and commitment-creation interfaces are deployed. A separate operator-run integration has completed real Base Sepolia funding, release and refund with complete independent export verification for its defined test profile. These are different deployment scopes. Neither makes mainnet escrow available.

## Maturity at a glance

| Component | Status | Demonstrated scope |
|---|---|---|
| Protocol specification | **Public specification — versioned** | Protocol v1.0.3; Discovery profile 1.0.0 and acceptance-v1 are separate formats. Publication is not standards-body adoption. |
| Routing and immediate payments | **Public beta** | Existing x402/MPP USDC payments on Base mainnet 8453; direct payments, no mainnet custody. |
| Signed discovery, preflight and buyer acceptance | **Beta** | Public signed profile, free nonbinding preflight, configured-buyer acceptance creating one authenticated commitment. No payment or service execution is triggered. |
| Verification and receipts | **Beta** | Actual JWS crypto for Discovery records; verification is format-specific. General COSE/JWS evidence hooks remain distinct. `GET /receipt?txHash=...` resolves a settled transaction hash to its commitment; verified live on 2026-11-06. |
| Custody / financial integration | **Testnet preview — not approved for mainnet funds** | Separately signed Base Sepolia profile, authenticated agreement/evaluator, actual test-USDC funding and signed release/refund, portable exports and public-chain verification. Financial execution is operator-run, not a public API. |
| Unreleased custody and governance candidates | **Under development / security review** | Custody V3 has an owner-approved snapshot for independent review; that review has not been completed. It is not an audit, not production readiness, and not deployment approval. Local candidate tests do not identify the deployed V1 contract. No completed independent audit or approved mainnet custody release. |

## Publicly deployed today

- `GET /.well-known/saax.json`: signed provider profile with explicit supported combinations. The preserved live profile identifies Base mainnet 8453.
- `POST /prepare-commitment` and MCP `prepare_commitment`: free compatibility checking and a provider-signed proposal. No agreement, funds, reserved capacity, service execution or spending authority.
- `POST /accept-commitment` and MCP `accept_commitment`: verifies an onboarded buyer's signed acceptance and records exactly one authenticated commitment. Durable proposal/acceptance storage supports retries; a new idempotency key does not make a single-use proposal reusable.
- Existing MCP tools and mainnet routing/immediate-payment services. A read-only release check performs MCP initialization, tool discovery, `ping` and protocol-info calls; an HTTP 200 alone is not treated as MCP proof.

The provider signature proves consistency with a key. Clients independently authenticate the provider key before installing it; configured-key trust is not permissionless publisher authentication. Buyer acceptance requires separately onboarded buyer keys. A key copied from an untrusted profile/export does not establish identity. See [quickstart and trust onboarding](/docs#discovery-quickstart).

## Real Base Sepolia evidence

The latest financial closeout uses a separately signed testnet profile, exact `eip155:84532` network and test-USDC CAIP-19 asset, six decimals, explicit escrow mode, and buyer-authorized seller/evaluator/custody/recovery terms. It rejects network or asset substitution; an RPC chain guard cannot rewrite signed terms.

Two minimal records each funded 1000 raw test-USDC units (0.001 test USDC):

- [Successful release](https://sepolia.basescan.org/tx/0xb0766b1e4a28861e0688655fb104e4cd553f1ee2e8a110e6896b0f42f1feeaf6), block 55360516.
- [Successful evaluator-signed refund](https://sepolia.basescan.org/tx/0xe324fff58137c2817835e3bf408b1fdd2b03a44914f7860b86244685335231eb), block 55360737.

The separate-process verifier ran without application database credentials: release78/78 and refund79/79 checks passed. It authenticates the profile/provider/buyer/complete terms/commitment/evaluator, verifies the deployed EIP-712 verdict at the execution block's timestamp, decodes the actual successful transactions/events, and checks historical custody/token outcomes. It also verifies signed fulfillment evidence and an evaluator signature connecting evidence to the verdict. These are internal software checks, not an independent security audit.

The fulfilled service is a deterministic local SHA-256 computation; the refund record is an authenticated test nonfulfillment declaration. Provider, buyer, seller and evaluator are operator-controlled test roles. No external customer, independent evaluator or public financial endpoint is claimed. [Read the implementation walkthrough](/blog/signed-discovery-to-testnet-finance).

## Contract identity and historical corrections

The deployed testnet contract is CustodyV1 at `0x5a5472d751839cd4968cbf1b136baf862279ff5d`, not the unreleased CustodyV3 candidate. Its runtime is 6934 bytes:6881 executable +51 CBOR metadata +2 length bytes. Pinned solc 0.8.26 compilation of the exact Git source matches the committed artifact and actual deployed runtime in full. Earlier metadata-length arithmetic was wrong; no new deployment was required. A code match establishes identity, not safety.

Earlier financial exports are retained as historical evidence. Their proposal terms did identify Sepolia, but they lacked the separately signed profile and complete buyer-authorized evaluator/evidence chain required by the stronger verifier. Their old39-check result is not complete end-to-end assurance. They are not rewritten or promoted by adding declarations.

## Recovery and custody limits

Discovery issuance recovery has been tested with replacement processes after durable acceptance and after issuance, preserving the same commitment. Specific financial crash/broadcast reconciliation scenarios have separate script evidence. These demonstrations do not prove every crash boundary, distributed failure, external-provider recovery or unattended operational service.

CustodyV1 can release under the agreed evaluator signature, refund under an evaluator-signed refund, or permit an unsigned timeout refund after the deadline while still **Funded**. A timeout refund is not an evaluator verdict. **Disputed funds can remain frozen indefinitely if the evaluator disappears.** There is no admin withdrawal, pause, upgrade or evaluator-replacement mechanism. Refunds and safety are not guaranteed.

## What remains before production custody

Mainnet custody deployment and spending are not enabled. Production signer/governance provisioning, exposure limits, operational recovery/canary parameters, legal review, target-chain release validation, independent security review and remediation remain open. Local candidate tests, a local chain configured as84532 and local EAS anchors are not proof of public Base Sepolia execution or public-chain finality. The new financial self-test does not claim an EAS anchor or L1-finality proof.

An external-participant pilot package exists but has not been sent; no external pilot completion or independent adoption is established. The Custody V3 snapshot is owner-approved as the baseline for independent review only; independent review has not been completed, and approval-for-review is not an audit, production readiness, or deployment approval.

## Documents

- [Integration guide](/docs)
- [Versioned specification](/spec)
- [Verification walkthrough](/blog/signed-discovery-to-testnet-finance)
- [Security and risk boundaries](/security)
- [Terms of use](/terms)

SAAX remains experimental software with component-specific maturity labels. Mainnet immediate payments process real funds. Nothing here guarantees recovery, safety, audit status, legal compliance or financial outcomes.
