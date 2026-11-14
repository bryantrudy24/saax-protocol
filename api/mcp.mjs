// SAAX Protocol — MCP discovery server (read-only, no settlement).
// Exposes protocol information to AI clients and agents via streamable-http.
//
// Day 13 (Task 3): wired to real gateway logic — ROUTES and READS only.
//   - route_request   : sanitize -> rank (scripts/rank-suppliers.js) -> ranked
//                       suppliers with scores, agent IDs, payTo addresses. If
//                       nothing clears the capability floor -> no_match.
//                       NEVER triggers settlement; the buyer initiates payment
//                       via the existing HTTP /route x402 challenge.
//   - get_commitment  : validates commitmentId format, then looks up the
//                       in-process commitment store (same lifecycle route-server
//                       uses). Returns the Trade Manifest or not-found.
//   - list_capabilities : distinct capabilities among active suppliers with
//                       supplier counts. Read-only.
//
// IMPORTANT: this module does NOT import endpoint/gateway.js or any
// wallet/signing code. It uses the ranker + a commitment store mirror, both
// pure read paths. Settlement stays on the HTTP /route endpoint.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { z } from "zod";
import crypto from "crypto";
import { lookupSubscription, lookupCommitmentById, lookupCommitmentsByEmail, commitmentRowToRecord, upsertCommitment } from "./lib/supabase.mjs";
import usageTelemetry from "../endpoint/usage-telemetry.js";
import { buildStoreClient } from "../endpoint/store.js";
import * as abuseGuard from "../endpoint/abuse-guard.js";

if (usageTelemetry.isEnabled()) {
  try { usageTelemetry.setStoreClient(buildStoreClient()); } catch (_) { /* stays disabled */ }
}

// Gate G.1: shared distributed rate limiting + auth-abuse protection.
// The Supabase rate_limits store is the shared authority across serverless
// instances; a memory window is ONLY a bounded fallback when the store is
// unreachable (fail-open on store outage, fail-closed on a real limit hit).
try {
  const storeMod = buildStoreClient();
  // reuse the same PostgREST client the ratelimit module uses (same table)
  abuseGuard.setStoreClient(storeMod);
} catch (_) { /* store optional; memory fallback engaged */ }

// ---- create_commitment (rail-neutral commitment minting) ---------------------
// Idempotent, deterministic, collision-resistant id: sha256(canonical terms +
// per-call nonce) -> "saax_" + first 16 hex chars (64 bits). A re-issue with
// identical terms yields a different id (each commitment is a distinct record)
// while the persisted row keeps a stable id. Rail is pure metadata.
const RAILS = new Set(["x402", "mpp", "ap2", "acp", "unspecified"]);

function canonicalTerms(input) {
  const pick = {};
  for (const k of ["buyerId", "sellerId", "terms", "acceptanceCriteria", "evidenceRequirements", "recoveryPolicy", "settlementRail"]) {
    if (input[k] !== undefined && input[k] !== null) pick[k] = input[k];
  }
  return JSON.stringify(pick, Object.keys(pick).sort());
}

function commitmentIdFrom(input, nonce) {
  const hash = crypto.createHash("sha256").update(canonicalTerms(input) + "|nonce:" + nonce, "utf8").digest("hex");
  return "saax_" + hash.slice(0, 16);
}

// ---- Ranker (read-only supplier ranking, same engine as the HTTP gateway) ----
import { buildRanker, sanitizeCapability as rankSanitize } from "../scripts/rank-suppliers.js";
import { buildShrinkage } from "../scripts/shrinkage.js";
import { currentWeights, weightsSnapshot } from "../endpoint/weights.js";

const ROUTE_SUPPLIER_INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "endpoint", "mcp-supplier-index.json");

// Load the shippable supplier index (endpoint/ ships to Vercel; data/ does not).
function loadSupplierIndex() {
  let raw = null;
  try {
    if (existsSync(ROUTE_SUPPLIER_INDEX)) raw = JSON.parse(readFileSync(ROUTE_SUPPLIER_INDEX, "utf8"));
  } catch (e) { /* fall through */ }
  if (!raw || !Array.isArray(raw.suppliers)) return [];
  return raw.suppliers;
}

// ---- Commitment store (read path) -------------------------------------------
// route-server.js keeps commitments inside gateway.commitmentFlow (in-process).
// The MCP layer is a SEPARATE process, so it maintains its own read-only mirror
// of commitments RECORDED in this instance. get_commitment, list_commitments and
// get_commitment_status all read this ONE store.
//
// PERSISTENCE (audited — daily-logs/saax-mcp-registry.md §13): this is an
// in-process module-level Map. It does NOT survive a Vercel cold start, and it
// is NOT shared with the HTTP /route function (a separate serverless process).
// A commitment minted via /route in another instance is not visible here.
const commitmentStore = new Map(); // commitmentId -> { commitmentId, createdAt, state, capability, terms, manifest }

// Canonical commitment lifecycle states (the vocabulary a state may take).
const LIFECYCLE_STATES = [
  "issued", "authority_validated", "accepted", "in_flight", "executing", "evidence_pending",
  "evidence_submitted", "verifying", "fulfilled", "failed", "recovering",
  "disputed", "settled", "finalized", "cancelled", "expired",
];

// Record a commitment manifest into the store and return its summary record.
// `state` defaults to the initial lifecycle state ('issued'); `terms` are drawn
// from the manifest's own fields (i.e. what the store actually holds).
function recordCommitment(manifest, opts = {}) {
  if (!manifest || !manifest.commitmentId) return null;
  const rec = {
    commitmentId: manifest.commitmentId,
    createdAt: opts.createdAt || new Date().toISOString(),
    state: (opts.state && LIFECYCLE_STATES.includes(opts.state)) ? opts.state : "issued",
    capability: manifest.capability || null,
    terms: {
      buyerAgentId: manifest.buyerAgentId || null,
      sellerAgentId: manifest.sellerAgentId || null,
      price: manifest.price || null,
      deadline: manifest.deadline || null,
      acceptanceCriteria: manifest.acceptanceCriteria || null,
      cancelCondition: manifest.cancelCondition || null,
      manifestHash: manifest.manifestHash || null,
    },
    manifest,
  };
  commitmentStore.set(rec.commitmentId, rec);
  return rec;
}

// Summary shape for list_commitments (a subset reflecting what the store holds).
function summarizeCommitment(rec) {
  return {
    commitmentId: rec.commitmentId,
    createdAt: rec.createdAt,
    state: rec.state,
    capability: rec.capability,
    terms: rec.terms,
  };
}

// ---- Capability index (cached after first call) -----------------------------
let capabilitiesCache = { list: [], at: 0 };

function refreshCapabilitiesIfStale(suppliers) {
  const now = Date.now();
  if (capabilitiesCache.at && now - capabilitiesCache.at < 60_000) return capabilitiesCache.list;
  const counts = new Map();
  for (const s of suppliers) {
    const svcs = Array.isArray(s.services) ? s.services.map(x => (x && x.name) || "").join(" ") : "";
    const hay = ((s.name || "") + " " + (s.description || "") + " " + svcs).toLowerCase();
    // Detect capability-ish keywords present in the supplier's own text.
    for (const kw of ["security", "scan", "audit", "data", "analytics", "automation", "workflow", "agent", "ai", "llm", "model", "payment", "settle", "rail", "design", "content", "writing"]) {
      if (hay.includes(kw)) counts.set(kw, (counts.get(kw) || 0) + 1);
    }
  }
  capabilitiesCache = {
    list: [...counts.entries()].map(([capability, suppliers]) => ({ capability, suppliers })),
    at: now,
  };
  return capabilitiesCache.list;
}

// ---- Witnessed route demands ------------------------------------------------
// Consolidated into commitmentStore above (records carry the manifest).

// Version source of truth: read from package.json at runtime so the
// endpoint's self-reported version always matches the published package.
// Falls back to "1.0.3" if the file cannot be read at module load.
let _pkgVersion = "1.0.3";
try {
  const _pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  if (existsSync(_pkgPath)) _pkgVersion = JSON.parse(readFileSync(_pkgPath, "utf8")).version || _pkgVersion;
} catch (_) { /* keep fallback */ }

const PROTOCOL = {
  name: "saax-protocol",
  version: _pkgVersion,
  fullName: "SAAX Protocol — Solvent Applied Autonomous Exchange Protocol",
  description:
    "Governed commitment lifecycle and rail-agnostic settlement layer for agent-to-agent commerce. Routes demand to verified suppliers, settles payments via x402 or MPP, and writes on-chain reputation feedback.",
  repository: "https://github.com/bryantrudy24/saax-protocol",
  rails: ["x402", "mpp"],
  lifecycle: [
    "commitment (manifest issued before payment)",
    "settlement requirement R (method-neutral)",
    "rail-selected credential validation",
    "settlement via selected rail",
    "spend receipt binding commitment to rail reference",
  ],
  routingFeeMicroUSDC: 50000,
  routingFeeUsd: "0.05",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  chainId: 8453,
};

// ---- Canonical tool-name registry (Phase 5E) -------------------------------
// Single source of truth for discovery surfaces (plain-GET response, metadata,
// future OpenAPI tool list). Populated by captureTool at registration time;
// never a hard-coded subset that can drift from the JSON-RPC surface.
const REGISTERED_TOOL_NAMES = [];
function captureTool(name) {
  if (name && !REGISTERED_TOOL_NAMES.includes(name)) REGISTERED_TOOL_NAMES.push(name);
  return name;
}

// Eagerly populate at module load (cold-start safe for plain-GET discovery).
captureTool("get_protocol_info");
captureTool("get_routing_fee");
captureTool("ping");
captureTool("route_request");
captureTool("get_commitment");
captureTool("list_capabilities");
captureTool("list_commitments");
captureTool("get_commitment_status");
captureTool("create_commitment");
captureTool("get_evidence_verification");
captureTool("get_authority_validation");
captureTool("get_commitment_history");
captureTool("get_recovery_status");
captureTool("get_pending_actions");
captureTool("resume_commitment");
captureTool("cancel_commitment");
captureTool("close_commitment");
captureTool("prepare_commitment");
captureTool("accept_commitment");
captureTool("submit_evidence");
captureTool("list_evidence");
captureTool("verify_evidence");
captureTool("raise_dispute");
captureTool("resolve_dispute");
captureTool("list_disputes");

// ---- Fail-closed sanitizer (same posture as the HTTP boundary) ---------------
// All MCP input crosses this. Non-string / empty / oversized input is rejected
// (fail closed). Capability text is additionally reduced to alphanumeric
// keywords by the ranker's own sanitizer.
function sanitizeInput(raw, { maxLen = 500, allowEmpty = false } = {}) {
  if (raw === undefined || raw === null) return { ok: false, reason: "missing required input" };
  if (typeof raw !== "string") return { ok: false, reason: "input must be a string" };
  if (raw.length > maxLen) return { ok: false, reason: "input exceeds maximum length " + maxLen };
  if (raw.trim() === "" && !allowEmpty) return { ok: false, reason: "input must not be empty" };
  return { ok: true, value: raw };
}

