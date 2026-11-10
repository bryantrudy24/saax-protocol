// SAAX Protocol — Day 1: Emit COMPACT upsert SQL (1 row per line) in a few chunks
const fs = require('fs');
const agents = JSON.parse(fs.readFileSync(__dirname + '/../data/agents-day1-named.json', 'utf8'));
const esc = s => (s || '').replace(/'/g, "''");
const j = v => (v === null || v === undefined) ? 'NULL' : "'" + esc(JSON.stringify(v)) + "'::jsonb";
const t = v => (v === null || v === undefined) ? 'NULL' : "'" + esc(String(v)) + "'";
const b = v => v === false ? 'false' : 'true';

const row = a => `(${a.agent_id},${t(a.name)},${t(a.description)},${j(a.services)},${j(a.supported_trust)},${b(a.active)},${t(a.owner)},${t(a.token_uri)},${a.block_number || 'NULL'},${t(a.last_indexed)})`;

const TAIL = `\non conflict (agent_id) do update set name=excluded.name, description=excluded.description, services=excluded.services, supported_trust=excluded.supported_trust, active=excluded.active, owner=excluded.owner, token_uri=excluded.token_uri, block_number=excluded.block_number, last_indexed=excluded.last_indexed;`;

const CHUNKS = 4;
const per = Math.ceil(agents.length / CHUNKS);
console.log(`total agents: ${agents.length}, per chunk: ${per}`);
for (let c = 0; c < CHUNKS; c++) {
  const slice = agents.slice(c * per, (c + 1) * per);
  if (!slice.length) break;
  const sql = `insert into saax_router.agents (agent_id, name, description, services, supported_trust, active, owner, token_uri, block_number, last_indexed) values\n${slice.map(row).join(',\n')}${TAIL}`;
  const f = __dirname + `/../data/compact-${c}.sql`;
  fs.writeFileSync(f, sql);
  console.log(`wrote ${f} (${slice.length} rows, ${sql.length} bytes)`);
}