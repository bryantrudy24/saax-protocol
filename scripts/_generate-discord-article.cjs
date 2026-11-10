#!/usr/bin/env node
// Generate pre-rendered HTML for the Discord-announcement article.
// Matches the established landing/blog template: head w/ canonical/OG/twitter + JSON-LD Article, nav, <article>, footer.
const fs = require('fs');
const path = require('path');
const BLOG = path.resolve(__dirname, '..', 'landing', 'blog');
const slug = 'building-reliable-autonomous-commerce';
const title = 'Building Reliable Autonomous Commerce: Join the SAAX Protocol Discussion';
const desc = 'Why persistent commitments matter when autonomous agents fail, restart, or disappear. A technical community introduction to SAAX Protocol and the open problems in agent-commerce reliability.';
const date = 'November 6, 2026';
const byline = 'SAAX Protocol | Published November 6, 2026 | Technical implementation note';

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}
function renderBody(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inList = false;
  function cl() { if (inList) { out.push('</ul>'); inList = false; } }
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (!t) { cl(); continue; }
    if (t.startsWith('## ')) { cl(); out.push('<h2>' + inline(t.slice(3)) + '</h2>'); continue; }
    if (t.startsWith('# ')) { cl(); out.push('<h1>' + inline(t.slice(2)) + '</h1>'); continue; }
    if (t.startsWith('---')) { cl(); out.push('<hr>'); continue; }
    if (t.startsWith('- ')) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(t.slice(2)) + '</li>'); continue; }
    if (/^\d+\.\s/.test(t)) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(t.replace(/^\d+\.\s/, '')) + '</li>'); continue; }
    cl(); out.push('<p>' + inline(t) + '</p>');
  }
  cl();
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
  <p class="brand-line">SAAX Protocol \u2014 Solvent Applied Autonomous Exchange Protocol</p>
  <div class="links">
    <a href="/spec">Spec</a><a href="/docs">Docs</a><a href="/blog">Blog</a>
    <a href="/terms">Terms</a><a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/disputes">Disputes</a>
  </div>
  <p class="copy">\u00a9 2026 SAAX Protocol. All rights reserved.</p>
</div></footer>`;

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
  .muted{color:var(--muted);}
  .post-list{list-style:none;}
  .post-list li{padding:.9rem 0;border-bottom:1px solid var(--border);}
  .post-list a{font-size:1.05rem;font-weight:600;}
  .post-list .date{color:var(--muted);font-size:.9rem;margin-left:.6rem;}
  footer{border-top:1px solid var(--border);padding:2rem 0 3rem;}
  footer .brand-line{font-weight:700;margin-bottom:.8rem;}
  footer .links{display:flex;flex-wrap:wrap;gap:1.2rem;margin-bottom:1rem;}
  footer .links a{color:var(--muted);font-size:.9rem;}
  footer .copy{color:var(--muted);font-size:.82rem;}`;

const ld = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: title,
  description: desc,
  url: 'https://saax-protocol.com/blog/' + slug,
  mainEntityOfPage: 'https://saax-protocol.com/blog/' + slug,
  datePublished: '2026-11-06',
  dateModified: '2026-11-06',
  author: { '@type': 'Organization', name: 'SAAX Protocol', url: 'https://saax-protocol.com' },
  publisher: {
    '@type': 'Organization', name: 'SAAX Protocol', url: 'https://saax-protocol.com',
    logo: { '@type': 'ImageObject', url: 'https://saax-protocol.com/assets/logo-full-light.png' }
  }
};

// Extract body after front matter (skip md H1, italic date lines, ---).
const mdLines = fs.readFileSync(path.join(BLOG, slug + '.md'), 'utf8').split(/\r?\n/);
let bodyMd = '', started = false;
for (const l of mdLines) {
  const t = l.replace(/\r$/, '').trim();
  if (!started) {
    if (/^# /.test(t)) continue;
    if (/^\*[A-Z][a-z]+ \d/.test(t)) continue;
    if (/^Last updated/.test(t)) continue;
    if (t === '---') { started = true; continue; }
    continue;
  }
  bodyMd += l.replace(/\r$/, '') + '\n';
}
const body = renderBody(bodyMd.trim());
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | SAAX Protocol</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="https://saax-protocol.com/blog/${slug}">
<meta property="og:title" content="${title} | SAAX Protocol">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="https://saax-protocol.com/blog/${slug}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="SAAX Protocol">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title} | SAAX Protocol">
<meta name="twitter:description" content="${desc}">
<style>
${CSS}
</style>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>
${NAV}
<main><div class="container">
<article>
<h1>${title}</h1>
<p class="post-byline">${byline}</p>
<p class="post-date"><em>${date}</em></p>
<hr>
${body}
</article>
</div></main>
${FOOTER}
</body>
</html>
`;
fs.writeFileSync(path.join(BLOG, slug + '.html'), html);
console.log('html written', html.length, 'bytes');