function validateCommitmentId(id) {
  if (typeof id !== "string" || id.length < 10 || id.length > 128) {
    return { ok: false, reason: "commitmentId must be a 10-128 char string" };
  }
  if (!/^[a-zA-Z0-9:_-]+$/.test(id)) {
    return { ok: false, reason: "commitmentId contains invalid characters" };
  }
  return { ok: true, value: id };
}


// ---- Premium gating (SAAX Premium subscription) ----------------------------
// The subscriptions table is written ONLY by the Stripe webhook
// (api/stripe/webhook.mjs) via a SECURITY DEFINER upsert RPC. Reads go through
// the lookup RPC (status='active' AND current_period_end > now()).
// Identity is resolved from the X-SAAX-Email header (or X-SAAX-Session-Email) —
// the operator maps a customer's email to their agent/session. Keeps gating
// stateless and N+1-free.
const PREMIUM_PAYMENT_REQUIRED = {
  "Trial": "https://saax-protocol.com/checkout?plan=trial",
  "Developer": "https://buy.stripe.com/8x2fZg1GR96BcC11keawo00",
  "Business": "https://buy.stripe.com/cNifZg85f6Yt6dD2oiawo01",
  "Enterprise": "mailto:reachsaaxprotocol@gmail.com",
};


// ---- Session-scoped identity (from HTTP headers) ----------------------------
// The MCP SDK doesn't pass raw HTTP headers into tool handlers, so we capture
// X-SAAX-Email at the handler level keyed by Mcp-Session-Id. Sessions inherit
// the identity for the whole conversation.
const sessionIdentityStore = new Map(); // sessionId -> email

function identityFromRequest(req) {
  if (!req) return null;
  const h = req.headers || {};
  return h["x-saax-email"] || h["x-saax-session-email"] || null;
}

// ---- Gate G.1: request bounds + client identity ------------------------------
const MAX_BODY_BYTES = Number(process.env.SAAX_MCP_MAX_BODY_BYTES || 256 * 1024); // 256 KiB
const MAX_EVIDENCE_BYTES = Number(process.env.SAAX_MCP_MAX_EVIDENCE_BYTES || 64 * 1024); // 64 KiB
const MAX_BODY_MESSAGE = "MCP request body exceeds the configured size limit";

function clientIpFromRequest(req) {
  if (!req || !req.headers) return "unknown";
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) {
    // Vercel sets X-Forwarded-For to the client IP (leftmost, trusted edge).
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

// Tool handlers run inside SDK closures with no access to the HTTP request.
// Stateless mode processes exactly one request per handler invocation, so a
// module-level IP slot is race-safe there (used ONLY for throttle bucket keys
// and auth-failure counting � never for authorization). Stateful mode falls
// back to "unknown" for handler-scoped calls when no request is active.
let currentRequestIp = "unknown";
function setCurrentRequestIp(ip) { currentRequestIp = ip || "unknown"; }
function handlerIp() { return currentRequestIp; }

// Extract the tool name from a JSON-RPC request so the per-op tier can apply.
function toolNameFromBody(parsedBody) {
  if (!parsedBody || typeof parsedBody !== "object") return null;
  if (Array.isArray(parsedBody)) {
    const first = parsedBody[0];
    if (first && first.method) {
      const m = String(first.method).replace(/^tools\//, "");
      if (m === "call" && first.params && first.params.name) return String(first.params.name);
      return m;
    }
    return null;
  }
  if (parsedBody.method) {
    const m = String(parsedBody.method).replace(/^tools\//, "");
    if (m === "call" && parsedBody.params && parsedBody.params.name) return String(parsedBody.params.name);
    return m;
  }
  // Notifications / responses carry no method; treat as non-sensitive.
  return null;
}

async function readBodyBounded(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error(MAX_BODY_MESSAGE);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Evidence envelope size guard (payloads only; never raw secrets). Applied at
// the submit_evidence tool boundary in addition to the HTTP body cap.
function evidenceSizeGuard(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  const raw = JSON.stringify(evidence);
  if (raw.length > MAX_EVIDENCE_BYTES) {
    return { ok: false, reason: "evidence envelope exceeds " + MAX_EVIDENCE_BYTES + " bytes" };
  }
  return { ok: true, bytes: raw.length };
}

// Per-request abuse check at the HTTP boundary (before session creation and
// before proof verification). Principal is only trusted AFTER verification �
// until then the IP tier bounds the source. Returns {ok:false,status:429,...}
// on a real limit hit; never throws on a store error (fail-open).
async function guardRequest(req, { tool }) {
  const ip = handlerIp();
  try {
    return await abuseGuard.checkMcpRequest({ ip, principal: null, tool });
  } catch (e) {
        // checkMcpRequest itself throws only in unexpected paths; fail closed for
    // sensitive tools so a guard failure can never disable abuse protection.
    if (abuseGuard.SENSITIVE_TOOLS.has(tool)) {
      return { ok: false, status: 503, limitType: 'store-unavailable', message: 'MCP abuse guard unavailable; sensitive operation refused (fail-closed)' };
    }
    return { ok: true, counts: {}, errors: ["guard:" + String(e.message || e)] };
  }
}

// Verified-principal tier: applied INSIDE tool handlers after EIP-712 proof
// verification, keyed on the recovered signer (never a claimed agentId). A
// forged proof is rejected before any principal bucket is touched. On a 429 the
// caller receives the standard MCP error payload.
async function guardPrincipal(principal, tool) {
  if (!principal) return { ok: true };
  try {
    return await abuseGuard.checkMcpRequest({ ip: null, principal, tool });
  } catch (e) {
        if (abuseGuard.SENSITIVE_TOOLS.has(tool)) {
      return { ok: false, status: 503, limitType: 'store-unavailable', message: 'MCP abuse guard unavailable; sensitive operation refused (fail-closed)' };
    }
    return { ok: true, errors: ["guard:" + String(e.message || e)] };
  }
}

// Record a failed proof verification for auth-abuse throttling (per-source,
// bounded backoff; anti-lockout: a later VALID proof succeeds and clears).
async function recordAuthFailure(principal, ip) {
  try {
    await abuseGuard.recordAuthFailure({ ip: ip || null, principal: principal || null });
  } catch (_) { /* non-fatal */ }
}

async function gatePremium(email, toolName) {
  if (!email) {
    return {
      ok: false,
      payload: {
        status: "payment_required",
        reason: "no_identity",
        message: `Pass your subscription email as the subscriptionEmail argument to use ${toolName}.`,
        tool: toolName,
        subscribe: {
          trial: PREMIUM_PAYMENT_REQUIRED["Trial"],
          developer: PREMIUM_PAYMENT_REQUIRED["Developer"],
          business: PREMIUM_PAYMENT_REQUIRED["Business"],
        },
      },
    };
  }
  let sub = null;
  try {
    sub = await lookupSubscription(email);
  } catch (e) {
    console.error("[gatePremium] lookup failed:", e.message);
    return { ok: false, payload: { status: "error", reason: "gate_lookup_failed", message: e.message } };
  }
  if (!sub) {
    return {
      ok: false,
      payload: {
        status: "payment_required",
        reason: "no_active_subscription",
        message: `No active SAAX Premium subscription found for ${email}.`,
        tool: toolName,
        subscribe: {
          trial: PREMIUM_PAYMENT_REQUIRED["Trial"],
          developer: PREMIUM_PAYMENT_REQUIRED["Developer"],
          business: PREMIUM_PAYMENT_REQUIRED["Business"],
        },
      },
    };
  }
  return { ok: true, email, sub };
}

// ---- Per-session MCP server factory -----------------------------------------
// route_request is pure read; it does not mint commitments. This hook exists so
// a future phase that mints can persist here; kept minimal and inert for now.
export function noteCommitment(manifest, opts) {
  return recordCommitment(manifest, opts);
}

import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const _preflightCore = await Promise.resolve(_require("../endpoint/preflight-core.js"));
const _ProposalStoreMod = await Promise.resolve(_require("../endpoint/proposal-store.js")).catch(() => null);
const _acceptanceCore = await Promise.resolve(_require("../endpoint/acceptance-core.js")).catch(() => null);
const _AcceptanceStoreMod = await Promise.resolve(_require("../endpoint/acceptance-store.js")).catch(() => null);
const _lifecycleMcp = await Promise.resolve(_require("../endpoint/lifecycle-mcp.js")).catch(() => null);
const _lifecycle = await Promise.resolve(_require("../endpoint/lifecycle.js")).catch(() => null);
// The MCP SDK's Protocol owns a SINGLE transport: connect() throws "Already
// connected to a transport. Call close() before connecting to a new transport,
// or use a separate Protocol instance per connection." A module-level singleton
// server therefore cannot serve concurrent sessions safely (closing one
// request's transport would tear down another's). Following the SDK's own
// simpleStreamableHttp example, each MCP session gets its OWN McpServer +
// transport, registered in `sessions` below. Tool closures share only
// module-level read caches (commitmentStore, sessionIdentityStore) � safe:
// they are plain synchronous Maps, never torn down per session.
function createSessionServer() {
  const server = new McpServer({
    name: PROTOCOL.name,
    version: PROTOCOL.version,
  });

// -----------------------------------------------------------------------------
// Tool 1 — get_protocol_info (unchanged)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_protocol_info",
  {
    title: "Get SAAX Protocol information",
    description: "Returns the SAAX Protocol version, available capability count, and the URL to the specification. Call this when an agent needs a one-time overview of the protocol. For pricing, use get_routing_fee. For the full capability list, use list_capabilities. For a liveness check, use ping.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(PROTOCOL, null, 2) }],
  })
);

// -----------------------------------------------------------------------------
// Tool 2 — get_routing_fee (unchanged)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_routing_fee",
  {
    title: "Get SAAX routing fee",
    description: "Returns the current routing fee schedule. Call this before initiating a routing request to determine the expected cost. For capability discovery, use list_capabilities. For protocol overview, use get_protocol_info.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            amount: PROTOCOL.routingFeeMicroUSDC,
            currency: "USDC",
            decimals: 6,
            usd: PROTOCOL.routingFeeUsd,
            asset: PROTOCOL.asset,
            chainId: PROTOCOL.chainId,
            rails: PROTOCOL.rails,
          },
          null,
          2
        ),
      },
    ],
  })
);

// -----------------------------------------------------------------------------
// Tool 3 — ping (unchanged)
// -----------------------------------------------------------------------------
server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Returns a lightweight liveness response. Call this to verify the endpoint is reachable. Do not use for discovery, capability listing, or pricing — use get_protocol_info, list_capabilities, or get_routing_fee instead.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: "ok" }] })
);

