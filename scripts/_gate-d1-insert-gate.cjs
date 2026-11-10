// Gate D.1 — one-shot insertion of the pilot-limits enforcement gate into
// endpoint/route-server.js. Idempotent: refuses to insert twice.
'use strict';
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'endpoint', 'route-server.js');
let src = fs.readFileSync(target, 'utf8');

const MARKER = 'GATE D.1: INTERNAL-BETA FINANCIAL LIMITS';
if (src.includes(MARKER)) {
  console.log('ALREADY PRESENT — no change');
  process.exit(0);
}

// The repository checks out with CRLF line endings on Windows; match the file
// as it actually is rather than assuming LF.
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const anchor = [
  "    gateway.setNonce(authNonce, 'pending');",
  '  }',
  '',
  '  // Valid payment: run the ranking engine (demand text already sanitized).',
].join(EOL);
if (!src.includes(anchor)) {
  console.error('ANCHOR NOT FOUND');
  process.exit(1);
}

const block = `    gateway.setNonce(authNonce, 'pending');
  }

  // ---- GATE D.1: INTERNAL-BETA FINANCIAL LIMITS ----------------------------
  // Placement is deliberate: AFTER the idempotency gate (an identical retry
  // replays the cached response and never reaches here), AFTER payment
  // verification (the payer identity is cryptographically established, not
  // caller-asserted), and BEFORE any settlement or broadcast. A rejected quota
  // therefore authorizes nothing and moves no funds.
  //
  // The wallet is the VERIFIED payer recovered from the payment authorization —
  // never a header or body field. When enforcement is off (the default) this
  // block is a no-op and existing behavior is unchanged.
  let pilotReservation = null;
  if (pilotLimits.isEnforcing()) {
    const authz = (paymentPayload && paymentPayload.payload && paymentPayload.payload.authorization) || {};
    const verifiedPayer = authz.from ? String(authz.from).toLowerCase() : null;
    const pilotAsset = SELF_MODE ? gateway.USDC_BASE_SEPOLIA : x402.USDC_ADDRESS[MOCK_NETWORK];
    const pilotChainId = SELF_MODE
      ? Number(process.env.SAAX_CHAIN_ID || 84532)
      : (MOCK_NETWORK === 'base' ? 8453 : 137);
    const pilotRecipient = authz.to ? String(authz.to) : (gateway.getOperativePayee() || MOCK_PAYTO);
    const pilotAmount = authz.value ? String(authz.value) : String(x402.rawUnits(ROUTING_FEE_USD));

    const quota = await pilotLimits.evaluate({
      idempotencyKey: idemKeyNow,
      wallet: verifiedPayer,
      chainId: pilotChainId,
      asset: pilotAsset,
      amountUnits: pilotAmount,
      recipient: pilotRecipient,
      commitmentId: commitmentFlowCtx ? commitmentFlowCtx.manifest.commitmentId : null,
    });

    if (!quota.ok) {
      // FAIL CLOSED. No payment challenge is presented, nothing is broadcast,
      // and the idempotency key is released as failed so a legitimate retry
      // after the operator resolves the condition is not stuck at 409.
      if (idemKeyNow && idem.fresh) {
        try { await idempotency.markFailed(idemKeyNow, 403, JSON.stringify({ error: 'pilot_limit_rejected', reason: quota.reason })); } catch (_) {}
      }
      log.push('PILOT LIMITS: rejected (' + quota.reason + ') -> 403, no payment authorized');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'pilot_limit_rejected',
        reason: quota.reason,
        retryable: quota.reason === 'limit_store_unavailable',
        ...(quota.detail ? { detail: quota.detail } : {}),
      }));
      return;
    }
    pilotReservation = quota.reservationId || null;
    log.push('PILOT LIMITS: ' + quota.reason + ' reservation=' + pilotReservation);
  }

  // Valid payment: run the ranking engine (demand text already sanitized).`;

// Normalize the block to the file's own line endings before inserting.
const blockEol = block.split('\n').join(EOL);
src = src.replace(anchor, blockEol);
fs.writeFileSync(target, src, 'utf8');
console.log('INSERTED — ' + src.length + ' bytes');
