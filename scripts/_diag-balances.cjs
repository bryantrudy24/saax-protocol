// Read-only balance reconciliation diagnostic — Day 19c
// Checks signer/buyer/prior-wallet on Base Sepolia + mainnet wrong-chain probe.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createPublicClient, http } = require('viem');
const { baseSepolia, base } = require('viem/chains');

const USDC_BS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MIN_ERC20 = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
const addrs = {
  signer: '0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70',
  buyer: '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13',
  other: '0x6e8df1e400b96eaec2615bff91c69563d35709f6',
};

(async () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org', { timeout: 10000 }) });
  const cid = await pub.getChainId();
  console.log('chain', cid);
  for (const [k, a] of Object.entries(addrs)) {
    const eth = Number(await pub.getBalance({ address: a })) / 1e18;
    const nonce = await pub.getTransactionCount({ address: a });
    let usdc = 'n/a';
    try { usdc = Number(await pub.readContract({ address: USDC_BS, abi: MIN_ERC20, functionName: 'balanceOf', args: [a] })) / 1e6; } catch (e) { usdc = 'ERR ' + String(e.message || e).slice(0, 40); }
    console.log(k, a, '| ETH', eth.toFixed(6), '| nonce', nonce, '| USDC', usdc);
  }
  // Wrong-chain probe (mainnet) — read-only
  try {
    const pubMain = createPublicClient({ chain: base, transport: http('https://mainnet.base.org', { timeout: 8000 }) });
    const mcid = await pubMain.getChainId();
    const se = Number(await pubMain.getBalance({ address: addrs.signer })) / 1e18;
    const be = Number(await pubMain.getBalance({ address: addrs.buyer })) / 1e18;
    console.log('mainnet', mcid, '| signer', se.toFixed(6), '| buyer', be.toFixed(6));
  } catch (e) { console.log('mainnet ERR', String(e.message || e).slice(0, 60)); }
  console.log('done');
})().catch((e) => { console.error('FATAL', String(e.message || e).slice(0, 200)); process.exit(1); });