// -----------------------------------------------------------------------------
// Tool 4 — route_request (WIRED: real ranking, no settlement)
// -----------------------------------------------------------------------------
server.registerTool(
  "route_request",
  {
    title: "Route a demand to ranked suppliers",
    description: "Submits a capability request and returns ranked supplier matches. Commitment creation with payment runs through the HTTP POST /route endpoint, not this tool. Use list_capabilities first to discover available capabilities. For commitment lookup after routing, use get_commitment.",
    inputSchema: {
      capability: z.string().describe("The capability demanded, e.g. 'security scan'"),
      budget: z.number().optional().describe("Maximum budget in USDC the buyer will pay"),
      deadline: z.number().optional().describe("Deadline in seconds from now for delivery"),
    },
  },
  async ({ capability, budget, deadline }) => {
    const cap = sanitizeInput(capability, { maxLen: 200 });
    if (!cap.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "no_match", reason: cap.reason }, null, 2) }] };
    }

    const suppliers = loadSupplierIndex();
    if (!suppliers.length) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "supplier index not loaded" }, null, 2) }] };
    }

    // Build the ranker the same way the HTTP gateway does (local state -> ranker).
    const repMap = {};
    for (const s of suppliers) {
      const probe = s.reputation_probe || null;
      if (probe) repMap[s.agent_id] = { agent_id: s.agent_id, clients: probe.clients || 0, count: probe.count || 0, avgX100: probe.avgX100 };
    }
    const ranker = buildRanker({ agents: suppliers, repMap, leaderboard: [] });

    let result;
    try {
      result = ranker(cap.value, { topN: 5 });
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: String(e.message || e).slice(0, 300) }, null, 2) }] };
    }

    if (result.status !== "ok") {
      return { content: [{ type: "text", text: JSON.stringify({ status: result.status, capability: cap.value, reason: result.reason }, null, 2) }] };
    }

    const ranked = result.candidates.map((c) => ({
      agentId: c.agent_id,
      name: c.name,
      score: c.score,
      match: c.match,
      category: c.category,
      payTo: c.payTo || (c.reputation_probe ? c.reputation_probe.owner : null),
      rail: "x402", // routed via the HTTP /route challenge; rail resolved at settle time
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "ok",
              capability: cap.value,
              budget,
              deadline,
              count: ranked.length,
              suppliers: ranked,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// -----------------------------------------------------------------------------
// Tool 5 — get_commitment (WIRED: commitment store lookup)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_commitment",
  {
    title: "Get a commitment manifest",
    description: "Returns the full commitment object for a given commitment ID — including terms, state, manifest hash, and evidence references. Call this when an agent needs the complete commitment record. For status-only polling, use get_commitment_status. For listing all commitments for a subscriber, use list_commitments.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id (0x-prefixed or agent-id style) to look up"),
    },
  },
  async ({ commitmentId }) => {
    const vid = validateCommitmentId(commitmentId);
    if (!vid.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: vid.reason }, null, 2) }] };
    }
    const cid = vid.value;

    // Supabase is the source of truth (persisted by the gateway on issuance).
    // The in-process Map is used only as a cache when the DB is unreachable.
    let row = null;
    try {
      row = await lookupCommitmentById(cid);
    } catch (e) {
      console.error("[get_commitment] lookup failed:", e.message);
    }
    if (!row) {
      const cached = commitmentStore.get(cid);
      if (!cached) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", commitmentId: cid }, null, 2) }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "found", manifest: cached.manifest, from: "cache" }, null, 2) }],
      };
    }
    const rec = commitmentRowToRecord(row);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "found", manifest: rec.manifest, from: "supabase" }, null, 2) }],
    };
  }
);

// -----------------------------------------------------------------------------
// Tool 6 — list_capabilities (NEW: read-only capability discovery)
// -----------------------------------------------------------------------------
server.registerTool(
  "list_capabilities",
  {
    title: "List routed capabilities",
    description: "Returns the capabilities currently indexed by the SAAX Router, with supplier counts per capability. Call this to discover what can be routed. For pricing of a specific capability, use get_routing_fee. For protocol overview, use get_protocol_info.",
    inputSchema: {},
  },
  async () => {
    const suppliers = loadSupplierIndex();
    const caps = refreshCapabilitiesIfStale(suppliers);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "ok", capabilities: caps }, null, 2),
        },
      ],
    };
  }
);


// -----------------------------------------------------------------------------
// Tool 7 — list_commitments (PREMIUM-gated read; same gating as the premium tools)
// -----------------------------------------------------------------------------
server.registerTool(
  "list_commitments",
  {
    title: "List commitments for a subscriber",
    description: "Returns all commitments associated with a subscription email. Requires an active SAAX Premium subscription. Call this to retrieve commitment history for a subscriber. For a single commitment by ID, use get_commitment. For status-only checks, use get_commitment_status.",
    inputSchema: {
      subscriptionEmail: z.string().describe("The subscription email (must have an active SAAX Premium subscription)"),
    },
  },
  async ({ subscriptionEmail }) => {
    const gate = await gatePremium(subscriptionEmail, "list_commitments");
    if (!gate.ok) {
      return { content: [{ type: "text", text: JSON.stringify(gate.payload, null, 2) }] };
    }
    // Read from Supabase: commitments recorded for this subscriber's email.
    // The gateway's /route issuance records buyer_email=null today, so this
    // returns the commitments that carry this email (authority-minted or
    // future flows). The in-process Map is not the source of truth anymore.
    let rows = [];
    try {
      rows = await lookupCommitmentsByEmail(gate.email);
    } catch (e) {
      console.error("[list_commitments] lookup failed:", e.message);
    }
    const commitments = rows.map(commitmentRowToRecord).map((r) => ({
      commitmentId: r.commitmentId,
      createdAt: r.createdAt,
      state: r.state,
      capability: r.capability,
      terms: r.terms,
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { status: "ok", subscriber: gate.email, count: commitments.length, commitments },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Agent-side rule: an unknown outcome is a status check, not another POST.
// next_action tells the calling agent whether to retry, poll, or stop.
function nextActionFor(state) {
  switch (state) {
    case "not_found": return "retry_safe";
    case "in_flight":
    case "executing": return "poll";
    case "fulfilled":
    case "settled":
    case "finalized": return "stop";
    case "failed":
    case "expired":
    case "cancelled": return "retry_with_new_id";
    default: return "poll";
  }
}

// -----------------------------------------------------------------------------
// Tool 8 — get_commitment_status (ungated; commitment id is the access token)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_commitment_status",
  {
    title: "Get a commitment's lifecycle state",
    description: "Returns only the current lifecycle state for a given commitment ID, plus the recommended next action for the calling agent. Call this before retrying any commitment that timed out — an unknown outcome is a status check, not another POST. The next_action field tells the agent whether to retry, poll, or stop. For the full commitment record, use get_commitment.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id to poll for its lifecycle state"),
    },
  },
  async ({ commitmentId }) => {
    const vid = validateCommitmentId(commitmentId);
    if (!vid.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: vid.reason }, null, 2) }] };
    }
    const cid = vid.value;
    let row = null;
    try {
      row = await lookupCommitmentById(cid);
    } catch (e) {
      console.error("[get_commitment_status] lookup failed:", e.message);
    }
    if (!row) {
      const cached = commitmentStore.get(cid);
      if (!cached) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", commitmentId: cid, next_action: "retry_safe" }, null, 2) }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ commitmentId: cid, state: cached.state, next_action: nextActionFor(cached.state) }, null, 2) }],
      };
    }
    const rec = commitmentRowToRecord(row);
    return {
      content: [{ type: "text", text: JSON.stringify({ commitmentId: cid, state: rec.state, next_action: nextActionFor(rec.state) }, null, 2) }],
    };
  }
);

// -----------------------------------------------------------------------------
// Tool 9 - create_commitment (NEW: rail-neutral commitment minting)
// -----------------------------------------------------------------------------
server.registerTool(
  "create_commitment",
  {
    title: "Create a rail-neutral commitment",
    description: "Creates a governed commitment between a buyer and a seller and persists it to the SAAX commitment store. The commitment is settlement-rail-neutral: settlementRail is metadata only (x402, mpp, ap2, acp, or unspecified) and is NEVER a prerequisite. Returns the new commitment id (saax_<hash>), createdAt, status, and the settlementRail. Call this BEFORE any payment flow to establish the governed commitment record. Once created, use get_commitment to read the manifest.",
    inputSchema: {
      buyerId: z.string().describe("The buyer's identity: 0x-address or agent id"),
      sellerId: z.string().describe("The seller's identity: 0x-address or agent id"),
      terms: z.object({
        deliverable: z.string().describe("The deliverable / capability description"),
        price: z.object({
          amount: z.string().describe("Price amount as a decimal string, e.g. '0.10'"),
          currency: z.string().describe("Currency symbol, e.g. USDC"),
          decimals: z.number().int().min(0).describe("Asset decimals (USDC = 6)"),
        }),
        deadline: z.string().describe("ISO-8601 deadline for fulfillment"),
      }).describe("The commercial terms: deliverable, price, deadline"),
      acceptanceCriteria: z.array(z.string()).min(1).describe("Objective acceptance criteria for fulfillment"),
      evidenceRequirements: z.array(z.string()).optional().describe("Evidence the seller must supply"),
      recoveryPolicy: z.object({
        maxRetries: z.number().int().min(0).optional(),
        refundOnFailure: z.boolean(),
        compensationPercent: z.string().optional(),
      }).optional().describe("Recovery policy on failure"),
      settlementRail: z.enum(["x402", "mpp", "ap2", "acp", "unspecified"]).default("unspecified").describe("The settlement rail as metadata. Never a prerequisite; 'unspecified' is valid."),
    },
  },
  async ({ buyerId, sellerId, terms, acceptanceCriteria, evidenceRequirements, recoveryPolicy, settlementRail }) => {
    const fail = (status, reason) => ({ content: [{ type: "text", text: JSON.stringify({ status, reason }, null, 2) }] });

    const clean = (s) => String(s || "").trim();
    const bid = clean(buyerId);
    const sid = clean(sellerId);
    if (!bid || !sid) return fail("invalid", "buyerId and sellerId are required");
    if (!terms || !terms.deliverable || !terms.price || !terms.deadline) {
      return fail("invalid", "terms.deliverable, terms.price, and terms.deadline are required");
    }
    if (isNaN(Date.parse(String(terms.deadline)))) {
      return fail("invalid", "terms.deadline must be a parseable ISO-8601 timestamp");
    }
    const price = terms.price;
    if (typeof price.amount !== "string" || !/^\d+(\.\d+)?$/.test(price.amount)) {
      return fail("invalid", "terms.price.amount must be a non-negative decimal string");
    }
    if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
      return fail("invalid", "acceptanceCriteria must be a non-empty array of strings");
    }
    const rail = RAILS.has(settlementRail) ? settlementRail : "unspecified";

    const nonce = crypto.randomBytes(8).toString("hex");
    const commitmentId = commitmentIdFrom({ buyerId: bid, sellerId: sid, terms, acceptanceCriteria, evidenceRequirements, recoveryPolicy, settlementRail: rail }, nonce);
    const createdAt = new Date().toISOString();

    // Persist to the existing commitment store (ax_router.commitments via the
    // upsert_commitment RPC). Additive: the manifest mirrors the tool's input so
    // get_commitment can serve it back after issuance.
    const record = {
      commitmentId,
      state: "issued",
      capability: terms.deliverable,
      buyerEmail: null,
      terms: {
        deliverable: terms.deliverable,
        price,
        deadline: terms.deadline,
        acceptanceCriteria,
        evidenceRequirements: evidenceRequirements || [],
        recoveryPolicy: recoveryPolicy || null,
        settlementRail: rail,
      },
      authorityRef: null,
      evidenceRefs: evidenceRequirements || [],
      settlementRef: null,
      manifestHash: "sha256:" + crypto.createHash("sha256").update(JSON.stringify({ commitmentId, terms, acceptanceCriteria, evidenceRequirements, recoveryPolicy, rail }), "utf8").digest("hex"),
    };
    try {
      await upsertCommitment(record);
    } catch (e) {
      console.error("[create_commitment] persist failed:", e.message);
      return fail("persist_failed", "commitment was created but could not be persisted: " + String(e.message || e).slice(0, 200));
    }
    // Keep the in-process mirror in sync (read path for this instance).
    commitmentStore.set(commitmentId, {
      commitmentId,
      createdAt,
      state: "issued",
      capability: terms.deliverable,
      terms: record.terms,
      manifest: { ...record.terms, commitmentId, manifestHash: record.manifestHash },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              commitment_id: commitmentId,
              created_at: createdAt,
              status: "open",
              settlement_rail: rail,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);
// -----------------------------------------------------------------------------
// PREMIUM TOOL A — get_evidence_verification (gated by SAAX Premium)
// -----------------------------------------------------------------------------// -----------------------------------------------------------------------------
// PREMIUM TOOL A — get_evidence_verification (gated by SAAX Premium)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_evidence_verification",
  {
    title: "Verify evidence against acceptance criteria",
    description: "Verifies external evidence against a commitment's acceptance criteria. Requires an active SAAX Premium subscription. For authority proof validation, use get_authority_validation.",
    inputSchema: {
      subscriptionEmail: z.string().describe("The subscription email (must have an active SAAX Premium subscription)"),
      evidence: z.any().describe("The evidence object (evidenceId, evidenceType, issuer, subject, payload, payloadHash, signature, verificationScheme, commitmentId, acceptanceCriterionId, ...)"),
      commitment: z.any().describe("The commitment object the evidence binds to"),
      criterion: z.any().describe("The verification policy / acceptance criterion"),
    },
  },
  async ({ evidence, commitment, criterion, subscriptionEmail }) => {
    const gate = await gatePremium(subscriptionEmail, "get_evidence_verification");
    if (!gate.ok) {
      return { content: [{ type: "text", text: JSON.stringify(gate.payload, null, 2) }] };
    }
    // Lazy-import the evidence module (CJS) to keep cold start light.
    const { validateEvidence, evaluateCriterion } = await import("../endpoint/evidence.js").catch((e) => {
      return { validateEvidence: null, evaluateCriterion: null, error: String(e.message || e) };
    });
    if (!evaluateCriterion || !validateEvidence) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "evidence module unavailable" }, null, 2) }] };
    }
    try {
      const validation = await validateEvidence(evidence, commitment);
      if (!validation.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "invalid_evidence", reason: validation.reason, stage: validation.stage }, null, 2) }] };
      }
      const outcome = await evaluateCriterion(criterion, [evidence]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "verified", outcome, validation, subscriber: gate.email, tool: "get_evidence_verification" },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: String(e.message || e).slice(0, 300) }, null, 2) }] };
    }
  }
);

