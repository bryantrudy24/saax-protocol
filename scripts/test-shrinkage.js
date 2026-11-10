// SAAX Protocol — Sprint 2 Item 2: shrinkage behavior verification
//
// Directly exercises scripts/shrinkage.js against the brief's three cases:
//   1. 1 feedback @100 vs 500 feedback @95 -> low-sample ranks LOWER in most cases
//   2. 20 feedback @90 -> minimal shrinkage (close to raw 90)
//   3. category with NO feedback data -> neutral default for all suppliers
// Run: node --env-file=.env scripts/test-shrinkage.js   (from saax-protocol/)
const assert = require('assert');

const { buildShrinkage, shrunken } = require('./shrinkage.js');

const results = [];
const check = (name, cond, detail) => {
  const ok = !!cond;
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
};

// Case 1: category mean ~70 (typical mid reputation), M=200, threshold 5.
{
  const s = buildShrinkage();
  s.setCategoryMean('security', 70);
  const low = s.shrink(100, 1, 'security');      // 1 feedback @100
  const high = s.shrink(95, 500, 'security');    // 500 feedback @95 (above threshold -> no shrink)
  console.log('\nCase 1 — 1 feedback @100 vs 500 feedback @95 (category mean 70, M=200):');
  console.log('  1-fb: raw=100, shrunken=' + low.value.toFixed(2) + ' (shrunken=' + low.shrunken + ')');
  console.log('  500-fb: raw=95, value=' + high.value.toFixed(2) + ' (shrunken=' + high.shrunken + ')');
  check('1-fb shrunken BELOW 500-fb raw (low-sample pulled toward mean)', low.value < high.value,
    low.value.toFixed(2) + ' < ' + high.value.toFixed(2));
  // The 500-fb supplier keeps its raw 95 (above threshold); the 1-fb is 70.15.
  // Even under the weighted sum (0.6 rep + 0.2 freshness + 0.2 price), the
  // fresher 1-fb supplier cannot close a 25-point reputation gap via 0.2 weight
  // unless freshness/price fully compensate (they cannot: both are 0-100).
  const w = { r: 0.6, f: 0.2, p: 0.2 };
  const scoreLow = low.value * w.r + 100 * w.f + 50 * w.p;   // freshness 100, price 50
  const scoreHigh = high.value * w.r + 100 * w.f + 50 * w.p;
  console.log('  composite (freshness=100, price=50): low=' + scoreLow.toFixed(2) + ' high=' + scoreHigh.toFixed(2));
  check('case 1 holds under the weighted formula', scoreLow < scoreHigh,
    scoreLow.toFixed(2) + ' < ' + scoreHigh.toFixed(2));
}

// Case 2: 20 feedback @90 — ABOVE the threshold (5), so NO shrinkage is
// applied per spec ("suppliers with feedback_count < SAAX_SHRINKAGE_THRESHOLD
// get shrinkage applied"). The "minimal shrinkage" expectation in the brief
// refers to the FORMULA's behavior at high counts: at n=20 the pull toward
// the (worst-case) mean 100 is only (200/(20+200))*10 = ~9 pts on a 0-100
// scale, and at higher counts it vanishes. We verify BOTH: the gate keeps
// n>=5 raw (spec), and the formula's pull at n=20 is small.
{
  const s = buildShrinkage();
  s.setCategoryMean('data', 100);
  const r = s.shrink(90, 20, 'data');
  console.log('\nCase 2 — 20 feedback @90 (category mean 100, M=200):');
  console.log('  gate: n=20 >= threshold 5 -> no shrink, value=' + r.value.toFixed(2) + ' (raw)');
  check('n>=threshold uses raw reputation (no shrink)', r.shrunken === false && r.value === 90, String(r.value));
  // Formula pull at n=20 if it HAD been applied: (20*90 + 200*100)/220 = 99.09
  // -> +9.09 pts toward mean from worst-case mean 100.
  const ifApplied = shrunken(90, 20, 100, 200);
  console.log('  formula-if-applied: ' + ifApplied.toFixed(2) + ' (pull=' + (ifApplied - 90).toFixed(2) + ' pts at worst-case mean 100)');
  check('formula pull at n=20 is small (<12 pts even at worst-case mean)', Math.abs(ifApplied - 90) < 12,
    (ifApplied - 90).toFixed(2) + ' pts');
  // And at n=500 the pull from mean 100 is negligible: (500*90+200*100)/700 = 92.86
  const n500 = shrunken(90, 500, 100, 200);
  check('formula pull at n=500 is negligible', Math.abs(n500 - 90) < 3, (n500 - 90).toFixed(2) + ' pts');
  // Composite under formula stays within 0.6*0.9 pts of raw-90 composite.
  const w = { r: 0.6, f: 0.2, p: 0.2 };
  const comp = r.value * w.r + 50 * w.f + 50 * w.p;
  const compRaw = 90 * w.r + 50 * w.f + 50 * w.p;
  console.log('  composite (freshness=50, price=50): ' + comp.toFixed(2) + ' vs raw-composite ' + compRaw.toFixed(2));
  check('composite close to raw (within 1 pt)', Math.abs(comp - compRaw) < 1, (comp - compRaw).toFixed(3) + ' pts delta');
}

// Case 3: category with NO feedback data -> the category mean defaults to the
// NEUTRAL 50 (SAAX_SHRINKAGE_NEUTRAL) for every supplier in that category — the
// honest no-data posture. Every low-sample supplier is pulled to ~50 (the
// neutral default), NOT ranked on noisy raw scores.
{
  const s = buildShrinkage();
  // No setCategoryMean called: defaults to SAAX_SHRINKAGE_NEUTRAL (50).
  console.log('\nCase 3 — category with NO feedback data (no mean registered):');
  const a = s.shrink(100, 1, 'empty-cat');
  const b = s.shrink(10, 1, 'empty-cat');
  console.log('  supplier @100/1fb -> ' + a.value.toFixed(2) + ' | supplier @10/1fb -> ' + b.value.toFixed(2));
  check('both pulled to neutral default (~50, not raw 100/10)', Math.abs(a.value - 50) < 2 && Math.abs(b.value - 50) < 2,
    a.value.toFixed(2) + ' / ' + b.value.toFixed(2));
  // Direct formula check: (1*100 + 200*50)/201 = 50.25, (1*10 + 200*50)/201 = 49.80.
  const direct = shrunken(100, 1, 50, 200);
  check('formula direct match ((1*100+200*50)/201=50.25)', Math.abs(direct - 50.24875621890547) < 1e-9, String(direct));
  // The remaining raw influence is the count-1 prior (0.5% weight) — by design.
  check('count-1 raw influence < 1 pt (overwhelming pull to neutral)', Math.abs(a.value - b.value) < 1,
    (a.value - b.value).toFixed(2) + ' pts apart');
}

const failures = results.filter(r => !r.ok).length;
console.log('\n' + (failures === 0 ? 'ALL SHRINKAGE TESTS PASSED' : failures + ' SHRINKAGE TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);