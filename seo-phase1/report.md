# SAAX Human Discoverability — Phase 1: Search Baseline & Technical SEO

**Run date:** 2026-10-24 (this audit)
**Repository (authoritative):** `C:\Users\Bryant\AppData\Roaming\ai.skynet.harness\workspaces\agent\ax-router`
**HEAD audited:** `main` @ `96e587f1` ("Update website status content to reflect Custody V3 review-prep state")
**Deployment:** Vercel project `ax-router` (`prj_o2g1a69CbitjPwtT3DAxevJkaX5v`), domain `saax-protocol.com` (Namecheap registrar)
**Deployed content baseline:** matches `publish/website-status-update` @ `bf8c603d` (content-alignment commit) **minus** the `96e587f1` status update, which is committed but **not deployed**.

---

## 1. Repository & deployed-vs-committed state

| Item | Finding |
|---|---|
| Authoritative repo | `ax-router` git tree; remote `origin` = `bryantrudy24/solvent-applied-saax-protocol.git` |
| Branch `main` HEAD | `96e587f1` — includes the Custody V3 / `status` content update (committed 2026-10-24), **not pushed/deployed** |
| Branch `publish/website-status-update` | `bf8c603d` — the last **deployed** content state (alignment of lifecycle, maturity separation, 11 blog posts) |
| `main` vs deployed | `main` adds: `/status` page (html+md), Custody V3 candidate badge/card on homepage, "Last updated" dates, `/status` link added in docs/security/spec/llms, sitemap entry for `/status` |
| Live `/status` | **404** (committed but not deployed) |
| Live sitemap | 22 URLs, **no `/status`**; deployed sitemap == `bf8c603d` sitemap |
| Working tree | Many pre-existing modified/untracked files (evidence, logs, scratch). **All preserved untouched.** Only landing metadata + 1 link changed by this task. |

**Conclusion:** the deployed site already reflects the full content-alignment work (`bf8c603d`). The only committed-but-unpublished content is the **Custody V3 status update** (`96e587f1`), which also carries the `/status` sitemap entry. A deploy is required before `/status` becomes live; that is out of scope for this phase (deploy requires explicit `vercel deploy` authorization).

---

## 2. Inventory — deployed public pages (all 22)

All URLs below resolved with HTTP 200, HTTPS, no redirect chains, no `X-Robots-Tag`, no `<meta name=robots>` noindex, correct self-canonical. Blog titles/H1/slugs/dates are **locked and unchanged** by this phase.

| URL | Title (deployed) | meta desc (before → after) | H1 | Canonical |
|---|---|---|---|---|
| `/` | SAAX Protocol — Solvent Applied Autonomous Exchange Protocol | 177 chars (good, unchanged) | The commitment protocol for autonomous commerce. | `https://saax-protocol.com/` |
| `/protocol` | SAAX Protocol — The Standard | **"SAAX Protocol — The Standard" (28c) → "The SAAX Protocol standard: the commitment lifecycle, authority and evidence interfaces, settlement linkage, and error codes for autonomous commerce."** | SAAX Protocol — The Standard | `…/protocol` |
| `/docs` | SAAX Protocol — Integration Guide | **"SAAX Protocol — Integration Guide" (33c) → "How to connect to SAAX from an AI agent or application: MCP integration, immediate x402/MPP payments on Base mainnet, and the testnet-only escrow flow."** | SAAX Protocol — Integration Guide | `…/docs` |
| `/spec` | SAAX Protocol — Commitment Lifecycle Specification | **"SAAX Protocol — Commitment Lifecycle Specification" (50c) → "The canonical commitment schema and lifecycle specification: states, authority, evidence, escrow custody, settlement linkage, and durable persistence."** | SAAX Protocol — Commitment Lifecycle Specification | `…/spec` |
| `/terms` | Terms - SAAX Protocol | 142 chars (good) | SAAX Protocol — Terms of Use | `…/terms` |
| `/security` | Security - SAAX Protocol | 151 chars (good) | SAAX Security | `…/security` |
| `/privacy` | Privacy Policy - SAAX Protocol | 155 chars (good) | SAAX Privacy Policy | `…/privacy` |
| `/disputes` | Disputes - SAAX Protocol | 152 chars (good) | SAAX Disputes | `…/disputes` |
| `/conformance` | Conformance Suite - SAAX Protocol | 160 chars (good) | SAAX Conformance Suite | `…/conformance` |
| `/welcome` | Welcome to SAAX Premium — SAAX Protocol | 169 chars (good) | Welcome to SAAX Premium | `…/welcome` |
| `/blog` | SAAX Protocol — Essays | 104 chars (good) | SAAX Protocol — Essays | `…/blog` |
| 11 blog posts | see §5 | see §5 | see §5 | `…/blog/<slug>` |

