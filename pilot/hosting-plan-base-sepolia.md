# SAAX External Testnet Pilot — Isolated Base Sepolia Hosting/Access Plan

**Status:** DEPLOYED (see §1b Deployment surface). The deployment is authoritative; this document describes the actual deployed surface, so shutdown follows reality. Hosted pilot chain = Base Sepolia, chain ID 84532, RPC https://sepolia.base.org. The local EVM has its own distinct ID (31337).
**Scope:** one isolated testnet surface for the external pilot. Never touches production (`settlement.saax-protocol.com`, the production Railway/Vercel project, or the mainnet `.env`).

---

## 1. Deployment configuration

**Deployed: dedicated Railway testnet project, separate from production (see §1b for the live identifiers).**

- **Project:** `saax-pilot-testnet` (testnet-only; never the production project).
- **Service:** `saax-pilot-testnet-web` — web service, start command `node endpoint/route-server.js` (via Procfile + railpack.config.json, see §1b).
- **Port:** Railway injects `PORT`; the server honors `PORT` (route-server.js:98 `PORT = Number(process.env.PORT || process.env.SAAX_PORT || 8080)`); bind `0.0.0.0` on Railway (the server's default `SAAX_HOST` is `0.0.0.0`; on the local instance we pin `127.0.0.1`, on Railway leave default).
- **Region:** any; testnet only. No domain aliasing to production.

### 1b. Deployed surface (post-deploy — authoritative)

Actual live deployment, from the operational deploy record (untracked):
- **Hostname:** `https://saax-pilot-testnet-web-production.up.railway.app` (HTTPS; HTTP → 301). Railway-generated domain, TLS at the edge.
- **Project id:** `902af65a-c36f-4b3f-a8c1-4665c46e700c`
- **Service id:** `4b43744c-1c44-4091-8fd5-ba05db9fa17e`
- **Volume:** `/data` (id `b3f41b01-a459-49b4-b23f-8532dc9e4e60`) — durable escrow-access ledger mount (`SAAX_ESCROW_LEDGER=/data/escrow-access-ledger.json`).
- **Deployment id:** `d51610cc-64bd-4a57-a86f-e193ec35f29f` (SUCCESS).
- **Deployment commit:** `d1eb4c6d` (repo NOT pushed; the deploy uploaded the working-tree runtime surface, see below).

**Upload surface — .railwayignore (repo root, untracked):** the deploy excludes internal ledgers/scratch/unrelated content by explicit ignore list, for secret hygiene (internal ledgers, scratch, and unrelated scripts are not uploaded). This is required by the plan's own secret-handling rules.

**Start command mechanism — Procfile + railpack.config.json (untracked):** Railpack defaults to `node index.js`, which does not exist; a local `Procfile` (`web: node endpoint/route-server.js`) + `railpack.config.json` (healthcheck `/health`) set the real start command.

**npm peer conflict — .npmrc (`legacy-peer-deps=true`) included in the upload:** required by `@safe-global/safe-contracts@1.4.1` (a Phase 3B dev-dependency) which conflicts with ethers 6.17; unignoring `.npmrc` lets npm install complete.

**Transitive runtime deps included:** `verifier/crypto.js` (required by `endpoint/escrow-access.js`) and `scripts/shrinkage.js` (required by `scripts/rank-suppliers.js`) are part of the upload surface — both would otherwise be absent at runtime.

**Limitation — deployment is not reproducible from the repo alone:** `.railwayignore`, `Procfile`, and `railpack.config.json` are untracked operational files, and the deployed surface was assembled from the working tree per those files. The deployment is therefore reproducible only from the repo **plus** those three untracked operational files (and the offline `.env` values set in Railway secrets). This is a stated limitation, not a defect.

### Environment variables (testnet-only values — NEVER the production `.env`)
| Var | Value (non-secret) | Notes |
|---|---|---|
| `SAAX_CHAIN_ID` | `84532` | **Hosted pilot chain = Base Sepolia, chain ID 84532, RPC https://sepolia.base.org.** Chain guard refuses anything else (escrow.js:472). The local EVM has its own distinct ID (31337) and must never be described as 84532. |
| `SAAX_NETWORK` | `base-sepolia` | explicit intent: base-sepolia (pilot) vs local (EVM 31337) |
| `SAAX_RPC_URL` | `https://sepolia.base.org` | testnet RPC only |
| `SAAX_X402_MODE` | `self` | self-hosted gateway |
| `SAAX_ESCROW_BACKED` | `1` | escrow-backed routing active |
| `SAAX_CUSTODY_ADDRESS` | `0x5a5472d751839cd4968cbf1b136baf862279ff5d` | C5 testnet custody (verified deployed on 84532) |
| `SAAX_EAS_MODE` | `live` | real attestations on Base Sepolia |
| `SAAX_USDC_ADDRESS` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Base Sepolia USDC (6 decimals) |
| `SAAX_TEST_BUYER_ADDRESS` | *(participant wallet address, set at onboarding)* | the role-address map's buyer binding |
| `SAAX_SELLER_ADDRESS` | *(operator seller if operator-run; disclosed)* | |
| `SAAX_SIGNER_ADDRESS` | *(operator signer/evaluator if operator-run; disclosed)* | |
| `SAAX_HOST` | `0.0.0.0` | Railway (public web); local instances pin `127.0.0.1` |
| `SAAX_ESCROW_LEDGER` | `/data/escrow-access-ledger.json` | volume-pinned durable acceptance ledger (see §1b) |

*Table reconciles the pre-deploy plan with what is actually deployed. `SAAX_NETWORK` and `SAAX_HOST` were added after the plan's original env table was written; the deployed configuration includes them, so the table now describes the deployed state, not the pre-deploy intent.*

### Secret handling
- **Never** put `SAAX_SIGNER_PRIVATE_KEY`, `SAAX_SELLER_PRIVATE_KEY`, `SAAX_TEST_BUYER_KEY`, or any Supabase/DB credentials in the Railway dashboard env for this pilot surface *unless* the participant model requires it — and even then use Railway's **secret variables** (masked) or a secret manager, never the repo, never the build log, never the export.
- The **participant wallet key never leaves the participant**. The operator only ever sets the participant's *public address* (`SAAX_TEST_BUYER_ADDRESS`).
- The operator signer key, if used for evaluator verdicts, stays in Railway secrets only. The verifier (independent process) needs **no** keys — it reads the export + RPC.

### Durable storage
- **Access ledger** (`data/escrow-access-ledger.json`): durable JSON file (atomic rename). On Railway, each instance's filesystem is ephemeral across redeploys — so for the pilot surface, either (a) pin the ledger path to Railway's **volume mount** (`/data`), or (b) accept that the ledger resets on redeploy and the on-chain escrow state is the source of truth for reconciled outcomes. Recommendation: **(a)** attach a small Railway volume at `/data` and set `SAAX_ESCROW_LEDGER=/data/escrow-access-ledger.json` so accepted operations and nonce consumption survive redeploys. This is the pilot-blocking persistence requirement — the acceptance ledger must not reset mid-pilot.
- **Idempotency/rate-limit stores**: memory-only in this configuration (documented) — acceptable for a single-participant pilot; the access ledger is the durable acceptance store.
- **Supabase**: NOT required for the pilot. The verifier runs with `SUPABASE_URL=` empty and no DB access.

## 1b. Credential requirements (Item 3 — external participant keys)

### The external buyer provides ONLY their public address
- The buyer's own wallet signs and funds from the buyer's own device.
- The operator NEVER requests, receives, hosts, or stores the buyer's private
  key or seed phrase. The only buyer credential the operator sets is the
  PUBLIC address in `SAAX_TEST_BUYER_ADDRESS`.
- The buyer funds the escrow with their own wallet and signs the access
  authorization with their own key; the server verifies the signature against
  the configured public address (roleAddrFor('buyer')).

### Operator testnet credentials: exist vs loaded (distinction)
| Credential | Exists (testnet) | Loaded/usable by this instance | Notes |
|---|---|---|---|
| SAAX_SIGNER_PRIVATE_KEY (evaluator) | yes | yes, in .env | operator-run; disclosed as such in the pilot |
| SAAX_SELLER_PRIVATE_KEY (supplier) | yes | yes, in .env | operator-run; disclosed |
| buyer key (participant) | no — participant-owned | NEVER loaded | only the public address is configured |
| EAS attester key | yes | yes (live attestations) | operator attester, distinct from evaluator |
| Supabase/DB creds | yes | yes for persistence | verifier runs WITHOUT them (SUPABASE_URL empty) |

### Role-address verification without exposing secrets
- The instance verifies role addresses by public address comparison only:
  `roleAddrFor(role)` resolves `SAAX_TEST_BUYER_ADDRESS` / `SAAX_SELLER_ADDRESS`
  / `SAAX_SIGNER_ADDRESS` and the access-auth signature must recover to that
  public address. No private key is ever read, printed, or transmitted.
- A key exists (file/env present) does NOT mean it is loaded: the testnet
  route-server loads only `SAAX_X402_MODE=self` + the escrow env; the
  production `.env` (mainnet keys) is never loaded into the testnet instance.

## 2. Access restrictions — concrete controls (replaces the unlisted-URL approach)

The pilot surface is reachable ONLY through the following concrete controls;
an unlisted or random URL is NOT an access restriction.

- **Participant bearer token (implemented, tested):** the route server requires
  `Authorization: Bearer <SAAX_PILOT_TOKEN>` on every request when the env var
  is set (route-server.js `requirePilotToken`, before the kill-switch gate).
  401 without it, 401 on mismatch, constant-time compare. The token value is
  NEVER logged (log redaction strips the Authorization header).
- **TLS:** HTTPS only — the Railway-generated domain (`*.up.railway.app`)
  terminates TLS at the edge; the plan requires HTTPS and refuses plain-HTTP
  for the pilot surface. No self-signed or plaintext listener.
- **Revocation:** rotating `SAAX_PILOT_TOKEN` (env) revokes immediately (read
  per request). At pilot close the token is rotated AND the project deleted.
- **Application-level authorization retained:** the bearer token is a
  TRANSPORT gate only. The EIP-712 access authorization (`x-saax-access-auth`,
  role/action/escrow/custody/chain/nonce/expiry bound, signature-verified) and
  the chain/custody checks (escrow.js `verifyOnChain` — chain 84532 enforced,
  mainnet bypass removed) remain the authorization of record. A leaked URL or
  token alone cannot execute an escrow action without a valid signed access
  artifact for that exact escrow.
- **Kill switch / rate limits (Day 8 gates):** leave on; rate-limit store
  memory-only is fine for a single participant.
- **No tunnel, no port-forward, no public dashboard.** The local dev instance
  stays bound to `127.0.0.1`; the hosted pilot is the ONLY exposed surface and
  it is token-gated, TLS-only, and deleted at close.

### 2b. Health endpoint exposure (current state: public, to be trimmed)

`/health` is **currently public by code** — it sits in a separate branch of the
HTTP dispatch, *outside* `requirePilotToken` (route-server.js:1959). It exposes
only non-secret operational state: `ok, mode, verifyMode, x402Mode, seller,
killSwitch, store, rateLimitStore, rails, port, at` — no tokens, keys, or
participant data. The pre-deploy plan did not document this exposure.

**Intended state:** the next code change trims `/health` to `{"ok":true}` and
moves the detailed state to a **token-gated** endpoint. The plan records the
current state as **"public, to be trimmed"** — not "public by design." No route
handler (the `/route` escrow path) is reachable without the bearer token; the
token gate (`requirePilotToken`) runs before all other gates (route-server.js:793).

## 3. Expected cost

- **Railway testnet web service:** ~$5/month (smallest instance, the free tier may cover a single low-traffic service; actual depends on the plan in effect — verify at deploy time, keep it the smallest footprint).
- **Test gas on Base Sepolia:** testnet ETH is free (faucets) or from the existing test wallet; expected gas per full flow ≈ 2-3 txs (fund, release/refund) at trivial testnet prices. **No mainnet funds are ever touched.**
- **EAS attestation on Base Sepolia:** testnet attestation is free/negligible (no production fee).
- **Total exposure per pilot:** ~1 test USDC + ~0.03 test ETH, per the v1 budget. The hosting charge (~$5/mo if any) is the only real cost and only if the Commander authorizes deploy.

## 4. Participant URL provisioning

1. Commander authorizes the pilot + names the external buyer.
2. Operator (me) creates the dedicated Railway project, sets the testnet env, mounts the volume.
3. Buyer provides their **public** Base Sepolia wallet address ONLY. The buyer keeps their private key on their own device, signs and funds with their own wallet; the operator never sees or hosts the key. (If the supplier is operator-run, that is disclosed.)
4. Operator sets `SAAX_TEST_BUYER_ADDRESS=<buyer address>` (and supplier/evaluator addresses as applicable).
5. Buyer receives: the pilot URL **privately**, the onboarding instructions (v1 package §4), the USDC token address, and the custody address.
6. Buyer completes: fund the escrow, service, evidence, evaluator release or refund.
7. Operator (or buyer, independently) runs the verifier: `node verifier/verify-export.js <export> --rpc https://sepolia.base.org`.

## 5. Shutdown

Reconciled against the actual deployed resources (record: `_pilot-deploy-record.txt`, untracked; project/service/volume ids in §1b).

- **Project deletion vs domain-disable paths:** the recommended close path is to **delete the Railway project** (`saax-pilot-testnet`, id `902af65a-c36f-4b3f-a8c1-4665c46e700c`) — deleting the project removes the service (`saax-pilot-testnet-web`, id `4b43744c-1c44-4091-8fd5-ba05db9fa17e`), the domain (`saax-pilot-testnet-web-production.up.railway.app`), and the volume (`/data`, id `b3f41b01-a459-49b4-b23f-8532dc9e4e60`) in one action, guaranteeing no residual exposure. **Domain-disable only** (keeping the project/volume) is the alternative if intermediate access is still wanted; it is NOT sufficient for full close because the service/volume keep running and accumulating.
- **Token revocation:** the pilot token is held as the Railway secret `SAAX_PILOT_TOKEN` (set via stdin, never committed, never logged). Revocation = rotating that secret value in Railway (the gate reads it per request, route-server.js:166), and confirming it is dead by requesting the deployed `/route` with the old token and observing 401 `pilot access token invalid`. At close, rotate the token and then delete the project so both the token and the domain are dead.
- **What to preserve after close:** the export artifact, the verifier output, the participant feedback, and the build log — committed (non-sensitive only).
- **No residual exposure:** verify the domain returns nothing (the project is deleted) and no tunnel/port remains.

---

## Authorization needed to execute this plan
1. **Authorization to deploy the dedicated testnet Railway project** (the only real cost: ~$5/mo if above free tier; no production touch).
2. **A named external buyer** (address + authorization to onboard). Until then, this plan is prepared and reversible; nothing is deployed.