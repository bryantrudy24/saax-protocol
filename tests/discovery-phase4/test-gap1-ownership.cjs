// SAAX Discovery Phase 4 — Gap 1: single-writer ownership (lease + fencing)
//
// Proves (isolated loopback, real acceptance store):
//   GW1 a healthy writer remains exclusive BEYOND the previous expiry threshold
//       (no age-based reclaim while the owner is alive).
//   GW2 a second process CANNOT write (refused; journal untouched).
//   GW3 a dead owner can be recovered safely (proven death on this host).
//   GW4 concurrent recovery can NOT produce two writers (recovery-intent guard).
//   GW5 a stale owner can NOT delete a successor's lock, and can NOT continue
//       writing after ownership loss (fencing at every write).
//   GW6 an unknown/remote-host lock is treated conservatively (never reclaimed).
//   GW7 a recycled pid (owner death unproven) defers reclaim.
//   GW8 renewal keeps the lock current; fence passes while owner holds it.
//
// Run: node tests/discovery-phase4/test-gap1-ownership.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { AcceptanceStore, RENEW_INTERVAL_MS } = require('../../endpoint/acceptance-store');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { passed += 1; console.log('[PASS] ' + name); }
  else { failed += 1; failures.push({ name, detail }); console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'saax-gap1-'));
function tmpdir(name) { const d = path.join(tmpBase, name); fs.mkdirSync(d, { recursive: true }); return d; }
function lockPath(dir) { return path.join(dir, 'operation.lock'); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function writeLockFile(dir, info) {
  fs.writeFileSync(lockPath(dir), JSON.stringify(info), 'utf8');
}

// A tiny helper child process that tries to acquire + write; reports the outcome
// as a JSON line on stdout then exits.
const CHILD = `
const { AcceptanceStore } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'endpoint', 'acceptance-store.js'))});
const dir = process.argv[2] || process.argv[1];
(async () => {
  const s = new AcceptanceStore(dir);
  if (!s.isLocked) { console.log(JSON.stringify({ locked: false, lockError: s.lockError, size: s.size })); process.exit(0); }
  try {
    const r = await s.persistAcceptance({ kind: 'acceptance', operationId: 'op_child_' + Date.now() % 100000, commitmentId: '0x' + 'c'.repeat(64), proposalId: 'prop_child', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'child-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null });
    console.log(JSON.stringify({ locked: true, write: r }));
  } catch (e) {
    console.log(JSON.stringify({ locked: true, error: e.code || e.message }));
  }
  process.exit(0);
})();
`;
function runChild(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('exit', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (_) { resolve({ parseError: out }); }
    });
  });
}

