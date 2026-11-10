// D3 CLOSURE — unit tests for worker/d3-action-auth.js (action-argument
// authorization). Proves which authenticated artifact authorizes each
// execution-affecting argument, and that substituted/omitted evaluator or
// mutual signatures are rejected with the specific reason.
//
// Uses REAL EIP-712 signatures (ethers) over the custody domain.
//
// Semantics corrected from the D3 closure brief (see
// worker/d3-action-auth-matrix.md):
//   - The timeout rule is the REFUND path with a fully-empty (v,r,s) AND
//     empty sigBytes (contract refund() dispatch). N5's refund-with-sigBytes
//     is no longer TIMEOUT_WITH_SIG — it is now VERDICT_SIG_AMBIGUOUS
//     (evaluator signature present, does not return to the timeout rule).
//   - Timeout refund additionally requires the BUYER access role
//     (TIMEOUT_ROLE_REQUIRED) — the deadline rule belongs to the buyer, and
//     nothing about a signature presence infers it.
//   - The contract-wallet (ERC-1271) evaluator verdict is verified through
//     the SAME verdict digest as the EOA path (contract _checkVerdict), with
//     (v,r,s) empty and sigBytes carrying the Safe signature.
//
// Usage: node scripts/test-d3-action-auth.cjs

'use strict';

const { ethers } = require('ethers');
const { verifyActionArgs } = require('../worker/d3-action-auth.js');
const sigs = require('../mainnet/design/support/v4-signatures.js');

