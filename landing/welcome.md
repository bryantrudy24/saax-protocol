# Welcome to SAAX Premium

**SAAX = Solvent Applied Autonomous Exchange Protocol**

If you are in a free trial, your access is active for 14 days from signup. You can cancel anytime before the trial ends to avoid being charged.

## You're subscribed

Your SAAX Premium subscription is active. Premium gates access to SAAX Router features as they ship. Not every listed feature is available today, and SAAX does not guarantee particular outcomes, SLAs, or compliance status. See the [terms](/terms) and [security](/security) pages for what is and is not guaranteed.

## How to connect

Connect your MCP client to:

```
https://www.saax-protocol.com/mcp
```

Add this URL to your MCP client's connector settings. The tools will be discovered automatically.

## How to authenticate

When you call a premium tool, pass your subscription email as the `subscriptionEmail` argument. The email you used at Stripe checkout is the one tied to your subscription. The email address is the subscription's access key — it is not proof of identity.

Example:

```json
{ "subscriptionEmail": "you@example.com" }
```

If the email is missing or doesn't match an active subscription, the tool returns a `payment_required` response.

## What's included

Premium features (as they ship):

- Evidence verification for high-value commitments
- Authority proof validation
- Enhanced supplier reputation data
- Priority routing in the SAAX Router
- Extended audit access

As a SAAX Premium subscriber, you can call:

- `get_evidence_verification` — verify external evidence against a commitment's acceptance criteria
- `get_authority_validation` — validate an authority proof against a commitment
- `list_commitments` — retrieve your commitment history by subscription email
- `get_commitment_status` — check the current lifecycle state of any commitment by ID

## Manage your subscription

Update your payment method, view invoices, or cancel anytime through the Stripe customer portal. Use the "Manage subscription" link in your checkout confirmation email, or contact support for a portal link.

## Questions?

For support, email [reachsaaxprotocol@gmail.com](mailto:reachsaaxprotocol@gmail.com).