// -----------------------------------------------------------------------------
// PREMIUM TOOL B — get_authority_validation (gated by SAAX Premium)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_authority_validation",
  {
    title: "Validate an authority proof",
    description: "Validates an authority proof against a commitment. Requires an active SAAX Premium subscription. For evidence verification, use get_evidence_verification.",
    inputSchema: {
      subscriptionEmail: z.string().describe("The subscription email (must have an active SAAX Premium subscription)"),
      proof: z.any().describe("The AuthorityProof object (proofType, issuer, subject, scope, validFrom, validUntil, signature, verificationScheme, verificationMaterial)"),
      commitment: z.any().describe("The commitment or requested action the proof must authorize"),
    },
  },
  async ({ proof, commitment, subscriptionEmail }) => {
    const gate = await gatePremium(subscriptionEmail, "get_authority_validation");
    if (!gate.ok) {
      return { content: [{ type: "text", text: JSON.stringify(gate.payload, null, 2) }] };
    }
    const { validateAuthorityProof, isAuthorized } = await import("../endpoint/authority.js").catch((e) => {
      return { validateAuthorityProof: null, isAuthorized: null, error: String(e.message || e) };
    });
    if (!validateAuthorityProof || !isAuthorized) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "authority module unavailable" }, null, 2) }] };
    }
    try {
      const validation = await validateAuthorityProof(proof, commitment);
      const authorized = validation.ok ? await isAuthorized(proof, commitment?.requestedAction || "fulfill") : false;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: validation.ok ? "authorized" : "rejected", validation, authorized, subscriber: gate.email, tool: "get_authority_validation" },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: String(e.message || e).slice(0, 300) }, null, 2) }] };
    }
  }
);



// -----------------------------------------------------------------------------
// MCP LIFECYCLE PHASE 2 � Secure lifecycle + recovery tools
// (isolated implementation; NOT deployed). Principal binding: every mutating
// tool verifies the caller's EIP-712 authority proof and binds the recovered
// signer as verifiedPrincipal � caller-supplied agentId is never authority.
// No financial transitions (settlement/escrow release/refunds) are exposed.
// -----------------------------------------------------------------------------

function lifecycleProofError(reason, stage) {
  return { content: [{ type: "text", text: JSON.stringify({ status: "unauthorized", reason, stage }, null, 2) }] };
}

// When a caller retries with the SAME idempotencyRef, the RPC's fingerprint
// includes from_state � so the retry must pass the ORIGINAL from_state (the
// state at first execution), not the current row state. Resolve it from the
// event ledger when the ref already exists.
async function resolveReplayFromState(cid, idempotencyRef) {
  if (!idempotencyRef) return null;
  try {
    const history = await _lifecycleMcp.readHistory(cid);
    const hit = history.find((e) => e.idempotency_ref === idempotencyRef);
    return hit ? hit.from_state : null;
  } catch (_) {
    return null;
  }
}

async function lifecycleReadTool(args) {
  const { commitmentId, agentId, role, proof } = args;
  const vid = validateCommitmentId(commitmentId || "");
  if (!vid.ok) return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: vid.reason }, null, 2) }] };
  const cid = vid.value;
  let row = null;
  try {
    row = await _lifecycleMcp.loadCommitment(cid);
  } catch (e) {
    console.error("[lifecycle read] lookup failed:", e.message);
    return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "commitment lookup failed" }, null, 2) }] };
  }
  if (!row) return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", commitmentId: cid }, null, 2) }] };
  const vp = await _lifecycleMcp.verifyPrincipal(proof, row, { callerRole: args.role, callerAction: 'get_recovery_status' });
  if (!vp.ok) {
    await recordAuthFailure(vp.principal || proof?.issuer || null, handlerIp());
    return lifecycleProofError(vp.reason, vp.stage);
  }
  const principalGuard = await guardPrincipal(vp.principal, "get_recovery_status");
  if (!principalGuard.ok) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
  }
  return { row, cid, principal: vp.principal };
}

// Tool 12 � get_commitment_history (read-only lifecycle journal)
server.registerTool(
  "get_commitment_history",
  {
    title: "Get the durable lifecycle journal for a commitment",
    description: "Returns the append-only lifecycle event ledger for a commitment � every recorded transition with actor, authority reference, state version, and evidence reference. The caller must present an EIP-712 authority proof binding its identity to the commitment. Read-only; reconciles the authoritative commitment before returning. For a compact status, use get_commitment_status; for recovery guidance, use get_recovery_status.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id"),
      agentId: z.string().describe("The caller's durable agent identifier"),
      role: z.enum(["buyer", "provider", "evaluator", "authority", "system"]).describe("The caller's role on this commitment"),
      proof: z.record(z.any()).describe("EIP-712 AuthorityProof signed by the caller (issuer = signer)"),
    },
  },
  async (args) => {
    const pre = await lifecycleReadTool(args);
    if (!pre.row) return pre;
    try {
      const history = await _lifecycleMcp.readHistory(pre.cid);
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "ok",
          commitmentId: pre.cid,
          state: pre.row.state,
          version: pre.row.version || 1,
          principal: pre.principal,
          count: history.length,
          events: history,
        }, null, 2) }],
      };
    } catch (e) {
      console.error("[get_commitment_history] failed:", e.message);
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "event history unavailable" }, null, 2) }] };
    }
  }
);

// Tool 13 � get_recovery_status (reconcile-before-read recovery guidance)
server.registerTool(
  "get_recovery_status",
  {
    title: "Get recovery status and pending actions for a commitment",
    description: "Returns the authoritative commitment state, the caller's authorization status (active/revoked/expired), whether the commitment is recoverable, and the caller's permitted next actions. Reconciles the durable commitment row and the caller's authorization record before returning. The caller must present an EIP-712 authority proof. Read-only. For the raw journal, use get_commitment_history; to continue a workflow, use resume_commitment.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id"),
      agentId: z.string().describe("The caller's durable agent identifier"),
      role: z.enum(["buyer", "provider", "evaluator", "authority", "system"]).describe("The caller's role on this commitment"),
      proof: z.record(z.any()).describe("EIP-712 AuthorityProof signed by the caller (issuer = signer)"),
    },
  },
  async (args) => {
    const pre = await lifecycleReadTool(args);
    if (!pre.row) return pre;
    try {
      const status = await _lifecycleMcp.buildRecoveryStatus(pre.row, args.agentId, pre.principal, args.role);
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    } catch (e) {
      console.error("[get_recovery_status] failed:", e.message);
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "recovery status unavailable" }, null, 2) }] };
    }
  }
);

// Tool 14 � get_pending_actions (read-only; derives the caller's permitted next steps)
server.registerTool(
  "get_pending_actions",
  {
    title: "Get the caller's permitted next lifecycle actions",
    description: "Returns the lifecycle actions the caller (verified by EIP-712 proof) may currently perform on a commitment � derived from the canonical transition map, the caller's role, and the caller's durable authorization scope. Read-only. For full recovery context, use get_recovery_status.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id"),
      agentId: z.string().describe("The caller's durable agent identifier"),
      role: z.enum(["buyer", "provider", "evaluator", "authority", "system"]).describe("The caller's role on this commitment"),
      proof: z.record(z.any()).describe("EIP-712 AuthorityProof signed by the caller (issuer = signer)"),
    },
  },
  async (args) => {
    const pre = await lifecycleReadTool(args);
    if (!pre.row) return pre;
    try {
      const status = await _lifecycleMcp.buildRecoveryStatus(pre.row, args.agentId, pre.principal, args.role);
      return { content: [{ type: "text", text: JSON.stringify({
        status: "ok",
        commitmentId: pre.cid,
        state: pre.row.state,
        authorized: status.caller.authorized,
        pendingActions: status.pendingActions,
      }, null, 2) }] };
    } catch (e) {
      console.error("[get_pending_actions] failed:", e.message);
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "pending actions unavailable" }, null, 2) }] };
    }
  }
);

