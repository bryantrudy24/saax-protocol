# SAAX Protocol

Solvent Applied Autonomous Exchange Protocol — a vendor-neutral commitment lifecycle for autonomous commerce.

## What SAAX Is

SAAX is a commitment layer for autonomous commerce. It records what was authorized, what was committed, and what proves fulfillment; it verifies authority proofs and outcome evidence against defined acceptance criteria; and it defines recovery semantics for failure, timeout, partial completion, and dispute. Settlement is linked by reference — SAAX standardizes the commitment lifecycle without prescribing any payment rail.

## Current State

- MCP endpoint: https://saax-protocol.com/mcp (canonical; www.saax-protocol.com/mcp serves the same server) — runtime version 1.0.3, official registry io.github.bryantrudy24/saax-protocol version 1.0.4 (active/latest)
- MCP tools: 26 (verified live 2026-11-15)
- Commitment store: persistent in Supabase (ax_router.commitments)
- Buyer attribution: captured via the optional subscriptionEmail field on POST /route
- Settlement endpoint: https://saax-protocol.com/route (Vercel function)
- Conformance suite: 94/94 vectors passing (protocol conformance)

## MCP Tools

Discovery and status:
- get_protocol_info
- get_routing_fee
- ping
- route_request
- list_capabilities
- get_supplier_details

Commitments and lifecycle:
- prepare_commitment
- accept_commitment
- create_commitment
- get_commitment
- get_commitment_status
- get_commitment_history
- list_commitments

Recovery:
- get_recovery_status
- get_pending_actions
- resume_commitment

Lifecycle actions:
- cancel_commitment
- close_commitment

Evidence:
- submit_evidence
- list_evidence
- verify_evidence
- get_evidence_verification

Disputes:
- raise_dispute
- resolve_dispute
- list_disputes

Authority:
- get_authority_validation

## Architecture

The surface splits into two planes. The MCP endpoint (https://www.saax-protocol.com/mcp) handles discovery, validation, and status: protocol information, routing fees, capability listing, authority and evidence verification, and commitment lookup and lifecycle status. The HTTP /route endpoint (https://saax-protocol.com/route, a Vercel function) handles commitment creation: it accepts a capability request, runs the sanitization gate and provider ranking, and issues a 402 payment challenge that drives the x402/MPP settlement flow. Commitments created through either plane are persisted to Supabase (ax_router.commitments) and shared across functions, so they survive cold starts and are retrievable by commitment ID or buyer email.

## Links

- Specification: https://saax-protocol.com/spec
- Conformance suite: https://saax-protocol.com/conformance
- Integration guide: https://saax-protocol.com/docs
- Security: https://saax-protocol.com/security