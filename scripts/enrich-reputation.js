// SAAX Protocol — Day 2: Reputation Fetch Layer
//
// Reads the authoritative agent-id list from data/agent-ids-day2.json (exported
// from saax_router.agents), then for each id fetches live reputation from the
// ERC-8004 ReputationRegistry on Base mainnet.
//
// Flow per agent:
//   1. getClients(agentId)                    -> live client addresses
//   2. if clients > 0:
//        getSummary(agentId, [...clients], '', '')  -> (count, summaryValue, valueDecimals)
//      avgX100 = summaryValue / 10^valueDecimals
//   3. null reputation where no clients (contract reverts on empty list: v2.0.0)
//
// Emits data/reputation-day2.json + data/upsert-reputation.sql for the connector.
// READ-ONLY on-chain. No wallet. No settlement.
const { JsonRpcProvider, Contract } = require('ethers');
const fs = require('fs');

const RPC = process.env.SAAX_RPC_URL || 'https://base-rpc.publicnode.com';
const REPUTATION_REGISTRY = process.env.SAAX_REPUTATION_REGISTRY || '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

function log(...a) { console.log(...a); }

async function probeAgent(rep, id, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const clients = await rep.getClients(id);
      if (clients.length === 0) {
        return { agent_id: id, clients: 0, count: 0, avgX100: null, decimals: null, found: true };
      }
      const [count, summaryValue, valueDecimals] = await rep.getSummary(id, [...clients], '', '');
      const norm = Number(summaryValue) / Math.pow(10, Number(valueDecimals));
      const avgX100 = Math.round(norm * 100) / 100;
      return { agent_id: id, clients: clients.length, count: Number(count), avgX100, decimals: Number(valueDecimals), summaryValue: String(summaryValue), found: true };
    } catch (e) {
      const msg = String(e);
      // Deployed v2.0.0 contract reverts (selector 0x42dd519c, "missing revert data")
      // when an agent has NO feedback clients. That is the same state as a clean
      // empty client list: score NULL, count 0. Treat as zero-clients, not error.
      if (msg.includes('missing revert data') || msg.includes('clientAddresses required')) {
        return { agent_id: id, clients: 0, count: 0, avgX100: null, decimals: null, found: true };
      }
      if (attempt < retries) {
        const wait = 300 * attempt;
        log(`  retry ${id} attempt ${attempt}: ${msg.slice(0, 100)} (wait ${wait}ms)`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        return { agent_id: id, found: false, reason: msg.slice(0, 140) };
      }
    }
  }
}

async function main() {
  log('SAAX Protocol — Day 2 Reputation Fetch Layer');
  log(`RPC: ${RPC}`);
  log(`ReputationRegistry: ${REPUTATION_REGISTRY}`);

  const provider = new JsonRpcProvider(RPC);
  const abi = JSON.parse(fs.readFileSync(__dirname + '/../abis/ReputationRegistry.json', 'utf8'));
  const rep = new Contract(REPUTATION_REGISTRY, abi, provider);

  const ids = JSON.parse(fs.readFileSync(__dirname + '/../data/agent-ids-day2.json', 'utf8'));
  log(`Agent ids to probe: ${ids.length}`);

  const enriched = [];
  for (let i = 0; i < ids.length; i++) {
    const id = Number(ids[i]);
    const r = await probeAgent(rep, id);
    enriched.push(r);
    const star = r.avgX100 !== null ? `⭐ ${r.avgX100}` : (r.found ? '0 clients' : 'not found');
    log(`[${i + 1}/${ids.length}] agent ${id}: ${star}`);
    if ((i + 1) % 15 === 0) await new Promise(r2 => setTimeout(r2, 200));
  }

  const withRep = enriched.filter(r => r.avgX100 !== null);
  const zeroClients = enriched.filter(r => r.found && r.count === 0);
  const notFound = enriched.filter(r => !r.found);
  log('');
  log(`TOTAL ${enriched.length}: with-reputation=${withRep.length} | zero-feedback=${zeroClients.length} | not-found=${notFound.length}`);

  fs.writeFileSync(__dirname + '/../data/reputation-day2.json', JSON.stringify(enriched, null, 2));

  const rows = enriched.filter(r => r.found).map(r => {
    const score = r.avgX100 === null ? 'NULL' : String(r.avgX100);
    const cnt = String(r.count);
    const ts = r.count > 0 ? 'now()' : 'NULL';
    return `(${r.agent_id}, ${score}, ${cnt}, ${ts})`;
  }).join(',\n');
  const sql = `-- SAAX Protocol Day 2 reputation enrichment (generated)\nUPDATE saax_router.agents AS a\nSET reputation_score = v.score,\n    feedback_count = v.cnt,\n    last_feedback_timestamp = CASE WHEN v.cnt > 0 THEN now() ELSE NULL END\nFROM (VALUES\n${rows}\n) AS v(agent_id, score, cnt, ts)\nWHERE a.agent_id = v.agent_id;\n`;
  fs.writeFileSync(__dirname + '/../data/upsert-reputation.sql', sql);
  log(`Wrote upsert-reputation.sql (${rows.length} rows)`);
  log('DONE');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });