// Shared Supabase client for the SAAX subscription layer.
// Imported by BOTH the Stripe webhook (api/stripe/webhook.mjs) and the MCP
// server's gating logic (api/mcp.mjs). Instantiated once per cold start.
//
// Security model:
//  - The subscriptions table has RLS enabled with ZERO policies: no direct
//    anon/client reads or writes are possible.
//  - All access goes through SECURITY DEFINER RPCs (upsert_subscription /
//    lookup_subscription) that own the table and are granted EXECUTE to anon.
//  - Clients authenticate with SUPABASE_SERVICE_ROLE_KEY (switched from the
//    anon key as part of the RLS remediation): the service role bypasses RLS,
//    and the RPCs remain the functional boundary. The anon key is no longer
//    used anywhere in this module.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Defensive: createClient(undefined) THROWS. The MCP server imports this module
// eagerly; if Supabase env is absent (e.g. a bare MCP deploy), we must still
// cold-start. RPC calls then fail fast with a clear error instead of crashing.
export const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

// Schema-scoped client for the ax_router schema. The commitments table and its
// RPCs (upsert_commitment / lookup_commitment_by_id / lookup_commitments_by_email)
// live in ax_router, NOT public. supabase-js RPC calls resolve against the
// client's db.schema; the subscription RPCs stay on the default (public) client.
// PostgREST needs schema propagation, so the client must be created with
// db.schema set — a per-call option does not exist.
export const supabaseAxRouter =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        db: { schema: "ax_router" },
      })
    : null;
/**
 * Create or update a subscription record by stripe subscription id.
 * @param {{email:string, stripeCustomerId:string, subscriptionId:string, priceTier:string, status:string, currentPeriodEnd:string}} sub
 * @returns {Promise<object>} the upserted row
 */
export async function upsertSubscription(sub) {
  if (!supabase) {
    throw new Error("upsert_subscription skipped: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  const { data, error } = await supabase.rpc("upsert_subscription", {
    p_email: sub.email,
    p_stripe_customer_id: sub.stripeCustomerId,
    p_subscription_id: sub.subscriptionId,
    p_price_tier: sub.priceTier,
    p_status: sub.status,
    p_current_period_end: sub.currentPeriodEnd,
  });
  if (error) {
    throw new Error(`upsert_subscription failed: ${error.message} (${error.code || "code"})`);
  }
  return data;
}

/**
 * Look up the active subscription for an email.
 * The RPC filters: email match AND status='active' AND current_period_end > now().
 * @param {string} email
 * @returns {Promise<object|null>} row or null
 */
export async function lookupSubscription(email) {
  if (!supabase) {
    throw new Error("lookup_subscription failed: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  const { data, error } = await supabase.rpc("lookup_subscription", {
    p_email: email,
  });
  if (error) {
    throw new Error(`lookup_subscription failed: ${error.message} (${error.code || "code"})`);
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/** Map a Stripe amount_total (cents) to a SAAX tier name. */

// ---------------------------------------------------------------------------
// Commitment store (Day: commitment lifecycle persistence)
// ---------------------------------------------------------------------------
// The commitments table lives in the ax_router schema. The RPCs are SECURITY
// DEFINER and granted EXECUTE to PUBLIC/anon today; the client authenticates
// with SUPABASE_SERVICE_ROLE_KEY (switched as part of the RLS remediation).
// Post-RLS, anon EXECUTE on the read RPCs is revoked; service_role keeps
// EXECUTE so this module's reads/writes continue to function.

/**
 * Persist (insert or update) a commitment by commitment_id.
 * @param {object} c { commitmentId, state, capability, buyerEmail, terms, authorityRef, evidenceRefs, settlementRef, manifestHash }
 * @returns {Promise<object>} the upserted row
 */
export async function upsertCommitment(c) {
  if (!supabaseAxRouter) throw new Error("upsert_commitment skipped: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");
  const { data, error } = await supabaseAxRouter.rpc("upsert_commitment", {
    p_commitment_id: c.commitmentId,
    p_state: c.state || "issued",
    p_capability: c.capability,
    p_buyer_email: c.buyerEmail,
    p_terms: c.terms || {},
    p_authority_ref: c.authorityRef,
    p_evidence_refs: c.evidenceRefs && c.evidenceRefs.length ? c.evidenceRefs : [],
    p_settlement_ref: c.settlementRef,
    p_manifest_hash: c.manifestHash,
  });
  if (error) throw new Error(`upsert_commitment failed: ${error.message} (${error.code || "code"})`);
  return data;
}

/**
 * Read a single commitment by id.
 * @param {string} commitmentId
 * @returns {Promise<object|null>} row or null
 */
export async function lookupCommitmentById(commitmentId) {
  if (!supabaseAxRouter) throw new Error("lookup_commitment_by_id failed: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");
  const { data, error } = await supabaseAxRouter.rpc("lookup_commitment_by_id", { p_commitment_id: commitmentId });
  if (error) throw new Error(`lookup_commitment_by_id failed: ${error.message} (${error.code || "code"})`);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * List all commitments for a buyer email.
 * @param {string} email
 * @returns {Promise<object[]>} rows (newest first)
 */
export async function lookupCommitmentsByEmail(email) {
  if (!supabaseAxRouter) throw new Error("lookup_commitments_by_email failed: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");
  const { data, error } = await supabaseAxRouter.rpc("lookup_commitments_by_email", { p_email: email });
  if (error) throw new Error(`lookup_commitments_by_email failed: ${error.message} (${error.code || "code"})`);
  return Array.isArray(data) ? data : [];
}

/** Map a commitments row (snake_case) to the MCP record shape (camelCase). */
export function commitmentRowToRecord(row) {
  if (!row) return null;
  const terms = row.terms && typeof row.terms === "object" ? row.terms : {};
  return {
    commitmentId: row.commitment_id,
    createdAt: row.created_at,
    state: row.state,
    capability: row.capability,
    buyerEmail: row.buyer_email,
    terms: { ...terms, manifestHash: row.manifest_hash },
    manifest: {
      commitmentId: row.commitment_id,
      manifestHash: row.manifest_hash,
      capability: row.capability,
      ...terms,
    },
    authorityRef: row.authority_ref,
    evidenceRefs: row.evidence_refs || [],
    settlementRef: row.settlement_ref,
  };
}

export function tierFromAmountCents(amountCents) {
  if (amountCents === 2900) return "Developer";
  if (amountCents === 19900) return "Business";
  return amountCents ? `Tier-${amountCents}` : "Unknown";
}