// Regenerate data/escrow-custody-build.json from contracts/SAAXEscrowCustodyV1.sol
// Same compiler settings as the harness (solc 0.8.26, optimizer 200, viaIR).
// The harness + testnet-broadcast deploy THIS artifact, so the bytecode
// references always match the reviewed source.
'use strict';
const solc = require('solc');
const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'contracts', 'SAAXEscrowCustodyV1.sol');
const src = fs.readFileSync(srcPath, 'utf8');
const name = 'SAAXEscrowCustodyV1.sol';
const input = {
  language: 'Solidity',
  sources: { [name]: { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) throw new Error('compile errors:\n' + errs.map((e) => e.formattedMessage).join('\n'));
const c = out.contracts[name]['SAAXEscrowCustodyV1'];
const artifact = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, source: 'contracts/SAAXEscrowCustodyV1.sol', compiledAt: new Date().toISOString() };
const outPath = path.join(__dirname, '..', 'data', 'escrow-custody-build.json');
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log('WROTE', outPath, 'bytecode len', artifact.bytecode.length, 'abi fns', artifact.abi.filter((f) => f.type === 'function').length);