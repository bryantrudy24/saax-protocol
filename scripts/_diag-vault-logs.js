// SAAX — enumerate vault USDC receipts (Transfer events to the vault on mainnet)
const { createPublicClient, http } = require('viem');
const c = createPublicClient({ transport: http('https://mainnet.base.org') });
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VAULT = '0xAF94b0d2a936C0683c870aB146979F7ebA46A49f';
const transferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { type: 'address', name: 'from', indexed: true },
      { type: 'address', name: 'to', indexed: true },
      { type: 'uint256', name: 'value', indexed: false },
    ],
  },
];
(async () => {
  const latest = await c.getBlockNumber();
  const from = latest - 20000n > 0n ? latest - 20000n : 0n;
  console.log('scanning blocks', from.toString(), '->', latest.toString());
  const logs = await c.getLogs({ address: USDC, event: transferAbi, args: { to: VAULT }, fromBlock: from, toBlock: latest });
  console.log('Transfer events to vault:', logs.length);
  for (const l of logs) {
    console.log('  tx=' + l.transactionHash + ' block=' + l.blockNumber + ' value=' + (Number(l.args.value) / 1e6) + ' from=' + l.args.from);
  }
})();