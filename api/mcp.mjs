// SAAX Protocol â€” MCP discovery server (read-only, no settlement).
// Exposes protocol information to AI clients and agents via streamable-http.
//
// Day 13 (Task 3): wired to real gateway logic â€” ROUTES and READS only.
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

if (usageTelemetry.isEnabled()) {
  try { usageTelemetry.setStoreClient(buildStoreClient()); } catch (_) { /* stays disabled */ }
}

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
// PERSISTENCE (audited â€” daily-logs/saax-mcp-registry.md Â§13): this is an
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
  fullName: "SAAX Protocol â€” Solvent Applied Autonomous Exchange Protocol",
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
// Identity is resolved from the X-SAAX-Email header (or X-SAAX-Session-Email) â€”
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
// The MCP SDK's Protocol owns a SINGLE transport: connect() throws "Already
// connected to a transport. Call close() before connecting to a new transport,
// or use a separate Protocol instance per connection." A module-level singleton
// server therefore cannot serve concurrent sessions safely (closing one
// request's transport would tear down another's). Following the SDK's own
// simpleStreamableHttp example, each MCP session gets its OWN McpServer +
// transport, registered in `sessions` below. Tool closures share only
// module-level read caches (commitmentStore, sessionIdentityStore) — safe:
// they are plain synchronous Maps, never torn down per session.
function createSessionServer() {
  const server = new McpServer({
    name: PROTOCOL.name,
    version: PROTOCOL.version,
  });

// -----------------------------------------------------------------------------
// Tool 1 â€” get_protocol_info (unchanged)
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
// Tool 2 â€” get_routing_fee (unchanged)
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
// Tool 3 â€” ping (unchanged)
// -----------------------------------------------------------------------------
server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Returns a lightweight liveness response. Call this to verify the endpoint is reachable. Do not use for discovery, capability listing, or pricing â€” use get_protocol_info, list_capabilities, or get_routing_fee instead.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: "ok" }] })
);

// -----------------------------------------------------------------------------
// Tool 4 â€” route_request (WIRED: real ranking, no settlement)
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
// Tool 5 â€” get_commitment (WIRED: commitment store lookup)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_commitment",
  {
    title: "Get a commitment manifest",
    description: "Returns the full commitment object for a given commitment ID â€” including terms, state, manifest hash, and evidence references. Call this when an agent needs the complete commitment record. For status-only polling, use get_commitment_status. For listing all commitments for a subscriber, use list_commitments.",
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
// Tool 6 â€” list_capabilities (NEW: read-only capability discovery)
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
// Tool 7 â€” list_commitments (PREMIUM-gated read; same gating as the premium tools)
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
// Tool 8 â€” get_commitment_status (ungated; commitment id is the access token)
// -----------------------------------------------------------------------------
server.registerTool(
  "get_commitment_status",
  {
    title: "Get a commitment's lifecycle state",
    description: "Returns only the current lifecycle state for a given commitment ID, plus the recommended next action for the calling agent. Call this before retrying any commitment that timed out â€” an unknown outcome is a status check, not another POST. The next_action field tells the agent whether to retry, poll, or stop. For the full commitment record, use get_commitment.",
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
// PREMIUM TOOL A â€” get_evidence_verification (gated by SAAX Premium)
// -----------------------------------------------------------------------------// -----------------------------------------------------------------------------
// PREMIUM TOOL A â€” get_evidence_verification (gated by SAAX Premium)
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
// PREMIUM TOOL B â€” get_authority_validation (gated by SAAX Premium)
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
// Tool 10 — prepare_commitment (SAAX Discovery Phase 3: FREE, NONBINDING
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
// proposal (trusted-key path, §7.2), verifies the BUYER'S OWN SIGNATURE over
// the exact proposal digest + terms digest (caller-supplied identity is not
// proof), durably accepts ONCE (single-writer acceptance store), and creates
// the commitment (manifest v1 + provider JWS over the canonical manifest+
// proposal binding — signedRepresentationVersion "manifest-v1.1+saax-
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

let _phase4BuyerRegistryCache = null;
function _phase4BuyerRegistry() {
  // Configured buyer registry: file-backed JSON under .output/ (gitignored).
  // { "<lowercased address>": { publicJwk, scopeMaxAmount?, scopeCurrency?,
  //   scopeCapability? } } — a buyer is authorized ONLY when their key is
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
// process), which is the intended rollout path — see the deployment plan.
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
  // SSO/identity: capture per-request from headers (not from a session map).
  const email = identityFromRequest(req);
  if (email) sessionIdentityStore.set("__request__", email);
  const statelessServer = createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await statelessServer.connect(transport);
  const rawBody = await readBodyRaw(req);
  let parsedBody;
  try { parsedBody = rawBody ? JSON.parse(rawBody) : undefined; } catch (_) { parsedBody = null; }
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
  // is handled with its own fresh transport — no process-local session map.
  // This is the deployment-compatible path for hosts without sticky-session
  // routing (the proxy acceptance test exercises per-request alternation).
  if (req.method === "GET" && !(req.headers.accept || "").includes("text/event-stream")) {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ name: PROTOCOL.name, version: PROTOCOL.version, title: PROTOCOL.fullName, description: PROTOCOL.description, endpoint: { type: "streamable-http", url: "https://ax-router.vercel.app/mcp", initialize: "POST /mcp with JSON-RPC initialize to begin" }, tools: ["get_protocol_info", "get_routing_fee", "ping", "route_request", "get_commitment", "list_capabilities", "list_commitments", "get_commitment_status", "get_evidence_verification", "get_authority_validation", "prepare_commitment", "accept_commitment"] }, null, 2));
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
            url: "https://ax-router.vercel.app/mcp",
            initialize: "POST /mcp with JSON-RPC initialize to begin",
          },
          tools: [
            "get_protocol_info",
            "get_routing_fee",
            "ping",
            "route_request",
            "get_commitment",
            "list_capabilities",
            "list_commitments",
            "get_commitment_status",
            "get_evidence_verification",
            "get_authority_validation",
            "prepare_commitment",
            "accept_commitment",
          ],
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
    const rawBody = await readBody();
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
  const body = req.method === "POST" ? await readBody() : undefined;
  let parsedBody = null;
  try { parsedBody = body ? JSON.parse(body) : undefined; } catch (_) { /* raw string fallback */ }
  try {
    await session.transport.handleRequest(req, res, parsedBody);
  } finally {
    _record("/mcp", res.statusCode || 200, res.statusCode && res.statusCode >= 400 ? "error" : "ok", { clientId: sessionIdHeader });
  }
}
