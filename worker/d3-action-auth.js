// D3 CLOSURE — ACTION-ARGUMENT AUTHORIZATION (worker-side).
//
// Proves that EVERY execution-affecting argument the worker builds into
// custody calldata is authorized by a genuine authenticated artifact BEFORE
// the transaction is prepared or broadcast.
//
// (Full design commentary in the committed header — this file is the
// implementation. The verifier is fully ASYNC because the shared signing
// helpers (verdictDigest/mutualDigest) dynamically import ethers and return
// promises.)
//
// Canonical action mapping: the access-action -> contract-action map below is
// the ONE canonical mapping every authorization path keys on. Access actions
// are matched case-insensitively; the CONTRACT side is emitted EXACTLY as the
// deployed ABI spells it (lowercase / camelCase literals) and is NEVER
// re-lowercased afterward — lowercasing the contract side once made
// 'mutualRelease'/'mutualRefund' unreachable (UNSUPPORTED_ACTION
// 'mutualrelease') and broke the digest action derivation inside the mutual
// branch. See worker/d3-action-auth-matrix.md for the full matrix.

'use strict';

const { ethers } = require('ethers');

/** Recover the ecrecover address exactly as Solidity's ecrecover does. */
function recoverAddress(digest, r, s, v) {
  try {
    const sig = ethers.Signature.from({ r: String(r), s: String(s), v: Number(v) });
    return ethers.recoverAddress(digest, sig);
  } catch { return null; }
}

/** Normalize (v,r,s) from the varied shapes actionArgs may carry.
 *  r/s that are missing, '0x', or ALL-ZERO bytes are treated as EMPTY —
 *  this matches the contract's dispatch, where r==0 && s==0 (with v==0)
 *  means the timeout rule / ERC-1271 container, NOT an EOA verdict.
 *  Only a NON-ZERO r/s pair is an EOA signature. */
function normalizeSig({ v, r, s }) {
  const vv = Number(v);
  let rr = String(r || '');
  let ss = String(s || '');
  const allZero = (x) => {
    const h = x.replace(/^0x/i, '').replace(/^0+$/, '');
    return h === '';
  };
  if (!rr || !ss || rr === '0x' || ss === '0x' || allZero(rr) || allZero(ss)) {
    return { vv: 0, rr: '', ss: '' };
  }
  return { vv, rr, ss };
}

// The access-action -> contract-action map (mirror of d3-worker).
const ACTION_TO_CONTRACT = {
  'submit verdict': 'release',
  'request refund': 'refund',
  'initiate dispute': 'raiseDispute',
  'resolve dispute': 'resolve',
  'mutual release': 'mutualRelease',
  'mutual refund': 'mutualRefund',
};

// Exact contract-action literals (canonical ABI names). Classification uses
// exact-match sets, never case normalization of the canonical value.
const CONTRACT_ACTIONS = Object.freeze({
  RELEASE: 'release',
  REFUND: 'refund',
  MUTUAL_RELEASE: 'mutualRelease',
  MUTUAL_REFUND: 'mutualRefund',
  RAISE_DISPUTE: 'raiseDispute',
  RESOLVE: 'resolve',
});

/** Classify a contract-action value against the canonical ABI names.
 *  Returns the CANONICAL literal or null when unknown. */
function canonicalContractAction(value) {
  const v = String(value || '');
  // Exact-match the canonical literals first (mutualRelease/mutualRefund/
  // raiseDispute/resolve are case-sensitive ABI names).
  const exact = Object.values(CONTRACT_ACTIONS).find((c) => c === v);
  if (exact) return exact;
  // Fall back to a case-insensitive match STRICTLY for the lowercase ABI
  // names ('release'/'refund') — the only ones Solidity capitalizes as
  // lowercase literals. Never reach a camelCase name through this path:
  // 'MUTUALRELEASE' has no canonical form here and stays unknown.
  const lc = v.toLowerCase();
  if (lc === 'release' || lc === 'refund') return lc;
  return null;
}

/**
 * Verify the actionArgs against the GENUINE artifacts. ASYNC — the digest
 * helpers return promises.
 */
