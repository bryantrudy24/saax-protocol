// enumerate-mainnet-settlements.js — authoritative on-chain list of every
// USDC Transfer buyer->vault in the mainnet activation window.
// Read-only: scans Transfer events from the USDC contract on Base mainnet.
const { createPublicClient, http, parseAbiItem } = require('viem');
const { base } = require('viem/chains');

const RPC = process.env.SAAX_RPC_URL || 'https://mainnet.base.org';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BUYER = '0x8DB70f40A7Aa4563FaB645cf325F55934EEad07a';
const VAULT = '0xAF94b0d2a936C0683c870aB146979F7ebA46A49f';

const FROM_BLOCK = 52190000n; // before the first mainnet settlement attempt
const client = createPublicClient({ chain: base, transport: http(RPC) });

(async () => {
  const toBlock = await client.getBlockNumber();
  const logs = [];
  const STEP = 1900n;
  for (let from = FROM_BLOCK; from <= toBlock; from += STEP) {
    let to = from + STEP - 1n;
    if (to > toBlock) to = toBlock;
    let part = [];
    try {
      part = await client.getLogs({
        address: USDC,
        event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
        args: { from: BUYER, to: VAULT },
        fromBlock: from,
        toBlock: to,
      });
    } catch (e) {
      console.error('chunk err', from.toString(), to.toString(), e.message);
    }
    logs.push(...part);
  }
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
  console.log('WINDOW', FROM_BLOCK.toString(), '->', toBlock.toString());
  console.log('COUNT', logs.length);
  for (const l of logs) {
    console.log(`${l.transactionHash} block=${Number(l.blockNumber)} value=${l.args.value}`);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });