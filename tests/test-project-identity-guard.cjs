#!/usr/bin/env node
// Gate J.16, Workstream A3 — fail-closed identity guard test.
// Proves: canonical project passes; SafeCity project fails closed; unset fails closed;
// non-Supabase host fails closed; JSON output shape.
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const GUARD = path.resolve(__dirname, '../scripts/_verify_project_identity.mjs');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function runGuard(env) {
  try {
    const out = execFileSync(process.execPath, [GUARD], { env: Object.assign({}, process.env, env), encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: e.stdout || '' };
  }
}

// 1. Canonical project -> exit 0
const ok = runGuard({ SUPABASE_URL: 'https://codboejrwohkjidrrcgl.supabase.co' });
check('canonical project exits 0', ok.code === 0, 'code=' + ok.code);
check('canonical project prints PASS', /ALL_CONFIGURED_URLS_RESOLVE_TO_SAAX_PRODUCTION/.test(ok.out));

// 2. SafeCity project (wrong) -> exit 1, identifies the offender
const bad = runGuard({ SUPABASE_URL: 'https://nlmmrqgzintyynelyuep.supabase.co' });
check('SafeCity project exits 1', bad.code === 1, 'code=' + bad.code);
check('SafeCity project names WRONG_PROJECT', /WRONG_PROJECT/.test(bad.out));
check('SafeCity project names the offending id', /nlmmrqgzintyynelyuep/.test(bad.out));
check('SafeCity project refuses to run queries', /refusing to run queries/.test(bad.out));

// 3. Unset -> exit 1
const unset = runGuard({ SUPABASE_URL: '' });
check('unset URL exits 1', unset.code === 1, 'code=' + unset.code);
check('unset URL says NO_URL_CONFIGURED', /NO_URL_CONFIGURED/.test(unset.out));

// 4. Non-Supabase host -> exit 1
const nonSup = runGuard({ SUPABASE_URL: 'https://localhost:3000' });
check('non-Supabase host exits 1', nonSup.code === 1, 'code=' + nonSup.code);

// 5. db.<ref> host form also passes (Supabase connection-pooler host style)
const pooler = runGuard({ SUPABASE_URL: 'https://db.codboejrwohkjidrrcgl.supabase.co' });
check('db.<ref>.supabase.co canonical passes', pooler.code === 0, 'code=' + pooler.code);

// 6. --json shape
try {
  const j = execFileSync(process.execPath, [GUARD, '--json'], { env: Object.assign({}, process.env, { SUPABASE_URL: 'https://codboejrwohkjidrrcgl.supabase.co' }), encoding: 'utf8' });
  const parsed = JSON.parse(j);
  check('--json parses', parsed.verdict && typeof parsed.verdict.ok === 'boolean', 'verdict.ok=' + parsed.verdict && parsed.verdict.ok);
  check('--json reports ok=true for canonical', parsed.verdict.ok === true);
} catch (e) {
  check('--json parses', false, e.message);
}

console.log('\n=== identity-guard test: ' + pass + '/' + (pass + fail) + ' passed ===');
process.exit(fail === 0 ? 0 : 1);
