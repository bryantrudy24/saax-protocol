// SAAX Standalone Verifier — crypto helpers (Dependency 5)
//
// Uses @noble/hashes (keccak_256) + @noble/curves (secp256k1 recovery) —
// audited, documented libraries, EXPLICITLY permitted by the mandate for a
// separate verifier process.
'use strict';

const { keccak_256 } = require('@noble/hashes/sha3');
const { secp256k1 } = require('@noble/curves/secp256k1');

function keccak256Bytes(input) {
  return keccak_256(Buffer.isBuffer(input) ? input : Buffer.from(input));
}
function keccak256Hex(input) {
  return '0x' + Buffer.from(keccak256Bytes(Buffer.from(input, 'utf8'))).toString('hex');
}
function sha256Hex(s) {
  return require('crypto').createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// ---- EIP-712 hashing (canonical, reimplemented per EIP-712 spec) --------------
function encodeType(primaryType, types) {
  const deps = [];
  const seen = new Set([primaryType]);
  const queue = [primaryType];
  while (queue.length) {
    const t = queue.shift();
    deps.push(t);
    for (const f of types[t] || []) {
      const base = f.type.replace(/\[\]$/, '');
      if (types[base] && !seen.has(base)) { seen.add(base); queue.push(base); }
    }
  }
  const rest = deps.slice(1).sort();
  return primaryType + '(' + (types[primaryType] || []).map(f => f.type + ' ' + f.name).join(',') + ')'
    + rest.map(t => t + '(' + (types[t] || []).map(f => f.type + ' ' + f.name).join(',') + ')').join('');
}

function typeHash(primaryType, types) {
  return Buffer.from(keccak256Bytes(Buffer.from(encodeType(primaryType, types), 'utf8')));
}

// Encode one VALUE to its 32-byte word (per EIP-712 ABI encoding).
function encodeValue(type, value, types) {
  const base = type.replace(/\[\]$/, '');
  if (type === 'bytes32') {
    const hex = String(value).replace(/^0x/, '');
    return Buffer.from(hex.padStart(64, '0').slice(0, 64), 'hex');
  }
  if (type === 'string') {
    return Buffer.from(keccak256Bytes(Buffer.from(String(value), 'utf8')));
  }
  if (type === 'bytes') {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value).replace(/^0x/, ''), 'hex');
    return Buffer.from(keccak256Bytes(b));
  }
  if (type === 'bool') {
    return Buffer.from((value ? 1 : 0).toString(16).padStart(64, '0'), 'hex');
  }
  if (type.startsWith('uint')) {
    return Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');
  }
  if (type === 'address') {
    const hex = String(value).replace(/^0x/, '').toLowerCase();
    return Buffer.from(hex.padStart(64, '0'), 'hex');
  }
  if (types[base]) {
    // nested struct: encode its fields then keccak
    const enc = encodeData(base, types, value);
    return Buffer.from(keccak256Bytes(enc));
  }
  if (type.endsWith('[]')) {
    const items = Array.isArray(value) ? value : [];
    const parts = items.map(x => Buffer.from(keccak256Bytes(encodeData(base, types, x))));
    return Buffer.from(keccak256Bytes(Buffer.concat(parts)));
  }
  throw new Error('unsupported EIP-712 type ' + type);
}

// Encode a struct's FIELDS in order to a byte buffer (each value -> 32 bytes).
function encodeData(primaryType, types, data) {
  const fields = types[primaryType] || [];
  const parts = [];
  for (const f of fields) {
    parts.push(encodeValue(f.type, data[f.name], types));
  }
  return Buffer.concat(parts);
}

function structHash(primaryType, types, data) {
  return Buffer.from(keccak256Bytes(Buffer.concat([typeHash(primaryType, types), encodeData(primaryType, types, data)])));
}

function domainSeparator(domain) {
  const dtypes = { EIP712Domain: [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
  ] };
  return structHash('EIP712Domain', dtypes, {
    name: domain.name || '', version: domain.version || '',
    chainId: BigInt(domain.chainId || 0), verifyingContract: domain.verifyingContract || '0x0000000000000000000000000000000000000000',
  });
}

function eip712Hash(domain, types, primaryType, message) {
  return keccak256Bytes(Buffer.concat([
    Buffer.from('\x19\x01', 'utf8'), domainSeparator(domain), structHash(primaryType, types, message),
  ]));
}

// ---- secp256k1 recovery (v,r,s -> signer address) -----------------------------
function recoverSignerFromSig(msgHash, { v, r, s }) {
  const rBuf = Buffer.isBuffer(r) ? r : Buffer.from(String(r).replace(/^0x/, ''), 'hex');
  const sBuf = Buffer.isBuffer(s) ? s : Buffer.from(String(s).replace(/^0x/, ''), 'hex');
  try {
    const sigObj = secp256k1.Signature.fromCompact(Buffer.concat([rBuf, sBuf]));
    const rec = sigObj.addRecoveryBit(v - 27);
    const pub = rec.recoverPublicKey(msgHash).toRawBytes(false);
    const hash = Buffer.from(keccak256Bytes(pub.subarray(1)));
    return '0x' + hash.subarray(12).toString('hex');
  } catch (e) {
    return null;
  }
}

module.exports = { keccak256Bytes, keccak256Hex, sha256Hex, eip712Hash, structHash, recoverSignerFromSig, encodeType, encodeData };
