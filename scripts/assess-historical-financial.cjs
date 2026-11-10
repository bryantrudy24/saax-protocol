'use strict';
// Diagnostic, never upgrades the assurance level of historical signed records.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ethers } = require('ethers');
const { verifyCompactJws, jcs } = require('../verifier/verify-financial-export');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence/discovery-phase6');
const trust = JSON.parse(fs.readFileSync(path.join(OUT, 'trust.json')));
const TYPES = require('../verifier/financial-evidence').VERDICT_TYPES;
const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const iface = new ethers.Interface(require('../data/escrow-custody-build.json').abi);
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  const results = [];
  for (const kind of ['release', 'refund']) {
    const relative = 'evidence/discovery-phase5/real-sepolia-' + kind + '-export.json';
    const canonical = execFileSync('git', ['show', '8e763985:' + relative], { cwd: ROOT });
    const actual = fs.readFileSync(path.join(ROOT, relative));
    if (actual.toString('utf8').replace(/\r\n/g, '\n') !== canonical.toString('utf8')) throw Error('historical export changed');
    const exp = JSON.parse(actual);
    const unsigned = o => { const r = structuredClone(o); delete r.signature; return r; };
    const proposalSig = verifyCompactJws({ jws: exp.proposal.signature.jws,
      publicJwk: trust.provider.publicJwk, expectedKeyId: trust.provider.keyId, expectedPayload: unsigned(exp.proposal) });
    const buyerSig = verifyCompactJws({ jws: exp.acceptance.signature.jws,
      publicJwk: trust.buyer.publicJwk, expectedKeyId: trust.buyer.keyId, expectedPayload: unsigned(exp.acceptance) });
    const sr = JSON.parse(Buffer.from(exp.commitment.signedRepresentation.jws.split('.')[1], 'base64url').toString());
    const terminal = exp[kind];
    const [fundReceipt, receipt, tx] = await Promise.all([provider.getTransactionReceipt(exp.funding.fundTx),
      provider.getTransactionReceipt(terminal.tx), provider.getTransaction(terminal.tx)]);
    const call = iface.parseTransaction({ data: tx.data });
    const block = await provider.getBlock(receipt.blockNumber);
    const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: 84532, verifyingContract: exp.custody };
    const v = terminal.verdict;
    const recovered = ethers.verifyTypedData(domain, TYPES, { commitmentId: exp.commitment.commitmentId,
      commitmentDigest: exp.funding.commitmentDigest, action: kind, nonce: v.nonce, issuedAt: v.issuedAt }, {v:v.v,r:v.r,s:v.s});
    results.push({ path: relative, originalGitSha256: digest(canonical), workingBytesSha256: digest(actual), preservedExceptCheckoutLineEndings: true,
      signedNetwork: exp.proposal.terms.network, signedAsset: exp.proposal.terms.asset, signedDecimals: exp.proposal.terms.decimals,
      providerProposalSignatureValid: proposalSig.ok, buyerAcceptanceSignatureValid: buyerSig.ok,
      separatelySignedProfileExported: !!exp.providerProfile,
      signedEvaluatorRepresentation: sr.evaluator, buyerSignedFinancialAgreement: exp.proposal.terms.policies.financialAgreement || null,
      signedFulfillmentEvidence: !!exp.fulfillmentEvidence,
      execution: { rpcChain: Number((await provider.getNetwork()).chainId), fundingStatus: fundReceipt.status,
        terminalStatus: receipt.status, function: call.name, recoveredEvaluator: recovered,
        matchesFundedEvaluator: recovered.toLowerCase() === exp.funding.evaluator.toLowerCase(),
        timestampWindowValid: BigInt(v.issuedAt) <= BigInt(block.timestamp) + 120n && BigInt(block.timestamp) <= BigInt(v.issuedAt) + 300n },
      assurance: 'INCOMPLETE for authenticated discovery-to-finance; real testnet transactions and these narrower signatures remain valid. No retroactive profile/evaluator/evidence authorization can be added.' });
  }
  fs.writeFileSync(path.join(OUT, 'historical-assessment.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('Historical exports unchanged: both proposals genuinely testnet-bound; narrower signatures/transactions checked; complete profile/evaluator/evidence authorization INCOMPLETE.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => provider.destroy());
