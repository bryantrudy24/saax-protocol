// SAAX — mainnet balance check (buyer USDC, vault USDC, signer ETH)
const { createPublicClient, http } = require('viem');
const c = createPublicClient({ transport: http('https://mainnet.base.org') });
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
(async () => {
  for (const [lbl, addr] of [['BUYER', '0x8DB70f40A7Aa4563FaB645cf325F55934EEad07a'], ['VAULT', '0xAF94b0d2a936C0683c870aB146979F7ebA46A49f'], ['SIGNER', '0xea1d6ddf708b6cc91886b7f00380d7fe1e13a63a']]) {
    const bal = await c.readContract({ address: USDC, abi, functionName: 'balanceOf', args: [addr] });
    console.log(lbl, 'USDC:', Number(bal) / 1e6);
  }
  const eth = await c.getBalance({ address: '0xea1d6ddf708b6cc91886b7f00380d7fe1e13a63a' });
  console.log('SIGNER ETH:', Number(eth) / 1e18);
})();