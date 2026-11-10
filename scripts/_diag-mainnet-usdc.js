// SAAX Protocol — diagnostic: inspect mainnet USDC bytecode for EIP-3009 support
// Read-only. No tx, no funds. Checks proxy pattern + selector presence.
const { createPublicClient, http } = require('viem');
const c = createPublicClient({ transport: http('https://mainnet.base.org') });
(async () => {
  const addr = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const code = await c.getCode({ address: addr });
  const hex = code ? code : '0x';
  console.log('code bytes:', (hex.length - 2) / 2);
  console.log('head:', hex.slice(0, 140));
  console.log('tail:', hex.slice(-140));
  const sel = 'e3ee160e';
  console.log('selector ' + sel + ' in full code:', hex.toLowerCase().includes(sel));
  try {
    const impl = await c.readContract({ address: addr, abi: [{ name: 'implementation', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }], functionName: 'implementation' });
    console.log('implementation():', impl);
  } catch (e) { console.log('implementation() call failed:', String(e.message || e).slice(0, 160)); }
})();