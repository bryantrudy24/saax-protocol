// SAAX Protocol — Day 1: Emit small idempotent upsert batch files (20 rows each)
const fs = require('fs');
const BATCH = 20;
const agents = JSON.parse(fs.readFileSync(__dirname + '/../data/agents-day1-named.json', 'utf8'));

const sqlEsc = s => (s || '').replace(/'/g, "''");
const jsonLit = v => (v === null || v === undefined) ? 'NULL' : "'" + sqlEsc(JSON.stringify(v)) + "'::jsonb";
const textLit = v => (v === null || v === undefined) ? 'NULL' : "'" + sqlEsc(String(v)) + "'";
const boolLit = v => v === false ? 'false' : 'true';

const rowSql = a => `(
  ${a.agent_id},
  ${textLit(a.name)},
  ${textLit(a.description)},
  ${jsonLit(a.services)},
  ${jsonLit(a.supported_trust)},
  ${boolLit(a.active)},
  ${textLit(a.owner)},
  ${textLit(a.token_uri)},
  ${a.block_number || 'NULL'},
  ${textLit(a.last_indexed)}
)`;

const HEADER = `insert into saax_router.agents (agent_id, name, description, services, supported_trust, active, owner, token_uri, block_number, last_indexed) values\n`;
const TAIL = `\non conflict (agent_id) do update set name=excluded.name, description=excluded.description, services=excluded.services, supported_trust=excluded.supported_trust, active=excluded.active, owner=excluded.owner, token_uri=excluded.token_uri, block_number=excluded.block_number, last_indexed=excluded.last_indexed;`;

let n = 0;
for (let i = 0; i < agents.length; i += BATCH) {
  const chunk = agents.slice(i, i + BATCH);
  const sql = HEADER + chunk.map(rowSql).join(',\n') + TAIL;
  fs.writeFileSync(__dirname + `/../data/b20-${n}.sql`, sql);
  n++;
}
console.log(`wrote ${n} batches of ${BATCH} rows`);
fs.writeFileSync(__dirname + '/../data/_agent_count.txt', String(agents.length));