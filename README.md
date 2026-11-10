# SAAX Protocol

**Durable commitments for autonomous commerce.**

SAAX (Solvent Applied Autonomous Exchange Protocol) is an open commitment
lifecycle protocol for agent-to-agent commerce: it connects autonomous
payments, verifiable agreements, fulfillment, and recovery across independent
systems, so that **the commitment outlives the worker**.

- **Trust** — verifiable commitments, authorization, and evidence.
- **Durability** — commitments survive workers and processes.
- **Recovery** — interrupted transactions reconcile without unsafe retries.

## What SAAX does

SAAX is a **complementary** layer, not a replacement for existing systems:

| System | Role | SAAX relationship |
|---|---|---|
| [x402](https://docs.cdp.coinbase.com/x402) | HTTP-based machine payments | SAAX binds a payment to a durable commitment and settlement record |
| [AP2](https://developers.google.com/gemini/client-payments/overview) | Agent payment authorization/mandates | SAAX persists the agreement + evidence beyond the mandate |
| [ACP](https://agentcommerceprotocol.com) | Agentic checkout/commerce | SAAX adds lifecycle/durability semantics to commerce flows |
| [MCP](https://modelcontextprotocol.io) | Agent tool connectivity | SAAX exposes its lifecycle as MCP tools |
| [EAS](https://attest.sh) | Verifiable attestations | SAAX can anchor commitment digests as on-chain attestations |

Read more: [specification](landing/spec.md) · [integration guide](landing/docs.md) ·
[status](landing/status.md) · [security](landing/security.md)

## Live status

- **Public Beta.** x402 immediate payments are live on **Base mainnet** (USDC).
- **Escrow custody is testnet-only** (Base Sepolia preview). NOT available on mainnet.
- **Independent external security audit: pending.** Internal tests do not
  replace an independent assessment. Use only funds you are prepared to lose.
- The MPP rail is implemented but **not registered** in production (x402-only mode).

## Interfaces

- **HTTP gateway:** `POST https://saax-protocol.com/route` (x402 payment challenge)
- **Receipts:** `GET https://saax-protocol.com/receipt?txHash=...`
- **MCP server:** `https://saax-protocol.com/mcp`
- **OpenAPI:** `https://saax-protocol.com/openapi.json`
- **Discovery:** `https://saax-protocol.com/.well-known/saax.json`

## Repository layout

```
api/          Serverless HTTP functions (route, receipt, mcp, discovery)
endpoint/     Core protocol engine (commitment lifecycle, rails, evidence, idempotency)
contracts/    Escrow custody contracts (testnet) + mocks
spec/         Protocol specification + design docs
landing/      Public website content
conformance/  Conformance vectors + runner
tests/        Test suites
```

## Development

```bash
npm install
npm test          # run the test suites
node conformance/runner/run-conformance.mjs   # conformance vectors
```

## License

MIT — see [LICENSE](LICENSE). See [DISCLOSURE.md](DISCLOSURE.md) for status
and risk disclosures.

---

*SAAX is not a consumer marketplace, a payment rail, an identity provider, or
a replacement for x402 / AP2 / ACP / MCP. It is the durable commitment layer
above them.*