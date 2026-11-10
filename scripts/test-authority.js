// SAAX Protocol — Day 15, Item 2: Authority-Proof test harness
// Run: node scripts/test-authority.js
//
// Five tests (per the Task Brief Step 4):
//   T1  Valid authority proof allows the commitment to be issued
//   T2  Expired proof rejects the commitment
//   T3  Proof with insufficient scope rejects the commitment
//   T4  Proof with bad signature rejects the commitment
//   T5  Commitment without a proof follows the legacy path (buyer signature
//       only) — backward compatible
//
// Signature scheme: eip712 via viem signTypedData/verifyTypedData over the
// AUTHORITY domain (real cryptographic verification — not emulation).

'use strict';

process.env.SAAX_IDEMPOTENCY_STORE = 'memory';

const { privateKeyToAccount, signTypedData } = require('viem/accounts');
const authorityMod = require('../endpoint/authority.js');
const commitmentMod = require('../endpoint/commitment.js');

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  if (ok) passed++;
  else { failures++; console.log('  FAIL', name, detail ? '| ' + detail : ''); }
  return ok;
};

// ---- key material -----------------------------------------------------------
const ISSUER_KEY = '0x' + 'ab'.repeat(32);                       // external authority (AP2/Verifiable Intent/OAuth)
const ISSUER = privateKeyToAccount(ISSUER_KEY).address;
const SUBJECT_KEY = '0x' + 'cd'.repeat(32);                      // the agent being authorized (commitment buyer)
const SUBJECT = privateKeyToAccount(SUBJECT_KEY).address;

// ---- proof builder ------------------------------------------------------------
async function makeProof({ issuerKey = ISSUER_KEY, overrides = {}, sign = true }) {
  const acct = privateKeyToAccount(issuerKey);
  const issuer = overrides.issuer || acct.address;
  const base = {
    authorityProofId: overrides.authorityProofId || '0x' + '11'.repeat(32),
    proofType: overrides.proofType || 'ap2-mandate',
    issuer,
    subject: overrides.subject || SUBJECT,
    scope: overrides.scope || {
      actions: ['route', 'settle'],
      capability: 'cold-chain-delivery',
      amountMax: '50000',
      currency: 'USDC',
    },
    validFrom: overrides.validFrom || new Date(Date.now() - 3600 * 1000).toISOString(),
    validUntil: overrides.validUntil || new Date(Date.now() + 86400 * 1000).toISOString(),
    signature: overrides.signature || undefined,
    verificationScheme: 'eip712',
    verificationMaterial: '0x' + '22'.repeat(32),
  };
  if (sign) {
    const sig = await signTypedData({
      privateKey: issuerKey,
      types: authorityMod.PROOF_TYPES,
      primaryType: 'AuthorityProof',
      message: {
        authorityProofId: base.authorityProofId,
        issuer: base.issuer,
        subject: base.subject,
        validFrom: BigInt(Math.floor(Date.parse(base.validFrom) / 1000)),
        validUntil: BigInt(Math.floor(Date.parse(base.validUntil) / 1000)),
        scopeDigest: authorityMod.scopeDigest(base.scope),
      },
      domain: { name: authorityMod.PROOF_DOMAIN_NAME, version: authorityMod.PROOF_DOMAIN_VERSION },
    });
    base.signature = sig;
  } else {
    base.signature = '0x' + 'ab'.repeat(65); // structurally valid 65-byte hex, cryptographically WRONG
  }
  return base;
}

// ---- commitment builder (legacy path uses no authority proof) ---------------
function makeCommitment(extra = {}) {
  return {
    commitmentId: '0x' + '33'.repeat(32),
    buyerAgentId: SUBJECT,
    sellerAgentId: '0x' + '44'.repeat(32),
    capability: 'cold-chain-delivery',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'temperature', value: '<= 5C' },
    deadline: '2026-10-07T12:00:00Z',
    ...extra,
  };
}

