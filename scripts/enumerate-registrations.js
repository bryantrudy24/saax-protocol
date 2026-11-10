// SAAX Protocol — Day 1: Enumerate agents via Registered(uint256 agentId, string agentURI, address owner)
// events on the Identity Registry (canonical indexer approach, matching QuickNode Explorer).
// READ-ONLY log query; no wallet, no writes.
const { JsonRpcProvider } = require('ethers');
const fs = require('fs');

const RPC = 'https://mainnet.base.org';
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// Registered(uint256 indexed agentId, string agentURI, address indexed owner)
// keccak of "Registered(uint256,string,address)"
const EVENT_SIG = 'Registered(uint256,string,address)';
const TOPIC0 = '0x' + require('ethers').id(EVENT_SIG).slice(2); // agentId topic
// owner is indexed topic1: keccak("Registered(uint256,string,address)")[1] not needed for filtering

async function main() {
  const provider = new JsonRpcProvider(RPC);

  // 1) Find latest block on the chain so we can walk backward
  const latest = await provider.send('eth_blockNumber', []);
  const latestNum = parseInt(latest, 16);
  console.log('latest block:', latestNum);

  // 2) Query logs for the event signature across a large recent window
  //    (Base has ~2s blocks; scanning 1M blocks covers ~2+ years of history)
  const fromBlock = '0x' + Math.max(0, latestNum - 1_500_000).toString(16);
  const toBlock = '0x' + latestNum;

  const filter = {
    address: REGISTRY,
    topics: [TOPIC0],
    fromBlock,
    toBlock,
  };

  console.log(`querying eth_getLogs ${fromBlock}..${toBlock}`);

  // Base public RPC caps log response size; use small chunks with adaptive halving on 413.
  const seen = new Map(); // agentId -> {agentURI, owner, blockNumber}

  async function queryRange(from, to) {
    const flt = { ...filter, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };
    const logs = await provider.send('eth_getLogs', [flt]);
    return logs || [];
  }

  // walk backward in 4k-block chunks (small enough for the public RPC cap)
  let from = Math.max(0, latestNum - 1_500_000);
  let to = latestNum;
  let size = 4_000;
  let failStreak = 0;

  while (from < to) {
    // query [from, min(from+size-1, to)]
    const hi = Math.min(from + size - 1, to);
    try {
      const logs = await queryRange(from, hi);
      for (const l of logs) {
        const agentId = parseInt(l.topics[1], 16);
        const owner = '0x' + l.topics[2].slice(26);
        const agentURI = l.data ? parseString(l.data) : '';
        if (!seen.has(agentId)) {
          seen.set(agentId, { agentId, agentURI, owner, blockNumber: parseInt(l.blockNumber, 16) });
        }
      }
      if (logs.length) console.log(`[${from}..${hi}] +${logs.length} logs (total ${seen.size})`);
      from = hi + 1;
      failStreak = 0;
      // grow chunk size up to 8k when clean
      size = Math.min(8_000, size + 500);
    } catch (e) {
      failStreak++;
      if (String(e).includes('413') || failStreak > 3) {
        size = Math.max(500, size / 2);
      }
      // skip? no — retry same range with smaller chunk
      size = Math.max(500, Math.floor(size / 2));
      if (size < 600) { from = hi + 1; size = 4_000; } // give up on tiny chunk, move on
    }
  }

  const agents = [...seen.values()].sort((a, b) => a.agentId - b.agentId);
  console.log(`\nTOTAL agents found: ${agents.length}`);
  for (const a of agents) {
    console.log(`[${a.agentId}] block=${a.blockNumber} owner=${a.owner} uri=${String(a.agentURI).slice(0, 60)}`);
  }
  fs.writeFileSync(__dirname + '/../data/enriched-registrations.json', JSON.stringify(agents, null, 2));
  console.log('\nSaved registrations to data/enriched-registrations.json');
}

// decode ABI string from log data (32-byte offset + length + bytes)
function parseString(data) {
  const hex = data.slice(2);
  const offset = parseInt(hex.slice(0, 64), 16);
  const len = parseInt(hex.slice(offset * 2, offset * 2 + 64), 16);
  const start = (offset + 32) * 2;
  const raw = hex.slice(start, start + len * 2);
  let s = '';
  for (let i = 0; i < raw.length; i += 2) {
    const c = parseInt(raw.slice(i, i + 2), 16);
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
  }
  return s;
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });