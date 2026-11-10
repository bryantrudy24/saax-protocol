# SAAX Security

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

SAAX is experimental software. This document describes the security posture of the SAAX Protocol and the SAAX Router, the classes of threats they are designed to defend against, and how to report a vulnerability. It distinguishes **what is deployed and enforced on the live mainnet Router**, **what is implemented and tested in the integrated testnet escrow flow**, and **what remains unverified or out of scope**.

## Scope

SAAX protects for four properties:

- **Commitment integrity** — a commitment record, once issued, cannot be silently altered; its terms, parties, evidence, and references are attributable and auditable.
- **Settlement correctness** — value moves only when the settlement requirement of a valid commitment is satisfied, and moves exactly as the commitment specifies.
- **Reputation integrity** — reputation signals derive from verifiable on-chain behavior and signatures, not self-declared claims.
- **Availability of the routing layer** — the routing service remains responsive to legitimate requests under load and resets cleanly after overload or operator action.

## Threat model

SAAX defends against the following attack classes. They are described generically; the precise controls are shared with operators and reviewers under coordinated disclosure.

- **Duplicate charges** — an attacker replays a payment authorization to extract value more than once. Mitigated by idempotency keys bound to each commitment (enforced on the live Router and in the escrow flow).
- **Gas abuse and denial of service** — an attacker floods the routing layer to exhaust computational or network resources. Mitigated by per-origin rate limiting.
- **Nonce replay** — an attacker replays a signed transfer authorization whose nonce was already consumed. Mitigated by nonce-bound idempotency: each authorization is tied to a unique nonce and settles at most once.
- **Spoofed buyer reputation** — an attacker fabricates a reputation signal for an address they do not control. Mitigated by deriving reputation from signatures and on-chain records rather than claimed identity.
- **Signature forgery** — an attacker forges an authorization or attestation. Mitigated by typed, domain-separated signature schemes (EIP-712) and contract scanning aware of proxy-upgrade patterns.
- **Prompt injection via untrusted input** — an attacker embeds instructions in free-text fields that a downstream system might execute. Mitigated by a sanitization gate that strips control content from untrusted input before it is processed. This is a defense-in-depth control; it does not eliminate the risk of prompt injection in any downstream model or agent.
- **Supply-side fraud** — a provider advertises capabilities it cannot deliver. Mitigated by a capability floor and reputation weighting that ranks providers on verified performance rather than self-declaration.
- **Credential leakage** — an operator's secret material is exposed to the network. Mitigated by a non-custodial design: the protocol never requires buyer funds to be held by the routing layer. Secret material is handled under a non-leakage architecture. On mainnet, the Router is non-custodial (payments are direct x402 authorizations from the buyer's wallet). In the testnet escrow flow, funds are held by the custody contract, not by the Router's operator.

## Mitigations in place — by deployment

The following table states where each control is enforced.

| Control | What it does | Where |
|---|---|---|
| Idempotency | Duplicate requests carrying the same idempotency key return the cached response and do not re-process value movement. | Live Router (mainnet immediate payments) |
| Rate limiting | Requests in excess of the per-origin window are rejected with HTTP 429. | Live Router |
| Nonce-bound settlement | Payment authorizations are bound to unique nonces; a spent nonce cannot be replayed. | Live Router; testnet escrow (per-verdict nonce consumed at acceptance) |
| Signature-derived reputation | Reputation resolves from signatures and on-chain feedback, not claimed identity or client-supplied headers. | Live Router (reads ERC-8004 identity registry) |
| Typed verification | Authorizations use typed, domain-separated signing (EIP-712); contract interactions are scanned with proxy-upgrade awareness. | Live Router; testnet escrow (EIP-712 verdicts/access auth) |
| Input sanitization | Untrusted fields are sanitized at the boundary; empty or malformed payloads are rejected with HTTP 422. | Live Router |
| Trusted-proxy handling | When deployed behind a reverse proxy, client addressing is read from the proxy-provided header so rate limits cannot be bypassed by proxy rotation. | Live Router (deployment-specific) |
| Kill switch | An operator-controlled halt returns HTTP 503 before any value movement or external call. | Live Router |
| Escrow chain guard | Every transaction-capable path refuses a chain other than Base Sepolia (84532) for escrow flows; mainnet escrow custody is never enabled. | Testnet escrow instance only |
| Durable acceptance ledger | Accepted operations, nonce consumption, and reconcile outcomes are persisted durably (JSON ledger with atomic rename) so a replacement worker can reconcile without re-executing. | Testnet escrow instance (durable file); Postgres profile in the reference deployment |
| EAS anchoring | Agreements are anchored via EAS attestation on-chain for independent verification. | Testnet escrow flow (live EAS on Base Sepolia) |

## Discovery and financial verification boundaries

Public signed Discovery, free preflight and configured-buyer acceptance are deployed **beta** interfaces. They verify real Ed25519 JWS signatures for their defined records and persist a single authenticated commitment, but do not fund, pay, execute a service or release custody. Provider identity requires an independently installed configured key; a self-declared key is not permissionless authentication. Buyer public keys are separately onboarded and scoped.

The isolated financial preview requires a separately signed Base Sepolia profile and exact network/CAIP-19 asset agreement through proposal, buyer acceptance, commitment and execution. A mainnet-bound proposal cannot become testnet authorization because an environment variable or RPC endpoint changed. The production mainnet profile and immediate-payment behavior remain separate and unchanged.

