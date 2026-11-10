#!/usr/bin/env node
// Review-snapshot manifest generator (SAAX Custody V3 independent-review snapshot).
// Hashes EXACT COMMITTED BYTES via `git show <rev>:<path>` for every referenced component.
// Output: review/f3c-candidate/10-review-snapshot-manifest.json
// This script, the manifest it emits, and the freeze record are added in ONE local
// preparation commit; the manifest does not include itself (no circular hash).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = '2e49625b0ee0ac4d95422a1b00f469a18bc7dbe8'; // candidate source revision
const PKG = '7c26838b7709366ae032ccf6f80971692589ee37'; // package/test evidence revision (current HEAD)
const PREV = '9066ace628cd96c569163830f3614e18b6eb0b2f'; // prior package commit (46/46 harness)
const OUT = path.join(ROOT, 'review', 'f3c-candidate', '10-review-snapshot-manifest.json');

function gitShow(rev, p) {
  try {
    return execFileSync('git', ['show', `${rev}:${p}`], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    return null; // path does not exist at that revision
  }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function keccak256(buf) {
  // tiny keccak256 via ethers if available (only for display; SHA-256 is the manifest digest)
  try {
    const { keccak256: k } = require('ethers');
    return k('0x' + buf.toString('hex'));
  } catch { return null; }
}

// component sets keyed by revision
const sets = {
  // exact candidate source + artifact identity + verifier pins (candidate lane)
  source: {
    'contracts/SAAXEscrowCustodyV3.sol': SRC,
  },
  artifact: {
    'data/escrow-custody-v3-build.json': PKG,
    'verifier/v4-candidate-identity-31337-v3.json': PKG,
    'verifier/v4-eas-policy.json': PKG,
  },
  // build inputs/settings + compiler + lockfiles
  build: {
    'hardhat.config.js': PKG,
    'package.json': PKG,
    'package-lock.json': PKG,
    'artifacts/f3a/v3-build-manifest.json': PKG,
    'artifacts/f3a/V3-creation.bytecode': PKG,
    'artifacts/f3a/V3-runtime.bytecode': PKG,
    'artifacts/f3a/V3.abi.json': PKG,
    'scripts/_f3c-reconcile-runtime.cjs': null, // UNCOMMITTED working tree; sanitized copy added to package evidence
  },
  // endpoint / worker / verifier components
  components: {
    'endpoint/custody-version.js': PKG,
    'endpoint/eas.js': PKG,
    'worker/d3-worker.js': PKG,
    'worker/d3-store.js': PKG,
    'worker/run-d3-worker.cjs': PKG,
    'verifier/verify-v4.js': PKG,
    'verifier/v4-journal.js': PKG,
    'verifier/v4-evidence.js': PKG,
    'verifier/v4-anchor.js': PKG,
    'mainnet/design/support/v4-signatures.js': PKG,
    'verifier/schema-uid-regression.js': PKG,
    'verifier/eas-verification-limits.md': PKG,
    'mainnet/design/support/v4-journal-writer.js': PKG,

  },
  // identity/EAS policies, schemas, migrations, config docs
  identity: {
    'mainnet/admission/schema.js': PKG,
    'mainnet/policies/custody-policy-v1.md': PKG,
    'mainnet/agreements/custody-policy-addendum-v1.md': PKG,
    'spec/commitment-schema.md': PKG,
    'mainnet/design/v4-journal-schema-decision.md': PKG,
    'mainnet/design/e1a-finality-policy.md': PKG,
    'mainnet/design/expiry-policy-d3.md': PKG,
    'mainnet/release-candidate-gap-assessment.md': PKG,
    'mainnet/f3c-status.md': PKG,
    'mainnet/funding-rule-approval.md': PKG,
  },
  // candidate-specific harnesses (exact-candidate suites)
  harnesses: {
    'scripts/test-custody-v3-candidate-boundary.cjs': PKG,
    'scripts/test-custody-v3-realsafe-candidate.cjs': PKG,
    'scripts/test-v3-integrated-flow.cjs': PKG,
    'scripts/test-f3c-two-worker-contention.cjs': PKG,
    'scripts/_f3c-v4-export-producer.cjs': PKG,
    'scripts/test-custody-version-dispatch.cjs': PKG,
    'scripts/test-e1b-verify-v4.cjs': PKG,
  },
  // evidence (candidate lanes), committed paths
  evidenceCand: {
    'evidence/f3c-candidate-boundary-exports/results.json': PKG,
    'evidence/f3c-candidate-boundary-exports/run-record.json': PKG,
    'evidence/f3c-candidate-realsafe-exports/results.json': PKG,
    'evidence/f3c-candidate-realsafe-exports/run-record.json': PKG,
    'evidence/f3c-candidate-realsafe-exports/same-block-pre-governance-release.json': PKG,
    'evidence/f3c-candidate-realsafe-exports/separate-process.txt': PKG,
    'evidence/f3c-candidate-realsafe-exports/fresh-install-rebuild.json': PKG,
    'evidence/f3c-v4-exports/results.json': PKG,
    'review/f3c-candidate/evidence/candidate-boundary-console.txt': PKG,
    'review/f3c-candidate/evidence/candidate-boundary-results.json': PKG,
    'review/f3c-candidate/evidence/candidate-boundary-run-record.json': PKG,
    'review/f3c-candidate/evidence/candidate-realsafe-console.txt': PKG,
    'review/f3c-candidate/evidence/candidate-realsafe-export.json': PKG,
    'review/f3c-candidate/evidence/candidate-realsafe-results.json': PKG,
    'review/f3c-candidate/evidence/candidate-realsafe-run-record.json': PKG,
    'review/f3c-candidate/evidence/candidate-realsafe-separate-process.txt': PKG,
    'review/f3c-candidate/evidence/fresh-install-rebuild.json': PKG,
    'review/f3c-candidate/evidence/reconcile-fresh.txt': PKG,
  },
  // historical/fixture evidence (V2, F3A, V1 batteries) - explicitly labeled not candidate coverage
  evidenceOther: {
    'evidence/phase3b-v4/results.json': PKG,
    'evidence/phase3c-v4/results.json': PKG,
    'evidence/f3c-final-report-2e49625b.md': null, // uncommitted working tree, sanitized copy; sha computed from copy
    'evidence/v3-battery/v3-battery-summary.json': PKG,
    // 7-outcome integrated export artifacts (candidate lane evidence)
    'evidence/f3c-v4-exports/release.json': PKG,
    'evidence/f3c-v4-exports/refund.json': PKG,
    'evidence/f3c-v4-exports/mutual-release.json': PKG,
    'evidence/f3c-v4-exports/mutual-refund.json': PKG,
    'evidence/f3c-v4-exports/resolve-release.json': PKG,
    'evidence/f3c-v4-exports/resolve-refund.json': PKG,
    'evidence/f3c-v4-exports/timeout.json': PKG,
    'evidence/f3c-v4-exports/separate-process-release.txt': PKG,
    'evidence/f3c-v4-exports/separate-process-refund.txt': PKG,
    'evidence/f3c-v4-exports/separate-process-mutual-release.txt': PKG,
    'evidence/f3c-v4-exports/separate-process-mutual-refund.txt': PKG,
    'evidence/f3c-v4-exports/separate-process-resolve-release.txt': PKG,
    'evidence/f3c-v4-exports/separate-process-resolve-refund.txt': PKG,
    'evidence/f3c-v4-exports/separate-process-timeout.txt': PKG,
  },
};

const manifest = {
  schema: 'saax-custody-v3-review-snapshot-manifest/v1',
  preparedAt: new Date().toISOString(),
  baseline: {
    candidateSourceRevision: SRC,
    packageRevision: PKG,
    packagePath: 'review/f3c-candidate/',
    priorPackageRevision: PREV,
    headAtPreparation: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    chainId: 31337,
    runtimeKeccakPin: '0x87615e3d90b6d188b6f33cec35ef135f3c97c11727a3b0a6689715238f5a46e3',
    coverageReported: { realsafe: '46/46', boundary: '161/161' },
    status: 'LOCAL CUSTODY CANDIDATE — NOT FROZEN, NOT APPROVED, deployment compatibility NOT established',
  },
  preparationArtifacts: {
    note: 'These files are created/committed IN the preparation commit and are therefore not hashed in this manifest (their hashes depend on the preparation commit itself; no circular hash). They are part of the prepared snapshot:' ,
    paths: [
      'review/f3c-candidate/10-review-snapshot-manifest.json (this file)' ,
      'review/f3c-candidate/11-validation-notes.md' ,
      'review/f3c-candidate/PROPOSED-freeze-approval-record.md' ,
      'review/f3c-candidate/evidence/outputs/* (sanitized working-tree transcript copies)' ,
      'review/f3c-candidate/evidence/f3c-final-report-2e49625b.md (working-tree copy)' ,
      'scripts/_review-hash-manifest.cjs (generator)' ,
    ],
  },
  hashCoverage: {
    method: 'SHA-256 over the exact committed bytes of each referenced file at its pinned revision (git show <rev>:<path>)',
    excludes: ['this manifest file itself (no circular hash)', 'node_modules/ dependency directories', 'secrets/private keys/env files/runtime databases/scratch files'],
  },
  components: {},
};

for (const [group, files] of Object.entries(sets)) {
  manifest.components[group] = {};
  for (const [p, rev] of Object.entries(files)) {
    const buf = (rev ? gitShow(rev, p) : null) || (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p)) : null);
    if (!buf) { manifest.components[group][p] = { status: 'MISSING', warning: true }; continue; }
    manifest.components[group][p] = {
      revision: rev || '(working tree — sanitized copy; see provenance note)',
      sha256: sha256(buf),
      bytes: buf.length,
      keccak256: keccak256(buf) || undefined,
    };
  }
}

// integrity: realsafe harness = first committed in 9066ace6; boundary harness = 7c26838b (verify equality)
const integrity = {
  realsafeHarness: {
    at9066ace6: sha256(gitShow('9066ace6', 'scripts/test-custody-v3-realsafe-candidate.cjs') || Buffer.alloc(0)),
    at7c26838b: sha256(gitShow('7c26838b', 'scripts/test-custody-v3-realsafe-candidate.cjs') || Buffer.alloc(0)),
  },
  boundaryHarness: {
    at9066ace6: (gitShow('9066ace6', 'scripts/test-custody-v3-candidate-boundary.cjs') ? 'present' : 'absent'),
    at7c26838b: sha256(gitShow('7c26838b', 'scripts/test-custody-v3-candidate-boundary.cjs') || Buffer.alloc(0)),
  },
  sourceUnchanged: {
    srcToPkgDiffEmpty: sha256(gitShow('2e49625b', 'contracts/SAAXEscrowCustodyV3.sol')) === sha256(gitShow('7c26838b', 'contracts/SAAXEscrowCustodyV3.sol')),
  },
};
manifest.integrity = integrity;

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote', OUT, 'bytes=', fs.statSync(OUT).size);
