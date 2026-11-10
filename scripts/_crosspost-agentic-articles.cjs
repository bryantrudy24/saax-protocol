#!/usr/bin/env node
// Cross-post the four new SAAX articles to Dev.to with canonical URLs.
// Usage: node scripts/_crosspost-agentic-articles.cjs
// Requires DEVTO_API_KEY env var.
const fs = require('fs');
const path = require('path');

const ARTICLES = [
  {
    slug: 'agentic-commerce-protocols-verified-map-2026',
    title: 'Agentic Commerce Protocols in November 2026: A Verified Map of ACP, AP2, UCP, x402, MCP, A2A - and Where a Commitment Layer Fits',
    description: 'A primary-source map of ACP, AP2, UCP, x402, MCP, and A2A as of November 2026, and where a durable commitment layer fits around them.',
    tags: ['webdev', 'ai', 'blockchain', 'security'],
    canonical: 'https://saax-protocol.com/blog/agentic-commerce-protocols-verified-map-2026',
  },
  {
    slug: 'after-ai-agent-pays-x402-stablecoins-saax',
    title: 'What Happens After an AI Agent Pays? x402, Stablecoins, Settlement Evidence, and SAAX',
    description: 'x402 and stablecoin settlement prove value moved - not that work was delivered. How durable commitments, idempotency, and reconciliation make agent payments recoverable.',
    tags: ['webdev', 'ai', 'blockchain', 'security'],
    canonical: 'https://saax-protocol.com/blog/after-ai-agent-pays-x402-stablecoins-saax',
  },
  {
    slug: 'google-ap2-authorization-vs-durable-commitments',
    title: 'Google AP2 and SAAX: Authorization Evidence vs Durable Commitments',
    description: 'AP2 answers "was this agent permitted to pay?" SAAX answers "what was the money for, and what happens when the deal goes wrong?" How the two layers complement each other.',
    tags: ['webdev', 'ai', 'blockchain', 'security'],
    canonical: 'https://saax-protocol.com/blog/google-ap2-authorization-vs-durable-commitments',
  },
  {
    slug: 'building-reliable-agentic-commerce-mcp-a2a-ucp-saax',
    title: 'Building Reliable Agentic Commerce with MCP, A2A, UCP, and SAAX',
    description: 'MCP connects agents to tools, A2A connects agents to agents, UCP navigates commerce. A reference architecture for the durable commitment layer that makes it all recoverable.',
    tags: ['webdev', 'ai', 'blockchain', 'security'],
    canonical: 'https://saax-protocol.com/blog/building-reliable-agentic-commerce-mcp-a2a-ucp-saax',
  },
];

function asciiSafe(s) {
  return s
    .replace(/\u2014/g, '--')  // em dash
    .replace(/\u2013/g, '-')   // en dash
    .replace(/\u2192/g, '->')  // arrow
    .replace(/\u2260/g, '!=')  // not equal
    .replace(/\u00b7/g, '-')   // middle dot
    .replace(/\u2026/g, '...') // ellipsis
    .replace(/\u2018|\u2019/g, "'") // quotes
    .replace(/\u201c|\u201d/g, '"');
}

function stripFrontMatter(md) {
  const lines = md.split('\n');
  let out = [];
  let seenSep = false;
  for (const ln of lines) {
    if (!seenSep) {
      if (/^# /.test(ln)) continue;
      if (/^\*/.test(ln)) continue;
      if (/^---\s*$/.test(ln)) { seenSep = true; continue; }
      continue;
    }
    out.push(ln);
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

(async () => {
  const key = process.env.DEVTO_API_KEY;
  if (!key) { console.error('DEVTO_API_KEY not set'); process.exit(1); }
  for (const a of ARTICLES) {
    const mdPath = path.join(__dirname, '..', 'landing', 'blog', a.slug + '.md');
    const body = asciiSafe(stripFrontMatter(fs.readFileSync(mdPath, 'utf8')));
    const attribution = `*Originally published on the [SAAX Protocol website](${a.canonical}). Developed with AI assistance and reviewed by the SAAX team. Claims about external protocols are sourced from official documentation linked in the article; SAAX status claims reflect the published [status page](https://saax-protocol.com/status). Nothing here is an independent audit, certification, or production-custody approval.*\n\n---\n\n`;
    const payload = {
      article: {
        title: a.title,
        published: true,
        body_markdown: attribution + body,
        tags: a.tags,
        canonical_url: a.canonical,
        description: a.description,
      },
    };
    let done = false;
    for (let attempt = 1; attempt <= 5 && !done; attempt++) {
      try {
        const resp = await fetch('https://dev.to/api/articles', {
          method: 'POST',
          headers: { 'api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const txt = await resp.text();
        if (resp.ok) {
          const j = JSON.parse(txt);
          console.log('PUBLISHED', a.slug, '->', j.url, '| id', j.id, '| canonical', j.canonical_url);
          done = true;
        } else {
          console.log('FAIL', a.slug, resp.status, txt.slice(0, 200));
          if (resp.status === 429) await new Promise((r) => setTimeout(r, 65000));
          else await new Promise((r) => setTimeout(r, 8000));
        }
      } catch (e) {
        console.log('ERR', a.slug, e.message);
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
    if (!done) console.log('GIVEUP', a.slug);
    await new Promise((r) => setTimeout(r, 20000));
  }
})();
