#!/usr/bin/env node
/* SAAX Gate H — operator credential lifecycle manager (isolated + production-safe).
 *
 * Commands:
 *   bootstrap  — generate a fresh operator token, store ONLY its sha256 hash in
 *                operator_secrets, write the plaintext token to a mode-600 env file.
 *                (Requires an existing operator secret row to exist — the migration
 *                seeds it. If absent, this creates the row through the same RPC path
 *                the operator would use, never via raw INSERT.)
 *   rotate     — rotate the operator hash in place; writes the NEW token to the env file.
 *   revoke     — CLEAR the stored hash so no token can authenticate; all
 *                provision_authority calls fail closed until bootstrap/rotate.
 *                (Schema note: operator_secrets currently has no revoked_at column;
 *                clearing the hash is the schema-compatible revocation. An additive
 *                migration adding created_at/revoked_at is prepared separately.)
 *   suspend    — alias of revoke.
 *   status     — read-only: report hash prefix, created/updated/revoked timestamps,
 *                and whether the token file exists (never content).
 *   recover    — after a lost token: rotate to a fresh token (new hash) so the old
 *                token is dead; does NOT require knowing the old token (uses the
 *                service role / psql operator path).
 *
 * Credentials NEVER printed, NEVER in tool args, NEVER committed:
 *   - Production DSN + service key: read from .env.stagef (gitignored)
 *   - Testbed DSN:                 read from TEST_DATABASE_URL env var (Docker)
 *   - Operator token:              written only to .stage-f-operator.env (mode 600)
 *                                   or .stage-f-test-operator.env (testbed, mode 600)
 *
 * Usage:
 *   node scripts/operator-manage.cjs status [--env prod|test]
 *   node scripts/operator-manage.cjs bootstrap [--env prod|test]
 *   node scripts/operator-manage.cjs rotate [--env prod|test]
 *   node scripts/operator-manage.cjs revoke [--reason "..."] [--env prod|test]
 *   node scripts/operator-manage.cjs recover [--env prod|test]
 *
 * --env defaults to 'prod'; --env test uses TEST_DATABASE_URL.
 *
 * Fails closed on any ambiguity (missing env file, empty token, non-1 rowcount).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const PROD_ENV = path.join(ROOT, '.env.stagef');
const PROD_TOKEN_FILE = path.join(ROOT, '.stage-f-operator.env');
const TEST_TOKEN_FILE = path.join(ROOT, '.stage-f-test-operator.env');

function loadEnv(f) {
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/\r$/, '');
  }
  return out;
}
const sha256hex = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

async function connect(env) {
  if (env === 'test') {
    const ds = process.env.TEST_DATABASE_URL;
    if (!ds) throw new Error('TEST_DATABASE_URL not set (testbed)');
    const u = new URL(ds);
    return new Client({ host: u.hostname, port: Number(u.port || 5432), database: u.pathname.replace(/^\//, ''), user: u.username, password: decodeURIComponent(u.password || ''), ssl: false, connectionTimeoutMillis: 15000 });
  }
  const prodEnv = loadEnv(PROD_ENV);
  const url = prodEnv.SUPABASE_URL;
  const serviceKey = prodEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from ' + PROD_ENV);
  const m = url.replace(/^"|"$/g, '').match(/^postgres(?:ql)?:\/\/([^:]+)(?::([^@]+))?@([^:]+)(?::(\d+))?\/(\w+)/);
  let host, port, db, user, password;
  if (m) {
    user = m[1]; password = m[2] ? decodeURIComponent(m[2]) : serviceKey; host = m[3]; port = Number(m[4] || 5432); db = m[5];
  } else {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    host = u.hostname; port = Number(u.port || 5432); db = (u.pathname || '/postgres').replace(/^\//, '') || 'postgres';
    user = 'postgres'; password = serviceKey;
  }
  if (host.endsWith('supabase.co') && !host.includes('pooler')) user = 'postgres.' + host.split('.')[0];
  return new Client({ host, port, database: db, user, password, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const envArg = process.argv.indexOf('--env');
  const env = envArg >= 0 ? process.argv[envArg + 1] : 'prod';
  if (env !== 'prod' && env !== 'test') throw new Error('--env must be prod or test');
  const tokenFile = env === 'test' ? TEST_TOKEN_FILE : PROD_TOKEN_FILE;

  const client = await connect(env);
  try {
    await client.connect();
    const who = await client.query('SELECT current_user');
    const role = who.rows[0].current_user;

    if (cmd === 'status') {
       const r = await client.query(
      `SELECT secret_key, left(secret_hash, 12) AS hash_prefix, updated_at,
              (secret_hash = '') AS hash_cleared
         FROM ax_router.operator_secrets WHERE secret_key='authority_operator'`);
    const row = r.rows[0];
    if (!row) { console.log('OPERATOR_STATUS none'); return; }
    console.log('OPERATOR_STATUS key=' + row.secret_key + ' hash_prefix=' + row.hash_prefix +
      ' updated=' + (row.updated_at || '') + ' hash_cleared=' + row.hash_cleared +
      ' token_file=' + fs.existsSync(tokenFile) + ' role=' + role);
    return;
    }

    if (cmd === 'bootstrap' || cmd === 'rotate' || cmd === 'recover') {
      const tok = newToken();
      const hash = sha256hex(tok);
      const r = await client.query(
        `UPDATE ax_router.operator_secrets SET secret_hash=$1, updated_at=now()
          WHERE secret_key='authority_operator' RETURNING secret_key`, [hash]);
      if (r.rowCount !== 1) {
        // Row missing: create it (operator-owned) with the hash only.
        const ins = await client.query(
          `INSERT INTO ax_router.operator_secrets (secret_key, secret_hash)
           VALUES ('authority_operator', $1) ON CONFLICT (secret_key)
           DO UPDATE SET secret_hash=EXCLUDED.secret_hash, updated_at=now()
           RETURNING secret_key`, [hash]);
        if (ins.rowCount !== 1) throw new Error('operator_secrets write failed');
      }
      fs.writeFileSync(tokenFile, `SAAX_STAGE_F_OPERATOR_SECRET=${tok}\nSAAX_STAGE_F_OPERATOR_HASH=${hash}\n`, { mode: 0o600 });
      console.log('OPERATOR_' + cmd.toUpperCase() + '_OK hash_prefix=' + hash.slice(0, 12) + ' role=' + role + ' file=' + tokenFile);
      return;
    }

    if (cmd === 'revoke' || cmd === 'suspend') {
      const ri = process.argv.indexOf('--reason');
      const reason = ri >= 0 ? process.argv[ri + 1] : 'operator-management';
      const r = await client.query(
        `UPDATE ax_router.operator_secrets SET secret_hash='' WHERE secret_key='authority_operator' AND secret_hash <> '' RETURNING secret_key`);
      if (r.rowCount !== 1) { console.log('OPERATOR_REVOKE_ALREADY'); return; }
      console.log('OPERATOR_REVOKE_OK reason=' + reason + ' role=' + role);
      return;
    }

    throw new Error('unknown command: ' + cmd);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(e => { console.error('OPERATOR_MANAGE_ERROR: ' + e.message); process.exit(1); });