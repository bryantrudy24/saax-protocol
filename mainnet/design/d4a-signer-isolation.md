# Phase D4A — Signer Isolation and Signed-Transaction Protection

Status: D4A complete (local, tested). Production key custody NOT claimed.
Date: 2026-10-18. HEAD at implementation: 2e9290ce + local D4A commit.

## 1. Threat model and actual process/key boundaries

| Asset | Where it lives | Boundary |
|---|---|---|
| Relayer private key | `SAAX_D2_RELAYER_KEY` env, worker process only | Loaded ONLY in `worker/signing-vault.js` (`loadRelayerSigner`). NOT imported by any `endpoint/*` module. Synthetic hardhat test key is the default in test CLIs — never a production secret. |
| Evaluator owner keys | `SAAX_SIGNER_PRIVATE_KEY` / `SAAX_EVALUATOR_PRIVATE_KEY` (env, scripts) | Used for decision approval (EIP-712 verdict/mutual recovery) — NEVER loaded into the relayer signing path or the API process. |
| Signed transaction bytes (prepared) | `prepared_txs.signed_bytes` / `signed_envelope` in the D1/D2/D3 SQLite store | D4A: **plaintext path replaced by AES-256-GCM envelope** when protection is on. The envelope holds ciphertext; `signed_bytes` holds a non-executable `ENC:<kid>:<txHash>` marker. |
| Prepared-key (encryption) | `SAAX_PREPARED_KEY` (32-byte hex) or `SAAX_PREPARED_KEY_FILE` | Never in the DB, repo, logs, or exports. `kid = SAAX_PREPARED_KEY_ID`. Rotation = new key + new kid; old envelopes readable while old key supplied. |
| Evaluator/mutual authorization material | `operations.action_args` (persisted) + EIP-712 vote objects | These are signed **authorizations**, not keys. They are intentionally public in exports as scoped proofs (mandate: "verification exports legitimately require scoped proofs"). |
| Pilot token | `SAAX_PILOT_TOKEN` (env) | Bearer transport gate; redacted from logs; rotated per participant. |
| Journal signer key | `SAAX_JOURNAL_SIGNER_KEY` | Worker process env; journal entries are pushed to the journal store, never the raw key. |

**Plaintext remnants:** the migration does NOT claim erasure of old plaintext in WAL/backups/temp files. Row change ≠ erasure. Storage/backup rotation is required to clear remnants; this is documented in the migration method and the D4A incident procedure (§6).

**Distinction:** private keys vs signed executable authorizations vs intentionally public proofs:
- SECRET: private keys, prepared-key, pilot token.
- RESTRICTED: raw signed transaction bytes (now encrypted at rest; only the restricted broadcast path decrypts).
- INTENTIONALLY PUBLIC: verdict/mutual authorization signatures inside exports (scoped proofs required by the verifier).

## 2. Actual signer isolation achieved

`worker/signing-vault.js` is the relayer signing boundary:
- `signViaVault` enforces BEFORE signing: op binding (`expectedOpId`), allowed chain, custody destination, supported+allowed contract action (selector decode), zero value, gasPrice ≤ `maxGasPrice`, gasLimit ≤ `maxGasLimit`.
- Returns `{ signedBytes, txHash, nonce }` ONLY to the worker's `_prepareAccepted`, which seals into the envelope and persists. Bytes never cross into the API process, logs, or exports.
- `worker/prepared-vault.js` provides the envelope (see §3).
- `d2-worker._resolvePreparedBytes` is the ONLY decrypt gateway: `validatePrepared`/`broadcastPrepared` use it; a substituted envelope/ciphertext/context fails closed; a wrong/missing key fails closed without mutating the stored envelope.

**Trust boundary (stated plainly):** the signing vault runs as a separate module/process **under the same OS account** as the worker. That is NOT strong host-compromise isolation — a fully compromised host can read the key from the environment. Remote/HSM/KMS signing is NOT implemented and is PENDING (no synthetic adapter is labeled production key custody).

## 3. Encryption envelope and key-delivery interface

