#!/usr/bin/env node
/**
 * SAAX guarded read-only production verification wrapper (Gate J.17, Workstream C2).
 *
 * Fail-closed gate in front of ANY read-only production database verification:
 *   - `--env`        : runs scripts/_verify_project_identity.mjs against the
 *                      configured Supabase/PostgREST URL env vars. Aborts if the
 *                      URLs do not resolve to the SAAX production project.
 *   - `--project <id>`: validates a project id that was INDEPENDENTLY confirmed
 *                      via the Supabase connector (mcp__supabase__list_projects)
 *                      before the caller runs read-only SQL. Only the canonical
 *                      SAAX production project id is accepted.
 *
 * Usage:
 *   node scripts/guarded-readonly-verify.mjs --env
 *   node scripts/guarded-readonly-verify.mjs --project codboejrwohkjidrrcgl
 *   node scripts/guarded-readonly-verify.mjs --env --project codboejrwohkjidrrcgl --json
 *
 * Exit 0 = identity verified (safe to run read-only queries).
 * Exit 1 = identity unverified / mismatch / malformed / missing (do NOT query).
 *
 * NEVER prints secrets. NEVER runs SQL. This script only verifies identity.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_PROJECT = 'codboejrwohkjidrrcgl';
const GUARD = path.resolve(__dirname, '_verify_project_identity.mjs');

const args = process.argv.slice(2);
const wantEnv = args.includes('--env');
const wantProject = args.includes('--project');
const wantJson = args.includes('--json');

const checks = [];
const verdict = { ok: false };

function record(name, ok, detail) {
  checks.push({ check: name, ok, detail: detail || null });
}

// --- 1. Env-URL identity guard (fail closed) -------------------------------
if (wantEnv) {
  let code, out;
  try {
    out = execFileSync(process.execPath, [GUARD, '--json'], { encoding: 'utf8' });
    code = 0;
  } catch (e) {
    code = e.status;
    out = e.stdout || '';
  }
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* guard always emits JSON with --json */ }
  const ok = code === 0 && parsed && parsed.verdict && parsed.verdict.ok === true;
  record('env-url identity guard', ok, ok ? parsed.verdict.reason : (parsed ? parsed.verdict.reason : 'guard output unparseable'));
  if (!ok) {
    verdict.reason = 'ENV_URL_IDENTITY_UNVERIFIED — refusing to run queries';
    verdict.offending = (parsed && parsed.verdict.offending) || null;
    verdict.ok = false;
    if (wantJson) { console.log(JSON.stringify({ verdict, checks }, null, 2)); process.exit(1); }
    console.log('[FAIL] ' + verdict.reason);
    process.exit(1);
  }
}

// --- 2. Connector-confirmed project id (fail closed) ------------------------
if (wantProject) {
  const idx = args.indexOf('--project');
  const raw = args[idx + 1];
  const project = String(raw || '').trim().toLowerCase();
  if (!project) {
    record('connector project id present', false, 'missing value after --project');
    verdict.reason = 'PROJECT_ID_MISSING — refusing to run queries';
    verdict.ok = false;
    if (wantJson) { console.log(JSON.stringify({ verdict, checks }, null, 2)); process.exit(1); }
    console.log('[FAIL] ' + verdict.reason);
    process.exit(1);
  }
  if (!/^[a-z0-9]{20}$/.test(project)) {
    record('connector project id format', false, 'malformed id: ' + project);
    verdict.reason = 'PROJECT_ID_MALFORMED — refusing to run queries';
    verdict.ok = false;
    if (wantJson) { console.log(JSON.stringify({ verdict, checks }, null, 2)); process.exit(1); }
    console.log('[FAIL] ' + verdict.reason + ' (' + project + ')');
    process.exit(1);
  }
  if (project !== CANONICAL_PROJECT) {
    record('connector project id is SAAX production', false, 'got ' + project + ', expected ' + CANONICAL_PROJECT);
    verdict.reason = 'WRONG_PROJECT — refusing to run queries';
    verdict.offending = [{ source: '--project', project }];
    verdict.ok = false;
    if (wantJson) { console.log(JSON.stringify({ verdict, checks }, null, 2)); process.exit(1); }
    console.log('[FAIL] ' + verdict.reason + ' (' + project + ')');
    process.exit(1);
  }
  record('connector project id is SAAX production', true, 'project ' + CANONICAL_PROJECT + ' confirmed');
}

// --- 3. Nothing requested -> fail closed ------------------------------------
if (!wantEnv && !wantProject) {
  record('verification mode requested', false, 'pass --env and/or --project');
  verdict.reason = 'NO_VERIFICATION_MODE — refusing to run queries';
  verdict.ok = false;
  if (wantJson) { console.log(JSON.stringify({ verdict, checks }, null, 2)); process.exit(1); }
  console.log('[FAIL] ' + verdict.reason);
  process.exit(1);
}

verdict.ok = true;
verdict.reason = 'IDENTITY_VERIFIED — safe to run read-only queries';
if (wantJson) {
  console.log(JSON.stringify({ verdict, checks }, null, 2));
} else {
  for (const c of checks) console.log(c.ok ? '[PASS] ' + c.check : '[FAIL] ' + c.check);
  console.log('[PASS] ' + verdict.reason);
}
process.exit(0);
