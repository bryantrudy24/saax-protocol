// SAAX Protocol — Day 1: Emit batched upsert SQL files (60 rows each) for committed execution
const fs = require('fs');

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

const HEADER = `-- SAAX Protocol Day 1: upsert agents cache (batch)\ninsert into saax_router.agents\n  (agent_id, name, description, services, supported_trust, active, owner, token_uri, block_number, last_indexed)\nvalues\n`;
const TAIL = `\non conflict (agent_id) do update set\n  name = excluded.name, description = excluded.description,\n  services = excluded.services, supported_trust = excluded.supported_trust,\n  active = excluded.active, owner = excluded.owner, token_uri = excluded.token_uri,\n  block_number = excluded.block_number, last_indexed = excluded.last_indexed;\n`;

const BATCH = 60;
let n = 0;
for (let i = 0; i < agents.length; i += BATCH) {
  const chunk = agents.slice(i, i + BATCH);
  const sql = HEADER + chunk.map(rowSql).join(',\n') + TAIL;
  const f = __dirname + `/../data/upsert-batch-${n}.sql`;
  fs.writeFileSync(f, sql);
  console.log(`wrote ${f} (${chunk.length} rows)`);
  n++;
}
console.log(`total batches: ${n}`);