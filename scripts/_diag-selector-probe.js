// SAAX Protocol — definitive EIP-3009 existence check via eth_call selector probe
// Read-only. eth_call with all-zero args: if transferWithAuthorization EXISTS, the
// call reverts with a signature/authorization-specific error (ECDSA/permit/deadline
// etc.). If it does NOT exist, it reverts with 'selector was not recognized' /
// 'function not found' style errors. This distinguishes real callable EIP-3009
// from coincidental selector bytes in code.
const { createPublicClient, http } = require('viem');
(async () => {
  const targets = [
    ['MAINNET', 'https://mainnet.base.org', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    ['SEPOLIA', 'https://sepolia.base.org', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
  ];
  const data = '0xe3ee160e' + '0'.repeat(64 * 9); // 9 zero args
  for (const [label, rpc, addr] of targets) {
    const c = createPublicClient({ transport: http(rpc) });
    try {
      const r = await c.call({ address: addr, data });
      console.log(label, 'call returned data (unexpected):', r.data);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      const selectorNotRecognized = /recognized|not found|unknown function|fallback/i.test(msg) && !/(ECDSA|AUTHORIZATION|INSUFFICIENT|Invalid|expired|deadline|Signature)/i.test(msg);
      console.log(label, 'call reverted:', msg);
      console.log(label, '  => function exists (EIP-3009 callable):', !selectorNotRecognized);
    }
  }
})();