// SAAX Protocol — Discovery HTTP endpoints as a Vercel serverless function.
//
// Serves, on the live deployment:
//   GET  /.well-known/saax.json   -> the SIGNED standalone discovery profile
//   POST /prepare-commitment      -> free, nonbinding signed proposal (preflight)
//   POST /accept-commitment       -> explicit buyer authorization -> exactly one
//                                    authenticated commitment (durable, cross-
//                                    instance via the Supabase acceptance store)
//
// All three use the SAME cores as the MCP adapter (endpoint/preflight-core.js,
// endpoint/acceptance-core.js) and the SAME durable store (the Supabase
// acceptance_operations table + atomic RPCs — safe on Vercel's multi-instance
// runtime). The preflight/acceptance operations create NO payment, custody,
// execution, or release; they are nonfinancial interfaces.
//
// The operator signing key is loaded from the environment
// (SAAX_OPERATOR_PRIVATE_JWK) — provisioned securely, never committed.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const preflightCore = await Promise.resolve(_require("../endpoint/preflight-core.js"));
const acceptanceCore = await Promise.resolve(_require("../endpoint/acceptance-core.js"));
const acceptCrypto = await Promise.resolve(_require("../endpoint/acceptance-crypto.js"));
const cryptoLib = await Promise.resolve(_require("../endpoint/discovery-crypto.js"));
const { ProposalStore } = await Promise.resolve(_require("../endpoint/proposal-store.js")).catch(() => ({ ProposalStore: null }));
const { SupabaseAcceptanceStore } = await Promise.resolve(_require("../endpoint/supabase-acceptance-store.js")).catch(() => ({ SupabaseAcceptanceStore: null }));
const { calculateJwkThumbprint } = await import("jose").catch(() => ({ calculateJwkThumbprint: null }));

export const config = { runtime: "nodejs", maxDuration: 60 };

// ---- Signed live discovery profile ------------------------------------------
// Prefer the committed signed profile; allow an operator override for rotation.
function loadSignedProfile() {
  const override = process.env.SAAX_SIGNED_PROFILE_JSON;
  if (override && override.trim()) {
    try { return JSON.parse(override); } catch (_) { /* fall through */ }
  }
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec", "examples", "discovery", "profile-live-signed.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  return null;
}

// ---- Provider ref (operator key from env; fallback to committed example key) -
function loadProviderRef() {
  const profile = loadSignedProfile();
  if (!profile) return null;
  const keyRef = (profile.signingKeys || [])[0];
  if (!keyRef || !keyRef.jwk) return null;
  let privateJwk = null;
  const envKey = process.env.SAAX_OPERATOR_PRIVATE_JWK;
  if (envKey && envKey.trim()) {
    try { privateJwk = JSON.parse(envKey); } catch (_) { privateJwk = null; }
  }
  if (!privateJwk) {
    // Local dev fallback: the gitignored example key (never for production).
    const devKey = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec", "examples", "discovery", "keys", "example-private.jwk.json");
    if (existsSync(devKey)) {
      try { privateJwk = JSON.parse(readFileSync(devKey, "utf8")); } catch (_) { /* fall through */ }
    }
  }
  if (!privateJwk) return null;
  const manSchema = (profile.capabilities && profile.capabilities[0] && profile.capabilities[0].schemas || []).find((s) => s && s.purpose === "commitment-manifest");
  return {
    providerId: profile.providerId,
    name: profile.providerName,
    origin: profile.origin,
    signingKeyId: keyRef.id,
    privateJwk,
    jwkPublic: { kty: "OKP", crv: "Ed25519", x: keyRef.jwk.x },
    manifestDigest: manSchema ? manSchema.digest : null,
    evaluatorRef: profile.capabilities && profile.capabilities[0] && profile.capabilities[0].evaluatorRequirements || null,
    permittedDecisions: null,
    profile,
  };
}

// ---- Supabase acceptance store (cross-instance durable) ----------------------
function makeAcceptanceStore() {
  const url = process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY || "";
  if (!url || !key || !SupabaseAcceptanceStore) return null;
  try {
    return new SupabaseAcceptanceStore({ supabaseUrl: url, serviceRoleKey: key });
  } catch (_) {
    return null;
  }
}

function makeProposalStore() {
  // DEPLOYED PATH: Supabase proposals (cross-instance atomic idempotency).
  // LOCAL FALLBACK: fs journal (single host) when Supabase is unconfigured.
  const url = process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SAAX_SUPABASE_KEY || "";
  if (url && key) {
    try {
      const mod = _require("../endpoint/supabase-proposal-store.js");
      return new mod.SupabaseProposalStore({ supabaseUrl: url, serviceRoleKey: key });
    } catch (e) {
      console.error("[prepare-commitment] Supabase proposal store unavailable:", e.message);
    }
  }
  if (!ProposalStore) return null;
  try {
    return new ProposalStore(path.join(process.env.SAAX_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".output"), "proposals"));
  } catch (_) {
    return null;
  }
}

// ---- Buyer registry (configured keys; server-side secret or file) ------------
let _buyerRegistry = null;
function loadBuyerRegistry() {
  if (_buyerRegistry) return _buyerRegistry;
  const env = process.env.SAAX_BUYER_REGISTRY_JSON;
  if (env && env.trim()) {
    try { _buyerRegistry = JSON.parse(env); return _buyerRegistry; } catch (_) { /* fall through */ }
  }
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".output", ".phase4-buyer-registry.json");
  if (existsSync(p)) {
    try { _buyerRegistry = JSON.parse(readFileSync(p, "utf8")); return _buyerRegistry; } catch (_) { /* fall through */ }
  }
  _buyerRegistry = {};
  return _buyerRegistry;
}

