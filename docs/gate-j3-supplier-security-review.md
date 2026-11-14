# SAAX Gate J.3 — Phase C: Supplier Lookup Security Review

**Date:** 2026-11-14
**Reviewer:** Lucius (isolated; not an independent assessment)
**Tool:** `get_supplier_details` (read-only, MCP tool 26)
**Verdict:** **PASS**

## 1. Data Exposure Review

### Returned fields (the complete disclosure surface)
```
supplier_id           — public agent identifier (int or string form)
name                  — supplier display name
description           — supplier self-description
services              — [{name, endpoint, version}] public service endpoints
owner                 — public ETH address (all 123 records are 0x… addresses)
source                — provenance string ("indexed" default)
verification_status   — HARDCODED "unverified" (never fabricated)
last_verified_at      — HARDCODED null
```

### Index audit (123 suppliers)
- Record keys: exactly `agent_id, owner, name, description, services, source` (6 fields).
- **Zero secret-like fields:** no key/token/pass/cred/private/secret anywhere in the index schema.
- **Zero private identifiers:** no `internal-*`, `service-account`, `ops-*`, `saax-operator` entries present.
- **Service endpoints:** public HTTPS URLs only (no credentials embedded).
- **Owners:** all public ETH addresses (0x…) — appropriate for a public supplier registry; not personal data.
- **No verification provenance exists in the index** — therefore `verification_status` is hardcoded `"unverified"` and `last_verified_at` is `null`. This is the correct honest representation: **no fabricated verification timestamps or trust claims**.

### What the tool does NOT return
- Private/operational metadata (none exists in the index).
- Credentials, secrets, private keys (none exist in the index).
- Reputation scores, rankings, trust guarantees (explicitly excluded).
- Any field not in the allowlist (whitelist construction, not blacklist).

## 2. Adversarial Test Results (41/41 PASS)

Executable: `scripts/adv-supplier-probe.mjs` (offline, read-only, uses the real index + exact tool lookup semantics).

| Category | Inputs | Result |
|---|---|---|
| Path traversal | `..`, `../`, `../../etc/passwd`, `..\\..\\`, `%2e%2e%2f`, `..%2f..%2f` | all `not_found` |
| SQL/NoSQL injection | `' OR 1=1 --`, `" OR "1"="1`, `; DROP TABLE suppliers;--` | all `not_found` |
| Numeric abuse | `NaN`, `Infinity`, `-1`, `1e999`, `0.5` | all `not_found`/`error` |
| Prototype/pollution | `constructor`, `__proto__`, `toString`, `null`, `undefined` | all `not_found` |
| Unicode/edge | NUL, emoji, RTL-override, fullwidth digits, `0x0`, zero-address | all `not_found` |
| Overflow | 65-char string, 100-digit number | `error` (over 64-char limit) |
| Wildcards | `*`, `agent%` | `not_found` |
| Private IDs | `internal-1`, `service-account`, `ops-supplier`, `saax-operator` | all `not_found` (not in index) |
| Valid lookups | exact numeric + decimal-string forms | `ok` (regression) |
| Canonical forms | leading zeros, surrounding whitespace (trimmed/canonicalized) | `ok` — documented exact-match behavior, not an attack |

## 3. Security Properties Verified

1. **Read-only:** the tool performs no writes, no financial operations, no state changes.
2. **Exact-match only:** no partial match, no wildcard, no enumeration (a supplier must be identified exactly).
3. **Fail-closed:** missing/corrupt index → explicit `error: supplier index not loaded` (Gate J.3 fix), never an empty/ambiguous result.
4. **No enumeration:** every non-exact input returns `not_found`/`error`; the tool cannot be used to dump the registry.
5. **No fabrication:** verification status is always `unverified`/`null` unless the index carries authoritative data (it does not).
6. **No private disclosure:** only the 6 public fields are ever returned.
7. **Boundary preserved:** the tool does not create a supplier marketplace, identity authority, reputation oracle, or ranking system.

## 4. Residual Notes (non-blocking)
- The tool returns `owner` (public ETH address). This is appropriate for a public registry but should be re-reviewed if the registry ever contains non-public owner identities.
- Service `endpoint` values are public HTTPS URLs; if private endpoints are ever added to the index, they MUST be filtered before exposure (current index has none).
- Rate limiting is inherited from the MCP endpoint abuse-guard (`mcp_*` scopes); per-tool limits apply via the shared guard.

## 5. Verdict
**PASS** — `get_supplier_details` is safe for production deployment as reviewed. No unauthorized disclosure, no fabrication, no trust implications. Deployment remains subject to Release Gates A (reproducibility) and C (live verification) and the owner-approved nonfinancial scope.
