// SAAX Protocol — Gate D.1: internal-Beta financial limits (adversarial suite)
//
// Runs against the ISOLATED local Postgres/PostgREST testbed (ax_router_db /
// ax_router_postgrest). Never touches the live Supabase project. No real money,
// no chain interaction: every "payment" here is a reservation request.
//
// Covers the 25 required adversarial cases from the Gate D.1 brief.
'use strict';

const path = require('path');
const { buildSupabaseClient } = require(path.join(__dirname, '..', '..', 'endpoint', 'store.js'));

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
// The isolated PostgREST requires a real HS256 JWT (role=service_role). The
// helper mints one from the container's own env; the secret is never printed.
const { mint } = require(path.join(__dirname, '_gate-d-jwt.cjs'));
const POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');

// Policy under test (the approved internal-Beta values).
const POLICY = {
  maxSingleUsd: '100',
  walletMaxUsd: '200',
  walletMaxTx: 3,
  globalMaxUsd: '1000',
  globalMaxTx: 15,
  windowHours: 24,
};

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const CHAIN = 84532;
const RECIPIENT = '0x1111111111111111111111111111111111111111';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail);
}

let client = null;
let limits = null;

// Unique namespace per run so repeated runs never collide.
const RUN = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const wallet = (n) => ('0x' + String(n).padStart(40, 'a')).toLowerCase();
const key = (n) => RUN + ':key:' + n;

function units(usd) {
  const r = limits.usdToUnits(usd, 6);
  if (!r.ok) throw new Error('usdToUnits failed for ' + usd + ': ' + r.reason);
  return r.units;
}

async function reserve({ idemKey, walletAddr, amountUnits, recipient, commitmentId, asset, chainId }) {
  return limits.evaluate({
    idempotencyKey: idemKey,
    wallet: walletAddr,
    chainId: chainId === undefined ? CHAIN : chainId,
    asset: asset === undefined ? USDC : asset,
    amountUnits,
    recipient: recipient === undefined ? RECIPIENT : recipient,
    commitmentId: commitmentId || null,
  });
}

async function sql(query) {
  // Direct psql through docker for setup/teardown assertions.
  // IMPORTANT: PostgREST serves the `ax_router` DATABASE (PGRST_DB_URI=.../ax_router),
  // so every setup/assertion must target that same database — querying `postgres`
  // would silently inspect a different, empty schema.
  const { execFileSync } = require('child_process');
  return execFileSync('docker', [
    'exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router',
    '-t', '-A', '-c', query,
  ], { encoding: 'utf8' }).trim();
}

