// SAAX Stripe webhook — Vercel serverless function.
// Handles: checkout.session.completed, invoice.paid, invoice.payment_failed.
//
// Signature verification uses the RAW request body (never parsed JSON) passed
// unmodified to stripe.webhooks.constructEvent with STRIPE_WEBHOOK_SECRET.
// Requests without a valid signature are rejected with 400.
import Stripe from "stripe";
import {
  supabase,
  upsertSubscription,
  lookupSubscription,
  tierFromAmountCents,
} from "../lib/supabase.mjs";
import { sendWelcomeEmail } from "../lib/welcome-email.mjs";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
// The Stripe REST key is optional for the webhook: signature verification only
// needs the signing secret (Stripe.webhooks.constructEvent is STATIC — it does
// not require an instantiated client). The API client is used solely to resolve
// the subscription's real period end; if no key is configured we fall back to
// +30 days from now (the invoice.paid path carries the authoritative period end).
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

/**
 * Load the FULL raw body as a Buffer (Vercel may stream; default handler
 * receives body as a string on most setups, but we defensively re-read).
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

// bodyParser:false is REQUIRED for Stripe signature verification — Vercel's
// JSON parser would convert the raw body into an object and destroy the exact
// bytes the signature was computed over. With the parser off, `req` stays a
// pure IncomingMessage and our stream reader (readRawBody) gets the raw bytes.
export const config = { runtime: "nodejs", maxDuration: 30, api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  // ---- 1. Signature verification (raw body) -------------------------------
  const rawBody = await readRawBody(req);
  let event;
  try {
    // Static API — works without a REST key: only the webhook signing secret
    // is needed to verify the signature.
    event = Stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] signature verification failed:", err.message);
    return json(res, 400, { error: "invalid_signature", message: err.message });
  }

  // ---- 2. Event routing ----------------------------------------------------
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const email = s.customer_details?.email || s.customer_email || "";
        if (!email) {
          console.warn("[webhook] checkout.session.completed missing email; skipping");
          return json(res, 200, { received: true, event: event.type, skipped: "missing_email" });
        }
        const subId = s.subscription || `cs_${s.id}`;
        const amountTotal = s.amount_total || 0;
        const tier = tierFromAmountCents(amountTotal);
        // Resolve the subscription's REAL status and period end from Stripe
        // (the checkout session object does not carry the subscription status).
        // A trial subscription reports status 'trialing' - we must record that
        // so the gating layer can serve access during the trial.
        let subStatus = "active";
        let periodEnd = new Date(Date.now() + 30 * 86400_000).toISOString();
        if (s.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(s.subscription);
            subStatus = sub.status || "active";
            periodEnd = new Date((sub.current_period_end || 0) * 1000).toISOString();
          } catch (e) {
            console.warn("[webhook] subscription retrieve failed; defaulting status:", e.message);
          }
        }
        const row = await upsertSubscription({
          email,
          stripeCustomerId: s.customer || "",
          subscriptionId: subId,
          priceTier: tier,
          status: subStatus,
          currentPeriodEnd: periodEnd,
        });
        console.log("[webhook] checkout.session.completed recorded:", subId, email, tier, "status:", subStatus);
// Welcome email - AWAITED so the serverless lifecycle cannot kill the send.
// The webhook returns 200 only after the send resolves (or fails fast on config).
const emailRes = await sendWelcomeEmail({ email, tier, price: amountTotal, periodEnd });
if (!emailRes.ok && emailRes.skipped !== 'missing_resend_key') {
  console.error('[welcome-email] send failed:', email, JSON.stringify(emailRes));
}
      }

      case "invoice.paid": {
        const inv = event.data.object;
        const subId = inv.subscription;
        const email = inv.customer_email || "";
        const periodEnd = inv.lines?.data?.[0]?.period?.end || Math.floor(Date.now() / 1000);
        if (subId && email) {
          const row = await upsertSubscription({
            email,
            stripeCustomerId: inv.customer || "",
            subscriptionId: subId,
            priceTier: tierFromAmountCents(inv.amount_paid || 0),
            status: "active",
            currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
          });
          console.log("[webhook] invoice.paid extends:", subId, email, new Date(periodEnd * 1000).toISOString());
          return json(res, 200, { received: true, event: event.type, subscription_id: subId, email, row });
        }
        console.warn("[webhook] invoice.paid missing subscription/email; skipping");
        return json(res, 200, { received: true, event: event.type, skipped: "missing_fields" });
      }

      case "invoice.payment_failed": {
        const inv = event.data.object;
        const subId = inv.subscription;
        const email = inv.customer_email || "";
        if (subId && email) {
          const row = await upsertSubscription({
            email,
            stripeCustomerId: inv.customer || "",
            subscriptionId: subId,
            priceTier: tierFromAmountCents(inv.amount_due || 0),
            status: "past_due",
            currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
          });
          console.log("[webhook] invoice.payment_failed → past_due:", subId, email);
          return json(res, 200, { received: true, event: event.type, subscription_id: subId, email, status: "past_due", row });
        }
        console.warn("[webhook] invoice.payment_failed missing subscription/email; skipping");
        return json(res, 200, { received: true, event: event.type, skipped: "missing_fields" });
      }

      default:
        // Acknowledge unhandled event types so Stripe stops retrying them.
        return json(res, 200, { received: true, event: event.type, unhandled: true });
    }
  } catch (err) {
    console.error("[webhook] handler error:", err.message);
    return json(res, 500, { error: "handler_failed", message: err.message });
  }
}

/** Best-effort: resolve the subscription's current period end via the Stripe API. */
async function periodEndForSubscription(subId) {
  try {
    if (!stripe) return Date.now() + 30 * 86400_000;
    const sub = await stripe.subscriptions.retrieve(subId);
    return (sub.current_period_end || 0) * 1000;
  } catch {
    return Date.now() + 30 * 86400_000;
  }
}