// SAAX Phase F3A — Reproducible build for SAAXEscrowCustodyV3 (PRE-AUDIT CANDIDATE).
// LOCAL ONLY. Pins solc 0.8.26+commit.8a97fa7a from node_modules (lockfile-pinned),
// optimizer runs=200, viaIR, evmVersion paris — matching hardhat.config.js —
// and records source/build/runtime hashes + metadata in
// artifacts/f3a/v3-build-manifest.json. The build is deterministically
// reproducible: same pinned compiler + settings + sources produce the same
// artifact hashes.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'f3a');

function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function sha256File(p) { return sha256(fs.readFileSync(p)); }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const solc = require('solc');
  const longVersion = solc.version();
  if (!longVersion.startsWith('0.8.26+commit.8a97fa7a')) throw new Error('unexpected solc version: ' + longVersion);

  const src = fs.readFileSync(path.join(ROOT, 'contracts/SAAXEscrowCustodyV3.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'contracts/SAAXEscrowCustodyV3.sol': { content: src } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.bytecode.sourceMap', 'evm.deployedBytecode.sourceMap'] } },
    },
  };
  const raw = JSON.stringify(input);
  const out = JSON.parse(solc.compile(raw));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error('compile errors:\n' + errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['contracts/SAAXEscrowCustodyV3.sol']['SAAXEscrowCustodyV3'];
  const srcHash = sha256(Buffer.from(src, 'utf8'));
  const bytecode = '0x' + c.evm.bytecode.object;
  const runtime = '0x' + c.evm.deployedBytecode.object;
  const creationHash = sha256(Buffer.from(bytecode.slice(2), 'hex'));
  const runtimeHash = sha256(Buffer.from(runtime.slice(2), 'hex'));

  const manifest = {
    artifact: 'SAAXEscrowCustodyV3',
    candidateLabel: 'pre-audit-candidate',
    custodyVersion: 3,
    solc: { version: '0.8.26', longVersion },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris' },
    dependencies: {
      '@safe-global/safe-contracts': require(path.join(ROOT, 'node_modules/@safe-global/safe-contracts/package.json')).version,
      'ethers': require(path.join(ROOT, 'node_modules/ethers/package.json')).version,
    },
    hashes: {
      sourceSha256: srcHash,
      creationBytecodeSha256: creationHash,
      runtimeBytecodeSha256: runtimeHash,
      inputJsonSha256: sha256(Buffer.from(raw, 'utf8')),
    },
    sizes: {
      creationHexLen: bytecode.length,
      runtimeHexLen: runtime.length,
    },
    compilerInput: raw,
    timestamp: new Date().toISOString(),
    provenance: {
      builtFrom: 'contracts/SAAXEscrowCustodyV3.sol',
      spec: 'mainnet/f3a-custody-v3-spec.md',
      baseline: 'f3e90663',
      localOnly: true,
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'v3-build-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'V3-creation.bytecode'), bytecode);
  fs.writeFileSync(path.join(OUT_DIR, 'V3-runtime.bytecode'), runtime);
  fs.writeFileSync(path.join(OUT_DIR, 'V3.abi.json'), JSON.stringify(c.abi, null, 2));
  console.log('v3-build-ok');
  console.log('  sourceSha256        ' + srcHash);
  console.log('  creationBytecode256 ' + creationHash);
  console.log('  runtimeBytecode256  ' + runtimeHash);
  console.log('  manifest            artifacts/f3a/v3-build-manifest.json');
})().catch((e) => { console.error('FATAL: ' + (e && e.stack ? e.stack : e)); process.exit(1); });