The exact deployed CustodyV1 runtime, committed artifact and pinned-source compilation match in full:6934 runtime bytes =6881 executable +51 CBOR metadata +2 length bytes, compiled with solc 0.8.26, optimizer 200, viaIR, Cancun. The earlier guessed metadata trim was incorrect. Identity is not proof of safety or independent review.

The expanded separate-process financial verifier authenticates configured provider and buyer keys, complete terms/digests/versions and evaluator permissions, then checks the actual deployed EIP-712 domain/type/action/nonce/issuedAt at execution-block time, successful decoded transaction calldata/events, historical escrow state, token transfers and balances. Signed seller evidence is checked against its policy; a separate evaluator signature connects its digest to the custody verdict. V1 does not directly include an evidence hash in its verdict struct.

This result applies to a deterministic local SHA256 self-test with real Base Sepolia custody, not independently observed external service quality. All test roles are operator-controlled. Historical exports lacking the signed profile/evaluator/evidence chain remain explicitly incomplete; valid old transactions are preserved. General COSE/JWS authority/evidence hooks elsewhere retain their format-specific structural/attesting-verifier limitations. No blanket cryptographic-verification or audit claim follows.

## Residual risks

SAAX does not fully eliminate the following risks, and users should assume they exist:

- **Smart contract risk** — the settlement contracts and the tokens they move may contain undiscovered defects; on-chain behavior is final.
- **Key compromise at the user layer** — if a participant's own keys are compromised, no protocol control can prevent loss.
- **Censorship and liveness** — routing availability depends on the operators of the routing node and on the Base network; neither SAAX nor any user can force either to remain available.
- **RPC dependence** — settlement correctness depends on the RPC providers serving on-chain data; a malicious or degraded provider can delay or distort observed state.
- **Reputation gaming** — colluding parties can manipulate on-path reputation over time; reputation weighting reduces but does not eliminate this.
- **Social engineering** — operators and integrators can be induced to misconfigure deployments; no technical control fully prevents operator error.
- **Evaluator dependence (escrow)** — in the escrow flow, disputed funds can be released or refunded only by the evaluator whose address is bound in the agreement. If that evaluator disappears, the disputed escrow cannot be resolved by anyone else. This is a design property of the testnet custody contract, not a bug.
- **Recovery boundaries** — replacement-process Discovery issuance and specific financial broadcast/reconciliation scenarios have test evidence. The new isolated producer persists its signed transaction hash before broadcast; this does not prove every older driver, failure boundary, external provider or unattended deployment recovers. Recovery remains explicit and operator-assisted, not a universal guarantee.
- **Prompt injection** — input sanitization reduces but cannot eliminate prompt-injection risk in downstream models, agents, or tools.

## Audit status

SAAX has **no independent security audit** of the protocol implementation, the Router, or the testnet custody contract as of this update. Passing conformance vectors and internal test suites are not an audit and do not constitute a security certification. The custody contract is testnet-only research code; it has not been reviewed by an independent custodian or auditor, and it is not production custody.

**Custody V3 candidate:** a newer custody candidate (`SAAXEscrowCustodyV3.sol`) has been tested only on a local EVM (chain 31337) with synthetic keys. An independent-review snapshot package has been prepared but has **not received owner approval**, and **no independent security review has been completed** — the project owner is seeking a suitable review firm, and no engagement or endorsement is implied. Local test counts and local anchors are not independent security assurance or public-chain finality. See [current status](/status).

## Non-custodial claim, scoped

On mainnet, the Router is non-custodial: immediate x402 payments move directly from the buyer's wallet to the payee; the Router never holds buyer funds. In the testnet escrow flow, funds are held by the `SAAXEscrowCustodyV1` contract — that is custody by a smart contract, not by the operator — and it is testnet-only. "Non-custodial" does not mean "no funds are ever held anywhere": it means the routing operator does not hold them. The Custody V3 candidate is local only and is not part of any hosted flow.

## Out of scope

SAAX is not designed to protect against:

- Compromise of a user's own private keys or wallet software.
- Malicious behavior of counterparties outside the commitment's terms (e.g., off-protocol fraud, delivery of defective goods despite passing acceptance criteria).
- Financial loss from market movement, token volatility, or failed external systems.
- Legal or regulatory consequences of using the protocol in a given jurisdiction.
- Attacks on the underlying networks (Base), the USDC contract, or the RPC infrastructure SAAX depends on.
- Losses arising from user error, including sending funds to the wrong address or misreading commitment terms.

## Reporting a vulnerability

If you believe you have found a security issue in SAAX, please report it by email:

**To report a security concern, email reachsaaxprotocol@gmail.com.**

Please include:

- A description of the vulnerability and its impact.
- The component affected (protocol, routing service, contracts, or docs).
- Steps to reproduce, including any payloads or request sequences.
- Your contact details if you would like a reply.

What we commit to:

- **Acknowledgment** within five business days of receipt.
- **Triage and a first response** within ten business days.
- **Coordinated disclosure** — we will work with you on a disclosure timeline (typically up to 90 days) before public discussion, unless the issue is already public or being actively exploited.

Do not test against production accounts, live funds, or the mainnet settlement contracts beyond what is necessary to demonstrate an issue. Use small amounts. Reports are handled on a best-effort, non-guaranteed timeline; this is experimental software maintained by a small team.

— SAAX Protocol
