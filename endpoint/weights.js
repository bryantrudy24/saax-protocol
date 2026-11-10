// SAAX Protocol — Sprint 2: ranking weights (single source of truth)
//
// The ranking formula was previously hardcoded in rank-suppliers.js and
// route-server.js. This module centralizes it so that:
//   1. The exact weight configuration at ranking time can be snapshotted
//      into ranking_outcomes.weights_used (outcome-logging requirement).
//   2. The tuning loop reads/updates ONE place (propose-weights.js writes
//      proposals; the OPERATOR applies them via apply-weights.js --confirm).
//   3. Defaults match the pre-sprint formula EXACTLY: 0.6 / 0.2 / 0.2 so the
//      ranker's behavior is unchanged until an operator-approved proposal
//      changes the weights.
//
// Env:
//   SAAX_W_REPUTATION  (default 0.6)  ReputationScore weight
//   SAAX_W_FRESHNESS   (default 0.2)  FeedbackFreshness weight
//   SAAX_W_PRICE       (default 0.2)  PriceCompetitiveness weight
//
// Weights are read AT LOAD TIME — same contract as the ranker's SAAX_* config
// (SAAX_CAPABILITY_FLOOR etc.), so apply-weights.js updates .env + the
// surrounding process environment and the next server/ranker start picks them
// up. No hot reload: production weight changes are operator-executed restarts.

const DEFAULT_WEIGHTS = Object.freeze({ reputation: 0.6, freshness: 0.2, price: 0.2 });

function normalizeWeights(w) {
  const reputation = Number(w && w.reputation);
  const freshness = Number(w && w.freshness);
  const price = Number(w && w.price);
  if (![reputation, freshness, price].every(Number.isFinite)) return { ...DEFAULT_WEIGHTS };
  const sum = reputation + freshness + price;
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    reputation: Math.round((reputation / sum) * 10000) / 10000,
    freshness: Math.round((freshness / sum) * 10000) / 10000,
    price: Math.round((price / sum) * 10000) / 10000,
  };
}

// Current weights from the environment (load-time snapshot).
function currentWeights() {
  return normalizeWeights({
    reputation: process.env.SAAX_W_REPUTATION,
    freshness: process.env.SAAX_W_FRESHNESS,
    price: process.env.SAAX_W_PRICE,
  });
}

// Rebuild the environment weight pair for apply-weights.js (spread back into
// proc.env so the next loaded module sees them; persists via .env rewrite).
function applyWeightsToEnv(w) {
  const n = normalizeWeights(w);
  process.env.SAAX_W_REPUTATION = String(n.reputation);
  process.env.SAAX_W_FRESHNESS = String(n.freshness);
  process.env.SAAX_W_PRICE = String(n.price);
  return n;
}

// Serialize the weight config for weights_used snapshots — includes the
// formula version so tuning analysis can trace which formula shape produced
// the row.
function weightsSnapshot() {
  return { ...currentWeights(), formula: 'linear' };
}

module.exports = {
  DEFAULT_WEIGHTS,
  normalizeWeights,
  currentWeights,
  applyWeightsToEnv,
  weightsSnapshot,
};