// SAAX F3A — Version-explicit V3 custody signature helper (LOCAL TEST ONLY).
//
// Implements the V3 EIP-712 signing specification exactly as the contract
// SAAXEscrowCustodyV3.sol computes it:
//   domain: SAAX Escrow Custody V3 / "3" / chainId / verifyingContract
//   EscrowVerdict(bytes32 commitmentId,bytes32 commitmentDigest,string action,
//                 uint256 nonce,uint256 issuedAt,bytes32 preSettlementHead)
//   MutualResolution(bytes32 commitmentId,bytes32 commitmentDigest,string action,
//                 uint256 nonce,uint256 issuedAt,bytes32 preSettlementHead)
//
// The V2-era helpers (SAAX Escrow Custody V2 5-field types) are preserved
// inline in scripts/test-custody-v2*.cjs and are NOT touched: V2-era
// signatures must remain verifiable under the V2 identity policy. This module
// is additive and version-explicit ("V3" in every exported function name).
'use strict';

const V3_DOMAIN_NAME = 'SAAX Escrow Custody V3';
const V3_DOMAIN_VERSION = '3';

const V3_VERDICT_TYPEHASH = 'EscrowVerdict(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt,bytes32 preSettlementHead)';
const V3_MUTUAL_TYPEHASH = 'MutualResolution(bytes32 commitmentId,bytes32 commitmentDigest,string action,uint256 nonce,uint256 issuedAt,bytes32 preSettlementHead)';

const VERDICT_TYPES = {
  EscrowVerdict: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'preSettlementHead', type: 'bytes32' },
  ],
};

const MUTUAL_TYPES = {
  MutualResolution: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'commitmentDigest', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'preSettlementHead', type: 'bytes32' },
  ],
};

function v3Domain(chainId, verifyingContract) {
  return { name: V3_DOMAIN_NAME, version: V3_DOMAIN_VERSION, chainId, verifyingContract };
}

// Independent recomputation of the exact typehash strings (self-check).
function v3Typehash(name, fields) {
  const s = name + '(' + fields.map((f) => f.type + ' ' + f.name).join(',') + ')';
  const { keccak256, toUtf8Bytes } = require('ethers');
  return keccak256(toUtf8Bytes(s));
}

// EIP-712 digest of a V3 verdict (evaluator settlement with head).
function v3VerdictDigest(ethers, custodyAddr, chainId, id, digest, action, nonce, issuedAt, head) {
  return ethers.TypedDataEncoder.hash(
    v3Domain(chainId, custodyAddr),
    VERDICT_TYPES,
    { commitmentId: id, commitmentDigest: digest, action, nonce, issuedAt, preSettlementHead: head }
  );
}

// EIP-712 digest of a V3 mutual resolution (buyer+seller with head).
function v3MutualDigest(ethers, custodyAddr, chainId, id, digest, action, nonce, issuedAt, head) {
  return ethers.TypedDataEncoder.hash(
    v3Domain(chainId, custodyAddr),
    MUTUAL_TYPES,
    { commitmentId: id, commitmentDigest: digest, action, nonce, issuedAt, preSettlementHead: head }
  );
}

// Sign a V3 verdict with an EOA signer (returns ethers Signature).
async function v3SignVerdict(ethers, signer, custodyAddr, chainId, id, digest, action, nonce, issuedAt, head) {
  return ethers.Signature.from(await signer.signTypedData(
    v3Domain(chainId, custodyAddr),
    VERDICT_TYPES,
    { commitmentId: id, commitmentDigest: digest, action, nonce, issuedAt, preSettlementHead: head }
  ));
}

// Sign a V3 mutual resolution with an EOA party signer.
async function v3SignMutual(ethers, signer, custodyAddr, chainId, id, digest, action, nonce, issuedAt, head) {
  return ethers.Signature.from(await signer.signTypedData(
    v3Domain(chainId, custodyAddr),
    MUTUAL_TYPES,
    { commitmentId: id, commitmentDigest: digest, action, nonce, issuedAt, preSettlementHead: head }
  ));
}

module.exports = {
  V3_DOMAIN_NAME,
  V3_DOMAIN_VERSION,
  V3_VERDICT_TYPEHASH,
  V3_MUTUAL_TYPEHASH,
  VERDICT_TYPES,
  MUTUAL_TYPES,
  v3Domain,
  v3Typehash,
  v3VerdictDigest,
  v3MutualDigest,
  v3SignVerdict,
  v3SignMutual,
};