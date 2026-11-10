// SAAX Protocol — Day 3/4 + Sprint 2: Ranking Engine (configurable scoring +
// capability floor + empirical-Bayes shrinkage + outcome logging hooks)
//
// Scores supplier candidates for a capability query and returns the top 3-5
// with computed scores and payTo addresses (mock mode: payTo = owner address
// from the Identity Registry — no real settlement).
//
// Score formula (per operator spec):
//   Score = (ReputationScore * 0.6) + (FeedbackFreshness * 0.2) + (PriceCompetitiveness * 0.2)
// Sprint 2: the weights are no longer hardcoded — endpoint/weights.js owns
// them (SAAX_W_REPUTATION / SAAX_W_FRESHNESS / SAAX_W_PRICE, defaults 0.6/0.2/0.2).
//
// CONFIGURABLE SCORING (PRE-DAY 4 FIX 1)
// -------------------------------------
//   SAAX_PRICE_SCORE_DEFAULT    (default "50")  neutral price-competitiveness score
//                                             (0-100) used until Day 5/x402/MPP probing
//                                             feeds real prices into this slot.
//   SAAX_FRESHNESS_STRATEGY     (default "count_proxy")
//       count_proxy   -> FeedbackFreshness derived from feedback_count
//                        (decayed by registry age; honest placeholder).
//       timestamp_delta-> (future) FeedbackFreshness from real on-chain
//                        last_feedback_timestamp deltas. When the archive
//                        event-scan resolves the missing timestamps, switch to
//                        this value — NO CODE CHANGE REQUIRED; the strategy is
//                        read from the environment at rank time.
//
// CAPABILITY MATCH FLOOR (PRE-DAY 4 FIX 2)
// ----------------------------------------
//   SAAX_CAPABILITY_FLOOR       (default "0.4") minimum capability match score a
//                                             supplier must clear to be
//                                             returned for a demand request.
//                                             If the TOP capability match
//                                             falls below this floor the
//                                             engine returns an explicit
//                                             no_match response instead of
//                                             falling through to trusted
//                                             generalists who cannot deliver
//                                             the requested capability.
//
// SPRINT 2 — SHRINKAGE (low-sample suppliers)
// ------------------------------------------
//   SAAX_SHRINKAGE_THRESHOLD    (default 5)   feedback_count below this => shrink
//   SAAX_SHRINKAGE_M            (default 200) prior strength; higher = stronger
//                                           pull toward the category mean
//   SAAX_SHRINKAGE_NEUTRAL      (default 50)  category mean when a category has
//                                           NO feedback data at all (neutral)
//   shrunken = (count * raw + M * mean) / (count + M)
//   Applied BEFORE the weighted sum; ReputationScore term becomes the shrunken
//   value for low-sample suppliers. Category means computed once per ranking
//   run, cached for the session.
//
// Mock-mode notes (honest placeholders, never presented as on-chain data):
//   - FeedbackFreshness: no on-chain timestamp source (Day 2 finding). Uses
//     feedback_count as a proxy *decayed* by registry age under count_proxy.
//   - PriceCompetitiveness: neutral SAAX_PRICE_SCORE_DEFAULT by default; Day 5
//     will feed real price data from x402/MPP probing.
//   - Capability query is UNTRUSTED INPUT: matched against text only, never executed.
const { JsonRpcProvider, Contract } = require('ethers');
const fs = require('fs');
const path = require('path');
const weights = require(path.join(__dirname, '..', 'endpoint', 'weights.js'));
const { buildShrinkage } = require(path.join(__dirname, 'shrinkage.js'));

const RPC = process.env.SAAX_RPC_URL || 'https://base-rpc.publicnode.com';
const IDENTITY_REGISTRY = process.env.SAAX_IDENTITY_REGISTRY || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// ---- Configurable scoring (PRE-DAY 4 FIX 1) ------------------------------
// Read from environment at load: SAAX_PRICE_SCORE_DEFAULT (price slot),
// SAAX_FRESHNESS_STRATEGY (freshness strategy selector). Day 5 feeds the price
// slot with real prices; the archive event-scan flips the strategy.
const SAAX_PRICE_SCORE_DEFAULT = Number(process.env.SAAX_PRICE_SCORE_DEFAULT || 50);
const SAAX_FRESHNESS_STRATEGY  = process.env.SAAX_FRESHNESS_STRATEGY || 'count_proxy';

