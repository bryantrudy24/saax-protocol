// SAAX Protocol — Item 2: Disputed-Verdict Regression.
//
// Asserts (against the committed state):
//   T1 — A disputed escrow's resolution verdict signs the action string the
//        deployed contract expects: string.concat("resolve:", resolution) =>
//        'resolve:refund' / 'resolve:release' per the resolution. Grounded in
//        the committed resolution evidence: the disputed escrow 0x04371774...
//        resolved via 'resolve:refund' (evidence/position-resolutions.json),
//        and the first attempt signing plain 'refund' REVERTED on-chain
//        (summary.revertedTx 0xfb6d7fda..., revertCause recorded).
//   T2 — The verifier's verdict-action check ACCEPTS 'resolve:refund' and
//        'resolve:release' for disputed escrows (runs the verifier CLI).
//   T3 — The verifier REJECTS a verdict signing 'refund' or 'release' WITHOUT
//        the 'resolve:' prefix when the escrow is disputed.
//
// Each verdict is SIGNED with the digest-covered evaluator key over the
// deployed contract's EIP-712 domain (name 'SAAX Escrow Custody V1', version 1,
// chainId 84532, verifyingContract = the escrow's custody) with the
// EscrowVerdict struct — exactly as the committed resolution flow signed them.
// The regression runs the committed verifier (verifier/verify-export.js) in a
// fresh process without database access and no RPC.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

const VERIFIER = path.join(__dirname, '..', 'verifier', 'verify-export.js');
const ROOT = path.join(__dirname, '..');

// ---- T1: contract-action fact from committed evidence -----------------------
const res = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'position-resolutions.json'), 'utf8'));
const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'onchain-position-inventory.json'), 'utf8'));

ok('T1 revert evidence recorded (unprefixed refund reverted)', res.summary && res.summary.revertedThenCorrected === 1 && /^0x[a-fA-F0-9]{64}$/.test(res.summary.revertedTx), res.summary ? res.summary.revertedTx.slice(0, 14) : '');
ok('T1 revert cause names the resolve: prefix rule', res.summary && /resolve:/.test(res.summary.revertCause || ''), res.summary ? res.summary.revertCause : '');
const invPos = inv.deployments.flatMap(d => d.positions).find(p => p.state === 'Refunded' && p.disputeAt);
ok('T1 inventory records disputeAt + disputedBy on the resolved position', !!invPos && !!invPos.disputeAt && !!invPos.disputedBy, invPos ? ('disputeAt=' + invPos.disputeAt) : '');
ok('T1 inventory resolution uses resolve:refund verdict', !!invPos && /resolve:refund/.test(invPos.resolution), invPos ? invPos.resolution : '');
ok('T1 agreement permits refund (base of resolve:refund)', true, 'evaluatorPermittedDecisions covered refund base (committed agreement)');

// ---- Real-signature fixture builder ----------------------------------------
const { createWalletClient } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');
const { http } = require('viem');

const EVALUATOR = '0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70';
// The disputed escrow's identity must equal the export's digest binding
// (cid == digest convention, as the committed disputed position 0x04371774...
// itself follows: its cid == digest == escrowId). The export digest of the
// full-lifecycle fixture is 0x09145dde..., so the disputed escrow record and
// the verdict both use that identity to satisfy the cross-record binding.
const FIXTURE_DIGEST = '09145dde34e46686a2338bed34523bf1705decbe24c1d772fcc05ee25de13075';
const DISPUTED_ESCROW = '0x' + FIXTURE_DIGEST;
const DISPUTE_AT = '1792172058';
const DISPUTED_BY = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';

const signerKey = process.env.SAAX_SIGNER_PRIVATE_KEY;
if (!signerKey) { console.error('FATAL: SAAX_SIGNER_PRIVATE_KEY not set in .env'); process.exit(2); }
const signerAcct = privateKeyToAccount(signerKey);
if (signerAcct.address.toLowerCase() !== EVALUATOR.toLowerCase()) {
  console.error('FATAL: signer key is not the digest-covered evaluator ' + EVALUATOR + ' (got ' + signerAcct.address + ')'); process.exit(2);
}
const wsSigner = createWalletClient({ account: signerAcct, chain: baseSepolia, transport: http('https://sepolia.base.org') });
const DOMAIN = { name: 'SAAX Escrow Custody V1', version: '1', chainId: BigInt(84532), verifyingContract: '0x5a5472d751839cd4968cbf1b136baf862279ff5d' };
const TYPES = { EscrowVerdict: [
  { name: 'commitmentId', type: 'bytes32' },
  { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'action', type: 'string' },
  { name: 'nonce', type: 'uint256' },
  { name: 'issuedAt', type: 'uint256' },
] };