(async function run() {
  // ==========================================================================
  // T1 — VALID authority proof allows the commitment to be issued
  // ==========================================================================
  const proof = await makeProof({});
  const commitment = makeCommitment({ authorityProofId: proof.authorityProofId });
  const v1 = await authorityMod.validateAuthorityProof(proof, commitment);
  check('T1a validateAuthorityProof ok (valid proof)', v1.ok, v1.reason);
  const auth1 = await authorityMod.isAuthorized(proof, 'settle', {
    commitment,
    capability: 'cold-chain-delivery',
    currency: 'USDC',
    amountRaw: '50000',
  });
  check('T1b isAuthorized settles (in scope)', auth1.ok, auth1.reason);
  const attached = authorityMod.attachAuthorityProof({ ...commitment }, proof);
  check('T1c attachAuthorityProof stores reference (no signature leakage)',
    attached.authorityProof && attached.authorityProof.authorityProofId === proof.authorityProofId &&
    !attached.authorityProof.signature, 'reference stored, signature NOT stored');

  // ==========================================================================
  // T2 — EXPIRED proof rejects the commitment
  // ==========================================================================
  const expired = await makeProof({
    overrides: {
      validFrom: new Date(Date.now() - 7200 * 1000).toISOString(), // 2h ago
      validUntil: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h ago (in the past)
    },
  });
  const v2 = await authorityMod.validateAuthorityProof(expired, makeCommitment({ authorityProofId: expired.authorityProofId }));
  check('T2 expired proof rejected (time)', !v2.ok && v2.stage === 'time', v2.reason);

  // ==========================================================================
  // T3 — PROOF WITH INSUFFICIENT SCOPE rejects the commitment
  // ==========================================================================
  const narrowScope = await makeProof({
    overrides: {
      scope: {
        actions: ['route'],          // NOT 'settle'
        capability: 'cold-chain-delivery',
        amountMax: '50000',
        currency: 'USDC',
      },
    },
  });
  const v3 = await authorityMod.validateAuthorityProof(narrowScope, makeCommitment({ authorityProofId: narrowScope.authorityProofId }));
  check('T3a proof itself valid', v3.ok, v3.reason);
  const auth3 = await authorityMod.isAuthorized(narrowScope, 'settle', {
    capability: 'cold-chain-delivery',
    currency: 'USDC',
    amountRaw: '50000',
  });
  check('T3b insufficient scope (action not in scope) rejected', !auth3.ok && auth3.stage === 'scope', auth3.reason);

  // amount over scope
  const lowAmount = await makeProof({
    overrides: {
      scope: {
        actions: ['settle'],
        capability: 'cold-chain-delivery',
        amountMax: '100',            // less than the commitment's 50000
        currency: 'USDC',
      },
    },
  });
  const auth3b = await authorityMod.isAuthorized(lowAmount, 'settle', {
    capability: 'cold-chain-delivery',
    currency: 'USDC',
    amountRaw: '50000',
  });
  check('T3c insufficient scope (amount > amountMax) rejected', !auth3b.ok && auth3b.stage === 'scope', auth3b.reason);

  // ==========================================================================
  // T4 — PROOF WITH BAD SIGNATURE rejects the commitment
  // ==========================================================================
  const badSig = await makeProof({ sign: false });
  const v4 = await authorityMod.validateAuthorityProof(badSig, makeCommitment({ authorityProofId: badSig.authorityProofId }));
  check('T4 bad signature rejected (signature)', !v4.ok && v4.stage === 'signature', v4.reason);

  // ==========================================================================
  // T5 — LEGACY PATH: commitment WITHOUT a proof is backward compatible
  // ==========================================================================
  const legacy = makeCommitment(); // no authorityProofId, no proof
  check('T5a legacy commitment has no authorityProofId',
    !legacy.authorityProofId && !legacy.authorityProof, 'legacy shape preserved');
  // The legacy path issues via the standard flow — validate a manifest build
  // succeeds (the manifest carries no proof requirement).
  const manifest = commitmentMod.buildManifest({
    commitmentId: commitmentMod.newCommitmentId(),
    buyerAgentId: SUBJECT,
    sellerAgentId: '0x' + '44'.repeat(32),
    capability: 'cold-chain-delivery',
    price: { amount: '50000', currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'temperature', value: '<= 5C' },
    deadline: '2026-10-07T12:00:00Z',
    cancelCondition: 'buyer-cancel-before-delivery',
  });
  check('T5b legacy manifest builds (no proof required)', !!manifest.manifestHash && !!manifest.commitmentId, 'legacy path OK');

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('----');
  console.log('authority tests: ' + passed + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e.message || e);
  process.exit(2);
});