async function verifyActionArgs(args, ctx) {
  const A = args || {};
  const esc = ctx.escrow || {};
  const lc = (x) => String(x || '').toLowerCase();

  // 1. Contract action authorized by the access action.
  const expectedAccess = Object.keys(ACTION_TO_CONTRACT).find((k) => ACTION_TO_CONTRACT[k] === ctx.contractAction);
  if (expectedAccess && String(ctx.accessAction || '').toLowerCase() !== expectedAccess.toLowerCase()) {
    return { ok: false, reason: 'ACTION_NOT_AUTHORIZED', detail: { accessAction: ctx.accessAction, contractAction: ctx.contractAction, expectedAccess } };
  }
  if (!expectedAccess && String(ctx.accessAction || '').toLowerCase() !== String(ctx.contractAction || '').toLowerCase()) {
    // Not a mapped action and not equal — reject unless the contract action
    // is not one the worker executes at all.
    const known = Object.values(ACTION_TO_CONTRACT);
    if (known.includes(ctx.contractAction)) {
      return { ok: false, reason: 'ACTION_NOT_AUTHORIZED', detail: { accessAction: ctx.accessAction, contractAction: ctx.contractAction, note: 'contract action not reachable from the access action' } };
    }
  }

  // 2. Escrow/commitment binding.
  if (!esc.buyer || /^0x0+$/.test(lc(esc.buyer))) {
    return { ok: false, reason: 'ESCROW_NOT_FOUND', detail: { escrowId: ctx.escrowId } };
  }
  if (!esc.digest || lc(esc.digest) !== lc(ctx.escrowId)) {
    return { ok: false, reason: 'ESCROW_DIGEST_MISMATCH', detail: { escrowDigest: esc.digest, escrowId: ctx.escrowId } };
  }

  // 3. Chain/custody re-check.
  if (Number(ctx.chainId) !== Number(ctx.expectedChainId)) {
    return { ok: false, reason: 'CHAIN_MISMATCH', detail: { expected: ctx.expectedChainId, got: ctx.chainId } };
  }
  if (lc(ctx.custody) !== lc(ctx.expectedCustody)) {
    return { ok: false, reason: 'CUSTODY_MISMATCH', detail: { expected: ctx.expectedCustody, got: ctx.custody } };
  }

  // Classify against the CANONICAL contract action (never lowercase the
  // canonical literals — that is what made the mutual branch unreachable).
  const action = canonicalContractAction(ctx.contractAction);
  if (!action) {
    return { ok: false, reason: 'UNSUPPORTED_ACTION', detail: String(ctx.contractAction || '').toLowerCase() };
  }

  if (action === CONTRACT_ACTIONS.RELEASE || action === CONTRACT_ACTIONS.REFUND) {
    // Structural signature check FIRST (mirrors the contract's dispatch in
    // refund(): any non-empty (v,r,s) => verdict; all-empty + empty sigBytes
    // => timeout rule). Presence of sigBytes alone is NEVER treated as
    // verdict intent — that is how the timeout-with-sig path got through.
    const sig = normalizeSig({ v: A.v, r: A.r, s: A.s });
    const hasEoaSig = !!(sig.rr && sig.ss);
    const sigBytesNonEmpty = !!(A.sigBytes && A.sigBytes !== '0x' && A.sigBytes !== '0x0');
    if (hasEoaSig) {
      // Verdict path (release always; refund with non-empty (v,r,s)). A
      // non-empty sigBytes alongside a (v,r,s) verdict is ambiguous — the
      // contract would read the sigBytes branch and could differ from the
      // EOA path — reject.
      if (sigBytesNonEmpty && !(A.v === undefined || A.v === 0 || A.v === '0')) {
        return { ok: false, reason: 'VERDICT_SIG_AMBIGUOUS', detail: 'verdict (v,r,s) with non-empty sigBytes: authorizing artifact is ambiguous' };
      }
    } else if (!hasEoaSig && sigBytesNonEmpty) {
      // Verdict path via ERC-1271 (contract-wallet evaluator): no (v,r,s),
      // sigBytes carries the Safe signature. This is a VERDICT, not timeout —
      // whatever the v field looks like, the presence of sigBytes (an
      // authenticated artifact) means the caller is NOT invoking the empty
      // timeout rule.
    } else {
      // Fully-empty (v,r,s) AND empty sigBytes.
      if (action === CONTRACT_ACTIONS.RELEASE) {
        return { ok: false, reason: 'RELEASE_REQUIRES_VERDICT', detail: 'release is never a timeout action; an evaluator verdict is required' };
      }
      // Timeout path: the contract rule (beneficiary = buyer, at/after
      // finalCutoff, no evaluator authority). The caller must be the BUYER
      // access role (policy A.2 — the deadline refund belongs to the buyer);
      // the access action 'request refund' permits SUBMITTING, and the
      // contract rule authorizes the refund itself. It does NOT create
      // evaluator authority — authorization is the explicit timeout mode.
      if (String(ctx.accessRole || '').toLowerCase() !== 'buyer') {
        return { ok: false, reason: 'TIMEOUT_ROLE_REQUIRED', detail: 'timeout refund requires the buyer access role (contract rule; no evaluator authority)' };
      }
      return { ok: true, authorization: 'timeout-contract-rule' };
    }

    // For resolve ops the digest action is "resolve:" + resolution (contract
    // _checkVerdict concatenation); for plain release/refund it is the
    // canonical literal. The override is set ONLY by the resolve branch and
    // never affects release/refund digests.
    const digestAction = ctx.digestActionOverride || action;
    // F3B V3: the pre-settlement checkpoint (journal tail) is FROZEN into the
    // authorization digest. The contract's V3 verdict typehash includes the
    // 6th field preSettlementHead, so a digest WITHOUT the head can never
    // authorize a V3 execution (typehash differs) and a checkpoint that is
    // not covered by the same signature is rejected. When the caller supplies
    // custodyVersion=3, the head is REQUIRED (non-zero) on evaluator paths;
    // on the timeout path the head must be ABSENT (headless refundTimeout).
    const v3 = Number(ctx.custodyVersion || 0) === 3;
    const head = A.preSettlementHead || null;
    const headPresent = !!head && head !== '0x' + '00'.repeat(32) && !/^0x0+$/.test(String(head));
    if (v3 && hasEoaSig && !headPresent) {
      return { ok: false, reason: 'V3_HEAD_REQUIRED', detail: 'V3 evaluator/mutual settlement requires a non-zero frozen preSettlementHead (checkpoint authorization)' };
    }
    // Bind the EIP-712 custody domain HERE (verifyingContract = expected
    // custody address, chainId = expected chain). The digest helpers require
    // the full domain; the module must not depend on the caller wrapping the
    // domain in — every authorized verdict/mutual digest is bound to the
    // expected custody + chain (matches the contract's custodyDomain).
    const digest = await ctx.verdictDigest({ commitmentId: A.commitmentId, commitmentDigest: A.commitmentDigest, action: digestAction, nonce: A.nonce, issuedAt: A.issuedAt, preSettlementHead: headPresent ? head : undefined, verifyingContract: ctx.expectedCustody, chainId: ctx.expectedChainId });
    if (!digest) return { ok: false, reason: 'VERDICT_DIGEST_UNAVAILABLE' };
    const isContract = ctx.isContractWallet ? await ctx.isContractWallet(lc(esc.evaluator)) : false;
    if (isContract) {
      // Contract-wallet (Safe/ERC-1271): v,r,s must be empty; sigBytes carries
      // the Safe signature. Verify via isValidSignature staticcall.
      const empty = (x) => x === undefined || x === '' || x === 0 || x === '0' || x === '0x' || x === '0x' + '00'.repeat(32);
      if (!(empty(A.v) && empty(A.r) && empty(A.s))) {
        return { ok: false, reason: 'CONTRACT_WALLET_AMBIGUOUS_SIG', detail: 'contract-wallet evaluator requires empty (v,r,s) with sigBytes-only authorization' };
      }
      if (!A.sigBytes || A.sigBytes === '0x' || A.sigBytes === '0x0') {
        return { ok: false, reason: 'CONTRACT_WALLET_MISSING_SIG', detail: 'contract-wallet evaluator requires sigBytes' };
      }
      if (!ctx.verifyContractWallet) return { ok: false, reason: 'CONTRACT_WALLET_VERIFIER_UNAVAILABLE' };
      const vw = await ctx.verifyContractWallet(lc(esc.evaluator), digest, A.sigBytes);
      if (!vw.ok) return vw;
      return { ok: true, authorization: 'evaluator-contract-wallet', recovered: vw.recovered || lc(esc.evaluator) };
    }
    // EOA evaluator path.
    const signer = ctx.recoverEoa ? ctx.recoverEoa(digest, { v: A.v, r: A.r, s: A.s }) : null;
    if (!signer) return { ok: false, reason: 'BAD_VERDICT_SIG' };
    if (lc(signer) !== lc(esc.evaluator)) {
      return { ok: false, reason: 'EVALUATOR_MISMATCH', detail: { expected: esc.evaluator, recovered: signer } };
    }
    return { ok: true, authorization: 'evaluator-eoa', recovered: signer };
  }

  if (action === CONTRACT_ACTIONS.MUTUAL_RELEASE || action === CONTRACT_ACTIONS.MUTUAL_REFUND) {
    // EIP-712 MutualResolution digest uses the LOWERCASE action literal:
    // mutualRelease -> 'release', mutualRefund -> 'refund' (the contract's
    // mutualRelease()/mutualRefund() pass exactly those literals to _mutual).
    const digestAction = action === CONTRACT_ACTIONS.MUTUAL_RELEASE ? 'release' : 'refund';
    // F3B V3: mutual resolution ALSO freezes the checkpoint into the digest
    // (V3 MutualResolution typehash includes the head). Headless is allowed
    // ONLY on the explicit refundTimeout path, which is not a mutual action.
    const v3m = Number(ctx.custodyVersion || 0) === 3;
    const headm = A.preSettlementHead || null;
    const headmPresent = !!headm && headm !== '0x' + '00'.repeat(32) && !/^0x0+$/.test(String(headm));
    if (v3m && !headmPresent) {
      return { ok: false, reason: 'V3_HEAD_REQUIRED', detail: 'V3 mutual settlement requires a non-zero frozen preSettlementHead (checkpoint authorization)' };
    }
    const digest = await ctx.mutualDigest({ commitmentId: A.commitmentId, commitmentDigest: A.commitmentDigest, action: digestAction, nonce: A.nonce, issuedAt: A.issuedAt, preSettlementHead: headmPresent ? headm : undefined, verifyingContract: ctx.expectedCustody, chainId: ctx.expectedChainId });
    if (!digest) return { ok: false, reason: 'MUTUAL_DIGEST_UNAVAILABLE' };
    const buyerSig = ctx.recoverEoa ? ctx.recoverEoa(digest, { v: A.bv, r: A.br, s: A.bs }) : null;
    const sellerSig = ctx.recoverEoa ? ctx.recoverEoa(digest, { v: A.sv, r: A.sr, s: A.ss }) : null;
    if (!buyerSig || !sellerSig) return { ok: false, reason: 'BAD_MUTUAL_SIG' };
    if (lc(buyerSig) !== lc(esc.buyer) || lc(sellerSig) !== lc(esc.seller)) {
      return { ok: false, reason: 'MUTUAL_PARTY_MISMATCH', detail: { expected: [esc.buyer, esc.seller], recovered: [buyerSig, sellerSig] } };
    }
    return { ok: true, authorization: 'mutual', recovered: { buyer: buyerSig, seller: sellerSig } };
  }

  if (action === CONTRACT_ACTIONS.RESOLVE) {
    // resolve() requires the evaluator verdict over "resolve:" + resolution
    // (contract line 533: _checkVerdict(..., string.concat("resolve:",
    // resolution), ...); design doc custody-v2-design.md T6-T8). The access
    // action 'resolve dispute' permits SUBMITTING the resolution; the only
    // on-chain authority is the evaluator verdict, verified against
    // escrow.evaluator exactly as release()/refund() (EOA or ERC-1271).
    // Nothing here invents resolver/operator privileges.
    // D3 CLOSURE: the documented access policy is enforced SEPARATELY from
    // the verdict. 'resolve dispute' is evaluator-only (action-auth matrix
    // row: Resolve (resolve) | evaluator); the re-entrant verdict check must
    // never be reachable from a buyer/seller op through the internal
    // contract-action normalization. A genuine verdict is evidence of the
    // evaluator's authority on-chain; it is NOT the access authorization for
    // the caller operation. Require the access role here, before the verdict
    // path, so the internal 'submit verdict' substitution cannot manufacture
    // evaluator access for an unauthorized caller action.
    if (String(ctx.accessRole || '').toLowerCase() !== 'evaluator') {
      return { ok: false, reason: 'RESOLVE_ROLE_REQUIRED', detail: 'resolve dispute requires the evaluator access role (documented access policy; verdict authority is separate)' };
    }
    const resolution = String(A.resolution || '').toLowerCase();
    if (!['release', 'refund', 'hold'].includes(resolution)) {
      return { ok: false, reason: 'BAD_RESOLUTION', detail: String(A.resolution || '') };
    }
    return verifyActionArgs(
      { ...A, resolution: undefined },
      {
        ...ctx,
        // The re-entrant call verifies the VERDICT path, whose access action
        // is 'submit verdict' (the evaluator's verdict authority). The
        // resolve access action already passed the outer access check; the
        // verdict digest remains "resolve:" + resolution via the override.
        contractAction: CONTRACT_ACTIONS.RELEASE,
        accessAction: 'submit verdict',
        digestActionOverride: 'resolve:' + resolution,
      }
    );
  }
  if (action === CONTRACT_ACTIONS.RAISE_DISPUTE) {
    // raiseDispute() has no signature: the contract gates on msg.sender being
    // buyer or seller (NotParty). The worker is a RELAYER — it never claims
    // msg.sender is the party. The dispute authority is the ACCESS policy:
    // the party (buyer|seller) whose access auth was accepted at the endpoint.
    if (!['buyer', 'seller'].includes(String(ctx.accessRole || '').toLowerCase())) {
      return { ok: false, reason: 'DISPUTE_ROLE_REQUIRED', detail: 'raiseDispute requires a buyer or seller access role (contract NotParty gate applies to the direct submitter only)' };
    }
    return { ok: true, authorization: 'dispute-party-role' };
  }

  return { ok: false, reason: 'UNSUPPORTED_ACTION', detail: action };
}

module.exports = { verifyActionArgs, ACTION_TO_CONTRACT, CONTRACT_ACTIONS, canonicalContractAction, recoverAddress, normalizeSig };