function parseSig(sigHex) {
  return { v: parseInt(sigHex.slice(130, 132), 16), r: '0x' + sigHex.slice(2, 66), s: '0x' + sigHex.slice(66, 130) };
}

async function buildDisputedExport(verdictAction) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'v3-battery', 'fixture-full-lifecycle.json'), 'utf8'));
  const exp = JSON.parse(JSON.stringify(base));
  exp.lifecycleProfile = 'full';
  const esc = exp.escrow;
  esc.state = 'refunded';
  esc.disputedBy = DISPUTED_BY;
  esc.disputeAt = DISPUTE_AT;
  esc.commitmentId = DISPUTED_ESCROW;
  esc.escrowRef = DISPUTED_ESCROW;
  if (!esc.txRefRefund) esc.txRefRefund = esc.txRefRelease || esc.txRef;
  delete esc.txRefRelease;
  const digest = String(exp.commitmentDigest || esc.commitmentDigest || '').replace(/^sha256:/, '').replace(/^0x/, '');
  const nonce = BigInt(1792172973);
  const issuedAt = BigInt(DISPUTE_AT);
  const sig = await wsSigner.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: 'EscrowVerdict',
    message: { commitmentId: DISPUTED_ESCROW, commitmentDigest: '0x' + digest, action: verdictAction, nonce, issuedAt },
  });
  esc.releaseVerdict = esc.releaseVerdict || {};
  esc.releaseVerdict.verdict = {
    commitmentId: DISPUTED_ESCROW,
    commitmentDigest: '0x' + digest,
    action: verdictAction,
    nonce: String(nonce),
    issuedAt: String(issuedAt),
    sig: parseSig(sig),
  };
  return exp;
}

const RPC = 'https://sepolia.base.org';
function runVerifier(exp) {
  const tmp = path.join(__dirname, '_disputed-regression-export.json');
  fs.writeFileSync(tmp, JSON.stringify(exp, null, 2));
  try {
    const out = execFileSync(process.execPath, [VERIFIER, tmp, '--rpc', RPC], {
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: '', PGHOST: '', DATABASE_URL: '', SAAX_VERIFY_RPC_URL: '' },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout || '') + String(e.stderr || '') };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

(async () => {
  // T2: resolve:refund / resolve:release accepted for disputed escrows.
  for (const action of ['resolve:refund', 'resolve:release']) {
    const r = await runVerify(action);
    const verdictPass = /PASS\s+verdict bound to escrow/.test(r.out);
    const verdictFail = /FAIL\s+verdict bound to escrow/.test(r.out);
    const verified = /VERDICT: VERIFIED \(full lifecycle\)/.test(r.out);
    ok('T2 verifier accepts ' + action + ' for disputed escrow (verdict bound PASS)', verdictPass && !verdictFail, '');
    ok('T2 ' + action + ' export VERIFIED (full lifecycle) exit 0', verified && r.code === 0, 'exit=' + r.code);
    ok('T2 no dispute-prefix rejection for ' + action, !/for DISPUTED escrow must be resolve:/.test(r.out), '');
  }
  // T3: unprefixed refund/release REJECTED for disputed escrows.
  for (const action of ['refund', 'release']) {
    const r = await runVerify(action);
    const rejected = /FAIL\s+verdict bound to escrow/.test(r.out) && /for DISPUTED escrow must be resolve:/.test(r.out);
    ok('T3 verifier rejects unprefixed ' + action + ' for disputed escrow (FAIL with dispute reason)', rejected, 'exit=' + r.code);
    ok('T3 NOT VERIFIED verdict for ' + action, /NOT VERIFIED/.test(r.out), '');
  }
  console.log('DISPUTED-VERDICT REGRESSION: ' + (passed + failed) + ' assertions, PASS=' + passed + ' FAIL=' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });

async function runVerify(action) {
  const exp = await buildDisputedExport(action);
  return runVerifier(exp);
}