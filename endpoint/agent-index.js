// SAAX Protocol — Day 6: Agent index used by the feedback gate.
//
// isKnownAgent(agentId) is the Day 1-3 index the feedback path validates against
// BEFORE any transaction is constructed. Unknown agent ids are rejected with an
// explicit error (no silent fallback, no transaction).
//
// Index = union of:
//   - data/agent-ids-day2.json      (119 ids, from the on-chain Identity Registry probe)
//   - endpoint/supplier-registrations.json  (named suppliers registered in the index; includes ids not in the day-2 probe)
//   - data/rankings-day4.json       (candidates ranked by the Day 4 engine; e.g. 2290)
//
// Loading is best-effort per source: a missing file only shrinks the index by
// that source, it never crashes the gate.
const fs = require('fs');
const path = require('path');

function loadJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function buildIndex() {
  const set = new Set();

  // 1. Day 2 on-chain probe ids
  const day2 = loadJson(path.join(__dirname, '..', 'data', 'agent-ids-day2.json'));
  if (Array.isArray(day2)) day2.forEach(id => set.add(Number(id)));

  // 2. Registered suppliers (keys of registrations)
  const regs = loadJson(path.join(__dirname, 'supplier-registrations.json'));
  if (regs && regs.registrations && typeof regs.registrations === 'object') {
    Object.keys(regs.registrations).forEach(k => set.add(Number(k)));
  }

  // 3. Day 4 ranked candidates
  const r4 = loadJson(path.join(__dirname, '..', 'data', 'rankings-day4.json'));
  if (r4 && r4.result && Array.isArray(r4.result.candidates)) {
    r4.result.candidates.forEach(c => { if (c && c.agent_id !== undefined) set.add(Number(c.agent_id)); });
  }

  return set;
}

const KNOWN_AGENT_IDS = buildIndex();

function isKnownAgent(agentId) {
  return KNOWN_AGENT_IDS.has(Number(agentId));
}

module.exports = { isKnownAgent, KNOWN_AGENT_IDS };