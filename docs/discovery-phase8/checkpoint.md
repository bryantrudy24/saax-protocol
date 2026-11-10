# SAAX Discovery Phase 8 — Website Currency + Dev.to Pilot Recruitment

**Date:** 2026-11-06
**Repo:** ax-router — working tree dirty (pre-existing, preserved uncommitted); HEAD `d8f83e43` = origin/main (verified).

## 1. Website currency finding

The live SAAX website is **already current** — no edits or redeployment required.

Verified against committed implementation and evidence (fetched live 2026-11-06):

- `/` — maturity labels correct: immediate payments Public beta (Base mainnet 8453), Signed Discovery & acceptance Beta, custody finance Testnet preview (Base Sepolia), unreleased custody Development/security review; "no mainnet custody, no completed audit, no guarantee" disclosures present. Public signed Discovery/preflight/acceptance create commitments "without moving funds" — matches implementation.
- `/status` — Last verified 2026-11-06; contains the separately signed testnet profile (exact eip155:84532 network + test-USDC CAIP-19, 6 decimals, escrow mode), real Base Sepolia release block 55360516 / refund block 55360737 with separate-process verifier release 78/78 and refund 79/79 checks, CustodyV1 identity (6934 bytes: 6881 executable + 51 CBOR metadata + 2 length bytes; pinned solc 0.8.26), historical-corrections section, and explicit "operator-run test roles, no external customer, no public financial endpoint" statements. Matches committed evidence.
- `/docs` — integration guide "Last verified: 2026-11-06"; quickstart = exactly the nonfinancial flow (authenticate provider key out-of-band → free preflight → buyer acceptance → one commitment → independent verification); honestly marks schema digests as provider declarations, configured-key onboarding, no permissionless authentication; discloses the historical COSE placeholder (manifest-v1.1+saax-proposal-bound).
- `/welcome` — verified contact support@saax-protocol.com (used as the pilot response route).
- Sitemap (27 URLs) = 2026-11-06 lastmod, no dead links. `/pilot` does NOT exist on the live site (404 confirmed) — local pilot package `pilot/external-testnet-pilot-phase6.md` is PREPARED, un-sent, awaiting participant authorization; the status page states "An external-participant pilot package exists but has not been sent."

**Conclusion:** The site neither overclaims nor underclaims. No site change was required; none was made; no empty release.

## 2. Dev.to recruitment post — PUBLISHED

- **How found:** checked `https://dev.to/api/articles?username=brudy_dev24` (10 existing articles; the Oct-10 "Building a revenue path… looking for collaborators" is a different, older call — not a pilot-recruitment duplicate). No matching recruitment post existed → original publish, authorized.
- **Publication mechanics:** Dev.to API requires the `api-key` header (`Authorization: Bearer` returns 403). Rate-limit bursts return 429 "Retry later"; duplicate title within 5 minutes returns 422; V0 endpoint silently 400s on title-dedup.
- **Published article:**
  - Title: *Looking for a Developer to Test SAAX's Signed Agent-Commitment Flow*
  - URL: https://dev.to/brudy_dev24/looking-for-a-developer-to-test-saaxs-signed-agent-commitment-flow-17in
  - Author: Bryant rudolph (brudy_dev24) — verified existing account
  - Tags: blockchain, webdev, security (3 ≤ 4)
  - Canonical: self (original Dev.to invitation; no SAAX page to canonicalize to)
  - AI disclosure: `fully_autonomous` (set explicitly; matches platform requirement and prior SAAX cross-post practice)
  - Published: 2026-11-06T21:34:20Z; rendered page verified live (title, author, disclosure, tags, full body, links, response route)
- **Content requirements met:** author-building-SAAX disclosure; concrete problem; already-implemented vs missing-external-feedback; asks for 1/small handful of volunteers; explicitly nonfinancial (no purchase/deposit/escrow/paid participation); key-control boundaries (participant keeps keys; no private keys/seed phrases/credentials; onboarding = verified public key + proof of control); asks for integration effort, confusing steps, verification results, failure cases; links verified SAAX pages (status, docs/integration guide, spec); no time/compensation/guarantee invented; operator-run roles disclosed; response route = comment on post OR support@saax-protocol.com (existing verified contact — not invented). No Coinstancy mention; no partnerships/adoption claims.
- **Cleanup:** diagnostic probe articles created during API debugging (ids 4990672/4990673/4990686/4990688/4990690/4990693/4990695/4990697) were unpublished; final `state=all` listing shows ONLY the 10 legitimate articles (9 prior + 4990700). No public junk remains.

## 3. Next executable actions (blocked on participant)

1. Await a respondent (comment on the post or email support@saax-protocol.com). **Do not onboard anyone automatically:** confirm interest, eligibility, public-key ownership, consent, and onboarding authorization first.
2. Onboard the authorized buyer: add verified public key + scope to `SAAX_BUYER_REGISTRY_JSON` (preserve existing entries; rollback = restore prior JSON), redeploy, verify via `vercel env ls production` (names only).
3. Run the live onboarded flow (profile → preflight → buyer acceptance → one commitment → export → independent verifier); retry-identical → same operation; rejection cases (altered terms, expired acceptance, replay conflict, unregistered buyer 401).
4. Record participant classification (external vs owner-operated) and no-financial-effect evidence; commit/push.

## Constraints held

