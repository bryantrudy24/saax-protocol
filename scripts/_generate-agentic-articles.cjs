#!/usr/bin/env node
// Generate blog article HTML from markdown for the agentic-commerce campaign.
// Mirrors the established template (building-reliable-autonomous-commerce.html).
// Usage: node scripts/_generate-agentic-articles.cjs
const fs = require('fs');
const path = require('path');

const ARTICLES = [
  {
    slug: 'agentic-commerce-protocols-verified-map-2026',
    title: 'Agentic Commerce Protocols in November 2026: A Verified Map of ACP, AP2, UCP, x402, MCP, A2A — and Where a Commitment Layer Fits',
    description:
      'A primary-source map of ACP, AP2, UCP, x402, MCP, and A2A as of November 2026 — what each officially covers, what its own docs exclude, and where a durable commitment layer fits.',
    date: '2026-11-08',
  },
  {
    slug: 'after-ai-agent-pays-x402-stablecoins-saax',
    title: 'What Happens After an AI Agent Pays? x402, Stablecoins, Settlement Evidence, and SAAX',
    description:
      'x402 and stablecoin settlement prove value moved — not that work was delivered. How SAAX durable commitments, idempotency, and reconciliation make agent payments recoverable.',
    date: '2026-11-08',
  },
  {
    slug: 'google-ap2-authorization-vs-durable-commitments',
    title: 'Google AP2 and SAAX: Authorization Evidence vs Durable Commitments',
    description:
      'AP2 answers "was this agent permitted to pay?" SAAX answers "what was the money for, and what happens when the deal goes wrong?" How the two layers complement each other.',
    date: '2026-11-08',
  },
  {
    slug: 'building-reliable-agentic-commerce-mcp-a2a-ucp-saax',
    title: 'Building Reliable Agentic Commerce with MCP, A2A, UCP, and SAAX',
    description:
      'MCP connects agents to tools, A2A connects agents to agents, UCP navigates commerce. A reference architecture for the durable commitment layer that makes it all recoverable.',
    date: '2026-11-08',
  },
];

const CSS = `:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa7b4;--accent:#2f81f7;--border:#2d333b;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.6;-webkit-font-smoothing:antialiased;}
  a{color:var(--accent);text-decoration:none;}
  a:hover{text-decoration:underline;}
  .container{max-width:1040px;margin:0 auto;padding:0 20px;}
  header .nav{display:flex;align-items:center;gap:1rem;padding:1rem 0;}
  .brand{font-weight:800;font-size:1.15rem;color:var(--fg);letter-spacing:.01em;}
  .nav .links{margin-left:auto;display:flex;gap:1.25rem;}
  .nav .links a{color:var(--fg);text-decoration:none;font-size:.92rem;}
  .nav .links a:hover{color:var(--accent);}
  main{padding:3rem 0 4rem;}
  article{max-width:780px;margin:0 auto;}
  article h1{font-size:2rem;font-weight:800;line-height:1.2;margin-bottom:1rem;}
  article h2{font-size:1.4rem;font-weight:750;margin:1.75rem 0 .9rem;}
  article h3{font-size:1.2rem;font-weight:700;margin:1.4rem 0 .7rem;}
  article p{color:var(--fg);margin-bottom:1.1rem;}
  article em{color:var(--muted);}
  article code{background:#161b22;border:1px solid var(--border);border-radius:4px;padding:.1rem .35rem;font-size:.9em;}
  article pre{background:#161b22;border:1px solid var(--border);border-radius:8px;padding:1rem 1.1rem;overflow-x:auto;margin:0 0 1.1rem;}
  article pre code{background:transparent;border:none;padding:0;font-size:.9em;display:block;}
  article ul,article ol{margin:0 0 1.1rem 1.4rem;}
  article li{margin-bottom:.4rem;}
  article blockquote{border-left:3px solid var(--border);padding-left:1rem;color:var(--muted);margin:0 0 1.1rem;}
  article hr{border:none;border-top:1px solid var(--border);margin:1.5rem 0;}
  article p.states{background:#161b22;border:1px solid var(--border);border-radius:8px;padding:.9rem 1.1rem;font-size:.95rem;}
  article .post-byline{color:var(--muted);font-weight:600;margin-bottom:.2rem;}
  article .post-date{color:var(--muted);font-style:italic;margin-bottom:1.2rem;}
  article table{border-collapse:collapse;width:100%;margin:0 0 1.1rem;font-size:.92rem;}
  article th,article td{border:1px solid var(--border);padding:.5rem .7rem;text-align:left;color:var(--fg);}
  article th{background:#161b22;font-weight:700;}
  article{min-width:0;overflow-wrap:anywhere;}
  article table{display:block;max-width:100%;overflow-x:auto;}
  article th,article td{min-width:110px;}
  .muted{color:var(--muted);}
  footer{border-top:1px solid var(--border);padding:2rem 0 3rem;}
  footer .brand-line{font-weight:700;margin-bottom:.8rem;}
  footer .links{display:flex;flex-wrap:wrap;gap:1.2rem;margin-bottom:1rem;}
  footer .links a{color:var(--muted);font-size:.9rem;}
  footer .copy{color:var(--muted);font-size:.82rem;}
  @media (max-width:640px){.nav .links{gap:.8rem;}article h1{font-size:1.6rem;}}`;