async function main() {
  // GW1: health writer remains exclusive BEYOND the previous 5-min threshold.
  {
    const dir = tmpdir('gw1');
    const s1 = new AcceptanceStore(dir, { lockStaleMs: 60 * 1000, now: null });
    ok(s1.isLocked, 'GW1a store holds the lock');
    // Simulate the lock aging well past the stale threshold while the owner is
    // alive: rewrite the lock with an ancient startedAt, same live pid/writerId.
    const raw = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
    writeLockFile(dir, { ...raw, startedAt: '2020-01-01T00:00:00.000Z' });
    const s2 = new AcceptanceStore(dir, { lockStaleMs: 60 * 1000, now: null });
    ok(!s2.isLocked, 'GW1b an OLD lock with a LIVE owner is NOT reclaimed (no age-based expiry)');
    ok(String(s2.lockError).includes('live process'), 'GW1c refusal names the live owner');
    // The original owner can still write (its lock was never broken).
    const wr = await s1.persistAcceptance({ kind: 'acceptance', operationId: 'op_gw1', commitmentId: '0x' + '1'.repeat(64), proposalId: 'prop_gw1', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'gw1-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null });
    ok(wr.ok, 'GW1d original owner still writes beyond the old expiry threshold');
    s1.releaseLock();
  }

  // GW2: a second process cannot write (real separate process).
  {
    const dir = tmpdir('gw2');
    const s1 = new AcceptanceStore(dir);
    const res = await runChild(dir);
    eq(res.locked, false, 'GW2a second process refused the lock');
    ok(String(res.lockError).includes('locked'), 'GW2b refusal names the lock');
    eq(res.size, 0, 'GW2c refused process cannot read/write the journal');
    // Owner still writes.
    const wr = await s1.persistAcceptance({ kind: 'acceptance', operationId: 'op_gw2', commitmentId: '0x' + '2'.repeat(64), proposalId: 'prop_gw2', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'gw2-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null });
    ok(wr.ok, 'GW2d owner still writes while the second process is refused');
    s1.releaseLock();
  }

  // GW3: dead owner recovered safely (proven death on this host).
  {
    const dir = tmpdir('gw3');
    // Simulate a crash: write a lock claiming a pid that is surely dead
    // (spawn a child that exits, capture its pid, then use it).
    const dead = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 50)']);
      c.on('exit', () => resolve(c.pid));
    });
    fs.mkdirSync(dir, { recursive: true });
    writeLockFile(dir, { pid: dead, host: 'local', writerId: 'dead-writer', startedAt: '2020-01-01T00:00:00.000Z', ownerStartedAtMs: Date.now() - 100000 });
    const s4 = new AcceptanceStore(dir);
    ok(s4.isLocked, 'GW3a dead-owner lock recovered and re-acquired');
    ok(s4.recoveredStaleLock === true, 'GW3b recovery reported');
    const wr = await s4.persistAcceptance({ kind: 'acceptance', operationId: 'op_gw3', commitmentId: '0x' + '3'.repeat(64), proposalId: 'prop_gw3', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'gw3-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null });
    ok(wr.ok, 'GW3c recovered store can write');
    s4.releaseLock();
  }

  // GW4: concurrent recovery cannot produce two writers (recovery-intent guard).
  {
    const dir = tmpdir('gw4');
    fs.mkdirSync(dir, { recursive: true });
    const deadPid = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20)']);
      c.on('exit', () => resolve(c.pid));
    });
    writeLockFile(dir, { pid: deadPid, host: 'local', writerId: 'dead', startedAt: '2020-01-01T00:00:00Z', ownerStartedAtMs: Date.now() - 500000 });
    // Two concurrent constructors: both see dead pid; the recovery-intent
    // marker ensures one wins. (Possible both succeed sequentially — the lock
    // is atomic; the invariant is never TWO writers at once.)
    const [a, b] = await Promise.all([
      new AcceptanceStore(dir),
      new AcceptanceStore(dir),
    ]);
    const owners = [a.isLocked, b.isLocked].filter(Boolean).length;
    ok(owners >= 1, 'GW4a at least one recovered owner');
    ok(owners <= 1, 'GW4b at most ONE writer after concurrent recovery', 'owners=' + owners);
    if (a.isLocked) { const wr = await a.persistAcceptance({ kind: 'acceptance', operationId: 'op_gw4a', commitmentId: '0x' + '4'.repeat(64), proposalId: 'prop_gw4', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'gw4a-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null }); ok(wr.ok, 'GW4c the one owner writes'); }
    ['a', 'b'].forEach((k) => { const s = k === 'a' ? a : b; if (s.isLocked) s.releaseLock(); });
  }

  // GW5: a live owner whose lock is STOLEN (successor took over) cannot delete
  // the successor's lock and cannot continue writing (fencing at every write).
  {
    const dir = tmpdir('gw5');
    const s1 = new AcceptanceStore(dir);
    ok(s1.isLocked, 'GW5a original owner holds the lock');
    // Simulate a successor that took over after the original owner's lock was
    // broken by proven-death recovery: erase the lock (as recovery would) and
    // let s2 acquire it — while s1 is still alive in this process.
    fs.unlinkSync(lockPath(dir));
    const s2 = new AcceptanceStore(dir);
    ok(s2.isLocked, 'GW5b successor owns the lock');
    // The OLD owner (s1) tries to release: must NOT delete s2's lock.
    s1.releaseLock();
    ok(fs.existsSync(lockPath(dir)), 'GW5c stale owner did NOT delete the successor lock');
    ok(s2.isLocked, 'GW5d successor still owns the lock after stale release attempt');
    // The old owner's WRITES are fenced (ownership check at every write).
    let fenced = false;
    try {
      await s1.persistAcceptance({ kind: 'acceptance', operationId: 'op_gw5x', commitmentId: '0x' + '5'.repeat(64), proposalId: 'prop_gw5', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'gw5x-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null });
    } catch (e) {
      fenced = e.code === 'DSC_STORE_NOT_OWNER';
    }
    ok(fenced, 'GW5e stale owner write is fenced (DSC_STORE_NOT_OWNER)');
    // The successor can still write.
    const wr = await s2.persistAcceptance({ kind: 'acceptance', operationId: 'op_gw5y', commitmentId: '0x' + '6'.repeat(64), proposalId: 'prop_gw5', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'gw5y-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null });
    ok(wr.ok, 'GW5f successor writes after stale-owner fence');
    s2.releaseLock();
  }

  // GW6: unknown/remote-host lock is treated conservatively (never reclaimed).
  {
    const dir = tmpdir('gw6');
    fs.mkdirSync(dir, { recursive: true });
    writeLockFile(dir, { pid: 12345, host: 'other-host.example', writerId: 'remote', startedAt: '2020-01-01T00:00:00Z', ownerStartedAtMs: Date.now() - 100000 });
    const s = new AcceptanceStore(dir);
    ok(!s.isLocked, 'GW6 remote-host lock NOT reclaimed');
    ok(String(s.lockError).includes('another host'), 'GW6b conservative refusal names the remote host');
    ok(fs.existsSync(lockPath(dir)), 'GW6c remote lock file untouched');
  }

  // GW7: recycled pid (owner death unproven) defers reclaim.
  {
    const dir = tmpdir('gw7');
    fs.mkdirSync(dir, { recursive: true });
    // A lock whose pid is ALIVE but whose ownerStartedAtMs is in the FUTURE
    // (impossible for the current process) => the pid was recycled after the
    // original owner died. Recovery MUST be deferred.
    const alivePid = process.pid;
    writeLockFile(dir, { pid: alivePid, host: 'local', writerId: 'old-writer', startedAt: '2020-01-01T00:00:00Z', ownerStartedAtMs: Date.now() + 60000 });
    const s = new AcceptanceStore(dir);
    ok(!s.isLocked, 'GW7 recycled-pid lock NOT reclaimed (owner death unproven)');
    ok(String(s.lockError).includes('recycled'), 'GW7b refusal names the pid-reuse risk');
  }

  // GW8: renewal keeps the lock current; fence passes while owner holds it.
  {
    const dir = tmpdir('gw8');
    const s = new AcceptanceStore(dir, { lockStaleMs: 60 * 1000, now: null, renewIntervalMs: 250 });
    const before = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
    await new Promise((r) => setTimeout(r, 750)); // > 2 renewal ticks
    const after = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
    ok(after.renewedAt && after.renewedAt !== before.renewedAt, 'GW8a lock renewed (lease stays current)');
    ok(after.pid === process.pid && after.writerId === s.writerId, 'GW8b renewal keeps the same owner identity');
    const wr = await s.persistAcceptance({ kind: 'acceptance', operationId: 'op_gw8', commitmentId: '0x' + '8'.repeat(64), proposalId: 'prop_gw8', requestDigest: 'sha256:' + 'a'.repeat(64), idempotencyKey: 'gw8-key', status: 'accepted', acceptedAt: new Date().toISOString(), profileVersion: '1.0.0', signingKeyId: 'k', manifestVersion: '1', manifestDigest: 'sha256:' + 'b'.repeat(64), schema: { id: 'x', version: '1', digest: 'sha256:' + 'b'.repeat(64) }, buyerScope: { buyer: '0x' + '1'.repeat(40) }, proposalDigest: 'sha256:' + 'd'.repeat(64), acceptanceRef: { acceptanceId: 'a', digest: 'sha256:' + 'e'.repeat(64), keyId: 'k' }, commitmentRef: null, signedRepresentation: null });
    ok(wr.ok, 'GW8c fenced write passes while the owner holds the lease');
    s.releaseLock();
  }

  // ---- Summary ----
  console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('runner crashed: ' + (e && e.stack || e)); process.exitCode = 1; });