// Tool 15 � resume_commitment (authorized continuation; no automatic inheritance)
server.registerTool(
  "resume_commitment",
  {
    title: "Resume a commitment after the original agent terminated",
    description: "Lets an independently authorized replacement agent continue a commitment. Reconciles the authoritative state, verifies the caller's EIP-712 authority proof, and executes the requested nonfinancial transition through the canonical transition engine. The replacement agent must hold its OWN durable authorization (no automatic inheritance). Duplicate requests are idempotent. Financial transitions (settle/finalize with settlement, escrow release, refunds) are NOT exposed. For inspection first, use get_recovery_status or get_pending_actions.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id"),
      agentId: z.string().describe("The caller's durable agent identifier"),
      role: z.enum(["buyer", "provider", "evaluator", "authority", "system"]).describe("The caller's role on this commitment"),
      proof: z.record(z.any()).describe("EIP-712 AuthorityProof signed by the caller (issuer = signer)"),
      action: z.string().describe("The lifecycle action to execute: cancel, accept, authorize, execute, complete, submit, verify, fulfill, recover, dispute (nonfinancial subset)"),
      idempotencyRef: z.string().optional().describe("Caller-scoped idempotency reference (>= 8 chars) for safe retries"),
      expectedVersion: z.number().int().optional().describe("Optimistic-concurrency guard: the state version the caller observed"),
      authorityRef: z.string().optional().describe("Optional external authority reference to record on the event"),
      evidenceRef: z.string().optional().describe("Optional evidence reference to bind to the transition"),
    },
  },
  async (args) => {
    const vid = validateCommitmentId(args.commitmentId || "");
    if (!vid.ok) return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: vid.reason }, null, 2) }] };
    const cid = vid.value;
    const agentId = String(args.agentId || "").trim();
    const role = String(args.role || "").trim();
    const action = String(args.action || "").trim();
    if (!agentId || !role || !action) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: "agentId, role, and action are required" }, null, 2) }] };
    }
    let row = null;
    try {
      row = await _lifecycleMcp.loadCommitment(cid);
    } catch (e) {
      console.error("[resume_commitment] lookup failed:", e.message);
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "commitment lookup failed" }, null, 2) }] };
    }
    if (!row) return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", commitmentId: cid }, null, 2) }] };
    const vp = await _lifecycleMcp.verifyPrincipal(args.proof, row, { callerRole: args.role, callerAction: args.action || 'resume_commitment' });
    if (!vp.ok) {
      await recordAuthFailure(vp.principal || args.proof?.issuer || null, handlerIp());
      return lifecycleProofError(vp.reason, vp.stage);
    }
    const principalGuard = await guardPrincipal(vp.principal, "resume_commitment");
    if (!principalGuard.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
    }
    const toState = _lifecycleMcp.actionToTransition(action, row.state);
    if (!toState) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: "unsupported action: " + action }, null, 2) }] };
    }
    if (['settled', 'finalized'].includes(toState)) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "blocked", reason: "settlement and finalization are not exposed through MCP" }, null, 2) }] };
    }
    const idem = args.idempotencyRef ||
      ('mcp:' + cid + ':' + vp.principal + ':' + action + ':' + (row.version || 1) + ':' + Date.now());
    // On a same-ref retry, the RPC fingerprint requires the ORIGINAL from_state.
    const replayFrom = await resolveReplayFromState(cid, idem);
    const r = await _lifecycle.transitionCommitment({
      commitmentId: cid,
      fromState: replayFrom || row.state,
      toState,
      requestedAction: action,
      agentId,
      verifiedPrincipal: vp.principal,
      actorRole: role,
      authorityRef: args.authorityRef || row.authority_ref || null,
      idempotencyRef: idem,
      evidenceRef: args.evidenceRef || null,
      expectedVersion: args.expectedVersion ?? row.version,
    });
    if (!r.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", code: r.code, reason: r.error }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...r.data }, null, 2) }] };
  }
);

// Tool 16 � cancel_commitment (authorized cancellation; terminal, nonfinancial)
server.registerTool(
  "cancel_commitment",
  {
    title: "Cancel a commitment",
    description: "Cancels a commitment when the caller (verified by EIP-712 proof) holds buyer or authority authorization with cancel scope. Terminal and nonfinancial � no payment, refund, or settlement is executed. Reconciles authoritative state first. Idempotent via idempotencyRef.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id"),
      agentId: z.string().describe("The caller's durable agent identifier"),
      role: z.enum(["buyer", "provider", "evaluator", "authority", "system"]).describe("The caller's role (cancel requires buyer or authority)"),
      proof: z.record(z.any()).describe("EIP-712 AuthorityProof signed by the caller (issuer = signer)"),
      reason: z.string().optional().describe("Cancellation reason (recorded as authority reference)"),
      idempotencyRef: z.string().optional().describe("Caller-scoped idempotency reference"),
    },
  },
  async (args) => _invokeResume(args, "cancel")
);

// Internal helper shared by cancel_commitment (DRY).
async function _invokeResume(args, action) {
  const vid = validateCommitmentId(args.commitmentId || "");
  if (!vid.ok) return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: vid.reason }, null, 2) }] };
  const cid = vid.value;
  const agentId = String(args.agentId || "").trim();
  const role = String(args.role || "").trim();
  if (!agentId || !role) return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: "agentId and role are required" }, null, 2) }] };
  let row = null;
  try {
    row = await _lifecycleMcp.loadCommitment(cid);
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "commitment lookup failed" }, null, 2) }] };
  }
  if (!row) return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", commitmentId: cid }, null, 2) }] };
  const vp = await _lifecycleMcp.verifyPrincipal(args.proof, row, { callerRole: args.role, callerAction: action });
  if (!vp.ok) {
    await recordAuthFailure(vp.principal || args.proof?.issuer || null, handlerIp());
    return lifecycleProofError(vp.reason, vp.stage);
  }
  const principalGuard = await guardPrincipal(vp.principal, action);
  if (!principalGuard.ok) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
  }
  const toState = _lifecycleMcp.actionToTransition(action, row.state);
  if (!toState) return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: "unsupported action: " + action }, null, 2) }] };
  const idem = args.idempotencyRef || ('mcp:' + cid + ':' + vp.principal + ':' + action + ':' + Date.now());
  // On a same-ref retry, the RPC fingerprint requires the ORIGINAL from_state.
  const replayFrom = await resolveReplayFromState(cid, idem);
  const r = await _lifecycle.transitionCommitment({
    commitmentId: cid,
    fromState: replayFrom || row.state,
    toState,
    requestedAction: action,
    agentId,
    verifiedPrincipal: vp.principal,
    actorRole: role,
    authorityRef: args.reason || row.authority_ref || null,
    idempotencyRef: idem,
    expectedVersion: args.expectedVersion ?? row.version,
  });
  if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ status: "error", code: r.code, reason: r.error }, null, 2) }] };
  return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...r.data }, null, 2) }] };
}

// Tool 17 � close_commitment (authorized closure; nonfinancial)
server.registerTool(
  "close_commitment",
  {
    title: "Close a fulfilled commitment",
    description: "Closes a fulfilled commitment (settled -> finalized) when the caller (verified by EIP-712 proof) holds system or authority authorization. Nonfinancial � no settlement, escrow release, or refund is executed. Reconciles authoritative state first. Idempotent via idempotencyRef.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment id"),
      agentId: z.string().describe("The caller's durable agent identifier"),
      role: z.enum(["buyer", "provider", "evaluator", "authority", "system"]).describe("The caller's role (close requires system or authority)"),
      proof: z.record(z.any()).describe("EIP-712 AuthorityProof signed by the caller (issuer = signer)"),
      idempotencyRef: z.string().optional().describe("Caller-scoped idempotency reference"),
    },
  },
  async (args) => {
    const vid = validateCommitmentId(args.commitmentId || "");
    if (!vid.ok) return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: vid.reason }, null, 2) }] };
    const cid = vid.value;
    const agentId = String(args.agentId || "").trim();
    const role = String(args.role || "").trim();
    if (!agentId || !role) return { content: [{ type: "text", text: JSON.stringify({ status: "invalid", reason: "agentId and role are required" }, null, 2) }] };
    if (!["system", "authority"].includes(role)) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "blocked", reason: "close_commitment requires system or authority role" }, null, 2) }] };
    }
    let row = null;
    try {
      row = await _lifecycleMcp.loadCommitment(cid);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "commitment lookup failed" }, null, 2) }] };
    }
    if (!row) return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", commitmentId: cid }, null, 2) }] };
    if (row.state !== "settled") {
      return { content: [{ type: "text", text: JSON.stringify({ status: "blocked", reason: "close_commitment requires state 'settled' (current: " + row.state + ")" }, null, 2) }] };
    }
    const vp = await _lifecycleMcp.verifyPrincipal(args.proof, row, { callerRole: args.role, callerAction: 'close_commitment' });
    if (!vp.ok) {
      await recordAuthFailure(vp.principal || args.proof?.issuer || null, handlerIp());
      return lifecycleProofError(vp.reason, vp.stage);
    }
    const principalGuard = await guardPrincipal(vp.principal, "close_commitment");
    if (!principalGuard.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
    }
    const idem = args.idempotencyRef || ('mcp:' + cid + ':' + vp.principal + ':finalize:' + Date.now());
    const replayFrom = await resolveReplayFromState(cid, idem);
    const r = await _lifecycle.transitionCommitment({
      commitmentId: cid,
      fromState: replayFrom || row.state,
      toState: "finalized",
      requestedAction: "finalize",
      agentId,
      verifiedPrincipal: vp.principal,
      actorRole: role,
      authorityRef: row.authority_ref || null,
      idempotencyRef: idem,
      expectedVersion: args.expectedVersion ?? row.version,
    });
    if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ status: "error", code: r.code, reason: r.error }, null, 2) }] };
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...r.data }, null, 2) }] };
  }
);


// -----------------------------------------------------------------------------
// Tool 10 � prepare_commitment (SAAX Discovery Phase 3: FREE, NONBINDING
// signed preflight). Same core as the isolated HTTP endpoint:
// endpoint/preflight-core.js. Deterministic validation + normalization,
// specific DSC_* errors, signed proposal (EdDSA JWS over RFC 8785 canonical
// payload, Phase-2 signature profile). Creates NO agreement, payment, custody
// deposit, service execution, resource reservation, or spending authority.
// A provider signature is NOT buyer acceptance. No preflight fee.
// -----------------------------------------------------------------------------
function _phase3Store() {
  // DEPLOYED PATH: Supabase proposals (cross-instance atomic idempotency).
  // LOCAL FALLBACK: file-backed journal (single host, restart-safe).
  if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY)) {
    try {
      const mod = _require("../endpoint/supabase-proposal-store.js");
      return new mod.SupabaseProposalStore({
        supabaseUrl: process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || "",
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY || "",
      });
    } catch (e) {
      console.error("[prepare_commitment] Supabase proposal store unavailable:", e.message);
    }
  }
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".output", ".phase3-proposals");
  try {
    return new (_ProposalStoreMod.ProposalStore)(dir);
  } catch (e) {
    return null;
  }
}

