// SAAX Premium welcome email — transactional send via Resend.
// Fired ASYNC after checkout.session.completed; never blocks the webhook 200.

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

// Customer portal URL (Stripe hosted, live session verified in Phase 4).
const PORTAL_URL =
  "https://billing.stripe.com/p/session?secret=live_YWNjdF8xVU5uNjFBV2dnUkxRYzdjLF9WT2p3VkRNaUE4WjloTjhSVVRVRXpXeW8zS0dOSjFJ0100qCj0Xyr2";

const MCP_URL = "https://www.saax-protocol.com/mcp";
const DOCS_URL = "https://saax-protocol.com/docs";
const SPEC_URL = "https://saax-protocol.com/spec";
const CONFORMANCE_URL = "https://saax-protocol.com/conformance";
const SUPPORT_EMAIL = "reachsaaxprotocol@gmail.com";

export function buildWelcomeEmail({ email, tier, price, periodEnd }) {
  const priceLabel = tier === "Business" ? "$199" : "$29";
  const nextBilling = periodEnd
    ? new Date(periodEnd).toISOString().slice(0, 10)
    : "your next billing date";

  const text = [
    "Hi,",
    "",
    "Thanks for subscribing to SAAX Premium. Your subscription is active.",
    "",
    "Your subscription:",
    `Tier: ${tier}`,
    `Price: ${priceLabel} / month`,
    `Next billing date: ${nextBilling}`,
    "",
    "How to connect:",
    "SAAX Premium unlocks the trust and enforcement layer of the SAAX Protocol. Connect your MCP client to:",
    MCP_URL,
    "",
    "When you call a premium tool like get_evidence_verification or get_authority_validation, pass your subscription email as the subscriptionEmail argument. That's how the gate identifies you:",
    "",
    `{ "subscriptionEmail": "${email}" }`,
    "",
    "The email you used at checkout is the one tied to your subscription. Use it exactly as written.",
    "",
    "Resources:",
    `Integration guide: ${DOCS_URL}`,
    `Protocol spec: ${SPEC_URL}`,
    `Conformance suite: ${CONFORMANCE_URL}`,
    "",
    "Manage your subscription:",
    "Update your payment method, view invoices, or cancel anytime at:",
    PORTAL_URL,
    "",
    `Questions? Reply to this email or contact ${SUPPORT_EMAIL}.`,
    "",
    "- SAAX Protocol",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.6;max-width:600px;margin:0 auto;padding:24px">
<h2 style="margin-bottom:4px">Welcome to SAAX Premium</h2>
<p style="margin-top:0;color:#555">Hi,</p>
<p>Thanks for subscribing to SAAX Premium. Your subscription is active.</p>
<h3 style="margin-bottom:4px">Your subscription</h3>
<table cellpadding="0" cellspacing="0" style="font-size:14px;color:#333">
<tr><td style="padding:2px 16px 2px 0">Tier</td><td><strong>${tier}</strong></td></tr>
<tr><td style="padding:2px 16px 2px 0">Price</td><td><strong>${priceLabel} / month</strong></td></tr>
<tr><td style="padding:2px 16px 2px 0">Next billing date</td><td><strong>${nextBilling}</strong></td></tr>
</table>
<h3>How to connect</h3>
<p>SAAX Premium unlocks the trust and enforcement layer of the SAAX Protocol. Connect your MCP client to:</p>
<p><code style="background:#f4f4f4;padding:2px 6px;border-radius:4px">${MCP_URL}</code></p>
<p>When you call a premium tool like <code>get_evidence_verification</code> or <code>get_authority_validation</code>, pass your subscription email as the <code>subscriptionEmail</code> argument — that's how the gate identifies you:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:13px">{ "subscriptionEmail": "${email}" }</pre>
<p>The email you used at checkout is the one tied to your subscription. Use it exactly as written.</p>
<h3>Resources</h3>
<ul>
<li><a href="${DOCS_URL}">Integration guide</a></li>
<li><a href="${SPEC_URL}">Protocol spec</a></li>
<li><a href="${CONFORMANCE_URL}">Conformance suite</a></li>
</ul>
<h3>Manage your subscription</h3>
<p>Update your payment method, view invoices, or cancel anytime: <a href="${PORTAL_URL}">customer portal</a>.</p>
<p>Questions? Reply to this email or contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
<p style="margin-top:32px;color:#888;font-size:12px">- SAAX Protocol</p>
</body></html>`;

  return {
    from: "SAAX Protocol <onboarding@saax-protocol.com>",
    to: [email],
    subject: "Welcome to SAAX Premium",
    html,
    text,
  };
}

export async function sendWelcomeEmail({ email, tier, price, periodEnd }) {
  if (!RESEND_API_KEY) {
    console.log("[welcome-email] RESEND_API_KEY not set; skipping send for", email);
    return { ok: false, skipped: "missing_resend_key" };
  }
  const msg = buildWelcomeEmail({ email, tier, price, periodEnd });
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[welcome-email] Resend error", res.status, JSON.stringify(data));
      return { ok: false, status: res.status, error: data };
    }
    console.log("[welcome-email] sent OK to", email, "tier", tier, "id", data.id);
    return { ok: true, id: data.id };
  } catch (err) {
    console.error("[welcome-email] send exception", err.message);
    return { ok: false, error: err.message };
  }
}