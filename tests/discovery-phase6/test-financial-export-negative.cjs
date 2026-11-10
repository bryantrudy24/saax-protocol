'use strict';
// Full verifier positive control is read from public Base Sepolia. Cached reads
// below reuse identical public responses for mutations; they never declare
// invented transactions successful or use the application database.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JsonRpcProvider } = require('ethers');
const { verifyExport } = require('../../verifier/verify-financial-export');
const ROOT = path.resolve(__dirname, '../..');
const E = path.join(ROOT, 'evidence/discovery-phase6');
const load = f => JSON.parse(fs.readFileSync(path.join(E, f), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
async function main() {
  const real = new JsonRpcProvider('https://sepolia.base.org');
  const cache = new Map();
  const provider = {};
  for (const method of ['getNetwork', 'getCode', 'getTransaction', 'getTransactionReceipt', 'getBlock', 'send']) {
    provider[method] = async (...args) => {
      const key = method + ':' + JSON.stringify(args);
      if (!cache.has(key)) cache.set(key, Promise.resolve(real[method](...args)));
      return cache.get(key);
    };
  }
  const release = load('closeout-release-export.json'), refund = load('closeout-refund-export.json');
  const trust = load('trust.json'); const results = [];
  try {
    const good = await verifyExport(release, trust, undefined, { provider });
    assert.equal(good.verdict, 'VERIFIED', JSON.stringify(good.checks.filter(c => c.status !== 'PASS')));
    results.push({ name: 'full public-chain positive release control', verdict: good.verdict, checks: good.checks.length });
    const cases = [
      ['substituted funding transaction', x => { x.funding.fundTx = refund.funding.fundTx; x.funding.fundBlock = refund.funding.fundBlock; }, 'E_FUNDING_CALLDATA_BINDINGS'],
      ['substituted terminal transaction', x => { x.release.tx = refund.refund.tx; x.release.block = refund.refund.block; }, 'E_TERMINAL_CALLDATA'],
      ['wrong EIP712 domain', x => { x.release.verdict.domain.name = 'Other Custody'; }, 'E_COMPLETE_VERDICT_AUTHORIZATION'],
      ['wrong custody domain', x => { x.release.verdict.domain.verifyingContract = trust.buyer.address; }, 'E_VERDICT_DECLARED_DOMAIN'],
      ['wrong chain domain', x => { x.release.verdict.domain.chainId = 8453; }, 'E_VERDICT_DECLARED_DOMAIN'],
      ['invalid verdict signature artifact', x => { x.release.verdict.r = '0x' + '00'.repeat(32); }, 'E_COMPLETE_VERDICT_AUTHORIZATION'],
      ['forbidden verdict action', x => { x.release.verdict.action = 'refund'; }, 'E_COMPLETE_VERDICT_AUTHORIZATION'],
      ['expired verdict at execution', x => { x.release.verdict.issuedAt = String(BigInt(x.release.verdict.issuedAt) - 1000n); }, 'E_COMPLETE_VERDICT_AUTHORIZATION'],
      ['unauthorized agreement evaluator substitution', x => { x.proposal.terms.policies.financialAgreement.evaluator.address = trust.buyer.address; }, 'E_PROPOSAL_JWS'],
      ['missing signed testnet profile', x => { delete x.providerProfile.signature; }, 'E_PROVIDER_PROFILE_SIGNATURE_ENVELOPE'],
      ['mainnet network substitution', x => { x.proposal.terms.network = 'eip155:8453'; }, 'PROPOSAL_NETWORK'],
      ['wrong asset chain substitution', x => { x.proposal.terms.asset = x.proposal.terms.asset.replace('84532', '8453'); }, 'PROPOSAL_ASSET'],
      ['missing financial decimals', x => { delete x.proposal.terms.decimals; }, 'PROPOSAL_TOKEN_TERMS'],
      ['manifest substitution', x => { x.commitment.manifest.price.amount = '1001'; }, 'E_MANIFEST_HASH_RECOMPUTED'],
      ['forged deterministic fulfillment output', x => { x.fulfillmentEvidence.payload.outputSha256 = 'ff'.repeat(32); }, 'E_FULFILLMENT_CRITERION'],
      ['wrong evidence issuer', x => { x.fulfillmentEvidence.payload.issuer = trust.buyer.address; }, 'E_FULFILLMENT_BINDINGS'],
      ['substituted evaluator evidence binding', x => { x.release.evaluation.evidenceDigest = '0x' + 'ab'.repeat(32); }, 'E_EVALUATOR_EVIDENCE_BINDING'],
      ['buyer acceptance substitution', x => { x.acceptance.termsDigest = 'sha256:' + 'ab'.repeat(32); }, 'ACCEPTANCE_TERMS_DIGEST'],
      ['signed refund falsely labelled timeout', x => { x.kind = 'real-sepolia-refund'; delete x.release; x.refund = clone(refund.refund); x.refund.timeout = true; }, 'E_TERMINAL_COMMITMENT_BINDING'],
    ];
    for (const [name, mutate, code] of cases) {
      const exp = clone(release); mutate(exp);
      const r = await verifyExport(exp, trust, undefined, { provider });
      assert.equal(r.verdict, 'NOT VERIFIED', name);
      assert.ok(r.checks.some(c => c.code === code && c.status === 'FAIL'), name + ' missing expected ' + code);
      results.push({ name, verdict: r.verdict, expectedFailure: code, failures: r.checks.filter(c => c.status === 'FAIL').map(c => c.code) });
      console.log('[PASS] ' + name + ' -> ' + code);
    }
    const badTrust = clone(trust); badTrust.provider.providerId = 'https://untrusted.example/';
    const r = await verifyExport(release, badTrust, undefined, { provider });
    assert.equal(r.verdict, 'NOT VERIFIED');
    assert.ok(r.checks.some(c => c.code === 'E_PROVIDER_PROFILE_TRUST_BINDING' && c.status === 'FAIL'));
    results.push({ name: 'provider identity must match configured key mapping', verdict: r.verdict });
    const mislabeled = clone(refund); mislabeled.refund.timeout = true;
    const mr = await verifyExport(mislabeled, trust, undefined, { provider });
    assert.equal(mr.verdict, 'NOT VERIFIED');
    assert.ok(mr.checks.some(c => c.code === 'E_TERMINAL_MODE_LABEL' && c.status === 'FAIL'));
    results.push({ name: 'signed refund cannot be relabelled unsigned timeout', verdict: mr.verdict, expectedFailure: 'E_TERMINAL_MODE_LABEL' });
    fs.writeFileSync(path.join(E, 'full-verifier-negative-results.json'), JSON.stringify({
      timestamp: new Date().toISOString(), publicReadCacheEntries: cache.size,
      source: 'public Base Sepolia positive control; identical cached reads reused for mutations',
      passed: results.length, failed: 0, results }, null, 2) + '\n');
    console.log('FULL VERIFIER CASES: ' + results.length + ' passed, 0 failed');
  } finally { real.destroy(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
