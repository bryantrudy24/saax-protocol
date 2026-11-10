// F3B — worker-side V3 custody digest helper (LOCAL TEST ONLY).
//
// Exposes the SAME interface as mainnet/design/support/v4-signatures.js
// (verdictDigest/mutualDigest taking one object with commitmentId,
// commitmentDigest, action, nonce, issuedAt, preSettlementHead,
// verifyingContract, chainId) but computes the V3 6-field head-bound EIP-712
// digests exactly as SAAXEscrowCustodyV3.sol does:
//   domain: SAAX Escrow Custody V3 / '3' / chainId / verifyingContract
//   EscrowVerdict(...,bytes32 preSettlementHead)
//   MutualResolution(...,bytes32 preSettlementHead)
'use strict';

const { ethers } = require('ethers');

const DOMAIN_NAME = 'SAAX Escrow Custody V3';
const DOMAIN_VERSION = '3';

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

function domain(p) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: p.chainId, verifyingContract: p.verifyingContract };
}

async function verdictDigest(p) {
  return ethers.TypedDataEncoder.hash(domain(p), VERDICT_TYPES, {
    commitmentId: p.commitmentId, commitmentDigest: p.commitmentDigest, action: p.action,
    nonce: p.nonce, issuedAt: p.issuedAt, preSettlementHead: p.preSettlementHead || ethers.ZeroHash,
  });
}

async function mutualDigest(p) {
  return ethers.TypedDataEncoder.hash(domain(p), MUTUAL_TYPES, {
    commitmentId: p.commitmentId, commitmentDigest: p.commitmentDigest, action: p.action,
    nonce: p.nonce, issuedAt: p.issuedAt, preSettlementHead: p.preSettlementHead || ethers.ZeroHash,
  });
}

module.exports = { verdictDigest, mutualDigest, DOMAIN_NAME, DOMAIN_VERSION };