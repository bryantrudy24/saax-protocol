// SAAX Protocol — Gate D.3 Phase D: rolling-window Retry-After estimation
//
// Verifies computeRetryAfter against the ISOLATED Postgres/PostgREST testbed
// (ax_router_db / ax_router_postgrest). Never touches live Supabase.
//
// What is proven:
//   1. A wallet/global amount-cap rejection yields a CONSERVATIVE estimate
//      anchored to the OLDEST exposure-consuming reservation (created_at +
//      window), NOT a flat 86400.
//   2. Unknown-outcome reservations (RESERVED/CONFIRMED/EXPIRED_UNRESOLVED)
//      keep pushing the estimate forward.
//   3. Non-window caps (single_transaction_cap, allowlist, invalid input)
//      return no estimate -> caller omits the header (never guess).
//   4. Store outage fails closed -> no estimate.
//   5. Deterministic boundaries: RELEASED frees budget immediately.
//
// Each test uses its OWN wallet so tests never interfere, and own RUN-scoped
// keys. All wallets are approved at startup and cleaned at the end.
'use strict';

const path = require('path');
const { buildSupabaseClient } = require(path.join(__dirname, '..', '..', 'endpoint', 'store.js'));
const { mint } = require(path.join(__dirname, '_gate-d-jwt.cjs'));
const { execFileSync } = require('node:child_process');

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || mint('service_role');

const limits = require(path.join(__dirname, '..', '..', 'endpoint', 'pilot-limits.js'));

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const CHAIN = 84532;
const RECIPIENT = '0x1111111111111111111111111111111111111111';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail);
}

function sql(query) {
  return execFileSync('docker', [
    'exec', 'ax_router_db', 'psql', '-U', 'postgres', '-d', 'ax_router', '-t', '-A', '-c', query,
  ], { encoding: 'utf8' }).trim();
}

const RUN = 'd3p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const wallet = (n) => ('0x' + String(n).padStart(40, 'a')).toLowerCase();
const key = (n) => RUN + ':key:' + n;

function units(usd) {
  const r = limits.usdToUnits(usd, 6);
  if (!r.ok) throw new Error('usdToUnits failed: ' + r.reason);
  return r.units;
}