**Edge cases verified:**
- `/receipt?txHash=…&rail=x402` → 200 (transaction receipt lookup; not in sitemap, expected)
- `/checkout` → 303 redirect to Stripe (expected; not indexable, not in sitemap)
- `/mcp` → 200 (API surface; not in sitemap — correct)
- `/route`, `/receipt` (GET) → 404 on GET for POST-only endpoints (expected)

---

## 3. Search accessibility verification (all checks documented)

| Check | Result |
|---|---|
| `robots.txt` | 200; `User-agent: * / Allow: /` + `Sitemap: https://saax-protocol.com/sitemap.xml` — valid, no blocking |
| `sitemap.xml` | 200; valid XML; 22 URLs — all resolve 200 and to the canonical page. Missing: `/status` (committed but not deployed) |
| Sitemap discovery | Referenced in robots.txt and discoverable at `/sitemap.xml` |
| Accidental noindex | **None** — no `<meta name=robots>` and no `X-Robots-Tag` on any deployed HTML page |
| HTTP→HTTPS | `http://saax-protocol.com/` → 308 permanent → HTTPS (good) |
| www vs non-www | `https://www.saax-protocol.com/` → **200, byte-identical content, NO redirect**; canonical points to non-www on both. Duplicate host exists but canonical consolidation is correct. (Not a defect requiring a fix; residual risk documented) |
| Trailing-slash variants | `/protocol/`, `/docs/`, `/spec/`, `/terms/`, `/security/`, `/privacy/`, `/disputes/`, `/conformance/`, `/welcome/`, `/blog/` → all **404** (Vercel rewrites don't match trailing slash). Not linked internally and not in sitemap — low priority, but a common crawler probe target (esp. Bing). No fix applied (would require redirect config, out of phase scope) |
| Broken internal links | Blog posts link internally to `/`, `/protocol`, `/spec`, `/docs`, `/blog`, `/conformance`, `/terms`, `/security`, `/privacy`, `/disputes` — **all 200**. Homepage links `/checkout?plan=trial`, `/status`, `/conformance` — `/status` currently 404 (see §1). **No other broken internal links** |
| Broken external links | `/docs` and `llms-full.txt` + `docs.md` referenced `https://registry.modelcontextprotocol.io/servers/io.github.bryantrudy24/saax-protocol` → **404 (fixed, see §4)**. Homepage uses the correct `/v0.1/.../versions` URL → 200. All other outbound (x402.org 200, erc-8004 200, basescan 200, GitHub 200, buy.stripe.com 200) |
| Orphaned documentation | `/status` committed but not deployed (orphaned until deploy). `/openapi.json` and `/conformance-vectors.md` 404 but are **not linked** from any page (plain-text references only) — not orphans, not broken links |
| Text/nav crawlability | All content is server-rendered static HTML; nav is plain `<a href>`; no JS-gated content. Crawler-accessible |

---

## 4. Fixes applied (locally, committed, not deployed)

### 4.1 Broken MCP Registry link (demonstrated 404)
- Before: `https://registry.modelcontextprotocol.io/servers/io.github.bryantrudy24/saax-protocol` → **HTTP 404**
- After: `https://registry.modelcontextprotocol.io/v0.1/servers/io.github.bryantrudy24%2Fsaax-protocol/versions` → **HTTP 200** (canonical, matches homepage usage)
- Files: `landing/docs.html`, `landing/docs.md`, `landing/llms-full.txt`

### 4.2 Thin / title-duplicate meta descriptions (SERP snippet quality)
Rewrote descriptions that merely repeated the H1/title. New text is drawn from the page's own accurate `og:description` (blog) or written from visible page content (core), preserving truth and scope (no invented claims, no mainnet-escrow implication).

| File | Before (chars) | After (chars) |
|---|---|---|
| `blog/agent-execution-liability-…` | "Agent Execution Liability: Who Pays When an Agent Buys Wrong" (60) | "Four parties can plausibly claim the loss is not theirs. Without a commitment record, liability becomes a negotiation between incomplete stories." (153) |
| `blog/how-to-handle-agentic-commerce-disputes` | "How to Handle Agentic Commerce Disputes" (39) | "When an agent buys wrong, there is no structured record of what was committed. A commitment layer makes disputes decidable." (137) |
| `blog/preventing-autonomous-agent-double-purchasing` | "Preventing Autonomous Agent Double-Purchasing" (45) | "Agent retries race the merchant's accept path. A commitment identifier prevents double-purchases only when execution and settlement enforce durable deduplication on it." (170) |
| `blog/the-audit-trail-problem-in-agentic-commerce` | "The Audit Trail Problem in Agentic Commerce" (43) | "Six months after an agent made a purchase, can you reconstruct what happened? In most systems today, the answer is no." (132) |
| `blog/what-does-an-agent-actually-commit-to` | "What Does an Agent Actually Commit To?" (38) | "The commitment layer explained — what it records, the lifecycle states, and the in-flight handling rule." (104) |
| `blog/why-payment-authorization-does-not-equal-fulfillment` | "Why Payment Authorization ≠ Fulfillment in Agentic Commerce" (59) | "A payment authorization proves the transaction was permitted. It does not prove the deliverable matched the agreement." (126) |
| `protocol.html` | "SAAX Protocol — The Standard" (28) | "The SAAX Protocol standard: the commitment lifecycle, authority and evidence interfaces, settlement linkage, and error codes for autonomous commerce." (158) |
| `docs.html` | "SAAX Protocol — Integration Guide" (33) | "How to connect to SAAX from an AI agent or application: MCP integration, immediate x402/MPP payments on Base mainnet, and the testnet-only escrow flow." (168) |
| `spec.html` | "SAAX Protocol — Commitment Lifecycle Specification" (50) | "The canonical commitment schema and lifecycle specification: states, authority, evidence, escrow custody, settlement linkage, and durable persistence." (163) |

**Preservation guarantees (verified by script):**
- All 11 blog **titles, H1s, slugs, and original publication dates unchanged.**
- No `<title>` or `<h1>` edits on any page.
- No changes to protocol behavior, API access controls, or security restrictions.
- UTF-8 intact (no mojibake introduced); line endings preserved (LF).

**Not changed (deliberately):**
- `/security`, `/privacy`, `/terms`, `/disputes`, `/conformance`, `/welcome`, `/blog`, `/` — descriptions already substantive.
- `blog/agentic-commerce-disputes-complete-faq`, `agentic-commerce-protocols-explained`, `agentic-commerce-rails`, `what-is-agentic-commerce`, `how-to-make-money-with-ai-agents` — already substantive.
- No structured data added (existing Organization JSON-LD on homepage is accurate; no rich-result promises).
- No sitemap change (deployed sitemap is correct for deployed content; `/status` addition belongs with the deploy).

---

## 5. Blog inventory (11 posts — titles/H1/slugs/dates preserved)

| # | Slug | Title (lock) | Date (lock) | meta desc before → after |
|---|---|---|---|---|
| 1 | `what-is-agentic-commerce` | Agentic Commerce Foundations: The Complete Guide | 2026-10-11 | good, unchanged |
| 2 | `agentic-commerce-disputes-complete-faq` | Agentic Commerce Disputes: The Complete FAQ | 2026-10-10 | good, unchanged |
| 3 | `how-to-handle-agentic-commerce-disputes` | How to Handle Agentic Commerce Disputes | 2026-10-08 | **fixed** |
| 4 | `agent-execution-liability-who-pays-when-an-agent-buys-wrong` | Agent Execution Liability: Who Pays When an Agent Buys Wrong | 2026-10-08 | **fixed** |
| 5 | `preventing-autonomous-agent-double-purchasing` | Preventing Autonomous Agent Double-Purchasing | 2026-10-08 | **fixed** |
| 6 | `the-audit-trail-problem-in-agentic-commerce` | The Audit Trail Problem in Agentic Commerce | 2026-10-08 | **fixed** |
| 7 | `why-payment-authorization-does-not-equal-fulfillment` | Why Payment Authorization ≠ Fulfillment in Agentic Commerce | 2026-10-08 | **fixed** |
| 8 | `what-does-an-agent-actually-commit-to` | What Does an Agent Actually Commit To? | 2026-10-10 | **fixed** |
| 9 | `agentic-commerce-protocols-explained` | Agentic Commerce Protocols Explained: AP2, x402, ACP, and UCP | 2026-10-11 | good, unchanged |
| 10 | `agentic-commerce-rails` | Agentic Commerce Rails: What Exists and What's Missing | 2026-10-11 | good, unchanged |
| 11 | `how-to-make-money-with-ai-agents` | How to Actually Make Money with AI Agents (And Why Most People Don't) | 2026-10-10 | good, unchanged |

---

## 6. Measurable search performance — ACCESS NOT AVAILABLE

**GSC / Bing Webmaster access: not configured.** No `google-site-verification` meta/token or `bing` verification exists in the codebase, and no Search Console / Bing Webmaster connector is connected on this station. **No traffic, ranking, or keyword data exists to report — none was invented.**

### Exact setup instructions (for the Commander)
1. **Google Search Console** — https://search.google.com/search-console → "Add property" → **Domain** property: `saax-protocol.com` (DNS verification, recommended) or **URL prefix**: `https://saax-protocol.com/` (HTML file or meta tag). Since the site is on Vercel with Namecheap DNS, the **DNS TXT record** route is simplest (add TXT `google-site-verification=…` at the registrar, or add the DNS record in Vercel's DNS panel if domain is managed there). After verify, submit `https://saax-protocol.com/sitemap.xml`.
2. **Bing Webmaster Tools** — https://www.bing.com/webmasters → sign in (Microsoft account) → add site → **import from Google Search Console** (one click, after GSC is live) or verify via the same DNS TXT / meta tag. Submit the same sitemap.
3. After ~48h, GSC shows: index coverage, sitemap errors, queries/impressions/clicks, landing pages, and branded vs non-branded split (filter query for "saax" / "saax protocol").

**Baseline that IS available (public, measured this run):**
- 22 public URLs, all HTTP 200, all self-canonical, all in sitemap.
- robots.txt allows all; no noindex anywhere.
- Homepage has Organization JSON-LD; authored pages have accurate og/twitter tags.
- 11 blog posts indexed as separate URLs with locked titles/dates.

---

## 7. Unresolved access dependencies

| Dependency | Status | Needed for |
|---|---|---|
| Deploy `96e587f1` (or cherry-pick status update to a deploy branch) | **Not done** (out of scope; requires explicit `vercel deploy`) | `/status` live; sitemap `/status` entry valid; homepage `/status` link stops 404ing |
| Google Search Console verification (Commander action) | Not done | Indexing status, queries, impressions, clicks, sitemap errors |
| Bing Webmaster Tools verification (Commander action) | Not done | Same on Bing |
| `www`→apex redirect | Optional; missed by design | Remove duplicate-host ambiguity (canonical already consolidates) |
| Trailing-slash redirects | Optional; not applied | Crawler URL normalization (low priority) |

---

## 8. Content priorities (at most 3, from audit evidence)

Ranked by expected discovery value vs. effort; none duplicate existing posts, none claim unsupported mainnet escrow.

### P1 — "SAAX status & roadmap" page (draft exists: `/status` — deploy it)
- **Intended reader:** evaluators, reviewers, technical prospects deciding whether to integrate.
- **Question answered:** "Is SAAX production-ready? What is live on mainnet, what is testnet-only, what is under review?"
- **Existing overlap:** none (only a committed draft `landing/status.html`/`status.md` from `96e587f1` — currently 404).
- **Integration links:** `/docs`, `/security`, `/conformance`, `/spec`.
- **Why now:** it is already authored, committed, and the missing page with the most direct search demand ("SAAX status", "SAAX mainnet"). Deploying it is the single highest-leverage action.

### P2 — "SAAX vs. escrow alternatives / when to use escrow vs immediate payment" explainer
- **Intended reader:** developers choosing a settlement model for agent payments.
- **Question answered:** "When do I need escrow (and what are the constraints) versus immediate x402/MPP payment?"
- **Existing overlap:** `/docs` covers the two flows factually but not decision-oriented; blog rails/protocols posts cover rails but not the escrow-vs-immediate decision.
- **Integration links:** `/docs`, `/spec` (§5 escrow), `/security` (non-custodial scoping).
- **Why now:** high-intent commercial query ("agent payment escrow", "x402 escrow"), directly supported by actual capability (testnet escrow + mainnet immediate), low effort (synthesizes existing pages).

### P3 — "Paying an AI agent safely: buyer checklist" (short buyer-facing guide)
- **Intended reader:** buyers/end-users who will let an agent spend money.
- **Question answered:** "What should I record before an agent pays, and what can go wrong?"
- **Existing overlap:** blog posts cover disputes/liability/audit individually; no single practical checklist page exists.
- **Integration links:** `/blog/*` (liability, disputes, audit-trail), `/terms`, `/disputes`.
- **Why now:** fills a genuine navigation gap from the homepage CTA ("Try SAAX Router") toward buyer confidence; supports non-branded queries like "how to safely let an AI agent pay".

---

## 9. Before/after issue table

| # | Issue | Before (deployed) | After (local commit) | Evidence |
|---|---|---|---|---|
| 1 | Broken MCP Registry link | 404 on docs/docs.md/llms-full.txt | 200 canonical URL in all 3 files | curl 404 → 200 |
| 2 | Title-duplicate meta descriptions | 6 blog + 3 core pages repeated H1 | Substantive, accurate descriptions | verified 9/9 |
| 3 | `/status` committed but 404 deployed | sitemap(on main) + homepage link → 404 | **Not changed** (needs deploy) | curl 404; git diff main vs bf8c603d |
| 4 | www duplicate host (no redirect) | 200 byte-identical on www | **Not changed** (canonical correct) | curl + fc |
| 5 | Trailing-slash URLs 404 | all core paths `/…/` → 404 | **Not changed** (not linked/in sitemap) | curl |
| 6 | No GSC/Bing verification | absent | setup instructions provided | file scan |
| 7 | No traffic/ranking baseline | none measurable without GSC | exact setup steps provided | connectors scan |

**Validation:** all fixes verified by script (meta OK 9/9, mojibake CLEAN, link fixed in 3 files, titles/H1/dates preserved). Site-wide crawl reconfirmed 22×200 + canonicals after patch (static HTML, no deploy needed to validate).

---

## 10. Commits (this phase — local only, no push)

- Landing fixes + task files are committed on `main` (working tree otherwise untouched; pre-existing unrelated modifications preserved).
- **No push, no deploy, no external posting.**
