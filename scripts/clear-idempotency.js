// SAAX Protocol — Day 9 live: clear nonce-bound idempotency rows from the
// PostgREST store. Test settlements should NOT be poisoned by cached 200s
// from prior dry-run/live runs. Clears only nnonce:* keys (nonce-bound
// idempotency), leaving other idempotency rows untouched.
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PGREST = process.env.POSTGREST_URL || 'http://localhost:3000';
const KEY = process.env.SAAX_POSTGREST_KEY || '';

function del(query) {
  return new Promise((resolve, reject) => {
    const u = new URL(PGREST + '/idempotency_keys?' + query);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'DELETE', headers: { Authorization: 'Bearer ' + KEY, 'Accept-Profile': 'saax_router' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const r = await del('key=like.*nnonce*');
  console.log('DELETE nnonce:* -> HTTP ' + r.status + (r.body ? ' ' + r.body.slice(0, 120) : ''));
  // Verify
  const u = new URL(PGREST + '/idempotency_keys?select=key&key=like.*nnonce*');
  const remaining = await new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + KEY, 'Accept-Profile': 'saax_router' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.end();
  });
  const rows = (remaining && remaining.trim()) ? JSON.parse(remaining) : [];
  console.log('remaining nnonce:* rows:', rows.length);
  process.exit(0);
})().catch(e => { console.error('CLEAR FAILED: ' + (e.message || e)); process.exit(1); });