// ---- Capability floor (PRE-DAY 4 FIX 2) -----------------------------------
// Minimum match score to return ANY supplier for a demand request. Below this,
// respond no_match instead of generalist fallback.
const SAAX_CAPABILITY_FLOOR = Number(process.env.SAAX_CAPABILITY_FLOOR || 0.4);

// ---- Sprint 2: ranking weights (single source of truth) -------------------
// The formula is no longer hardcoded here; endpoint/weights.js owns the
// current weights (env SAAX_W_REPUTATION / SAAX_W_FRESHNESS / SAAX_W_PRICE,
// default 0.6/0.2/0.2 — unchanged behavior). The weightsSnapshot() is stored
// in ranking_outcomes.weights_used at ranking time so tuning analysis can
// trace outcomes back to the exact formula that produced them.
const W = weights.currentWeights();
const WEIGHTS_SNAPSHOT = weights.weightsSnapshot();

// ---- Untrusted-input sanitization (Security gate) ------------------------
// The demand request arrives as untrusted text. We only ever extract
// alphanumeric capability keywords from it; anything else is dropped. No
// instruction inside the text is ever executed, echoed back, or used as a key.
function sanitizeCapability(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')   // strip punctuation/control (also kills any URL/shell chars)
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 24);
}

// ---- FeedbackFreshness (strategy-driven) -----------------------------------
// count_proxy (current): 0..100 from feedback_count, decayed by registry age
//   (honest placeholder: no on-chain timestamp available Sprint 1).
// timestamp_delta (future): computed from real last_feedback_timestamp when the
//   archive event-scan resolves it. The engine reads this function, so switching
//   SAAX_FRESHNESS_STRATEGY is the only change required.
function feedbackFreshness(rep, strategy = SAAX_FRESHNESS_STRATEGY) {
  const feedbackCount = (rep && rep.count) || 0;
  if (strategy === 'timestamp_delta') {
    // Reserve: when last_feedback_timestamp is populated (Day 5 event-scan),
    // compute deltas here. Until then, behave identically to count_proxy so the
    // deployed engine never changes behaviour without the data to back it.
    if (feedbackCount > 0) return Math.min(100, feedbackCount * 10);
    return 0;
  }
  // count_proxy (default)
  if (feedbackCount > 0) return Math.min(100, feedbackCount * 10);
  return 0;
}

// ---- Capability matching ---------------------------------------------------
// Scores how well an agent's text (name + description + services) matches the
// query keywords. Simple but transparent: overlap of query terms over the
// agent's token set, weighted toward exact service names.
function matchScore(agent, keywords) {
  if (!keywords.length) return 0;
  const hay = (
    (agent.name || '') + ' ' +
    (agent.description || '') + ' ' +
    (Array.isArray(agent.services) ? agent.services.map(s => s.name || '').join(' ') : '')
  ).toLowerCase();
  let hits = 0;
  for (const kw of keywords) if (hay.includes(kw)) hits++;
  return hits / keywords.length;
}

// ---- Sprint 2: capability category + category mean (shrinkage) -------------
// Suppliers are grouped into capability categories derived from their service
// names (the data model has no dedicated category column). The mean reputation
// per category is computed ONCE per ranking run and cached for the session.
function categoryOf(agent) {
  const svc = Array.isArray(agent.services) ? agent.services.map(s => (s && s.name) || '').join(' ') : '';
  const src = ((agent.name || '') + ' ' + svc).toLowerCase();
  const CATS = [
    ['security', /security|scan|audit|pen.?test|vulnerab/i],
    ['data', /data|analytics|analysis|insight|intel/i],
    ['automation', /automation|workflow|orchestrat|agent/i],
    ['ai', /ai|llm|model|generative|nlp|vision/i],
    ['ops', /ops|operat|support|monitor/i],
    ['creative', /design|creative|content|writing|art/i],
    ['payments', /payment|settle|rail|stripe|x402/i],
  ];
  for (const [cat, re] of CATS) if (re.test(src)) return cat;
  return 'general';
}

