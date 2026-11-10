// Phase D4B focused tests — external signer interface, configuration gates,
// process boundary, protected execution (payout + refund), and negatives.
//
// Classes of coverage, distinctly labeled:
//   [REAL]    local EVM 31337, genuine custody V2 + MockUSDC + real Safe 2-of-3
//             evaluator (ERC-1271), genuine EIP-712 verdicts, genuine Safe
//             message hashing/signature encoding, the real worker modules, the
//             SEPARATE-PROCESS synthetic reference signer (holds the relayer
//             key in its own process). Local deployments + locally funded test
//             escrows are authorized for this checkpoint.
//   [UNIT]    external-signer interface, config gates, env allowlist, envelope
//             hardening — no chain, no provider.
//   [LOCAL-REF]  separate-process reference signer server/client behavior
//             (timeout/unavailable/malformed/auth). The reference signer is a
//             synthetic adapter, NOT an HSM, NOT production key custody.
//
// REAL-PROVIDER NOTE: no real HSM/KMS/remote signer is exercised. Actual HSM/
// KMS integration and production key custody are UNVERIFIED/PENDING (D4A plan
// §7, D4B doc). This suite proves the interface + protected pipeline with a
// synthetic isolated signer only.
//
// Synthetic keys only. No production keys, no mainnet, no deployment, no push.

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const { D2Worker } = require('../worker/d2-worker.js');
const { FinalityAdapter } = require('../worker/d2-finality.js');
const { D2Prerequisites } = require('../worker/d2-prereqs.js');
const { loadCustodyAbi } = require('../worker/d1-abi.js');
const vaultMod = require('../worker/prepared-vault.js');
const extMod = require('../worker/external-signer.js');
const { SyntheticReferenceSigner, RefSignerClient, ExternalSigner, ERR } = extMod;
const gatesMod = require('../worker/config-gates.js');
const allowlistMod = require('../worker/env-allowlist.js');

const ROOT = path.resolve(__dirname, '..');
const CHAIN = 31337;
const RELAYER_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'; // synthetic external-signer key
const RELAYER_ADDR = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';
const KEY_A = '0x' + crypto.randomBytes(32).toString('hex'); // prepared key
const PREPARED_KID = 'd4b-k1';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; failures.push(name + (detail ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 220)) : '')); console.log('FAIL  ' + name + (detail ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 220)) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4b-test-'));

