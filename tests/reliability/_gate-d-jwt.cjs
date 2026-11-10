// Gate D testbed helper: mint a PostgREST JWT for the ISOLATED local testbed.
//
// Scope: local Docker PostgREST (ax_router_postgrest :3000) only. The secret is
// read from the container's own environment at runtime and is NEVER printed,
// logged, or written to disk. This file contains no secret material.
'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function testbedSecret() {
  const out = execFileSync('docker', ['inspect', 'ax_router_postgrest', '--format',
    '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' });
  const line = out.split(/\r?\n/).find(l => l.startsWith('PGRST_JWT_SECRET='));
  if (!line) throw new Error('testbed JWT secret not found (is ax_router_postgrest running?)');
  return line.slice('PGRST_JWT_SECRET='.length).trim();
}

function mint(role) {
  const secret = testbedSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { role: role || 'service_role', iat: now, exp: now + 3600 };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return signingInput + '.' + b64url(sig);
}

module.exports = { mint };

if (require.main === module) {
  // Print only a fingerprint, never the token itself.
  const t = mint(process.argv[2] || 'service_role');
  console.log('minted role=' + (process.argv[2] || 'service_role') + ' length=' + t.length +
    ' sha256=' + crypto.createHash('sha256').update(t).digest('hex').slice(0, 16));
}
