#!/usr/bin/env node
// Rebuild landing/llms-full.txt from the current committed pages.
// Converts each page's HTML to readable text, preserving the Source: section structure.
const fs = require('fs');
const path = require('path');

const PAGES = [
  { src: 'landing/status.html', url: 'https://saax-protocol.com/status' },
  { src: 'landing/docs.html', url: 'https://saax-protocol.com/docs' },
  { src: 'landing/protocol.html', url: 'https://saax-protocol.com/protocol' },
  { src: 'landing/spec.html', url: 'https://saax-protocol.com/spec' },
  { src: 'landing/security.html', url: 'https://saax-protocol.com/security' },
  { src: 'landing/disputes.html', url: 'https://saax-protocol.com/disputes' },
];

// blog articles (all except index; index is added separately at the end)
const blogFiles = fs.readdirSync('landing/blog').filter((f) => f.endsWith('.html') && f !== 'index.html');
const BLOGS = blogFiles.map((f) => ({
  src: 'landing/blog/' + f,
  url: 'https://saax-protocol.com/blog/' + f.replace('.html', ''),
}));

function strip(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function htmlToText(html) {
  let t = html;
  // pull out title
  const titleMatch = t.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/\s*\|\s*SAAX Protocol.*$/, '').trim() : '';
  // head/nav/footer removal
  t = t.replace(/<head[\s\S]*?<\/head>/i, '');
  t = t.replace(/<header[\s\S]*?<\/header>/i, '');
  t = t.replace(/<footer[\s\S]*?<\/footer>/i, '');
  t = t.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
  // headings
  t = t.replace(/<h1[^>]*>(.*?)<\/h1>/gi, (m, c) => '# ' + strip(c).trim() + '\n\n');
  t = t.replace(/<h2[^>]*>(.*?)<\/h2>/gi, (m, c) => '## ' + strip(c).trim() + '\n\n');
  t = t.replace(/<h3[^>]*>(.*?)<\/h3>/gi, (m, c) => '### ' + strip(c).trim() + '\n\n');
  // tables
  t = t.replace(/<table[\s\S]*?<\/table>/gi, (m) => {
    const rows = [...m.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => {
      const cells = [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => strip(c[1]).trim());
      return '| ' + cells.join(' | ') + ' |';
    });
    return rows.join('\n') + '\n\n';
  });
  // lists
  t = t.replace(/<li[^>]*>(.*?)<\/li>/gi, (m, c) => '- ' + strip(c).trim() + '\n');
  // code blocks
  t = t.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => '```\n' + strip(c).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&') + '\n```\n\n');
  // paragraphs / divs / blockquotes
  t = t.replace(/<(p|div|blockquote|section|article|main)[^>]*>/gi, '\n');
  t = t.replace(/<\/(p|div|blockquote|section|article|main|ul|ol|table|tr|tbody|thead)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (m, h, c) => strip(c).trim() + ' (' + h + ')');
  t = t.replace(/<(code|strong|b|em|i|span)[^>]*>(.*?)<\/\1>/gi, (m, tag, c) => strip(c).trim());
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&hellip;/g, '...').replace(/&nbsp;/g, ' ');
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\r?\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  t = t.split('\n').map((l) => l.trimEnd()).join('\n').trim();
  return { title, text: t };
}

let out = '# SAAX Protocol - full documentation\n\nVerified current snapshot: 2026-11-08. Public specification and component-specific implementation status. Internal tests are not an audit.\n\n';

for (const pg of PAGES) {
  const html = fs.readFileSync(pg.src, 'utf8');
  const { text } = htmlToText(html);
  out += '\n---\n\nSource: ' + pg.url + '\n\n' + text + '\n';
}
// blog index
{
  const html = fs.readFileSync('landing/blog/index.html', 'utf8');
  const { text } = htmlToText(html);
  out += '\n---\n\nSource: https://saax-protocol.com/blog\n\n' + text + '\n';
}
for (const b of BLOGS.sort()) {
  const html = fs.readFileSync(b.src, 'utf8');
  const { text } = htmlToText(html);
  out += '\n---\n\nSource: ' + b.url + '\n\n' + text + '\n';
}

fs.writeFileSync('landing/llms-full.txt', out);
console.log('llms-full.txt rebuilt:', out.length, 'bytes;', PAGES.length + 1 + BLOGS.length, 'sections');