function buyerScopeFor(address) {
  const a = String(address || "").toLowerCase();
  const reg = loadBuyerRegistry()[a];
  if (!reg) return null;
  return {
    buyer: a,
    buyerPublicJwk: reg.publicJwk,
    scopeMaxAmount: reg.scopeMaxAmount,
    scopeCurrency: reg.scopeCurrency,
    scopeCapability: reg.scopeCapability,
  };
}

// ---- Trusted thumbprints (configured trust path) -----------------------------
let _trustedThumbprints = null;
async function trustedThumbprints() {
  if (_trustedThumbprints) return _trustedThumbprints;
  const providerRef = loadProviderRef();
  if (!providerRef) { _trustedThumbprints = []; return _trustedThumbprints; }
  if (calculateJwkThumbprint) {
    try {
      _trustedThumbprints = [await calculateJwkThumbprint(providerRef.jwkPublic)];
      return _trustedThumbprints;
    } catch (_) { /* fall through */ }
  }
  _trustedThumbprints = [];
  return _trustedThumbprints;
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 512 * 1024) { reject(new Error("payload too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const url = String(req.url || "/").split("?")[0];

  // GET /.well-known/saax.json — the signed standalone discovery profile.
  if (req.method === "GET" && (url === "/.well-known/saax.json" || url === "/.well-known/discovery")) {
    const profile = loadSignedProfile();
    if (!profile) { json(res, 500, { status: "error", errorCode: "DSC_UNAVAILABLE", reason: "signed profile not configured" }); return; }
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(profile, null, 2));
    return;
  }

  // POST /prepare-commitment — free, nonbinding preflight.
  if (req.method === "POST" && url === "/prepare-commitment") {
    let body;
    try { body = await readBody(req); } catch (e) { json(res, 400, { status: "error", errorCode: "DSC_INVALID_REQUEST", reason: (e && e.message) || "invalid body" }); return; }
    const providerRef = loadProviderRef();
    if (!providerRef) { json(res, 503, { status: "error", errorCode: "DSC_UNAVAILABLE", reason: "provider profile unavailable" }); return; }
    const store = makeProposalStore();
    if (!store) { json(res, 503, { status: "error", errorCode: "DSC_UNAVAILABLE", reason: "proposal store unavailable" }); return; }
    const outcome = await preflightCore.prepareCommitment({ profile: providerRef.profile, providerRef, request: body, store, clock: null });
    if (outcome.status === "ok") { json(res, 200, { status: "ok", proposal: outcome.proposal }); return; }
    if (outcome.status === "duplicate") { json(res, 200, { status: "duplicate", proposal: outcome.proposal }); return; }
    json(res, outcome.httpStatus || 422, { status: "error", error: { code: outcome.errorCode, message: outcome.reason } });
    return;
  }

  // POST /accept-commitment — explicit buyer authorization -> one commitment.
  if (req.method === "POST" && url === "/accept-commitment") {
    let body;
    try { body = await readBody(req); } catch (e) { json(res, 400, { status: "error", errorCode: "DSC_INVALID_REQUEST", reason: (e && e.message) || "invalid body" }); return; }
    const providerRef = loadProviderRef();
    if (!providerRef) { json(res, 503, { status: "error", errorCode: "DSC_UNAVAILABLE", reason: "provider profile unavailable" }); return; }
    const store = makeAcceptanceStore();
    if (!store) { json(res, 503, { status: "error", errorCode: "DSC_UNAVAILABLE", reason: "acceptance store unavailable (Supabase not configured)" }); return; }
    const proposal = body.proposal;
    const acceptance = body.acceptance;
    if (!proposal || !acceptance) { json(res, 422, { status: "error", errorCode: "DSC_INVALID_REQUEST", reason: "proposal and acceptance required" }); return; }
    const buyerAddr = acceptance.buyer || (proposal.audience && proposal.audience.buyer);
    const buyerScope = buyerScopeFor(buyerAddr);
    if (!buyerScope) { json(res, 401, { status: "error", errorCode: "DSC_UNAUTHORIZED", reason: "buyer not registered" }); return; }
    const thumbs = await trustedThumbprints();
    if (!thumbs.length) { json(res, 503, { status: "error", errorCode: "DSC_UNAVAILABLE", reason: "trust not configured" }); return; }
    const outcome = await acceptanceCore.acceptCommitment({
      profile: providerRef.profile,
      trustedThumbprints: thumbs,
      proposal,
      buyerScope,
      acceptance,
      providerRef,
      store,
      clock: null,
      idempotencyKey: String(body.idempotencyKey || ""),
    });
    if (outcome.status === "ok" || outcome.status === "duplicate") {
      json(res, outcome.status === "ok" ? 201 : 200, { status: outcome.status, operation: outcome.operation, commitment: outcome.commitment });
      return;
    }
    json(res, outcome.httpStatus || 422, { status: outcome.status === "rejected" ? "rejected" : outcome.status, error: { code: outcome.errorCode, message: outcome.reason } });
    return;
  }

  // Other routes -> 404.
  json(res, 404, { status: "error", errorCode: "DSC_NOT_FOUND", reason: "unknown discovery route " + url });
}