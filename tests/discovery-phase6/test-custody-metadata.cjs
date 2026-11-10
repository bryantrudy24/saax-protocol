'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeCbor, describe, extractArtifactRuntime } = require('../../scripts/check-custody-identity.cjs');
const artifact = require('../../data/escrow-custody-build.json');
const creation = Buffer.from(artifact.bytecode.slice(2), 'hex');
const runtime = extractArtifactRuntime(creation).runtime;
test('actual metadata is 51-byte CBOR plus 2-byte length; exact arithmetic', () => {
  const info = describe(runtime, 'fixture artifact runtime');
  assert.equal(info.fullBytes, 6934); assert.equal(info.executableBytes, 6881);
  assert.equal(info.metadataBytes, 51); assert.equal(info.trailerBytes, 2);
  assert.equal(info.trailerHex, '0x0033'); assert.equal(info.solc, '0.8.26');
  assert.equal(info.fullKeccak256, '0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473');
});
test('CBOR consumes exactly the map, not guessed padding', () => {
  assert.throws(() => decodeCbor(Buffer.from('a164736f6c634300081a00', 'hex')), /consume exactly/);
});
test('CBOR invalid length/truncation rejected', () => {
  const corrupt = Buffer.from(runtime); corrupt.writeUInt16BE(65535, corrupt.length - 2);
  assert.throws(() => describe(corrupt, 'bad'), /impossible CBOR length/);
  assert.throws(() => decodeCbor(Buffer.from('a164736f6c6343', 'hex')), /truncated/);
});
test('CBOR duplicate map key rejected', () => {
  assert.throws(() => decodeCbor(Buffer.from('a2616101616102', 'hex')), /duplicate/);
});
test('non-Solidity initcode is not guessed to be artifact runtime', () => {
  assert.throws(() => extractArtifactRuntime(Buffer.from('60006000', 'hex')), /unrecognized/);
});
test('definite CBOR booleans decode when compiler adds experimental flag', () => {
  assert.equal(decodeCbor(Buffer.from('a16178f5', 'hex')).get('x'), true);
});