- Implementation: node `crypto` AES-256-GCM (established authenticated encryption; NO custom cryptography).
- Envelope: `{ v:1, alg:'AES-256-GCM', kid, iv(12B), tag(16B), ct, aad }` — `aad` = canonical authenticated context `{op, chain, sender, accountNonce, intendedTx:{to, txHash}}`.
- Fresh unique IV per seal (`crypto.randomBytes`); tag authenticates ciphertext + AAD.
- Key delivery: `SAAX_PREPARED_KEY` (64-hex) XOR `SAAX_PREPARED_KEY_FILE` (mutually exclusive). `SAAX_PREPARED_KEY_ID` picks the key version. No key in DB/repo/logs/exports.
- Decrypt ONLY in the restricted broadcast/recovery path (`d2-worker._resolvePreparedBytes`), which recomputes the tx hash from the decrypted bytes and validates against the durable `tx_hash` (and the existing `validatePrepared` field checks: sender, chain, destination, value, nonce, action, contract state).
- Canonical agreement/journal hashes are NOT changed by encrypting internal storage.

## 4. Runtime/dependency versions

- Node v26.3.0 (repo baseline), `node:crypto` (built-in), `node:sqlite` (built-in, WAL).
- ethers ^6.17.0 (signing, hash).
- Safe 1.4.1 + CompatibilityFallbackHandler (local EVM tests, real artifacts via helpers.compileSafe).
- No new external runtime dependency.

## 5. Startup, recovery, rotation, backup procedures

**Startup (protected worker):** set `SAAX_PREPARED_KEY` (or `_FILE`) + `SAAX_PREPARED_KEY_ID`; set `SAAX_D4A_PROTECT=1`; run `node worker/run-d3-worker.cjs <store> <chainId> <custody> <rpc> ...`. On startup, `refuseIfUnsupportedStore()` is available; protected broadcast refuses plaintext rows with a precise migration requirement.

**Recovery:** same as D2/D3 (`--recover`, `--broadcast`, `--reconcile`) — the prepared bytes are decrypted inside the restricted path using the durable bindings; restart restores the exact tx hash (proven R6).

**Rotation:** generate a new 32-byte key; set `SAAX_PREPARED_KEY_ID` (new) + supply BOTH old and new keys at open time for pending records (old envelope kid → old key; new seals → new key). New envelopes carry the new kid. Rotation does NOT revoke an already-signed transaction.

**Backup/restore:** the SQLite store (with envelopes) + the prepared key, delivered SEPARATELY (key out of the backup). Restore the DB and supply the key via env/file. Never back up SAAX_PREPARED_KEY into the same store/backup.

**Key-rotation and signed-tx distinction (incident procedure):** deleting ciphertext or rotating the key does NOT revoke an already-signed, already-broadcast transaction. Revocation = a chain-level action (e.g. custody finality), never storage hygiene. Preserve this distinction in incident handling.

## 6. Migration and rotation limits

- Explicit `migratePreparedPlaintextToEnvelope(vault, opts)` — NEVER auto-runs; restart-safe (guarded per-row UPDATE), idempotent, interrupted-run safe (sealed rows skipped; unsealed rows resume). Proven S1-S5.
- `refuseIfUnsupportedStore()` — protected broadcast refuses plaintext rows with the migration requirement (S1).
- LIMIT: migration replaces the row; WAL/backups/temp files may retain prior plaintext. Do not claim erasure. Rotate storage/backups to clear.
- LIMIT: a legacy store with no key available cannot be migrated (SEAL_FAILED surfaces precisely); operator must supply the key.
- Missing/wrong key: open fails closed (KEY_UNAVAILABLE / AUTH_DECRYPT_FAILED / KEY_ID_MISMATCH), stored envelope unmodified (recoverable, R7/R7b).
- Rotation: old-kid envelopes remain readable while old key supplied (S6/U9). A rotated-out key that is no longer supplied makes old pending records unreadable — keep the key until all old envelopes are consumed, or re-seal them under the new kid explicitly.

## 7. Exact remaining production key-provisioning decisions

