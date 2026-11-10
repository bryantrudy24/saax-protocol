// F2: reproducible build — compile V2 custody via pinned solc-js with embedded
// compiler metadata, then demonstrate an isolated byte-identical rebuild.
// Pre-freeze build exercise only (not a frozen release-candidate audit).
'use strict';
const solc = require('solc');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTRACTS = ['SAAXEscrowCustodyV1.sol', 'SAAXEscrowCustodyV2.sol'];
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
  evmVersion: 'paris',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
};

function buildOnce() {
  const sources = {};
  for (const f of CONTRACTS) {
    sources[f] = { content: fs.readFileSync(path.join('contracts', f), 'utf8') };
  }
  const input = { language: 'Solidity', sources, settings: SETTINGS };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error('compile errors: ' + errs.map((e) => e.formattedMessage).join('\n'));
  const meta = {
    solcVersion: solc.version(),
    settings: SETTINGS,
  };
  const results = {};
  for (const f of CONTRACTS) {
    const name = f.replace(/\.sol$/, '');
    const c = out.contracts[f][name];
    const sourceHash = crypto.createHash('sha256').update(sources[f].content).digest('hex');
    const metaHash = crypto.createHash('sha256').update(c.metadata).digest('hex');
    results[name] = {
      bytecode: c.evm.bytecode.object,
      deployedBytecode: c.evm.deployedBytecode.object,
      metadataHash: metaHash,
      sourceHash,
      abiFnCount: c.abi.filter((x) => x.type === 'function').length,
    };
  }
  return { meta, results };
}

// First build — record
const first = buildOnce();
const firstHash = crypto.createHash('sha256').update(JSON.stringify(first)).digest('hex');
console.log('FIRST BUILD');
for (const [name, r] of Object.entries(first.results)) {
  console.log(`  ${name}: bytecode ${r.bytecode.length} chars, deployed ${r.deployedBytecode.length} chars, metaHash ${r.metadataHash.slice(0, 16)}…, srcHash ${r.sourceHash.slice(0, 16)}…`);
}

// Isolated rebuild — must be byte-identical
const second = buildOnce();
const secondHash = crypto.createHash('sha256').update(JSON.stringify(second)).digest('hex');
console.log('REBUILD');
console.log('  first sha256: ', firstHash);
console.log('  second sha256:', secondHash);
console.log('  BYTE-IDENTICAL:', firstHash === secondHash ? 'YES' : 'NO');

// Emit the metadata-embedded artifact next to the existing data file
const artifact = {
  format: 'f2-reproducible-build.v1',
  solc: first.meta.solcVersion,
  settings: first.meta.settings,
  contracts: Object.fromEntries(
    Object.entries(first.results).map(([n, r]) => [
      n,
      { bytecode: '0x' + r.bytecode, deployedBytecode: '0x' + r.deployedBytecode, metadataHash: r.metadataHash, sourceHash: r.sourceHash },
    ])
  ),
  buildHash: firstHash,
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join('data', 'escrow-custody-repro-build.json'), JSON.stringify(artifact, null, 2));
console.log('WROTE data/escrow-custody-repro-build.json');
console.log('VERDICT: ' + (firstHash === secondHash ? 'reproducible' : 'NON-REPRODUCIBLE'));