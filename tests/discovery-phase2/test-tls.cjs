// SAAX Discovery Phase 2 — test TLS certificate helper
//
// Generates a self-signed Ed25519 certificate for 127.0.0.1 / localhost using
// Git's bundled openssl.exe (present on this machine; not a repo dependency).
// The PEM + key are written under tests/discovery-phase2/.test-tls/ (gitignored;
// regenerated on demand). The Node client trusts the CA bundle through
// NODE_EXTRA_CA_CERTS or by passing `ca` to https.request via the test server
// helper, so TLS verification stays ON in tests (no rejectUnauthorized=false).
//
// This is TEST-ONLY infrastructure: production retrieval never disables
// certificate verification.

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATES = [
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  'openssl', // PATH fallback (Unix-like environments)
];
function findOpenssl() {
  for (const c of CANDIDATES) {
    try {
      const r = execFileSync(c, ['version'], { encoding: 'utf8' });
      if (r && r.includes('OpenSSL')) return c;
    } catch (_) { /* try next */ }
  }
  return null;
}

const TLS_DIR = path.join(__dirname, '.test-tls');
const KEY_PATH = path.join(TLS_DIR, 'test-key.pem');
const CERT_PATH = path.join(TLS_DIR, 'test-cert.pem');

function ensureTestCert() {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return { key: KEY_PATH, cert: CERT_PATH, regenerated: false };
  }
  const openssl = findOpenssl();
  if (!openssl) throw new Error('openssl not found on PATH or well-known paths; cannot generate test TLS cert');
  fs.mkdirSync(TLS_DIR, { recursive: true });

  // Ed25519 self-signed cert with SANs for 127.0.0.1 and localhost.
  const san = 'subjectAltName=IP:127.0.0.1,DNS:localhost';
  const extFile = path.join(TLS_DIR, 'ext.cnf');
  fs.writeFileSync(extFile, '[req]\ndistinguished_name=dn\n[dn]\n[x509v3]\n' + san + '\n', 'utf8');

  const genKey = [
    'genpkey', '-algorithm', 'ED25519', '-out', KEY_PATH,
  ];
  const genCert = [
    'req', '-new', '-x509', '-key', KEY_PATH, '-out', CERT_PATH,
    '-days', '30', '-subj', '/CN=localhost',
    '-addext', san,
  ];
  try {
    execFileSync(openssl, genKey, { stdio: 'pipe' });
    execFileSync(openssl, genCert, { stdio: 'pipe' });
  } catch (e) {
    // Some older openssl lacks -addext; fall back to -extfile.
    fs.rmSync(KEY_PATH, { force: true });
    fs.rmSync(CERT_PATH, { force: true });
    execFileSync(openssl, genKey, { stdio: 'pipe' });
    execFileSync(openssl, ['req', '-new', '-x509', '-key', KEY_PATH, '-out', CERT_PATH, '-days', '30', '-subj', '/CN=localhost', '-extensions', 'x509v3', '-config', extFile], { stdio: 'pipe' });
  }
  fs.rmSync(extFile, { force: true });
  return { key: KEY_PATH, cert: CERT_PATH, regenerated: true };
}

function certPem() {
  const t = ensureTestCert();
  return fs.readFileSync(t.cert, 'utf8');
}

module.exports = { ensureTestCert, certPem, TLS_DIR, KEY_PATH, CERT_PATH };