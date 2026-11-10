# SAAX Public Contact Email Routing — Ops Record

**Date:** 2026-11-06
**Repo:** ax-router — HEAD `c6e2ba78` = origin/main (verified); working tree dirty pre-existing, preserved uncommitted.
**Task:** Route `disputes@`, `privacy@`, `security@`, `support@` at saax-protocol.com to `reachsaaxprotocol@gmail.com`.

## 1. Provider and current DNS state (verified live 2026-11-06)

Authoritative DNS: **Cloudflare** (NS `mitch.ns.cloudflare.com`, `cass.ns.cloudflare.com`).
Inbound mail: **Cloudflare Email Routing** — MX records point at its gateway; SPF includes its include; DMARC exists.

| Record | Value | Meaning |
|---|---|---|
| MX | `route1.mx.cloudflare.net` (95), `route2.mx.cloudflare.net` (23), `route3.mx.cloudflare.net` (85) | Cloudflare Email Routing inbound active |
| TXT (SPF) | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Cloudflare authorized to send on behalf |
| TXT | `google-site-verification=IEYZLgV9Y0KipSPrRozk6f0cglsdbN_ECP6BnHSR8qk` | Google verification (pre-existing, unrelated) |
| TXT (DMARC) | `v=DMARC1; p=none; rua=mailto:2710578371ea44f0b4a7bbfcbeb25c93@dmarc-reports.cloudflare.net` | Reporting only, no enforcement |

The site's public trust docs (security.md / privacy.md / disputes.md / welcome.md, commit `96567df4`) already expose the four branded addresses and state "email forwarding is live on saax-protocol.com". The DNS layer is **consistent with that claim** (Cloudflare Email Routing is the active inbound gateway).

## 2. What this task verified vs. did not verify

**Verified (credential-free):**
- Cloudflare Email Routing gateway is live: direct SMTP conversation against `route2.mx.cloudflare.net` returns `220 mx.cloudflare.net Cloudflare Email ESMTP Service ready`.
- RCPT-stage acceptance for all four aliases **and** a nonexistent control address (`nonexistent-probe-xyz@saax-protocol.com`) — Cloudflare's gateway accepts RCPT for any address at that stage, so **RCPT acceptance alone does not prove per-address rules exist and is not evidence of a catch-all either**.
- Envelope-sender authorization is enforced: anonymous `MAIL FROM:<...@example.com>` is rejected at end-of-DATA with `550 5.7.1 ... isn't allowed to send email for saax-routing-test@example.com` — i.e., the gateway requires the envelope sender to be an authorized sender for its domain (SPF/DKIM-style check). This is correct Cloudflare Email Routing behavior, and it means **unauthenticated SMTP submission cannot be used to deliver the four test messages**.

**NOT verified (requires interactive access that was declined this run):**
- The existence of the four per-address routing rules (or catch-all state) in the Cloudflare Email Routing dashboard.
- Destination-address verification status for `reachsaaxprotocol@gmail.com` in Cloudflare Email Routing.
- Actual Gmail delivery / Inbox-vs-Spam placement.

**No configuration was changed.** No MX/SPF/DMARC edit, no rule change, no catch-all toggle, no mailbox deletion, no provider migration. Rollback is therefore trivial: nothing to restore. The DNS snapshot above is the rollback reference if anyone later edits routing records — restore exactly these values.

## 3. Intended routes (contract)

| Public address | Destination |
|---|---|
| disputes@saax-protocol.com | reachsaaxprotocol@gmail.com |
| privacy@saax-protocol.com | reachsaaxprotocol@gmail.com |
| security@saax-protocol.com | reachsaaxprotocol@gmail.com |
| support@saax-protocol.com | reachsaaxprotocol@gmail.com |

## 4. Exact remaining dependencies (blockers)

Routing **configuration** and **delivery confirmation** each need one Commander action; everything after is autonomous:

1. **Connect Cloudflare in StarNet** (CONNECT › ABILITIES › APPS › Cloudflare, sign-in). Then I can read Email Routing rules for `saax-protocol.com`, create the four routes if missing, and record exact rule state — no dashboard navigation, no secret values.
2. **Connect Gmail (app password)** (CONNECT › ABILITIES › APPS › Gmail (app password); Commander creates the app password themselves at myaccount.google.com → Security → App passwords — the value never passes through me). Then I can (a) send the four authorized labeled test messages via the destination account and (b) read the inbox to confirm arrival and Inbox/Spam placement with header-level recipient evidence.
   - Alternative without any connector: the Commander sends the four test messages manually from reachsaaxprotocol@gmail.com to the four aliases (destination == sender proves the inbound path end-to-end) and reports receipt; I then verify header evidence if access is granted.

The Gmail sign-in connector is **blocked in this StarNet build** (Google review pending), and dashboard logins (Gmail, Cloudflare) were declined in this run — that is the exact blocker. The SMTP layer cannot send (envelope-sender authorization enforced), and no local credential exists for Resend (production/Preview envs mask the key; the key is only readable inside Vercel function runtime — outside this run's access).

## 5. Test messages

Four test messages were **scripted** (unique subjects per alias, harmless content, no personal data) but **not sent** — no authorized sender credential was available. The send/verify step will run immediately after dependency 1 and/or 2 above is satisfied. Message-IDs are pre-generated per alias (`saax-routing-<alias>-<timestamp>@example.com`) so each alias is independently attributable.

## 6. Reproduction commands

```powershell
# DNS layer
Resolve-DnsName saax-protocol.com -Type MX
Resolve-DnsName saax-protocol.com -Type TXT
Resolve-DnsName _dmarc.saax-protocol.com -Type TXT

# SMTP gateway probe (credential-free): expect 220 Cloudflare Email ESMTP Service ready
node saax-smtp-probe.cjs   # script: EHLO/MAIL FROM/RCPT TO per address

# After connectors are connected (not available in this run):
#   Cloudflare: GET zones/{zone}/email/routing/rules  -> read/create 4 routes
#   Gmail app-password: send 4 labeled messages, IMAP-search arrival + folder
```

## 7. Status summary

| Address | Configured destination | Test result | Inbox/Spam |
|---|---|---|---|
| disputes@saax-protocol.com | reachsaaxprotocol@gmail.com | **PENDING** — no authorized sender / no rule read | Pending |
| privacy@saax-protocol.com | reachsaaxprotocol@gmail.com | **PENDING** | Pending |
| security@saax-protocol.com | reachsaaxprotocol@gmail.com | **PENDING** | Pending |
| support@saax-protocol.com | reachsaaxprotocol@gmail.com | **PENDING** | Pending |

Routing is **DNS-consistent with Cloudflare Email Routing** but not rule-confirmed; delivery is **not confirmed**. Completion requires one of the two Commander actions in §4.
