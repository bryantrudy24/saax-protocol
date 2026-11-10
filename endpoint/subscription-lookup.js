// SAAX Protocol — buyer subscription lookup adapter (CJS).
//
// Resolves an ACTIVE subscription for a buyer email via the public
// lookup_subscription RPC — the SAME RPC the premium gating (api/mcp.mjs)
// uses. Consumed by endpoint/route-server.js to capture buyer identity at
// commitment issuance (the optional `subscriptionEmail` body field).
//
// Design notes:
//  - Mirrors endpoint/commitment-store.js's PostgREST client pattern
//    (SUPABASE_URL + anon key). The subscription RPCs live in the PUBLIC
//    schema (unlike the ax_router commitment RPCs), so no Accept-Profile /
//    Content-Profile override is applied.
//  - The RPC filters: email match AND status='active' AND
//    current_period_end > now(). A row => active subscription; no row => none.
//  - Read-only: this module never writes. Lookup failure THROWS so the caller
//    can fail closed rather than issue a commitment under an unverified
//    identity.
const STORE_BASE_URL = (process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || '').trim();
const STORE_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SAAX_SUPABASE_KEY ||
  '';

// Minimal PostgREST client (same shape commitment-store.js builds).
function buildClient() {
  const base = String(STORE_BASE_URL).trim().replace(/\/+$/, '');
  const isPlatform = /supabase\.co/i.test(base);
  const PREFIX = isPlatform ? '/rest/v1' : '';
  const headers = {
    apikey: STORE_KEY,
    Authorization: 'Bearer ' + STORE_KEY,
    'Content-Type': 'application/json',
  };
  return {
    async rpc(fn, params) {
      const res = await fetch(base + PREFIX + '/rpc/' + fn, {
        method: 'POST',
        headers,
        body: JSON.stringify(params || {}),
      });
      if (res.status >= 400) {
        const txt = (await res.text()).slice(0, 300);
        return { data: null, error: new Error('RPC ' + fn + ' -> ' + res.status + ' ' + txt) };
      }
      const body = await res.json();
      return { data: body, error: null };
    },
  };
}

function isConfigured() {
  return !!(STORE_BASE_URL && STORE_KEY);
}

/**
 * Resolve the active subscription for an email.
 * @param {string} email
 * @returns {Promise<object|null>} the active subscription row, or null.
 * @throws {Error} on lookup failure / missing configuration (caller fails closed).
 */
async function lookupActiveSubscription(email) {
  if (!isConfigured()) {
    throw new Error('subscription lookup skipped: SUPABASE_URL/SUPABASE_ANON_KEY not configured');
  }
  const client = buildClient();
  const { data, error } = await client.rpc('lookup_subscription', { p_email: email });
  if (error) throw error;
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

module.exports = { lookupActiveSubscription, isConfigured };
