// SAAX — diagnose eth_getTransactionCount against mainnet.base.org
const https = require('https');
function rpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json ' + res.statusCode + ': ' + d.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
(async () => {
  const url = 'https://mainnet.base.org';
  const addr = '0xEa1D6ddF708b6cC91886b7F00380d7Fe1e13a63A';
  for (const tag of ['latest', 'pending']) {
    try {
      const r = await rpc(url, 'eth_getTransactionCount', [addr, tag]);
      console.log(tag, '->', JSON.stringify(r).slice(0, 160));
    } catch (e) { console.log(tag, 'FAILED:', String(e.message || e).slice(0, 200)); }
  }
})();