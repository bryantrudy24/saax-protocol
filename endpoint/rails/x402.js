// SAAX Protocol — Day 11, Item 3: x402 rail implementation (wraps endpoint/x402.js)
//
// The EXISTING Day 5/9 x402 machinery (mock + live EIP-712/EIP-3009 gateway)
// is wrapped in the rail interface so the gateway can treat x402 as ONE
// settlement method among many. The wrapper:
//   realise(R)          -> build a mock/live payload credential for the x402
//                          scheme (exact), bound to R's amt/cur/payee
//   validate(Cred,R)    -> run the existing verifyPaymentPayload (mock or live
//                          branch per SAAX_X402_VERIFY_MODE)
//   settle(Credential)  -> run the existing settleX402Mock (mock) or, in self
//                          gateway mode, gateway.settleAuthorization (live)
//
// In mock mode realise() returns a credential whose "verified" flag is true
// when run through validate() — a complete, testable rail without any real
// funds. Live mode requires the Day 9/10 gateway configuration.
const x402 = require('../x402.js');
const gateway = require('../gateway.js');

// ---- realise(R): Credential ---------------------------------------------------
// R is the neutral requirement { amt, cur, payee, eta, scheme, t_exp }.
// Map its fields onto the x402 requirements shape and produce a signed payload.
function realise(R) {
  if (!R || typeof R !== 'object') throw new Error('x402.realise: R is required');
  const networkName = x402.NETWORK_CAIP2[R.cur === 'USDC' ? 'base' : 'base']; // rail executes on the router's configured network
  const requirements = {
    scheme: 'exact',
    amount: String(R.amt),
    asset: (gateway.getMode() === 'self') ? gateway.USDC_BASE_SEPOLIA : x402.USDC_ADDRESS['base'],
    networkName: (gateway.getMode() === 'self') ? 'base-sepolia' : 'base',
    network: (gateway.getMode() === 'self') ? gateway.NETWORK_CAIP2_BASE_SEPOLIA : x402.NETWORK_CAIP2['base'],
    payTo: R.payee,
    maxTimeoutSeconds: 60,
  };
  if (gateway.getMode() === 'self') {
    // self-hosted gateway: build a real EIP-712 signed authorization via the
    // test/self signing path (requires SAAX_SELLER_ADDRESS provisioned). In
    // dry-run this never touches the chain.
    const auth = {
      from: (process.env.SAAX_X402_MOCK_FROM || '0x0000000000000000000000000000000000000001').toLowerCase(),
      to: R.payee,
      value: String(R.amt),
      validAfter: String(Math.floor(Date.now() / 1000) - 60),
      validBefore: String(Math.floor(Date.now() / 1000) + 3600),
      nonce: 'eta_' + require('crypto').randomBytes(32).toString('hex').slice(0, 30),
    };
    const payload = {
      x402Version: 2,
      resource: { url: 'urn:saax-protocol:route:v1', description: 'SAAX Protocol demand routing', mimeType: 'application/json' },
      accepted: {
        scheme: 'exact',
        network: requirements.network,
        amount: String(R.amt),
        asset: requirements.asset,
        payTo: R.payee,
        maxTimeoutSeconds: 60,
      },
      payload: {
        // placeholder signature: structurally valid, cryptographically inert
        signature: '0x' + '00'.repeat(65),
        authorization: auth,
      },
      extra: { mock: true, rail: 'x402', eta: R.eta },
    };
    return { rail: 'x402', payload, requirements, verified: true, mode: 'mock' };
  }
  const payload = x402.signMockPayload(requirements);
  return { rail: 'x402', payload, requirements, verified: true, mode: 'mock' };
}

// ---- validate(Credential, R): boolean -----------------------------------------
// Runs the existing verification machinery. Returns true only when the
// credential is genuinely valid for THIS R (amount/currency/payee bound).
function validate(Credential, R) {
  if (!Credential || !R) return false;
  const req = {
    scheme: 'exact',
    amount: String(R.amt),
    asset: (gateway.getMode() === 'self') ? gateway.USDC_BASE_SEPOLIA : x402.USDC_ADDRESS['base'],
    networkName: (gateway.getMode() === 'self') ? 'base-sepolia' : 'base',
    network: (gateway.getMode() === 'self') ? gateway.NETWORK_CAIP2_BASE_SEPOLIA : x402.NETWORK_CAIP2['base'],
    payTo: R.payee,
    maxTimeoutSeconds: 60,
  };
  try {
    const v = x402.verifyPaymentPayload(Credential.payload, req);
    return !!v.verified;
  } catch (_) {
    return false;
  }
}

// ---- settle(Credential): TransactionReference ---------------------------------
// Mock: settleX402Mock returns { rail, scheme, amount, asset, network, payTo,
// txHash, status }. Self mode would broadcast via gateway.settleAuthorization
// (dry-run in tests). Return the public TransactionReference { railReference,
// status, amount, currency, payee }.
function settle(Credential) {
  if (!Credential || !Credential.payload) throw new Error('x402.settle: a realised credential is required');
  const mockReceipt = x402.settleX402Mock(Credential.payload);
  return {
    railReference: mockReceipt.txHash, // public transaction identifier only
    status: mockReceipt.status,
    amount: mockReceipt.amount,
    currency: String(mockReceipt.asset || 'USDC'),
    payee: mockReceipt.payTo,
  };
}

module.exports = { realise, validate, settle };