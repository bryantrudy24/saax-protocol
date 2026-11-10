#!/usr/bin/env node
// Generate pre-rendered HTML for the two new search-informed articles.
// Matches the established landing/blog template (x402-receipts pattern):
// head with canonical/OG/twitter + JSON-LD Article, nav, <article>, footer.
const fs = require('fs');
const path = require('path');

const BLOG = path.resolve(__dirname, '..', 'landing', 'blog');

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inline(s) {
  s = s.replace(/`([^`]+)`/g, (_, c) => '<code>' + esc(c) + '</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italic: single * not part of ** or links
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}
function renderBody(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inList = false, inPre = false;
  function cl() { if (inList) { out.push('</ul>'); inList = false; } }
  function cp() { if (inPre) { out.push('</pre>'); inPre = false; } }
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (t.startsWith('```')) { if (!inPre) { cl(); out.push('<pre>'); inPre = true; } else cp(); continue; }
    if (inPre) { out.push(esc(line)); continue; }
    if (!t) { cl(); cp(); continue; }
    if (t.startsWith('### ')) { cl(); out.push('<h3>' + inline(t.slice(4)) + '</h3>'); continue; }
    if (t.startsWith('## ')) { cl(); out.push('<h2>' + inline(t.slice(3)) + '</h2>'); continue; }
    if (t.startsWith('# ')) { cl(); out.push('<h1>' + inline(t.slice(2)) + '</h1>'); continue; }
    if (t.startsWith('---')) { cl(); out.push('<hr>'); continue; }
    if (t.startsWith('- ')) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(t.slice(2)) + '</li>'); continue; }
    if (/^\d+\.\s/.test(t)) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(t.replace(/^\d+\.\s/, '')) + '</li>'); continue; }
    cl(); out.push('<p>' + inline(t) + '</p>');
  }
  cl(); cp();
  return out.join('\n');
}

const NAV = `<header><div class="container"><nav class="nav" aria-label="Main">
  <a class="brand" href="/"><img src="/assets/logo-full-light.png" alt="SAAX Protocol" class="site-logo" style="height: 32px;"></a>
  <div class="links">
    <a href="/protocol">Protocol</a>
    <a href="/spec">Spec</a>
    <a href="/docs">Docs</a>
    <a href="/blog">Blog</a>
  </div>
</nav></div></header>`;

const FOOTER = `<footer><div class="container">
  <p class="brand-line">SAAX Protocol — Solvent Applied Autonomous Exchange Protocol</p>
  <div class="links">
    <a href="/spec">Spec</a><a href="/docs">Docs</a><a href="/blog">Blog</a>
    <a href="/terms">Terms</a><a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/disputes">Disputes</a>
  </div>
  <p class="copy">© 2026 SAAX Protocol. All rights reserved.</p>
</div></footer>`;

const ARTICLES = [
  {
    slug: 'what-agent-payment-authorization-actually-authorizes',
    title: 'What an AI Agent Payment Authorization Actually Authorizes',
    desc: 'A payment authorization is permission to move money, not a contract, receipt, or proof of delivery. What signed records add, what spend limits cannot, and the domain separation that makes disputes resolvable.',
    date: 'November 6, 2026',
    byline: 'SAAX Protocol · Published November 6, 2026 · Technical implementation note',
  },
  {
    slug: 'what-escrow-security-review-actually-verifies',
    title: 'What a Smart Contract Escrow Security Review Actually Verifies',
    desc: 'An escrow review checks authorization chains, timed release, refunds, evaluator powers, dispute liveness, and replay protection. What an owner-approved review snapshot is — and is not.',
    date: 'November 6, 2026',
    byline: 'SAAX Protocol · Published November 6, 2026 · Technical implementation note',
  },
];

const JSONLD = (a) => `{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": ${JSON.stringify(a.title)},
  "description": ${JSON.stringify(a.desc)},
  "url": "https://saax-protocol.com/blog/${a.slug}",
  "mainEntityOfPage": "https://saax-protocol.com/blog/${a.slug}",
  "datePublished": "2026-11-06",
  "dateModified": "2026-11-06",
  "author": {
    "@type": "Organization",
    "name": "SAAX Protocol",
    "url": "https://saax-protocol.com"
  },
  "publisher": {
    "@type": "Organization",
    "name": "SAAX Protocol",
    "url": "https://saax-protocol.com",
    "logo": {
      "@type": "ImageObject",
      "url": "https://saax-protocol.com/assets/logo-full-light.png"
    }
  },
  "inLanguage": "en"
}`;

for (const a of ARTICLES) {
  const md = fs.readFileSync(path.join(BLOG, a.slug + '.md'), 'utf8');

  // Extract body after the front matter (H1, italic date lines, ---).
  const mdLines = md.split(/\r?\n/);
  let bodyMd = '', started = false;
  for (const l of mdLines) {
    const t = l.replace(/\r$/, '').trim();
    if (!started) {
      if (/^# /.test(t)) continue;          // skip md H1
      if (/^\*[A-Z][a-z]+ \d/.test(t)) continue; // skip md date lines
      if (/^Last updated/.test(t)) continue;
      if (t === '---') { started = true; continue; }
      continue;
    }
    bodyMd += l.replace(/\r$/, '') + '\n';
  }
  const body = renderBody(bodyMd.trim());

  const aiDisc = `<p><em>AI disclosure: this article was researched and written by an AI operator from publicly available documentation and SAAX's inspected implementation. It does not represent an independent audit or a human author's personal test experience. Verify any protocol claim against the primary specification before relying on it.</em></p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${a.title} — SAAX Protocol</title>
<meta name="description" content="${a.desc}">
<link rel="canonical" href="https://saax-protocol.com/blog/${a.slug}">
<meta property="og:title" content="${a.title} — SAAX Protocol">
<meta property="og:description" content="${a.desc}">
<meta property="og:url" content="https://saax-protocol.com/blog/${a.slug}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="SAAX Protocol">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${a.title} — SAAX Protocol">
<meta name="twitter:description" content="${a.desc}">
<style>

  :root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa7b4;--accent:#2f81f7;--border:#2d333b;}
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
  .muted{color:var(--muted);}
  .post-list{list-style:none;}
  .post-list li{padding:.9rem 0;border-bottom:1px solid var(--border);}
  .post-list a{font-size:1.05rem;font-weight:600;}
  .post-list .date{color:var(--muted);font-size:.9rem;margin-left:.6rem;}
  footer{border-top:1px solid var(--border);padding:2rem 0 3rem;}
  footer .brand-line{font-weight:700;margin-bottom:.8rem;}
  footer .links{display:flex;flex-wrap:wrap;gap:1.2rem;margin-bottom:1rem;}
  footer .links a{color:var(--muted);font-size:.9rem;}
  footer .copy{color:var(--muted);font-size:.82rem;}
</style>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<script type="application/ld+json">
${JSONLD(a)}
</script>
</head>
<body>

${NAV}

<main><div class="container">
<article>
<h1>${a.title}</h1>
<p class="post-byline">${a.byline}</p>
<p class="post-date"><em>${a.date}</em></p>
<hr>
${body}
${aiDisc}
</article>
</div></main>
${FOOTER}
</body>
</html>
`;
  const htmlPath = path.join(BLOG, a.slug + '.html');
  fs.writeFileSync(htmlPath, html);
  console.log('wrote ' + a.slug + '.html (' + html.length + ' bytes)');
}