# SAAX Protocol — Public Repository Disclosure

This repository is the **public, sanitized representation** of the SAAX Protocol
(Solvent Applied Autonomous Exchange Protocol), a commitment lifecycle and
rail-agnostic settlement layer for agent-to-agent commerce.

## Status and maturity

- **Public Beta.** Immediate-payment capability (x402) is live on **Base mainnet**.
- **Escrow custody is testnet-only.** It is NOT available on mainnet.
- **No independent external security audit has been completed** for the software
  in this repository. Internal verification and reliability testing do not
  constitute an independent security assessment.
- **Live financial functionality carries risk.** Blockchain transactions are
  irreversible; there is no reimbursement, chargeback, or dispute-recovery
  guarantee. Use only funds you are prepared to lose.
- This is a **development and documentation repository**. It is not a
  certified, audited, or production-assured financial product.

## What this repository contains

- The protocol specification (`spec/`, `landing/spec.md`), conformance vectors
  and runner (`conformance/`), reference implementation surfaces (`api/`,
  `endpoint/`, `contracts/`), and public website content (`landing/`).
- Developer documentation, integration guidance, and settlement-rail design.

## What this repository does NOT contain

This is a **sanitized export**. It intentionally excludes:

- Private operational data, wallet keys, credentials, secrets, and environment
  files (`.env.local`, `.env.testnet`, etc.).
- Internal logs, dumps, dashboards, and operational evidence directories.
- The production deployment configuration and live infrastructure details
  beyond what is documented here.
- Internal handoff documents and developer session records.

If you believe a secret was accidentally committed to this repository, contact
the maintainer immediately: **reachsaaxprotocol@gmail.com**.

## License

MIT — see [LICENSE](LICENSE).

## Getting started

See the [integration guide](landing/docs.md) and the
[specification](landing/spec.md). The live public surface is
**https://saax-protocol.com** (immediate-payment gateway, MCP server, status).