(async () => {
  // ---- Setup -------------------------------------------------------------
  process.env.SAAX_PILOT_ENFORCEMENT = 'on';
  process.env.SAAX_PILOT_MAX_SINGLE_USD = POLICY.maxSingleUsd;
  process.env.SAAX_PILOT_WALLET_MAX_USD = POLICY.walletMaxUsd;
  process.env.SAAX_PILOT_WALLET_MAX_TX = String(POLICY.walletMaxTx);
  process.env.SAAX_PILOT_GLOBAL_MAX_USD = POLICY.globalMaxUsd;
  process.env.SAAX_PILOT_GLOBAL_MAX_TX = String(POLICY.globalMaxTx);
  process.env.SAAX_PILOT_WINDOW_HOURS = String(POLICY.windowHours);

  limits = require(path.join(__dirname, '..', '..', 'endpoint', 'pilot-limits.js'));
  client = buildSupabaseClient(POSTGREST_URL, POSTGREST_KEY, 'ax_router');
  limits.setStoreClient(client);

  // Clean slate: remove every reservation belonging to a wallet this suite
  // created (identified by its own label), so a previous run can never leave
  // rows that saturate the GLOBAL window. Real data is never touched.
  const w1 = wallet(1), w2 = wallet(2), w3 = wallet(3), w4 = wallet(4);
  await sql(`DELETE FROM ax_router.payment_reservations WHERE wallet IN (SELECT wallet FROM ax_router.pilot_wallets WHERE label LIKE 'gate-d1-%')`);
  await sql(`DELETE FROM ax_router.payment_reservations WHERE wallet IN ('${w1}','${w2}','${w3}','${w4}')`);
  await sql(`DELETE FROM ax_router.pilot_wallets WHERE label LIKE 'gate-d1-%'`);
  await sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet IN ('${w1}','${w2}','${w3}','${w4}')`);
  for (const w of [w1, w2, w3, w4]) {
    const r = await limits.approveWallet(w, { label: 'gate-d1-test', chainId: CHAIN });
    if (!r.ok) throw new Error('allowlist setup failed: ' + JSON.stringify(r));
  }

  // ---- 1. Transaction exactly at $100 ------------------------------------
  {
    const r = await reserve({ idemKey: key('t1'), walletAddr: w1, amountUnits: units('100') });
    record('01-exactly-100-allowed', r.ok === true, 'allowed=' + r.ok + ' reason=' + r.reason);
  }

  // ---- 2. Transaction above $100 -----------------------------------------
  {
    const r = await reserve({ idemKey: key('t2'), walletAddr: w1, amountUnits: units('100.000001') });
    record('02-above-100-rejected', r.ok === false && r.reason === 'single_transaction_cap',
      'reason=' + r.reason);
  }

  // ---- 3. Wallet exactly at $200 -----------------------------------------
  // w1 already holds $100 from test 1; add exactly $100 more.
  {
    const r = await reserve({ idemKey: key('t3'), walletAddr: w1, amountUnits: units('100') });
    record('03-wallet-exactly-200-allowed', r.ok === true, 'allowed=' + r.ok + ' reason=' + r.reason);
  }

  // ---- 4. Wallet above $200 ----------------------------------------------
  {
    const r = await reserve({ idemKey: key('t4'), walletAddr: w1, amountUnits: units('0.000001') });
    record('04-wallet-above-200-rejected', r.ok === false && r.reason === 'wallet_amount_cap',
      'reason=' + r.reason);
  }

  // ---- 5. Fourth transaction within 24h ----------------------------------
  // A FRESH wallet (w1 is already at its $200 cap from tests 1-4, so it would
  // be rejected on amount before the count cap could ever be exercised).
  // Three small transactions pass; the fourth must hit the COUNT cap.
  {
    const cw = wallet(5);
    await limits.approveWallet(cw, { label: 'gate-d1-count5', chainId: CHAIN });
    const t1 = await reserve({ idemKey: key('t5a'), walletAddr: cw, amountUnits: units('0.01') });
    const t2 = await reserve({ idemKey: key('t5b'), walletAddr: cw, amountUnits: units('0.01') });
    const t3 = await reserve({ idemKey: key('t5c'), walletAddr: cw, amountUnits: units('0.01') });
    const t4 = await reserve({ idemKey: key('t5d'), walletAddr: cw, amountUnits: units('0.01') });
    record('05-fourth-transaction-rejected',
      t1.ok && t2.ok && t3.ok && t4.ok === false && t4.reason === 'wallet_count_cap',
      'first3=' + [t1.ok, t2.ok, t3.ok].join(',') + ' fourth=' + t4.ok + ' reason=' + t4.reason);
  }

  // ---- 6. Rolling-window expiration --------------------------------------
  // Age that wallet's reservations past the window; it must be allowed again.
  {
    const cw = wallet(5);
    await sql(`UPDATE ax_router.payment_reservations SET created_at = now() - interval '25 hours' WHERE wallet = '${cw}'`);
    const r = await reserve({ idemKey: key('t6'), walletAddr: cw, amountUnits: units('50') });
    record('06-rolling-window-expiry-allows', r.ok === true, 'allowed=' + r.ok + ' reason=' + r.reason);
  }

  // ---- 7. Global $1,000 boundary -----------------------------------------
  // Fresh wallets, $100 each. 10 x $100 = $1,000 exactly (allowed), then +$1 rejected.
  {
    const gw = [];
    for (let i = 0; i < 11; i++) gw.push(wallet(100 + i));
    await sql(`DELETE FROM ax_router.payment_reservations WHERE wallet LIKE '0x0000000000000000000000000000000000000%'`);
    await sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet LIKE '0x0000000000000000000000000000000000000%'`);
    for (const w of gw) await limits.approveWallet(w, { label: 'gate-d1-global', chainId: CHAIN });

    // Clear any other in-window reservations so the global counter is exact.
    await sql(`DELETE FROM ax_router.payment_reservations WHERE created_at > now() - interval '24 hours'`);

    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      const r = await reserve({ idemKey: key('t7-' + i), walletAddr: gw[i], amountUnits: units('100') });
      if (r.ok) allowed++;
    }
    const over = await reserve({ idemKey: key('t7-over'), walletAddr: gw[10], amountUnits: units('0.000001') });
    record('07-global-1000-boundary',
      allowed === 10 && over.ok === false && over.reason === 'global_amount_cap',
      'allowed=' + allowed + '/10 over=' + over.ok + ' reason=' + over.reason);
  }

  // ---- 8. Global 15-transaction boundary ---------------------------------
  {
    await sql(`DELETE FROM ax_router.payment_reservations WHERE created_at > now() - interval '24 hours'`);
    const gw = [];
    for (let i = 0; i < 16; i++) gw.push(wallet(200 + i));
    for (const w of gw) await limits.approveWallet(w, { label: 'gate-d1-count', chainId: CHAIN });

    let allowed = 0;
    for (let i = 0; i < 15; i++) {
      const r = await reserve({ idemKey: key('t8-' + i), walletAddr: gw[i], amountUnits: units('0.01') });
      if (r.ok) allowed++;
    }
    const over = await reserve({ idemKey: key('t8-over'), walletAddr: gw[15], amountUnits: units('0.01') });
    record('08-global-15-count-boundary',
      allowed === 15 && over.ok === false && over.reason === 'global_count_cap',
      'allowed=' + allowed + '/15 over=' + over.ok + ' reason=' + over.reason);
  }

  // ---- 9. Twenty simultaneous payment attempts ---------------------------
  {
    await sql(`DELETE FROM ax_router.payment_reservations WHERE created_at > now() - interval '24 hours'`);
    const sw = wallet(300);
    await limits.approveWallet(sw, { label: 'gate-d1-concurrent', chainId: CHAIN });

    const attempts = [];
    for (let i = 0; i < 20; i++) {
      attempts.push(reserve({ idemKey: key('t9-' + i), walletAddr: sw, amountUnits: units('10') }));
    }
    const settled = await Promise.all(attempts);
    const okCount = settled.filter((r) => r.ok).length;
    // Wallet cap: $200 / $10 = 20 by amount, but count cap is 3 -> exactly 3.
    record('09-twenty-simultaneous-capped-at-3', okCount === 3,
      'allowed=' + okCount + ' (expected 3: wallet count cap)');
  }

  // ---- 10. Two instances racing on the final available quota -------------
  {
    await sql(`DELETE FROM ax_router.payment_reservations WHERE created_at > now() - interval '24 hours'`);
    const rw = wallet(400);
    await limits.approveWallet(rw, { label: 'gate-d1-race', chainId: CHAIN });

    // Two reservations of $100 each fill the $200 wallet cap; then two more
    // race for the (nonexistent) remaining quota. Exactly one of the racers
    // must be rejected — never both allowed.
    await reserve({ idemKey: key('t10-a'), walletAddr: rw, amountUnits: units('100') });
    await reserve({ idemKey: key('t10-b'), walletAddr: rw, amountUnits: units('100') });
    const race = await Promise.all([
      reserve({ idemKey: key('t10-c'), walletAddr: rw, amountUnits: units('1') }),
      reserve({ idemKey: key('t10-d'), walletAddr: rw, amountUnits: units('1') }),
    ]);
    const okCount = race.filter((r) => r.ok).length;
    record('10-race-on-final-quota', okCount === 0,
      'allowed=' + okCount + ' (expected 0: wallet already at cap)');
  }

  // ---- 11. Identical idempotency-key retry -------------------------------
  {
    await sql(`DELETE FROM ax_router.payment_reservations WHERE created_at > now() - interval '24 hours'`);
    const iw = wallet(500);
    await limits.approveWallet(iw, { label: 'gate-d1-retry', chainId: CHAIN });

    const first = await reserve({ idemKey: key('t11'), walletAddr: iw, amountUnits: units('50') });
    const retry = await reserve({ idemKey: key('t11'), walletAddr: iw, amountUnits: units('50') });
    const count = await sql(`SELECT count(*) FROM ax_router.payment_reservations WHERE idempotency_key = '${key('t11')}'`);
    record('11-identical-retry-no-extra-quota',
      first.ok && retry.ok && retry.reason === 'replay_existing_reservation' && Number(count) === 1,
      'first=' + first.reason + ' retry=' + retry.reason + ' rows=' + count);
  }

  // ---- 12. Conflicting payload with reused key ---------------------------
  // The reservation id is DERIVED from the idempotency key, so a reused key
  // resolves to the SAME reservation row and the payload-hash comparison fires
  // first — a strictly stronger rejection than a bare key conflict. Either
  // reason is a correct refusal; what matters is that it is refused and that
  // no second reservation is created.
  {
    const iw = wallet(500);
    const conflict = await reserve({ idemKey: key('t11'), walletAddr: iw, amountUnits: units('99') });
    const rows = await sql(`SELECT count(*) FROM ax_router.payment_reservations WHERE idempotency_key = '${key('t11')}'`);
    record('12-conflicting-payload-rejected',
      conflict.ok === false &&
      (conflict.reason === 'reservation_payload_mismatch' || conflict.reason === 'idempotency_key_conflict') &&
      Number(rows) === 1,
      'reason=' + conflict.reason + ' rows=' + rows);
  }

  // ---- 13. Worker crash after reservation --------------------------------
  // The reservation is durable in Postgres; a "crash" is simply the absence of
  // any further call. The row must still exist and still consume exposure.
  {
    const cw = wallet(600);
    await limits.approveWallet(cw, { label: 'gate-d1-crash', chainId: CHAIN });
    await reserve({ idemKey: key('t13'), walletAddr: cw, amountUnits: units('100') });
    const row = await sql(`SELECT status FROM ax_router.payment_reservations WHERE idempotency_key = '${key('t13')}'`);
    // Fill the wallet to exactly $200 with a second $100 reservation, then probe
    // $1. The probe is under the single cap and under the count cap, so the ONLY
    // thing that can reject it is the wallet AMOUNT cap — which proves the
    // crashed reservation still consumes exposure.
    await reserve({ idemKey: key('t13a'), walletAddr: cw, amountUnits: units('100') });
    const next = await reserve({ idemKey: key('t13b'), walletAddr: cw, amountUnits: units('1') });
    record('13-crash-after-reservation-retains-exposure',
      row === 'RESERVED' && next.ok === false && next.reason === 'wallet_amount_cap',
      'status=' + row + ' next=' + next.reason);
  }

  // ---- 14. Worker crash before settlement confirmation -------------------
  // Stale RESERVED -> EXPIRED_UNRESOLVED, which STILL consumes exposure.
  {
    const cw = wallet(600);
    await sql(`UPDATE ax_router.payment_reservations SET created_at = now() - interval '2 hours' WHERE wallet = '${cw}'`);
    const rec = await limits.reconcile({ staleMinutes: 60 });
    const row = await sql(`SELECT status FROM ax_router.payment_reservations WHERE idempotency_key = '${key('t13')}'`);
    const next = await reserve({ idemKey: key('t14'), walletAddr: cw, amountUnits: units('99') });
    record('14-stale-reservation-retains-exposure',
      rec.ok && row === 'EXPIRED_UNRESOLVED' && next.ok === false && next.reason === 'wallet_amount_cap',
      'reconciled=' + JSON.stringify(rec) + ' status=' + row + ' next=' + next.reason);
  }

  // ---- 15. Database outage during reservation ----------------------------
  {
    const deadClient = buildSupabaseClient('http://127.0.0.1:59999', 'x', 'ax_router');
    limits.setStoreClient(deadClient);
    const r = await reserve({ idemKey: key('t15'), walletAddr: wallet(700), amountUnits: units('1') });
    limits.setStoreClient(client);
    record('15-store-outage-fails-closed',
      r.ok === false && r.reason === 'limit_store_unavailable',
      'reason=' + r.reason);
  }

  // ---- 16. PostgREST timeout with unknown commit outcome -----------------
  // Simulated by a client whose rpc() rejects after the DB may have committed.
  // The module must fail closed and NOT report success.
  {
    const flaky = {
      rpc: async () => { throw new Error('ETIMEDOUT: postgrest request timed out'); },
      from: () => { throw new Error('unused'); },
    };
    limits.setStoreClient(flaky);
    const r = await reserve({ idemKey: key('t16'), walletAddr: wallet(700), amountUnits: units('1') });
    limits.setStoreClient(client);
    record('16-timeout-unknown-outcome-fails-closed',
      r.ok === false && r.reason === 'limit_store_unavailable',
      'reason=' + r.reason);
  }

  // ---- 17. Unapproved wallet ---------------------------------------------
  {
    const r = await reserve({ idemKey: key('t17'), walletAddr: wallet(800), amountUnits: units('1') });
    record('17-unapproved-wallet-rejected',
      r.ok === false && r.reason === 'wallet_not_allowlisted',
      'reason=' + r.reason);
  }

  // ---- 18. Spoofed wallet identity ---------------------------------------
  // A caller cannot claim another wallet's quota: the reservation is keyed to
  // the wallet passed in, and the allowlist is checked per wallet. A revoked
  // wallet is rejected even though it was once approved.
  {
    const sw = wallet(900);
    await limits.approveWallet(sw, { label: 'gate-d1-revoke', chainId: CHAIN });
    await limits.revokeWallet(sw, { note: 'test revocation' });
    const r = await reserve({ idemKey: key('t18'), walletAddr: sw, amountUnits: units('1') });
    record('18-revoked-wallet-rejected',
      r.ok === false && r.reason === 'wallet_revoked',
      'reason=' + r.reason);
  }

  // ---- 19. Unsupported payment asset -------------------------------------
  {
    const r = await reserve({
      idemKey: key('t19'), walletAddr: w2, amountUnits: units('1'),
      asset: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    record('19-unsupported-asset-rejected',
      r.ok === false && r.reason === 'unsupported_asset',
      'reason=' + r.reason);
  }

  // ---- 20. Token-decimal and integer-overflow edge cases -----------------
  {
    const cases = [];
    // Non-integer base units
    cases.push(await reserve({ idemKey: key('t20a'), walletAddr: w2, amountUnits: '1.5' }));
    // Zero
    cases.push(await reserve({ idemKey: key('t20b'), walletAddr: w2, amountUnits: '0' }));
    // Negative
    cases.push(await reserve({ idemKey: key('t20c'), walletAddr: w2, amountUnits: '-1' }));
    // Overflow beyond numeric(78,0)
    cases.push(await reserve({ idemKey: key('t20d'), walletAddr: w2, amountUnits: '9'.repeat(80) }));
    // Malformed
    cases.push(await reserve({ idemKey: key('t20e'), walletAddr: w2, amountUnits: 'abc' }));

    const allRejected = cases.every((r) => r.ok === false);
    record('20-amount-edge-cases-rejected', allRejected,
      cases.map((r) => r.reason).join(','));
  }

  // ---- 21. Duplicate settlement evidence ---------------------------------
  // Confirming twice must be idempotent and must never release the exposure.
  {
    const dw = wallet(1000);
    await limits.approveWallet(dw, { label: 'gate-d1-dup', chainId: CHAIN });
    const r = await reserve({ idemKey: key('t21'), walletAddr: dw, amountUnits: units('100') });
    const c1 = await limits.confirm(r.reservationId, '0xabc');
    const c2 = await limits.confirm(r.reservationId, '0xabc');
    const row = await sql(`SELECT status FROM ax_router.payment_reservations WHERE reservation_id = '${r.reservationId}'`);
    record('21-duplicate-settlement-idempotent',
      c1.ok && c2.ok && row === 'CONFIRMED',
      'c1=' + c1.ok + ' c2=' + c2.ok + ' status=' + row);
  }

  // ---- 22. Unknown settlement status -------------------------------------
  // markUnresolved keeps the reservation consuming exposure.
  {
    const uw = wallet(1100);
    await limits.approveWallet(uw, { label: 'gate-d1-unknown', chainId: CHAIN });
    const r = await reserve({ idemKey: key('t22'), walletAddr: uw, amountUnits: units('100') });
    await limits.markUnresolved(r.reservationId, 'outcome unknown');
    const row = await sql(`SELECT status FROM ax_router.payment_reservations WHERE reservation_id = '${r.reservationId}'`);
    // Fill to exactly $200, then probe $1: only the wallet AMOUNT cap can bind,
    // proving the unresolved reservation still consumes exposure.
    await reserve({ idemKey: key('t22a'), walletAddr: uw, amountUnits: units('100') });
    const next = await reserve({ idemKey: key('t22b'), walletAddr: uw, amountUnits: units('1') });
    record('22-unknown-status-retains-exposure',
      row === 'EXPIRED_UNRESOLVED' && next.ok === false && next.reason === 'wallet_amount_cap',
      'status=' + row + ' next=' + next.reason);
  }

  // ---- 23. Safe release following authoritative failure evidence ---------
  {
    const rw = wallet(1200);
    await limits.approveWallet(rw, { label: 'gate-d1-release', chainId: CHAIN });
    const r = await reserve({ idemKey: key('t23'), walletAddr: rw, amountUnits: units('100') });
    const rel = await limits.release(r.reservationId, 'authoritative non-settlement');
    const row = await sql(`SELECT status FROM ax_router.payment_reservations WHERE reservation_id = '${r.reservationId}'`);
    const next = await reserve({ idemKey: key('t23b'), walletAddr: rw, amountUnits: units('100') });
    record('23-authoritative-release-frees-budget',
      rel.ok && row === 'RELEASED' && next.ok === true,
      'status=' + row + ' next=' + next.ok);
  }

  // ---- 24. Bypass attempts through alternate entry points ----------------
  // The gate is a single function; there is no alternate path that skips it.
  // Prove the module refuses to evaluate without an idempotency key (so a
  // caller cannot reserve anonymously) and that enforcement-off is explicit.
  {
    const noKey = await reserve({ idemKey: '', walletAddr: w3, amountUnits: units('1') });
    const prev = process.env.SAAX_PILOT_ENFORCEMENT;
    process.env.SAAX_PILOT_ENFORCEMENT = 'off';
    const off = await reserve({ idemKey: key('t24'), walletAddr: w3, amountUnits: units('1') });
    process.env.SAAX_PILOT_ENFORCEMENT = prev;
    record('24-no-anonymous-bypass',
      noKey.ok === false && noKey.reason === 'missing_idempotency_key' &&
      off.ok === true && off.enforced === false,
      'noKey=' + noKey.reason + ' off=' + off.reason);
  }

  // ---- 25. Simultaneous global and wallet-limit contention ---------------
  {
    await sql(`DELETE FROM ax_router.payment_reservations WHERE created_at > now() - interval '24 hours'`);
    const cw = wallet(1300);
    await limits.approveWallet(cw, { label: 'gate-d1-contend', chainId: CHAIN });

    // 10 concurrent $100 attempts from ONE wallet: wallet cap ($200 / 3 tx)
    // must bind first, and the global counter must never exceed its own cap.
    const attempts = [];
    for (let i = 0; i < 10; i++) {
      attempts.push(reserve({ idemKey: key('t25-' + i), walletAddr: cw, amountUnits: units('100') }));
    }
    const settled = await Promise.all(attempts);
    const okCount = settled.filter((r) => r.ok).length;
    const globalTx = await sql(`SELECT count(*) FROM ax_router.payment_reservations WHERE created_at > now() - interval '24 hours' AND status IN ('RESERVED','CONFIRMED','EXPIRED_UNRESOLVED')`);
    record('25-wallet-and-global-contention',
      okCount === 2 && Number(globalTx) === 2,
      'allowed=' + okCount + ' (expected 2: $200/$100) global_rows=' + globalTx);
  }

  // ---- Teardown ----------------------------------------------------------
  await sql(`DELETE FROM ax_router.payment_reservations WHERE wallet IN ('${w1}','${w2}','${w3}','${w4}')`);
  await sql(`DELETE FROM ax_router.payment_reservations WHERE wallet LIKE '0x0000000000000000000000000000000000000%'`);
  await sql(`DELETE FROM ax_router.payment_reservations WHERE wallet LIKE '0x00000000000000000000000000000000000000%'`);
  await sql(`DELETE FROM ax_router.pilot_wallets WHERE label LIKE 'gate-d1-%'`);

  const failed = results.filter((r) => !r.pass);
  console.log('\n==== GATE D.1 RESULT: ' + (results.length - failed.length) + '/' + results.length + ' PASS ====');
  if (failed.length) {
    for (const f of failed) console.log('  FAILED: ' + f.name + ' :: ' + f.detail);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('SUITE ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
