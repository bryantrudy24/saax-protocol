// SAAX Protocol — Day 2: derive TRUE feedback timestamps from NewFeedback events
//
// The operator wants last_feedback_timestamp to reflect when feedback was actually
// submitted on-chain. getSummary gives count/value but not timestamps. The
// ReputationRegistry emits NewFeedback(agentId, clientAddress, feedbackIndex,
// value, valueDecimals, indexedTag1, tag1, tag2, endpoint, feedbackURI,
// feedbackHash) — we scan a window of blocks for those events, match the 5 scored
// agent ids, and read the block timestamp (eth_getBlockByNumber) for each match.
//
// READ-ONLY. No wallet, no writes.
const { JsonRpcProvider } = require('ethers');
const fs = require('fs');

const RPC = process.env.SAAX_RPC_URL || 'https://base-rpc.publicnode.com';
const REPUTATION_REGISTRY = process.env.SAAX_REPUTATION_REGISTRY || '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const TARGET_IDS = new Set([84947, 84978, 84979, 84981, 84982]);
// The registry was deployed at block 41,663,783 on Base; current head ~52M.
const FROM_BLOCK = 41663783;
// Scan in chunks; stop early once all targets seen N times (they have 1 feedback each).
const CHUNK = 20000;

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const chainId = await provider.send('eth_chainId', []);
  console.log('chainId', chainId);
  const head = await provider.send('eth_blockNumber', []);
  console.log('head block', head);

  const topic = '0x' + '0'.repeat(24) + REPUTATION_REGISTRY.toLowerCase().slice(2);
  // NewFeedback topic0 = keccak('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)')
  // computed by ethers id() to avoid guessing
  const { id } = require('ethers');
  const topTopic = id('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)');

  const from = parseInt(head, 16);
  const found = {}; // agentId -> { block, ts }
  let scanned = 0;

  for (let end = from; end > FROM_BLOCK && Object.keys(found).length < TARGET_IDS.size; ) {
    const start = Math.max(end - CHUNK, FROM_BLOCK);
    const fromHex = '0x' + start.toString(16);
    const toHex = '0x' + end.toString(16);
    try {
      const logs = await provider.send('eth_getLogs', [{
        fromBlock: fromHex,
        toBlock: toHex,
        address: REPUTATION_REGISTRY,
        topics: [topTopic],
      }]);
      for (const lg of logs) {
        // topic0 is indexed: first 32 bytes = agentId (256-bit)
        if (!lg.topics || lg.topics.length < 1) continue;
        const agentId = parseInt(lg.topics[0].slice(2, 34), 16);
        if (!TARGET_IDS.has(agentId)) continue;
        const bn = lg.blockNumber;
        // get block timestamp
        const blk = await provider.send('eth_getBlockByNumber', [bn, false]);
        const ts = blk ? Number(blk.timestamp) : null;
        if (!found[agentId]) found[agentId] = { block: parseInt(bn, 16), ts: ts ? new Date(ts * 1000).toISOString() : 'n/a' };
      }
      scanned += end - start;
      console.log(`scanned ${start}..${end} (${scanned} blocks) found=${Object.keys(found).length}`);
      if (Object.keys(found).length >= TARGET_IDS.size) break;
    } catch (e) {
      const msg = String(e);
      if (msg.includes('413') || msg.includes('limit') || msg.includes('too')) {
        // shrink chunk
        console.log('  shrank chunk to', CHUNK / 2);
      } else {
        console.log('scan ERR', msg.slice(0, 140));
      }
    }
    end = start;
    if (end <= FROM_BLOCK) break;
  }

  console.log('\nTRUE FEEDBACK TIMESTAMPS:');
  for (const id of [...TARGET_IDS]) {
    const f = found[id] ? `${found[id].block} @ ${found[id].ts}` : 'NOT FOUND in scan window';
    console.log(`  agent ${id}: ${f}`);
  }
  fs.writeFileSync(__dirname + '/../data/feedback-timestamps.json', JSON.stringify(found, null, 2));
  console.log('saved feedback-timestamps.json');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });