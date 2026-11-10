// SAAX Protocol — Day 1: Build the CURATED 50+ quality set for Supabase.
// Excludes bulk test-farm duplicates; prefers distinct named services.
const fs = require('fs');
const agents = JSON.parse(fs.readFileSync(__dirname + '/../data/agents-day1-named.json', 'utf8'));

const isTestFarm = a =>
  a.name === 'My AI Agent' ||
  a.name === 'AI Agent My AI Agent' ||
  /^(AI Agent )?(GENESIS|Codex|MoneyMiner|AlgoWorker|ClearTask|SignalWorker|TaskCraft|CentCraft|WaveChase|Antigravity|OpenCode|Proofline|OneYuan|DollarCraft|MoneyGenerator|IsolatedTask|AIEast|Astra|BuiltBy|ReceiptWorkbench|BoliviaCode|OpportunityLab|EdwardCoding|Nitro|CodexResearch|me356500|ZhaooWork|ExecutiveCouncil|PavilionCoding|ArturGuerra|CarefulWork|ANK Hunter|Lars Verified|ClearTable|IsolatedTask)/.test(a.name);

const quality = agents.filter(a => !isTestFarm(a) && a.description);
console.log(`total named: ${agents.length}, quality (non-farm, described): ${quality.length}`);

// Rank: prefer those with x402 support / agentWallet / real services
const ranked = quality.sort((a, b) => {
  const sa = a.services && a.services.length ? 1 : 0;
  const sb = b.services && b.services.length ? 1 : 0;
  return sb - sa;
});

// Keep at most 2 wild-west farm entries to avoid a homogeneous block
const ww = [], rest = [];
for (const a of ranked) {
  if (String(a.token_uri).includes('wild-west-bots') && ww.length < 10) ww.push(a);
  else if (String(a.token_uri).includes('wild-west-bots')) { /* skip excess */ }
  else rest.push(a);
}
const curated = [...rest, ...ww];
console.log(`curated set: ${curated.length}`);

fs.writeFileSync(__dirname + '/../data/agents-day1-curated.json', JSON.stringify(curated, null, 2));
console.log('wrote data/agents-day1-curated.json');
// Print a preview
for (const a of curated.slice(0, 30)) console.log(`  [${a.agent_id}] ${a.name} :: ${String(a.description).slice(0, 60)}`);