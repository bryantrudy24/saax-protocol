// SAAX Protocol — Day 3: ranker self-test (runs the same loadLocal path the CLI uses)
const r = require('./rank-suppliers.js');
const fs = require('fs');

function loadLocal() {
  const agents = JSON.parse(fs.readFileSync('data/agents-day1-named.json', 'utf8'));
  const rep = JSON.parse(fs.readFileSync('data/reputation-day2.json', 'utf8'));
  const repMap = {};
  for (const x of (Array.isArray(rep) ? rep : Object.values(rep))) repMap[x.agent_id] = x;
  let leaderboard = [];
  try { leaderboard = JSON.parse(fs.readFileSync('data/leaderboard-suppliers-day3.json', 'utf8')); } catch (e) {}
  for (const ag of leaderboard) {
    if (ag.reputation_probe && !repMap[ag.agent_id]) {
      repMap[ag.agent_id] = { agent_id: ag.agent_id, clients: ag.reputation_probe.clients || 0, count: ag.reputation_probe.count || 0, avgX100: ag.reputation_probe.avgX100 };
    }
  }
  return { agents, repMap, leaderboard };
}

const { agents, repMap, leaderboard } = loadLocal();
const ranker = r.buildRanker({ agents, repMap, leaderboard });
const res = ranker('security scan', { topN: 8 });
console.log('candidates:', res.length);
for (const c of res) console.log(c.agent_id, c.name, 'match=' + c.match, 'rep=' + c.reputation_score, 'fb=' + c.feedback_count, 'score=' + c.score);
console.log('---');
// sanity: SYBIL should appear with match>0
const sybil = res.find(c => c.agent_id === 84667);
console.log('SYBIL in top8:', !!sybil);