1. **Where the real relayer key lives in production**: env-in-worker vs external KMS/HSM. Remote/HSM/KMS signing is NOT implemented — pending.
2. **Prepared-key custody**: who holds the 32-byte key, how it is delivered to the worker at boot, and who may rotate; must be separate from the store/backup.
3. **Safe (evaluator 2-of-3) config in production**: pin Safe version + handler + owner/threshold; owners must be distinct entities; owner/threshold governance monitored (Phase 3B checkpoint).
4. **Key separation in the hosted service**: the production API must keep evaluator owner keys and the relayer key out of the API process — the local D4A separation is proven in-process; the hosted deployment must enforce the same boundary (no `SAAX_*_PRIVATE_KEY` in the route process env).
5. **External signer/Safe dependency config**: Safe singleton + factory addresses on the target chain, handler addresses, verification of `isValidSignature` behavior; outstanding review (independent design/security review NOT COMPLETED).

## 8. Test evidence

- `scripts/test-d4a-vault.cjs` — 56/56 PASS, exit 0. Coverage: envelope roundtrip/IV-uniqueness/substitution-context-key-version rejection; signing-vault bounds (chain/dest/action/value/fee/op mismatch); store migration (refuse idempotence interruption resume rotation); protected worker (encrypted-at-rest, validate-through-envelope, ciphertext substitution rejects, restart exact-hash restore, missing-key fail-closed, broadcast pipeline reaches the EVM with a genuine BadSignature outcome for forged args, API process has no key path, logs/exports clean).
- `node --check` on all touched modules: OK.

## 9. Pending (D4B / production)

- Remote/HSM/KMS signing adapter (documented pending, not synthetic-labeled).
- Production key provisioning + host-level isolation (separate OS account/container per worker; keys via secret manager).
- Real Safe singleton + owner/threshold governance wiring in the hosted worker.
- Independent design/security review of the signer/envelope design.
- Envelope is AES-256-GCM (proven cipher); audit of key-management procedures remains outstanding.
## 10. Phase D4B closure — entry-point gates, complete signing intent, verdict rejection, runtime boundaries

Status: D4B closure (local, tested). HEAD at closure: 58879c3e + local D4B closure commit. No push, no hosted deployment, no production keys.

### 10.1 Supported worker entry points (inventory)

| Entry point | Purpose | Production-config gate | Signs/broadcasts |
|---|---|---|---|
| `worker/run-d2-worker.cjs` | D2 CLI (child-process crash/restart tests, reconcile) | YES — `assertConfigGates` fails closed before store open/sign/broadcast | prepare/broadcast/reconcile |
| `worker/run-d3-worker.cjs` | D3 integrated worker launcher (poll work_items, execute, drain outbox) | YES — `assertConfigGates` fails closed before store open/sign/broadcast (added in closure) | prepare/broadcast/reconcile/export |
| `endpoint/route-server.js` | API process | N/A — writes ACCEPTANCE rows only via `worker-integration.js`; never signs or broadcasts | NO |
| `worker/d1-worker.js` / `d2-worker.js` / `d3-worker.js` | worker libraries (invoked by the CLIs and tests) | enforced by the calling CLI | via caller |

Every production-intended worker startup path now refuses unsafe configuration before any database mutation, signing, or broadcasting. The API process cannot import the vaults or reach a private-key path (R9, re-proven incl. D4B modules). The synthetic reference signer (`external-signer-refserver.cjs`) refuses to run unless `SAAX_EXEC_MODE=local`, chain 31337, a strong token, and a key are all present — a configuration string saying "production" or "external signer" never certifies the test adapter as production-ready.

### 10.2 Required signing intent (production execution path)

The production execution path (D1 external lane → D2 validatePrepared → D3 execution) requires a COMPLETE, immutable intent:

- **Transaction type and chain** — `type` must be legacy 0 or EIP-1559 2; `chainId` fixed to the configured chain.
- **Expected sender** — the external signer's identity (verified via `getSignerIdentity`); returned bytes independently recovered and compared (`EXTERNAL_SIGNER_WRONG_KEY` on mismatch).
- **Reserved account nonce** — reserved durably before signing; decoded nonce must equal the reservation.
- **Destination, value, exact calldata** — custody address, zero value, calldata decoded to the expected action; the calldata is built from the authorized actionArgs and the SAME bytes are re-validated after signing (`TX_INTENT_MISMATCH:<field>` on any substitution). The signed data is never derived from mutable actionArgs after authorization without revalidation.
- **Gas limit + fee fields/bounds** — gasLimit within `maxGasLimit`; EIP-1559 `maxFeePerGas`/`maxPriorityFeePerGas` both present and within bounds; legacy `gasPrice` within bound; unsupported features (access lists, unknown types, blob fields) rejected.
- **Auxiliary fields** — `normalizeIntent` rejects unsupported fields (`UNSUPPORTED_TX_FIELD`) and mixed fee models (`MIXED_FEES`).

