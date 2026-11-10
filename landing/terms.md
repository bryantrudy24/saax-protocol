# SAAX Protocol — Terms of Use

*Last updated: 2026-10-17*

By accessing or using the SAAX Protocol, you acknowledge and accept the risks described below. **If you do not accept these risks, do not use SAAX.**

## 1. Experimental Software Disclaimer

SAAX Protocol is experimental software. It is under active development and its behavior, interfaces, and availability may change without notice. You should assume that any component may fail at any time.

## 2. No Warranty of Correctness

SAAX Protocol is provided without warranty of correctness, fitness for a particular purpose, or merchantability. Routing decisions, reputation signals, and settlement outcomes are provided on an as-is basis. You should not rely on SAAX for any determination you cannot afford to verify yourself.

## 3. No Warranty of Availability

SAAX Protocol is provided without warranty of availability. The service may be offline, degraded, or permanently discontinued at any time. Do not build systems that depend on continuous availability of SAAX.

## 4. Financial Risk — Real Funds on Base Mainnet

SAAX processes real funds on the Base mainnet. Transactions are irreversible once confirmed on-chain. If you send funds, lose access, or are impacted by a failed or malicious transaction, those funds may be permanently unrecoverable. **Only use SAAX with funds you are prepared to lose.**

## 4a. Immediate Payments vs. Escrow Refunds

SAAX currently runs two distinct flows with different money mechanics.

**Immediate payments (Base mainnet).** The Router settles x402/MPP payments directly on Base mainnet. Settlement is irreversible once confirmed on-chain; there is no chargeback, no reversal, and no refund mechanism in the protocol. If you send funds, you lose access, or a transaction fails or is malicious, those funds may be permanently unrecoverable. **Only use SAAX with funds you are prepared to lose.**

**Escrow flow (Base Sepolia testnet only).** The integrated escrow flow holds test USDC in a custody contract and releases or refunds it under an evaluator-signed verdict or a timeout refund. A refund, when it occurs, is a **separate on-chain transfer** from the custody contract back to the buyer's address — it is not a reversal or rewriting of blockchain history. The original funding and release transactions remain on-chain permanently. Refunds are conditional: they require the evaluator to sign a refund verdict (or, before the deadline, the timeout path) and are not guaranteed. Disputed funds can be released or refunded only by the agreement-bound evaluator; if the evaluator disappears, the funds stay locked.

**Support complaints are separate from on-chain disputes.** Contacting support or filing a complaint does not initiate an on-chain dispute and does not freeze or move funds. On-chain dispute initiation (where available) and evaluator resolution are the mechanisms that can actually change escrowed funds, and neither is guaranteed to produce a refund.

SAAX does not guarantee reimbursement of any loss, in either flow, regardless of cause.
## 5. Smart Contract and Protocol Risk

SAAX relies on smart contracts, token standards, and blockchain infrastructure. These systems may contain bugs, be exploited, or behave unexpectedly. Vulnerability in any dependency can lead to loss of funds. You accept these risks by using SAAX.

## 6. No Recovery Guarantee

SAAX does not guarantee the recovery of lost, misdirected, or stolen funds. There is no insurance, no refund mechanism, and no obligation to reimburse any loss, regardless of cause.

## 7. Your Keys, Your Responsibility

You are solely responsible for the custody and security of any private keys, wallets, or credentials you use with SAAX. SAAX cannot recover lost keys, reverse unauthorized transfers, or restore access to wallets under your control.

## 8. No Legal or Financial Advice

Nothing in SAAX Protocol, its documentation, or its behavior constitutes legal, financial, investment, or tax advice. You are responsible for understanding the legal and regulatory implications of using experimental payment software in your jurisdiction.

## 9. No Endorsement of Suppliers

Suppliers discovered or routed through SAAX are not endorsed, vetted, or guaranteed by SAAX. Reputation signals reflect reported outcomes and can be gamed, stale, or incomplete. Verify any counterparty independently before transacting.

## 10. Experimental Stage — Interfaces May Change

SAAX is in an experimental stage. Endpoints, message formats, pricing, and capabilities may change or be removed at any time. Code and documentation may not match current behavior. Do not depend on SAAX interfaces being stable.

---

*By using SAAX Protocol, you accept all of the above. If you do not accept these risks, do not use SAAX.*