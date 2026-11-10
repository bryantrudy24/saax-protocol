// Loads the SAAX custody ABI from the committed artifacts. Version-aware for
// F3B: when SAAX_CUSTODY_VERSION=3 the V3 candidate artifact
// (data/escrow-custody-v3-build.json) is used; otherwise the legacy V2
// hardhat artifact path is unchanged (byte-preserved behavior).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadCustodyAbi(relativeTo, opts) {
  const repoRoot = path.resolve(__dirname, '..');
  const version = Number((opts && opts.custodyVersion) || process.env.SAAX_CUSTODY_VERSION || 0);
  if (version === 3) {
    const p = path.join(repoRoot, 'data', 'escrow-custody-v3-build.json');
    if (!fs.existsSync(p)) throw new Error('V3 custody ABI artifact missing: ' + p);
    const artifact = JSON.parse(fs.readFileSync(p, 'utf8'));
    return artifact.abi;
  }
  const candidates = [
    path.join(repoRoot, 'build', 'hardhat-artifacts', 'contracts', 'SAAXEscrowCustodyV2.sol', 'SAAXEscrowCustodyV2.json'),
    path.join(repoRoot, 'artifacts', 'contracts', 'SAAXEscrowCustodyV2.sol', 'SAAXEscrowCustodyV2.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const artifact = JSON.parse(fs.readFileSync(c, 'utf8'));
      return artifact.abi;
    }
  }
  throw new Error('custody ABI artifact not found; build first (hardhat compile)');
}

module.exports = { loadCustodyAbi };