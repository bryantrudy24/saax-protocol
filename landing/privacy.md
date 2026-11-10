# SAAX Privacy Policy

*Last updated: 2026-10-17*

This policy describes what SAAX collects, what is public, what is private, how long data is retained, and what you can and cannot delete. It describes actual current practice. Where a capability does not exist (for example, guaranteed deletion), this policy says so plainly.

## What we collect

When you interact with the SAAX Protocol or the SAAX Router, the following data may be collected or processed:

| Data | Why | Where it lives |
|---|---|---|
| Commitment records | The terms, parties, and lifecycle state of commitments you create or participate in | Router working memory; durable ledger (file-based escrow-access ledger); on-chain records where settlement or anchoring occurs |
| Wallet addresses | Identifying the parties to a commitment and their settlement references | On-chain and Router working memory / durable ledger |
| Email addresses | Subscription access key for SAAX Premium; receipt payer field where recorded | Stripe + Router subscription store (Supabase) |
| IP addresses | Rate limiting and abuse prevention | Router working memory (transient) |
| Timestamps | Lifecycle ordering, evidence freshness, audit | Router working memory and on-chain |
| Evidence references | References (not necessarily contents) to external proof material | Router working memory and on-chain where recorded |

SAAX does not use cookies, does not run analytics or tracking scripts, and does not sell or share personal data for advertising. The landing page and documentation site set no tracking cookies.

## What is public

Anything written on-chain is **permanent and public**:

- Commitments that are settled or anchored on-chain.
- Settlement transactions and their amounts, parties, and timestamps.
- On-chain reputation feedback.
- EAS attestations anchoring agreements (on Base Sepolia for the testnet escrow flow; on-chain where anchored for mainnet).

On-chain records are visible to anyone and cannot be removed by SAAX or by you. **Do not put private information in a commitment, an evidence payload, or a settlement reference** if you do not want it public forever.

On-chain records and anchored attestations are **hashes and references** — the digest of the agreement, not necessarily the complete agreement contents. For the escrow flow, the v3 agreement digest is anchored via EAS; the full agreement terms may live only with the parties unless they are included in the payload. In general, a public hash or reference does not by itself reveal the full underlying content.

## What is private

The following are private to the operators of the SAAX Router and are not published:

- Router database records and working memory (including in-memory commitment state).
- Rate-limit counters and the IP addresses they are derived from.
- Session data.
- Unsolicited or draft commitment state that has not been written on-chain.
- Evidence payloads that are referenced but never published on-chain (only their hashes or references may be recorded).

Access to these private records is limited to the operators of the routing service.

## Retention

| Data | Retention |
|---|---|
| In-memory commitment state | For the life of the process; lost on restart (memory-only profile) |
| Rate-limit counters | Transient; reset on process restart or at window boundary |
| IP addresses | Transient; held only for the rate-limit window |
| File-based durable ledger (escrow access) | Kept until the operator deletes it; no automatic expiry; used for acceptance, nonce, and reconcile records |
| On-chain commitments, settlements, reputation feedback, attestations | **Permanent** — immutable on the blockchain |
| Logs | Held by the hosting providers per their standard practices (see below); SAAX does not run its own log retention service |

There is **no deletion SLA**, and none is claimed. If you want a record removed from private working memory, ask (contact below); removal is best-effort and only possible for records that have not been written on-chain. On-chain records cannot be deleted.

## Third-party processors

The SAAX service runs on third-party infrastructure. These providers process the data described above on SAAX's behalf:

- **Vercel** — hosts the public website, the MCP endpoint, the HTTP `/route` endpoint, the `/receipt` endpoint, and the Stripe checkout handler. Their privacy policy governs their handling of request logs and hosting data.
- **Railway (or the configured hosting provider)** — hosts the routing/settlement service and its environment configuration. Their privacy policy governs their handling of service logs and configuration.
- **Base RPC providers** (e.g., `https://mainnet.base.org`, `https://sepolia.base.org`) — relay the on-chain reads and writes SAAX makes. Transactions you submit through SAAX are broadcast via these providers and are public on the Base network.
- **Namecheap (or the domain registrar)** — domain registration for saax-protocol.com; holds registrar records per their policy.
- **Stripe** — processes SAAX Premium subscription payments, checkout sessions, and webhooks. When you subscribe, your payment details are handled by Stripe under their privacy policy; SAAX receives the subscription status and the email address on the checkout.

SAAX selects providers for infrastructure purposes and does not control their internal data practices. Review their policies directly for details.

## User rights

You can request access to, correction of, or deletion of private records SAAX holds about you:

- **Email:** reachsaaxprotocol@gmail.com
- We will respond on a best-effort basis and will confirm what private records exist for an address you control.
- **Correction** is possible for private working memory only; on-chain records cannot be corrected.
- **Deletion** is best-effort and applies only to private working memory; we will state plainly what we could and could not delete.

We will not charge a fee for a reasonable request. We may ask you to prove control of the wallet address in question before acting.

## What cannot be deleted

- On-chain records are immutable. Commitments, settlements, and reputation feedback written to Base mainnet or Base Sepolia cannot be deleted, edited, or made private by anyone, including SAAX.
- Evidence that was hashed or referenced on-chain can be discontinued (you can stop maintaining the material it points to), but the reference itself remains.

## Contact

For privacy requests, email reachsaaxprotocol@gmail.com.

— SAAX Protocol
