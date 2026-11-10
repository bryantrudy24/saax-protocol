// SAAX — enumerate vault USDC receipts via raw Transfer event topic
const { createPublicClient, http, keccak256, toHex } = require('viem');
const c = createPublicClient({ transport: http('https://mainnet.base.org') });
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VAULT = '0xAF94b0d2a936C0683c870aB146979F7ebA46A49f';
const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
(async () => {
  const latest = await c.getBlockNumber();
  const from = latest - 500n > 0n ? latest - 500n : 0n;
  console.log('scanning blocks', from.toString(), '->', latest.toString(), 'topic', TRANSFER_TOPIC);
  // topics: [sig, from(indexed), to(indexed)] — filter to=vault (indexed position 2)
  const logs = await c.getLogs({ address: USDC, topics: [TRANSFER_TOPIC, null, VAULT.toLowerCase()], fromBlock: from, toBlock: latest });
  console.log('Transfer events to vault:', logs.length);
  for (const l of logs) {
    const valueHex = l.data;
    const value = BigInt(valueHex) / 1000000n;
    console.log('  tx=' + l.transactionHash + ' block=' + l.blockNumber + ' value=' + value.toString() + ' from=' + ('0x' + (l.topics[1] || '').slice(26)));
  }
})();