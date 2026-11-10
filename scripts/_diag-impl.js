// SAAX Protocol — diagnostic: check mainnet USDC IMPLEMENTATION bytecode for EIP-3009
const { createPublicClient, http } = require('viem');
const c = createPublicClient({ transport: http('https://mainnet.base.org') });
(async () => {
  const impl = '0x2Ce6311ddAE708829bc0784C967b7d77D19FD779';
  const code = await c.getCode({ address: impl });
  const hex = code ? code : '0x';
  console.log('implementation code bytes:', (hex.length - 2) / 2);
  console.log('selector e3ee160e in implementation:', hex.toLowerCase().includes('e3ee160e'));
  // Also probe the actual functions via eth_call (read-only): name/version/domain
  for (const [fn, abi] of [
    ['name', [{ name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }]],
    ['version', [{ name: 'version', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }]],
  ]) {
    try {
      const r = await c.readContract({ address: fn === 'name' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', abi, functionName: fn });
      console.log(fn + '():', r);
    } catch (e) { console.log(fn + '() failed:', String(e.message || e).slice(0, 100)); }
  }
})();