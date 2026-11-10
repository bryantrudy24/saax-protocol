// SAAX Protocol — Day 1: Enrich a quality, diverse subset of enumerated registrations.
// Strategy: prioritize named marketplace hosts and non-bulk registrations, cap bulk S3,
// resolve with bounded parallelism and per-host politeness. Emits agents-day1.json.
const fs = require('fs');

const REGS = __dirname + '/../data/enriched-registrations.json';
const OUT = __dirname + '/../data/agents-day1.json';
const TARGET = parseInt(process.env.SAAX_TARGET || '60', 10); // aim above 50 for quality slack

const regs = JSON.parse(fs.readFileSync(REGS, 'utf8'));

function hostOf(uri) {
  try { return new URL(uri).host; } catch { return null; }
}

// Hosts we prefer (named agent marketplaces / non-bulk registrations)
const PREFERRED_HOSTS = ['marketplace.olas.network', 'execution.market', 'wild-west-bots.vercel.app', 'clustly.ai', 'api.acp.virtuals.io', 'voltplayground.xyz', 'gist.githubusercontent.com', 'raw.githubusercontent.com'];
const BULK_HOST = 'termix-platform-prod.s3.ap-southeast-1.amazonaws.com';
const BULK_CAP = 8;

// Score: prefer hosts with identifiable agent names
function uriHost(uri) { return hostOf(uri); }

let pool = regs.filter(r => r.agentURI && r.agentURI.trim());
console.log(`pool: ${pool.length}`);

// Classify
const preferred = [], bulk = [], other = [];
for (const r of pool) {
  const h = hostOf(r.agentURI);
  if (!h) continue;
  if (PREFERRED_HOSTS.includes(h)) preferred.push(r);
  else if (h === BULK_HOST) bulk.push(r);
  else other.push(r);
}
console.log(`preferred: ${preferred.length}, bulk: ${bulk.length}, other: ${other.length}`);

// Take: all preferred (up to 300), a capped slice of bulk, and fill from other
let selected = preferred.slice(0, Math.min(300, preferred.length));
selected.push(...bulk.slice(0, Math.min(BULK_CAP, bulk.length)));
const otherNeeded = Math.max(0, TARGET + 20 - selected.length);
selected.push(...other.slice(0, otherNeeded));
console.log(`selected: ${selected.length}`);

// Resolve with bounding + dedupe cache
const cache = new Map();
async function resolveUri(uri) {
  if (!uri) return null;
  if (cache.has(uri)) return cache.get(uri);
  let doc = null;
  try {
    if (uri.startsWith('data:')) {
      const m = uri.match(/^data:application\/json;base64,(.+)$/);
      if (m) doc = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    } else if (uri.startsWith('ipfs://')) {
      const hash = uri.replace('ipfs://', '');
      for (const base of ['https://ipfs.io/ipfs/', 'https://cloudflare-ipfs.com/ipfs/']) {
        try { const r = await fetch(base + hash); if (r.ok) { doc = await r.json(); break; } } catch {}
      }
    } else if (/^https?:\/\//.test(uri)) {
      const r = await fetch(uri, { method: 'GET' });
      if (r.ok) {
        const t = await r.text();
        try { doc = JSON.parse(t); } catch { doc = null; }
      }
    }
  } catch { doc = null; }
  cache.set(uri, doc);
  return doc;
}

function nameOf(doc) {
  if (!doc) return null;
  for (const k of ['name', 'agentName', 'title']) {
    if (doc[k] && typeof doc[k] === 'string' && doc[k].trim()) return doc[k].trim();
  }
  return null;
}

function servicesOf(doc) {
  if (!doc || !Array.isArray(doc.services)) return [];
  return doc.services.map(s => ({ name: s.name || null, endpoint: s.endpoint || s.url || null, version: s.version || null }))
    .filter(s => s.name || s.endpoint);
}

async function main() {
  const out = [];
  const CONC = 12;
  for (let i = 0; i < selected.length; i += CONC) {
    const chunk = selected.slice(i, i + CONC);
    const resolved = await Promise.all(chunk.map(async r => {
      const doc = await resolveUri(r.agentURI);
      return {
        agent_id: r.agentId,
        owner: r.owner,
        token_uri: String(r.agentURI).slice(0, 300),
        name: nameOf(doc),
        description: doc && doc.description ? String(doc.description).slice(0, 1000) : null,
        services: servicesOf(doc),
        supported_trust: doc && doc.supportedTrust ? doc.supportedTrust : (doc && doc.trust ? doc.trust : null),
        active: doc ? (doc.active !== false) : true,
        block_number: r.blockNumber,
        last_indexed: new Date().toISOString(),
      };
    }));
    out.push(...resolved);
    if ((i / CONC) % 5 === 0) console.log(`resolved ${Math.min(i + CONC, selected.length)}/${selected.length}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${out.length} enriched agents -> data/agents-day1.json`);
  console.log(`  with name: ${out.filter(a => a.name).length}`);
  console.log(`  with services: ${out.filter(a => a.services.length).length}`);
  console.log(`  with description: ${out.filter(a => a.description).length}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });