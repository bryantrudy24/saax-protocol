// SAAX — Chain-identity two-process check (chain guard + EAS derived chain).
//
// Verifies the pilot-required subset resolution:
//   1. SAAX_NETWORK=local + SAAX_CHAIN_ID=31337: an export/EIP-712 domain
//      claiming 84532 must be REJECTED by the chain guard when the RPC
//      resolves to the local EVM chain (31337).
//   2. SAAX_NETWORK=base-sepolia + SAAX_CHAIN_ID=84532: the same 84532-claimed
//      export must be ACCEPTED past the chain gate against the real Base
//      Sepolia RPC (read-only; the custody read is a getEscrow view call).
//   3. endpoint/eas.js derives its provider chain from the ACTIVE config in
//      both settings (log ACTIVE_CHAIN_ID/ACTIVE_NETWORK, not a constant).
//
// No writes, no deployment, no spend. Local EVM is a stub RPC on 127.0.0.1.
'use strict';
const http = require('http');

const results = [];
let passed = 0, failed = 0;
function record(name, ok, detail) {
  if (ok) { passed++; results.push({ name, ok, detail }); console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; results.push({ name, ok, detail }); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// ---- minimal local EVM stub (answers eth_chainId = 31337; batch-aware,      -
// because ethers v6 sends a batched detection probe on first use) --------------
function startLocalEvm(chainIdHex) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let result;
      try { result = JSON.parse(body); } catch (e) { result = {}; }
      const handle = (item) => {
        const method = item ? item.method : undefined;
        let answer;
        if (method === 'eth_chainId') answer = chainIdHex;
        else if (method === 'eth_getCode') answer = '0x';
        else if (method === 'eth_blockNumber') answer = '0x1';
        else if (method === 'eth_call') answer = '0x0000000000000000000000000000000000000000000000000000000000000000';
        else if (method === 'eth_getBalance') answer = '0x0';
        else if (method === 'eth_getBlockByNumber') answer = { number: '0x1', hash: '0x' + '00'.repeat(32), timestamp: '0x1' };
        else return { jsonrpc: '2.0', id: item ? item.id : null, error: { code: -32601, message: 'method not supported in stub: ' + method } };
        return { jsonrpc: '2.0', id: item ? item.id : null, result: answer };
      };
      const resp = Array.isArray(result) ? result.map(handle) : handle(result);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resp));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function main() {
  // Fixed custody C5 (committed deployment record) and a real resolved escrow.
  const custody = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
  const escrowId = '0xcef2f4533bd90dcc30e78ea3cac4b38ed93b5aa316a2bf5e25e5128529d95e5c'; // C5, refunded 48205662

  // ---- EAS derived-chain check (both settings) -----------------------------
  {
    process.env.SAAX_NETWORK = 'local';
    process.env.SAAX_CHAIN_ID = '31337';
    delete require.cache[require.resolve('../endpoint/eas.js')];
    const easLocal = require('../endpoint/eas.js');
    record('eas.js derives chain from active config (local/31337)',
      easLocal.ACTIVE_CHAIN_ID === 31337 && easLocal.ACTIVE_NETWORK === 'local' && easLocal.CHAIN_ID === 31337,
      'ACTIVE_CHAIN_ID=' + easLocal.ACTIVE_CHAIN_ID + ' ACTIVE_NETWORK=' + easLocal.ACTIVE_NETWORK);
  }
  {
    process.env.SAAX_NETWORK = 'base-sepolia';
    process.env.SAAX_CHAIN_ID = '84532';
    delete require.cache[require.resolve('../endpoint/eas.js')];
    const easSepolia = require('../endpoint/eas.js');
    record('eas.js derives chain from active config (base-sepolia/84532)',
      easSepolia.ACTIVE_CHAIN_ID === 84532 && easSepolia.ACTIVE_NETWORK === 'base-sepolia' && easSepolia.CHAIN_ID === 84532,
      'ACTIVE_CHAIN_ID=' + easSepolia.ACTIVE_CHAIN_ID + ' ACTIVE_NETWORK=' + easSepolia.ACTIVE_NETWORK);
  }

  // ---- Case 1: local EVM (31337) rejects an 84532-claimed export -----------
  {
    process.env.SAAX_NETWORK = 'local';
    process.env.SAAX_CHAIN_ID = '31337';
    delete process.env.SAAX_RPC_URL;
    const evm = await startLocalEvm('0x7a69'); // 31337
    process.env.SAAX_RPC_URL = 'http://127.0.0.1:' + evm.port;
    const escrow = require('../endpoint/escrow.js');
    const out = await escrow.verifyOnChain(escrowId, { custody });
    record('chain guard REJECTS 84532-claimed export on local EVM 31337',
      out.ok === false && String(out.error) === 'UNSUPPORTED_CHAIN' && String(out.reason || '').includes('testnet-only'),
      'error=' + out.error + ' reason=' + (out.reason || ''));
    evm.server.close();
    delete process.env.SAAX_RPC_URL;
  }

  // ---- Case 2: Base Sepolia RPC accepts the same export (read-only) --------
  {
    process.env.SAAX_NETWORK = 'base-sepolia';
    process.env.SAAX_CHAIN_ID = '84532';
    process.env.SAAX_RPC_URL = 'https://sepolia.base.org';
    const escrow = require('../endpoint/escrow.js');
    const out = await escrow.verifyOnChain(escrowId, { custody });
    record('chain guard ACCEPTS 84532-claimed export on Base Sepolia RPC (read-only)',
      out.ok === true && String(out.chainId) === '84532' && out.escrow && String(out.escrow.id) === escrowId,
      'chainId=' + out.chainId + ' state=' + (out.escrow ? out.escrow.state : '?') + ' escrow.ok=' + !!out.escrow);
    delete process.env.SAAX_RPC_URL;
  }

  console.log('----');
  console.log('passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });