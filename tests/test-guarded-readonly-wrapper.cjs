#!/usr/bin/env node
// Gate J.17, Workstream C2/C3 — guarded read-only verification wrapper tests.
// Proves fail-closed identity enforcement BEFORE any protected SQL path:
//   - correct SAAX project passes
//   - SafeCity project rejected
//   - missing project id rejected
//   - malformed project id rejected
//   - unexpected valid Supabase project id rejected
//   - conflicting environment variables rejected
//   - missing credentials rejected
//   - wrong-project connector id rejected
//   - guard executes before SQL (no SQL path exists in the wrapper)
//   - failure handling and exit status are correct
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const WRAPPER = path.resolve(__dirname, '../scripts/guarded-readonly-verify.mjs');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function run(args, env) {
  try {
    const out = execFileSync(process.execPath, [WRAPPER].concat(args), { env: Object.assign({}, process.env, env || {}), encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: e.stdout || '' };
  }
}

// 1. Correct SAAX project id -> exit 0
const ok = run(['--project', 'codboejrwohkjidrrcgl']);
check('correct SAAX project exits 0', ok.code === 0, 'code=' + ok.code);
check('correct project prints IDENTITY_VERIFIED', /IDENTITY_VERIFIED/.test(ok.out));

// 2. SafeCity project (wrong) -> exit 1, names the offender
const bad = run(['--project', 'nlmmrqgzintyynelyuep']);
check('SafeCity project exits 1', bad.code === 1, 'code=' + bad.code);
check('SafeCity names WRONG_PROJECT', /WRONG_PROJECT/.test(bad.out));
check('SafeCity names the offending id', /nlmmrqgzintyynelyuep/.test(bad.out));

// 3. Missing project id -> exit 1
const missing = run(['--project']);
check('missing project id exits 1', missing.code === 1, 'code=' + missing.code);
check('missing id says PROJECT_ID_MISSING', /PROJECT_ID_MISSING/.test(missing.out));

// 4. Malformed project id -> exit 1
const malformed = run(['--project', 'codboejrwohkjidrrcgl-extra']);
check('malformed project id exits 1', malformed.code === 1, 'code=' + malformed.code);
check('malformed id says PROJECT_ID_MALFORMED', /PROJECT_ID_MALFORMED/.test(malformed.out));

// 5. Unexpected valid Supabase project id -> exit 1
const other = run(['--project', 'kndahofkhxpllmvnqlce']);
check('unexpected valid project exits 1', other.code === 1, 'code=' + other.code);
check('unexpected project names WRONG_PROJECT', /WRONG_PROJECT/.test(other.out));

// 6. Conflicting environment variables -> exit 1 (env guard)
const conflict = run(['--env'], { SUPABASE_URL: 'https://codboejrwohkjidrrcgl.supabase.co', SAAX_SUPABASE_URL: 'https://nlmmrqgzintyynelyuep.supabase.co' });
check('conflicting env vars exit 1', conflict.code === 1, 'code=' + conflict.code);
check('conflicting env vars refuse queries', /refusing to run queries/.test(conflict.out));

// 7. Missing credentials (no env) -> exit 1
const none = run(['--env']);
check('missing credentials exit 1', none.code === 1, 'code=' + none.code);
check('missing credentials say unverified', /ENV_URL_IDENTITY_UNVERIFIED|refusing to run queries/.test(none.out));

// 8. Wrong-project connector id (env says canonical, --project says SafeCity) -> exit 1
const mixed = run(['--env', '--project', 'nlmmrqgzintyynelyuep'], { SUPABASE_URL: 'https://codboejrwohkjidrrcgl.supabase.co' });
check('env canonical + connector SafeCity exits 1', mixed.code === 1, 'code=' + mixed.code);
check('mixed case refuses queries', /refusing to run queries/.test(mixed.out));

// 9. Guard executes before SQL — the wrapper contains NO SQL execution path
const src = require('node:fs').readFileSync(WRAPPER, 'utf8');
check('wrapper has no SQL execution path', !/execute_sql|pg\.|postgres|SELECT/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

// 10. --json shape on pass and on fail
const jOk = run(['--project', 'codboejrwohkjidrrcgl', '--json']);
let parsedOk = null; try { parsedOk = JSON.parse(jOk.out); } catch {}
check('--json parses on pass', parsedOk && parsedOk.verdict && parsedOk.verdict.ok === true);
const jBad = run(['--project', 'nlmmrqgzintyynelyuep', '--json']);
let parsedBad = null; try { parsedBad = JSON.parse(jBad.out); } catch {}
check('--json parses on fail', parsedBad && parsedBad.verdict && parsedBad.verdict.ok === false);
check('--json fail names offender', parsedBad && JSON.stringify(parsedBad.verdict).includes('nlmmrqgzintyynelyuep'));

console.log('\n=== guarded read-only verification wrapper: ' + pass + '/' + (pass + fail) + ' passed ===');
process.exit(fail === 0 ? 0 : 1);