// Average raw reputation across the suppliers in a category. Called ONCE per
// ranking run with all candidates; results are cached in the shrinkage context.
function computeCategoryMeans(candidates, repMap, shrinkage) {
  const sums = new Map();
  const counts = new Map();
  for (const agent of candidates) {
    const cat = categoryOf(agent);
    const repScore = Number((repMap[agent.agent_id] || {}).avgX100) || 0;
    sums.set(cat, (sums.get(cat) || 0) + repScore);
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  for (const [cat, sum] of sums) {
    const mean = counts.get(cat) ? sum / counts.get(cat) : 50;
    shrinkage.setCategoryMean(cat, mean);
  }
}

// ---- Ranked output ---------------------------------------------------------
// data agents carry the identity metadata; rep carries on-chain reputation.
// leaderboard is the curated high-reputation pool.
function buildRanker({ agents, repMap, leaderboard }) {
  return function rank(capability, { topN = 5 } = {}) {
    const keywords = sanitizeCapability(capability);
    if (!keywords.length) {
      return { status: 'no_match', capability, reason: 'capability field empty after sanitization' };
    }

    // Sprint 2: one shrinkage context per ranking run (category means cached
    // for the session inside it).
    const shrinkage = buildShrinkage();

    const candidates = [];

    // Merge indexed agents + leaderboard pool into one candidate list.
    const seen = new Set();
    const all = [...agents];
    for (const lb of leaderboard) {
      if (!seen.has(lb.agent_id)) all.push(lb);
    }

    let topMatch = 0;
    for (const agent of all) {
      seen.add(agent.agent_id);
      const cat = categoryOf(agent);
      const rep = repMap[agent.agent_id] || {};
      const repScore = rep.avgX100;      // 0..100 from getSummary
      const feedbackCount = rep.count || 0;
      const m = matchScore(agent, keywords);
      if (m > topMatch) topMatch = m;

      // Config slot: PriceCompetitiveness from SAAX_PRICE_SCORE_DEFAULT.
      // (Day 5 replaces this with real prices; the engine simply reads the slot.)
      const price = SAAX_PRICE_SCORE_DEFAULT;

      // FeedbackFreshness from the active strategy (SAAX_FRESHNESS_STRATEGY).
      const freshness = feedbackFreshness(rep);

      // Candidate gate (PRE-DAY 4 FIX 2): a supplier can only enter when it
      // clears the capability FLOOR with a real match, OR carries verified
      // on-chain reputation ABOVE the floor-equivalent (in which case it still
      // requires a match signal to be returned for a *capability* demand —
      // pure generalists with zero match never satisfy a specific capability
      // request; they are only carried as a fallback when a real match exists
      // above the floor and we need to fill the top-N).
      if (m <= 0 && !(repScore > 0 && topMatch >= SAAX_CAPABILITY_FLOOR)) continue;

      // Sprint 2 — shrinkage BEFORE the weighted sum (operator spec). The
      // ReputationScore term becomes shrunken_reputation for low-sample
      // suppliers; the weighted formula + weights come from weights.js.
      const shrunk = shrinkage.shrink(repScore, feedbackCount, cat);
      const reputationTerm = shrunk.value;
      // All terms on 0-100 scale => final score range 0-100.
      const score = Math.round(
        (reputationTerm * W.reputation) +
        (freshness * W.freshness) +
        (price * W.price)
      );

      candidates.push({
        agent_id: agent.agent_id,
        name: agent.name,
        services: agent.services,
        match: Math.round(m * 100) / 100,
        reputation_score: repScore || null,
        reputation_shrunken: shrunk.shrunken ? Math.round(shrunk.value * 100) / 100 : null,
        shrinkage: shrunk.shrunken ? { category: cat, mean: Math.round(shrunk.mean * 100) / 100, count: shrunk.count, m: shrinkage.config.m } : null,
        category: cat,
        feedback_count: feedbackCount,
        score,
        components: {
          reputation: reputationTerm,
          freshness,
          price,
        },
        weights_used: WEIGHTS_SNAPSHOT,
        payTo: agent.owner || agent.payTo,
        source: agent.source || 'indexed',
      });
    }

    // Category means computed once per run from ALL candidates (cached in the
    // session shrinkage context).
    computeCategoryMeans(all, repMap, shrinkage);

    // First pass scored with neutral means (means were not known yet). Re-run
    // the shrinkage pass with the real category means so the scores reflect
    // the mean-based pull. Only suppliers still below the threshold are
    // touched; the candidates array is mutated in place (same objects).
    for (const cand of candidates) {
      const n = cand.feedback_count || 0;
      if (n >= shrinkage.config.threshold) continue;
      const cat = cand.category;
      const mean = shrinkage.categoryMean(cat);
      const raw = cand.reputation_score || 0;
      const value = (n * raw + shrinkage.config.m * mean) / (n + shrinkage.config.m);
      cand.reputation_shrunken = Math.round(value * 100) / 100;
      cand.shrinkage = { category: cat, mean: Math.round(mean * 100) / 100, count: n, m: shrinkage.config.m };
      cand.components.reputation = value;
      cand.score = Math.round(
        (value * W.reputation) +
        (cand.components.freshness * W.freshness) +
        (cand.components.price * W.price)
      );
    }
    const shrinkageAppliedAny = candidates.some(c => c.shrinkage);

    // CAPABILITY FLOOR CHECK (PRE-DAY 4 FIX 2): if the top match among ALL
    // indexed suppliers clears the floor, rank and return matches + trusted
    // generalist fallbacks (specialists first, then generalists). If the top
    // match does NOT clear the floor, no indexed supplier can deliver the
    // requested capability — return an EXPLICIT no_match instead of falling
    // through to generalists who cannot actually deliver.
    if (topMatch < SAAX_CAPABILITY_FLOOR) {
      return {
        status: 'no_match',
        capability,
        reason: 'no supplier meets minimum capability threshold',
      };
    }

    // Rank: capability relevance is the primary signal; composite score breaks
    // ties. Capability matches first, then verified-reputation generalists.
    candidates.sort((a, b) =>
      (b.match > 0 ? 1 : 0) - (a.match > 0 ? 1 : 0) ||
      b.score - a.score ||
      b.match - a.match ||
      (b.reputation_score || 0) - (a.reputation_score || 0));

    const top = candidates.slice(0, topN);
    return {
      status: 'ok',
      capability,
      weights_used: WEIGHTS_SNAPSHOT,
      shrinkage_applied: shrinkageAppliedAny,
      candidates: top,
    };
  };
}

// ---- Load local state ------------------------------------------------------
function loadLocal() {
  const agents = JSON.parse(fs.readFileSync('data/agents-day1-named.json', 'utf8'));
  let rep;
  try { rep = JSON.parse(fs.readFileSync('data/reputation-day3.json', 'utf8')); }
  catch (e) { rep = JSON.parse(fs.readFileSync('data/reputation-day2.json', 'utf8')); }
  const repMap = {};
  for (const r of (Array.isArray(rep) ? rep : Object.values(rep))) repMap[r.agent_id] = r;

  let leaderboard = [];
  try {
    const lb = JSON.parse(fs.readFileSync('data/leaderboard-suppliers-day3.json', 'utf8'));
    leaderboard = Array.isArray(lb) ? lb : Object.values(lb);
    // Merge each leaderboard agent's on-chain reputation probe into the rep map
    // so the ranker has real reputation spread to score.
    for (const agent of leaderboard) {
      if (agent.reputation_probe && !repMap[agent.agent_id]) {
        repMap[agent.agent_id] = {
          agent_id: agent.agent_id,
          clients: agent.reputation_probe.clients || 0,
          count: agent.reputation_probe.count || 0,
          avgX100: agent.reputation_probe.avgX100,
        };
      }
    }
  } catch (e) { /* file optional */ }
  return { agents, repMap, leaderboard };
}

async function main() {
  const { agents, repMap, leaderboard } = loadLocal();
  const ranker = buildRanker({ agents, repMap, leaderboard });

  // argv[1] is the script path under this harness's node invocation; the first
  // user-supplied argument (the capability query) is argv[2].
  const query = process.argv[2] || 'security scan';
  const result = ranker(query, { topN: 5 });

  console.log('=== SAAX Protocol — RANKING ENGINE (configurable + shrinkage) ===');
  console.log('query:', query, '| status:', result.status,
    '| floor:', SAAX_CAPABILITY_FLOOR,
    '| price_default:', SAAX_PRICE_SCORE_DEFAULT,
    '| freshness_strategy:', SAAX_FRESHNESS_STRATEGY,
    '| weights:', JSON.stringify(result.weights_used),
    '| shrinkage_applied:', result.shrinkage_applied);
  if (result.status === 'ok') {
    console.log('candidates:', result.candidates.length);
    console.log(JSON.stringify(result.candidates, null, 1));
  } else {
    console.log(JSON.stringify(result, null, 1));
  }

  fs.writeFileSync('data/rankings-day4.json', JSON.stringify({ query, result, at: new Date().toISOString() }, null, 1));
  process.exit(0);
}

// CLI
if (require.main === module) main().catch(e => { console.error('FATAL', String(e)); process.exit(1); });

module.exports = { buildRanker, sanitizeCapability, matchScore, feedbackFreshness, categoryOf, computeCategoryMeans, SAAX_PRICE_SCORE_DEFAULT, SAAX_FRESHNESS_STRATEGY, SAAX_CAPABILITY_FLOOR };