let _phase3Profile = null;
let _phase3SignerKey = null;
function _phase3ProviderRef() {
  // DEPLOYED PATH: the LIVE signed discovery profile + operator private key
  // (SAAX_OPERATOR_PRIVATE_JWK secret; the signed profile is committed as a
  // public artifact). LOCAL FALLBACK: the Phase-3 example fixture + throwaway
  // key (never in production).
  try {
    if (!_phase3Profile) {
      const livePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec/examples/discovery/profile-live-signed.json");
      if (existsSync(livePath)) {
        _phase3Profile = JSON.parse(readFileSync(livePath, "utf8"));
      } else {
        _phase3Profile = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec/examples/discovery/profile-phase3-unsigned.json"), "utf8"));
      }
    }
    const envOperatorKey = process.env.SAAX_OPERATOR_PRIVATE_JWK;
    if (envOperatorKey && envOperatorKey.trim()) {
      try { _phase3SignerKey = JSON.parse(envOperatorKey); } catch (_) { /* keep fallback */ }
    }
    if (!_phase3SignerKey) {
      const devKey = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec/examples/discovery/keys/example-private.jwk.json");
      if (existsSync(devKey)) {
        try { _phase3SignerKey = JSON.parse(readFileSync(devKey, "utf8")); } catch (_) { /* fall through */ }
      }
    }
    const keyRef = _phase3Profile.signingKeys[0];
    const manSchema = (_phase3Profile.capabilities[0] && _phase3Profile.capabilities[0].schemas || []).find((s) => s.purpose === "commitment-manifest");
    return {
      providerId: _phase3Profile.providerId,
      name: _phase3Profile.providerName,
      origin: _phase3Profile.origin,
      signingKeyId: keyRef.id,
      privateJwk: _phase3SignerKey,
      jwkPublic: { kty: "OKP", crv: "Ed25519", x: keyRef.jwk.x },
      manifestDigest: manSchema ? manSchema.digest : null,
      evaluatorRef: _phase3Profile.capabilities[0] && _phase3Profile.capabilities[0].evaluatorRequirements || null,
      permittedDecisions: null,
      profile: _phase3Profile,
    };
  } catch (e) {
    return null;
  }
}

server.registerTool(
  "prepare_commitment",
  {
    title: "Prepare a free, nonbinding signed proposal (preflight)",
    description: "Prepares a free, NONBINDING signed proposal (preflight) for a desired SAAX capability. Validates capability, schema/version/digest, units, and the exact supported network/asset/rail/mode combination; returns a provider-signed proposal binding the request digest and normalized terms. Creates NO agreement, payment, custody deposit, service execution, resource reservation, or spending authority. A provider signature is NOT buyer acceptance. No preflight fee. Errors are typed DSC_* codes.",
    inputSchema: {
      profileVersion: z.string().describe("SAAX Discovery profile version (e.g. 1.0.0)"),
      capability: z.object({ id: z.string().describe("Provider capability id") }).describe("Desired capability"),
      schema: z.object({
        id: z.string().describe("Schema id (e.g. https://saax-protocol.com/schemas/commitment-manifest/v1)"),
        version: z.string().describe("Schema version"),
        digest: z.string().describe("sha256:<64 hex> schema digest"),
      }).describe("Expected commitment schema"),
      units: z.object({
        amount: z.string().describe("Integer-string settlement amount in the declared unit"),
        unit: z.string().describe("Explicit unit (e.g. micro-units of settlement asset)"),
      }).describe("Amount + unit"),
      financialProfile: z.object({
        network: z.string().describe("CAIP-2 network id (e.g. eip155:8453)"),
        asset: z.string().describe("CAIP-19 asset id"),
        rail: z.string().describe("Rail: x402, mpp, ap2, acp, ach, card, internal-ledger, unknown"),
        mode: z.string().describe("Payment mode"),
      }).describe("Financial axes"),
      constraints: z.object({
        maxAmount: z.string().optional().describe("Integer-string max amount"),
        deadline: z.string().optional().describe("ISO-8601 deadline"),
      }).optional().describe("Optional constraints"),
      intendedParties: z.object({
        buyer: z.string().optional().describe("0x buyer address"),
        seller: z.string().optional().describe("0x seller address"),
      }).optional().describe("Intended parties"),
      clientNonce: z.string().min(8).describe("Caller-chosen nonce (echoed; replay idempotency)"),
      issuedAt: z.string().describe("ISO-8601 client timestamp"),
    },
  },
  async (args) => {
    const providerRef = _phase3ProviderRef();
    if (!providerRef) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", errorCode: "DSC_UNAVAILABLE", reason: "provider profile unavailable" }, null, 2) }] };
    }
    const store = _phase3Store();
    if (!store) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", errorCode: "DSC_UNAVAILABLE", reason: "proposal store unavailable" }, null, 2) }] };
    }
    const outcome = await _preflightCore.prepareCommitment({
      profile: providerRef.profile,
      providerRef,
      request: args,
      store,
      clock: null,
    });
    if (outcome.status === "ok") {
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", proposal: outcome.proposal }, null, 2) }] };
    }
    if (outcome.status === "duplicate") {
      return { content: [{ type: "text", text: JSON.stringify({ status: "duplicate", proposal: outcome.proposal }, null, 2) }] };
    }
    if (outcome.status === "conflict") {
      return { content: [{ type: "text", text: JSON.stringify({ status: "conflict", error: { code: outcome.errorCode, message: outcome.reason } }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: outcome.errorCode, message: outcome.reason } }, null, 2) }] };
  }
);

// -----------------------------------------------------------------------------
// Tool 11 - accept_commitment (SAAX Discovery Phase 4: explicit buyer
// authorization -> exactly one authenticated commitment). Same core as the
// isolated HTTP endpoint: endpoint/acceptance-core.js. Revalidates the signed
// proposal (trusted-key path, �7.2), verifies the BUYER'S OWN SIGNATURE over
// the exact proposal digest + terms digest (caller-supplied identity is not
// proof), durably accepts ONCE (single-writer acceptance store), and creates
// the commitment (manifest v1 + provider JWS over the canonical manifest+
// proposal binding � signedRepresentationVersion "manifest-v1.1+saax-
// proposal-bound"). Creates NO payment authorization, custody funding, service
// execution, or release. A buyer acceptance is NOT a payment authorization or
// an evaluator release verdict. Errors are typed DSC_* codes.
// NOT advertised as live (no public deployment): the tool is registered for
// the isolated test environment only.
// -----------------------------------------------------------------------------
function _phase4Store() {
  // DEPLOYED PATH: Supabase acceptance_operations (cross-instance atomic
  // idempotency + recovery). Safe on Vercel's multi-instance runtime.
  // LOCAL FALLBACK: file journal (single host) when Supabase is unconfigured.
  if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY)) {
    try {
      const mod = _require("../endpoint/supabase-acceptance-store.js");
      return new mod.SupabaseAcceptanceStore({
        supabaseUrl: process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || "",
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY || "",
      });
    } catch (e) {
      console.error("[accept_commitment] Supabase store unavailable:", e.message);
    }
  }
  if (!_AcceptanceStoreMod) return null;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".output", ".phase4-acceptances");
  try {
    return new (_AcceptanceStoreMod.AcceptanceStore)(dir);
  } catch (e) {
    return null;
  }
}

function _buyerScopeFor(buyerRegistry, address) {
  const a = String(address || "").toLowerCase();
  const reg = buyerRegistry[a];
  if (!reg) return null;
  return {
    buyer: a,
    buyerPublicJwk: reg.publicJwk,
    scopeMaxAmount: reg.scopeMaxAmount,
    scopeCurrency: reg.scopeCurrency,
    scopeCapability: reg.scopeCapability,
  };
}

server.registerTool(
  "accept_commitment",
  {
    title: "Accept a signed proposal and create exactly one authenticated commitment",
    description: "Accepts a signed preflight proposal with explicit buyer authorization and creates exactly ONE authenticated SAAX commitment. Revalidates the proposal (trusted provider key, profile version, expiry, combination, manifest digest), verifies the BUYER'S SIGNATURE over the exact proposal digest and terms digest, durably accepts once (single-writer store), and returns the operation + commitment. Creates NO payment authorization, custody funding, service execution, or release. A buyer acceptance is NOT a payment authorization or evaluator release verdict. Errors are typed DSC_* codes. Idempotent: same idempotencyKey + same request returns the same operation; same key + different request -> DSC_NONCE_CONFLICT; a single-use proposal cannot be re-accepted under a new key -> DSC_PROPOSAL_REUSED.",
    inputSchema: {
      proposal: z.record(z.any()).describe("The signed proposal returned by prepare_commitment (full object incl. signature)"),
      acceptance: z.record(z.any()).describe("The buyer acceptance contract (schemaVersion acceptance-v1, action accept_commitment, domain saax:acceptance:v1, signed by the buyer)"),
      idempotencyKey: z.string().min(8).describe("Caller-scoped idempotency key (>= 8 chars)"),
    },
  },
  async (args) => {
    if (!_acceptanceCore || !_AcceptanceStoreMod) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", errorCode: "DSC_UNAVAILABLE", reason: "acceptance module unavailable" }, null, 2) }] };
    }
    const providerRef = _phase3ProviderRef();
    if (!providerRef) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", errorCode: "DSC_UNAVAILABLE", reason: "provider profile unavailable" }, null, 2) }] };
    }
    const store = _phase4Store();
    if (!store) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", errorCode: "DSC_UNAVAILABLE", reason: "acceptance store unavailable" }, null, 2) }] };
    }
    const proposal = args.proposal;
    const acceptance = args.acceptance;
    if (!proposal || !acceptance) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", errorCode: "DSC_INVALID_REQUEST", reason: "proposal and acceptance required" }, null, 2) }] };
    }
    const buyerAddr = acceptance.buyer || (proposal.audience && proposal.audience.buyer);
    const buyerScope = _buyerScopeFor(_phase4BuyerRegistry(), buyerAddr);
    if (!buyerScope) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", errorCode: "DSC_UNAUTHORIZED", reason: "buyer not registered" }, null, 2) }] };
    }
    const { calculateJwkThumbprint } = await Promise.resolve(_require("jose"));
    let thumb = "";
    try { thumb = await calculateJwkThumbprint(providerRef.jwkPublic); } catch (_) { /* ignore */ }
    const outcome = await _acceptanceCore.acceptCommitment({
      profile: providerRef.profile,
      trustedThumbprints: [thumb],
      proposal,
      buyerScope,
      acceptance,
      providerRef,
      store,
      clock: null,
      idempotencyKey: args.idempotencyKey,
    });
    if (outcome.status === "ok" || outcome.status === "duplicate") {
      return { content: [{ type: "text", text: JSON.stringify({ status: outcome.status, operation: outcome.operation, commitment: outcome.commitment }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: outcome.status === "rejected" ? "rejected" : outcome.status, error: { code: outcome.errorCode, message: outcome.reason } }, null, 2) }] };
  }
);

