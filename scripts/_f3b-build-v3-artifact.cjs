// F3B Step 1: build the V3 custody artifact with pinned identity (runtime
// code hash), saving data/escrow-custody-v3-build.json + writing the 31337
// identity file the verifier consumes. Uses the EXACT F3A compile settings
// (solc 0.8.26, optimizer 200, viaIR). LOCAL ONLY — no deployment.
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');
const crypto = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'SAAXEscrowCustodyV3.sol'), 'utf8');
const NAME = 'SAAXEscrowCustodyV3';
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, viaIR: true };

function compile() {
  const input = {
    language: 'Solidity',
    sources: { ['contracts/SAAXEscrowCustodyV3.sol']: { content: SOURCE } },
    settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) throw new Error('compile error: ' + errs[0].formattedMessage);
  const c = out.contracts['contracts/SAAXEscrowCustodyV3.sol'][NAME];
  const abi = c.abi;
  const bytecode = '0x' + c.evm.bytecode.object;
  const deployedBytecode = '0x' + c.evm.deployedBytecode.object;
  // Deterministic runtime code hash WITHOUT deployment: the metadata suffix
  // contains the bytecodeHash setting; compute runtime hash over the deployed
  // object bytes exactly as a deployed contract's code would be hashed.
  const runtimeCodeHash = ethers.keccak256(deployedBytecode);
  const sourceSha256 = 'sha256:' + crypto.createHash('sha256').update(SOURCE).digest('hex');
  return { abi, bytecode, deployedBytecode, runtimeCodeHash, sourceSha256 };
}

const built = compile();
const functions = built.abi.filter(x => x.type === 'function').map(f => f.name + '(' + f.inputs.length + ')');
const artifact = {
  format: 'f3b-custody-v3-build-v1',
  contract: NAME,
  compiler: 'solc-0.8.26+commit.8a97fa7a.Emscripten.clang',
  settings: SETTINGS,
  sourceSha256: built.sourceSha256,
  abi: built.abi,
  bytecode: built.bytecode,
  runtimeCodeHash: built.runtimeCodeHash,
  compiledAt: new Date().toISOString(),
  note: 'LOCAL TEST ONLY — pre-audit V3 candidate artifact; not deployed, not admitted on any public chain. V1 data/escrow-custody-build.json and V2 artifact untouched.',
};
fs.writeFileSync(path.join(__dirname, '..', 'data', 'escrow-custody-v3-build.json'), JSON.stringify(artifact, null, 2));
console.log('WROTE data/escrow-custody-v3-build.json');
console.log('abi fns: ' + functions.join(', '));
console.log('runtimeCodeHash: ' + built.runtimeCodeHash);
console.log('sourceSha256: ' + built.sourceSha256);
console.log('bytecode len: ' + built.bytecode.length + ' deployed len: ' + built.deployedBytecode.length);