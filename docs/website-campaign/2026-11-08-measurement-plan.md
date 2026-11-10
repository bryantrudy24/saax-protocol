# SAAX Search-Visibility Measurement Plan (30/60/90 days)

**Date:** 2026-11-08
**Status:** BASELINE ESTABLISHED — measurement requires Google Search Console + analytics access, which is NOT currently connected. No fabricated metrics.

## 1. Current measurement status (verified)

- **Google Search Console: NOT connected.** No GSC connector on the station; DNS TXT verification not performed. Exact setup steps in section 5.
- **Google indexing: NOT VERIFIED.** No URL Inspection evidence. Sitemap submission is technically possible once GSC is connected; submission does not guarantee indexing.
- **Search demand: INFERRED, NOT MEASURED.** No keyword-volume/impression data claimed.
- **Dev.to analytics:** available via the Dev.to dashboard (reads, reactions, comments) — can be recorded without GSC.

## 2. Keyword-to-page map

| Page | Primary search intent | Target queries (inferred) |
|---|---|---|
| `/blog/agentic-commerce-protocols-verified-map-2026` | Protocol comparison, current state | agentic commerce protocols comparison; ACP AP2 UCP x402 differences; ACP vs AP2 |
| `/blog/after-ai-agent-pays-x402-stablecoins-saax` | Post-payment recovery, settlement evidence | x402 payment; AI agent payment settlement; stablecoin agent payments; payment receipt vs fulfillment |
| `/blog/google-ap2-authorization-vs-durable-commitments` | AP2 authorization | Google AP2; agent payment authorization; AP2 mandates |
| `/blog/building-reliable-agentic-commerce-mcp-a2a-ucp-saax` | Architecture, reliability | MCP A2A agent commerce; reliable agentic commerce; agent commerce architecture |
| `/status` | Trust, current state | SAAX status; agent commerce protocol beta |
| `/protocol`, `/spec`, `/docs` | Technical depth | SAAX commitment protocol; agent commerce commitment lifecycle |

## 3. 30-day plan (days 1-30)

**Goal:** verify indexability; establish baseline; fix any coverage issues.
- [ ] Connect Google Search Console (DNS TXT verification — owner action).
- [ ] Submit/verify `https://saax-protocol.com/sitemap.xml`.
- [ ] URL Inspection on the 4 new articles + homepage + status; record indexed/not-indexed.
- [ ] Record Dev.to reads/reactions for the 4 cross-posts (baseline).
- [ ] Check coverage report for crawl errors, canonicalization, noindex issues.
- [ ] Re-run structured-data validation (Rich Results test) on the 4 articles.

## 4. 60-day plan (days 31-60)

**Goal:** first measured demand signal; iterate.
- [ ] Record GSC Performance: impressions, clicks, CTR, avg position for the 4 article URLs + site queries.
- [ ] Identify which article ranks for which query (keyword-to-page validation).
- [ ] Compare Dev.to referral traffic (if analytics connected) against direct.
- [ ] Update any article with weak engagement (editorial refresh, not keyword stuffing).
- [ ] Add internal links from underperforming pages to the cluster if useful.

## 5. 90-day plan (days 61-90)

**Goal:** trend + expansion decision.
- [ ] 3-month trend: impressions/clicks by query and page; WoW growth.
- [ ] Identify 1-2 new article topics from actual query data (only if measured demand supports).
- [ ] Re-verify canonical consistency and sitemap freshness (lastmod accurate).
- [ ] Report: what indexed, what ranked, what converted to docs/status visits.
- [ ] Decide whether GSC data justifies additional campaign investment.

## 6. Metrics requiring access

| Metric | Source |
|---|---|
| Indexed pages | Google Search Console (URL Inspection / Coverage) |
| Impressions, clicks, CTR, position | Google Search Console (Performance) |
| Search queries | Google Search Console (Performance → Queries) |
| Organic landing pages | Google Search Console (Performance → Pages) |
| Dev.to referral traffic | Google Analytics / Vercel Analytics (if enabled) |
| Dev.to reads/reactions | Dev.to dashboard (no GSC needed) |

## 7. Exact Search Console setup (owner action)

1. Open Google Search Console (search.google.com/search-console) → Add property → Domain.
2. Enter `saax-protocol.com`; copy the DNS TXT record.
3. Add the TXT record at the DNS provider (wherever saax-protocol.com DNS is hosted).
4. Verify; then Property → Sitemaps → submit `https://saax-protocol.com/sitemap.xml`.
5. Share the property (or add the station's access) so indexing can be inspected.
6. After verification, this station can run URL Inspection and read Performance data.

## 8. Explicit non-claims

- No indexing, ranking, impression, click, CTR, or traffic figure is claimed anywhere in this release.
- Sitemap submission does not guarantee indexing. HTTP 200 does not equal indexed.
- Dev.to publication is not Google indexing.