// ---- Tool 18 � submit_evidence (durable, authorized evidence submission) ----
// Phase 3 (evidence infrastructure). Principal-bound via EIP-712 proof;
// persists a durable evidence record bound to the commitment + criterion;
// idempotent per (commitment, idempotencyRef); NEVER transitions the
// commitment state and never triggers settlement/escrow/finalization.
server.registerTool(
  "submit_evidence",
  {
    title: "Submit fulfillment evidence",
    description:
      "Durably submits evidence for a commitment. The caller must present an EIP-712 authority proof; the recovered signer must hold an unrevoked, unexpired provider or buyer authorization on the commitment (verified in-transaction against the durable registry). The evidence envelope is validated for structure and size, bound to the commitment and optional acceptance criterion, and persisted with the verified submitter attribution and an integrity payload hash. Idempotent per idempotencyRef: a replay returns the original record; reuse with a materially different payload is rejected. Submission does NOT transition the commitment state and does NOT trigger settlement, escrow release, or finalization � those require separate authorized lifecycle actions.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment ID the evidence binds to"),
      criterionId: z.string().optional().describe("The acceptance criterion ID this evidence addresses, if applicable"),
      agentId: z.string().describe("The caller's agent identity (bound to the verified principal)"),
      proof: z.any().describe("The EIP-712 AuthorityProof: authorityProofId, issuer, subject, validFrom, validUntil, scope, signature, verificationScheme=eip712"),
      evidence: z.any().describe("The evidence envelope: evidenceType, issuer, subject, payload, payloadHash, signature, verificationScheme, commitmentId, acceptanceCriterionId, provenance"),
      idempotencyRef: z.string().optional().describe("Stable idempotency reference; replay-safe"),
    },
  },
  async (args) => {
    const { submitEvidence } = await import("../endpoint/evidence-lifecycle.js").catch((e) => ({ submitEvidence: null, error: String(e.message || e) }));
    if (!submitEvidence) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "evidence module unavailable" }, null, 2) }] };
    }
    const out = await submitEvidence(args);
    if (!out.ok) {
      await recordAuthFailure(args.proof?.issuer || null, handlerIp());
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: out.reason, stage: out.stage }, null, 2) }] };
    }
    const principalGuard = await guardPrincipal(out.principal || args.proof?.issuer || null, "submit_evidence");
    if (!principalGuard.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", evidence: out.record }, null, 2) }] };
  }
);

// ---- Tool 19 � list_evidence (commitment-scoped read) ------------------------
server.registerTool(
  "list_evidence",
  {
    title: "List evidence for a commitment",
    description:
      "Returns the durable evidence records for a commitment (stable identifiers, integrity references, submitter attribution, status, timestamps � never raw payload content). The caller must present an EIP-712 authority proof and hold an active authorization on the commitment. Commitment-scoped: callers with no authorization on the commitment see nothing. Optional status filter (submitted|verified|rejected|disputed). Read-only.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment ID whose evidence to list"),
      agentId: z.string().describe("The caller's agent identity"),
      proof: z.any().describe("The EIP-712 AuthorityProof"),
      status: z.enum(["submitted", "verified", "rejected", "disputed"]).optional().describe("Filter by evidence status"),
      limit: z.number().min(1).max(200).optional().describe("Max records (default 50)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
    },
  },
  async (args) => {
    const { listEvidence } = await import("../endpoint/evidence-lifecycle.js").catch((e) => ({ listEvidence: null, error: String(e.message || e) }));
    if (!listEvidence) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "evidence module unavailable" }, null, 2) }] };
    }
    const out = await listEvidence(args);
    if (!out.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: out.reason, stage: out.stage }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...out.record }, null, 2) }] };
  }
);

// ---- Tool 20 � verify_evidence (evaluator-only verdict) -----------------------
server.registerTool(
  "verify_evidence",
  {
    title: "Verify or reject submitted evidence",
    description:
      "Sets the verification status of a submitted evidence record to verified or rejected. The caller must present an EIP-712 authority proof and hold an unrevoked, unexpired EVALUATOR authorization on the commitment (verified in-transaction). Idempotent per verdict: re-verifying with the same verdict replays the original outcome; changing a verified record to rejected (or vice versa) is rejected without a dispute path. Does NOT auto-transition the commitment state � the caller must perform the authorized lifecycle transition separately. Rejection requires a reason.",
    inputSchema: {
      evidenceId: z.string().describe("The evidence record ID to verify"),
      verdict: z.enum(["verified", "rejected"]).describe("The evaluator verdict"),
      agentId: z.string().describe("The caller's agent identity"),
      proof: z.any().describe("The EIP-712 AuthorityProof"),
      reason: z.string().optional().describe("Required when verdict=rejected"),
      expectedVersion: z.number().optional().describe("Optimistic-concurrency expected version"),
    },
  },
  async (args) => {
    const { verifyEvidence } = await import("../endpoint/evidence-lifecycle.js").catch((e) => ({ verifyEvidence: null, error: String(e.message || e) }));
    if (!verifyEvidence) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "evidence module unavailable" }, null, 2) }] };
    }
    const out = await verifyEvidence(args);
    if (!out.ok) {
      await recordAuthFailure(args.proof?.issuer || null, handlerIp());
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: out.reason, stage: out.stage }, null, 2) }] };
    }
    const principalGuard = await guardPrincipal(out.principal || args.proof?.issuer || null, "verify_evidence");
    if (!principalGuard.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", evidence: out.record }, null, 2) }] };
  }
);

// ---- Tool 21 - raise_dispute (authorized dispute initiation) ----------------
server.registerTool(
  "raise_dispute",
  {
    title: "Raise a dispute on a commitment",
    description:
      "Raises a durable dispute on a commitment and transitions it to the disputed state. The caller must present an EIP-712 authority proof and hold an unrevoked, unexpired authorization on the commitment (verified in-transaction). Disputes may only be raised from evidence_submitted or fulfilled states per the canonical lifecycle. Dispute resolution NEVER triggers a financial transfer. Idempotent per idempotencyRef.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment ID being disputed"),
      disputeId: z.string().optional().describe("Stable dispute identifier; generated if omitted"),
      agentId: z.string().describe("The caller's agent identity (bound to the verified principal)"),
      proof: z.any().describe("The EIP-712 AuthorityProof"),
      reason: z.string().describe("Dispute reason (at least 8 characters)"),
      evidenceRefs: z.array(z.string()).optional().describe("Reference identifiers of supporting evidence records"),
      idempotencyRef: z.string().optional().describe("Stable idempotency reference; replay-safe"),
    },
  },
  async (args) => {
    const { raiseDispute } = await import("../endpoint/dispute.js").catch((e) => ({ raiseDispute: null, error: String(e.message || e) }));
    if (!raiseDispute) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "dispute module unavailable" }, null, 2) }] };
    }
    const out = await raiseDispute(args);
    if (!out.ok) {
      await recordAuthFailure(args.proof?.issuer || null, handlerIp());
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: out.reason, stage: out.stage }, null, 2) }] };
    }
    const principalGuard = await guardPrincipal(out.principal || args.proof?.issuer || null, "raise_dispute");
    if (!principalGuard.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", dispute: out.record }, null, 2) }] };
  }
);

// ---- Tool 22 - resolve_dispute (evaluator-only, nonfinancial) -----------------
server.registerTool(
  "resolve_dispute",
  {
    title: "Resolve an open dispute",
    description:
      "Records an evaluator decision on an open dispute and transitions the commitment to the canonical nonfinancial outcome (continue|rework|satisfied|against). The caller must present an EIP-712 authority proof and hold an unrevoked, unexpired EVALUATOR authorization on the commitment (verified in-transaction). Resolution NEVER executes a financial transfer or settlement. Idempotent per idempotencyRef.",
    inputSchema: {
      disputeId: z.string().describe("The dispute ID to resolve"),
      outcome: z.enum(["continue", "rework", "satisfied", "against"]).describe("Nonfinancial resolution outcome"),
      agentId: z.string().describe("The caller's agent identity (bound to the verified principal)"),
      proof: z.any().describe("The EIP-712 AuthorityProof"),
      reason: z.string().optional().describe("Resolution rationale"),
      idempotencyRef: z.string().optional().describe("Stable idempotency reference; replay-safe"),
    },
  },
  async (args) => {
    const { resolveDispute } = await import("../endpoint/dispute.js").catch((e) => ({ resolveDispute: null, error: String(e.message || e) }));
    if (!resolveDispute) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "dispute module unavailable" }, null, 2) }] };
    }
    const out = await resolveDispute(args);
    if (!out.ok) {
      await recordAuthFailure(args.proof?.issuer || null, handlerIp());
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: out.reason, stage: out.stage }, null, 2) }] };
    }
    const principalGuard = await guardPrincipal(out.principal || args.proof?.issuer || null, "resolve_dispute");
    if (!principalGuard.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "rate_limited", reason: principalGuard.message }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", dispute: out.record }, null, 2) }] };
  }
);

// ---- Tool 23 - list_disputes (commitment-scoped authorized read) --------------
server.registerTool(
  "list_disputes",
  {
    title: "List disputes for a commitment",
    description:
      "Returns the durable dispute records for a commitment (dispute identifiers, status, resolution, attribution, timestamps). The caller must present an EIP-712 authority proof and hold an active authorization on the commitment. Commitment-scoped: callers with no authorization see nothing. Optional status filter. Read-only.",
    inputSchema: {
      commitmentId: z.string().describe("The commitment ID whose disputes to list"),
      agentId: z.string().describe("The caller's agent identity"),
      proof: z.any().describe("The EIP-712 AuthorityProof"),
      status: z.enum(["open", "resolved", "rejected"]).optional().describe("Filter by dispute status"),
      limit: z.number().min(1).max(200).optional().describe("Max records (default 50)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
    },
  },
  async (args) => {
    const { listDisputes } = await import("../endpoint/dispute.js").catch((e) => ({ listDisputes: null, error: String(e.message || e) }));
    if (!listDisputes) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: "dispute module unavailable" }, null, 2) }] };
    }
    const out = await listDisputes(args);
    if (!out.ok) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", reason: out.reason, stage: out.stage }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...out.record }, null, 2) }] };
  }
);

let _phase4BuyerRegistryCache = null;
function _phase4BuyerRegistry() {
  // Configured buyer registry: file-backed JSON under .output/ (gitignored).
  // { "<lowercased address>": { publicJwk, scopeMaxAmount?, scopeCurrency?,
  //   scopeCapability? } } � a buyer is authorized ONLY when their key is
  // registered here (Phase-4 configured-buyer path, mirroring trusted-key).
  try {
    if (_phase4BuyerRegistryCache) return _phase4BuyerRegistryCache;
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".output", ".phase4-buyer-registry.json");
    if (fs.existsSync(file)) {
      _phase4BuyerRegistryCache = JSON.parse(readFileSync(file, "utf8"));
    } else {
      _phase4BuyerRegistryCache = {};
    }
    return _phase4BuyerRegistryCache;
  } catch (e) {
    return {};
  }
}

  return server;
}

// ---- Live session registry ---------------------------------------------------
// sessionId -> { server, transport, lastActive, open }
// Created on the session-initializing POST (initialize), reused for subsequent
// POST/GET on the SAME session, and closed ONLY by that session's own teardown.
// Idle sessions are swept so a warm instance cannot accumulate transports.
const sessions = new Map();
const SESSION_IDLE_MS = 15 * 60 * 1000; // 15 min without open requests
const MAX_SESSIONS = 500;

function trackSessionOpen(session, res) {
  session.open++;
  res.on("close", () => {
    session.open--;
    session.lastActive = Date.now();
  });
}

