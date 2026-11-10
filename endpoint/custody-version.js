// F3B — Explicit custody-version dispatch (LOCAL TEST ONLY).
//
// Version selection is NEVER inferred from manifest/export formatVersion. It
// is driven by the custody identity declared for the active chain/lane and
// validated against the pinned artifact (runtimeCodeHash) when on-chain code
// is readable:
//
//   selectCustodyVersion({ custodyAddress, chainId, provider, declaredVersion })
//     -> { version: 1|2|3, artifact, identity, domain, errors[] }
//
// Rules:
//   - V1 artifact  (data/escrow-custody-build.json)     — hosted lane default
//   - V2 candidate (data/escrow-custody-v2-build.json)   — legacy D3 lane
//   - V3 candidate (data/escrow-custody-v3-build.json)   — F3B integrated lane
//   - declaredVersion may CONFIRM but never override the chain-lane mapping.
//   - When the on-chain runtime is readable (provider + getCode), the pinned
//     runtimeCodeHash must match; a mismatch is a REJECT (identity failure).
//   - formatVersion in any export/manifest is NEVER the selector.
//
// The V3 identity file is verifier-owned (verifier/v4-candidate-identity-31337-v3.json);
// the artifact is endpoint-owned (data/escrow-custody-v3-build.json). This
// module bridges them for the isolated integrated path only.
'use strict';

const path = require('path');

const V1 = { version: 1, name: 'SAAX Escrow Custody V1', artifact: 'data/escrow-custody-build.json' };
const V2 = { version: 2, name: 'SAAX Escrow Custody V2', artifact: 'data/escrow-custody-v2-build.json' };
const V3 = { version: 3, name: 'SAAX Escrow Custody V3', artifact: 'data/escrow-custody-v3-build.json' };

const LANES = {
  // hosted lane default: Base Sepolia test (chain 84532) -> V1 legacy artifact
  84532: { lane: 'hosted', version: 1, artifact: V1.artifact },
  // local integrated lane (31337): default V2 (legacy D3), V3 selectable via
  // SAAX_CUSTODY_VERSION=3 — DOES NOT change the V1/V2 behavior when unset.
  31337: { lane: 'local', version: 2, artifact: V2.artifact },
};

function loadArtifact(artifactPath) {
  try {
    return require(path.join(__dirname, '..', artifactPath));
  } catch (e) {
    return { error: 'artifact missing: ' + artifactPath + ' (' + e.message + ')' };
  }
}

/**
 * Select the custody version for a chain/lane with explicit identity.
 * @param {object} opts { chainId, declaredVersion, custodyAddress, provider }
 * @returns {object} { ok, version, artifact, identity, lane, errors[] }
 */
function selectCustodyVersion(opts) {
  const errors = [];
  const chainId = Number(opts && opts.chainId);
  const laneDef = LANES[chainId];
  if (!laneDef) {
    return { ok: false, version: null, lane: null, errors: ['unsupported chain ' + chainId + ' (supported: 84532 hosted, 31337 local)'] };
  }
  // V3 is ONLY selectable on the local lane (31337). Any other lane rejects.
  const declared = String(opts && opts.declaredVersion || '').trim();
  let version = laneDef.version;
  if (declared) {
    const dv = Number(declared);
    if (![1, 2, 3].includes(dv)) {
      return { ok: false, version: null, lane: laneDef.lane, errors: ['invalid declared custody version ' + declared] };
    }
    if (dv === 3 && chainId !== 31337) {
      return { ok: false, version: null, lane: laneDef.lane, errors: ['V3 custody only supported on local lane 31337 (got chain ' + chainId + ')'] };
    }
    if (dv === 1 && chainId !== 84532) {
      return { ok: false, version: null, lane: laneDef.lane, errors: ['V1 custody only supported on hosted lane 84532 (got chain ' + chainId + ')'] };
    }
    if (dv === 2 && chainId !== 31337) {
      return { ok: false, version: null, lane: laneDef.lane, errors: ['V2 custody only supported on local lane 31337 (got chain ' + chainId + ')'] };
    }
    // declared CONFIRMS the lane default (or the local lane's V3 override)
    if (laneDef.lane === 'local') version = dv; // 2 or 3
    else if (dv !== laneDef.version) {
      return { ok: false, version: null, lane: laneDef.lane, errors: ['declared custody version ' + dv + ' contradicts lane default ' + laneDef.version + ' for chain ' + chainId] };
    }
  }
  const meta = version === 3 ? V3 : (version === 2 ? V2 : V1);
  const artifact = loadArtifact(meta.artifact);
  if (artifact.error) return { ok: false, version, lane: laneDef.lane, errors: [artifact.error] };
  if (!artifact.abi) return { ok: false, version, lane: laneDef.lane, errors: ['artifact has no abi'] };

  // Identity: runtimeCodeHash from the artifact (V3 built with it; V1/V2 carry
  // what they carry). When the chain is readable, getCode must match.
  const identity = artifact.runtimeCodeHash ? { runtimeCodeHash: artifact.runtimeCodeHash, compiler: artifact.compiler || null, sourceSha256: artifact.sourceSha256 || null } : null;

  return { ok: true, version, name: meta.name, artifact, identity, lane: laneDef.lane, errors };
}

module.exports = { selectCustodyVersion, LANES, V1, V2, V3 };