// SAAX Protocol — definitive EIP-3009 existence check, raw JSON-RPC (no viem call() wrapper)
// Sends direct eth_call with transferWithAuthorization selector + 9 zero args.
// Reads the RAW error body: an "execution reverted" with data vs a "-32601/unknown selector" 
// distinguishes callable EIP-3009 from absent function.
const http = require('http');
function rpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, port: u.port || 443 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
(async () => {
  const targets = [
    ['MAINNET', 'https://mainnet.base.org', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    ['SEPOLIA', 'https://sepolia.base.org', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
  ];
  const data = '0xe3ee160e' + '0'.repeat(64 * 9);
  for (const [label, url, addr] of targets) {
    try {
      const r = await rpc(url, 'eth_call', [{ to: addr, data }, 'latest']);
      console.log(label, 'OK (unexpected return):', JSON.stringify(r).slice(0, 200));
    } catch (e) { console.log(label, 'request failed:', String(e.message || e).slice(0, 160)); }
  }
})();