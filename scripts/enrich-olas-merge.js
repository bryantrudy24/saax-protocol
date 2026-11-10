// SAAX Protocol — Day 1: Enrich ALL Olas marketplace registrations (distinct named agents)
// Merge with the curated set to reach 50+ quality agents.
const fs = require('fs');
const regs = JSON.parse(fs.readFileSync(__dirname + '/../data/enriched-registrations.json', 'utf8'));
const curated = JSON.parse(fs.readFileSync(__dirname + '/../data/agents-day1-curated.json', 'utf8'));

const olas = regs.filter(r => r.agentURI && String(r.agentURI).includes('olas.network'));
console.log(`olas registrations: ${olas.length}`);

const cache = new Map();
async function resolveUri(uri) {
  if (cache.has(uri)) return cache.get(uri);
  let doc = null;
  try {
    const r = await fetch(uri);
    if (r.ok) { const t = await r.text(); try { doc = JSON.parse(t); } catch {} }
  } catch {}
  cache.set(uri, doc);
  return doc;
}

async function main() {
  const out = [];
  for (let i = 0; i < olas.length; i += 8) {
    const chunk = olas.slice(i, i + 8);
    const resolved = await Promise.all(chunk.map(async r => {
      const doc = await resolveUri(r.agentURI);
      return {
        agent_id: r.agentId,
        owner: r.owner,
        token_uri: String(r.agentURI).slice(0, 300),
        name: doc && doc.name ? String(doc.name) : null,
        description: doc && doc.description ? String(doc.description).slice(0, 1000) : null,
        services: doc && doc.services ? doc.services.map(s => ({ name: s.name || null, endpoint: s.endpoint || s.url || null, version: s.version || null })) : [],
        supported_trust: doc && doc.supportedTrust ? doc.supportedTrust : null,
        active: doc ? (doc.active !== false) : true,
        block_number: r.blockNumber,
        last_indexed: new Date().toISOString(),
      };
    }));
    out.push(...resolved);
    if ((i / 8) % 5 === 0) console.log(`resolved ${Math.min(i + 8, olas.length)}/${olas.length}`);
  }

  // Merge: curated first, then olas agents not already present
  const curIds = new Set(curated.map(a => a.agent_id));
  const merged = [...curated];
  for (const a of out) {
    if (!curIds.has(a.agent_id) && a.name) merged.push(a);
  }
  console.log(`merged total: ${merged.length}`);
  fs.writeFileSync(__dirname + '/../data/agents-day1-merged.json', JSON.stringify(merged, null, 2));
  console.log('wrote data/agents-day1-merged.json');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });