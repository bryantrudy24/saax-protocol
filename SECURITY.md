# Security Policy

## Reporting a vulnerability

The SAAX Protocol reference implementation is in **public Beta** and has not
completed an independent external security review. If you discover a security
vulnerability in this software:

- **Do not** open a public issue.
- Email the maintainers directly: **reachsaaxprotocol@gmail.com**
- Include: affected component, a minimal reproduction, and the impact.

We aim to acknowledge receipt within 5 business days and to respond with a
remediation plan or a detailed explanation within 15 business days.

## Responsible disclosure

Please allow a reasonable disclosure window before publishing details of any
confirmed vulnerability in a public forum. We will coordinate remediation and
disclosure with you.

## Scope

In-scope: the code and configuration in this repository and the public
surfaces at `saax-protocol.com` (`/route`, `/receipt`, `/mcp`, `/openapi.json`).

Out-of-scope: third-party dependencies unless the vulnerability is demonstrated
to affect this software's use of them; social engineering; denial-of-service
attacks against the live service.

## Status

- Immediate payments: **public Beta** (live on Base mainnet).
- Escrow custody: **testnet-only**; not available on mainnet.
- Independent external security review: **pending**.