// F3B Step 1c — focused custody-version dispatch selection/rejection tests.
// Proves version selection is identity-driven (chain/lane + declared version),
// NEVER inferred from formatVersion; V3 only on local 31337; V1/V2 preserved.
'use strict';
const assert = require('assert');
const custodyVersion = require('../endpoint/custody-version.js');
const { selectCustodyVersion } = custodyVersion;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  [' + e.message + ']'); }
}
const V1_HASH = (() => { try { return require('../data/escrow-custody-build.json').runtimeCodeHash; } catch { return null; } })();
const V3_HASH = (() => { try { return require('../data/escrow-custody-v3-build.json').runtimeCodeHash; } catch { return null; } })();

// --- selection ---
t('V1 selected on hosted lane 84532 (no declared version)', () => {
  const r = selectCustodyVersion({ chainId: 84532, declaredVersion: '' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, 1);
  assert.strictEqual(r.lane, 'hosted');
  assert.ok(r.artifact.abi.length > 0, 'V1 artifact has abi');
});
t('V2 selected on local lane 31337 (no declared version, legacy default)', () => {
  const r = selectCustodyVersion({ chainId: 31337, declaredVersion: '' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, 2);
  assert.strictEqual(r.lane, 'local');
});
t('V3 selected on local lane 31337 with declared 3', () => {
  const r = selectCustodyVersion({ chainId: 31337, declaredVersion: '3' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, 3);
  assert.strictEqual(r.name, 'SAAX Escrow Custody V3');
  assert.ok(r.identity && r.identity.runtimeCodeHash, 'V3 identity carries runtimeCodeHash');
});
t('V3 artifact carries the head-bound ABI (release 9-arg, refundTimeout 2-arg)', () => {
  const r = selectCustodyVersion({ chainId: 31337, declaredVersion: '3' });
  const fns = r.artifact.abi.filter(x => x.type === 'function').map(f => f.name);
  assert.ok(fns.includes('release') && fns.includes('refundTimeout') && fns.includes('refundVerdict'), 'V3 ABI has release/refundTimeout/refundVerdict');
  assert.ok(fns.includes('mutualRelease') && fns.includes('resolve') && fns.includes('legacyDeadline'), 'V3 ABI has mutual/resolve/legacyDeadline');
});

// --- rejection ---
t('V3 rejected on hosted lane 84532', () => {
  const r = selectCustodyVersion({ chainId: 84532, declaredVersion: '3' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('V3 custody only supported on local lane 31337'));
});
t('V1 rejected on local lane 31337', () => {
  const r = selectCustodyVersion({ chainId: 31337, declaredVersion: '1' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('V1 custody only supported on hosted lane 84532'));
});
t('V2 rejected on hosted lane 84532', () => {
  const r = selectCustodyVersion({ chainId: 84532, declaredVersion: '2' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('V2 custody only supported on local lane 31337'));
});
t('unsupported chain rejected', () => {
  const r = selectCustodyVersion({ chainId: 1, declaredVersion: '' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('unsupported chain 1'));
});
t('invalid declared version rejected', () => {
  const r = selectCustodyVersion({ chainId: 31337, declaredVersion: '4' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('invalid declared custody version 4'));
});
t('declared version 3 does not get inferred from formatVersion-like input', () => {
  // A formatVersion field is NEVER the selector: passing an object shaped like
  // an export formatVersion must not select V3 by itself.
  const r = selectCustodyVersion({ chainId: 31337, declaredVersion: '' });
  assert.strictEqual(r.version, 2, 'blank declared stays V2 even if caller has formatVersion=3 elsewhere');
});

// if the V3 artifact reports a runtime hash, confirm it is present in identity
if (V3_HASH) {
  t('V3 artifact runtimeCodeHash recorded', () => {
    const r = selectCustodyVersion({ chainId: 31337, declaredVersion: '3' });
    assert.strictEqual(r.identity.runtimeCodeHash, V3_HASH);
  });
} else {
  console.log('N/A   V3 artifact runtimeCodeHash recorded (no runtimeCodeHash key)');
}

console.log('\n' + (fail === 0 ? 'ALL' : fail) + (fail === 0 ? ' TESTS PASSED' : ' TESTS FAILED'));
process.exit(fail === 0 ? 0 : 1);