The D1 external lane constructs this complete intent and freezes it before signing (`Object.freeze`); validateBytes then enforces every constrained field on the returned bytes. Missing critical constraints never become unconstrained.

### 10.3 Verdict rejection (validly-encoded unauthorized cases)

The D4B suite proves rejection of cryptographically VALID but unauthorized verdicts, not just the ambiguous-format negative:

- **Wrong evaluator signer** — a well-formed EOA (v,r,s) verdict by a non-evaluator → `EVALUATOR_MISMATCH`, rejected before signing, escrow stays Funded.
- **Correct signer over a different escrow** — a genuine Safe verdict over another escrow's commitmentId/digest → `ESCROW_BINDING_MISMATCH` (new execution-path check binding actionArgs to the op's escrowId + escrow digest), rejected before calldata build/sign, zero effects.
- **Invalid Safe authorization below threshold** — well-formed Safe sigBytes carrying 1-of-3 owners below the configured 2-of-3 threshold → the Safe's own `isValidSignature` (ERC-1271) rejects it; worker rejects before signing, escrow stays Funded.

The ambiguous-format negative (N6, `VERDICT_SIG_AMBIGUOUS`) remains, but is not the basis for claiming rejection of validly-encoded unauthorized verdicts.

### 10.4 Runtime process-secret boundaries (actual local launch path)

The source scan is complemented by a runtime demonstration through the actual local launch path. A child env-probe (`scripts/_env-probe-child.cjs`) is spawned as a REAL child with the exact env the supervisor builds for each entry-point class (via `env-allowlist.buildChildEnv`), and reports only NAMES of present candidate secrets (never values):

- **API child**: omits relayer (`SAAX_D2_RELAYER_KEY`), evaluator (`SAAX_EVALUATOR_PRIVATE_KEY`, `SAAX_SIGNER_PRIVATE_KEY`), decryption (`SAAX_PREPARED_KEY`), and external-signer keys; keeps only its required config.
- **Synthetic signer child**: receives only its required key (`SAAX_EXTERNAL_SIGNER_KEY` + policy vars); no relayer/evaluator/prepared key.
- **Worker child**: receives only necessary execution/storage credentials (`SAAX_WORKER_STORE`, chain/custody/RPC, journal, prepared key id, external-signer endpoint/token); no relayer key, no pilot token.
- A planted sentinel never reaches any child; the leaked-secret detector independently confirms which secrets a wholesale env pass would have leaked.

**Limitation (stated):** this is process-level separation under the SAME OS account. A compromised OS account can still read keys from the environment; it is NOT host-compromise isolation. Remote/HSM/KMS custody remains pending.

### 10.5 Focused + regression verification (closure)

- `node --check` on every changed module: OK.
- D4B suite (`scripts/test-d4b-external-signer.cjs`): full pass (count recorded at run time), including new S1D3–S4D3 D3-launcher refusals, ENV1–ENV4 runtime boundaries, Q2-0..Q2-4 complete-intent checks, and N8–N10 validly-encoded verdict negatives.
- Regressions: `test-d4a-vault.cjs`, `test-d1-worker.cjs`, `test-d2-worker.cjs`, `test-d3-integration.cjs`, `test-d3-action-auth.cjs` all pass unchanged.
- Separate-process local EVM run: D3 worker spawn + D4B REAL payout/refund still execute correctly.

### 10.6 Remaining gates (unchanged, restated)

- Remote/HSM/KMS signing adapter (production key custody pending).
- Host-level isolation (separate OS account/container; keys via secret manager).
- Hosted Safe governance wiring (real singleton/owner/threshold governance, snapshots at verdict block).
- Independent design/security review of signer/envelope design.
- Finality policy beyond local confirmations; public-chain activation remains disabled.
