# SAAX Disputes

*Last updated: 2026-10-06*

SAAX standardizes recovery and dispute *states* within the commitment lifecycle. It does not guarantee reimbursement, reversal, or resolution of disputes. This page explains when to open a dispute or complaint, how to file one, what happens next, and what SAAX can and cannot do.

## When to use this channel

A dispute or complaint is appropriate when:

- A commitment you participated in did not behave as its terms stated (for example, settlement moved the wrong amount, or a state transition contradicted the recorded terms).
- You believe a settled commitment was charged incorrectly or duplicated.
- You believe the routing service misbehaved — a failure to respond, an incorrect error, or an availability problem that caused you loss.
- You believe someone is misusing the SAAX name or the protocol to defraud users.
- You have a privacy or data-handling concern (those can also go to the privacy contact).

This channel is **not** for:

- Disagreements with a counterparty about the quality of goods or services that fell outside the commitment's acceptance criteria. SAAX does not arbitrate commerce; it records terms and outcomes.
- Market losses, volatility, or losses from your own key management.
- Anything already resolved on-chain that you simply want reversed — on-chain records are immutable and cannot be undone.

## How to file

Email the dispute team at:

**For dispute inquiries, email reachsaaxprotocol@gmail.com.**

Please include:

- **Commitment ID** — the commitment identifier from the request or the 402 challenge (if you have one).
- **Description of the issue** — what happened, when, and what you expected instead.
- **Evidence** — transaction hashes, request/response payloads, timestamps, screenshots, or any other material that supports your account.
- **Your wallet address(es)** — so we can correlate records (remember: on-chain records are public).
- **Contact details** — where you want a reply.

The more evidence you include, the faster we can investigate. Requests with no commitment ID or evidence may be returned for more information.

## Expected response time

**Best-effort, non-guaranteed.** SAAX components vary in maturity — immediate payments are public beta on Base mainnet, escrow custody is testnet-only preview (not approved for mainnet funds), and custody/governance candidates are under development / security review. This service is maintained by a small team. We aim to:

- **Acknowledge** receipt within five business days.
- **Provide an initial response** (status or next step) within ten business days.

These are targets, not commitments. Complex investigations — especially those requiring on-chain analysis or correlation across providers — can take longer. We will not claim a response-time SLA.

## Resolution process

After a dispute is filed:

1. **Acknowledgment** — you receive confirmation of receipt and a reference.
2. **Triage** — we classify the issue (commitment misbehavior, service failure, process error, or misuse) and assign it.
3. **Investigation** — we review the commitment record, the relevant transactions, and any evidence you provided, consulting public on-chain data and provider records where needed.
4. **Findings** — we tell you what the records show: what happened, whether the protocol behaved per its terms, and whether an operator error occurred.
5. **Outcome** — where the operator is at fault (for example, a service misconfiguration that caused loss), we will state what we can do: a correction of private records, an explanation, or — only where feasible and within the protocol's capabilities — a good-faith accommodation. Where the protocol behaved per its terms, the finding is that the commitment stands as recorded.
6. **Closure** — the dispute is closed with a written summary. Closing a dispute does not alter immutables: on-chain transactions are not reversed by a dispute outcome.

## Escalation

If the initial response does not resolve the issue:

- **Reply to the same thread** asking for escalation, and we will route it to a senior operator.
- **Re-file with additional evidence** if you believe something was missed.
- If the issue involves an external party — the token contract (USDC), the Base network, or a hosting provider — we will tell you how to escalate to them, since those are outside SAAX's control.

There is no formal appeals body beyond the operators. Independent arbitration is possible only if the parties agree to it in the commitment's terms; SAAX does not provide arbitration.

## How disputes actually resolve (escrow flow)

In the integrated escrow flow (Base Sepolia testnet), a dispute is a real on-chain state: only the funded buyer or seller can call the custody contract to raise a dispute, which freezes the funds. From that point the funds can move **only** by an evaluator-signed verdict under the deployed contract's rules — `release` or `refund` (recorded as `resolve:release` / `resolve:refund`). There is no operator override, no admin withdrawal, and no automatic timer that resolves a dispute.

This means disputes are **evaluator-dependent**: the evaluator address bound in the agreement is the only entity that can resolve a disputed escrow. If the evaluator does not act — or disappears — the disputed funds remain locked indefinitely. Only buyer or seller can initiate it; only the evaluator's signed verdict can resolve it. The timeout-refund path does not run while an escrow is disputed.

This limitation is a design property of the testnet custody contract, and it applies to the testnet research flow only. Mainnet immediate payments have no dispute state at all: settlement is final.

## Support vs. on-chain disputes

Contacting support (reachsaaxprotocol@gmail.com) is a **complaint channel**, not an on-chain action. It will not freeze funds, move funds, or start an on-chain dispute. On-chain dispute initiation is performed against the custody contract by a participant, and resolution requires the evaluator's signed verdict as described above. A support complaint and an on-chain dispute are separate processes; neither guarantees a refund or a favorable outcome.
## What SAAX can and cannot do

SAAX standardizes recovery and dispute states within the commitment lifecycle. It does not guarantee reimbursement, reversal, or resolution of disputes. Enforcement depends on the parties involved and any arbitration mechanisms they agree to.

Specifically:

- **We can:** investigate, explain what the records show, correct private working-memory records, and (where operator error caused loss) make a good-faith accommodation within the protocol's capabilities.
- **We cannot:** reverse on-chain transactions, edit immutable records, force a counterparty to pay, guarantee a favorable outcome, or make you whole for market or counterparty losses.

## Contact

- **Disputes:** [reachsaaxprotocol@gmail.com](mailto:reachsaaxprotocol@gmail.com)
- **Privacy:** [reachsaaxprotocol@gmail.com](mailto:reachsaaxprotocol@gmail.com)
- **Security:** [reachsaaxprotocol@gmail.com](mailto:reachsaaxprotocol@gmail.com)

*— SAAX Protocol*