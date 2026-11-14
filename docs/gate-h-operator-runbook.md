# SAAX Gate H — Operator Credential Management Runbook

**Status:** VERIFIED on disposable Docker testbed (2026-11-14) · Production NOT modified
**Runner:** `scripts/operator-manage.cjs` (committed, task-owned)
**Verifier:** `scripts/verify-operator-failclosed.cjs` (testbed-only)

## 1. Purpose

Manage the SAAX production operator credential (`authority_operator`) — the one secret that
gates `provision_authority` (operator bootstrap) — without ever exposing the plaintext
credential in Git, tool arguments, chat, logs, or database tables.

## 2. Credential architecture (verified)

- **Database stores only a one-way SHA-256 hash** of the operator secret in
  `ax_router.operator_secrets.secret_hash` (row `secret_key='authority_operator'`).
- **Plaintext lives ONLY** in a mode-600 env file on the operator's machine:
  `.stage-f-operator.env` (production) / `.stage-f-test-operator.env` (testbed).
  Both are gitignored (`.stage-f-*`, `.env.stagef`).
- **`provision_authority` compares** `sha256(p_operator_token)` to the stored hash.
  Any mismatch → `AUTH_OPERATOR_TOKEN_INVALID`; a cleared/empty hash → any token fails
  (`AUTH_OPERATOR_TOKEN_REQUIRED`/`INVALID`). **Revocation is fail-closed.**
- Service role has **SELECT-only** on `operator_secrets`; no DML grants to any role.
- The runner connects via the `pg` driver over TLS to the transaction pooler (prod)
  or the disposable Docker Postgres (test), using `SUPABASE_SERVICE_ROLE_KEY` / DSN
  from gitignored env files. **No credential is printed or passed as a tool argument.**

## 3. Commands

| Command | Effect | When |
|---|---|---|
| `node scripts/operator-manage.cjs status [--env prod\|test]` | Read-only: hash prefix, updated_at, whether hash is cleared, whether token file exists | Any time |
| `node scripts/operator-manage.cjs bootstrap [--env prod\|test]` | Generate fresh 32-byte token; store ONLY its hash; write token to mode-600 env file | Initial setup / first operator |
| `node scripts/operator-manage.cjs rotate [--env prod\|test]` | Rotate hash in place; write new token to env file (old token dies) | Periodic rotation / suspected exposure |
| `node scripts/operator-manage.cjs revoke [--reason "..."] [--env prod\|test]` | **Clear the stored hash** → all provisioning fails closed | Emergency suspension |
| `node scripts/operator-manage.cjs recover [--env prod\|test]` | Fresh hash + new token file (does NOT need the old token) | Lost token / after revoke |

`--env` defaults to `prod`; `--env test` reads `TEST_DATABASE_URL` for the Docker testbed.

## 4. Production execution checklist (owner-authorized, separate approval required)

1. Confirm current hash via `status`.
2. `bootstrap` (first operator) or `rotate` (rotation).
3. Immediately verify `status` shows the new hash prefix and token file exists.
4. Verify a known-bad token is rejected via a read-only `provision_authority` attempt
   (testbed only — never on production).
5. Store the token file in the operator's password manager / secret vault; the file is
   the ONLY plaintext copy.
6. On suspected exposure: `revoke` → confirm `hash_cleared=true` → `recover` → verify.
7. Record the action in `authorization_events` via the operator's normal audit path.

## 5. Security properties (testbed-verified 2026-11-14)

- Real token provisions (`{"status":"provisioned"}`).
- Wrong token → `AUTH_OPERATOR_TOKEN_INVALID`.
- Cleared hash (revoked) → ANY token rejected (fail-closed).
- No plaintext in Git, tool args, chat, logs, or DB (hash only, mode-600 file).

## 6. Known limitation (documented, additive migration candidate)

The current `operator_secrets` schema has **no `created_at` / `revoked_at` columns** —
revocation is expressed by clearing the hash, which is schema-compatible but loses the
audit timestamp of the revocation itself. An **additive migration** (no data rewrite,
no table rewrite) is prepared at
`data/migration-20261114-gate-h-operator-secrets-audit.sql` adding those two columns,
so revocation/rotation timestamps are preserved. **This migration is NOT applied to
production and requires separate owner approval.** Until applied, `authorization_events`
is the authoritative audit trail for operator actions.

## 7. What NOT to do

- Never print or echo the token/hash value.
- Never pass the token in a SQL tool-call argument (the connector may log it).
- Never commit `.stage-f-*` / `.env.stagef` / token files (gitignored + `.gitignore` updated).
- Never weaken `provision_authority` to skip the token gate.
- Never give service_role INSERT/UPDATE/DELETE on `operator_secrets`.
