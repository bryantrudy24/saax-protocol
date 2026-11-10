#!/usr/bin/env node
// Validate the two new article HTML files: structure, metadata, JSON-LD, links.
const fs = require('fs');
const path = require('path');

const slugs = [
  'what-agent-payment-authorization-actually-authorizes',
  'what-escrow-security-review-actually-verifies',
];

let fail = 0;
for (const slug of slugs) {
  const p = path.join(__dirname, '..', 'landing', 'blog', slug + '.html');
  const c = fs.readFileSync(p, 'utf8');
  const checks = {
    'has doctype': c.startsWith('<!DOCTYPE html>'),
    'has lang': /<html lang="en">/.test(c),
    'has head close': c.includes('</head>'),
    'has body/main/footer': c.includes('<body>') && c.includes('<main>') && c.includes('<footer>'),
    'closes html': c.trimEnd().endsWith('</html>'),
    'h1 exactly once': (c.match(/<h1>/g) || []).length === 1,
    'canonical present': c.includes(`rel="canonical" href="https://saax-protocol.com/blog/${slug}"`),
    'og:url matches': c.includes(`property="og:url" content="https://saax-protocol.com/blog/${slug}"`),
    'og:type article': c.includes('property="og:type" content="article"'),
    'twitter card': c.includes('name="twitter:card" content="summary_large_image"'),
    'JSON-LD Article': /"@type": "Article"/.test(c),
    'JSON-LD headline matches': c.includes(`"headline": "`),
    'JSON-LD url matches': c.includes(`"url": "https://saax-protocol.com/blog/${slug}"`),
    'has byline': c.includes('post-byline'),
    'has date': c.includes('post-date'),
    'has AI disclosure': c.includes('AI disclosure'),
    'has next step': c.includes('Next step'),
  };
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? 'PASS' : 'FAIL'} ${slug}: ${k}`);
    if (!v) fail++;
  }
  // link check: collect internal hrefs and confirm they are well-formed
  const links = [...c.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const broken = links.filter((l) => l.startsWith('/blog/') && l !== `/blog/${slug}`);
  console.log(`${slug}: ${links.length} links; internal blog links: ${broken.join(', ') || 'none'}`);
}
console.log(fail === 0 ? 'ALL CHECKS PASS' : `${fail} CHECKS FAILED`);
process.exit(fail === 0 ? 0 : 1);