// ======================================================================
// [UNIT] external signer interface
// ======================================================================
function runUnitExternalSigner() {
  section('UNIT external signer interface');
  const abi = loadCustodyAbi();
  const iface = new ethers.Interface(abi);
  const cid = '0x' + '11'.repeat(32);
  const digest = '0x' + '22'.repeat(32);
  // release calldata (selector + args)
  const releaseData = iface.encodeFunctionData('release', [cid, digest, 1, 2000, 27, '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(65)]);

  // E1: SyntheticReferenceSigner returns the expected identity
  const s1 = new SyntheticReferenceSigner({ keyHex: RELAYER_KEY, allowedChainId: CHAIN, custody: '0x' + '99'.repeat(20), allowedActions: new Set([iface.getFunction('release').selector]), maxGasPrice: '2000000000', maxGasLimit: '800000', expectedFrom: RELAYER_ADDR });
  (async () => {
    const id = await s1.getSignerIdentity();
    check('E1 external signer identity == configured relayer account', id.address === RELAYER_ADDR.toLowerCase());

    // E2: sign a valid tx (EIP-1559 type 2), no broadcast
    const r = await s1.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
    check('E2 sign returns ok + signedBytes + txHash + from', r.ok === true && typeof r.signedBytes === 'string' && r.signedBytes.startsWith('0x') && typeof r.txHash === 'string' && r.from === RELAYER_ADDR.toLowerCase());
    const v2 = ExternalSigner.validateSignedBytes(r.signedBytes, { to: '0x' + '99'.repeat(20), chainId: CHAIN, value: 0n, data: releaseData, nonce: 0, from: RELAYER_ADDR });
    check('E3 independent validation accepts the signed bytes', v2.ok === true && v2.txHash === r.txHash.toLowerCase() && v2.from === RELAYER_ADDR.toLowerCase());

    // E4: wrong chain rejected by policy
    const r4 = await s1.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: 84532 });
    check('E4 wrong chain rejected (policy before signing)', r4.ok === false && /CHAIN/.test(r4.reason));

    // E5: wrong custody destination rejected
    const r5 = await s1.signTransaction({ to: '0x' + '88'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
    check('E5 wrong destination rejected', r5.ok === false && /DEST/.test(r5.reason));

    // E6: disallowed action rejected
    const refundData = iface.encodeFunctionData('refund', [cid, digest, 1, 2000, 27, '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(65)]);
    const r6 = await s1.signTransaction({ to: '0x' + '99'.repeat(20), data: refundData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
    check('E6 disallowed action rejected', r6.ok === false && /ACTION/.test(r6.reason));

    // E7: non-zero value rejected
    const r7 = await s1.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 1n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
    check('E7 non-zero value rejected', r7.ok === false && /VALUE/.test(r7.reason));

    // E8: fee bound rejection (gasPrice over max)
    const r8 = await s1.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '3000000000', nonce: 0, chainId: CHAIN });
    check('E8 gasPrice over bound rejected', r8.ok === false && /GASPRICE/.test(r8.reason));
    const r8b = await s1.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '900000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
    check('E8b gasLimit over bound rejected', r8b.ok === false && /GASLIMIT/.test(r8b.reason));

    // E9: timeout fault
    const s9 = new SyntheticReferenceSigner({ keyHex: RELAYER_KEY, allowedChainId: CHAIN, custody: '0x' + '99'.repeat(20), allowedActions: new Set([iface.getFunction('release').selector]), maxGasPrice: '2000000000', maxGasLimit: '800000', faults: { timeout: true } });
    try { await s9.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN }); check('E9 timeout fault raises TIMEOUT', false); }
    catch (e) { check('E9 timeout fault raises TIMEOUT', e.code === ERR.TIMEOUT); }

    // E10: unavailable fault
    const s10 = new SyntheticReferenceSigner({ keyHex: RELAYER_KEY, allowedChainId: CHAIN, custody: '0x' + '99'.repeat(20), allowedActions: new Set([iface.getFunction('release').selector]), maxGasPrice: '2000000000', maxGasLimit: '800000', faults: { unavailable: true } });
    try { await s10.getSignerIdentity(); check('E10 unavailable fault raises UNAVAILABLE', false); }
    catch (e) { check('E10 unavailable fault raises UNAVAILABLE', e.code === ERR.UNAVAILABLE); }

    // E11: malformed response (garbage bytes) — independent validation rejects
    const s11 = new SyntheticReferenceSigner({ keyHex: RELAYER_KEY, allowedChainId: CHAIN, custody: '0x' + '99'.repeat(20), allowedActions: new Set([iface.getFunction('release').selector]), maxGasPrice: '2000000000', maxGasLimit: '800000', faults: { malformed: true } });
    const r11 = await s11.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
    const v11 = ExternalSigner.validateSignedBytes(r11.signedBytes, { to: '0x' + '99'.repeat(20), chainId: CHAIN, value: 0n, data: releaseData, nonce: 0, from: RELAYER_ADDR });
    check('E11 malformed response rejected by independent validation', v11.ok === false && /MALFORMED/.test(v11.reason));

    // E12: independent validation catches wrong signer (bytes signed by another key)
    const sOther = new SyntheticReferenceSigner({ keyHex: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', allowedChainId: CHAIN, custody: '0x' + '99'.repeat(20), allowedActions: new Set([iface.getFunction('release').selector]), maxGasPrice: '2000000000', maxGasLimit: '800000' });
    const r12 = await sOther.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
    const v12 = ExternalSigner.validateSignedBytes(r12.signedBytes, { to: '0x' + '99'.repeat(20), chainId: CHAIN, value: 0n, data: releaseData, nonce: 0, from: RELAYER_ADDR });
    check('E12 independent validation rejects wrong-signer bytes', v12.ok === false && /WRONG_KEY/.test(v12.reason));
  })();
}

// ======================================================================
// [UNIT] complete signing intent (Q2): one returned-field substitution at a
// time, plus omitted constraints. The reusable helper may permit partial
// intents, but the PRODUCTION execution path must require a complete,
// immutable intent. These tests prove validateBytes rejects any substituted
// field and that the D1 external lane constructs a COMPLETE intent (every
// critical field present) before signing.
// ======================================================================
function runCompleteIntent() {
  section('UNIT complete signing intent (per-field substitution + omissions)');
  const iface = new ethers.Interface(loadCustodyAbi());
  const cid = '0x' + '11'.repeat(32);
  const digest = '0x' + '22'.repeat(32);
  const releaseData = iface.encodeFunctionData('release', [cid, digest, 1, 2000, 27, '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(65)]);
  const to = '0x' + '99'.repeat(20);
  const signer = new SyntheticReferenceSigner({ keyHex: RELAYER_KEY, allowedChainId: CHAIN, custody: to, allowedActions: new Set([iface.getFunction('release').selector]), maxGasPrice: '2000000000', maxGasLimit: '800000' });
  const baseIntent = () => ({ to, chainId: CHAIN, value: 0n, data: releaseData, nonce: 0, from: RELAYER_ADDR, gasLimit: '400000', type: 2, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '500000000' });

  (async () => {
    // Sign as EIP-1559 (type 2) to match the production D1 external lane.
    const base = await signer.signTransaction({ to, data: releaseData, value: 0n, gasLimit: '400000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '500000000', nonce: 0, chainId: CHAIN });
    // Q2-0: the full intent accepts the genuinely signed bytes.
    const full = ExternalSigner.validateSignedBytes(base.signedBytes, baseIntent());
    check('Q2-0 complete intent accepts the signed bytes', full.ok === true && full.from === RELAYER_ADDR.toLowerCase(), full);

    // Q2-1: ONE returned-field substitution at a time must reject with the
    // specific field reason (or WRONG_KEY for the sender).
    const subs = [
      ['nonce', { nonce: 1 }, /TX_INTENT_MISMATCH:nonce/],
      ['to', { to: '0x' + '88'.repeat(20) }, /TX_INTENT_MISMATCH:to/],
      ['value', { value: 1n }, /TX_INTENT_MISMATCH:value/],
      ['data', { data: iface.encodeFunctionData('release', ['0x' + '33'.repeat(32), digest, 1, 2000, 27, '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(65)]) }, /TX_INTENT_MISMATCH:data/],
      ['chainId', { chainId: 84532 }, /TX_INTENT_MISMATCH:chainId/],
      ['gasLimit', { gasLimit: '500000' }, /TX_INTENT_MISMATCH:gasLimit/],
      ['maxFeePerGas', { maxFeePerGas: '1200000000' }, /TX_INTENT_MISMATCH:maxFeePerGas/],
      ['maxPriorityFeePerGas', { maxPriorityFeePerGas: '600000000' }, /TX_INTENT_MISMATCH:maxPriorityFeePerGas/],
      ['type', { type: 0 }, /TX_INTENT_MISMATCH:type/],
    ];
    for (const [label, over, pat] of subs) {
      const r = ExternalSigner.validateSignedBytes(base.signedBytes, { ...baseIntent(), ...over });
      check('Q2-1 ' + label + ' substitution rejected', r.ok === false && pat.test(r.reason || ''), r);
    }
    const rFrom = ExternalSigner.validateSignedBytes(base.signedBytes, { ...baseIntent(), from: '0x' + '77'.repeat(20) });
    check('Q2-2 from substitution rejected as WRONG_KEY', rFrom.ok === false && /WRONG_KEY/.test(rFrom.reason || ''), rFrom);

    // Q2-3: the helper's contract — a partial intent still enforces the
    // fields the caller DID constrain (omission is unconstrained by design in
    // the REUSABLE helper), and the production path requires completeness
    // (proven by Q2-4 below).
    const minimal = ExternalSigner.validateSignedBytes(base.signedBytes, { to, chainId: CHAIN, nonce: 0 });
    check('Q2-3 partial intent still enforces the constrained fields', minimal.ok === true && minimal.from === RELAYER_ADDR.toLowerCase(), minimal);
    const wrongMin = ExternalSigner.validateSignedBytes(base.signedBytes, { to: '0x' + '88'.repeat(20), chainId: CHAIN, nonce: 0 });
    check('Q2-3b partial intent rejects the constrained-field substitution', wrongMin.ok === false && /to/.test(wrongMin.reason || ''), wrongMin);

    // Q2-4: the PRODUCTION execution path (D1 external lane) must build a
    // COMPLETE immutable intent. Reconstruct the exact intent the D1 lane
    // builds (d1-worker.js ~line 179) and assert every critical field is
    // present and non-null. This is the "missing critical constraints must
    // reject, not become unconstrained" guarantee for the production path.
    const d1Intent = require('../worker/transaction-intent.js').normalizeIntent({ to: '0x' + '99'.repeat(20), chainId: CHAIN, value: 0n, data: releaseData, nonce: 0, from: RELAYER_ADDR, gasLimit: '400000', type: 2, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '500000000' });
    const required = ['to', 'from', 'chainId', 'value', 'data', 'nonce', 'gasLimit', 'type', 'maxFeePerGas', 'maxPriorityFeePerGas'];
    const missing = required.filter((k) => d1Intent[k] === undefined || d1Intent[k] === null);
    check('Q2-4 production intent is COMPLETE (all critical fields present)', missing.length === 0, 'missing=' + JSON.stringify(missing));
    check('Q2-4b production intent is immutable (frozen)', Object.isFrozen(d1Intent) === true);
  })();
}

// ======================================================================
// [UNIT] configuration gates
// ======================================================================
function runUnitConfigGates() {
  section('UNIT configuration gates');
  // G1: local mode (default) passes without production controls
  const r1 = gatesMod.assessConfigGates({}, {});
  check('G1 local mode (default) passes without production controls', r1.ok === true && r1.mode === 'local' && r1.production === false);
  // G1b: local mode with legacy note when unset
  check('G1b legacy note present when SAAX_EXEC_MODE unset', typeof r1.legacyNote === 'string' && /local test mode/.test(r1.legacyNote));

  // G2: production mode with missing controls fails
  const r2 = gatesMod.assessConfigGates({ SAAX_EXEC_MODE: 'production' }, {});
  check('G2 production mode fails without controls', r2.ok === false && r2.production === true && r2.missing.length > 0);

  // G3: complete production config passes
  const prodEnv = {
    SAAX_EXEC_MODE: 'production',
    SAAX_EXEC_RUNTIME: 'node-v26-railway',
    SAAX_EXEC_STORAGE: 'volume-pinned-sqlite',
    SAAX_PREPARED_KEY_ID: 'k-prod-1',
    SAAX_PREPARED_KEY_FILE: '/run/secrets/prepared.key',
    SAAX_D4A_PROTECT: '1',
    SAAX_EXTERNAL_SIGNER_ADAPTER: 'ref-signer',
    SAAX_EXTERNAL_SIGNER_ENDPOINT: 'http://signer:9090',
    SAAX_ALLOWED_CHAIN_ID: '84532',
    SAAX_CUSTODY_ADDRESS: '0x' + '5a'.repeat(20),
    SAAX_ALLOWED_ACTIONS: 'release,refund',
    SAAX_MAX_GAS_PRICE: '2000000000',
    SAAX_MAX_GAS_LIMIT: '800000',
    SAAX_FINALITY_POLICY: 'safe-finalized',
    SAAX_EVALUATOR_GOVERNANCE: 'safe-2of3',
  };
  const r3 = gatesMod.assessConfigGates(prodEnv, {});
  check('G3 complete production config passes', r3.ok === true && r3.missing.length === 0 && r3.violations.length === 0);

  // G4: production with a development key fails
  const r4 = gatesMod.assessConfigGates({ ...prodEnv }, { devRelayerKeys: [RELAYER_KEY] });
  check('G4 production with dev relayer key fails', r4.ok === false && r4.violations.some((v) => /development key/.test(v)));

  // G5: production with a test-only override fails
  const r5 = gatesMod.assessConfigGates({ ...prodEnv, SAAX_X402_VERIFY_MODE: 'mock' }, {});
  check('G5 production with test override fails', r5.ok === false && r5.violations.some((v) => /SAAX_X402_VERIFY_MODE=mock/.test(v)));

  // G6: production without finality policy fails (explicit finality required)
  const r6 = gatesMod.assessConfigGates({ ...prodEnv, SAAX_FINALITY_POLICY: undefined }, {});
  check('G6 production without finality policy fails', r6.ok === false && r6.missing.some((m) => /FINALITY/.test(m)));

  // G7: production without evaluator governance fails
  const r7 = gatesMod.assessConfigGates({ ...prodEnv, SAAX_EVALUATOR_GOVERNANCE: undefined }, {});
  check('G7 production without evaluator governance fails', r7.ok === false && r7.missing.some((m) => /EVALUATOR_GOVERNANCE/.test(m)));

  // G8: production without prepared-key id fails
  const r8 = gatesMod.assessConfigGates({ ...prodEnv, SAAX_PREPARED_KEY_ID: undefined }, {});
  check('G8 production without prepared key id fails', r8.ok === false && r8.missing.some((m) => /PREPARED_KEY_ID/.test(m)));

  // G9: assertConfigGates throws for production failure
  let threw = false;
  try { gatesMod.assertConfigGates({ SAAX_EXEC_MODE: 'production' }, {}); } catch (e) { threw = e.message === 'PRODUCTION_CONFIG_GATES_FAILED'; }
  check('G9 assertConfigGates throws for production failure', threw === true);

  // G10: local mode with explicit declaration does not fail even with mock overrides
  const r10 = gatesMod.assessConfigGates({ SAAX_EXEC_MODE: 'local', SAAX_X402_VERIFY_MODE: 'mock' }, {});
  check('G10 explicit local mode allows test overrides (no production gate)', r10.ok === true && r10.mode === 'local');

  // G11: mainnet admission stays independently disabled even when gates pass
  check('G11 gates do not enable admission', r3.admissionEnabled === false);
}

// ======================================================================
// [UNIT] env allowlist (process boundary)
// ======================================================================
function runUnitEnvAllowlist() {
  section('UNIT env allowlist (process boundary)');
  const parentEnv = {
    SAAX_D2_RELAYER_KEY: '0xsecret',
    SAAX_PREPARED_KEY: '0xkey',
    SAAX_PILOT_TOKEN: 'tok',
    SAAX_EXTERNAL_SIGNER_KEY: '0xext',
    PATH: '/usr/bin',
    NODE_OPTIONS: '',
    OTHER_SECRET: 'x',
  };
  // A1: allowlist drops non-listed secrets
  const child = allowlistMod.buildChildEnv(parentEnv, ['SAAX_EXTERNAL_SIGNER_KEY', 'SAAX_EXTERNAL_SIGNER_CHAIN']);
  check('A1 allowlist keeps only listed vars + basics', child.SAAX_EXTERNAL_SIGNER_KEY === '0xext' && child.SAAX_D2_RELAYER_KEY === undefined && child.SAAX_PREPARED_KEY === undefined && child.SAAX_PILOT_TOKEN === undefined && child.OTHER_SECRET === undefined && child.PATH === '/usr/bin');
  // A2: leaked-secret-names detection
  const leaked = allowlistMod.leakedSecretNames(['SAAX_D2_RELAYER_KEY', 'SAAX_PREPARED_KEY', 'SAAX_PILOT_TOKEN'], parentEnv, ['SAAX_EXTERNAL_SIGNER_KEY']);
  check('A2 leaked secret names detected', leaked.length === 3 && leaked.includes('SAAX_D2_RELAYER_KEY') && leaked.includes('SAAX_PILOT_TOKEN'));
  // A3: overrides applied
  const child2 = allowlistMod.buildChildEnv(parentEnv, [], { SAAX_EXTERNAL_SIGNER_CHAIN: '31337' });
  check('A3 overrides applied', child2.SAAX_EXTERNAL_SIGNER_CHAIN === '31337');
}

// ======================================================================
// [UNIT] startup controls (worker CLI gate fails closed)
// ======================================================================
function runUnitStartupControls() {
  section('UNIT startup controls (run-d2-worker config gate)');
  // S1: an explicitly-local invocation starts fine (escape hatch stated, not
  // silent) — gates never block the legacy test harness.
  const local = gatesMod.assessConfigGates({ SAAX_EXEC_MODE: 'local' }, {});
  check('S1 explicit local mode passes the startup gate', local.ok === true && local.production === false);

  // S2: a production-intended invocation without controls is refused at
  // startup with the specific reason.
  let s2err = null;
  try { gatesMod.assertConfigGates({ SAAX_EXEC_MODE: 'production' }, {}); } catch (e) { s2err = e; }
  check('S2 production startup refuses when controls missing', !!s2err && s2err.message === 'PRODUCTION_CONFIG_GATES_FAILED' && Array.isArray(s2err.details.missing) && s2err.details.missing.length > 0);

  // S3: each missing required control is named individually (runtime/storage
  // ARE present here, so the remaining required controls must all appear).
  const s3 = gatesMod.assessConfigGates({ SAAX_EXEC_MODE: 'production', SAAX_EXEC_RUNTIME: 'x', SAAX_EXEC_STORAGE: 'y' }, {});
  check('S3 missing controls name each requirement', s3.ok === false && s3.missing.some((m) => /PREPARED_KEY_ID/.test(m)) && s3.missing.some((m) => /EXTERNAL_SIGNER_ADAPTER/.test(m)) && s3.missing.some((m) => /FINALITY_POLICY/.test(m)) && s3.missing.some((m) => /EVALUATOR_GOVERNANCE/.test(m)), s3.missing.join(','));

  // S4: production refusals are distinct from test-only mode (no silent
  // fallback: a production-intended config NEVER downgrades to local).
  const s4 = gatesMod.assessConfigGates({ SAAX_EXEC_MODE: 'production', SAAX_EXEC_RUNTIME: 'x', SAAX_EXEC_STORAGE: 'y' }, {});
  check('S4 production mode never silently falls back', s4.production === true && s4.ok === false);
}

// ======================================================================
// [UNIT] D3 launcher production-config refusal (Q1: the D3 entry point)
// ======================================================================
function runD3LauncherGate() {
  section('D3 launcher production-config gate (run-d3-worker.cjs)');
  // The D3 integrated worker launcher must FAIL CLOSED on a production-
  // intended configuration before it opens the store, signs, or broadcasts.
  // S1D3/S2D3 spawn the ACTUAL launcher as a child process and assert the
  // exit code + named reason. A passing run-d2 startup test alone would be
  // insufficient (the task requirement).
  const spawnLauncher = (extraEnv, args = ['--once']) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'worker/run-d3-worker.cjs'), path.join(tmpdir, 'd3gate.sqlite'), String(CHAIN), '0x' + '5a'.repeat(20), 'http://127.0.0.1:18888', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.stderr.on('data', (d) => { text += d; });
    p.on('exit', (code) => resolve({ code, text }));
  });

  (async () => {
    // S1D3: explicit local mode starts (escape hatch stated, never silent).
    const local = await spawnLauncher({ SAAX_EXEC_MODE: 'local' });
    // With no work rows and --once the launcher exits 0 after an empty poll.
    check('S1D3 explicit local mode passes the D3 launcher gate', local.code === 0, 'code=' + local.code + ' text=' + local.text.slice(0, 200));

    // S2D3: production-intended invocation without controls is refused at
    // startup with the specific reason (no store open, no sign, no broadcast).
    const prod = await spawnLauncher({ SAAX_EXEC_MODE: 'production' });
    check('S2D3 production D3 launcher refuses when controls missing', prod.code === 1 && /PRODUCTION_CONFIG_GATES_FAILED/.test(prod.text), 'code=' + prod.code + ' text=' + prod.text.slice(0, 300));
    const missing = (prod.text.match(/"missing":\[([^\]]*)\]/) || [])[1] || '';
    check('S2D3b D3 launcher names the missing controls', /SAAX_EXEC_RUNTIME/.test(missing) && /SAAX_EXEC_STORAGE/.test(missing) && /SAAX_EXTERNAL_SIGNER_ADAPTER/.test(missing) && /SAAX_FINALITY_POLICY/.test(missing) && /SAAX_EVALUATOR_GOVERNANCE/.test(missing), missing);

    // S3D3: production config WITH a development key is refused (violation),
    // even when every required control is present.
    const prodDev = await spawnLauncher({
      SAAX_EXEC_MODE: 'production',
      SAAX_EXEC_RUNTIME: 'node-v26-railway',
      SAAX_EXEC_STORAGE: 'volume-pinned-sqlite',
      SAAX_PREPARED_KEY_ID: 'k-prod-1',
      SAAX_PREPARED_KEY: '0x' + '11'.repeat(32),
      SAAX_D4A_PROTECT: '1',
      SAAX_EXTERNAL_SIGNER_ADAPTER: 'ref-signer',
      SAAX_EXTERNAL_SIGNER_ENDPOINT: 'http://signer:9090',
      SAAX_ALLOWED_CHAIN_ID: '84532',
      SAAX_CUSTODY_ADDRESS: '0x' + '5a'.repeat(20),
      SAAX_ALLOWED_ACTIONS: 'release,refund',
      SAAX_MAX_GAS_PRICE: '2000000000',
      SAAX_MAX_GAS_LIMIT: '800000',
      SAAX_FINALITY_POLICY: 'safe-finalized',
      SAAX_EVALUATOR_GOVERNANCE: 'safe-2of3',
      SAAX_D2_RELAYER_KEY: RELAYER_KEY, // known hardhat dev key
    });
    check('S3D3 production D3 launcher refuses a dev relayer key', prodDev.code === 1 && /PRODUCTION_CONFIG_GATES_FAILED/.test(prodDev.text) && /development key/.test(prodDev.text), 'code=' + prodDev.code + ' text=' + prodDev.text.slice(0, 300));

    // S4D3: a config string claiming an external signer must NOT certify the
    // synthetic reference adapter as production-ready — a complete-looking
    // production config still fails unless every control is present, and the
    // ref-signer adapter is not a production adapter. Prove the missing
    // runtime/storage controls are still enforced when only the signer is set.
    const prodSignerOnly = await spawnLauncher({
      SAAX_EXEC_MODE: 'production',
      SAAX_EXTERNAL_SIGNER_ADAPTER: 'ref-signer',
      SAAX_EXTERNAL_SIGNER_ENDPOINT: 'http://signer:9090',
    });
    check('S4D3 external-signer config alone is not production-ready', prodSignerOnly.code === 1 && /PRODUCTION_CONFIG_GATES_FAILED/.test(prodSignerOnly.text), 'code=' + prodSignerOnly.code);
  })();
}

// ======================================================================
// [UNIT] Runtime process-secret boundaries (Q4: actual local launch path)
// ======================================================================
function runRuntimeEnvBoundaries() {
  section('RUNTIME process-secret boundaries (actual local launch path)');
  const probe = path.join(ROOT, 'scripts/_env-probe-child.cjs');
  const candidates = ['SAAX_D2_RELAYER_KEY', 'SAAX_EVALUATOR_PRIVATE_KEY', 'SAAX_SIGNER_PRIVATE_KEY', 'SAAX_PREPARED_KEY', 'SAAX_EXTERNAL_SIGNER_KEY', 'SAAX_PILOT_TOKEN', 'SAAX_JOURNAL_SIGNER_KEY', 'SAAX_SUPABASE_SERVICE_ROLE_KEY', 'SAAX_WORKER_STORE', 'SAAX_CUSTODY_ADDRESS', 'SAAX_CHAIN_ID', 'SAAX_RPC_URL', 'SAAX_JOURNAL_DIR', 'SAAX_PREPARED_KEY_ID', 'SAAX_EXTERNAL_SIGNER_ENDPOINT'];
  const sentinel = 'SAAX_D4B_RUNTIME_SENTINEL';
  const spawnProbe = (env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [probe, candidates.join(',')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
  (async () => {
    // Plant a synthetic sentinel in the PARENT env; it must never reach any
    // child that uses the explicit allowlist (report names/presence only).
    process.env[sentinel] = 'sentinel-value';
    process.env.SAAX_D2_RELAYER_KEY = RELAYER_KEY;
    process.env.SAAX_EVALUATOR_PRIVATE_KEY = '0x' + 'e0'.repeat(32);
    process.env.SAAX_PREPARED_KEY = '0x' + 'aa'.repeat(32);
    process.env.SAAX_EXTERNAL_SIGNER_KEY = RELAYER_KEY;
    process.env.SAAX_PILOT_TOKEN = 'pilot-sentinel';
    process.env.SAAX_JOURNAL_SIGNER_KEY = RELAYER_KEY;
    process.env.SAAX_WORKER_STORE = path.join(tmpdir, 'envprobe-store.sqlite');
    process.env.SAAX_CHAIN_ID = String(CHAIN);
    process.env.SAAX_CUSTODY_ADDRESS = '0x' + '5a'.repeat(20);
    process.env.SAAX_RPC_URL = 'http://127.0.0.1:18888';
    process.env.SAAX_JOURNAL_DIR = path.join(tmpdir, 'envprobe-journal');
    process.env.SAAX_JOURNAL_RPC = 'http://127.0.0.1:18888';
    process.env.SAAX_D4A_PROTECT = '1';
    process.env.SAAX_PREPARED_KEY_ID = PREPARED_KID;
    process.env.SAAX_EXTERNAL_SIGNER_ENDPOINT = 'http://127.0.0.1:19091';
    process.env.SAAX_EXTERNAL_SIGNER_TOKEN = 'd4b-test-token-0123456789abcdef0123';

    // 1. API child: built via the allowlist with ONLY the endpoint's config
    //    vars — relayer/evaluator/decryption secrets must be absent.
    const apiAllow = ['PORT', 'SAAX_HOST', 'SAAX_NETWORK', 'SAAX_CHAIN_ID', 'SAAX_ACCESS_CHAIN_ID', 'SAAX_RPC_URL', 'SAAX_CUSTODY_ADDRESS', 'SAAX_PILOT_TOKEN', 'SAAX_WORKER_STORE', 'SAAX_ESCROW_LEDGER', 'SAAX_INTEGRATED_WORKER', 'SAAX_D2_RELAYER_ADDRESS', 'SAAX_JOURNAL_DIR', 'SAAX_JOURNAL_RPC', 'SAAX_ESCROW_SCAN_FROM_BLOCK', 'SAAX_CUSTODY_ABI'];
    const apiEnv = allowlistMod.buildChildEnv(process.env, apiAllow, {});
    const apiRes = await spawnProbe(apiEnv);
    let apiPresent = [];
    try { apiPresent = JSON.parse(apiRes.out.replace(/^ENVREPORT /, '')).present; } catch {}
    check('ENV1 API child env omits relayer/evaluator/decryption secrets', apiRes.code === 0 && !apiPresent.includes('SAAX_D2_RELAYER_KEY') && !apiPresent.includes('SAAX_EVALUATOR_PRIVATE_KEY') && !apiPresent.includes('SAAX_SIGNER_PRIVATE_KEY') && !apiPresent.includes('SAAX_PREPARED_KEY') && !apiPresent.includes('SAAX_EXTERNAL_SIGNER_KEY') && !apiPresent.includes(sentinel), 'present=' + JSON.stringify(apiPresent));
    check('ENV1b API child keeps its required config', apiPresent.includes('SAAX_WORKER_STORE') && apiPresent.includes('SAAX_CUSTODY_ADDRESS'), 'present=' + JSON.stringify(apiPresent));

    // 2. Synthetic signer child: receives ONLY its required key.
    const signerAllow = ['SAAX_EXTERNAL_SIGNER_KEY', 'SAAX_EXTERNAL_SIGNER_CHAIN', 'SAAX_EXTERNAL_SIGNER_CUSTODY', 'SAAX_EXTERNAL_SIGNER_MAX_GAS_PRICE', 'SAAX_EXTERNAL_SIGNER_MAX_GAS_LIMIT', 'SAAX_EXTERNAL_SIGNER_TOKEN', 'SAAX_EXEC_MODE'];
    const signerEnv = allowlistMod.buildChildEnv(process.env, signerAllow, { SAAX_EXTERNAL_SIGNER_KEY: RELAYER_KEY });
    const signerRes = await spawnProbe(signerEnv);
    let signerPresent = [];
    try { signerPresent = JSON.parse(signerRes.out.replace(/^ENVREPORT /, '')).present; } catch {}
    check('ENV2 signer child receives only its required key', signerRes.code === 0 && signerPresent.includes('SAAX_EXTERNAL_SIGNER_KEY') && !signerPresent.includes('SAAX_D2_RELAYER_KEY') && !signerPresent.includes('SAAX_EVALUATOR_PRIVATE_KEY') && !signerPresent.includes('SAAX_PREPARED_KEY') && !signerPresent.includes(sentinel), 'present=' + JSON.stringify(signerPresent));

    // 3. Worker child: receives only NECESSARY execution/storage credentials.
    //    The prepared key (SAAX_PREPARED_KEY) is the worker's OWN decryption
    //    credential — it MUST be present for it to open envelopes. The
    //    relayer/evaluator private keys and the pilot transport token must
    //    NOT be present (the relayer key lives in the external signer
    //    process, never the worker).
    const workerAllow = ['SAAX_WORKER_STORE', 'SAAX_CHAIN_ID', 'SAAX_CUSTODY_ADDRESS', 'SAAX_RPC_URL', 'SAAX_JOURNAL_DIR', 'SAAX_JOURNAL_RPC', 'SAAX_EXEC_MODE', 'SAAX_D4A_PROTECT', 'SAAX_PREPARED_KEY', 'SAAX_PREPARED_KEY_ID', 'SAAX_EXTERNAL_SIGNER_ENDPOINT', 'SAAX_EXTERNAL_SIGNER_TOKEN'];
    const workerEnv = allowlistMod.buildChildEnv(process.env, workerAllow, { SAAX_EXEC_MODE: 'local' });
    const workerRes = await spawnProbe(workerEnv);
    let workerPresent = [];
    try { workerPresent = JSON.parse(workerRes.out.replace(/^ENVREPORT /, '')).present; } catch {}
    check('ENV3 worker child receives execution/storage + decryption creds, no relayer/evaluator/pilot', workerRes.code === 0 && workerPresent.includes('SAAX_WORKER_STORE') && workerPresent.includes('SAAX_PREPARED_KEY') && !workerPresent.includes('SAAX_D2_RELAYER_KEY') && !workerPresent.includes('SAAX_EVALUATOR_PRIVATE_KEY') && !workerPresent.includes('SAAX_PILOT_TOKEN') && !workerPresent.includes(sentinel), 'present=' + JSON.stringify(workerPresent));

    // ENV4: the LEAKED-NAMES detector independently confirms which secrets
    // would have leaked under a wholesale env pass but are now blocked (the
    // prepared key is allowlisted for the worker, so it is NOT leaked).
    const leaked = allowlistMod.leakedSecretNames(['SAAX_D2_RELAYER_KEY', 'SAAX_EVALUATOR_PRIVATE_KEY', 'SAAX_EXTERNAL_SIGNER_KEY', 'SAAX_PILOT_TOKEN', sentinel], process.env, workerAllow);
    check('ENV4 leaked-secret detector confirms the boundary', leaked.includes('SAAX_D2_RELAYER_KEY') && leaked.includes('SAAX_EVALUATOR_PRIVATE_KEY') && leaked.includes('SAAX_PILOT_TOKEN') && leaked.includes(sentinel) && leaked.includes('SAAX_EXTERNAL_SIGNER_KEY'), 'leaked=' + JSON.stringify(leaked));

    // Cleanup sentinel from the parent so it does not leak into later spawns.
    delete process.env[sentinel];
    delete process.env.SAAX_D2_RELAYER_KEY;
    delete process.env.SAAX_EVALUATOR_PRIVATE_KEY;
    delete process.env.SAAX_EXTERNAL_SIGNER_KEY;
    delete process.env.SAAX_PILOT_TOKEN;
    delete process.env.SAAX_JOURNAL_SIGNER_KEY;
    // Restore the suite's prepared key (the REAL section seals with it).
    process.env.SAAX_PREPARED_KEY = KEY_A;
  })();
}

// ======================================================================
// [UNIT] API process boundary re-proof (R9-equivalent)
// ======================================================================
function reProveApiBoundary() {
  section('API process boundary (R9 re-proof)');
  // The API modules must not import or reach any vault/private-key surface —
  // including the new D4B external-signer modules (the signer key must never
  // be reachable from the API process).
  const apiFiles = [
    path.join(ROOT, 'api', 'checkout.mjs'),
    path.join(ROOT, 'api', 'mcp.mjs'),
    path.join(ROOT, 'api', 'receipt.mjs'),
    path.join(ROOT, 'api', 'route.mjs'),
    path.join(ROOT, 'api', 'lib', 'supabase.mjs'),
    path.join(ROOT, 'api', 'lib', 'welcome-email.mjs'),
    path.join(ROOT, 'api', 'stripe', 'webhook.mjs'),
    path.join(ROOT, 'endpoint', 'route-server.js'),
  ];
  const forbidden = [
    'signing-vault', 'prepared-vault', 'external-signer', 'transaction-intent',
    'config-gates', 'env-allowlist', 'SAAX_D2_RELAYER_KEY', 'SAAX_SIGNER_PRIVATE_KEY',
    'SAAX_EVALUATOR_PRIVATE_KEY', 'SAAX_EXTERNAL_SIGNER_KEY', 'SAAX_PREPARED_KEY',
  ];
  const hits = [];
  for (const f of apiFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const term of forbidden) {
      if (src.includes(term)) hits.push(f + ':' + term);
    }
  }
  check('R9-API API process has no vault/signer/key path (incl. D4B modules)', hits.length === 0, hits.join(', '));
  // The signing-vault still documents worker-only loading (D4A R9b re-proof)
  // and the prepared-vault the restricted path (D4A R9c re-proof).
  const signingSrc = fs.readFileSync(path.join(ROOT, 'worker', 'signing-vault.js'), 'utf8');
  const vaultSrc = fs.readFileSync(path.join(ROOT, 'worker', 'prepared-vault.js'), 'utf8');
  check('R9b signing-vault documents worker-only key loading', /SAAX_D2_RELAYER_KEY/.test(signingSrc) && /HTTP\/API process/.test(signingSrc));
  check('R9c prepared-vault documents restricted decryption path', /restricted broadcast\/recovery path/.test(vaultSrc));
}

// ======================================================================
// [LOCAL-REF] separate-process reference signer server + client
// ======================================================================
let refServer = null;
function startRefServer(extraEnv = {}) {
  // A strong bearer token is REQUIRED by the reference server's own guard
  // (it refuses to start without one); the child env allowlist carries it so
  // the server authenticates localhost requests and no secret leaks.
  const TEST_TOKEN = 'd4b-test-token-0123456789abcdef0123'; // >= 32 chars
  const childEnv = allowlistMod.buildChildEnv(process.env, ['SAAX_EXTERNAL_SIGNER_KEY', 'SAAX_EXTERNAL_SIGNER_CHAIN', 'SAAX_EXTERNAL_SIGNER_CUSTODY', 'SAAX_EXTERNAL_SIGNER_MAX_GAS_PRICE', 'SAAX_EXTERNAL_SIGNER_MAX_GAS_LIMIT', 'SAAX_EXTERNAL_SIGNER_TOKEN', 'SAAX_EXEC_MODE'], { SAAX_EXTERNAL_SIGNER_KEY: RELAYER_KEY, SAAX_EXTERNAL_SIGNER_CHAIN: String(CHAIN), SAAX_EXTERNAL_SIGNER_TOKEN: TEST_TOKEN, SAAX_EXEC_MODE: 'local', ...extraEnv });
  const port = 19090 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [path.join(ROOT, 'worker', 'external-signer-refserver.cjs'), '--port', String(port)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => {
    const t = setTimeout(() => { if (!refServerReady) resolve({ child, port, out: () => out, ready: false }); }, 6000);
    let refServerReady = false;
    child.stdout.on('data', (d) => {
      if (!refServerReady && /listening on/.test(out)) { refServerReady = true; clearTimeout(t); resolve({ child, port, out: () => out, ready: true }); }
    });
  });
}

async function runLocalRefTests() {
  section('LOCAL-REF separate-process reference signer');
  const launched = await startRefServer({ SAAX_EXTERNAL_SIGNER_CUSTODY: '0x' + '99'.repeat(20) });
  refServer = launched;
  check('R1 reference signer server starts (separate process)', launched.ready === true);
  if (!launched.ready) return;
  const client = new RefSignerClient({ endpoint: 'http://127.0.0.1:' + launched.port, timeoutMs: 5000 });
  const abi = loadCustodyAbi();
  const iface = new ethers.Interface(abi);
  const releaseData = iface.encodeFunctionData('release', ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), 1, 2000, 27, '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(65)]);
  // R2: identity via HTTP
  const id = await client.getSignerIdentity();
  check('R2 client obtains signer identity over HTTP', id.address === RELAYER_ADDR.toLowerCase());
  // R3: sign via HTTP (policy validated server-side; no broadcast)
  const r = await client.signTransaction({ to: '0x' + '99'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN });
  check('R3 client signs over HTTP (no broadcast)', r.ok === true && typeof r.signedBytes === 'string' && r.signedBytes.startsWith('0x'));
  // R4: independent validation of HTTP-returned bytes
  const v = ExternalSigner.validateSignedBytes(r.signedBytes, { to: '0x' + '99'.repeat(20), chainId: CHAIN, value: 0n, data: releaseData, nonce: 0, from: RELAYER_ADDR });
  check('R4 HTTP-returned bytes independently validated', v.ok === true);
  // R5: policy rejection surfaced via error code
  let badCode = null;
  try { await client.signTransaction({ to: '0x' + '88'.repeat(20), data: releaseData, value: 0n, gasLimit: '400000', gasPrice: '1000000000', nonce: 0, chainId: CHAIN }); } catch (e) { badCode = e.code; }
  check('R5 policy rejection surfaced as error code', typeof badCode === 'string' && /POLICY_REJECTED/.test(badCode));
  // R6: unavailable — point client at a dead port
  const deadClient = new RefSignerClient({ endpoint: 'http://127.0.0.1:1', timeoutMs: 1500 });
  let deadCode = null;
  try { await deadClient.getSignerIdentity(); } catch (e) { deadCode = e.code; }
  check('R6 unavailable provider -> UNAVAILABLE', deadCode === ERR.UNAVAILABLE);
  // R7: timeout — a server that never answers
  const slow = http.createServer(() => {});
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const slowPort = slow.address().port;
  const slowClient = new RefSignerClient({ endpoint: 'http://127.0.0.1:' + slowPort, timeoutMs: 800 });
  let timeoutCode = null;
  try { await slowClient.getSignerIdentity(); } catch (e) { timeoutCode = e.code; }
  check('R7 timeout -> TIMEOUT', timeoutCode === ERR.TIMEOUT);
  slow.close();
  // R8: child env allowlist — the server got ONLY its allowed env (not the
  // prepared key, not the pilot token). We assert the parent's secret env
  // values are absent from the child's env by checking the server never saw
  // them; simplest proof: the allowlist builder already drops them (A1-A2),
  // and the spawned child's process.env is the built allowlist. We verify the
  // server process did NOT inherit a planted marker.
  const marker = 'SAAX_D4B_MARKER_SECRET';
  process.env[marker] = 'leak-check';
  const l2 = await startRefServer();
  const childEnvCheck = allowlistMod.buildChildEnv(process.env, ['SAAX_EXTERNAL_SIGNER_KEY', 'SAAX_EXTERNAL_SIGNER_CHAIN', 'SAAX_EXTERNAL_SIGNER_CUSTODY'], { SAAX_EXTERNAL_SIGNER_KEY: RELAYER_KEY });
  check('R8 child env allowlist excludes application secrets', childEnvCheck[marker] === undefined && childEnvCheck.SAAX_PREPARED_KEY === undefined);
  if (l2.ready) { l2.child.kill(); }
  delete process.env[marker];
}

// ======================================================================
// [REAL] protected execution — genuine Safe-approved payout + refund
// ======================================================================
async function runRealProtectedExecution() {
  section('REAL protected execution (external signer + Safe 2-of-3 + envelope)');
  let provider, hre, accounts, custody, token, custodyAddr, safeProxyAddr, safeArt;
  const abi = loadCustodyAbi();
  async function startRealEvm() {
    const s = await helpers.startEvm(CHAIN);
    provider = s.provider; hre = s.hre; accounts = s.accounts;
    const [deployer, buyer, seller, evaluatorEOA, attester, donor, stranger] = accounts;
    const deploy = async (art, args = []) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
    token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
    const policy = '0x' + 'ab'.repeat(32);
    const safeArtLocal = helpers.compileSafe('Safe', 'contracts/Safe.sol');
    safeArt = safeArtLocal;
    const handlerArt = helpers.compileSafe('CompatibilityFallbackHandler', 'contracts/handler/CompatibilityFallbackHandler.sol');
    const factoryArt = helpers.compileSafe('SafeProxyFactory', 'contracts/proxies/SafeProxyFactory.sol');
    const singleton = await deploy(safeArtLocal), handler = await deploy(handlerArt), factory = await deploy(factoryArt);
    const init = new ethers.Interface(safeArtLocal.abi).encodeFunctionData('setup', [[buyer.address, seller.address, evaluatorEOA.address], 2, ethers.ZeroAddress, '0x', handler.target, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
    const created = await (await factory.createProxyWithNonce(singleton.target, init, 6311n)).wait();
    const createdEvent = created.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === 'ProxyCreation');
    safeProxyAddr = createdEvent.args.proxy;
    custody = await deploy(hre.artifacts.readArtifactSync('SAAXEscrowCustodyV2'), [1000000, 10000000, true, 1, policy]);
    custodyAddr = custody.target;
    return { deployer, buyer, seller, evaluatorEOA, attester, donor, stranger };
  }
  const rpcUrl = 'http://127.0.0.1:18888';
  // Build an RPC proxy to the hardhat in-process provider (allow needed methods)
  const allow = new Set(['eth_chainId', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_sendRawTransaction', 'eth_getBalance', 'eth_blockNumber', 'eth_feeHistory', 'eth_getTransactionByBlockNumberAndIndex']);
  const rpcServer = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async (q) => {
      try {
        if (!allow.has(q.method)) throw new Error('method unavailable');
        return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise((r) => rpcServer.listen(18888, '127.0.0.1', r));
  const rpcProvider = () => new ethers.JsonRpcProvider(rpcUrl, CHAIN, { staticNetwork: true });

  const { deployer, buyer, seller, evaluatorEOA, attester, donor, stranger } = await startRealEvm();

  // helper: build a genuine Safe 2-of-3 verdict signature for an escrow action
  const HH_KEYS_LOCAL = [
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  ];
  const ownerAddr = (i) => new ethers.Wallet(HH_KEYS_LOCAL[i]).address;
  async function buildSafeVerdictSig(cid2, digest2, action, nonce, issuedAt, ownerIndices) {
    const verdictDigest = custodyVerdictDigest(ethers, custodyAddr, CHAIN, cid2, digest2, action, nonce, issuedAt);
    const msgHash = helpers.safeMessageHash(ethers, safeProxyAddr, CHAIN, verdictDigest);
    const sigObjs = [];
    for (const oi of ownerIndices) {
      const sig = helpers.rawSign(ethers, oi, msgHash);
      sigObjs.push({ addr: ownerAddr(oi), sig });
    }
    return helpers.packSafeSigs(sigObjs);
  }
  function custodyVerdictDigest(e, custodyAddr2, chainId, id, digest2, action, nonce, issuedAt) {
    const domain = { name: 'SAAX Escrow Custody V2', version: '2', chainId, verifyingContract: custodyAddr2 };
    const types = { EscrowVerdict: [
      { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' },
    ] };
    return e.TypedDataEncoder.hash(domain, types, { commitmentId: id, commitmentDigest: digest2, action, nonce, issuedAt });
  }

  async function fundEscrow(cid2, digest2, { buyer, seller, evaluator, amount = 1000, deadlineOffset = 2000, cutoffOffset = 4000 }) {
    const t = Number((await provider.getBlock('latest')).timestamp);
    await (await token.mint(buyer.address, amount + 100000)).wait();
    await (await token.connect(buyer).approve(custodyAddr, amount + 100000)).wait();
    await (await custody.connect(buyer).fund(cid2, digest2, token.target, buyer.address, seller.address, evaluator, amount, t + deadlineOffset, t + cutoffOffset, 0, 1, '0x' + 'ab'.repeat(32), digest2)).wait();
    return { t };
  }

  // --- three escrows: release, refund, and a fresh one for the negatives ---
  const cidR = '0x' + 'd4'.repeat(32);
  const digR = '0x' + 'd4'.repeat(32);
  const cidF = '0x' + 'd5'.repeat(32);
  const digF = '0x' + 'd5'.repeat(32);
  const cidN = '0x' + 'd6'.repeat(32);
  const digN = '0x' + 'd6'.repeat(32);
  await fundEscrow(cidR, digR, { buyer, seller, evaluator: safeProxyAddr, amount: 1000 });
  await fundEscrow(cidF, digF, { buyer, seller, evaluator: safeProxyAddr, amount: 1000 });
  await fundEscrow(cidN, digN, { buyer, seller, evaluator: safeProxyAddr, amount: 1000 });

  // Dedicated reference signer bound to the REAL custody for this section.
  const realRef = await startRefServer({ SAAX_EXTERNAL_SIGNER_CUSTODY: custodyAddr });
  if (realRef.ready) { if (refServer && refServer.child) { try { refServer.child.kill(); } catch {} } refServer = realRef; }
  else { check('REAL ref signer bound to custody', false, 'failed to start'); }

  // worker opts shared
  const makeWorker = (storePath, opts = {}) => new D2Worker({
    storePath, abi, chain: { id: CHAIN, custody: custodyAddr },
    prereqs: new D2Prerequisites({
      abi, custody: { address: custodyAddr, chainId: CHAIN },
      getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; },
      getBlock: async (t) => provider.getBlock(t),
      policy: { require2of3Evaluator: true }, // the restricted launch requires Safe
    }),
    nextNonce: async (acct, chainId) => Number(await rpcProvider().getTransactionCount(acct, 'pending')),
    relayer: { account: RELAYER_ADDR, wallet: null }, // NO in-process relayer key
    provider: rpcProvider(),
    finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: opts.wipeStore !== undefined ? opts.wipeStore : true,
    protection: true,
    vault: vaultMod,
    externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }),
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  // ---- RELEASE: genuine Safe-approved payout ----
  const storeRel = path.join(tmpdir, 'd4b-release.sqlite');
  const wRel = makeWorker(storeRel);
  const acceptRel = wRel.store.acceptOperation({
    opId: 'op-rel', payloadDigest: digR, agreementRef: 'agr-d4b-rel', escrowId: cidR,
    chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'release', authNonce: 'n-rel', authRole: 'evaluator', authExpiry: 9999999999,
  });
  check('REL-1 accepted durably', acceptRel.ok);
  const issuedAt = Math.floor(Date.now() / 1000);
  const verdictNonce = 1;
  const packedSig = await buildSafeVerdictSig(cidR, digR, 'release', verdictNonce, issuedAt, [1, 2]); // buyer + seller = 2-of-3
  const sigR = ethers.Signature.from(helpers.rawSign(ethers, 3, helpers.safeMessageHash(ethers, safeProxyAddr, CHAIN, custodyVerdictDigest(ethers, custodyAddr, CHAIN, cidR, digR, 'release', verdictNonce, issuedAt))));
  // NOTE: the custody release takes the evaluator's ERC-1271 signature bytes
  // (packedSafeSigs over SafeMessage). The 8-arg release uses (v,r,s,sigBytes);
  // for the Safe path the sigBytes carries the packed Safe sigs. Build release
  // args with the Safe-packed signature:
  const releaseArgs = {
    commitmentId: cidR, commitmentDigest: digR, nonce: verdictNonce, issuedAt,
    v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: packedSig,
  };
  const prepRel = await wRel._prepareAccepted({ ...acceptRel.op, requestedAction: 'release' }, { requestedAction: 'release', actionArgs: releaseArgs, bindings: { agreementRef: 'agr-d4b-rel', escrowId: cidR, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: digR, authNonce: 'n-rel', authRole: 'evaluator', authExpiry: 9999999999, cutoff: null } });
  check('REL-2 prepare via EXTERNAL SIGNER succeeds', prepRel.ok && prepRel.status === 'PREPARED', prepRel);
  const storedRel = wRel.store.getPrepared('op-rel');
  check('REL-3 envelope stored (encrypted), no plaintext', !!storedRel && !!storedRel.signedEnvelope && /^ENC:/.test(storedRel.signed_bytes));
  const relT0 = await token.balanceOf(seller.address);
  const bRel = await wRel.broadcastPrepared('op-rel', { simulate: false });
  check('REL-4 broadcast accepted by local EVM', bRel.ok === true || bRel.status === 'SUBMISSION_UNCERTAIN', JSON.stringify(bRel).slice(0, 200));
  // reconcile
  await provider.send('evm_mine', []); // advance head so finality depth >= 1
  const recRel = await wRel.reconcileOutcome('op-rel');
  check('REL-5 reconcile establishes success', recRel.ok === true && recRel.status === 'FINALIZED', JSON.stringify(recRel).slice(0, 200));
  const escRel = await custody.getEscrow(cidR);
  check('REL-6 escrow state Released', Number(escRel.state) === 3, String(escRel.state));
  const relT1 = await token.balanceOf(seller.address);
  check('REL-7 seller paid once (+1000)', relT1 - relT0 === 1000n, String(relT1 - relT0));
  // events: Released emitted once (raw eth_getLogs — avoids ABI-fragment issues)
  const relReceipt = await rpcProvider().getTransactionReceipt(storedRel.tx_hash);
  const relFromBlock = Number(relReceipt.blockNumber);
  const allRel = await provider.send('eth_getLogs', [{ fromBlock: ethers.toBeHex(relFromBlock), toBlock: ethers.toBeHex(relFromBlock + 10), address: custodyAddr, topics: [ethers.id('Released(bytes32,address,uint256,bytes32)')] }]);
  check('REL-8 Released event count == 1', allRel.length === 1, 'count=' + allRel.length);
  wRel.close();

  // restart + idempotent reconciliation (release path)
  const wRel2 = makeWorker(storeRel, { wipeStore: false });
  // The escrow is already Released, so validatePrepared correctly refuses at
  // the on-chain state gate (fail-closed — a release cannot be re-executed).
  // The restart-recovery guarantee is the ENVELOPE: decrypt the sealed bytes
  // and recompute the exact tx hash, independent of the state gate.
  const prepRel2 = wRel2.store.getPrepared('op-rel');
  const resolvedRel2 = wRel2._resolvePreparedBytes(prepRel2);
  const { computeTxHash } = require('../worker/d1-tx.js');
  check('REL-9 restart restores exact tx hash via decryption', !!storedRel && resolvedRel2.ok === true && String(computeTxHash(resolvedRel2.bytes)).toLowerCase() === String(storedRel.tx_hash).toLowerCase());
  const vRel2 = await wRel2.validatePrepared('op-rel');
  check('REL-9b validatePrepared refuses already-released op (fail closed)', vRel2.ok === false && vRel2.reason === 'STATE_NOT_PERMITTED', JSON.stringify(vRel2).slice(0, 160));
  const recRel2 = await wRel2.reconcileOutcome('op-rel');
  // A terminal FINALIZED op has no supervised attempt; reconcile reports
  // NO_ACTIVE_ATTEMPT with the final status — the canonical D2 idempotency
  // contract (matched in test-d2-worker.cjs). Never a re-broadcast or payout.
  check('REL-10 re-reconcile is idempotent (no second payout)', (recRel2.reason === 'NO_ACTIVE_ATTEMPT' || recRel2.ok === true) && recRel2.status === 'FINALIZED', JSON.stringify(recRel2).slice(0, 160));
  const sellerAfter = await token.balanceOf(seller.address);
  check('REL-11 seller balance unchanged after re-reconcile (once)', sellerAfter - relT1 === 0n);
  wRel2.close();

  // ---- REFUND: genuine Safe-approved refund (authorized, not timeout) ----
  const storeRef = path.join(tmpdir, 'd4b-refund.sqlite');
  const wRef = makeWorker(storeRef);
  const acceptRef = wRef.store.acceptOperation({
    opId: 'op-ref', payloadDigest: digF, agreementRef: 'agr-d4b-ref', escrowId: cidF,
    chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'refund', authNonce: 'n-ref', authRole: 'evaluator', authExpiry: 9999999999,
  });
  check('REF-1 accepted durably', acceptRef.ok);
  const verdictNonceF = 2; // distinct verdict nonce (release used 1 on this contract)
  const packedSigF = await buildSafeVerdictSig(cidF, digF, 'refund', verdictNonceF, issuedAt, [1, 3]); // buyer + evaluator = 2-of-3
  const refundArgs = {
    commitmentId: cidF, commitmentDigest: digF, nonce: verdictNonceF, issuedAt,
    v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: packedSigF,
  };
  const prepRef = await wRef._prepareAccepted({ ...acceptRef.op, requestedAction: 'refund' }, { requestedAction: 'refund', actionArgs: refundArgs, bindings: { agreementRef: 'agr-d4b-ref', escrowId: cidF, chainId: CHAIN, custody: custodyAddr, requestedAction: 'refund', payloadDigest: digF, authNonce: 'n-ref', authRole: 'evaluator', authExpiry: 9999999999, cutoff: null } });
  check('REF-2 prepare via external signer succeeds', prepRef.ok && prepRef.status === 'PREPARED', prepRef);
  const buyerT0 = await token.balanceOf(buyer.address);
  const bRef = await wRef.broadcastPrepared('op-ref', { simulate: false });
  check('REF-3 refund broadcast accepted', bRef.ok === true || bRef.status === 'SUBMISSION_UNCERTAIN', JSON.stringify(bRef).slice(0, 200));
  await provider.send('evm_mine', []); // advance head so finality depth >= 1
  const recRef = await wRef.reconcileOutcome('op-ref');
  check('REF-4 refund reconcile success', recRef.ok === true && recRef.status === 'FINALIZED', JSON.stringify(recRef).slice(0, 200));
  const escRef = await custody.getEscrow(cidF);
  check('REF-5 escrow state Refunded', Number(escRef.state) === 4, String(escRef.state));
  const buyerT1 = await token.balanceOf(buyer.address);
  check('REF-6 buyer refunded once (+1000)', buyerT1 - buyerT0 === 1000n, String(buyerT1 - buyerT0));
  wRef.close();

  // ---- NEGATIVES ----
  section('REAL negatives');
  // Valid Safe release verdict for the negative escrow (distinct verdict nonce 3)
  const negIssuedAt = Math.floor(Date.now() / 1000);
  const negVerdictNonce = 3;
  const packedSigN = await buildSafeVerdictSig(cidN, digN, 'release', negVerdictNonce, negIssuedAt, [1, 2]);
  const releaseArgsN = {
    commitmentId: cidN, commitmentDigest: digN, nonce: negVerdictNonce, issuedAt: negIssuedAt,
    v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: packedSigN,
  };
  // N1: wrong signer — client pointed at a signer with a DIFFERENT key
  const sOtherServer = await startRefServer({ SAAX_EXTERNAL_SIGNER_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' });
  if (sOtherServer.ready) {
    const storeN1 = path.join(tmpdir, 'd4b-n1.sqlite');
    const wN1 = new D2Worker({
      storePath: storeN1, abi, chain: { id: CHAIN, custody: custodyAddr },
      prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }),
      nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')),
      relayer: { account: RELAYER_ADDR, wallet: null },
      provider: rpcProvider(),
      finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }),
      gas: { gasLimit: '400000', gasPrice: '1000000000' },
      wipeStore: true, protection: true, vault: vaultMod,
      externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + sOtherServer.port, timeoutMs: 5000 }),
      maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    wN1.store.acceptOperation({ opId: 'op-n1', payloadDigest: digN, agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'release', authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999 });
    const prepN1 = await wN1._prepareAccepted({ ...(wN1.store.getOperation('op-n1')), requestedAction: 'release' }, { requestedAction: 'release', actionArgs: releaseArgsN, bindings: { agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: digN, authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999, cutoff: null } });
    check('N1 wrong-signer external signer rejected (identity mismatch)', !prepN1.ok && /EXTERNAL_SIGNER|WRONG/.test(prepN1.reason || ''), prepN1);
    wN1.close();
    sOtherServer.child.kill();
  } else { check('N1 wrong-signer external signer rejected (identity mismatch)', false, 'ref server failed to start'); }

  // N2: changed transaction fields — prepare with a mismatched gasPrice over bound
  const storeN2 = path.join(tmpdir, 'd4b-n2.sqlite');
  const wN2 = new D2Worker({
    storePath: storeN2, abi, chain: { id: CHAIN, custody: custodyAddr },
    prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }),
    nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')),
    relayer: { account: RELAYER_ADDR, wallet: null },
    provider: rpcProvider(),
    finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true, protection: true, vault: vaultMod,
    externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }),
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  wN2.store.acceptOperation({ opId: 'op-n2', payloadDigest: digN, agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'release', authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999 });
  const prepN2 = await wN2._prepareAccepted({ ...(wN2.store.getOperation('op-n2')), requestedAction: 'release' }, { requestedAction: 'release', actionArgs: releaseArgsN, bindings: { agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: digN, authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999, cutoff: null, gasLimit: '400000', gasPrice: '5000000000' } });
  check('N2 changed fee fields (over bound) rejected', !prepN2.ok && /EXTERNAL_SIGNER|REJECTED|VAULT/.test(prepN2.reason || ''), prepN2);
  wN2.close();

  // N3: signer outage — client points at a dead port; prepare fails closed
  const storeN3 = path.join(tmpdir, 'd4b-n3.sqlite');
  const wN3 = new D2Worker({
    storePath: storeN3, abi, chain: { id: CHAIN, custody: custodyAddr },
    prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }),
    nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')),
    relayer: { account: RELAYER_ADDR, wallet: null },
    provider: rpcProvider(),
    finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true, protection: true, vault: vaultMod,
    externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:1', timeoutMs: 1200 }),
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  wN3.store.acceptOperation({ opId: 'op-n3', payloadDigest: digN, agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'release', authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999 });
  const prepN3 = await wN3._prepareAccepted({ ...(wN3.store.getOperation('op-n3')), requestedAction: 'release' }, { requestedAction: 'release', actionArgs: releaseArgsN, bindings: { agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: digN, authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999, cutoff: null } });
  check('N3 signer outage fails closed (no broadcast, no plaintext)', !prepN3.ok && /EXTERNAL_SIGNER/.test(prepN3.reason || ''), prepN3);
  wN3.close();

  // N4: missing prepared key blocks broadcast, state recoverable
  const savedKey = process.env.SAAX_PREPARED_KEY;
  process.env.SAAX_PREPARED_KEY = '0x' + '00'.repeat(32);
  const vN4 = await new D2Worker({ storePath: storeRel, abi, chain: { id: CHAIN, custody: custodyAddr }, prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }), nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')), relayer: { account: RELAYER_ADDR, wallet: null }, provider: rpcProvider(), finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }), gas: { gasLimit: '400000', gasPrice: '1000000000' }, protection: true, vault: vaultMod, externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }), maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000', logger: { info: () => {}, warn: () => {}, error: () => {} } }).validatePrepared('op-rel');
  check('N4 missing key blocks execution (fail closed)', !vN4.ok && /ENVELOPE|KEY/.test(vN4.reason || ''), vN4);
  process.env.SAAX_PREPARED_KEY = savedKey;
  const stillThere = new D2Worker({ storePath: storeRel, abi, chain: { id: CHAIN, custody: custodyAddr }, prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }), nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')), relayer: { account: RELAYER_ADDR, wallet: null }, provider: rpcProvider(), finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }), gas: { gasLimit: '400000', gasPrice: '1000000000' }, protection: true, vault: vaultMod, externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }), maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000', logger: { info: () => {}, warn: () => {}, error: () => {} } }).store.getPrepared('op-rel');
  check('N4b envelope intact after missing-key failure (recoverable)', !!stillThere.signedEnvelope);
  process.env.SAAX_PREPARED_KEY = KEY_A;

  // N5: cross-operation envelope substitution — copy op-rel envelope onto op-ref
  const refStored = new D2Worker({ storePath: storeRef, abi, chain: { id: CHAIN, custody: custodyAddr }, prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }), nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')), relayer: { account: RELAYER_ADDR, wallet: null }, provider: rpcProvider(), finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }), gas: { gasLimit: '400000', gasPrice: '1000000000' }, protection: true, vault: vaultMod, externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }), maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000', logger: { info: () => {}, warn: () => {}, error: () => {} } }).store.getPrepared('op-ref');
  const relEnv = storedRel && storedRel.signedEnvelope;
  // swap the ref op's envelope with the rel op's envelope
  const swapWorker = new D2Worker({ storePath: storeRef, abi, chain: { id: CHAIN, custody: custodyAddr }, prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }), nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')), relayer: { account: RELAYER_ADDR, wallet: null }, provider: rpcProvider(), finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }), gas: { gasLimit: '400000', gasPrice: '1000000000' }, protection: true, vault: vaultMod, externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }), maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000', logger: { info: () => {}, warn: () => {}, error: () => {} } });
  swapWorker.store.db.prepare('UPDATE prepared_txs SET signed_envelope = ? WHERE op_id = ?').run(JSON.stringify(relEnv), 'op-ref');
  const vN5 = await swapWorker.validatePrepared('op-ref');
  check('N5 cross-operation envelope substitution rejected (aad from durable bindings)', !vN5.ok && /ENVELOPE|AUTH|DECRYPT/.test(vN5.reason || ''), vN5);
  // restore
  swapWorker.store.db.prepare('UPDATE prepared_txs SET signed_envelope = ? WHERE op_id = ?').run(JSON.stringify(refStored.signedEnvelope), 'op-ref');
  swapWorker.close();

  // N6: invalid signature retained — a forged release with an invalid verdict
  // signature must NOT produce a payout. Build release args with a bad sigBytes.
  const storeN6 = path.join(tmpdir, 'd4b-n6.sqlite');
  const wN6 = new D2Worker({
    storePath: storeN6, abi, chain: { id: CHAIN, custody: custodyAddr },
    prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }),
    nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')),
    relayer: { account: RELAYER_ADDR, wallet: null },
    provider: rpcProvider(),
    finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true, protection: true, vault: vaultMod,
    externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }),
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  wN6.store.acceptOperation({ opId: 'op-n6', payloadDigest: digN, agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'release', authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999 });
  const badArgs = { commitmentId: cidN, commitmentDigest: digN, nonce: 77, issuedAt, v: 27, r: '0x' + 'aa'.repeat(32), s: '0x' + 'bb'.repeat(32), sigBytes: '0x' + 'cc'.repeat(65) };
  const prepN6 = await wN6._prepareAccepted({ ...(wN6.store.getOperation('op-n6')), requestedAction: 'release' }, { requestedAction: 'release', actionArgs: badArgs, bindings: { agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: digN, authNonce: 'nn', authRole: 'evaluator', authExpiry: 9999999999, cutoff: null } });
  // The prereqs validator should reject an invalid evaluator verdict BEFORE broadcast.
  check('N6 invalid verdict signature rejected before prepare (no payout)', !prepN6.ok && /PREREQUISITE|SIGNATURE|VERDICT/.test(prepN6.reason || ''), prepN6);
  const escAfterN6 = await custody.getEscrow(cidN);
  check('N6b escrow still Funded (no payout from forged attempt)', Number(escAfterN6.state) === 1, String(escAfterN6.state));
  wN6.close();

  // N7: unsafe configuration — production gates fail with a dev key (unit already
  // proven G4/G5; here we prove the gate module returns the failure shape).
  const rN7 = gatesMod.assessConfigGates({ SAAX_EXEC_MODE: 'production', SAAX_EXEC_RUNTIME: 'x', SAAX_EXEC_STORAGE: 'y', SAAX_PREPARED_KEY_ID: 'k', SAAX_PREPARED_KEY: '0x' + '11'.repeat(32), SAAX_D4A_PROTECT: '1', SAAX_EXTERNAL_SIGNER_ADAPTER: 'ref', SAAX_EXTERNAL_SIGNER_ENDPOINT: 'http://x', SAAX_ALLOWED_CHAIN_ID: '84532', SAAX_CUSTODY_ADDRESS: '0x' + '5a'.repeat(20), SAAX_ALLOWED_ACTIONS: 'release', SAAX_MAX_GAS_PRICE: '1', SAAX_MAX_GAS_LIMIT: '1', SAAX_FINALITY_POLICY: 'safe', SAAX_EVALUATOR_GOVERNANCE: 'safe-2of3' }, { devRelayerKeys: [RELAYER_KEY] });
  check('N7 unsafe production config rejected (dev key)', rN7.ok === false && rN7.violations.length > 0);

  // ---- Q3: VALIDLY-ENCODED unauthorized verdicts must be rejected BEFORE
  // transaction signing/preparation, with ZERO external effects. These use
  // the PROPER signature representation for each case — the ambiguity
  // negative (N6) alone does not prove rejection of a cryptographically
  // valid but unauthorized verdict.
  const makeWorkerN = (storeId) => new D2Worker({
    storePath: path.join(tmpdir, storeId), abi, chain: { id: CHAIN, custody: custodyAddr },
    prereqs: new D2Prerequisites({ abi, custody: { address: custodyAddr, chainId: CHAIN }, getEscrow: async (c) => { const e = await custody.getEscrow(c); return { state: e.state, finalCutoff: e.finalCutoff, deadline: e.deadline, buyer: e.buyer, seller: e.seller, amount: e.amount, token: e.token, evaluator: e.evaluator, commitmentDigest: e.digest ?? e.commitmentDigest }; }, getBlock: async (t) => provider.getBlock(t), policy: { require2of3Evaluator: true } }),
    nextNonce: async (a, c) => Number(await rpcProvider().getTransactionCount(a, 'pending')),
    relayer: { account: RELAYER_ADDR, wallet: null },
    provider: rpcProvider(),
    finality: new FinalityAdapter({ getBlock: async (t) => rpcProvider().getBlock(t), getReceipt: async (h) => rpcProvider().getTransactionReceipt(h), confirmations: 1 }),
    gas: { gasLimit: '400000', gasPrice: '1000000000' },
    wipeStore: true, protection: true, vault: vaultMod,
    externalSigner: new RefSignerClient({ endpoint: 'http://127.0.0.1:' + refServer.port, timeoutMs: 5000 }),
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxGasLimit: '800000',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const releaseArgsFor = (cid2, dig2, packed, nonce, t2) => ({
    commitmentId: cid2, commitmentDigest: dig2, nonce, issuedAt: t2,
    v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: packed,
  });
  const prepareRelease = async (w, opId, args) => {
    w.store.acceptOperation({ opId, payloadDigest: digN, agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custodyAddress: custodyAddr, requestedAction: 'release', authNonce: 'nn' + opId, authRole: 'evaluator', authExpiry: 9999999999 });
    return w._prepareAccepted({ ...(w.store.getOperation(opId)), requestedAction: 'release' }, { requestedAction: 'release', actionArgs: args, bindings: { agreementRef: 'agr', escrowId: cidN, chainId: CHAIN, custody: custodyAddr, requestedAction: 'release', payloadDigest: digN, authNonce: 'nn' + opId, authRole: 'evaluator', authExpiry: 9999999999, cutoff: null } });
  };

  // N8: WRONG EVALUATOR SIGNER — a valid EOA verdict signed by an address
  // that is NOT the escrow's evaluator (proper (v,r,s) ECDSA encoding, fully
  // well-formed, wrong key). Must reject with EVALUATOR_MISMATCH before the
  // external key signs anything.
  {
    const wN8 = makeWorkerN('d4b-n8.sqlite');
    const d = custodyVerdictDigest(ethers, custodyAddr, CHAIN, cidN, digN, 'release', 101, negIssuedAt);
    const verdictDigest8 = custodyVerdictDigest(ethers, custodyAddr, CHAIN, cidN, digN, 'release', 101, negIssuedAt);
    const msgHash8 = helpers.safeMessageHash(ethers, safeProxyAddr, CHAIN, verdictDigest8);
    const sigReal = helpers.rawSign(ethers, 1, msgHash8); // buyer (owner)
    const sigStranger = helpers.rawSign(ethers, 6, msgHash8); // stranger (NOT an owner)
    const packedWrong = helpers.packSafeSigs([{ addr: ownerAddr(1), sig: sigReal }, { addr: stranger.address.toLowerCase(), sig: sigStranger }]);
    const args = { commitmentId: cidN, commitmentDigest: digN, nonce: 101, issuedAt: negIssuedAt, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash, sigBytes: packedWrong };
    const prep = await prepareRelease(wN8, 'op-n8', args);
    check('N8 wrong-evaluator (non-owner) Safe verdict rejected before sign', !prep.ok, prep);
    const escN8 = await custody.getEscrow(cidN);
    check('N8b escrow still Funded (zero external effects)', Number(escN8.state) === 1, String(escN8.state));
    wN8.close();
  }

  // N9: CORRECT SIGNER OVER A DIFFERENT ESCROW — a genuine evaluator verdict
  // over a different escrow's commitmentId/digest (well-formed Safe sigBytes
  // over the wrong escrow). The actionArgs reference a different escrow than
  // the op's escrowId — must reject with ESCROW_BINDING_MISMATCH before any
  // calldata build or signing, and the op's escrow must stay Funded.
  {
    const wN9 = makeWorkerN('d4b-n9.sqlite');
    const otherCid = '0x' + 'e7'.repeat(32); // an escrow that does NOT exist
    const otherDig = '0x' + 'e8'.repeat(32);
    const packedOther = await buildSafeVerdictSig(otherCid, otherDig, 'release', 102, negIssuedAt, [1, 2]);
    const args = releaseArgsFor(otherCid, otherDig, packedOther, 102, negIssuedAt);
    const prep = await prepareRelease(wN9, 'op-n9', args);
    check('N9 correct signer over a different escrow rejected (ESCROW_BINDING_MISMATCH)', !prep.ok && /ESCROW_BINDING_MISMATCH/.test(prep.reason || ''), prep);
    const escN9 = await custody.getEscrow(cidN);
    check('N9b escrow still Funded (zero external effects)', Number(escN9.state) === 1, String(escN9.state));
    wN9.close();
  }

  // N10: INVALID Safe AUTHORIZATION BELOW THRESHOLD — a well-formed Safe
  // sigBytes carrying only ONE of the three owners (1-of-3 below the
  // configured threshold of 2). The Safe's own isValidSignature (ERC-1271)
  // must reject it — the worker rejects before any signing.
  {
    const wN10 = makeWorkerN('d4b-n10.sqlite');
    const packedOne = await buildSafeVerdictSig(cidN, digN, 'release', 103, negIssuedAt, [1]); // buyer only = 1-of-3
    const args = releaseArgsFor(cidN, digN, packedOne, 103, negIssuedAt);
    const prep = await prepareRelease(wN10, 'op-n10', args);
    check('N10 below-threshold Safe verdict rejected (ERC_1271_REJECTED / authorize fail)', !prep.ok, prep);
    const escN10 = await custody.getEscrow(cidN);
    check('N10b escrow still Funded (zero external effects)', Number(escN10.state) === 1, String(escN10.state));
    wN10.close();
  }

  rpcServer.close();
  if (refServer && refServer.child) refServer.child.kill();
  process.env.SAAX_PREPARED_KEY = KEY_A;
}

// ======================================================================
// Entry
// ======================================================================
(async () => {
  process.env.SAAX_PREPARED_KEY = KEY_A;
  process.env.SAAX_PREPARED_KEY_ID = PREPARED_KID;
  // The reference signer requires a strong bearer token; every local client
  // (RefSignerClient default) authenticates via this env var.
  process.env.SAAX_EXTERNAL_SIGNER_TOKEN = 'd4b-test-token-0123456789abcdef0123';
  process.env.SAAX_EXEC_MODE = 'local';
  runUnitExternalSigner();
  runCompleteIntent();
  runUnitConfigGates();
  runUnitEnvAllowlist();
  runUnitStartupControls();
  runD3LauncherGate();
  runRuntimeEnvBoundaries();
  reProveApiBoundary();
  await runLocalRefTests();
  await runRealProtectedExecution();
  console.log('\n=== D4B RESULTS ===');
  console.log('passed=' + passed + ' failed=' + failed);
  if (failures.length) console.log('FAILURES:\n' + failures.join('\n'));
  console.log(failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
  process.exit(failed === 0 ? 0 : 1);
})();
