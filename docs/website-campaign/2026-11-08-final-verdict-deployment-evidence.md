# SAAX Website Update + Agentic-Commerce Search Visibility — Final Verdict & Deployment Evidence

**Date:** 2026-11-08
**Verdict: COMPLETE — WITH DOCUMENTED LIMITATIONS**

## 1. Website (before → after)

| Page | Change |
|---|---|
| `/` (homepage) | Hero → "Durable Commitments for Autonomous Commerce"; complement-not-replace message; topic-cluster article block (4 new); x402/MPP overstatements corrected (5) |
| `/status` | Added durable-idempotency/reconciliation row (Beta deployed) + financial-limit row (Implemented/disabled); x402/MPP → x402 |
| `/docs` | x402-accurate payment language; MPP "implemented but not registered (x402-only)" disclosure |
| `/protocol` | Rail registry disclosure corrected; Router settles via x402 |
| `/blog` | 4 new articles added to index (md+html) |
| `/sitemap.xml` | 30 → 34 URLs, lastmod 2026-11-08 |
| `/llms.txt` | State line corrected; 4 essays added |
| `/llms-full.txt` | Rebuilt from updated pages (29 sections, snapshot 2026-11-08) |

**Capability status changes:** MPP downgraded from implied-live to "implemented, not registered in production"; financial-limit infrastructure explicitly labeled implemented/disabled; durable idempotency/reconciliation added as deployed-Beta rows.

## 2. Articles (SAAX originals — live)

| # | URL | Verdict |
|---|---|---|
| 1 | https://saax-protocol.com/blog/agentic-commerce-protocols-verified-map-2026 | LIVE (200), canonical, Article JSON-LD, OG, AI disclosure |
| 2 | https://saax-protocol.com/blog/after-ai-agent-pays-x402-stablecoins-saax | LIVE (200), same |
| 3 | https://saax-protocol.com/blog/google-ap2-authorization-vs-durable-commitments | LIVE (200), same |
| 4 | https://saax-protocol.com/blog/building-reliable-agentic-commerce-mcp-a2a-ucp-saax | LIVE (200), same |

## 3. Dev.to cross-posts (live, canonical verified)

| Dev.to ID | URL | Canonical → SAAX |
|---|---|---|
| 4998791 | dev.to/brudy_dev24/agentic-commerce-protocols-in-november-2026-...-45nn | agentic-commerce-protocols-verified-map-2026 |
| 4998796 | dev.to/brudy_dev24/what-happens-after-an-ai-agent-pays-...-22kn | after-ai-agent-pays-x402-stablecoins-saax |
| 4998797 | dev.to/brudy_dev24/google-ap2-and-saax-...-445b | google-ap2-authorization-vs-durable-commitments |
| 4998799 | dev.to/brudy_dev24/building-reliable-agentic-commerce-with-mcp-a2a-ucp-and-saax-1ad3 | building-reliable-agentic-commerce-mcp-a2a-ucp-saax |

No duplicate publication (verified against 13 existing posts before creating).

## 4. Engineering safety

- Branch: `website/agentic-commerce-campaign` (worktree isolated; main dirty tree preserved untouched).
- Commits: `eb2b83ad` (site + articles + indexes), `2a6b4b3d` (crosspost script), plus evidence docs (next commit).
- Production deployment: `ax-router-pr4moaioq` (Ready 33s), aliased `saax-protocol.com`.
- Rollback target: `ax-router-kx0954g5r` (prior production).
- Vercel GitHub auto-deploy: NOT reconnected (manual CLI deploy; verified no `git connect`).
- Payment execution code: UNTOUCHED (only landing/ pages, scripts, indexes, docs changed; no `endpoint/`, `api/` financial code, no migrations, no contracts).
- DB: untouched this run (no Supabase writes; verified read-only).
- Financial-limit enforcement: OFF. Allowlist: empty.
- LUMIYOU / Victoria's Vision: untouched (isolated worktree, no paths).
- Approved custody snapshot: untouched.

## 5. Verification results (live, this run)

- 9 live URLs → 200 with correct titles (homepage, status, 4 articles, blog index, sitemap, llms.txt).
- Homepage: hero H1 verified, topic block verified, no x402/MPP claims.
- Status: financial-limit + durable rows verified; x402-only.
- Article 1 live: canonical, JSON-LD Article, og:type article, H1, AI disclosure all verified via HTTP content match.
- Sitemap live: contains all 4 new URLs.
- Validator: 4 articles ALL CHECKS PASS; sitemap 34 URLs; blog index includes all 4.
- Dev.to: all 4 cross-posts verified via API (id, title, canonical).

## 6. Search visibility status

- **Google indexing: NOT VERIFIED** (Search Console not connected; no URL Inspection evidence).
- **Search demand: INFERRED, NOT MEASURED** (no keyword-volume/impression data).
- **Sitemap:** valid, 34 URLs, live.
- **robots.txt:** allows all, sitemap declared.
- **Structured data:** Article JSON-LD on all 4; Organization/WebAPI on homepage (existing).
- **Internal links:** topic-cluster block on homepage; cross-article links; consistent canonicals on saax-protocol.com.
- **Measurement:** 30/60/90-day plan documented; exact GSC setup steps provided (owner DNS TXT).

## 7. Remaining dependencies

1. **Google Search Console** connection (owner DNS TXT) → indexing inspection, sitemap submission, performance data.
2. **Vercel/GA analytics** (if desired) for referral/landing measurement.
3. **Next milestone** (live multi-instance financial verification) — separate owner authorization per the handoff plan; NOT started.

## 8. Final verdict

**COMPLETE — WITH DOCUMENTED LIMITATIONS.**
- Website accurate, deployed, verified live.
- 4 distinct researched articles live; 4 Dev.to cross-posts with exact canonicals.
- Searches: HTTP-verified; indexing NOT verified; demand NOT measured (limitations documented, no claims made).
- Production sound: financial code/DB/limits untouched; rollback preserved.