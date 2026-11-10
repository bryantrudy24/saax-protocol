# SAAX Agentic-Commerce Search-Visibility Campaign — Research Record

**Date:** 2026-11-08
**Status:** COMPLETE (evidence-backed; search demand NOT measured)

## 1. Research method

Primary-source verification of six agentic-commerce and agent-interoperability protocols, conducted by the STAGING RESEARCHER on 2026-11-08. The full fact sheet is at `agentic-commerce-protocols-primary-source-factsheet-2026-11-08.md` (researcher workspace). Source rule: primary protocol specifications, project repositories, and official protocol sites only. No secondary reporting used.

## 2. Protocol factsheet summary (verified 2026-11-08)

| Protocol | Maintainer | Official scope | Status per official sources |
|---|---|---|---|
| ACP / ACS | OpenAI, Stripe, Meta (lead maintainers per MAINTAINERS.md) | Checkout sessions; merchant is the system of record | Repo: "currently in beta"; ACS RFC draft 2026-01-16 |
| AP2 | Google | Agent payments authorization: signed mandates (intent, cart, payment) and payment evidence | Public launch; official mandate specs |
| UCP | Google | Commerce capabilities and lifecycle: discovery, catalog, cart, checkout, orders, post-purchase | Public launch with commerce partners |
| x402 | x402 Foundation (Coinbase repo is a development fork) | HTTP resource payments: signed payment payloads, verification, settlement | V1 and V2 specs; V2 current main |
| MCP | Model Context Protocol (Linux Foundation project) | LLM-to-tool/context connectivity: resources, prompts, tools, lifecycle, authorization | Spec revision 2025-11-25; tasks experimental |
| A2A | Agent2Agent Protocol (Linux Foundation) | Inter-agent discovery, messaging, delegated tasks, async status, artifacts, cancellation | v1.0 materials on official site |

## 3. Key verified claims used in the articles

- **ACP/ACS**: "The merchant remains the system of record for all orders, payments, taxes, and compliance." Out of scope: "PSP authorization/capture semantics, returns/exchanges workflows, tax configuration, fraud modeling details." Source: ACS RFC.
- **AP2**: signed mandates (intent/cart/payment) capture user authorization; scope is authorization and payment evidence; official materials do not establish a complete dispute-adjudication or post-failure recovery protocol.
- **x402**: V2 moved payment data to headers and added before/after settlement verification hooks; the repo notes Coinbase's repo is a development fork.
- **MCP**: not a payment or commerce record protocol; "tasks" experimental in the 2025-11-25 revision.
- **A2A**: task state/history and artifacts; not a commercial commitment, payment, dispute, or financial recovery protocol.
- **None of the six, per its own official scope, defines a cross-party persistent commitment contract with verification and recovery semantics as its core artifact.** (This is the precise, bounded claim — not "none of them have order management." UCP covers order lifecycle; AP2 provides signed evidence supporting dispute review.)

## 4. Search-demand evidence

**No authenticated search-demand data was available.** Google Search Console access is not connected (no GSC connector in the station; verified via connectors.list). Google Trends was not used because no authenticated data source was available and the brief prohibits fabricating traffic estimates.

**Demand is INFERRED, not measured**, from:
- The existence of six actively-maintained protocols in the space (ACP, AP2, UCP, x402, MCP, A2A) indicates sustained technical activity and developer search interest.
- Existing SAAX articles on related topics (x402 receipts, unknown payment outcomes, ERC-8004) have attracted developer engagement on Dev.to.
- No keyword-volume, impression, or ranking data is claimed anywhere.

**Do not treat HTTP 200, sitemap inclusion, or Dev.to publication as proof of Google indexing or measured demand.** Indexing status: NOT VERIFIED. Search demand: INFERRED, NOT MEASURED.

## 5. Topic selection rationale (per search intent)

| # | Article | Target query intent | Evidence of interest | Question existing results leave unanswered |
|---|---|---|---|---|
| 1 | Agentic Commerce Protocols in November 2026 (verified map) | "agentic commerce protocols comparison", "ACP AP2 UCP x402 differences" | Six active protocols; frequent ecosystem explainers | A primary-source, date-verified map distinguishing what each officially covers vs excludes |
| 2 | What Happens After an AI Agent Pays? | "x402 payment", "AI agent payment settlement evidence", "stablecoin agent payments" | x402 is actively maintained; settlement-evidence boundary is a recurring theme | The durable-record/reconciliation layer after settlement |
| 3 | Google AP2 and SAAX | "AP2 agent payments protocol", "agent payment authorization" | AP2 launch with major partners; authorization-vs-commitment gap is a live question | Where authorization evidence stops and durable commitments begin |
| 4 | Building Reliable Agentic Commerce with MCP, A2A, UCP, and SAAX | "MCP A2A agent commerce", "agentic commerce architecture" | MCP/A2A are the connectivity standards; reference architectures are sought | How a durable commitment layer fits the full stack |

SAAX's differentiated contribution: vendor-neutral durable commitment lifecycle (Trust, Durability, Recovery) that complements these protocols without replacing them — with verified implementation evidence (x402 live on Base mainnet; escrow testnet-only; financial limits deployed-disabled).

## 6. Sources (primary)

Full URL list is in the researcher fact sheet. Key primary sources:
- ACP repo / ACS RFC: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
- x402 docs: https://docs.x402.org/introduction ; V2: https://x402.org/x402-v2-launch/
- MCP spec: https://modelcontextprotocol.io
- A2A: https://a2a-protocol.org
- AP2/UCP: official Google protocol documentation (linked in the articles)

## 7. Limits

- Search volumes, impressions, rankings, and indexing are NOT measured or claimed.
- Protocol status labels marked UNVERIFIED where official sources do not state them.
- This research record does not constitute an independent audit, endorsement, or partnership claim.
