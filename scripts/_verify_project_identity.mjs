#!/usr/bin/env node
/**
 * SAAX fail-closed production project identity guard (Gate J.16, Workstream A3).
 *
 * Validates that any Supabase/PostgREST URL referenced in the environment
 * resolves to the SAAX production project `codboejrwohkjidrrcgl` BEFORE any
 * read-only verification query runs. Aborts (exit 1) if:
 *   - no URL is configured at all, or
 *   - the URL references ANY other project (e.g. the SafeCity AI project
 *     `nlmmrqgzintyynelyuep`), or
 *   - the URL is malformed.
 *
 * Usage:
 *   node scripts/_verify_project_identity.mjs
 * Exit 0 = identity verified (safe to run read-only queries).
 * Exit 1 = identity mismatch/unset/malformed (fail closed, do NOT query).
 *
 * Optional: pass --json for machine-readable output.
 */
const CANONICAL_PROJECT = 'codboejrwohkjidrrcgl';

function parseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try { return new URL(s); } catch { return { malformed: true, raw: s }; }
}

function projectRefFromHost(hostname) {
  if (!hostname) return null;
  // db.<ref>.supabase.co / <ref>.supabase.co
  const m = hostname.match(/^(?:db\.)?([a-z0-9]{20})\.supabase\.co$/);
  return m ? m[1] : null;
}

function check(urlName, rawValue) {
  if (!rawValue) return { urlName, ok: false, reason: 'unset' };
  const parsed = parseUrl(rawValue);
  if (!parsed) return { urlName, ok: false, reason: 'unset' };
  if (parsed.malformed) return { urlName, ok: false, reason: 'malformed', raw: rawValue };
  const ref = projectRefFromHost(parsed.hostname);
  if (!ref) {
    // Not a supabase.co host — could be a self-hosted PostgREST URL. For the
    // guard we only allow the known production PostgREST endpoint; anything
    // else is treated as unknown identity (fail closed unless explicitly
    // overridden with SAAX_ALLOW_NON_SUPABASE=1).
    if (process.env.SAAX_ALLOW_NON_SUPABASE === '1' && rawValue.includes('postgrest')) {
      return { urlName, ok: true, reason: 'non-supabase-postgrest-allowed', host: parsed.hostname };
    }
    return { urlName, ok: false, reason: 'non-supabase-host', host: parsed.hostname, raw: rawValue };
  }
  if (ref === CANONICAL_PROJECT) {
    return { urlName, ok: true, reason: 'canonical', project: ref };
  }
  return {
    urlName,
    ok: false,
    reason: 'WRONG_PROJECT',
    project: ref,
    expected: CANONICAL_PROJECT,
    raw: rawValue,
  };
}

const candidates = [
  ['SUPABASE_URL', process.env.SUPABASE_URL],
  ['SAAX_SUPABASE_URL', process.env.SAAX_SUPABASE_URL],
  ['POSTGREST_URL', process.env.POSTGREST_URL],
  ['SAAX_POSTGREST_URL', process.env.SAAX_POSTGREST_URL],
];

const results = candidates.map(([name, val]) => check(name, val));
const anyConfigured = results.some(r => r.reason !== 'unset');
const allOk = results.filter(r => r.reason !== 'unset').every(r => r.ok);

let verdict;
if (!anyConfigured) {
  verdict = { ok: false, reason: 'NO_URL_CONFIGURED — refusing to run queries against an unknown database' };
} else if (allOk) {
  verdict = { ok: true, reason: 'ALL_CONFIGURED_URLS_RESOLVE_TO_SAAX_PRODUCTION' };
} else {
  const bad = results.filter(r => r.reason !== 'unset' && !r.ok);
  verdict = {
    ok: false,
    reason: 'IDENTITY_MISMATCH — refusing to run queries',
    offending: bad.map(b => ({ urlName: b.urlName, project: b.project || b.host || null, reason: b.reason })),
  };
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ verdict, checks: results }, null, 2));
} else {
  results.forEach(r => {
    if (r.reason === 'unset') console.log(`[SKIP] ${r.urlName} not set`);
    else if (r.ok) console.log(`[PASS] ${r.urlName} -> ${r.reason}${r.project ? ' (' + r.project + ')' : ''}`);
    else console.log(`[FAIL] ${r.urlName} -> ${r.reason}${r.project ? ' (' + r.project + ')' : ''}${r.raw ? ' raw=' + r.raw : ''}`);
  });
  console.log(verdict.ok ? `[PASS] ${verdict.reason}` : `[FAIL] ${verdict.reason}`);
}

process.exit(verdict.ok ? 0 : 1);
