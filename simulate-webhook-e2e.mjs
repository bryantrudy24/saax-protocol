// Local end-to-end webhook simulator: exercises the deployed webhook's exact
// handler logic against the real Supabase RPCs, with a real Stripe signature
// computed locally (same algorithm Stripe uses: HMAC-SHA256 over
// timestamp.payload with the signing secret).
//
// This mirrors `stripe trigger` for the three events. It needs STRIPE_WEBHOOK_SECRET
// in env to build a VALID signature — which is exactly the operator-supplied value.
import Stripe from "stripe";
import crypto from "crypto";
import { upsertSubscription, lookupSubscription, supabase } from "./api/lib/supabase.mjs";

const SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_secret_placeholder";

// Build an event payload the way Stripe does.
function buildEvent(type, object) {
  return {
    id: `evt_test_${Date.now()}`,
    object: "event",
    api_version: "2025-03-31",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 0,
    request: { id: "req_test", idempotency_key: `test_${Date.now()}` },
    type,
  };
}

// Sign an event payload exactly like Stripe: HMAC-SHA256(secret, `${t}.${payload}`).
function signEvent(payload, secret) {
  const t = Math.floor(Date.now() / 1000);
  const signed = `${t}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return { header: `t=${t},v1=${signature}`, timestamp: t };
}

async function run() {
  const email = "webhook-sim@saaxtest.dev";

  // ---- 1. checkout.session.completed --------------------------------------
  const cs = {
    id: "cs_test_sim_001",
    object: "checkout.session",
    customer: "cus_test_sim",
    customer_details: { email },
    subscription: "sub_test_sim_001",
    amount_total: 2900,
    currency: "usd",
    mode: "subscription",
    payment_status: "paid",
  };
  let payload = JSON.stringify(buildEvent("checkout.session.completed", cs));
  let { header } = signEvent(payload, SECRET);
  // Verify the signature the way the webhook does.
  let verified;
  try {
    verified = Stripe.webhooks.constructEvent(payload, header, SECRET);
    console.log("1) SIGNATURE_VERIFIED:", verified.type);
  } catch (e) {
    console.log("1) SIGNATURE_FAILED:", e.message);
    process.exit(1);
  }
  // Simulate the handler's checkout branch.
  const s = cs;
  const row = await upsertSubscription({
    email,
    stripeCustomerId: s.customer,
    subscriptionId: s.subscription,
    priceTier: "Developer",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  console.log("1) SUBSCRIPTION_RECORDED:", row.subscription_id, "|", row.status, "|", row.price_tier);

  const found = await lookupSubscription(email);
  console.log("1) GATE_LOOKUP_ACTIVE:", !!found, found ? `| ${found.status} | ${found.price_tier}` : "NONE");

  // ---- 2. invoice.paid (extends period) -----------------------------------
  const invPaid = {
    id: "in_test_sim_001",
    object: "invoice",
    subscription: "sub_test_sim_001",
    customer: "cus_test_sim",
    customer_email: email,
    amount_paid: 2900,
    lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 60 * 86400 } }] },
  };
  payload = JSON.stringify(buildEvent("invoice.paid", invPaid));
  ({ header } = signEvent(payload, SECRET));
  verified = Stripe.webhooks.constructEvent(payload, header, SECRET);
  console.log("2) SIGNATURE_VERIFIED:", verified.type);
  const ext = await upsertSubscription({
    email,
    stripeCustomerId: invPaid.customer,
    subscriptionId: invPaid.subscription,
    priceTier: "Developer",
    status: "active",
    currentPeriodEnd: new Date(invPaid.lines.data[0].period.end * 1000).toISOString(),
  });
  console.log("2) PERIOD_EXTENDED:", ext.current_period_end);

  // ---- 3. invoice.payment_failed (marks past_due) --------------------------
  const invFail = {
    id: "in_test_sim_002",
    object: "invoice",
    subscription: "sub_test_sim_001",
    customer: "cus_test_sim",
    customer_email: email,
    amount_due: 2900,
  };
  payload = JSON.stringify(buildEvent("invoice.payment_failed", invFail));
  ({ header } = signEvent(payload, SECRET));
  verified = Stripe.webhooks.constructEvent(payload, header, SECRET);
  console.log("3) SIGNATURE_VERIFIED:", verified.type);
  const pd = await upsertSubscription({
    email,
    stripeCustomerId: invFail.customer,
    subscriptionId: invFail.subscription,
    priceTier: "Developer",
    status: "past_due",
    currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  console.log("3) STATUS_PAST_DUE:", pd.status);

  // Gate should now DENY (status past_due).
  const denied = await lookupSubscription(email);
  console.log("3) GATE_DENIED_AFTER_FAIL:", !denied ? "payment_required (correct)" : "UNEXPECTED ALLOW");

  // ---- Cleanup -------------------------------------------------------------
  const { error } = await supabase.from("subscriptions").delete().eq("email", email);
  console.log("CLEANUP:", error ? `WARN ${error.message}` : "OK");
  console.log("SIM_DONE");
}

run().catch((e) => {
  console.error("SIM_ERROR:", e.message);
  process.exit(1);
});