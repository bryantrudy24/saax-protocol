// SAAX Checkout Session creator - Vercel serverless function.
// Creates a Stripe Checkout Session for SAAX Premium subscriptions.
//   GET  /checkout?plan=trial|developer|business   (browser click -> 303 redirect)
//   POST /checkout  { plan: "trial"|"developer"|"business" }   (API call -> 303 redirect)
//
// The trial plan requires a Checkout Session (NOT a Payment Link) because
// Payment Links cannot carry trial_period_days. The session collects a card
// up front (payment_method_collection: always) so Radar's free-trial abuse
// control can detect trial starts, and the subscription is created in
// trialing status with a 14-day trial.
import Stripe from "stripe";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const TRIAL_PRICE_ID = process.env.STRIPE_TRIAL_PRICE_ID || "";

const DEVELOPER_PRICE_ID = "price_1UNp39AWggRLQc7cJawGJKhp";
const BUSINESS_PRICE_ID = "price_1UNp3AAWggRLQc7cx7dnTtg5";

const SUCCESS_URL = "https://saax-protocol.com/welcome";
const CANCEL_URL = "https://saax-protocol.com";

const PLANS = {
  trial: { priceId: TRIAL_PRICE_ID, trialDays: 14 },
  developer: { priceId: DEVELOPER_PRICE_ID, trialDays: 0 },
  business: { priceId: BUSINESS_PRICE_ID, trialDays: 0 },
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!STRIPE_SECRET_KEY) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "server_misconfigured", message: "STRIPE_SECRET_KEY is not set in the environment." }));
    return;
  }

  // Resolve the plan from GET query or POST body.
  let plan = "developer";
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      plan = url.searchParams.get("plan") || "developer";
    } else if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString("utf8");
      if (body) {
        try {
          plan = (JSON.parse(body).plan) || "developer";
        } catch {
          // fall through to default
        }
      }
    } else {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
  } catch (e) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "bad_request", message: e.message }));
    return;
  }

  const cfg = PLANS[plan];
  if (!cfg) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "unknown_plan", message: `Unknown plan '${plan}'. Use trial, developer, or business.` }));
    return;
  }
  if (!cfg.priceId) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "server_misconfigured", message: `No price configured for plan '${plan}'.` }));
    return;
  }

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const sessionParams = {
      mode: "subscription",
      line_items: [{ price: cfg.priceId, quantity: 1 }],
      payment_method_collection: "always",
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      subscription_data: {
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" },
        },
      },
    };
    if (cfg.trialDays > 0) {
      sessionParams.subscription_data.trial_period_days = cfg.trialDays;
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.statusCode = 303;
    res.setHeader("Location", session.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ redirect: session.url }));
  } catch (e) {
    console.error("[checkout] session creation failed:", e.message);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "checkout_failed", message: e.message }));
  }
}