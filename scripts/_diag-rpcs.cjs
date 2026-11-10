// Cross-RPC Base Sepolia balance verification — Day 19d
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createPublicClient, http } = require('viem');
const { baseSepolia } = require('viem/chains');

const addrs = ['0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70', '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13'];
const rpcs = [
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.drpc.org',
  'https://base-sepolia.blockpi.network/v1/rpc/public',
];

(async () => {
  for (const rpc of rpcs) {
    try {
      const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc, { timeout: 7000 }) });
      const cid = Number(await pub.getChainId());
      const bn = await pub.getBlockNumber();
      const se = Number(await pub.getBalance({ address: addrs[0] })) / 1e18;
      const be = Number(await pub.getBalance({ address: addrs[1] })) / 1e18;
      console.log(rpc, '| cid', cid, '| block', String(bn), '| signer', se.toFixed(6), '| buyer', be.toFixed(6));
    } catch (e) { console.log(rpc, 'ERR', String(e.message || e).slice(0, 50)); }
  }
  console.log('done');
})().catch((e) => { console.error('FATAL', String(e.message || e).slice(0, 120)); process.exit(1); });