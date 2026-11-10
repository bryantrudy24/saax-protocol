#!/usr/bin/env node
// Validate the four new agentic-commerce articles: structure, metadata, JSON-LD, links.
const fs = require('fs');
const path = require('path');

const slugs = [
  'agentic-commerce-protocols-verified-map-2026',
  'after-ai-agent-pays-x402-stablecoins-saax',
  'google-ap2-authorization-vs-durable-commitments',
  'building-reliable-agentic-commerce-mcp-a2a-ucp-saax',
];

let fail = 0;
for (const slug of slugs) {
  const p = path.join(__dirname, '..', 'landing', 'blog', slug + '.html');
  const c = fs.readFileSync(p, 'utf8');
  const checks = {
    'has doctype': c.startsWith('<!DOCTYPE html>'),
    'has lang': /<html lang="en">/.test(c),
    'h1 exactly once': (c.match(/<h1>/g) || []).length === 1,
    'canonical present': c.includes(`rel="canonical" href="https://saax-protocol.com/blog/${slug}"`),
    'og:url matches': c.includes(`property="og:url" content="https://saax-protocol.com/blog/${slug}"`),
    'og:type article': c.includes('property="og:type" content="article"'),
    'twitter card': c.includes('name="twitter:card" content="summary_large_image"'),
    'JSON-LD Article': /"@type": "Article"/.test(c),
    'JSON-LD headline': c.includes('"headline":'),
    'JSON-LD url matches': c.includes(`"url": "https://saax-protocol.com/blog/${slug}"`),
    'byline': c.includes('post-byline'),
    'date': c.includes('post-date'),
    'AI disclosure': c.includes('AI disclosure'),
    'next step': c.includes('Next step'),
    'no noindex': !c.includes('noindex'),
    'no gmail leakage': !c.includes('reachsaaxprotocol'),
  };
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? 'PASS' : 'FAIL'} ${slug}: ${k}`);
    if (!v) fail++;
  }
  const links = [...c.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const internal = links.filter((l) => l.startsWith('/'));
  console.log(`${slug}: ${links.length} links; internal: ${internal.join(', ')}`);
}

// sitemap check
const sitemap = fs.readFileSync(path.join(__dirname, '..', 'landing', 'sitemap.xml'), 'utf8');
for (const slug of slugs) {
  const ok = sitemap.includes(`https://saax-protocol.com/blog/${slug}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} sitemap includes ${slug}`);
  if (!ok) fail++;
}
const urlCount = (sitemap.match(/<url>/g) || []).length;
console.log(`sitemap URL count: ${urlCount} (expect 34)`);

// blog index check
const idx = fs.readFileSync(path.join(__dirname, '..', 'landing', 'blog', 'index.html'), 'utf8');
for (const slug of slugs) {
  const ok = idx.includes(`/blog/${slug}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} blog index includes ${slug}`);
  if (!ok) fail++;
}

console.log(fail === 0 ? 'ALL CHECKS PASS' : `${fail} CHECKS FAILED`);
process.exit(fail === 0 ? 0 : 1);