// Minimal markdown -> HTML for the subset used in these articles
function mdToHtml(md) {
  let lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inUl = false;
  let inOl = false;
  let inPre = false;
  let preBuf = [];
  const flushUl = () => { if (inUl) { html += '</ul>\n'; inUl = false; } };
  const flushOl = () => { if (inOl) { html += '</ol>\n'; inOl = false; } };
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  for (const raw of lines) {
    const line = raw;
    if (line.startsWith('```')) {
      if (!inPre) { flushUl(); flushOl(); inPre = true; preBuf = []; }
      else { inPre = false; html += '<pre><code>' + preBuf.join('\n') + '</code></pre>\n'; }
      continue;
    }
    if (inPre) { preBuf.push(line); continue; }
    if (line.startsWith('|') && line.includes('|---')) continue;
    if (line.startsWith('|')) {
      flushUl(); flushOl();
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!html.endsWith('</table>\n') && !html.endsWith('</thead>\n') && !html.endsWith('<tbody>\n') && !/<table>/.test(html.slice(-200))) {
        html += '<table>\n<thead>\n<tr>' + cells.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr>\n</thead>\n<tbody>\n';
      } else {
        html += '<tr>' + cells.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>\n';
      }
      continue;
    }
    if (/^## /.test(line)) { flushUl(); flushOl(); html += '<h2>' + inline(line.slice(3)) + '</h2>\n'; continue; }
    if (/^### /.test(line)) { flushUl(); flushOl(); html += '<h3>' + inline(line.slice(4)) + '</h3>\n'; continue; }
    if (/^# /.test(line)) { flushUl(); flushOl(); continue; } // skip H1 (title rendered separately)
    if (/^---\s*$/.test(line)) { flushUl(); flushOl(); html += '<hr>\n'; continue; }
    if (/^\*.*\*$/.test(line) && !line.includes('**')) { flushUl(); flushOl(); html += '<p><em>' + inline(line.slice(1, -1)) + '</em></p>\n'; continue; }
    if (/^[-*] /.test(line)) { flushOl(); if (!inUl) { html += '<ul>\n'; inUl = true; } html += '<li>' + inline(line.replace(/^[-*] /, '')) + '</li>\n'; continue; }
    if (/^\d+\. /.test(line)) { flushUl(); if (!inOl) { html += '<ol>\n'; inOl = true; } html += '<li>' + inline(line.replace(/^\d+\. /, '')) + '</li>\n'; continue; }
    if (line.trim() === '') { flushUl(); flushOl(); continue; }
    flushUl(); flushOl();
    if (/^&gt;/.test(line)) { html += '<blockquote>' + inline(line.replace(/^&gt;\s?/, '')) + '</blockquote>\n'; continue; }
    html += '<p>' + inline(line) + '</p>\n';
  }
  flushUl(); flushOl();
  if (inPre) html += '<pre><code>' + preBuf.join('\n') + '</code></pre>\n';
  return html;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

for (const a of ARTICLES) {
  const mdPath = path.join(__dirname, '..', 'landing', 'blog', a.slug + '.md');
  const md = fs.readFileSync(mdPath, 'utf8');
  // strip front matter: first H1 line, date lines, and the first --- separator
  const bodyLines = md.split('\n');
  let body = '';
  let skip = true; // skip until the first --- after the title/date block
  let seenSep = false;
  for (const ln of bodyLines) {
    if (!seenSep) {
      if (/^# /.test(ln)) continue;
      if (/^\*/.test(ln) && !seenSep && !ln.includes('**')) continue;
      if (/^---\s*$/.test(ln)) { seenSep = true; continue; }
      continue;
    }
    body += ln + '\n';
  }
  body = body.replace(/\n+$/, '\n');
  const content = mdToHtml(body);

  const jsonLd = `{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": ${JSON.stringify(a.title)},
  "description": ${JSON.stringify(a.description)},
  "url": "https://saax-protocol.com/blog/${a.slug}",
  "mainEntityOfPage": "https://saax-protocol.com/blog/${a.slug}",
  "datePublished": "${a.date}",
  "dateModified": "${a.date}",
  "author": { "@type": "Organization", "name": "SAAX Protocol", "url": "https://saax-protocol.com" },
  "publisher": { "@type": "Organization", "name": "SAAX Protocol", "url": "https://saax-protocol.com" },
  "inLanguage": "en"
}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.title)} | SAAX Protocol</title>
<meta name="description" content="${esc(a.description)}">
<link rel="canonical" href="https://saax-protocol.com/blog/${a.slug}">
<meta property="og:title" content="${esc(a.title)} | SAAX Protocol">
<meta property="og:description" content="${esc(a.description)}">
<meta property="og:url" content="https://saax-protocol.com/blog/${a.slug}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="SAAX Protocol">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(a.title)} | SAAX Protocol">
<meta name="twitter:description" content="${esc(a.description)}">
<style>
${CSS}
</style>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<script type="application/ld+json">
${jsonLd}
</script>
</head>
<body>
<header><div class="container"><nav class="nav" aria-label="Main">
  <a class="brand" href="/"><img src="/assets/logo-full-light.png" alt="SAAX Protocol" class="site-logo" style="height: 32px;"></a>
  <div class="links">
    <a href="/protocol">Protocol</a>
    <a href="/spec">Spec</a>
    <a href="/docs">Docs</a>
    <a href="/status">Status</a>
    <a href="/blog">Blog</a>
  </div>
</nav></div></header>
<main><div class="container"><article>
<h1>${esc(a.title)}</h1>
<p class="post-byline">By SAAX Protocol</p>
<p class="post-date">${a.date}</p>
${content}
<p class="states"><em>AI disclosure: This article was developed with AI assistance and reviewed by the SAAX team. Claims about external protocols are sourced from official documentation linked in the text; SAAX status claims reflect the published <a href="/status">status page</a>. Nothing here is an independent audit, certification, or production-custody approval.</em></p>
<p><strong>Next step:</strong> read the <a href="/protocol">protocol overview</a> and the <a href="/spec">commitment lifecycle specification</a>, then try the <a href="/docs#discovery-quickstart">public preflight and acceptance flow</a> — it creates a signed commitment without moving funds.</p>
</article></div></main>
<footer><div class="container">
  <p class="brand-line">SAAX Protocol - Solvent Applied Autonomous Exchange Protocol</p>
  <div class="links">
    <a href="/spec">Spec</a><a href="/docs">Docs</a><a href="/status">Status</a><a href="/blog">Blog</a>
    <a href="/terms">Terms</a><a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/disputes">Disputes</a><a href="/conformance">Conformance</a>
  </div>
  <p class="copy">© 2026 SAAX Protocol. All rights reserved.</p>
</div></footer>
</body>
</html>
`;
  const outPath = path.join(__dirname, '..', 'landing', 'blog', a.slug + '.html');
  fs.writeFileSync(outPath, html);
  console.log('generated', a.slug + '.html', html.length, 'bytes');
}
console.log('done');
