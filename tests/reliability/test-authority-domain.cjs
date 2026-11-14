// SAAX Protocol — MCP Lifecycle Phase 5C: EIP-712 authority-proof domain
// hardening conformance (isolated).
//   * proofDomainFor: optional chain binding (scope.chainId /
//     verificationMaterial chain hint), fail-closed on conflict/invalid.
//   * cross-chain replay rejected; unbound v1 domain remains compatible.
//   * real cose/jws authority-proof verification (Phase 5B verifier wired in).
//
// Usage: node tests/reliability/test-authority-domain.cjs
'use strict';

const { privateKeyToAccount } = require('viem/accounts');
const { CompactSign } = require('jose');
const crypto = require('crypto');
const authority = require('../../endpoint/authority.js');

let PASS = 0, FAIL = 0;
function check(name, ok, info) { ok ? PASS++ : FAIL++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + (info || ''))); }

(async () => {
  const ISSUER = privateKeyToAccount('0x' + '7'.repeat(64));
  const scope = { actions: ['submit_evidence'], chainId: 8453 };
  const scopeNoChain = { actions: ['submit_evidence'] };
  const scopeDigest = (s) => authority.scopeDigest(s);

  // --- proofDomainFor ---
  let d = authority.proofDomainFor({ scope: {} });
  check('D1-domain-unbound-no-chainId', d.chainId === undefined && d.name === 'SAAX Authority');
  d = authority.proofDomainFor({ scope: scope });
  check('D2-domain-scope-chainId', String(d.chainId) === '8453');
  d = authority.proofDomainFor({ scope: {}, verificationMaterial: 'chain:11155111' });
  check('D3-domain-vm-chain-hint', String(d.chainId) === '11155111');
  let threw = false;
  try { authority.proofDomainFor({ scope: { chainId: 'x' } }); } catch (e) { threw = true; }
  check('D4-domain-invalid-chain-throws', threw);
  threw = false;
  try { authority.proofDomainFor({ scope: scope, verificationMaterial: 'chain:1' }); } catch (e) { threw = true; }
  check('D5-domain-conflicting-bindings-throw', threw);

  // --- eip712 chain-bound valid / cross-chain replay / unbound compat ---
  const baseProof = {
    authorityProofId: 'ap-1', proofType: 'verifiable-intent',
    issuer: ISSUER.address, subject: '0x' + 'b'.repeat(40),
    validFrom: new Date(Date.now() - 60 * 1000).toISOString(),
    validUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
    verificationScheme: 'eip712',
  };
  const signAndCheck = async (proof, domain) => {
    const typed = { domain, types: authority.PROOF_TYPES, primaryType: 'AuthorityProof', message: {
      authorityProofId: proof.authorityProofId, issuer: proof.issuer, subject: proof.subject,
      validFrom: BigInt(Math.floor(Date.parse(proof.validFrom) / 1000)),
      validUntil: BigInt(Math.floor(Date.parse(proof.validUntil) / 1000)),
      scopeDigest: scopeDigest(proof.scope),
    }};
    proof.signature = await ISSUER.signTypedData(typed);
    return proof;
  };

  // C5: chain-bound valid
  const proofBound = await signAndCheck(Object.assign({}, baseProof, { scope }),
    { name: 'SAAX Authority', version: '1', chainId: BigInt(8453) });
  let r = await authority.verifyProofSignature(proofBound);
  check('D6-eip712-chain-bound-valid', r.ok === true, r.reason || '');

  // C6: cross-chain replay -> domain mismatch -> signature fails (or conflict)
  const proofWrongChain = Object.assign({}, proofBound, { verificationMaterial: 'chain:1' });
  r = await authority.verifyProofSignature(proofWrongChain);
  check('D7-eip712-cross-chain-replay-rejected', r.ok === false, r.reason || '');

  // C7: unbound v1 compat
  const proofUnbound = await signAndCheck(Object.assign({}, baseProof, { authorityProofId: 'ap-2', scope: scopeNoChain }),
    { name: 'SAAX Authority', version: '1' });
  r = await authority.verifyProofSignature(proofUnbound);
  check('D8-eip712-unbound-compat-valid', r.ok === true, r.reason || '');

  // --- real cose/jws authority proofs ---
  const { publicKey: edPub, privateKey: edPriv } = crypto.generateKeyPairSync('ed25519');
  const edJwk = edPub.export({ format: 'jwk' });
  const { publicKey: edPub2 } = crypto.generateKeyPairSync('ed25519');
  const edJwk2 = edPub2.export({ format: 'jwk' });
  const jwsPayload = { authorityProofId: 'ap-jws-1', scopeDigest: scopeDigest(scopeNoChain) };
  const tok = await new CompactSign(Buffer.from(JSON.stringify(jwsPayload))).setProtectedHeader({ alg: 'EdDSA' }).sign(edPriv);
  const proofJws = Object.assign({}, baseProof, { authorityProofId: 'ap-jws-1', issuer: '0x' + 'c'.repeat(40), verificationScheme: 'jws', signature: 'JWS_' + tok });
  r = await authority.verifyProofSignature(proofJws, { resolver: async () => edJwk });
  check('D9-jws-authority-proof-real-verified', r.ok === true, r.reason || '');
  r = await authority.verifyProofSignature(proofJws, { resolver: async () => edJwk2 });
  check('D10-jws-authority-proof-wrong-key-rejected', r.ok === false, r.reason || '');
  const fakeJws = Object.assign({}, proofJws, { signature: 'JWS_' + 'ab'.repeat(20) });
  r = await authority.verifyProofSignature(fakeJws, { resolver: async () => edJwk });
  check('D11-jws-authority-structural-rejected', r.ok === false, r.reason || '');

  console.log('\n==== PHASE 5C AUTHORITY DOMAIN: ' + PASS + '/' + (PASS + FAIL) + ' PASS ====');
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });