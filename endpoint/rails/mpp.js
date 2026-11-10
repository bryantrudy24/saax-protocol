// SAAX Protocol — Day 12 (MPP sprint), Item 2: MPP rail implementation
//
// The Machine Payments Protocol rail, backed by the REAL mppx package
// (wevm/mppx 0.13.1), registered in the rail-agnostic registry with the
// standard interface:
//   realise(R): Credential            — emit an MPP challenge for requirement R
//   validate(Credential, R): boolean  — verify an Authorization: Payment
//                                        credential against R (pure crypto,
//                                        no RPC)
//   settle(Credential): TransactionReference — broadcast/settle the verified
//                                        credential; returns railReference
//
// Wire format (MPP):
//   challenge  -> WWW-Authenticate: Payment  (base64url JSON Challenge)
//   credential -> Authorization: Payment     (base64url JSON Credential)
//   receipt    -> Payment-Receipt            (base64url JSON Receipt)
//
// The mppx evm.charge() method is configured with:
//   - currency: USDC on Base Sepolia (eip155:84532)
//   - recipient: the COLD VAULT (SAAX_VAULT_ADDRESS) — Day 13 hot wallet +
//     cold vault architecture. The vault receives settled USDC; the signer
//     (hot wallet) broadcasts and pays gas.
//   - authorization domain: { name: 'USDC', version: '2' }
//   - settle: OUR custom settler — the exact same dual-path settlement the
//     Day 10 gateway uses (EIP-3009 transferWithAuthorization when the token
//     supports it, EIP-2612 permit + transferFrom otherwise). This bridges
//     mppx's native EIP-3009 expectation to the real testnet contract.
//
// The gateway creates ONE mppx instance (methods: [evmCharge]) and reuses it;
// this module holds a lazy singleton so the rail is usable from both the
// route server and the test harness without duplicate state.

'use strict';

const crypto = require('crypto');
const { keccak256, stringToHex, getAddress } = require('viem');
const { evm, Mppx } = require('mppx/server');

const gateway = require('../gateway.js');

const RAIL_NAME = 'mpp';
// Active chain/asset: follow the gateway's env-selected configuration
// (SAAX_CHAIN_ID / SAAX_X402_ASSET / SAAX_RPC_URL). The gateway exports the
// legacy names BASE_SEPOLIA_* / USDC_BASE_SEPOLIA aliased to the ACTIVE
// chain, so the MPP rail tracks the same .env switch (testnet <-> mainnet).
// Active chain/asset: follow the gateway's env-selected configuration
// (SAAX_CHAIN_ID / SAAX_X402_ASSET). The legacy BASE_SEPOLIA_* names are
// hardcoded to the testnet and MUST NOT be used for the live rail; the
// active aliases keep MPP consistent with the x402 challenge (mainnet).
const USDC_BASE_SEPOLIA = gateway.USDC_BASE_SEPOLIA || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ACTIVE_CHAIN_ID = gateway.ACTIVE_CHAIN_ID || gateway.BASE_SEPOLIA_CHAIN_ID || 84532;
const USDC_DECIMALS = 6;
const USDC_DOMAIN = { name: 'USDC', version: '2' };

// ---- internal state ---------------------------------------------------------
let _mppx = null;        // lazy singleton Mppx instance
let _method = null;      // the evm charge method descriptor
let _lastChallenge = null; // last challenge issued (for realise->validate continuity)

function secretKey() {
  // Deterministic dev secret derived from the environment, 32+ bytes.
  // Production MUST set MPP_SECRET_KEY explicitly (see .env.example).
  if (process.env.MPP_SECRET_KEY) return process.env.MPP_SECRET_KEY;
  const seed = process.env.SAAX_SELLER_PRIVATE_KEY || 'saax-protocol-dev-mpp-secret';
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function recipientAddress() {
  // Day 13 hot wallet + cold vault: the MPP rail pays the VAULT (cold
  // storage). Falls back to the seller (legacy single-wallet mode) only when
  // no vault is configured.
  const addr = gateway.getVaultAddress && gateway.getVaultAddress();
  if (addr) return addr;
  const seller = gateway.getSellerAddress && gateway.getSellerAddress();
  return seller || process.env.SAAX_SELLER_ADDRESS || '0x1111111111111111111111111111111111111111';
}

function rawToDisplay(rawAmount) {
  // mppx charge routes expect DISPLAY units (e.g. "0.05" for 50000 raw @ 6dp).
  const raw = BigInt(String(rawAmount));
  const dec = BigInt(10) ** BigInt(USDC_DECIMALS);
  const whole = raw / dec;
  const frac = raw % dec;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')}`;
}

function displayToRaw(displayAmount) {
  // Convert a display-unit amount string back to raw atomic units.
  const s = String(displayAmount);
  const [w, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return (BigInt(w || '0') * BigInt(10) ** BigInt(USDC_DECIMALS) + BigInt(frac || '0')).toString();
}

function challengeHashOf(challenge) {
  // EIP-3009 nonce for the Payment-auth EVM flow = keccak256([id, realm]).
  return keccak256(stringToHex(JSON.stringify([challenge.id, challenge.realm])));
}

// ---- mppx singleton ---------------------------------------------------------
function mppx() {
  if (_mppx) return _mppx;
  const settle = async ({ credential, payload, request }) => {
    // ---- Item 2: settle via the gateway's dual-path settlement --------------
    // Re-derive and re-check EVERY claimed value independently before
    // broadcasting. These checks mirror the mppx validate() checks as defense
    // in depth at the settlement boundary (the settle call can be reached
    // directly by a caller that skips validateCredential).
    const recipient = request.recipient;
    const amount = String(request.amount);
    const vault = recipientAddress();
    if (getAddress(payload.to) !== getAddress(recipient)) {
      throw new Error('MPP settle: recipient mismatch (payload.to != request.recipient)');
    }
    if (getAddress(recipient) !== getAddress(vault)) {
      throw new Error('MPP settle: recipient is not the configured vault wallet');
    }
    if (String(payload.value) !== amount) {
      throw new Error('MPP settle: amount mismatch (payload.value != request.amount)');
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(payload.validAfter) > now) {
      throw new Error('MPP settle: authorization is not valid yet');
    }
    if (BigInt(payload.validBefore) <= now) {
      throw new Error('MPP settle: authorization has expired');
    }
    // Nonce re-check: must equal the challenge binding.
    if (payload.nonce !== challengeHashOf(credential.challenge)) {
      throw new Error('MPP settle: nonce does not bind to the challenge');
    }
    // ---- dispatch to the gateway's settlement (dual-path) -------------------
    const txRef = await gateway.settleAuthorization(payload, payload.signature, {
      asset: USDC_BASE_SEPOLIA,
      chainId: ACTIVE_CHAIN_ID,
      recipient: recipient,
    });
    return {
      reference: typeof txRef === 'string' ? txRef
        : (txRef && (txRef.reference || txRef.txHash)) || String(txRef && txRef.transactionHash || (txRef && txRef.reference) || txRef),
      timestamp: new Date().toISOString(),
    };
  };

  _method = evm.charge({
    currency: USDC_BASE_SEPOLIA,
    chainId: ACTIVE_CHAIN_ID,
    decimals: USDC_DECIMALS,
    recipient: recipientAddress(),
    authorization: USDC_DOMAIN,
    settle,
  });
  _mppx = Mppx.create({ methods: [_method], secretKey: secretKey() });
  return _mppx;
}

// ---- Rail interface ---------------------------------------------------------

/**
 * realise(R): Credential
 * Emit an MPP challenge for the neutral requirement R.
 * R = { amt, cur, payee, eta, scheme, t_exp } (raw amt, USDC, seller).
 * Returns a challenge OBJECT (the server presents it via WWW-Authenticate:
 * Payment). Also stashes the challenge so validate() can assert the credential
 * binds to the issued challenge (challenge-id continuity).
 */
async function realise(R) {
  if (!R || typeof R !== 'object') throw new Error('mpp.realise: R is required');
  const amt = R.amt !== undefined ? R.amt : R.amount;
  if (amt === undefined) throw new Error('mpp.realise: R.amt is required');
  const display = rawToDisplay(amt);
  const challenge = await mppx().challenge.evm.charge({
    amount: display,
    description: 'SAAX Protocol routing fee',
    externalId: R.commitmentId || undefined,
  });
  _lastChallenge = challenge;
  return challenge;
}

/**
 * validate(Credential, R): boolean
 * Verify an MPP credential (Authorization: Payment base64url JSON) against R.
 * - Parses the credential structure
 * - Re-derives the challenge hash (nonce) from the echoed challenge
 * - Re-checks: recipient == R.payee, amount == R.amt, validAfter/Before window,
 *   signature via EIP-712 recovery (viem, pure crypto, no RPC)
 * - Optionally asserts the echoed challenge is the one we issued (when
 *   _lastChallenge is set and the credential came through our realise())
 *
 * Returns boolean (rail interface). Throws on structurally malformed input.
 */
async function validate(Credential, R) {
  if (!Credential || typeof Credential !== 'object') throw new Error('mpp.validate: credential required');
  const challenge = Credential.challenge;
  const payload = Credential.payload;
  if (!challenge || !payload) throw new Error('mpp.validate: credential missing challenge/payload');
  if (challenge.method !== 'evm' || challenge.intent !== 'charge') {
    throw new Error('mpp.validate: credential is not an evm/charge MPP credential');
  }
  if (payload.type !== 'authorization') {
    throw new Error('mpp.validate: credential payload type must be "authorization"');
  }
  // Continuity: if we issued a challenge through realise(), the credential must
  // echo it (guards against a credential built against a different challenge).
  if (_lastChallenge && challenge.id !== _lastChallenge.id) {
    throw new Error('mpp.validate: challenge id does not match the issued challenge');
  }
  // Nonce binding re-derivation (Item 2: re-derive every claimed value).
  const expectedNonce = challengeHashOf(challenge);
  if (payload.nonce !== expectedNonce) {
    // allowed: some clients sign with a raw 32-byte hex; verify the hash binds
    throw new Error('mpp.validate: nonce does not bind to the challenge');
  }
  // Run mppx's own verifyCredential/validateCredential (Item 2 requirement).
  try {
    const validation = await mppx().validateCredential(Credential, {
      request: { amount: rawToDisplay(R && R.amt !== undefined ? R.amt : R.amount) },
    });
    // Cross-check R: payee must match the credential's recipient.
    if (R && R.payee) {
      const rec = (validation.challenge && validation.challenge.request && validation.challenge.request.recipient) || '';
      if (getAddress(rec) !== getAddress(R.payee)) {
        throw new Error('mpp.validate: recipient does not match R.payee');
      }
    }
    return true;
  } catch (e) {
    if (e && e.message && /not valid yet|expired|mismatch|signature/i.test(e.message)) {
      return false; // verification failed: invalid credential
    }
    throw e;
  }
}

/**
 * settle(Credential): TransactionReference
 * Broadcast/settle the verified credential via mppx.broadcastCredential (which
 * calls our custom settler => gateway dual-path settlement), then return the
 * rail reference. The receipt binds the commitment to this reference.
 */
async function settle(Credential) {
  if (!Credential || typeof Credential !== 'object') throw new Error('mpp.settle: credential required');
  const receipt = await mppx().broadcastCredential(Credential, {
    request: { amount: rawToDisplay(BigInt(Credential.payload && Credential.payload.value) || 0n) },
  });
  if (!receipt || receipt.status !== 'success') {
    throw new Error('mpp.settle: broadcast did not succeed: ' + (receipt && receipt.status));
  }
  return receipt.reference;
}

/**
 * emitChallengeHeader(challenge): string
 * Serialize a challenge for the WWW-Authenticate: Payment header.
 * MPP wire: base64url JSON challenge object prefixed by auth scheme.
 */
function emitChallengeHeader(challenge) {
  // Standard MPP challenge header: `Payment <base64url JSON challenge>`.
  const wire = Buffer.from(JSON.stringify(challenge)).toString('base64url');
  return 'Payment ' + wire;
}

/**
 * parseCredentialHeader(headerValue): Credential|null
 * Parse an Authorization: Payment header value into a credential object.
 * Returns null when the header is not a Payment credential.
 */
function parseCredentialHeader(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (trimmed.toLowerCase().startsWith('payment ')) {
    const b64 = trimmed.slice('payment '.length).trim();
    try {
      return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    } catch (e) {
      return null; // malformed
    }
  }
  return null;
}

/**
 * buildReceiptHeader(receipt): string
 * Serialize a receipt for the Payment-Receipt header: base64url JSON.
 */
function buildReceiptHeader(receipt) {
  return Buffer.from(JSON.stringify(receipt)).toString('base64url');
}

module.exports = {
  realise,
  validate,
  settle,
  emitChallengeHeader,
  parseCredentialHeader,
  buildReceiptHeader,
  rawToDisplay,
  displayToRaw,
  challengeHashOf,
  // test hooks
  _resetForTest() { _mppx = null; _method = null; _lastChallenge = null; },
  __getMppx: mppx,
};