- **No website deployment** (not needed — site already current).
- No outreach beyond the single authorized Dev.to post (no DMs, emails, comments to others, pitches).
- No payments, escrow, execution, or release initiated.
- LUMIYOU / Victoria's Vision untouched; unrelated dirty working tree preserved uncommitted.
- No secrets in this record; DEVTO_API_KEY referenced by name only.
---

# Phase 8 Addendum (2026-11-06, second release) — Website Update + Two Search-Informed Articles + Dev.to Cross-Posts

**HEAD before:** `43782740` (origin/main verified). **After:** `5af87319` (site content) + `1cf68339` (validator tooling), both pushed.

## 1. Website currency correction (V3 snapshot approval)

The site was **stale on one fact**: the homepage/status/security pages said the Custody V3 review snapshot "has not yet received owner approval / remains proposed." The owner **approved** it on 2026-11-06 (manifest `920ddff8…`, prep commit `ea0562b5`, archive `bfecfd1b…`; recorded in `review/f3c-candidate/OWNER-APPROVAL-RECORD.md`). Corrected wording applied everywhere — "owner-approved snapshot for independent review; review not completed; not an audit, not readiness, not deployment approval":

- `landing/index.html` — status-row + V3 card (2 spots) + receipt-operational line (receipt verified live 200 before editing).
- `landing/status.md` + `status.html` — maturity-table row + closing paragraph (2 spots each).
- `landing/security.html` — V3 candidate paragraph (audit-status section).
- `landing/docs.md` + `docs.html` — maturity matrix row.
- `landing/llms.txt` + `llms-full.txt` — verification line (receipt now "verified live 2026-11-06" instead of "store-schema error") + V3 snapshot wording.

Stale-claim sweep confirmed zero remaining "not yet received owner approval" / "PROPOSED, NOT FROZEN" / "store-schema error" / "currently erroring" in any tracked landing file.

## 2. Two search-informed articles (originals)

Researched (OWASP SCS 2026, vendor landscape) and published on SAAX — full details in `daily-logs/2026-11-06-search-informed-articles-research.md`.

| Article | SAAX URL | Dev.to URL |
|---|---|---|
| What an AI Agent Payment Authorization Actually Authorizes | https://saax-protocol.com/blog/what-agent-payment-authorization-actually-authorizes | https://dev.to/brudy_dev24/what-an-ai-agent-payment-authorization-actually-authorizes-585a (id 4991123, tags ai/agents/web3/security, Fully Autonomous) |
| What a Smart Contract Escrow Security Review Actually Verifies | https://saax-protocol.com/blog/what-escrow-security-review-actually-verifies | https://dev.to/brudy_dev24/what-a-smart-contract-escrow-security-review-actually-verifies-5can (id 4991125, tags security/web3/ethereum/blockchain, Fully Autonomous) |

Each: unique title/meta description, self-referencing canonical + Article JSON-LD, blog-index links, sitemap entries, llms.txt + llms-full.txt entries, internal links to existing SAAX pages, AI disclosure, explicit "approval-for-review is not an audit" framing.

## 3. Deployment

- Commit `5af87319` pushed → **Vercel auto-deploy from GitHub** → production `ax-router-nn8rdyb7u` (id `dpl_2jyyZQWe4FWrTyS9GLSBGXnApyGk`), aliased `saax-protocol.com` + `www`. Preview `ax-router-6yjba71o8` verified first (both articles, status, blog index via `vercel curl`).
- **Rollback target:** previous production `ax-router-21wshzfse` (via `vercel rollback`).
- Live verified post-deploy: both article URLs 200 with correct metadata; `/status` corrected wording; `/blog` lists both; `/.well-known/saax.json` intact (mainnet 8453); MCP initialize + tools/list = 13 tools incl. `prepare_commitment`/`accept_commitment` (release-check script `scripts/_mcp-release-check.cjs`); `/receipt` 200 (verified before editing the homepage claim).
- `scripts/validate-saax-site.py` protected base updated `71183c7b → 5af87319` + new-article sitemap requirements (commit `1cf68339`). Validation clean except the pre-existing dirty `data/escrow-access-ledger.json` (runtime ledger, preserved uncommitted).

## 4. Dev.to cross-posts

- Account `brudy_dev24` verified via `GET /api/articles/me`; no duplicates of either topic.
- Both posts `published:true`, canonical URL = exact SAAX original URL, `ai_disclosure_level: fully_autonomous` (correct field per dev.to/llms.txt; the API requires this field — `ai_disclosure` is ignored), 4 tags each, "Originally published on SAAX Protocol" attribution, absolute working links. Live pages fetched and verified (title, author, badge, tags, body).

## 5. Next executable actions

- Await external pilot respondent (Phase-8 base). No onboarding without explicit authorization.
- Ignore the pre-existing `data/escrow-access-ledger.json` dirty flag if validator reports it (unrelated runtime ledger).
- Future releases: `python scripts/validate-saax-site.py` now gates on both new article slugs in sitemap.

## Constraints held

- No LUMIYOU / Victoria's Vision changes (commit diff = 21 SAAX-only files; pre-existing dirty tree preserved uncommitted; no secrets staged).
- No financial behavior, contracts, env vars, custody config, or DNS changes.
- No Coinstancy mention; no partnerships/adoption/audit claims.
- Approved review snapshot bytes untouched; unrelated dirty files preserved.