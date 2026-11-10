#!/usr/bin/env node
// Validate the Discord-community article HTML: structure, metadata, JSON-LD, links, slotting.
const fs = require('fs');
const path = require('path');
const slug = 'building-reliable-autonomous-commerce';
const p = path.join(__dirname, '..', 'landing', 'blog', slug + '.html');
const c = fs.readFileSync(p, 'utf8');
const checks = {
  'has doctype': c.startsWith('<!DOCTYPE html>'),
  'has lang en': /<html lang="en">/.test(c),
  'h1 exactly once': (c.match(/<h1>/g) || []).length === 1,
  'canonical present': c.includes(`rel="canonical" href="https://saax-protocol.com/blog/${slug}"`),
  'og:url matches': c.includes(`property="og:url" content="https://saax-protocol.com/blog/${slug}"`),
  'og:type article': c.includes('property="og:type" content="article"'),
  'twitter card': c.includes('name="twitter:card" content="summary_large_image"'),
  'JSON-LD Article': /"@type": "Article"/.test(c),
  'JSON-LD url matches': c.includes(`"url": "https://saax-protocol.com/blog/${slug}"`),
  'has byline': c.includes('post-byline'),
  'has date': c.includes('post-date'),
  'has AI disclosure': c.includes('AI disclosure'),
  'has next step': c.includes('Next step'),
  'has discord invite': c.includes('https://discord.gg/HEbPR8NEZ'),
  'no gmail in article': !c.includes('gmail.com'),
  'no noindex': !c.includes('noindex'),
  'no Coinstancy': !c.toLowerCase().includes('coinstancy'),
};
let fail = 0;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? 'PASS' : 'FAIL'} ${k}`);
  if (!v) fail++;
}
const links = [...c.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const broken = links.filter((l) => l.startsWith('/blog/') && l !== `/blog/${slug}`);
console.log(`${slug}: ${links.length} links; internal blog links: ${broken.join(', ') || 'none'}`);
console.log(fail === 0 ? 'ALL CHECKS PASS' : `${fail} CHECKS FAILED`);
process.exit(fail === 0 ? 0 : 1);