async function reserve({ idemKey, walletAddr, amountUnits, recipient, commitmentId }) {
  return limits.evaluate({
    idempotencyKey: idemKey,
    wallet: walletAddr,
    chainId: CHAIN,
    asset: USDC,
    amountUnits,
    recipient: recipient === undefined ? RECIPIENT : recipient,
    commitmentId,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = buildSupabaseClient(POSTGREST_URL, POSTGREST_KEY);
  limits.setStoreClient(client);
  process.env.SAAX_PILOT_ENFORCEMENT = 'on';
  process.env.SAAX_PILOT_MAX_SINGLE_USD = '100';
  process.env.SAAX_PILOT_WALLET_MAX_USD = '200';
  process.env.SAAX_PILOT_WALLET_MAX_TX = '3';
  process.env.SAAX_PILOT_GLOBAL_MAX_USD = '1000';
  process.env.SAAX_PILOT_GLOBAL_MAX_TX = '15';
  process.env.SAAX_PILOT_WINDOW_HOURS = '24';

  // Approved wallets: w1 (T1/T2/T3), w2 (T5), w3 (T6), w4 (T8). w888 (T4) is
  // deliberately NOT approved so the allowlist rejection path is exercised.
  // T8 seeds 11 additional wallets (wallet(500..510)); they must be in the
  // cleanup list too, or leaked RESERVED rows corrupt the global-scope
  // Retry-After estimate on later runs (oldest row > 24h -> estimate clamps
  // to 1). Test-hygiene fix, verified against the actual failure.
  const wallets = [wallet(1), wallet(2), wallet(3), wallet(4)];
  const unapproved = wallet(888);
  const t8SeedWallets = [];
  for (let i = 0; i < 11; i++) t8SeedWallets.push(wallet(500 + i));
  const allForCleanup = wallets.concat([unapproved, wallet(999)]).concat(t8SeedWallets);
  const wl = wallets.map((w) => "'" + w + "'").join(',');
  sql(`DELETE FROM ax_router.payment_reservations WHERE wallet IN (${wl})`);
  sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet IN (${wl})`);
  for (const w of wallets) {
    const ap = await limits.approveWallet(w, { label: 'gate-d3-retry', chainId: CHAIN });
    if (!ap.ok) throw new Error('approveWallet failed for ' + w + ': ' + ap.reason);
  }

  // ---- T1: wallet amount cap -> estimate anchored to OLDEST (not 86400) ----
  // Single-tx cap is $100, so use $90 x 2 = $180, then $30 -> wallet cap $200.
  {
    const w = wallet(1);
    const r1 = await reserve({ idemKey: key('t1a'), walletAddr: w, amountUnits: units('90') });
    if (!r1.ok) throw new Error('T1 first reserve failed: ' + r1.reason);
    await sleep(1200); // age the oldest row ~1.2s
    const r1b = await reserve({ idemKey: key('t1b'), walletAddr: w, amountUnits: units('90') });
    if (!r1b.ok) throw new Error('T1 second reserve failed: ' + r1b.reason);
    const r2 = await reserve({ idemKey: key('t1c'), walletAddr: w, amountUnits: units('30') });
    if (r2.ok) throw new Error('T1 expected cap but got ' + r2.reason);
    const ra = await limits.computeRetryAfter({ reason: r2.reason, wallet: w, chainId: CHAIN });
    // Oldest created ~ 1.2s ago -> estimate ~ 86400 - 1.2 = 86399 (NOT 86400)
    const ok = r2.reason === 'wallet_amount_cap' &&
      ra && ra.estimateSeconds !== null &&
      ra.estimateSeconds >= 86380 && ra.estimateSeconds < 86400; // strictly < 86400 proves non-flat
    record('T1-wallet-cap-estimate-anchored',
      !!ok,
      'reason=' + r2.reason + ' estimate=' + (ra && ra.estimateSeconds) + ' (<86400 proves rolling)');
  }

  // ---- T2: count cap -> estimate anchored (wallet has 3 x $1) -------------
  // w1 currently has $90 + $90 = $180 (2 rows). Add 2 x $1 -> 4 rows; the
  // wallet count cap is 3, so the 4th row already exceeded -> now a NEW $1
  // request hits wallet_count_cap. Compute from the oldest of the 4.
  {
    const w = wallet(1);
    await reserve({ idemKey: key('t2a'), walletAddr: w, amountUnits: units('1') });
    await reserve({ idemKey: key('t2b'), walletAddr: w, amountUnits: units('1') });
    await sleep(800);
    const existing = sql(`SELECT count(*) FROM ax_router.payment_reservations WHERE wallet='${w}'`);
    // Force a count-cap rejection deterministically: insert 4 rows total
    // (2 existing + 2 above = 4), then any new reserve -> count cap.
    // A direct reserve would be rejected for count BEFORE inserting, which is
    // exactly what we want to observe via computeRetryAfter.
    const r4 = await reserve({ idemKey: key('t2c'), walletAddr: w, amountUnits: units('1') });
    if (r4.ok) throw new Error('T2 expected count cap but got ' + r4.reason);
    const ra = await limits.computeRetryAfter({ reason: r4.reason, wallet: w, chainId: CHAIN });
    const ok = r4.reason === 'wallet_count_cap' &&
      ra && ra.estimateSeconds !== null && ra.estimateSeconds >= 86380 && ra.estimateSeconds < 86400;
    record('T2-count-cap-estimate-anchored',
      !!ok,
      'reason=' + r4.reason + ' estimate=' + (ra && ra.estimateSeconds));
  }

  // ---- T3: single_transaction_cap -> NO estimate (header omitted) ---------
  {
    const w = wallet(1);
    const r = await reserve({ idemKey: key('t3'), walletAddr: w, amountUnits: units('101') });
    const ra = await limits.computeRetryAfter({ reason: r.reason, wallet: w, chainId: CHAIN });
    record('T3-single-cap-no-estimate',
      r.reason === 'single_transaction_cap' && ra && ra.estimateSeconds === null,
      'reason=' + r.reason + ' estimate=' + (ra && ra.estimateSeconds));
  }

  // ---- T4: allowlist rejection -> NO estimate ------------------------------
  {
    const w = unapproved; // never approved at startup
    const r = await reserve({ idemKey: key('t4'), walletAddr: w, amountUnits: units('1') });
    const ra = await limits.computeRetryAfter({ reason: r.reason, wallet: w, chainId: CHAIN });
    record('T4-allowlist-no-estimate',
      r.reason === 'wallet_not_allowlisted' && ra && ra.estimateSeconds === null,
      'reason=' + r.reason + ' estimate=' + (ra && ra.estimateSeconds));
  }

  // ---- T5: unknown-outcome reservation keeps exposure (EXPIRED_UNRESOLVED) -
  // $90 + $90 = $180, then $30 -> wallet cap. Mark the FIRST row unresolved.
  {
    const w = wallet(2);
    const r1 = await reserve({ idemKey: key('t5a'), walletAddr: w, amountUnits: units('90') });
    if (!r1.ok || !r1.reservationId) throw new Error('T5 first reserve failed: ' + JSON.stringify(r1));
    await reserve({ idemKey: key('t5b'), walletAddr: w, amountUnits: units('90') });
    const fin = await limits.finalize(r1.reservationId, 'EXPIRED_UNRESOLVED', 'test unknown outcome', null);
    await sleep(800);
    const r2 = await reserve({ idemKey: key('t5c'), walletAddr: w, amountUnits: units('30') });
    const ra = await limits.computeRetryAfter({ reason: r2.reason, wallet: w, chainId: CHAIN });
    const ok = fin.ok === true && r2.reason === 'wallet_amount_cap' &&
      ra && ra.estimateSeconds !== null && ra.estimateSeconds >= 86380;
    record('T5-unresolved-retains-exposure',
      !!ok,
      'fin=' + JSON.stringify(fin) + ' reason=' + r2.reason + ' estimate=' + (ra && ra.estimateSeconds));
  }

  // ---- T6: RELEASED frees budget immediately ------------------------------
  {
    const w = wallet(3);
    const r1 = await reserve({ idemKey: key('t6a'), walletAddr: w, amountUnits: units('90') });
    if (!r1.ok || !r1.reservationId) throw new Error('T6 first reserve failed: ' + JSON.stringify(r1));
    const fin = await limits.release(r1.reservationId, 'test authoritative non-settlement');
    const r2 = await reserve({ idemKey: key('t6b'), walletAddr: w, amountUnits: units('60') });
    record('T6-released-frees-budget',
      fin.ok === true && r2.ok === true && r2.reason === 'reserved',
      'fin=' + JSON.stringify(fin) + ' r2=' + (r2.ok ? 'reserved' : r2.reason));
  }

  // ---- T7: store outage -> NO estimate (fail closed) -----------------------
  {
    limits.setStoreClient(null);
    const ra = await limits.computeRetryAfter({ reason: 'wallet_amount_cap', wallet: wallet(1), chainId: CHAIN });
    record('T7-store-outage-no-estimate',
      ra && ra.estimateSeconds === null,
      'estimate=' + (ra && ra.estimateSeconds));
    limits.setStoreClient(client);
  }

  // ---- T8: global cap estimate (global scope) -----------------------------
  // Seed 11 rows across 11 DIFFERENT wallets (each $95 < wallet cap $200, but
  // global total $1045 > $1000), all 5h old. A $60 reserve on a fresh wallet
  // then trips GLOBAL_amount_cap, and computeRetryAfter must estimate from
  // the OLDEST seeded row = 24h - 5h = ~19h (68400s), NOT 86400.
  {
    const seedWallets = [];
    for (let i = 0; i < 11; i++) seedWallets.push(wallet(500 + i));
    const values = seedWallets.map((w, i) =>
      `('${RUN}_g${i}','${key('g' + i)}','${w}',8453,` +
      `'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',95000000,` +
      `'${RECIPIENT}','ph_g${i}','RESERVED', now() - interval '5 hours', now() + interval '19 hours')`
    ).join(',\n        ');
    sql(`INSERT INTO ax_router.payment_reservations
          (reservation_id, idempotency_key, wallet, chain_id, asset, amount_units,
           recipient, payload_hash, status, created_at, expires_at)
        VALUES ${values}`);
    const r2 = await reserve({ idemKey: key('t8c'), walletAddr: wallet(4), amountUnits: units('60') });
    if (r2.ok) throw new Error('T8 expected global cap but got ' + r2.reason);
    const ra = await limits.computeRetryAfter({ reason: r2.reason, wallet: wallet(4), chainId: CHAIN });
    // Oldest seeded row is 5h old -> estimate ~ 19h = 68400s (NOT 86400).
    const ok = r2.reason === 'global_amount_cap' &&
      ra && ra.estimateSeconds !== null &&
      ra.estimateSeconds >= 68300 && ra.estimateSeconds <= 68500;
    record('T8-global-cap-estimate-anchored',
      !!ok,
      'reason=' + r2.reason + ' estimate=' + (ra && ra.estimateSeconds) + ' (~68400 = 24h-5h)');
  }

  // ---- Cleanup -------------------------------------------------------------
  const clean = allForCleanup.map((w) => "'" + w + "'").join(',');
  sql(`DELETE FROM ax_router.payment_reservations WHERE wallet IN (${clean})`);
  sql(`DELETE FROM ax_router.pilot_wallets WHERE wallet IN (${clean})`);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n==== GATE D.3 PHASE D RESULT: ' + passed + '/' + (passed + failed) + ' PASS ====');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR: ' + (e && e.stack || e));
  process.exit(2);
});