const CHAIN = 31337;
const CUSTODY = '0x5A5472D751839CD4968CBF1B136BAf862279FF5D';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const BUYER = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SELLER = new ethers.Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const EVALUATOR_EOA = new ethers.Wallet('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const STRANGER = new ethers.Wallet('0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97');

const CID = ethers.zeroPadValue(ethers.toBeHex(77), 32);
const DIGEST = ethers.keccak256(ethers.concat([CID, ethers.toBeHex(1, 1)]));

// Accepts EITHER the module's single-object call
// ({commitmentId, commitmentDigest, action, nonce, issuedAt, verifyingContract, chainId})
// OR the positional (action, nonce, issuedAt) legacy shape, and binds the
// custody domain exactly as the worker call-site does.
async function verdictDigest(a1, a2, a3) {
  const p = (typeof a1 === 'object' && a1 !== null)
    ? { commitmentId: CID, commitmentDigest: DIGEST, ...a1 }
    : { commitmentId: CID, commitmentDigest: DIGEST, action: a1, nonce: a2, issuedAt: a3 };
  return sigs.verdictDigest({ ...p, verifyingContract: CUSTODY, chainId: CHAIN });
}
async function mutualDigest(a1, a2, a3) {
  const p = (typeof a1 === 'object' && a1 !== null)
    ? { commitmentId: CID, commitmentDigest: DIGEST, ...a1 }
    : { commitmentId: CID, commitmentDigest: DIGEST, action: a1, nonce: a2, issuedAt: a3 };
  return sigs.mutualDigest({ ...p, verifyingContract: CUSTODY, chainId: CHAIN });
}

const escrow = { buyer: BUYER.address, seller: SELLER.address, evaluator: EVALUATOR_EOA.address, digest: DIGEST, amount: '1000', token: '0x' + '11'.repeat(20), state: 1, finalCutoff: 9999999999n };

function ctx(over) {
  return {
    contractAction: 'release', escrowId: DIGEST.toLowerCase(), escrow,
    chainId: CHAIN, custody: CUSTODY.toLowerCase(), expectedChainId: CHAIN, expectedCustody: CUSTODY.toLowerCase(),
    accessNonce: '1', accessRole: 'evaluator', accessAction: 'submit verdict',
    isContractWallet: async () => false,
    verdictDigest, mutualDigest,
    recoverEoa: (d, { v, r, s }) => {
      try { return ethers.recoverAddress(d, { v: Number(v), r: String(r), s: String(s) }); } catch { return null; }
    },
    verifyContractWallet: async () => ({ ok: false, reason: 'N/A' }),
    ...over,
  };
}

(async () => {
  // ——— POSITIVE: genuine evaluator EOA verdict (release) ———
  {
    const nonce = 9001, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx());
    check('P1: genuine evaluator EOA verdict authorizes release', r.ok === true && r.authorization === 'evaluator-eoa', r);
  }
  // ——— POSITIVE: timeout refund (empty verdict, buyer role) ———
  {
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce: 9002, issuedAt: 9999, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32), sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'refund', accessAction: 'request refund', accessRole: 'buyer' }));
    check('P2: empty verdict = timeout contract rule (no evaluator authority)', r.ok === true && r.authorization === 'timeout-contract-rule', r);
  }
  // ——— POSITIVE: mutual release (buyer+seller) ———
  {
    const nonce = 9003, issuedAt = 1000;
    const d = await mutualDigest('release', nonce, issuedAt);
    const bs = BUYER.signingKey.sign(d), ss = SELLER.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, bv: bs.v, br: bs.r, bs: bs.s, sv: ss.v, sr: ss.r, ss: ss.s };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'mutualRelease', accessAction: 'mutual release', accessRole: 'buyer' }));
    check('P3: mutual release authorized by BOTH parties', r.ok === true && r.authorization === 'mutual', r);
  }
  // ——— POSITIVE: mutual refund (buyer+seller) ———
  {
    const nonce = 9004, issuedAt = 1000;
    const d = await mutualDigest('refund', nonce, issuedAt);
    const bs = BUYER.signingKey.sign(d), ss = SELLER.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, bv: bs.v, br: bs.r, bs: bs.s, sv: ss.v, sr: ss.r, ss: ss.s };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'mutualRefund', accessAction: 'mutual refund', accessRole: 'buyer' }));
    check('P4: mutual refund authorized by BOTH parties', r.ok === true && r.authorization === 'mutual', r);
  }
  // ——— POSITIVE: evaluator verdict refund (genuine EOA) ———
  {
    const nonce = 9005, issuedAt = 1000;
    const d = await verdictDigest('refund', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'refund', accessAction: 'request refund', accessRole: 'evaluator' }));
    check('P5: evaluator verdict refund authorized (EOA)', r.ok === true && r.authorization === 'evaluator-eoa', r);
  }
  // ——— NEGATIVES ———
  {
    const nonce = 9010, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const sg = STRANGER.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx());
    check('N1: stranger-signed verdict rejected (EVALUATOR_MISMATCH)', r.ok === false && r.reason === 'EVALUATOR_MISMATCH', r);
  }
  {
    const nonce = 9011, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const badCid = ethers.zeroPadValue(ethers.toBeHex(99), 32);
    const args = { commitmentId: badCid, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx());
    check('N2: substituted commitmentId invalidates the verdict binding', r.ok === false && r.reason === 'EVALUATOR_MISMATCH', r);
  }
  {
    const nonce = 9012, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx({ escrow: { ...escrow, evaluator: STRANGER.address } }));
    check('N3: substituted evaluator rejected (EVALUATOR_MISMATCH)', r.ok === false && r.reason === 'EVALUATOR_MISMATCH', r);
  }
  {
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce: 9013, issuedAt: 1000, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32), sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx());
    check('N4: omitted verdict on release rejected (RELEASE_REQUIRES_VERDICT)', r.ok === false && r.reason === 'RELEASE_REQUIRES_VERDICT', r);
  }
  {
    const nonce = 9014, issuedAt = 9999;
    const d = await verdictDigest('refund', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' + 'aa'.repeat(64) };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'refund', accessAction: 'request refund', accessRole: 'buyer' }));
    check('N5: refund with BOTH (v,r,s) verdict AND non-empty sigBytes rejected (VERDICT_SIG_AMBIGUOUS)', r.ok === false && r.reason === 'VERDICT_SIG_AMBIGUOUS', r);
  }
  {
    const nonce = 9015, issuedAt = 1000;
    const d = await mutualDigest('refund', nonce, issuedAt);
    const bs = BUYER.signingKey.sign(d), ss = STRANGER.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, bv: bs.v, br: bs.r, bs: bs.s, sv: ss.v, sr: ss.r, ss: ss.s };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'mutualRefund', accessAction: 'mutual refund', accessRole: 'buyer' }));
    check('N6: mutual with substituted party rejected (MUTUAL_PARTY_MISMATCH)', r.ok === false && r.reason === 'MUTUAL_PARTY_MISMATCH', r);
  }
  {
    const nonce = 9016, issuedAt = 1000;
    const d = await verdictDigest('refund', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'release' }));
    check('N7: wrong-action verdict rejected (EVALUATOR_MISMATCH)', r.ok === false && r.reason === 'EVALUATOR_MISMATCH', r);
  }
  {
    const nonce = 9017, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const badEscrow = { ...escrow, digest: ethers.keccak256(ethers.concat([CID, ethers.toBeHex(2, 1)])) };
    const r = await verifyActionArgs(args, ctx({ escrow: badEscrow }));
    check('N8: substituted escrow (digest mismatch) rejected (ESCROW_DIGEST_MISMATCH)', r.ok === false && r.reason === 'ESCROW_DIGEST_MISMATCH', r);
  }
  {
    const nonce = 9018, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r1 = await verifyActionArgs(args, ctx({ chainId: 84532 }));
    check('N9a: substituted chain rejected (CHAIN_MISMATCH)', r1.ok === false && r1.reason === 'CHAIN_MISMATCH', r1);
    const r2 = await verifyActionArgs(args, ctx({ custody: '0x' + '22'.repeat(20) }));
    check('N9b: substituted custody rejected (CUSTODY_MISMATCH)', r2.ok === false && r2.reason === 'CUSTODY_MISMATCH', r2);
  }
  {
    const nonce = 9019, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'release', accessAction: 'request refund', accessRole: 'buyer' }));
    check('N10: access action not authorizing the contract action rejected (ACTION_NOT_AUTHORIZED)', r.ok === false && r.reason === 'ACTION_NOT_AUTHORIZED', r);
  }
  {
    const r = await verifyActionArgs({ commitmentId: CID, commitmentDigest: DIGEST }, ctx({ escrow: { buyer: '0x' + '00'.repeat(20) } }));
    check('N11: missing escrow -> ESCROW_NOT_FOUND', r.ok === false && r.reason === 'ESCROW_NOT_FOUND', r);
  }
  {
    // Timeout intent is the EXPLICIT empty-verdict mode (contract dispatch).
    // A refund carrying only sigBytes (with empty v,r,s) is a VERDICT
    // (ERC-1271 container) — NOT timeout. Rejected as CONTRACT_WALLET_MISSING_SIG
    // / evaluator path, never authorized as timeout.
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce: 9020, issuedAt: 1000, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32), sigBytes: '0x' + 'ab'.repeat(65) };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'refund', accessAction: 'request refund', accessRole: 'buyer' }));
    check('N12: refund with sigBytes but empty (v,r,s) is NOT timeout (rejected, not timeout-authorize)', r.ok === false && [ 'CONTRACT_WALLET_MISSING_SIG', 'CONTRACT_WALLET_VERIFIER_UNAVAILABLE', 'CONTRACT_WALLET_AMBIGUOUS_SIG', 'BAD_VERDICT_SIG' ].includes(r.reason), r);
  }
  {
    // Cross-role: timeout refund submitted under a NON-buyer role must be
    // rejected (TIMEOUT_ROLE_REQUIRED) — the buyer's role is part of the
    // timeout authority, not inferred from an absent signature.
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce: 9021, issuedAt: 9999, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32), sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'refund', accessAction: 'request refund', accessRole: 'seller' }));
    check('N13: timeout refund under a non-buyer role rejected (TIMEOUT_ROLE_REQUIRED)', r.ok === false && r.reason === 'TIMEOUT_ROLE_REQUIRED', r);
  }
  {
    // Untrusted relayer submission: a genuine evaluator-signed refund verdict
    // submitted with accessRole 'buyer' (the buyer's access auth) is STILL a
    // valid evaluator verdict — the module authorizes by the genuine
    // signature against escrow.evaluator, not by the access role. The access
    // policy gates who may submit at the endpoint; the worker authorizes the
    // action by the contract authority.
    const nonce = 9022, issuedAt = 1000;
    const d = await verdictDigest('refund', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'refund', accessAction: 'request refund', accessRole: 'buyer' }));
    check('P6: evaluator verdict refund via buyer-submitted relay is authorized (evaluator authority wins)', r.ok === true && r.authorization === 'evaluator-eoa', r);
  }
  {
    // ERC-1271 (contract-wallet evaluator): verdict digest is the SAME
    // EscrowVerdict over the exact contract action; (v,r,s) empty; sigBytes
    // carries the Safe signature; the hook staticcalls isValidSignature.
    const nonce = 9023, issuedAt = 1000;
    const d = await verdictDigest('release', nonce, issuedAt);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32), sigBytes: '0x' + 'cd'.repeat(65) };
    const r = await verifyActionArgs(args, ctx({ escrow: { ...escrow, evaluator: '0x' + '33'.repeat(20) }, isContractWallet: async () => true, verifyContractWallet: async (evaluator, digest, sigBytes) => ({ ok: true, reason: null }) }));
    check('P7: ERC-1271 evaluator verdict authorized (contract wallet)', r.ok === true && r.authorization !== 'timeout-contract-rule' && r.reason === undefined, r);
  }
  {
    // RESOLVE: the evaluator verdict action is "resolve:" + resolution
    // (contract _checkVerdict string.concat; design T6-T8). A genuine
    // evaluator signature over resolve:release authorizes resolve(hold
    // aside); a signature over resolve:release with resolution 'hold'
    // mismatches the digest.
    const nonce = 9024, issuedAt = 1000;
    const d = await verdictDigest('resolve:release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x', resolution: 'release' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'resolve', accessAction: 'resolve dispute', accessRole: 'evaluator', escrow: { ...escrow, state: 2 } }));
    check('P8: genuine evaluator resolve:release authorizes resolve', r.ok === true && r.authorization === 'evaluator-eoa', r);
  }
  {
    const nonce = 9025, issuedAt = 1000;
    const d = await verdictDigest('resolve:release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x', resolution: 'hold' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'resolve', accessAction: 'resolve dispute', accessRole: 'evaluator', escrow: { ...escrow, state: 2 } }));
    check('N14: resolve verdict bound to a different resolution rejected (EVALUATOR_MISMATCH)', r.ok === false && r.reason === 'EVALUATOR_MISMATCH', r);
  }
  {
    const r = await verifyActionArgs({ commitmentId: CID, commitmentDigest: DIGEST, nonce: 9026, issuedAt: 1000, resolution: 'explode' }, ctx({ contractAction: 'resolve', accessAction: 'resolve dispute', accessRole: 'evaluator', escrow: { ...escrow, state: 2 } }));
    check('N15: non-(release|refund|hold) resolution rejected (BAD_RESOLUTION)', r.ok === false && r.reason === 'BAD_RESOLUTION', r);
  }

  // D3 CLOSURE — resolve access-role enforcement (documented access policy is
  // separate from the verdict; internal contract-action normalization must
  // not manufacture evaluator access).
  {
    const nonce = 9030, issuedAt = 1000;
    const d = await verdictDigest('resolve:refund', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x', resolution: 'refund' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'resolve', accessAction: 'resolve dispute', accessRole: 'evaluator', escrow: { ...escrow, state: 2 } }));
    check('P9: genuine evaluator resolve:refund authorizes resolve', r.ok === true && r.authorization === 'evaluator-eoa', r);
  }
  {
    // Buyer role with a GENUINE evaluator verdict signature: the verdict does
    // NOT manufacture buyer-side resolve access — the documented access
    // policy (resolve is evaluator-only) is enforced separately.
    const nonce = 9031, issuedAt = 1000;
    const d = await verdictDigest('resolve:release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x', resolution: 'release' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'resolve', accessAction: 'resolve dispute', accessRole: 'buyer', escrow: { ...escrow, state: 2 } }));
    check('N16: buyer cannot gain resolve access through the internal mapping (RESOLVE_ROLE_REQUIRED)', r.ok === false && r.reason === 'RESOLVE_ROLE_REQUIRED', r);
  }
  {
    const nonce = 9032, issuedAt = 1000;
    const d = await verdictDigest('resolve:release', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x', resolution: 'release' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'resolve', accessAction: 'resolve dispute', accessRole: 'seller', escrow: { ...escrow, state: 2 } }));
    check('N17: seller cannot gain resolve access through the internal mapping (RESOLVE_ROLE_REQUIRED)', r.ok === false && r.reason === 'RESOLVE_ROLE_REQUIRED', r);
  }
  {
    // A buyer-signed op whose accessAction was normalized to the verdict
    // contract action ('submit verdict' -> release) must still be rejected:
    // the role is buyer, so the re-entrant resolve path cannot substitute
    // evaluator access for an unauthorized caller action.
    const nonce = 9033, issuedAt = 1000;
    const d = await verdictDigest('resolve:refund', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: sg.v, r: sg.r, s: sg.s, sigBytes: '0x', resolution: 'refund' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'resolve', accessAction: 'submit verdict', accessRole: 'buyer', escrow: { ...escrow, state: 2 } }));
    // The step-1 access-scope mapping rejects a non-resolve access action
    // before the resolve branch (ACTION_NOT_AUTHORIZED), and the resolve
    // branch's own role check (RESOLVE_ROLE_REQUIRED) is the second layer.
    // Either rejection proves the internal normalization cannot manufacture
    // evaluator access for a buyer op.
    check('N18: buyer op normalized to verdict action cannot reach resolve (rejected at mapping or role gate)', r.ok === false && ['ACTION_NOT_AUTHORIZED', 'RESOLVE_ROLE_REQUIRED'].includes(r.reason), r);
  }
  {
    // ERC-1271 consistency: the resolve access-role gate fires BEFORE
    // signature-type dispatch, so a contract-wallet resolve op under a
    // non-evaluator role is rejected at the SAME gate (RESOLVE_ROLE_REQUIRED),
    // never reaching the Safe/ERC-1271 verdict verification.
    const nonce = 9034, issuedAt = 1000;
    const d = await verdictDigest('resolve:refund', nonce, issuedAt);
    const sg = EVALUATOR_EOA.signingKey.sign(d);
    const args = { commitmentId: CID, commitmentDigest: DIGEST, nonce, issuedAt, v: 0, r: '0x', s: '0x', sigBytes: sg.serialized ? sg.serialized : ('0x' + sg.r.slice(2) + sg.s.slice(2) + '1b'), resolution: 'refund' };
    const r = await verifyActionArgs(args, ctx({ contractAction: 'resolve', accessAction: 'resolve dispute', accessRole: 'seller', escrow: { ...escrow, state: 2 }, isContractWallet: async () => true, verifyContractWallet: async () => ({ ok: true }) }));
    check('N19: ERC-1271 resolve op under seller role rejected at the same role gate (RESOLVE_ROLE_REQUIRED)', r.ok === false && r.reason === 'RESOLVE_ROLE_REQUIRED', r);
  }

  console.log('\n----\npassed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE_CRASH', e); process.exit(2); });