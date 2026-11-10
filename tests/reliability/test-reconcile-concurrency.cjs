// SAAX Final Production Reliability Gate — concurrent reconciliation harness
// Fires N parallel reconcile RPC calls at the SAME stale pending key across
// separate "workers" (separate HTTP requests). The per-key advisory lock must
// serialize: exactly ONE worker resolves the row; the others see 0 reconciled
// (idempotent no-op). Also verifies the LIVE PostgREST endpoint path (the
// same one the application uses) — not just direct psql.
'use strict';

const http = require('http');

const POSTGREST = 'http://127.0.0.1:3000';
const KEY = process.env.RECON_KEY || 'recon:test:concurrent-rpc';
const WORKERS = Number(process.env.RECON_WORKERS || 6);

function rpc(name, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    // Mint a service-role JWT with the RUNNING local PostgREST secret (the
    // .env key is rejected by the live container). Same pattern as the
    // settlement-integrity suite.
    const { execSync } = require('child_process');
    const crypto = require('crypto');
    const secretLine = execSync(
      'docker inspect ax_router_postgrest --format "{{range .Config.Env}}{{println .}}{{end}}"',
      { encoding: 'utf8' }
    ).split('\n').find(l => l.startsWith('PGRST_JWT_SECRET='));
    const sec = secretLine ? secretLine.split('=').slice(1).join('=').trim() : '';
    const b64u = s => Buffer.from(s).toString('base64url');
    const hh = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const pp = b64u(JSON.stringify({ role: 'service_role', iss: 'saax-protocol-selfhosted', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 }));
    const ss = crypto.createHmac('sha256', sec).update(hh + '.' + pp).digest('base64url');
    const jwt = hh + '.' + pp + '.' + ss;
    const req = http.request({
      host: '127.0.0.1', port: 3000, path: '/rpc/' + name, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Profile': 'ax_router',
        'Accept-Profile': 'ax_router',
        apikey: jwt,
        Authorization: 'Bearer ' + jwt,
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  // Self-seed a stale pending row fresh (delete first for idempotent re-runs)
  // so the suite is hermetic and can be re-run without manual DB setup.
  const { execSync } = require('child_process');
  execSync(
    'docker exec ax_router_db psql -U postgres -d ax_router -v ON_ERROR_STOP=1 -c "DELETE FROM ax_router.idempotency_keys WHERE key=\'' + KEY + '\'; INSERT INTO ax_router.idempotency_keys (key, status, payload_hash, created_at, expires_at) VALUES (\'' + KEY + '\', \'pending\', \'ph:ccrpc\', now() - interval \'5 minutes\', now() + interval \'1 hour\');"',
    { stdio: 'ignore' }
  );
  const results = await Promise.all(
    Array.from({ length: WORKERS }, () => rpc('reconcile_idempotency', {
      p_stale_after_seconds: 60,
      p_limit: 100,
      p_force_unknown: false,
      p_confirmed_keys: [KEY],
      p_failed_keys: null,
    }))
  );
  const ok = results.filter(r => r.status === 200);
  const resolved = results.filter(r => r.status === 200 && /"reconciled":\s*1/.test(r.body));
  const noops = results.filter(r => r.status === 200 && /"reconciled":\s*0/.test(r.body));
  console.log('workers=' + WORKERS + ' ok=' + ok.length + ' resolved=' + resolved.length + ' noops=' + noops.length);
  console.log('sample resolved:', resolved.length ? resolved[0].body.slice(0, 160) : '(none)');
  console.log('sample noop   :', noops.length ? noops[0].body.slice(0, 160) : '(none)');
  const pass = ok.length === WORKERS && resolved.length === 1 && noops.length === WORKERS - 1;
  console.log(pass ? '=== CONCURRENCY PASS ===' : '=== CONCURRENCY FAIL ===');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });