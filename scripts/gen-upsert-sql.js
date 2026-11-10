// SAAX Protocol — Day 1: Generate idempotent upsert SQL for Supabase saax_router.agents
// from data/agents-day1.json. Applied via the Supabase connector (no service key needed).
const fs = require('fs');

const agents = JSON.parse(fs.readFileSync(__dirname + '/../data/agents-day1-merged.json', 'utf8'));
const sqlEsc = s => (s || '').replace(/'/g, "''");

function jsonLit(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + sqlEsc(JSON.stringify(v)) + "'::jsonb";
}
function textLit(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + sqlEsc(String(v)) + "'";
}
function boolLit(v) {
  return v === false ? 'false' : 'true';
}

const rows = agents.map(a => `(
  ${a.agent_id},
  ${textLit(a.name)},
  ${textLit(a.description)},
  ${jsonLit(a.services)},
  ${jsonLit(a.supported_trust)},
  ${boolLit(a.active)},
  ${textLit(a.owner)},
  ${textLit(a.token_uri)},
  ${a.block_number ? a.block_number : 'NULL'},
  ${textLit(a.last_indexed)}
)`);

const sql = `-- SAAX Protocol Day 1: upsert agents cache (generated ${new Date().toISOString()})
insert into saax_router.agents
  (agent_id, name, description, services, supported_trust, active, owner, token_uri, block_number, last_indexed)
values
${rows.join(',\n')}
on conflict (agent_id) do update set
  name = excluded.name,
  description = excluded.description,
  services = excluded.services,
  supported_trust = excluded.supported_trust,
  active = excluded.active,
  owner = excluded.owner,
  token_uri = excluded.token_uri,
  block_number = excluded.block_number,
  last_indexed = excluded.last_indexed;

select count(*) as agents_indexed from saax_router.agents;`;

fs.writeFileSync(__dirname + '/../data/upsert-agents.sql', sql);
console.log(`Generated data/upsert-agents.sql with ${agents.length} rows`);