function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [sid, s] of sessions) {
    if (s.open === 0 && s.lastActive < cutoff) {
      s.transport.close().catch(() => {});
      sessions.delete(sid);
    }
  }
}
setInterval(sweepIdleSessions, 60_000).unref();

async function closeSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  try {
    await s.transport.close();
  } catch (_) {
    // best-effort teardown; the entry is already removed
  }
}

// ---- Stateless (per-request) dispatch --------------------------------------
// MCP SDK streamable-http STATELESS mode: sessionIdGenerator === undefined.
// The SDK skips session validation entirely (webStandardStreamableHttp.js
// validateSession: "If the sessionIdGenerator ID is not set, the session
// management is disabled and we don't need to validate the session ID").
// Each HTTP request gets a FRESH transport + McpServer; the transport is
// connected, served, then closed immediately after the response completes.
// This is the SDK's documented model for hosts WITHOUT session-affinity
// routing (e.g. Vercel's plain-rewrite /mcp with no sticky sessions): any
// request may reach a different instance and must not depend on process-local
// session memory.
//
// Enabled via SAAX_MCP_MODE=stateless (default: stateful, preserving the
// existing session-based behavior for clients that rely on it). The env var
// is read ONCE at module load: flipping it requires a redeploy (a new
// process), which is the intended rollout path � see the deployment plan.
//
// Key properties:
//  - Per-request session identity is read from HTTP headers (X-SAAX-Email /
//    X-SAAX-Session-Email) directly, NOT from a process-local session map.
//  - Tool closures share only module-level read caches (commitmentStore,
//    capabilitiesCache) - plain synchronous Maps, never torn down.
//  - No request can close another request's transport (nothing is shared).
//  - Durable financial identity comes from commitment IDs / idempotency keys
//    in Supabase, not from the transport or session - see the financial-boundary
//    test (tests/repro-mcp-financial-boundary.mjs).
const MCP_MODE = (process.env.SAAX_MCP_MODE || "stateful").toLowerCase();

function isStatelessMode() {
  return MCP_MODE === "stateless";
}

async function readBodyRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return chunks.join("");
}

async function handleStateless(req, res) {
  const t0 = Date.now();
  setCurrentRequestIp(clientIpFromRequest(req));
  // Gate G.1: bound the body BEFORE parsing (413 on oversize).
  let rawBody;
  try {
    rawBody = await readBodyBounded(req);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = e.statusCode || 413;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: e.message }, id: null }));
    }
    usageTelemetry.record({ endpoint: "/mcp", method: req.method, status: res.statusCode || 413, outcome: "error", durationMs: Date.now() - t0, requestId: req.headers["x-request-id"] || null, isSynthetic: false, mode: "stateless", errorCode: "body_too_large" }).catch(() => {});
    return;
  }
  // SSO/identity: capture per-request from headers (not from a session map).
  const email = identityFromRequest(req);
  if (email) sessionIdentityStore.set("__request__", email);
  // Gate G.1: distributed rate limit at the HTTP boundary (IP tier for
  // unauthenticated; the verified-principal tier applies inside tool handlers
  // where the recovered signer is known).
  let parsedBody;
  try { parsedBody = rawBody ? JSON.parse(rawBody) : undefined; } catch (_) { parsedBody = null; }
  const tool = toolNameFromBody(parsedBody);
  const guard = await guardRequest(req, { tool });
  if (!guard.ok) {
    // Preserve the guard decision: 429 for a real limit hit, 503 when the
    // sensitive-operation store-outage policy refuses (fail-closed). Retry-After
    // is only meaningful for 429 (rate limit); omit it for 503.
    const code = guard.status === 503 ? 503 : 429;
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    if (code === 429) res.setHeader("Retry-After", String(guard.retryAfterSeconds || 60));
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: guard.message || "rate limited" }, id: null }));
    usageTelemetry.record({ endpoint: "/mcp", method: req.method, status: code, outcome: "error", durationMs: Date.now() - t0, requestId: req.headers["x-request-id"] || null, isSynthetic: false, mode: "stateless", errorCode: code === 503 ? "rate_limiter_unavailable" : "rate_limited", limitType: guard.limitType || null }).catch(() => {});
    return;
  }
  const statelessServer = createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await statelessServer.connect(transport);
  let responded = false;
  try {
    await transport.handleRequest(req, res, parsedBody);
    responded = true;
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error: " + String(e.message || e) }, id: null }));
      responded = true;
    }
  } finally {
    if (email) sessionIdentityStore.delete("__request__");
    if (!responded && !res.headersSent && !res.writableEnded) {
      res.statusCode = 500; res.end();
    }
    usageTelemetry.record({
      endpoint: "/mcp", method: req.method, status: res.statusCode || 200,
      outcome: (res.statusCode && res.statusCode >= 400) ? "error" : "ok",
      durationMs: Date.now() - t0, requestId: req.headers["x-request-id"] || null,
      isSynthetic: false, mode: "stateless",
    }).catch(() => {});
    try { await transport.close(); } catch (_) {}
  }
}

export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(req, res) {
  const _t0 = Date.now();
  const _record = (endpoint, status, outcome, extra = {}) => {
    usageTelemetry.record({
      endpoint,
      method: req.method,
      status,
      outcome,
      durationMs: Date.now() - _t0,
      requestId: req.headers["x-request-id"] || null,
      isSynthetic: false,
      ...extra,
    }).catch(() => {});
  };

  // Stateless mode: every request (initialization, reinitialization, tools)
  // is handled with its own fresh transport � no process-local session map.
  // This is the deployment-compatible path for hosts without sticky-session
  // routing (the proxy acceptance test exercises per-request alternation).
  if (req.method === "GET" && !(req.headers.accept || "").includes("text/event-stream")) {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ name: PROTOCOL.name, version: PROTOCOL.version, title: PROTOCOL.fullName, description: PROTOCOL.description, endpoint: { type: "streamable-http", url: "https://saax-protocol.com/mcp", initialize: "POST /mcp with JSON-RPC initialize to begin" }, tools: REGISTERED_TOOL_NAMES }, null, 2));
    usageTelemetry.record({ endpoint: "/mcp", method: req.method, status: 200, outcome: "ok", durationMs: Date.now() - _t0, requestId: req.headers["x-request-id"] || null, isSynthetic: false, mode: "stateless" }).catch(() => {});
    return;
  }
  if (isStatelessMode()) {
    return handleStateless(req, res);
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    _record("/mcp", 204, "ok");
    return;
  }
  // Friendly info response for plain GET (browsers, crawlers, verifiers).
  // Real MCP clients requesting SSE resume send Accept: text/event-stream,
  // in which case we fall through to the SDK's transport handling.
  if (
    req.method === "GET" &&
    !(req.headers.accept || "").includes("text/event-stream")
  ) {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(
      JSON.stringify(
        {
          name: PROTOCOL.name,
          version: PROTOCOL.version,
          title: PROTOCOL.fullName,
          description: PROTOCOL.description,
          endpoint: {
            type: "streamable-http",
            url: "https://saax-protocol.com/mcp",
            initialize: "POST /mcp with JSON-RPC initialize to begin",
          },
          tools: REGISTERED_TOOL_NAMES,
        },
        null,
        2
      )
    );
    _record("/mcp", 200, "ok");
    return;
  }

  // ---- Session-based dispatch (SDK simpleStreamableHttp pattern) -------------
  // streamable-http sessions: the initialize POST creates the session; all
  // later POSTs and the SSE GET carry Mcp-Session-Id; each session owns its own
  // McpServer + transport. No request ever closes another session's transport.
  const sessionIdHeader = req.headers["mcp-session-id"];
  // Gate G.1: distributed rate limit at the HTTP boundary for POST traffic.
  if (req.method === "POST") {
    let parsedForGuard = null;
    try {
      const bodyPreview = await readBodyBounded(req);
      try { parsedForGuard = JSON.parse(bodyPreview); } catch (_) { parsedForGuard = null; }
      const guardTool = toolNameFromBody(parsedForGuard);
      const guard = await guardRequest(req, { tool: guardTool });
      if (!guard.ok) {
        res.statusCode = 429;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Retry-After", String(guard.retryAfterSeconds || 60));
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: guard.message || "rate limited" }, id: null }));
        _record("/mcp", 429, "error", { errorCode: "rate_limited", limitType: guard.limitType || null });
        return;
      }
      // Re-attach the body so the SDK transport can read it (Node http.IncomingMessage
      // is a stream; after readBodyBounded the stream is consumed). Rebuild a
      // fresh readable and stash it on the request for the transport.
      req.rawBody = bodyPreview;
    } catch (e) {
      // Body exceeded the bound: 413 without touching the transport.
      res.statusCode = e.statusCode || 413;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: e.message }, id: null }));
      _record("/mcp", res.statusCode, "error", { errorCode: "body_too_large" });
      return;
    }
  }

  if (req.method === "DELETE") {
    if (sessionIdHeader) await closeSession(sessionIdHeader);
    res.statusCode = 200;
    res.end();
    _record("/mcp", 200, "ok", { clientId: sessionIdHeader || null });
    return;
  }

  const readBody = async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return chunks.join("");
  };

  if (!sessionIdHeader) {
    // MUST be a session-initializing POST (initialize). Anything else -> 400.
    if (req.method !== "POST") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no Mcp-Session-Id and not an initialize request" }, id: null }));
      _record("/mcp", 400, "error", { errorCode: "no_session" });
      return;
    }
    const rawBody = req.rawBody !== undefined ? req.rawBody : undefined;
    let parsedBody = null;
    try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch (_) { /* malformed */ }
    if (!parsedBody || parsedBody.method !== "initialize") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: first request must be initialize" }, id: null }));
      _record("/mcp", 400, "error", { errorCode: "not_initialize" });
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Too many open sessions" }, id: null }));
      _record("/mcp", 503, "error", { errorCode: "too_many_sessions" });
      return;
    }
    const sessionServer = createSessionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server: sessionServer, transport, open: 0, lastActive: Date.now() });
        res.setHeader("Mcp-Session-Id", sessionId);
      },
    });
    await sessionServer.connect(transport);
    try {
      await transport.handleRequest(req, res, parsedBody);
      _record("/mcp", res.statusCode || 200, "ok", { clientId: sessions.size ? "session" : null });
    } finally {
      // If an initialize response completes and the client keeps the session,
      // the session remains in the map (transport stays attached for reuse).
      _record("/mcp", res.statusCode || 200, "ok", { clientId: "session" });
    }
    return;
  }

  // Existing session: reuse its transport/server; never touch another session.
  const session = sessions.get(sessionIdHeader);
  if (!session) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
    _record("/mcp", 404, "error", { errorCode: "session_not_found" });
    return;
  }
  trackSessionOpen(session, res);
  const body = req.method === "POST" ? (req.rawBody !== undefined ? req.rawBody : undefined) : undefined;
  let parsedBody = null;
  try { parsedBody = body ? JSON.parse(body) : undefined; } catch (_) { /* raw string fallback */ }
  try {
    await session.transport.handleRequest(req, res, parsedBody);
  } finally {
    _record("/mcp", res.statusCode || 200, res.statusCode && res.statusCode >= 400 ? "error" : "ok", { clientId: sessionIdHeader });
  }
}
