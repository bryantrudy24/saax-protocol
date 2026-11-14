// Gate I — SEO/indexing diagnostics (read-only)
const https = require('https');
function get(url) {
  return new Promise((res, rej) => https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res({ status: r.statusCode, body: d }));
  }).on('error', rej));
}
(async () => {
  const pages = ['/', '/recovery', '/security', '/docs', '/blog/what-is-agentic-commerce', '/blog/how-ai-agents-buy-things-guide-agentic-commerce', '/blog/agentic-commerce-market-size-2026-forecasts'];
  for (const p of pages) {
    const r = await get('https://saax-protocol.com' + p);
    const canon = (r.body.match(/rel="canonical" href="([^"]+)/) || [])[1] || 'none';
    const robots = (r.body.match(/name="robots" content="([^"]+)/) || [])[1] || 'all';
    const title = (r.body.match(/<title>([^<]+)/) || [])[1] || '';
    const jl = (r.body.match(/application\/ld\+json/g) || []).length;
    const og = (r.body.match(/property="og:title" content="([^"]+)/) || [])[1] || '';
    console.log(JSON.stringify({ p, status: r.status, title: title.slice(0, 60), canon: canon.slice(0, 80), robots, jsonld: jl, og: og.slice(0, 50) }));
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
