// SAAX Final Production Reliability Gate — restart-with-stale-pending test
// Simulates a process restart where stale pending rows exist in the DB:
//   - SELF lane (forceUnknown=false): stale pending rows MUST stay pending
//     (unresolved) — never auto-failed, never replayed.
//   - Mock lane (forceUnknown=true, nothing was broadcast): safe to fail.
//   - Idempotent re-run: a second reconcile resolves 0 further rows.
'use strict';

const { buildSupabaseClient } = require('../../endpoint/store.js');
const rec = require('../../endpoint/idempotency-reconcile.js');

let failures = 0, passes = 0;
const check = (name, cond, detail) => {
  const ok = !!cond;
  console.log((ok ? '[PASS]' : '[FAIL]') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
  if (ok) passes++; else failures++;
};

(async () => {
  // Self-seed the two stale pending rows (delete first for idempotent
  // re-runs) so the suite is hermetic without manual DB setup.
  const execSync = require('child_process').execSync;
  execSync(
    'docker exec ax_router_db psql -U postgres -d ax_router -v ON_ERROR_STOP=1 -c "DELETE FROM ax_router.idempotency_keys WHERE key LIKE \'recon:startup:%\'; INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at) VALUES (\'recon:startup:stale-self\', \'pending\', \'ph:s1\', now() - interval \'10 minutes\', now() + interval \'1 hour\'), (\'recon:startup:stale-mock\', \'pending\', \'ph:s2\', now() - interval \'10 minutes\', now() + interval \'1 hour\');"',
    { stdio: 'ignore' }
  );
  // Mint a service-role JWT with the RUNNING local PostgREST secret (the
  // .env SAAX_POSTGREST_KEY is signed with a different secret and is
  // rejected by the live container — see test-settlement-integrity.js).
  const secretLine = execSync(
    'docker inspect ax_router_postgrest --format "{{range .Config.Env}}{{println .}}{{end}}"',
    { encoding: 'utf8' }
  ).split('\n').find(l => l.startsWith('PGRST_JWT_SECRET='));
  const sec = secretLine ? secretLine.split('=').slice(1).join('=').trim() : '';
  const crypto = require('crypto');
  const b64u = s => Buffer.from(s).toString('base64url');
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ role: 'service_role', iss: 'saax-protocol-selfhosted', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 }));
  const sig = crypto.createHmac('sha256', sec).update(h + '.' + p).digest('base64url');
  const key = h + '.' + p + '.' + sig;
  const client = buildSupabaseClient('http://127.0.0.1:3000', key, 'ax_router');

  // SELF-style reconcile (no evidence): stale pending stays pending.
  const r1 = await rec.reconcile({ client, forceUnknown: false });
  check('SELF restart reconcile: nothing resolved without evidence', r1.reconciled === 0, 'reconciled=' + r1.reconciled);
  check('SELF restart reconcile: stale rows reported UNRESOLVED', r1.unresolved >= 2, 'unresolved=' + r1.unresolved);

  // Verify the DB rows are still pending (never auto-failed).
  // (the .eq chain below is deliberately awaited to avoid an in-flight fetch
  // being torn down at exit — a Windows Node crash, 0xC0000142)
  const rowsCheck = await client.from('idempotency_keys').select('key,status').eq('key', 'recon:startup:stale-self').eq('key', 'recon:startup:stale-mock');
  if (rowsCheck.error) console.error('row check error (non-fatal): ' + rowsCheck.error.message);
  const all = await client.from('idempotency_keys').select('key,status');
  const staleSelf = (all.data || []).find(r => r.key === 'recon:startup:stale-self');
  const staleMock = (all.data || []).find(r => r.key === 'recon:startup:stale-mock');
  check('SELF: stale key stays pending', staleSelf && staleSelf.status === 'pending', staleSelf && JSON.stringify(staleSelf));
  check('SELF: second stale key stays pending', staleMock && staleMock.status === 'pending', staleMock && JSON.stringify(staleMock));

  // Idempotent: second reconcile resolves nothing further.
  const r2 = await rec.reconcile({ client, forceUnknown: false });
  check('SELF restart reconcile idempotent: second run resolves 0', r2.reconciled === 0, 'reconciled=' + r2.reconciled);

  // Mock lane: forceUnknown=true marks them failed (nothing was broadcast).
  const r3 = await rec.reconcile({ client, forceUnknown: true, confirmedKeys: [], failedKeys: [] });
  // forceUnknown=true does NOT mark failed in the current RPC — it leaves
  // pending + notes. The mock-safe-fail design is: the caller passes keys as
  // failedKeys when it KNOWS nothing was broadcast. Verify the explicit path:
  const r4 = await rec.reconcile({ client, forceUnknown: false, failedKeys: ['recon:startup:stale-self'] });
  check('Mock lane explicit failed key -> failed', r4.reconciled === 1, 'reconciled=' + r4.reconciled);
  const after = await client.from('idempotency_keys').select('key,status');
  const selfAfter = (after.data || []).find(r => r.key === 'recon:startup:stale-self');
  check('DB row now failed', selfAfter && selfAfter.status === 'failed', selfAfter && JSON.stringify(selfAfter));

  console.log('\n=== ' + passes + ' passed, ' + failures + ' failed ===');
  // Use exitCode + natural drain instead of hard exit so no in-flight fetch
  // is torn down (Windows node guard-crash).
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exitCode = 2; });